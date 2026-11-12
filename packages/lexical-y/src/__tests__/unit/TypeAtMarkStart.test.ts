/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Typing at the start of a commented run (MarkStateExtension) after an
// equal word: `t30z ` typed at the start of the commented `da t2z` after
// `da ` is cut off the comment, joins `da `, and the rest of the run is a
// part split off it. It was written as `del "da" ins "da t30z"`: the words
// deleted and inserted again (soak S4-7). It writes the typed text alone.

import {
  buildEditorFromExtensions,
  configExtension,
  defineExtension,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$addMarkID, MarkStateExtension} from '@lexical/mark';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../..';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function peer() {
  const doc = createYDoc();
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        configExtension(YCollabExtension, {
          doc,
          schemaVersion: 1,
          selfCheck: true,
        }),
        MarkStateExtension,
      ],
      name: 'type-at-mark-start',
      onError: e => {
        throw e;
      },
    }),
  );
  const {binding} = getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output;
  return {binding, doc, editor};
}

describe('typing at the start of a commented run', () => {
  for (const [a, b] of [
    ['da ', 'da t2z'],
    ['xy ', 'da t2z'],
    ['la la ', 'zz'],
    ['ab', 'cd'],
    ['', 'da t2z'],
  ] as const) {
    test(`"${a}" + commented "${b}": the typed text is written alone`, async () => {
      const p = peer();
      p.editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('Title')),
              $createParagraphNode().append($createTextNode(a + b)),
            );
        },
        {discrete: true},
      );
      p.binding.initialize();
      await flush();
      p.editor.update(
        () => {
          const t = (
            $getRoot().getChildAtIndex(1) as ElementNode
          ).getFirstChild() as TextNode;
          const s = $createRangeSelection();
          s.anchor.set(t.getKey(), a.length, 'text');
          s.focus.set(t.getKey(), a.length + b.length, 'text');
          $addMarkID('c2', s);
          $setSelection(null);
        },
        {discrete: true},
      );
      await flush();
      const w = {deleted: '', inserted: ''};
      p.doc.on('afterTransaction', (tr: Y.Transaction) => {
        if (!tr.local) {
          return;
        }
        Y.iterateStructsByIdSet(tr, tr.insertSet, x => {
          if (x instanceof Y.Item && x.content instanceof Y.ContentString) {
            w.inserted += x.content.str;
          }
        });
        Y.iterateStructsByIdSet(tr, tr.deleteSet, x => {
          if (x instanceof Y.Item && x.content instanceof Y.ContentString) {
            w.deleted += x.content.str;
          }
        });
      });
      p.editor.update(
        () => {
          const kids = (
            $getRoot().getChildAtIndex(1) as ElementNode
          ).getAllTextNodes();
          (a === '' ? kids[0] : kids[1]).select(0, 0).insertText('t30z ');
        },
        {discrete: true},
      );
      await flush();
      expect(w).toEqual({deleted: '', inserted: 't30z '});
    });
  }
});
