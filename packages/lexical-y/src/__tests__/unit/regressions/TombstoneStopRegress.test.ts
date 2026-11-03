/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A collaborator removes a format over a range (its opener and restore
// ends); after a sync another client types plain text next to a closer of
// that range that is now a tombstone; the collaborator undoes. The typed text
// stays plain and every letter keeps its format, as on main: typed text that
// continues a run steps over tombstones after it (stopping before them put it
// on the wrong side of a closer the undo brings back, so it ended inside the
// restored run). Reduced from prop's op-list runs 7031523, 7041381 and
// 7070729, both client id orders, gc off and on.

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
  $isTextNode,
  $setSelection,
  defineExtension,
  type ElementNode,
  type TextFormatType,
  type TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYCollabConfig, createYDoc, YCollabExtension} from '../../..';
import {seedYState} from '../../../headless';

const CONFIG = {extensions: [RichTextExtension], schemaVersion: 1};
const KEYS = ['b', 'i', 's'] as const;
const FMT: Record<string, TextFormatType> = {
  b: 'bold',
  i: 'italic',
  s: 'strikethrough',
};

type Word = [string, Record<string, boolean>];
type Op = {
  k: string;
  t?: string;
  i?: number;
  j?: number;
  key?: string;
  v?: boolean;
  ch?: string;
};
type Spec = {
  key: string;
  seed: number;
  ids: number[];
  words: Word[];
  ops: Op[];
};

function $texts(): TextNode[] {
  return ($getRoot().getFirstChildOrThrow() as ElementNode)
    .getChildren()
    .filter($isTextNode);
}
function $len(): number {
  return $texts().reduce((n, t) => n + t.getTextContentSize(), 0);
}
function $splitAt(off: number) {
  let acc = 0;
  for (const t of $texts()) {
    const n = t.getTextContentSize();
    if (off > acc && off < acc + n) {
      t.splitText(off - acc);
      return;
    }
    acc += n;
  }
}
function $setRange(i: number, j: number, key: string, on: boolean) {
  $splitAt(i);
  $splitAt(j);
  let acc = 0;
  for (const t of $texts()) {
    const n = t.getTextContentSize();
    if (acc >= i && acc + n <= j && t.hasFormat(FMT[key]) !== on) {
      t.toggleFormat(FMT[key]);
    }
    acc += n;
  }
}
function $typePlain(i: number, s: string) {
  const ts = $texts();
  let acc = 0;
  let node = ts[ts.length - 1];
  let off = node.getTextContentSize();
  for (const t of ts) {
    const n = t.getTextContentSize();
    if (i <= acc + n) {
      node = t;
      off = i - acc;
      break;
    }
    acc += n;
  }
  const sel = $createRangeSelection();
  sel.anchor.set(node.getKey(), off, 'text');
  sel.focus.set(node.getKey(), off, 'text');
  $setSelection(sel);
  sel.format = 0;
  sel.insertText(s);
  $setSelection(null);
}
function $chars(): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const t of $texts()) {
    const keys = KEYS.filter(k => t.hasFormat(FMT[k]));
    for (const c of t.getTextContent()) {
      out.push([c, [...keys]]);
    }
  }
  return out;
}
function oracle(
  fa: [string, string[]][],
  fb: [string, string[]][],
  words: Word[],
) {
  const orig: Record<string, string[]> = {};
  for (const [w, f] of words) {
    for (const c of w) {
      orig[c] = KEYS.filter(k => f[k]);
    }
  }
  const conv = JSON.stringify(fa) === JSON.stringify(fb);
  let extra = 0;
  let lost = 0;
  let onA = 0;
  let zLeft = 0;
  for (const [c, keys] of fa) {
    if (c === 'Z') {
      zLeft++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      if (keys.length) onA++;
      continue;
    }
    const o = orig[c] || [];
    for (const kk of keys) if (!o.includes(kk)) extra++;
    for (const kk of o) if (!keys.includes(kk)) lost++;
  }
  const flags =
    (extra ? 'E' : '') +
    (lost ? 'L' : '') +
    (onA ? 'A' : '') +
    (zLeft ? 'Z' : '') +
    (conv ? '' : 'D');
  return {bad: flags !== '', flags};
}
function run(spec: Spec, gcOn: boolean) {
  const seeded = seedYState(CONFIG, () => {
    const p = $createParagraphNode();
    for (const [w, f] of spec.words) {
      const t = $createTextNode(w);
      for (const k of KEYS) if (f[k]) t.toggleFormat(FMT[k]);
      p.append(t);
    }
    $getRoot().clear().append(p);
  });
  const peers = spec.ids.map((id: number, n: number) => {
    const doc = createYDoc(seeded, {gc: gcOn});
    doc.clientID = id;
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          createYCollabConfig({
            captureTimeout: 2 ** 30,
            doc,
            layoutUpgrade: null,
            schemaVersion: 1,
            synced: true,
          }),
        ],
        name: `ops-${n}`,
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
  });
  const [A, B] = peers;
  const sync = () => {
    for (let q = 0; q < 2; q++) {
      Y.applyUpdate(
        B.doc,
        Y.encodeStateAsUpdate(A.doc, Y.encodeStateVector(B.doc)),
      );
      Y.applyUpdate(
        A.doc,
        Y.encodeStateAsUpdate(B.doc, Y.encodeStateVector(A.doc)),
      );
    }
  };
  const clamp = (i: number, len: number) => Math.max(0, Math.min(i, len));
  try {
    for (const op of spec.ops) {
      if (op.k === 'sync') sync();
      else if (op.k === 'undo')
        B.editor.dispatchCommand(UNDO_COMMAND, undefined);
      else if (op.k === 'A') {
        const len = A.editor.read(() => $len());
        A.editor.update(() => $typePlain(clamp(op.i!, len), op.ch!), {
          discrete: true,
        });
      } else if (op.t === 'ins') {
        const len = B.editor.read(() => $len());
        B.editor.update(() => $typePlain(clamp(op.i!, len), 'Z'), {
          discrete: true,
        });
        B.binding.undoManager?.stopCapturing();
      } else {
        const len = B.editor.read(() => $len());
        if (len === 0) continue;
        const i = clamp(op.i!, len - 1);
        const j = clamp(op.j!, len);
        if (j <= i) continue;
        B.editor.update(() => $setRange(i, j, op.key!, op.v!), {
          discrete: true,
        });
        B.binding.undoManager?.stopCapturing();
      }
    }
    sync();
    return oracle(
      A.editor.read(() => $chars()),
      B.editor.read(() => $chars()),
      spec.words,
    );
  } finally {
    for (const p of peers) p.editor.dispose();
  }
}

