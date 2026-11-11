/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment jsdom

// A read that changes the selection of an editor with a root element: Lexical
// extends such a commit with the selection change command and runs node
// transforms over the commit's changes in it. The binding's reads skip
// transforms, so what they bring (a ragged table) must stay as stored.

import {
  $createTableNodeWithDimensions,
  $createTableSelection,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableNode,
  registerTablePlugin,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $setSelection,
  COMMAND_PRIORITY_EDITOR,
  createEditor,
  type ElementNode,
  type LexicalEditor,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {$p, expectConverged, NODES, setup} from '../utils/harness';

const idle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

function client(id: number, state?: Uint8Array) {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = id;
  if (state !== undefined) {
    Y.applyUpdate(doc, state, 'load');
  }
  const editor = createEditor({
    nodes: NODES,
    onError: e => {
      throw e;
    },
  });
  const binding = new YBinding(editor, doc, {schemaVersion: 1});
  return {binding, doc, editor, stop: binding.start()};
}

const widths = (editor: LexicalEditor) =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .filter(n => n.getType() === 'table')
      .map(t =>
        (t as ElementNode)
          .getChildren()
          .map(r => (r as ElementNode).getChildrenSize()),
      ),
  );

// A row (A) or a column (B) after the first cell.
function $insertAfterFirstCell(insert: () => unknown): void {
  const table = $getRoot().getFirstChild() as ElementNode;
  const row = table.getFirstChild() as ElementNode;
  const cell = row.getFirstChild() as ElementNode;
  (cell.getFirstChild() as ElementNode).selectEnd();
  insert();
}

test('a client that loads a ragged table with a selection in its editor shows it as stored', async () => {
  const a = client(1);
  a.editor.update(
    () => $getRoot().append($createTableNodeWithDimensions(2, 2, false)),
    {discrete: true},
  );
  a.binding.initialize();
  const base = Y.encodeStateAsUpdate(a.doc);
  const sv = Y.encodeStateVector(a.doc);
  const b = client(2, base);
  b.binding.initialize();
  // A row insert ‖ a column insert: the new row lacks the new column.
  a.editor.update(
    () => $insertAfterFirstCell(() => $insertTableRowAtSelection(true)),
    {
      discrete: true,
    },
  );
  b.editor.update(
    () => $insertAfterFirstCell(() => $insertTableColumnAtSelection(true)),
    {discrete: true},
  );
  const relay = new Y.Doc({gc: false});
  Y.applyUpdate(relay, base);
  Y.applyUpdate(relay, Y.encodeStateAsUpdate(a.doc, sv));
  Y.applyUpdate(relay, Y.encodeStateAsUpdate(b.doc, sv));

  // The loading client has a root element, a table plugin, and a selection
  // from before its first sync (as an autofocus sets one).
  const c = client(3);
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  c.editor.setRootElement(root);
  registerTablePlugin(c.editor);
  let notified = 0;
  c.editor.registerCommand(
    SELECTION_CHANGE_COMMAND,
    () => {
      notified++;
      return false;
    },
    COMMAND_PRIORITY_EDITOR,
  );
  c.editor.update(() => $getRoot().selectEnd(), {discrete: true});
  const before = notified;
  Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(relay), 'provider');
  c.binding.initialize();
  await idle();
  expect(widths(c.editor)).toEqual([[3, 2, 3]]);
  // It wrote nothing, and selection listeners still heard of the change.
  expect(c.doc.store.clients.has(3)).toBe(false);
  expect(notified).toBeGreaterThan(before);
  for (const x of [a, b, c]) {
    x.stop();
  }
  root.remove();
});

test('a table selection across cells is dropped when a peer removes the table', async () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    const t = await setup(
      () =>
        $getRoot().append(
          $p('one'),
          $createTableNodeWithDimensions(2, 2, false),
          $p('three'),
        ),
      {ids},
    );
    t.a.update(() => {
      const table = $getRoot().getChildAtIndex(1);
      if (!$isTableNode(table)) {
        throw new Error('no table');
      }
      const first = (
        table.getFirstChildOrThrow() as ElementNode
      ).getFirstChildOrThrow();
      const last = (
        table.getLastChildOrThrow() as ElementNode
      ).getLastChildOrThrow();
      const selection = $createTableSelection();
      selection.set(table.getKey(), first.getKey(), last.getKey());
      $setSelection(selection);
    });
    t.b.update(() => $getRoot().getChildAtIndex(1)!.remove());
    await t.sync();
    expect(t.a.errors).toEqual([]);
    // The selection names no node that is gone (the table's own selection
    // handler, and an app's toolbar, would throw on it).
    expect(
      t.a.read(() => {
        const selection = $getSelection() as unknown as {
          anchor: {key: string};
          focus: {key: string};
          tableKey: string;
        } | null;
        return selection === null
          ? []
          : [
              selection.anchor.key,
              selection.focus.key,
              selection.tableKey,
            ].filter(key => $getNodeByKey(key) === null);
      }),
    ).toEqual([]);
    await expectConverged(t.peers);
  }
});
