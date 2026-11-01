/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Contract C1 with an editor that is kept busy: an app update listener
// queues follow-up updates after every commit (as decorators and plugins
// that react to changes do), `k` of them in a chain, up to and past the
// binding's limit of pending commits (16). The bound editor must show the
// derived fields a fresh reader shows (list numbering next to named-slot
// hosts) at the first read, after microtasks, after a task, after 50 ms and
// after 1 s (MATRIX_FULL=1; the default run checks k = 1 and 17 and waits
// 50 ms more).

import * as Y from '@y/y';
import {$getRoot} from 'lexical';
import * as fs from 'node:fs';
import {afterEach, describe, expect, test} from 'vitest';

import {
  bindFresh,
  type BindMode,
  type BoundEditor,
  configLabel,
  DEFAULT_CONFIG,
  freshSnapshot,
  NODE_SHAPES,
  type NodeShape,
  renderedValues,
  seedShapes,
  shapesWith,
  snapshot,
} from '../../catalog';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    c();
  }
});

const LISTS = ['list/number-start-5', 'list/bullet-nested'].map(
  n => NODE_SHAPES.find(s => s.name === n)!,
);
const BETWEEN = NODE_SHAPES.find(s => s.name === 'text/normal')!;
const DOCS: NodeShape[][] = shapesWith('slots').flatMap(slot =>
  LISTS.map(list => [slot, list, BETWEEN, list]),
);
const FULL = process.env.MATRIX_FULL === '1';
const FOLLOW_UPS = FULL ? [1, 15, 16, 17, 64] : [1, 17];
/** The last check's delay: 1 s with MATRIX_FULL=1. */
const LAST_WAIT = FULL ? 1000 : 50;
const MODES: BindMode[] = ['binding', 'extension', 'extension-then-sync'];

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('C1 with follow-up updates: the editor shows what a fresh reader shows', () => {
  for (const shapes of DOCS) {
    for (const k of FOLLOW_UPS) {
      for (const mode of MODES) {
        for (const dom of ['headless', 'jsdom'] as const) {
          const config = {...DEFAULT_CONFIG, dom};
          const name = `${shapes.map(s => s.name).join(' + ')} [${k} follow-ups, ${mode}, ${configLabel(config)}]`;
          test(
            name,
            async () => {
              const seed = seedShapes(shapes, config);
              const problems: string[] = [];
              // Registered before the binding's first read, as an app's
              // plugins are: every commit queues one more update while any
              // of the k are left.
              let left = k;
              const b: BoundEditor = bindFresh(seed, config, mode, editor =>
                editor.registerUpdateListener(() => {
                  if (left > 0) {
                    left--;
                    editor.update(() => {
                      $getRoot().markDirty();
                    });
                  }
                }),
              );
              cleanups.push(() => b.dispose());
              const check = (when: string) => {
                const shown = snapshot(b.editor);
                const fresh = freshSnapshot(
                  Y.encodeStateAsUpdate(b.doc),
                  config,
                );
                if (
                  JSON.stringify(shown.numbering) !==
                  JSON.stringify(fresh.numbering)
                ) {
                  problems.push(
                    `${when}: numbering ${JSON.stringify(shown.numbering.values)} != fresh ${JSON.stringify(fresh.numbering.values)}`,
                  );
                }
                const rendered = renderedValues(b.root);
                if (
                  rendered !== null &&
                  JSON.stringify(rendered) !==
                    JSON.stringify(shown.numbering.values)
                ) {
                  problems.push(
                    `${when}: rendered ${JSON.stringify(rendered)} != ${JSON.stringify(shown.numbering.values)}`,
                  );
                }
              };
              check('first read');
              for (let i = 0; i < 5; i++) {
                await Promise.resolve();
              }
              check('after microtasks');
              await wait(0);
              check('after a task');
              await wait(50);
              check('after 50 ms');
              await wait(LAST_WAIT);
              check(`after ${LAST_WAIT} ms more`);
              if (process.env.MATRIX_OUT) {
                fs.appendFileSync(
                  process.env.MATRIX_OUT,
                  JSON.stringify({name, problems}) + '\n',
                );
              }
              expect(problems).toEqual([]);
            },
            10000,
          );
        }
      }
    }
  }
});
