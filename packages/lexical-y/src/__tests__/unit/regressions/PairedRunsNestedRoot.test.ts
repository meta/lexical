/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A binding's root can be a nested Y.Node (the `root` option). Paired
// writes climbed to the top-level type above it: they recorded layout 3
// there, and read pairing from there, while the bound root kept layout 1,
// so an older binding of that root stayed editable
//. The bound root now holds the record, and pairing, recording and
// invalidation use it.

import {ListItemNode, ListNode} from '@lexical/list';
import {HeadingNode, QuoteNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  createEditor,
  type LexicalEditor,
} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../../..';

const NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode];

function client(doc: Y.Doc, root: Y.Node, text: string | null) {
  const editor = createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
  });
  if (text !== null) {
    editor.update(
      () =>
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode(text))),
      {discrete: true},
    );
  }
  const binding = new YBinding(editor, doc as never, {
    root,
    schemaVersion: 1,
    selfCheck: true,
  });
  binding.start();
  return {binding, editor};
}

const bindings: YBinding[] = [];
afterEach(() => {
  for (const b of bindings.splice(0)) {
    b.dispose();
  }
});

const formats = (editor: LexicalEditor) =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getAllTextNodes()
      .filter($isTextNode)
      .map(n => [n.getTextContent(), n.getFormat()]),
  );

for (const gc of [false, true]) {
  test(`a binding on a nested root records layout 3 on that root (gc ${gc ? 'on' : 'off'})`, () => {
    const doc = createYDoc(null, {gc});
    const root = new Y.Node('editor-root');
    doc.get('app').setAttr('editor', root);
    const c = client(doc, root, 'ab');
    bindings.push(c.binding);
    c.binding.initialize();
    c.editor.update(
      () => {
        const text = $getRoot().getAllTextNodes()[0];
        text.select(0, 1).formatText('bold');
      },
      {discrete: true},
    );
    expect(root.getAttr('lexical-y:4')).toBe(true);
    expect(doc.get('app').getAttr('lexical-y:4')).toBeUndefined();
    // A reader of the same root, and of a reload, reads the paired runs.
    const reload = createYDoc(Y.encodeStateAsUpdate(doc), {gc});
    const again = reload.get('app').getAttr('editor') as Y.Node;
    const r = client(reload, again, null);
    bindings.push(r.binding);
    expect(formats(r.editor)).toEqual(formats(c.editor));
    expect(formats(c.editor)).toEqual([
      ['a', 1],
      ['b', 0],
    ]);
  });
}
