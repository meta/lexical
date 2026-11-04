/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

import {
  $createTableNodeWithDimensions,
  $createTableSelection,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $setSelection,
  createEditor,
  type ElementNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YBinding} from '../../..';
import {NODES} from '../../utils/harness';

const GC = process.env.LEXICAL_Y_GC === '1';

type P = {
  doc: Y.Doc;
  editor: ReturnType<typeof createEditor>;
  binding: YBinding;
};

function peer(id: number, state?: Uint8Array): P {
  const doc = createYDoc(null, {gc: GC});
  doc.clientID = id;
  if (state !== undefined) {
    Y.applyUpdate(doc, state, 'load');
  }
  const editor = createEditor({
    namespace: 'ragged-table-selection',
    nodes: NODES,
    onError: e => {
      throw e;
    },
  });
  const binding = new YBinding(editor, doc, {
    schemaVersion: 1,
    selfCheck: true,
  });
  binding.start();
  return {binding, doc, editor};
}

const update = (p: P, fn: () => void) => {
  p.binding.undoManager?.stopCapturing();
  p.editor.update(fn, {discrete: true});
};

function exchange(peers: P[]): void {
  for (let round = 0; round < 3; round++) {
    for (const a of peers) {
      for (const b of peers) {
        if (a !== b) {
          Y.applyUpdate(
            b.doc,
            Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)),
            'net',
          );
        }
      }
    }
  }
}

const $table = () => $getRoot().getChildren().find($isTableNode) as ElementNode;
const $cell = (r: number, c: number) =>
  ($table().getChildAtIndex(r) as ElementNode).getChildAtIndex(
    c,
  ) as ElementNode;
const shape = (p: P) =>
  p.editor.getEditorState().read(() =>
    $table()
      .getChildren()
      .map(r => (r as ElementNode).getChildrenSize()),
  );

function selectAll(p: P): {tried: number; crashes: string[]} {
  const cells: [number, number][] = [];
  p.editor.getEditorState().read(() => {
    $table()
      .getChildren()
      .forEach((r, i) => {
        for (let j = 0; j < (r as ElementNode).getChildrenSize(); j++)
          cells.push([i, j]);
      });
  });
  const crashes: string[] = [];
  let tried = 0;
  for (const a of cells) {
    for (const f of cells) {
      tried++;
      try {
        p.editor.update(
          () => {
            const sel = $createTableSelection();
            sel.set(
              $table().getKey(),
              $cell(a[0], a[1]).getKey(),
              $cell(f[0], f[1]).getKey(),
            );
            $setSelection(sel);
            $getSelection()!.getNodes();
          },
          {discrete: true},
        );
      } catch (e) {
        crashes.push(
          `${JSON.stringify(a)}->${JSON.stringify(f)}: ${String(e).slice(0, 120)}`,
        );
      }
    }
  }
  return {crashes, tried};
}

test('a table selection in a table made ragged by concurrent row and column inserts holds its cells', () => {
  const a = peer(1);
  update(a, () => {
    $getRoot().append(
      $createTableNodeWithDimensions(2, 2, false),
      $createParagraphNode(),
    );
  });
  a.binding.initialize();
  const s = Y.encodeStateAsUpdate(a.doc);
  const [b, c, d] = [2, 3, 4].map(id => {
    const p = peer(id, s);
    p.binding.initialize();
    return p;
  });
  // Offline from the same state: one peer inserts a column, one a row, one
  // another column.
  update(b, () => {
    ($cell(0, 0).getFirstChild() as ElementNode).selectEnd();
    $insertTableColumnAtSelection(true);
  });
  update(d, () => {
    ($cell(0, 0).getFirstChild() as ElementNode).selectEnd();
    $insertTableRowAtSelection(true);
  });
  update(c, () => {
    ($cell(1, 1).getFirstChild() as ElementNode).selectEnd();
    $insertTableColumnAtSelection(true);
  });
  exchange([a, b, c, d]);
  const f = peer(99, Y.encodeStateAsUpdate(a.doc));
  f.binding.initialize();
  const shapes = [a, b, c, d, f].map(shape);
  // Every peer has the same table, ragged: the table transform leaves the
  // rows that the merged updates changed to their authors.
  expect(shapes[0].some(n => n !== shapes[0][0])).toBe(true);
  let all: string[] = [];
  let tried = 0;
  for (const p of [a, b, c, d, f]) {
    const r = selectAll(p);
    all = all.concat(r.crashes);
    tried += r.tried;
  }
  expect(tried).toBeGreaterThan(0);
  expect(
    shapes.every(x => JSON.stringify(x) === JSON.stringify(shapes[0])),
  ).toBe(true);
  expect(all).toEqual([]);
});
