/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Inside an app's outer transaction, an UndoManager redo inserts copies of
// ends that the copy repair re-points before observers run; a binding
// started in the same transaction read before that, so the new opener read
// as unpaired while its end was valid, and the binding showed "Xb" plain
// where main shows "b" bold.
// Reads now bring pending copies current first.

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

import {createYDoc, YBinding} from '../../..';
import {setFormatIdentityWrites} from '../../utils/noSwitch';

const bindings: YBinding[] = [];
afterEach(() => {
  for (const b of bindings.splice(0)) {
    b.dispose();
  }
});

function bind(
  doc: Y.Doc,
  init?: () => void,
): {binding: YBinding; editor: LexicalEditor} {
  const editor = createEditor({
    onError: e => {
      throw e;
    },
  });
  if (init !== undefined) {
    editor.update(init, {discrete: true});
  }
  const binding = new YBinding(editor, doc as never, {schemaVersion: 1});
  bindings.push(binding);
  binding.start();
  if (init !== undefined) {
    binding.initialize();
  }
  return {binding, editor};
}

const formats = (editor: LexicalEditor) =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getAllTextNodes()
      .filter($isTextNode)
      .map(n => [n.getTextContent(), n.getFormat()]),
  );

for (const gc of [false, true]) {
  test(`a binding started inside an app's outer transaction reads the redo's copies repaired (gc ${gc ? 'on' : 'off'})`, () => {
    const doc = createYDoc(null, {gc});
    const first = bind(doc, () => {
      const ab = $createTextNode('ab');
      ab.toggleFormat('bold');
      $getRoot().append($createParagraphNode().append(ab));
    });
    setFormatIdentityWrites(doc, true);
    // The app's manager keeps text and removes both format items of each
    // pair the binding's writes made.
    const um = new Y.UndoManager(doc.get('lexical-y'), {
      captureTimeout: 0,
      deleteFilter: item => item.content instanceof Y.ContentFormat,
      trackedOrigins: new Set<unknown>([first.binding]),
    });
    try {
      first.editor.update(
        () => {
          const ab = $getRoot().getAllTextNodes()[0] as TextNode;
          const sel = ab.select(1, 1);
          sel.format = 0;
          sel.insertText('X');
        },
        {discrete: true},
      );
      // A second reader builds the index of ends, then stops.
      const second = bind(doc);
      expect(formats(second.editor)).toEqual([
        ['a', 1],
        ['X', 0],
        ['b', 1],
      ]);
      second.binding.dispose();
      um.undo();
      // Redo inside an outer transaction, and a binding started in it.
      let shown: unknown = null;
      doc.transact(() => {
        um.redo();
        shown = formats(bind(doc).editor);
      });
      expect(shown).toEqual([
        ['a', 1],
        ['X', 0],
        ['b', 1],
      ]);
    } finally {
      um.destroy();
    }
  });
}
