/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A downstream app's undo fuzz (two clients, one comment id per text node,
// sync after every edit), session 2810: with garbage collection on, a
// comment came back over four paragraphs after the two clients' undos once
// a delete kept every format item it leaves (D86), until the binding kept
// its own format items from collection while they are undoable (D88). The
// session's own ops, replayed: no comment may end up on two paragraphs.

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $addMarkID,
  $getNodeMarkIDs,
  $removeMarkID,
  MarkStateExtension,
} from '@lexical/mark';
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
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../../..';
import {seedYState} from '../../../headless';

const CONFIG = {
  extensions: [RichTextExtension, MarkStateExtension],
  schemaVersion: 1,
};
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'note', 'run'];

type Op = {e: 0 | 1} & (
  | {k: 'add'; t: number; a: number; b: number; id: string}
  | {k: 'remove'; id: string}
  | {k: 'format'; t: number; a: number; b: number; f: 'bold' | 'italic'}
  | {k: 'type'; t: number; a: number; s: string}
  | {k: 'del'; t: number; a: number; b: number}
  | {k: 'undo'}
);

// The session up to the op after which the comment spread.
const OPS: Op[] = [
  {a: 0, b: 4, e: 1, f: 'bold', k: 'format', t: 7},
  {a: 0, e: 1, k: 'type', s: 'yy', t: 5},
  {a: 14, b: 23, e: 0, id: 'c1', k: 'add', t: 10},
  {a: 8, b: 14, e: 1, id: 'c2', k: 'add', t: 4},
  {a: 2, b: 3, e: 1, k: 'del', t: 4},
  {e: 0, id: 'c2', k: 'remove'},
  {a: 21, b: 28, e: 0, f: 'italic', k: 'format', t: 2},
  {a: 0, b: 2, e: 0, k: 'del', t: 17},
  {a: 0, b: 1, e: 0, id: 'c3', k: 'add', t: 6},
  {a: 0, e: 1, k: 'type', s: 'x', t: 6},
  {a: 13, b: 14, e: 0, k: 'del', t: 7},
  {a: 1, b: 7, e: 0, k: 'del', t: 17},
  {a: 24, b: 35, e: 1, id: 'c4', k: 'add', t: 3},
  {e: 1, k: 'undo'},
  {a: 2, b: 5, e: 1, k: 'del', t: 6},
  {e: 0, k: 'undo'},
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

function $select(t: TextNode, a: number, b: number) {
  const s = $createRangeSelection();
  const n = t.getTextContentSize();
  s.anchor.set(t.getKey(), Math.min(a, n), 'text');
  s.focus.set(t.getKey(), Math.min(b, n), 'text');
  $setSelection(s);
  return s;
}

function $apply(op: Op) {
  if (op.k === 'undo') {
    return;
  }
  if (op.k === 'remove') {
    $removeMarkID(op.id);
    return;
  }
  const ts = $texts();
  const t = ts[op.t % Math.max(1, ts.length)];
  if (t === undefined) {
    return;
  }
  const size = t.getTextContentSize();
  if (op.k === 'add') {
    if (Math.min(op.b, size) > Math.min(op.a, size)) {
      $addMarkID(op.id, $select(t, op.a, op.b));
    }
  } else if (op.k === 'format') {
    $select(t, op.a, op.b).formatText(op.f);
  } else if (op.k === 'type') {
    const s = $select(t, op.a, op.a);
    s.format = 0;
    s.insertText(op.s);
  } else if (Math.min(op.b, size) > Math.min(op.a, size)) {
    $select(t, op.a, op.b).removeText();
  }
  $setSelection(null);
}

/** The comment ids on more than one paragraph. */
function spread(editor: LexicalEditor): string[] {
  return editor.getEditorState().read(() => {
    const blocks = new Map<string, Set<string>>();
    for (const t of $texts()) {
      const block = t.getParentOrThrow().getKey();
      for (const id of $getNodeMarkIDs(MarkStateExtension, t)) {
        const set = blocks.get(id) ?? new Set();
        set.add(block);
        blocks.set(id, set);
      }
    }
    return [...blocks]
      .filter(([, s]) => s.size > 1)
      .map(([id, s]) => `${id}:${s.size}`);
  });
}

for (const gc of [true, false]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`no comment spreads over paragraphs (gc ${gc ? 'on' : 'off'}, ids ${ids})`, () => {
      const seeded = seedYState(CONFIG, () => {
        const root = $getRoot().clear();
        for (let i = 0; i < 6; i++) {
          root.append(
            $createParagraphNode().append(
              $createTextNode(`${WORDS[i]} one two three four five ${i}`),
            ),
          );
        }
      });
      const peers = ids.map((id, n) => {
        const doc = createYDoc(seeded, {gc});
        doc.clientID = id;
        const editor = buildEditorFromExtensions(
          defineExtension({
            dependencies: [
              ...CONFIG.extensions,
              configExtension(YCollabExtension, {
                // Every edit of a client until its undo is one step, as in
                // the session (it ran well inside the capture timeout).
                captureTimeout: 2 ** 30,
                doc,
                schemaVersion: 1,
                synced: true,
              }),
            ],
            name: `undo-spread-2810-${n}`,
            onError: e => {
              throw e;
            },
          }),
        );
        return {doc, editor};
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
        for (const op of OPS) {
          const {editor} = peers[op.e];
          if (op.k === 'undo') {
            editor.dispatchCommand(UNDO_COMMAND, undefined);
          } else {
            editor.update(() => $apply(op), {discrete: true});
          }
          sync();
          expect(peers.map(p => spread(p.editor))).toEqual([[], []]);
        }
      } finally {
        for (const p of peers) {
          p.editor.dispose();
        }
      }
    });
  }
}
