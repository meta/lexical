/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Contract C1 for text content listeners, over every node shape and every
// way an editor's state changes: local edits from the core op catalog, a
// remote change read by a binding (`@lexical/y`, `@lexical/yjs` v2), and
// `setEditorState`. A text content listener is called after a commit that
// changes the document's text, with the text a fresh read of the root
// gives, and not after one that leaves the text as it was. Headless and
// rendered (jsdom).

import {buildEditorFromExtensions} from '@lexical/extension';
import {$getRoot, defineExtension, type LexicalEditor} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {
  $appendShapes,
  catalogAppExtension,
  CatalogNet,
  CORE_OPS,
  DEFAULT_CONFIG,
  prng,
  shapeDocs,
} from '../../catalog';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    c();
  }
});

/** Records what the listener got and checks it after every commit. */
function watch(editor: LexicalEditor, problems: string[], label: string) {
  let last = editor.getEditorState().read(() => $getRoot().getTextContent());
  let got: string[] = [];
  cleanups.push(editor.registerTextContentListener(text => got.push(text)));
  return (when: string) => {
    const now = editor.getEditorState().read(() => $getRoot().getTextContent());
    if (now !== last) {
      if (got.length === 0 || got[got.length - 1] !== now) {
        problems.push(
          `${label} ${when}: text changed to ${JSON.stringify(now.slice(0, 60))} but the listener got ${JSON.stringify(got.map(g => g.slice(0, 60)))}`,
        );
      }
    } else if (got.length > 0 && got.some(g => g !== now)) {
      problems.push(
        `${label} ${when}: text unchanged but the listener got ${JSON.stringify(got.map(g => g.slice(0, 60)))}`,
      );
    }
    last = now;
    got = [];
  };
}

describe('C1: text content listeners see every change of the text', () => {
  const docs = shapeDocs(0, 8, 0x548);
  docs.forEach((shapes, i) => {
    for (const dom of ['headless', 'jsdom'] as const) {
      test(`unbound, ${dom}: ${shapes.map(s => s.name).join(' + ')}`, async () => {
        const problems: string[] = [];
        const editor = buildEditorFromExtensions(
          defineExtension({
            dependencies: [catalogAppExtension(DEFAULT_CONFIG)],
            name: 'catalog-text-content',
            onError: e => {
              throw e;
            },
          }),
        );
        cleanups.push(() => editor.dispose());
        if (dom === 'jsdom') {
          const root = document.createElement('div');
          document.body.append(root);
          cleanups.push(() => root.remove());
          editor.setRootElement(root);
        }
        const check = watch(editor, problems, 'unbound');
        editor.update(() => $appendShapes(shapes), {discrete: true});
        check('after building');
        // Rendered elements' own events (a <details> element's toggle) run
        // before the next edit, as they do between a user's edits: the
        // playground's collapsible reads its node in that listener, and
        // throws if the node was removed in the meantime.
        await new Promise(resolve => setTimeout(resolve, 0));
        const rand = prng(i + 1);
        for (let step = 0; step < 8; step++) {
          const op = CORE_OPS[Math.floor(rand() * CORE_OPS.length)];
          editor.update(() => void op.$run(rand), {discrete: true});
          check(`after ${op.name}`);
        }
        const json = editor.getEditorState().toJSON();
        editor.update(() => $getRoot().clear(), {discrete: true});
        check('after clearing');
        editor.setEditorState(editor.parseEditorState(json));
        check('after setEditorState');
        expect(problems).toEqual([]);
      });
    }
    for (const kind of ['y', 'yjs-v2'] as const) {
      test(`${kind}, remote changes: ${shapes.map(s => s.name).join(' + ')}`, () => {
        const problems: string[] = [];
        const net = new CatalogNet(kind);
        cleanups.push(() => net.dispose());
        const [a, b] = ['A', 'B'].map(n => net.add(n));
        const check = watch(b.editor, problems, `${kind} reader`);
        a.update(() => {
          $getRoot().clear();
          $appendShapes(shapes);
        });
        if (a.yBinding !== null) {
          a.yBinding.initialize();
          a.flush();
        }
        net.settle(100);
        check('after the first read');
        const rand = prng(100 + i);
        for (let step = 0; step < 8; step++) {
          const op = CORE_OPS[Math.floor(rand() * CORE_OPS.length)];
          a.update(() => void op.$run(rand));
          net.settle(100);
          check(`after a remote ${op.name}`);
        }
        expect(problems).toEqual([]);
      });
    }
  });
});
