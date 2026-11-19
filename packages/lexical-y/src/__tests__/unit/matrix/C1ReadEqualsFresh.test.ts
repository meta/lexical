/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Contract C1 over the catalogs: an editor bound to a document shows what a
// fresh headless reader of that document shows (readYState), and the
// derived fields (list numbering, `start`, `<li value>`) an editor without
// collab derives for the same content. Checked right after the first read
// (nothing awaited), right after a remote change is applied, and once the
// binding's queued work has run; for every node shape, every list type next
// to every named-slot host on either side, mixed documents, every bind mode
// (YBinding, YCollabExtension on a synced document, YCollabExtension synced
// later), headless and jsdom, and BlockIdExtension enabled, disabled and
// absent.
//
// MATRIX_FULL=1 runs the full product; the default run samples it (every
// shape, slot host, list type, bind mode, DOM and block id setting at least
// once).

import * as Y from '@y/y';
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import * as fs from 'node:fs';
import {afterEach, describe, expect, test} from 'vitest';

import {editYState} from '../../../headless';
import {
  bindFresh,
  type BindMode,
  type BoundEditor,
  type CatalogConfig,
  catalogHeadlessConfig,
  configLabel,
  configProduct,
  firstDifference,
  freshSnapshot,
  NODE_SHAPES,
  type NodeShape,
  renderedValues,
  seedShapes,
  shapeDocs,
  shapesWith,
  type Snapshot,
  snapshot,
  unboundSnapshot,
} from '../../catalog';

const FULL = process.env.MATRIX_FULL === '1';

const bound: BoundEditor[] = [];
afterEach(() => {
  for (const b of bound.splice(0)) {
    b.dispose();
  }
});

type Cell = {
  name: string;
  shapes: readonly NodeShape[];
  config: CatalogConfig;
  mode: BindMode;
};

/**
 * Everything C1 promises, as a list of what differs (empty when it holds).
 */
function diffs(
  b: BoundEditor,
  cell: Cell,
  when: string,
  expectedDerived: unknown[],
  settledFresh?: Snapshot,
): string[] {
  const out: string[] = [];
  const state = Y.encodeStateAsUpdate(b.doc);
  const shown = snapshot(b.editor);
  const fresh = freshSnapshot(state, cell.config);
  // Nested editors' states are compared against a reader that settled as
  // long (below): they initialize themselves a task after they are created,
  // with or without collab.
  const shownJson = withoutNestedEditors(shown.json);
  const freshJson = withoutNestedEditors(fresh.json);
  if (JSON.stringify(shownJson) !== JSON.stringify(freshJson)) {
    out.push(
      `${when}: editor differs from a fresh readYState of its doc at ${firstDifference(shownJson, freshJson)}`,
    );
  }
  if (
    settledFresh !== undefined &&
    JSON.stringify(shown.json) !== JSON.stringify(settledFresh.json)
  ) {
    out.push(
      `${when}: editor differs from a settled fresh reader of its doc at ${firstDifference(shown.json, settledFresh.json)}`,
    );
  }
  if (JSON.stringify(shown.numbering) !== JSON.stringify(fresh.numbering)) {
    out.push(
      `${when}: numbering ${JSON.stringify(shown.numbering)} != fresh ${JSON.stringify(fresh.numbering)}`,
    );
  }
  if (
    expectedDerived.length > 0 &&
    JSON.stringify(shown.derived) !== JSON.stringify(expectedDerived)
  ) {
    out.push(
      `${when}: derived fields differ from an editor without collab: ${JSON.stringify(shown.derived)} != ${JSON.stringify(expectedDerived)}`,
    );
  }
  const rendered = renderedValues(b.root);
  if (
    rendered !== null &&
    JSON.stringify(rendered) !== JSON.stringify(shown.numbering.values)
  ) {
    out.push(
      `${when}: rendered <li value> ${JSON.stringify(rendered)} != ${JSON.stringify(shown.numbering.values)}`,
    );
  }
  if (b.errors.length > 0) {
    out.push(`${when}: errors ${b.errors.map(String).join('; ')}`);
  }
  // Nested editor instances are not synchronized, only their JSON snapshots
  // (y.md, Limits): a nested editor that initializes itself after the read
  // (a sticky note's caption gets its paragraph a task later, with or
  // without collab) differs from what is stored until the host node is
  // written again, and the self-check says so.
  const selfCheck = b.warnings.filter(
    w => w.includes('self-check') && !w.includes('.editorState.'),
  );
  if (selfCheck.length > 0) {
    out.push(`${when}: ${selfCheck.join('; ')}`);
  }
  return out;
}

