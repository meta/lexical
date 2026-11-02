/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// D98 (accepted limit): a Yjs UndoManager destroyed without a clear keeps
// what its steps protected. B deletes a character in a table cell: its undo
// manager keeps that character and, walking up, the cell, row and table
// (Yjs keepItem). The binding then stops, which destroys that undo manager;
// Yjs's UndoManager#destroy does not clear, so those keeps stay. A
// collaborator later deletes the table: with garbage collection on, B's
// document still holds the deleted table, row and cell until it reloads.
// Clearing the undo history before stopping, and before the delete, prevents
// it; a clear after the delete releases the keeps but collects nothing.
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

/** Deleted containers B's document still holds (not collected). */
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

const MODES: [string, 'none' | 'before' | 'after'][] = [
  ['stays in B\u2019s document when B stopped without a clear', 'none'],
  ['is collected when B cleared its undo history before stopping', 'before'],
  [
    'stays in B\u2019s document when B cleared only after the table was deleted',
    'after',
  ],
];

for (const [name, clear] of MODES) {
  test(`a table a collaborator deletes ${name} (gc on)`, async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('before')),
          $createTableNode().append(
            $createTableRowNode().append(
              $createTableCellNode(0).append(
                $createParagraphNode().append($createTextNode('one two')),
              ),
            ),
          ),
          $createParagraphNode().append($createTextNode('after')),
        ),
      {gc: true, ids: [1, 2]},
    );
    try {
      // B deletes a character in the cell: its undo manager keeps it and
      // the cell, row and table.
      t.b.update(() => {
        const table = $getRoot().getChildAtIndex(1) as ElementNode;
        const row = table.getFirstChild() as ElementNode;
        const cell = row.getFirstChild() as ElementNode;
        const text = cell.getAllTextNodes()[0] as TextNode;
        const s = $createRangeSelection();
        s.anchor.set(text.getKey(), 1, 'text');
        s.focus.set(text.getKey(), 2, 'text');
        $setSelection(s);
        s.removeText();
        $setSelection(null);
      });
      await t.sync();
      // The containers A's delete removes: the table, its row and its cell.
      let removed: string[] = [];
      const deleteTable = async () => {
        const before = liveContainers(t.b.doc);
        t.a.update(() => {
          $getRoot().getChildAtIndex(1)!.remove();
        });
        await t.sync();
        const after = liveContainers(t.b.doc);
        removed = [...before].filter(id => !after.has(id)).sort();
      };
      if (clear === 'after') {
        // A deletes the table while B's history still holds the step.
        await deleteTable();
        t.b.binding.undoManager!.clear();
        t.b.stop();
      } else {
        if (clear === 'before') {
          t.b.binding.undoManager!.clear();
        }
        t.b.stop();
        await deleteTable();
      }
      const left = deletedContainers(t.b.doc);
      if (clear === 'before') {
        expect(left).toEqual([]);
      } else {
        // The table, its row and its cell (the cell's paragraph is a line
        // of the cell, not a container of its own). A binding that cleared
        // at stop would leave none here when B stopped first (checked: 0),
        // at the cost D98 names; a clear after the delete releases the keeps
        // but collects nothing (D88).
        expect(removed).toHaveLength(3);
        expect(left.sort()).toEqual(removed);
        // A fresh document from B's state collects them.
        const fresh = new Y.Doc();
        Y.applyUpdate(fresh, Y.encodeStateAsUpdate(t.b.doc));
        expect(deletedContainers(fresh)).toEqual([]);
      }
    } finally {
      t.peers.forEach(p => p.stop());
    }
  });
}
