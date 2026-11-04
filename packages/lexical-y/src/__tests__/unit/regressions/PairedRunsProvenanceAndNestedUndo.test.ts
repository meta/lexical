/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Two shapes, as written independently
 * text, including the same-paragraph shape: the first paired
 * write in a line with untouched text must keep what is stored there (it
 * stored a clearer over x's [2]). Read by identity syntax, the client shows
 * the paired values before the writer's record and records layout 3 with its
 * first write.
 *   1. provenance must not alias independent NodeState entries that share a canonical parsed object.
 *   2. a nested root whose layout 1 record was undone (layout 3 and schema left) is still known as a layout
 *              root before any binding: app delete + undo of the pair around X reads the same on the object and on
 *              an encoded reload.
 */
import * as Y from '@y/y';
import {
  $createRangeSelection,
  $getRoot,
  $getState,
  $isTextNode,
  $setSelection,
  $setState,
  createEditor,
  createState,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../../..';
import {
  $p,
  $selectIn,
  flush,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';

// The shapes need writes off until each turns them on (the suite may run
// with paired writes forced on).

const ONE = Object.freeze([1]);
const TWO = Object.freeze([2]);
const EMPTY = Object.freeze([]);
const numeric = createState('numeric\u001fstate', {
  parse: (v: unknown) => {
    if (!Array.isArray(v)) return EMPTY;
    if (v.length === 0) return EMPTY;
    if (v.length === 1 && v[0] === 1) return ONE;
    if (v.length === 1 && v[0] === 2) return TWO;
    return Object.freeze([...v]);
  },
});
function prepare(editor: LexicalEditor) {
  const {sharedConfigMap} = (editor as any)._nodes.get('text')!.sharedNodeState;
  if (!sharedConfigMap.has(numeric.key))
    sharedConfigMap.set(numeric.key, numeric);
}
const states = (e: LexicalEditor) =>
  e.getEditorState().read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(
        n => `${n.getTextContent()}:${JSON.stringify($getState(n, numeric))}`,
      )
      .join('|'),
  );
const records = (p: Peer) =>
  p.doc.get('lexical-y').getAttr('lexical-y:3') === true;
function $text(token: string): TextNode {
  const n = $getRoot()
    .getAllTextNodes()
    .find(x => x.getTextContent().includes(token));
  if (!n || !$isTextNode(n)) throw new Error(`no ${token}`);
  return n;
}
const fmts = (e: LexicalEditor) =>
  e.getEditorState().read(() =>
    $getRoot()
      .getAllTextNodes()
      .filter($isTextNode)
      .map(n => `${n.getTextContent()}{${n.getFormat()}}`)
      .join('|'),
  );

for (const gc of [false, true]) {
  describe(`gc ${gc ? 'on' : 'off'}`, () => {
    for (const [sameKeyOnly, distinct] of [
      [false, false],
      [true, false],
      [true, true],
    ] as const) {
      test(`a canonical parsed object shared by a raw end value and a legitimate entry (${sameKeyOnly ? 'same paragraph' : 'separate paragraph'}${distinct ? ', legit value distinct' : ''})`, async () => {
        const LEGIT = distinct ? Object.freeze([3]) : ONE;
        const t = await setup(
          () => {
            if (sameKeyOnly) $getRoot().append($p('ax b'), $p('c'));
            else $getRoot().append($p('ax'), $p('b'), $p('c'));
          },
          {delivery: 'sender', gc, ids: [1, 2], prepare},
        );
        const [a, b] = t.peers;
        // seed: "ax" [2], "b" [1] (legacy writes, before any paired write)
        a.update(() => {
          const ax = $text('ax');
          if (sameKeyOnly) {
            const [first, rest] = ax.splitText(2);
            $setState(first, numeric, TWO);
            $setState(rest, numeric, LEGIT);
          } else {
            $setState(ax, numeric, TWO);
            $setState($text('b'), numeric, ONE);
          }
        });
        await t.sync();
        // B's first paired write records layout 3 (on "c"); its second gives "a" its own value (a paired run over "a")
        b.update(() => {
          $selectIn([sameKeyOnly ? 1 : 2], 0, 1).formatText('bold');
          $setSelection(null);
        });
        b.update(() => {
          const ax = $text('ax');
          const [aa] = ax.splitText(1);
          $setState(aa, numeric, Object.freeze([5]));
        });
        // A gets only the second update (paired items, no record): read by syntax, "x" shows the paired [2]
        const list = a.pending.get(b) ?? [];
        a.pending.delete(b);
        Y.applyUpdate(a.doc, list[list.length - 1], a.net);
        await flush();
        expect(records(a)).toBe(true); // layout 3 from the document's creation
        // A upgrades by bolding "b"
        a.update(() => {
          const n = $text('b');
          const at = n.getTextContent().indexOf('b');
          const sel = $createRangeSelection();
          sel.anchor.set(n.getKey(), at, 'text');
          sel.focus.set(n.getKey(), at + 1, 'text');
          sel.formatText('bold');
          $setSelection(null);
        });
        await flush();
        expect(records(a)).toBe(true);
        const fresh = await freshReader(a);
        const L = JSON.stringify(LEGIT);
        const want = sameKeyOnly
          ? `a:[5]|x:[2]| :${L}|b:${L}|c:[]`
          : 'a:[5]|x:[2]|b:[1]|c:[]';
        expect(states(fresh.editor)).toBe(want);
        expect(states(a.editor)).toBe(want);
        expect(a.warnings.filter(w => w.includes('self-check'))).toEqual([]);
        await t.sync();
        expect(states(b.editor)).toBe(states(fresh.editor));
      });
    }

    test('a nested root with its layout 1 record undone (layout 3 kept), no binding: app delete + undo of the pair around X', async () => {
      const doc = createYDoc(null, {gc});
      doc.clientID = 7;
      const child = new Y.Node('editor');
      doc.transact(() => doc.get('app').setAttr('editor', child));
      const editor = createEditor({
        onError: e => {
          throw e;
        },
      });
      editor.update(() => $getRoot().clear().append($p('ab')), {
        discrete: true,
      });
      editor.update(
        () => {
          $selectIn([0], 0, 2).formatText('bold');
          $setSelection(null);
        },
        {discrete: true},
      );
      const binding = new YBinding(editor, doc as never, {
        root: child,
        schemaVersion: 1,
        selfCheck: true,
      });
      // app UndoManager capturing initialization; on undo it deletes only the layout 1 record
      const initUm = new Y.UndoManager(child, {
        captureTimeout: 0,
        deleteFilter: (item: any) => item.parentSub === 'lexical-y:1',
        trackedOrigins: new Set<unknown>([binding, null]),
      });
      // track whatever origin initialization uses (the binding passes its own origin token)
      const track = (tr: any) => initUm.trackedOrigins.add(tr.origin);
      doc.on('beforeTransaction', track);
      binding.start();
      binding.initialize();
      doc.off('beforeTransaction', track);
      initUm.trackedOrigins.clear();
      expect((initUm as any).undoStack.length).toBeGreaterThan(0);
      editor.update(
        () => {
          const s = $selectIn([0], 1);
          s.format = 0;
          s.insertText('X');
          $setSelection(null);
        },
        {discrete: true},
      );
      expect(fmts(editor)).toBe('a{1}|X{0}|b{1}');
      initUm.undo();
      initUm.destroy();
      expect(child.getAttr('lexical-y:1')).toBeUndefined();
      expect(child.getAttr('lexical-y:3')).toBe(true);
      const encoded = Y.encodeStateAsUpdate(doc as never);
      binding.dispose();
      const d = createYDoc(null, {gc});
      d.clientID = 9;
      Y.applyUpdate(d as never, encoded);
      const c = d.get('app').getAttr('editor') as any;
      const um = new Y.UndoManager(c, {captureTimeout: 0});
      d.transact(tr => {
        for (let it = c._start; it; it = it.right) {
          if (
            !it.deleted &&
            it.content instanceof Y.ContentFormat &&
            it.content.key === 'f:bold' &&
            Array.isArray(it.content.value)
          )
            it.delete(tr);
        }
      });
      um.undo();
      um.destroy();
      const e1 = createEditor({
        onError: e => {
          throw e;
        },
      });
      const b1 = new YBinding(e1, d as never, {
        root: c,
        schemaVersion: 1,
        selfCheck: true,
      });
      b1.start();
      b1.initialize();
      const d3 = createYDoc(null, {gc});
      Y.applyUpdate(d3 as never, Y.encodeStateAsUpdate(d as never));
      const e3 = createEditor({
        onError: e => {
          throw e;
        },
      });
      const b3 = new YBinding(e3, d3 as never, {
        root: d3.get('app').getAttr('editor') as any,
        schemaVersion: 1,
        selfCheck: true,
      });
      b3.start();
      b3.initialize();
      expect(fmts(e3)).toBe(fmts(e1));
      expect(fmts(e3)).toBe('a{1}|X{0}|b{1}');
      b1.dispose();
      b3.dispose();
    });
  });
}
