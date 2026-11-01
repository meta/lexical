/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Rare sequences in which a format ends up on text nobody formatted, made
// wrong by the rules that fixed #9671 and #9599: a trade recorded as D95
// (#9690). Each passed before those rules. `test.fails` until stored
// provenance can tell a range's end from a removal's start.
// B makes its steps (each its own undo step), A types a plain character, B
// undoes everything. Expected: every original letter keeps exactly its
// original formats and B's "Z" is gone (A's character is left out of the
// comparison).

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
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
  type TextFormatType,
  type TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../../..';
import {seedYState} from '../../../headless';

const CONFIG = {extensions: [RichTextExtension], schemaVersion: 1};
type F = 'b' | 'i' | 's';
const FMT: Record<F, TextFormatType> = {
  b: 'bold',
  i: 'italic',
  s: 'strikethrough',
};
type Op =
  | {k: 'fmt'; i: number; j: number; key: F; v: boolean}
  | {k: 'Z'; i: number}
  | {k: 'A'; i: number; ch: string}
  | {k: 'sync'}
  | {k: 'undo'};

function $texts(): TextNode[] {
  const p = $getRoot().getFirstChildOrThrow();
  return $isElementNode(p) ? p.getChildren().filter($isTextNode) : [];
}
function $at(i: number): [TextNode, number] {
  let acc = 0;
  const ts = $texts();
  for (const t of ts) {
    if (i <= acc + t.getTextContentSize()) return [t, i - acc];
    acc += t.getTextContentSize();
  }
  const last = ts[ts.length - 1];
  return [last, last.getTextContentSize()];
}
function $select(i: number, j: number) {
  const s = $createRangeSelection();
  const [a, ao] = $at(i);
  const [b, bo] = $at(j);
  s.anchor.set(a.getKey(), ao, 'text');
  s.focus.set(b.getKey(), bo, 'text');
  $setSelection(s);
  return s;
}
function $typePlain(i: number, text: string) {
  const s = $select(i, i);
  s.format = 0;
  s.insertText(text);
  $setSelection(null);
}
function $setRange(i: number, j: number, key: F, v: boolean) {
  for (const n of $select(i, j).extract()) {
    if ($isTextNode(n) && n.hasFormat(FMT[key]) !== v) n.toggleFormat(FMT[key]);
  }
  $setSelection(null);
}
const $chars = () =>
  $texts().flatMap(t =>
    [...t.getTextContent()].map(
      c =>
        c + (['b', 'i', 's'] as F[]).filter(k => t.hasFormat(FMT[k])).join(''),
    ),
  );

function run(
  words: [string, F[]][],
  ids: [number, number],
  gc: boolean,
  ops: Op[],
) {
  const seeded = seedYState(CONFIG, () => {
    const p = $createParagraphNode();
    for (const [w, fs] of words) {
      const t = $createTextNode(w);
      for (const f of fs) t.toggleFormat(FMT[f]);
      p.append(t);
    }
    $getRoot().clear().append(p);
  });
  const [A, B] = ids.map(id => {
    const doc = createYDoc(seeded, {gc});
    doc.clientID = id;
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          configExtension(YCollabExtension, {
            captureTimeout: 2 ** 30,
            doc,
            schemaVersion: 1,
            synced: true,
          }),
        ],
        name: `repro/${id}`,
      }),
    );
    const {binding} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    return {binding, doc, editor};
  });
  const sync = () => {
    Y.applyUpdate(
      B.doc,
      Y.encodeStateAsUpdate(A.doc, Y.encodeStateVector(B.doc)),
    );
    Y.applyUpdate(
      A.doc,
      Y.encodeStateAsUpdate(B.doc, Y.encodeStateVector(A.doc)),
    );
  };
  for (const op of ops) {
    if (op.k === 'sync') sync();
    else if (op.k === 'undo') B.editor.dispatchCommand(UNDO_COMMAND, undefined);
    else if (op.k === 'A')
      A.editor.update(() => $typePlain(op.i, op.ch), {discrete: true});
    else {
      B.editor.update(
        () =>
          op.k === 'Z'
            ? $typePlain(op.i, 'Z')
            : $setRange(op.i, op.j, op.key, op.v),
        {discrete: true},
      );
      B.binding.undoManager?.stopCapturing();
    }
  }
  sync();
  const a = A.editor.getEditorState().read($chars);
  expect(B.editor.getEditorState().read($chars)).toEqual(a);
  return a.filter(c => !/^[0-9]/.test(c)).join(' ');
}

const CASES: {
  name: string;
  words: [string, F[]][];
  ids: [number, number];
  ops: Op[];
}[] = [
  {
    // italic over "efghi", Z typed inside it, italic over "Z" and the rest;
    // A types 1
    ids: [2, 1],
    name: '#9690: restore of own earlier insert removed (#9671 rule, restore side)',
    ops: [
      {i: 4, j: 9, k: 'fmt', key: 'i', v: true},
      {i: 7, k: 'Z'},
      {i: 7, j: 11, k: 'fmt', key: 'i', v: true},
      {k: 'sync'},
      {ch: '1', i: 8, k: 'A'},
      {k: 'undo'},
      {k: 'undo'},
      {k: 'undo'},
    ],
    words: [
      ['abc', ['i']],
      ['def', []],
      ['ghi', []],
    ],
  },
  {
    // Z typed after the plain "ghi", then strikethrough removed over the text
    // after it; A types 1
    ids: [2, 1],
    name: "#9690: restore scan stops at another client's text (#9599 rule)",
    ops: [
      {i: 9, k: 'Z'},
      {k: 'sync'},
      {i: 9, j: 15, k: 'fmt', key: 's', v: false},
      {ch: '1', i: 12, k: 'A'},
      {k: 'undo'},
      {k: 'undo'},
    ],
    words: [
      ['abc', ['s']],
      ['def', ['i', 's']],
      ['ghi', []],
      ['jkl', ['b', 's']],
      ['mno', ['s']],
    ],
  },
];

for (const c of CASES) {
  for (const gc of [false, true]) {
    test.fails(`${c.name} (gc ${gc ? 'on' : 'off'}, ids ${c.ids})`, () => {
      const orig = c.words
        .flatMap(([w, fs]) =>
          [...w].map(
            ch =>
              ch +
              (['b', 'i', 's'] as F[]).filter(k => fs.includes(k)).join(''),
          ),
        )
        .join(' ');
      expect(run(c.words, c.ids, gc, c.ops)).toBe(orig);
    });
  }
}
