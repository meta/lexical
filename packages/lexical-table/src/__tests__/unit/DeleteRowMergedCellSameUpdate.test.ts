/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createTableNodeWithDimensions,
  $createTableSelectionFrom,
  $deleteTableRowAtSelection,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $mergeCells,
  TableExtension,
  type TableNode,
} from '@lexical/table';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $setSelection,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

// $deleteTableRowAtSelection trims the row span of a merged cell that reaches
// past the deleted rows. When that cell is already writable in the current
// update (for example, merged earlier in the same update), setRowSpan changes
// it in place, so the span must not be read again after it is trimmed.

type Cells = [row: number, column: number][];
interface Case {
  name: string;
  rows: number;
  columns: number;
  merge: Cells;
  deleteRows: [anchor: [number, number], focus: [number, number]];
  expected: string[];
}

const cases: Case[] = [
  {
    columns: 2,
    deleteRows: [
      [0, 0],
      [0, 0],
    ],
    expected: ['A2 | B1 B2'],
    merge: [
      [0, 1],
      [1, 1],
    ],
    name: 'deleting the top row of a 2-row merged cell',
    rows: 2,
  },
  {
    columns: 3,
    deleteRows: [
      [0, 0],
      [0, 0],
    ],
    expected: ['A2 | B1 C1 B2 C2 cs2', 'A3 | B3 | C3'],
    merge: [
      [0, 1],
      [0, 2],
      [1, 1],
      [1, 2],
    ],
    name: 'deleting the top row of a 2x2 merged cell',
    rows: 3,
  },
  {
    columns: 2,
    deleteRows: [
      [1, 0],
      [2, 0],
    ],
    expected: ['A1 | B1 B2 B3 B4 rs2', 'A4'],
    merge: [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ],
    name: 'deleting two middle rows of a 4-row merged cell',
    rows: 4,
  },
];

function $cellAt(table: TableNode, row: number, column: number) {
  const rowNode = table.getChildAtIndex(row);
  assert($isTableRowNode(rowNode), 'expected a TableRowNode');
  const cell = rowNode.getChildAtIndex(column);
  assert($isTableCellNode(cell), 'expected a TableCellNode');
  return cell;
}

function $table(): TableNode {
  const table = $getRoot().getFirstChild();
  assert($isTableNode(table), 'expected a TableNode');
  return table;
}

function run(c: Case, sameUpdate: boolean): string[] {
  using editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [TableExtension],
      name: 'delete-row-merged-cell-host',
      theme: {tableScrollableWrapper: ''},
    }),
  );
  editor.update(
    () => {
      const table = $createTableNodeWithDimensions(c.rows, c.columns, false);
      $getRoot().clear().append(table);
      for (let row = 0; row < c.rows; row++) {
        for (let column = 0; column < c.columns; column++) {
          const paragraph = $cellAt(table, row, column).getFirstChild();
          assert($isElementNode(paragraph), 'expected a paragraph');
          paragraph.append(
            $createTextNode(String.fromCharCode(65 + column) + (row + 1)),
          );
        }
      }
    },
    {discrete: true},
  );
  const $merge = () => {
    const table = $table();
    $mergeCells(c.merge.map(([row, column]) => $cellAt(table, row, column)));
  };
  const $delete = () => {
    const table = $table();
    const [[ar, ac], [fr, fc]] = c.deleteRows;
    $setSelection(
      $createTableSelectionFrom(
        table,
        $cellAt(table, ar, ac),
        $cellAt(table, fr, fc),
      ),
    );
    $deleteTableRowAtSelection();
  };
  if (sameUpdate) {
    editor.update(
      () => {
        $merge();
        $delete();
      },
      {discrete: true},
    );
  } else {
    editor.update($merge, {discrete: true});
    editor.update($delete, {discrete: true});
  }
  return editor.read(() =>
    $table()
      .getChildren()
      .map(row => {
        assert($isTableRowNode(row), 'expected a TableRowNode');
        return row
          .getChildren()
          .map(cell => {
            assert($isTableCellNode(cell), 'expected a TableCellNode');
            const text = cell.getTextContent().split(/\n+/).join(' ');
            const rowSpan = cell.getRowSpan();
            const colSpan = cell.getColSpan();
            return (
              text +
              (rowSpan > 1 ? ` rs${rowSpan}` : '') +
              (colSpan > 1 ? ` cs${colSpan}` : '')
            );
          })
          .join(' | ');
      }),
  );
}

describe('$deleteTableRowAtSelection with a merged cell', () => {
  test.each(cases)('$name, in separate updates', c => {
    expect(run(c, false)).toEqual(c.expected);
  });

  test.each(cases)('$name, in the same update as the merge', c => {
    expect(run(c, true)).toEqual(c.expected);
  });
});
