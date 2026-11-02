/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// D99 (accepted limit): an undo or redo that restores content inside a
// container keeps that container from collection until reload (Yjs
// UndoManager). When content in a container (such as a table cell) is
// deleted—either directly by an edit, or when undoing an insertion—the
// UndoManager records that deletion on a stack item and keepItem walks up the
// parent chain setting keep = true on the cell, row and table. When an undo
// restores that deleted content (or a redo re-inserts it), popStackItem pops
// the deletion step off the stack. When the undo history is cleared or
// destroyed, Yjs's clearUndoManagerStackItem only un-keeps items in deletions
// of steps still on the stacks; the popped deletion step is no longer on any
// stack, so its parent keep walk is never released. If a collaborator later
// deletes that container, the deleted container structs stay in this client's
// document until reload (compacted when loaded into a fresh document with gc on).
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
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
import {expect, test} from 'vitest';

import {MARKER} from '../../../internal/Schema';
import {setup} from '../../utils/harness';

/** Live containers of `doc` (Y types other than a line's marker). */
const liveContainers = (doc: Y.Doc): Set<string> => {
  const out = new Set<string>();
  for (const structs of doc.store.clients.values()) {
    for (const s of structs) {
      if (
        s instanceof Y.Item &&
        !s.deleted &&
        s.content instanceof Y.ContentType &&
        s.content.type.name !== MARKER
      ) {
        out.add(`${s.id.client}:${s.id.clock}`);
      }
    }
  }
  return out;
};

/** Deleted containers `doc` still holds (not collected). */
const deletedContainers = (doc: Y.Doc): string[] => {
  const out: string[] = [];
  for (const structs of doc.store.clients.values()) {
    for (const s of structs) {
      if (
        s instanceof Y.Item &&
        s.deleted &&
        s.content instanceof Y.ContentType
      ) {
        out.push(`${s.id.client}:${s.id.clock}`);
      }
    }
  }
  return out;
};

type EditFlow =
  | 'type'
  | 'type, then undo'
  | 'type, undo, then redo'
  | 'delete'
  | 'delete, then undo';

const CASES: [string, EditFlow, number][] = [
  ['is collected when client typed and cleared before stopping', 'type', 0],
  [
    'is collected when client typed, undid, and cleared before stopping',
    'type, then undo',
    0,
  ],
  [
    'stays in document when client typed, undid, redid, and cleared before stopping',
    'type, undo, then redo',
    3,
  ],
  ['is collected when client deleted and cleared before stopping', 'delete', 0],
  [
    'stays in document when client deleted, undid, and cleared before stopping',
    'delete, then undo',
    3,
  ],
];

for (const [name, flow, kept] of CASES) {
  test(`a table a collaborator deletes ${name} (gc on)`, async () => {
    const t = await setup(
      () => {
        const cell = $createTableCellNode(0).append(
          $createParagraphNode().append($createTextNode('cell text')),
        );
        $getRoot().append(
          $createParagraphNode().append($createTextNode('before')),
          $createTableNode().append($createTableRowNode().append(cell)),
          $createParagraphNode().append($createTextNode('after')),
        );
      },
      {gc: true, ids: [1, 2]},
    );
    try {
      const [A, B] = t.peers;
      if (flow === 'delete' || flow === 'delete, then undo') {
        A.update(() => {
          const text = (
            $getRoot().getChildAtIndex(1) as ElementNode
          ).getFirstDescendant() as TextNode;
          const s = $createRangeSelection();
          s.anchor.set(text.getKey(), 1, 'text');
          s.focus.set(text.getKey(), 2, 'text');
          $setSelection(s);
          s.removeText();
          $setSelection(null);
        });
      } else {
        A.update(() =>
          (
            (
              $getRoot().getChildAtIndex(1) as ElementNode
            ).getFirstDescendant() as TextNode
          )
            .select(4, 4)
            .insertText(' typed'),
        );
      }
      await t.sync();

      if (
        flow === 'type, then undo' ||
        flow === 'type, undo, then redo' ||
        flow === 'delete, then undo'
      ) {
        A.undo();
        await t.sync();
      }
      if (flow === 'type, undo, then redo') {
        A.binding.redo();
        await t.sync();
      }

      A.binding.undoManager?.clear();
      A.stop();

      const beforeDelete = liveContainers(A.doc);
      B.update(
        () => void ($getRoot().getChildAtIndex(1) as ElementNode).remove(),
      );
      await t.sync();
      const afterDelete = liveContainers(A.doc);
      const removed = [...beforeDelete]
        .filter(id => !afterDelete.has(id))
        .sort();
      expect(removed).toHaveLength(3);

      const leftInA = deletedContainers(A.doc);
      if (kept === 0) {
        expect(leftInA).toEqual([]);
      } else {
        expect(leftInA.sort()).toEqual(removed);
        const fresh = new Y.Doc({gc: true});
        Y.applyUpdate(fresh, Y.encodeStateAsUpdate(A.doc));
        expect(deletedContainers(fresh)).toEqual([]);
      }
    } finally {
      t.peers.forEach(p => p.stop());
    }
  });
}

test('an undo restoring deleted text in a container keeps it from gc (plain Yjs)', () => {
  const doc = new Y.Doc({gc: true});
  const root = doc.get('root');
  const table = new Y.Node('table');
  const row = new Y.Node('row');
  const cell = new Y.Node('cell');
  root.insert(0, [table]);
  table.insert(0, [row]);
  row.insert(0, [cell]);
  cell.insert(0, 'hello world');

  const um = new Y.UndoManager(root, {captureTimeout: 0});
  cell.delete(5, 6); // delete ' world': puts deletion on undoStack, keeps cell, row, table
  um.undo(); // popStackItem pops deletion from undoStack; re-creates text
  um.clear(); // popped deletion step is not on any stack, so clear() cannot un-keep it
  um.destroy();

  // Collaborator deletes the table
  root.delete(0, 1);

  // The table, row and cell stay kept in doc
  expect(deletedContainers(doc)).toHaveLength(3);

  // A fresh document loaded from that state collects them
  const fresh = new Y.Doc({gc: true});
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
  expect(deletedContainers(fresh)).toHaveLength(0);
});

test('a redo restoring an insert in a container keeps it from gc (plain Yjs)', () => {
  const doc = new Y.Doc({gc: true});
  const root = doc.get('root');
  const table = new Y.Node('table');
  const row = new Y.Node('row');
  const cell = new Y.Node('cell');
  root.insert(0, [table]);
  table.insert(0, [row]);
  row.insert(0, [cell]);
  cell.insert(0, 'hello');

  const um = new Y.UndoManager(root, {captureTimeout: 0});
  cell.insert(5, ' world'); // insert
  um.undo(); // undo: deletes ' world', puts deletion on redoStack, keeps cell, row, table
  um.redo(); // redo: popStackItem pops deletion from redoStack, re-creates text
  um.clear(); // popped deletion step is not on any stack, so clear() cannot un-keep it
  um.destroy();

  // Collaborator deletes the table
  root.delete(0, 1);

  // The table, row and cell stay kept in doc
  expect(deletedContainers(doc)).toHaveLength(3);

  // A fresh document loaded from that state collects them
  const fresh = new Y.Doc({gc: true});
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
  expect(deletedContainers(fresh)).toHaveLength(0);
});