/** `json` with every nested editor's state (`{editorState: ...}`) elided. */
function withoutNestedEditors(json: unknown): unknown {
  return JSON.parse(JSON.stringify(json), (key, value) =>
    key === 'editorState' && value !== null && typeof value === 'object'
      ? '(nested editor)'
      : value,
  );
}

async function runCell(cell: Cell): Promise<string[]> {
  const seed = seedShapes(cell.shapes, cell.config);
  const expected = unboundSnapshot(cell.shapes, cell.config).derived;
  let b: BoundEditor;
  try {
    b = bindFresh(seed, cell.config, cell.mode);
  } catch (error) {
    return [`bind threw: ${String(error)}`];
  }
  bound.push(b);
  const out = diffs(b, cell, 'first read', expected);
  // Settling with no further edits: microtasks, a task, 50 ms.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  out.push(...diffs(b, cell, 'after microtasks', expected));
  await new Promise(resolve => setTimeout(resolve, 0));
  out.push(...diffs(b, cell, 'after a task', expected));
  await new Promise(resolve => setTimeout(resolve, 50));
  out.push(...diffs(b, cell, 'after 50 ms', expected));
  // A peer appends a paragraph (a remote change), applied as a provider does.
  const {update} = editYState(
    seed,
    catalogHeadlessConfig(cell.config),
    () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('from a peer')),
      );
    },
    {writer: null},
  );
  if (update !== null) {
    Y.applyUpdate(b.doc, update, 'provider');
  }
  const afterRemote = unboundSnapshot(cell.shapes, cell.config).derived;
  out.push(...diffs(b, cell, 'after a remote change', afterRemote));
  await new Promise(resolve => setTimeout(resolve, 0));
  // Once settled, against a fresh reader that settled too: nested editors
  // (a sticky note's caption) initialize themselves a task after they are
  // created, with or without collab, so a reader that closes at once has
  // not seen that yet.
  const reader = bindFresh(
    Y.encodeStateAsUpdate(b.doc),
    {...cell.config, dom: 'headless'},
    'binding',
  );
  bound.push(reader);
  await new Promise(resolve => setTimeout(resolve, 0));
  out.push(
    ...diffs(b, cell, 'once settled', afterRemote, snapshot(reader.editor)),
  );
  return out;
}

const MODES: BindMode[] = ['binding', 'extension', 'extension-then-sync'];

function cellsFor(
  family: string,
  docs: readonly (readonly NodeShape[])[],
  configs: CatalogConfig[],
  modes: BindMode[] = MODES,
): Cell[] {
  const cells: Cell[] = [];
  docs.forEach((shapes, i) => {
    const name = shapes.map(s => s.name).join(' + ');
    modes.forEach((mode, j) => {
      // Each doc in every mode; configs rotate independently of the mode,
      // so every mode meets every config within a family (all of them
      // with MATRIX_FULL).
      const picked = FULL ? configs : [configs[(i + j) % configs.length]];
      for (const config of picked) {
        cells.push({
          config,
          mode,
          name: `${family}: ${name} [${mode}, ${configLabel(config)}]`,
          shapes,
        });
      }
    });
  });
  return cells;
}

const CONFIGS = configProduct(['dom', 'blockIds']);

// Every list type and start next to every named-slot host, on either side,
// with a paragraph and a second list between.
const LIST_SLOT_DOCS: NodeShape[][] = shapesWith('list')
  .filter(s => s.name.startsWith('list/'))
  .flatMap(list =>
    shapesWith('slots').flatMap(slot => [
      [slot, list, NODE_SHAPES.find(s => s.name === 'paragraph/empty')!, list],
      [list, NODE_SHAPES.find(s => s.name === 'text/normal')!, list, slot],
    ]),
  );

const SINGLE_DOCS: NodeShape[][] = NODE_SHAPES.map(s => [s]);

const MIXED_DOCS = shapeDocs(FULL ? 40 : 12, 6, 0xc1);

describe('C1: a bound editor shows what a fresh reader of its doc shows', () => {
  for (const cell of [
    ...cellsFor('list next to slot', LIST_SLOT_DOCS, CONFIGS),
    ...cellsFor('one shape', SINGLE_DOCS, CONFIGS),
    ...cellsFor('mixed', MIXED_DOCS, CONFIGS),
  ]) {
    test(cell.name, async () => {
      const problems = await runCell(cell);
      if (process.env.MATRIX_OUT) {
        fs.appendFileSync(
          process.env.MATRIX_OUT,
          JSON.stringify({name: cell.name, problems}) + '\n',
        );
      }
      expect(problems).toEqual([]);
    });
  }
});
