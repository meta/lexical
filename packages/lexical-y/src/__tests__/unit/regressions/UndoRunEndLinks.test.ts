/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// An undo that brings back a run gives it an end of this client's own where
// a closer ended it (closeRestoredRuns). It found where in one transaction
// and wrote the null in a second one, keeping the item objects it had found;
// the first transaction split items and merged them back, so the item to its
// left could be a piece no longer in the store. The null was linked to that
// piece: the item in the store kept its old right, so a walk of the list
// skipped the null (a broken link, on the undoing client only). Two clients,
// synced after every step, reduced from an undo fuzz: B deletes two
// characters; A comments the end of one line and part of another (one step)
// and bolds part of the first; B types " new " and deletes part of it,
// removes A's first comment and undoes that.

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$addMarkID, $removeMarkID, MarkStateExtension} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  configExtension,
  defineExtension,
  type LexicalNode,
  type TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../../..';
import {seedYState} from '../../../headless';
import {misLinkedItems} from '../../utils/structure';

const EXTENSIONS = [RichTextExtension, MarkStateExtension];
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'note', 'run'];

type Op = {e: number; end?: boolean} & (
  | {k: 'add'; t: number; a: number; b: number; id: string}
  | {k: 'remove'; id: string}
  | {k: 'format'; t: number; a: number; b: number; f: 'bold'}
  | {k: 'type'; t: number; a: number; s: string}
  | {k: 'del'; t: number; a: number; b: number}
  | {k: 'undo'}
);

// The undo fuzz's text node indexes (modulo the text nodes there are).
const OPS: Op[] = [
  {a: 18, b: 20, e: 1, k: 'del', t: 1},
  {a: 25, b: 34, e: 0, id: 'c2', k: 'add', t: 13},
  {a: 6, b: 8, e: 0, end: true, id: 'c4', k: 'add', t: 1},
  {a: 21, b: 25, e: 0, f: 'bold', k: 'format', t: 0},
  {a: 19, e: 1, k: 'type', s: ' new ', t: 6},
  {a: 3, b: 5, e: 1, k: 'del', t: 6},
  {e: 1, id: 'c2', k: 'remove'},
  {e: 1, k: 'undo'},
];

function $texts(): TextNode[] {
  const out: TextNode[] = [];
  const walk = (n: LexicalNode) => {
    if ($isTextNode(n) && n.getType() === 'text') {
      out.push(n);
    }
    if ($isElementNode(n)) {
      n.getChildren().forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

function $apply(op: Op) {
  if (op.k === 'undo') {
    return;
  }
  if (op.k === 'remove') {
    $removeMarkID(op.id);
    return;
  }
  const texts = $texts();
  const t = texts[op.t % Math.max(1, texts.length)];
  const size = t.getTextContentSize();
  const s = $createRangeSelection();
  const b = op.k === 'type' ? op.a : op.b;
  s.anchor.set(t.getKey(), Math.min(op.a, size), 'text');
  s.focus.set(t.getKey(), Math.min(b, size), 'text');
  $setSelection(s);
  if (op.k === 'add') {
    $addMarkID(op.id, s);
  } else if (op.k === 'format') {
    s.formatText(op.f);
  } else if (op.k === 'type') {
    s.format = 0;
    s.insertText(op.s);
  } else {
    s.removeText();
  }
  $setSelection(null);
}

describe('an undo that ends a restored run', () => {
  for (const gc of [false, true]) {
    test(`keeps the list's links whole (gc ${gc ? 'on' : 'off'})`, () => {
      const seeded = seedYState(
        {extensions: EXTENSIONS, schemaVersion: 1},
        () => {
          const root = $getRoot().clear();
          WORDS.forEach((word, i) =>
            root.append(
              $createParagraphNode().append(
                $createTextNode(`${word} one two three four five ${i}`),
              ),
            ),
          );
        },
      );
      const peers = [0, 1].map(i => {
        const doc = createYDoc(seeded, {gc});
        const editor = buildEditorFromExtensions(
          defineExtension({
            dependencies: [
              ...EXTENSIONS,
              configExtension(YCollabExtension, {
                captureTimeout: 2 ** 30,
                doc,
                schemaVersion: 1,
                synced: true,
              }),
            ],
            name: `run-end-links/${i}`,
            onError: error => {
              throw error;
            },
          }),
        );
        const {binding} = getExtensionDependencyFromEditor(
          editor,
          YCollabExtension,
        ).output;
        return {binding, doc, editor};
      });
      const sync = () => {
        const [a, b] = peers;
        Y.applyUpdate(
          b.doc,
          Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
        );
        Y.applyUpdate(
          a.doc,
          Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)),
        );
      };
      try {
        for (const [i, op] of OPS.entries()) {
          const {binding, editor} = peers[op.e];
          if (op.k === 'undo') {
            editor.dispatchCommand(UNDO_COMMAND, undefined);
          } else {
            editor.update(() => $apply(op), {discrete: true});
          }
          if (op.end) {
            binding.undoManager?.stopCapturing();
          }
          sync();
          for (const peer of peers) {
            expect(misLinkedItems(peer.doc), `after step ${i}`).toEqual([]);
          }
        }
      } finally {
        peers.forEach(p => p.editor.dispose());
      }
    });
  }
});
