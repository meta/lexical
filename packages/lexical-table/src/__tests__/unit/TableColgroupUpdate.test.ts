/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A column width change is written onto the <col>s the table already
// rendered. Replacing them with new <col>s left the old layout behind: a
// table sized by its content kept its old width after its columns were
// narrowed (browser/ColgroupWidthChange.test.ts measures that). jsdom does no
// layout, so this pins the DOM half: the same <col> nodes, carrying the new
// widths.

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createTableCellNode,
  $createTableNodeWithDimensions,
  $isTableNode,
  $isTableRowNode,
  TableExtension,
} from '@lexical/table';
import {$createParagraphNode, $getRoot, type LexicalEditor} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

/** A three-column table pinned at 300px a column. */
function mount() {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions({
    dependencies: [TableExtension],
    name: 'test/table-colgroup-update',
    onError: e => {
      throw e;
    },
    theme: {tableScrollableWrapper: 'table-scrollable-wrapper'},
  });
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  editor.update(
    () => {
      const table = $createTableNodeWithDimensions(2, 3, false);
      table.setColWidths([300, 300, 300]);
      $getRoot().clear().append(table);
    },
    {discrete: true},
  );
  return {editor, root};
}

function $getTable() {
  const table = $getRoot().getFirstChild();
  if (!$isTableNode(table)) {
    throw new Error('Expected the table');
  }
  return table;
}

function setColWidths(
  editor: LexicalEditor,
  colWidths: readonly number[] | undefined,
) {
  editor.update(
    () => {
      $getTable().setColWidths(colWidths);
    },
    {discrete: true},
  );
}

function getCols(root: HTMLElement) {
  return Array.from(
    root.querySelectorAll<HTMLTableColElement>('table > colgroup > col'),
  );
}

// Identity, not shape: a replaced <col> with the same width still fails.
function expectSameNodes(actual: Element[], expected: Element[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((node, i) => expect(node).toBe(expected[i]));
}

test('a width change updates the <col>s already rendered', () => {
  const {editor, root} = mount();
  const before = getCols(root);
  expect(before.map(col => col.style.width)).toEqual([
    '300px',
    '300px',
    '300px',
  ]);

  setColWidths(editor, [100, 120, 140]);

  const after = getCols(root);
  expect(after.map(col => col.style.width)).toEqual([
    '100px',
    '120px',
    '140px',
  ]);
  expectSameNodes(after, before);
});

// A fresh <col> for a column without a width (0) had no style attribute at
// all; the <col> updated in place must not keep its old width either.
test('a column left without a width loses its style attribute', () => {
  const {editor, root} = mount();
  const before = getCols(root);

  setColWidths(editor, [100, 120, 0]);

  const after = getCols(root);
  expectSameNodes(after, before);
  expect(after[0].style.width).toBe('100px');
  expect(after[2].hasAttribute('style')).toBe(false);
});

test('adding and removing a column appends and trims <col>s at the end', () => {
  const {editor, root} = mount();
  const before = getCols(root);

  editor.update(
    () => {
      const table = $getTable();
      for (const row of table.getChildren()) {
        if ($isTableRowNode(row)) {
          row.append($createTableCellNode().append($createParagraphNode()));
        }
      }
      table.setColWidths([300, 300, 300, 200]);
    },
    {discrete: true},
  );

  const grown = getCols(root);
  expect(grown.map(col => col.style.width)).toEqual([
    '300px',
    '300px',
    '300px',
    '200px',
  ]);
  expectSameNodes(grown.slice(0, 3), before);

  editor.update(
    () => {
      const table = $getTable();
      for (const row of table.getChildren()) {
        if ($isTableRowNode(row)) {
          row.getLastChildOrThrow().remove();
        }
      }
      table.setColWidths([300, 300, 300]);
    },
    {discrete: true},
  );

  expectSameNodes(getCols(root), before);
});

test('clearing the widths removes the colgroup', () => {
  const {editor, root} = mount();

  setColWidths(editor, undefined);

  expect(root.querySelector('table > colgroup')).toBeNull();
});