const SPECS: Spec[] = [
  {
    ids: [1, 2],
    key: '7031523:12-min',
    ops: [
      {i: 8, j: 12, k: 'B', key: 's', t: 'fmt', v: false},
      {k: 'sync'},
      {ch: '1', i: 12, k: 'A'},
      {k: 'undo'},
    ],
    seed: 7031523,
    words: [
      ['abc', {b: false, i: false, s: false}],
      ['def', {b: false, i: false, s: false}],
      ['ghi', {b: false, i: false, s: false}],
      ['jkl', {b: true, i: false, s: true}],
    ],
  },
  {
    ids: [1, 2],
    key: '7041381:12-min',
    ops: [
      {i: 5, j: 10, k: 'B', key: 's', t: 'fmt', v: false},
      {k: 'sync'},
      {ch: '0', i: 9, k: 'A'},
      {k: 'undo'},
    ],
    seed: 7041381,
    words: [
      ['abc', {b: false, i: false, s: false}],
      ['def', {b: false, i: false, s: false}],
      ['ghi', {b: true, i: false, s: true}],
      ['jkl', {b: true, i: true, s: true}],
    ],
  },
  {
    ids: [1, 2],
    key: '7070729:12-min',
    ops: [
      {i: 0, j: 6, k: 'B', key: 'b', t: 'fmt', v: false},
      {k: 'sync'},
      {ch: '0', i: 3, k: 'A'},
      {k: 'undo'},
    ],
    seed: 7070729,
    words: [
      ['abc', {b: true, i: false, s: false}],
      ['def', {b: false, i: false, s: false}],
      ['ghi', {b: false, i: true, s: false}],
    ],
  },
];
for (const gc of [false, true]) {
  for (const sp of SPECS) {
    for (const ids of [sp.ids, [...sp.ids].reverse()]) {
      test(`gc ${gc ? 'on' : 'off'}, ids ${ids.join('/')}: run ${sp.key} keeps A's digit plain and every letter's format`, () => {
        expect(run({...sp, ids}, gc).flags).toBe('');
      });
    }
  }
}
