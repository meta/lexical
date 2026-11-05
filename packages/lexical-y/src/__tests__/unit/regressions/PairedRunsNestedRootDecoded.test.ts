/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A binding's root can be a nested Y.Node. Pairing climbed to the top-level
// type unless a binding had registered the nested root, so a document
// decoded with createYDoc read its nested layout 3 root as plain until a
// binding started: its lifetime copy repair did nothing, and an app undo of
// both format items around a word sent an unrepaired end (an encoded reload
// read "Xb" plain where main keeps "b" bold).
// The root is now the nearest type holding a layout record, whatever has
// registered it.

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  createEditor,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {createYDoc, RAW_YJS_WRITE_WARNING, YBinding} from '../../..';

const bindings: YBinding[] = [];
/** The codes of the warnings the test's editors were given, in order. */
const warnings: string[] = [];
afterEach(() => {
  for (const b of bindings.splice(0)) {
    b.dispose();
  }
  warnings.length = 0;
});

function bind(doc: Y.Doc, root: Y.Node, init?: () => void): LexicalEditor {
  const editor = createEditor({
    onError: e => {
      throw e;
    },
    onWarn: w => {
      warnings.push(String((w as {code?: string}).code));
    },
  });
  if (init !== undefined) {
    editor.update(init, {discrete: true});
  }
  const binding = new YBinding(editor, doc as never, {root, schemaVersion: 1});
  bindings.push(binding);
  binding.start();
  if (init !== undefined) {
    binding.initialize();
  }
  return editor;
}

const formats = (editor: LexicalEditor) =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getAllTextNodes()
      .filter($isTextNode)
      .map(n => [n.getTextContent(), n.getFormat()]),
  );

for (const gc of [false, true])
  for (const withoutLayout1 of [false, true]) {
    test(`a decoded nested layout 3 root repairs an app undo's copies before any binding${withoutLayout1 ? ', its layout 1 record deleted' : ''} (gc ${gc ? 'on' : 'off'})`, () => {
      // 1-2: bind a nested root, seed bold "ab", insert plain "X" with paired
      // writes, encode.
      const doc = createYDoc(null, {gc});
      const root = new Y.Node('editor-root');
      doc.get('app').setAttr('editor', root);
      const editor = bind(doc, root, () => {
        const ab = $createTextNode('ab');
        ab.toggleFormat('bold');
        $getRoot().append($createParagraphNode().append(ab));
      });
      editor.update(
        () => {
          const ab = $getRoot().getAllTextNodes()[0] as TextNode;
          const sel = ab.select(1, 1);
          sel.format = 0;
          sel.insertText('X');
        },
        {discrete: true},
      );
      expect(root.getAttr('lexical-y:3')).toBe(true);
      if (withoutLayout1) {
        // An app UndoManager that captured the
        // initialization, with a delete filter that keeps everything but the
        // layout 1 record, undoes it after paired writes: layout 3 stays and
        // layout 1 is gone. The root is still known by a layout record.
        doc.transact(() => root.deleteAttr('lexical-y:1'));
        expect(root.getAttr('lexical-y:1')).toBeUndefined();
      }
      // 3: decode, without a binding.
      const decoded = createYDoc(Y.encodeStateAsUpdate(doc), {gc});
      const nested = decoded.get('app').getAttr('editor') as Y.Node;
      // 4: an app UndoManager on the nested root deletes both format items
      // around "X" in its own transaction, then undoes that.
      const origin = {app: true};
      const um = new Y.UndoManager(nested, {
        captureTimeout: 0,
        trackedOrigins: new Set<unknown>([origin]),
      });
      try {
        const around: Y.Item[] = [];
        for (let it = nested._start; it !== null; it = it.right) {
          if (
            !it.deleted &&
            it.content instanceof Y.ContentString &&
            it.content.str === 'X'
          ) {
            let l = it.left;
            while (l !== null && l.deleted) {
              l = l.left;
            }
            let r = it.right;
            while (r !== null && r.deleted) {
              r = r.right;
            }
            if (l !== null && l.content instanceof Y.ContentFormat) {
              around.push(l);
            }
            if (r !== null && r.content instanceof Y.ContentFormat) {
              around.push(r);
            }
          }
        }
        expect(around.length).toBe(2);
        decoded.transact(tr => {
          for (const it of around) {
            it.delete(tr);
          }
        }, origin);
        um.undo();
        // 5: a binding on the same object, and an encoded reload, agree, as on
        // main: "a" bold, "X" plain, "b" bold.
        const same = bind(decoded, nested);
        const reload = createYDoc(Y.encodeStateAsUpdate(decoded), {gc});
        const again = bind(
          reload,
          reload.get('app').getAttr('editor') as Y.Node,
        );
        const want = [
          ['a', 1],
          ['X', 0],
          ['b', 1],
        ];
        expect(formats(same)).toEqual(want);
        expect(formats(again)).toEqual(want);
        // The layout 1 record deleted in a transaction of no binding is a
        // raw write under the first binding's root, on purpose (it stands in
        // for an app's undo): reported to that editor in development.
        expect(warnings).toEqual(withoutLayout1 ? [RAW_YJS_WRITE_WARNING] : []);
      } finally {
        um.destroy();
      }
    });
  }
