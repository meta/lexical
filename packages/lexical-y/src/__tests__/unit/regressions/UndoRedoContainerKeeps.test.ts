/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// D99 (accepted limit): an undo or redo that restores content inside a
// container (a table cell) can keep that container, its row and its table
// from garbage collection until reload. The UndoManager step that deleted the
// content kept it and, walking up, the cell, row and table (Yjs's keepItem
// stops at an ancestor already kept). The undo or redo that restores the
// content takes that step off the stacks, and Yjs's clear() releases only
// the steps still on them, so a clear before the binding stops does not
// release the cell. It does when the step's deletion was the first thing to
// keep the cell: a cell the binding already kept for one of its own format
// items (D88) is let go when the binding stops, and a deletion in the same
// cell still on a stack is released by the clear, parents included. If a
// collaborator then deletes the table, the deleted table, row and cell stay
// in this client's document until it reloads (compacted when its state is
// loaded into a fresh document with gc on). Destroying an UndoManager
// releases nothing (D98).
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

type Step = 'type' | 'delete' | 'delete again' | 'bold' | 'undo' | 'redo';

// [name, A's steps in the cell, the cell's text after each step, containers
// left in A after A clears, stops and B deletes the table]
const CASES: [string, Step[], string[], number][] = [
  ['is collected when A typed', ['type'], ['cell typed text'], 0],
  [
    'is collected when A typed and undid',
    ['type', 'undo'],
    ['cell typed text', 'cell text'],
    0,
  ],
  [
    'stays in A\u2019s document when A typed, undid and redid',
    ['type', 'undo', 'redo'],
    ['cell typed text', 'cell text', 'cell typed text'],
    3,
  ],
  ['is collected when A deleted', ['delete'], ['cll text'], 0],
  [
    'stays in A\u2019s document when A deleted and undid',
    ['delete', 'undo'],
    ['cll text', 'cell text'],
    3,
  ],
  // The binding kept the cell for its own bold (D88) before the undo step's
  // deletion, so that step kept only what it deleted (keepItem stops at a
  // kept parent), and the binding lets the cell go when it stops.
  [
    'is collected when A bolded first, then typed, undid and redid',
    ['bold', 'type', 'undo', 'redo'],
    ['cell text', 'cell typed text', 'cell text', 'cell typed text'],
    0,
  ],
  [
    'is collected when A bolded first, then deleted and undid',
    ['bold', 'delete', 'undo'],
    ['cell text', 'cll text', 'cell text'],
    0,
  ],
  // The first deletion's step is still on the undo stack, so the clear
  // releases it, and with it the cell, row and table.
  [
    'is collected when A deleted twice and undid the second',
    ['delete', 'delete again', 'undo'],
    ['cll text', 'cl text', 'cll text'],
    0,
  ],
];

for (const [name, steps, texts, kept] of CASES) {
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
      const $cellText = () =>
        (
          $getRoot().getChildAtIndex(1) as ElementNode
        ).getFirstDescendant() as TextNode;
      const $select = (from: number, to: number) => {
        const text = $cellText();
        const s = $createRangeSelection();
        s.anchor.set(text.getKey(), from, 'text');
        s.focus.set(text.getKey(), to, 'text');
        $setSelection(s);
        return s;
      };
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step === 'undo') {
          A.undo();
        } else if (step === 'redo') {
          A.binding.undoManager!.stopCapturing();
          A.binding.redo();
        } else {
          A.update(() => {
            if (step === 'type') {
              $select(4, 4).insertText(' typed');
            } else if (step === 'delete' || step === 'delete again') {
              $select(1, 2).removeText();
            } else {
              $select(5, 9).formatText('bold');
            }
            $setSelection(null);
          });
        }
        await t.sync();
        expect(
          A.read(() => $getRoot().getChildAtIndex(1)!.getTextContent()),
          `after ${step}`,
        ).toBe(texts[i]);
      }

      A.binding.undoManager!.clear();
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
      // B's delete reached A: the table, its row and its cell.
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

const plainTable = () => {
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
  return {cell, doc, root, um};
};

test('an undo restoring deleted text in a container keeps it from gc (plain Yjs)', () => {
  const {cell, doc, root, um} = plainTable();
  cell.delete(5, 6); // the step keeps ' world' and the cell, row and table
  expect(cell.toString()).toBe('<cell>hello</cell>');
  expect(um.undo()).not.toBe(null); // takes the step off the undo stack
  expect(cell.toString()).toBe('<cell>hello world</cell>');
  um.clear(); // releases only the steps still on the stacks
  um.destroy();

  // The table is deleted (the UndoManager no longer tracks anything).
  root.delete(0, 1);

  // The table, row and cell stay in doc.
  expect(deletedContainers(doc)).toHaveLength(3);

  // A fresh document loaded from that state collects them.
  const fresh = new Y.Doc({gc: true});
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
  expect(deletedContainers(fresh)).toHaveLength(0);
});

test('a redo restoring an insert in a container keeps it from gc (plain Yjs)', () => {
  const {cell, doc, root, um} = plainTable();
  cell.delete(5, 6);
  um.clear(); // starts from a cell nothing keeps
  cell.insert(5, ' there');
  expect(um.undo()).not.toBe(null); // its step keeps ' there' and the cell, row and table
  expect(cell.toString()).toBe('<cell>hello</cell>');
  expect(um.redo()).not.toBe(null); // takes that step off the redo stack
  expect(cell.toString()).toBe('<cell>hello there</cell>');
  um.clear();
  um.destroy();

  root.delete(0, 1);

  expect(deletedContainers(doc)).toHaveLength(3);

  const fresh = new Y.Doc({gc: true});
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
  expect(deletedContainers(fresh)).toHaveLength(0);
});
