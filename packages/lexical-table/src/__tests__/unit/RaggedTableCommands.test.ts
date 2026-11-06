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
  $computeTableMapSkipCellCheck,
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableNode,
  $isTableRowNode,
  $mergeCells,
  $padTableRows,
  $unmergeCell,
  TableCellHeaderStates,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  defineExtension,
  type ElementNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, onTestFinished, test} from 'vitest';

// Not exported from the package; reached by pasting a table into a table.
import {$insertTableIntoGrid} from '../../LexicalTableUtils';

type CellSpec = {
  text: string;
  colSpan?: number;
  rowSpan?: number;
  headerState?: number;
};

// Builds an editor whose table has exactly the given rows. The table
// transform is deliberately not registered: this is the state a merge of
// concurrent collaborative edits can leave behind (e.g. one peer inserts a row
// while another inserts a column), because remote updates are applied with
// transforms skipped.
function buildTableEditor(rows: (string | CellSpec)[][]) {
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        const table = $createTableNode();
        for (const cells of rows) {
          const row = $createTableRowNode();
          for (const spec of cells) {
            const {
              text,
              colSpan = 1,
              rowSpan = 1,
              headerState = TableCellHeaderStates.NO_STATUS,
            } = typeof spec === 'string' ? {text: spec} : spec;
            row.append(
              $createTableCellNode(headerState, colSpan)
                .setRowSpan(rowSpan)
                .append($createParagraphNode().append($createTextNode(text))),
            );
          }
          table.append(row);
        }
        $getRoot().clear().append(table, $createParagraphNode());
      },
      name: '[ragged-table]',
      nodes: [TableNode, TableRowNode, TableCellNode],
      onError: (e: Error) => {
        throw e;
      },
    }),
  );
  onTestFinished(() => editor.dispose());
  return editor;
}

// Rows of 3, 3 and 2 cells.
const RAGGED = [
  ['00', '01', '02'],
  ['10', '11', '12'],
  ['20', '21'],
];

const $table = () => $getRoot().getChildren().find($isTableNode)!;
const $cell = (r: number, c: number) =>
  ($table().getChildAtIndex(r) as ElementNode).getChildAtIndex(
    c,
  ) as TableCellNode;
const $selectCell = (r: number, c: number) =>
  ($cell(r, c).getFirstChild() as ElementNode).selectEnd();
// Grid columns covered by each row, spans included.
const $widths = () =>
  $computeTableMapSkipCellCheck($table(), null, null)[0].map(
    row => row.filter(Boolean).length,
  );
// Text of each row's cells, in document order.
const $texts = () =>
  $table()
    .getChildren()
    .map(row =>
      $assertNodeType(row, $isTableRowNode)
        .getChildren()
        .map(cell => cell.getTextContent()),
    );

describe('table commands on a ragged table', () => {
  test('insert column after the last column of a full row', () => {
    const editor = buildTableEditor(RAGGED);
    editor.update(
      () => {
        $selectCell(0, 2);
        $insertTableColumnAtSelection(true);
      },
      {discrete: true},
    );
    expect(editor.read($widths)).toEqual([4, 4, 4]);
    expect(editor.read($texts)).toEqual([
      ['00', '01', '02', ''],
      ['10', '11', '12', ''],
      ['20', '21', '', ''],
    ]);
  });

  test('insert column after the last cell of the short row', () => {
    const editor = buildTableEditor(RAGGED);
    editor.update(
      () => {
        $selectCell(2, 1);
        $insertTableColumnAtSelection(true);
      },
      {discrete: true},
    );
    expect(editor.read($widths)).toEqual([4, 4, 4]);
    expect(editor.read($texts)).toEqual([
      ['00', '01', '', '02'],
      ['10', '11', '', '12'],
      ['20', '21', '', ''],
    ]);
  });

  test('insert row after the short row', () => {
    const editor = buildTableEditor(RAGGED);
    editor.update(
      () => {
        $selectCell(2, 0);
        $insertTableRowAtSelection(true);
      },
      {discrete: true},
    );
    expect(editor.read($widths)).toEqual([3, 3, 3, 3]);
  });

  test('insert row before the first row', () => {
    const editor = buildTableEditor(RAGGED);
    editor.update(
      () => {
        $selectCell(0, 0);
        $insertTableRowAtSelection(false);
      },
      {discrete: true},
    );
    expect(editor.read($widths)).toEqual([3, 3, 3, 3]);
  });

  test('delete the last column', () => {
    const editor = buildTableEditor(RAGGED);
    editor.update(
      () => {
        $selectCell(0, 2);
        $deleteTableColumnAtSelection();
      },
      {discrete: true},
    );
    expect(editor.read($widths)).toEqual([2, 2, 2]);
    expect(editor.read($texts)).toEqual([
      ['00', '01'],
      ['10', '11'],
      ['20', '21'],
    ]);
  });

  test('delete the short row', () => {
    const editor = buildTableEditor(RAGGED);
    editor.update(
      () => {
        $selectCell(2, 0);
        $deleteTableRowAtSelection();
      },
      {discrete: true},
    );
    expect(editor.read($widths)).toEqual([3, 3]);
    expect(editor.read($texts)).toEqual([
      ['00', '01', '02'],
      ['10', '11', '12'],
    ]);
  });

  test('merge a block that reaches past the end of the short row', () => {
    const editor = buildTableEditor(RAGGED);
    editor.update(
      () => {
        $mergeCells([$cell(1, 1), $cell(1, 2), $cell(2, 1)]);
      },
      {discrete: true},
    );
    expect(editor.read($widths)).toEqual([3, 3, 3]);
    const texts = editor.read($texts);
    expect(texts[0]).toEqual(['00', '01', '02']);
    expect(texts[1][0]).toEqual('10');
    expect(texts[1][1]).toMatch(/11[^]*12[^]*21/);
    expect(texts[2]).toEqual(['20']);
  });

  test('merge cells in the last column', () => {
    const editor = buildTableEditor(RAGGED);
    editor.update(
      () => {
        $mergeCells([$cell(1, 1), $cell(1, 2)]);
      },
      {discrete: true},
    );
    expect(editor.read($widths)).toEqual([3, 3, 3]);
  });

  test('unmerge a header-column cell when another row is short', () => {
    const editor = buildTableEditor([
      [
        '00',
        '01',
        {headerState: TableCellHeaderStates.COLUMN, rowSpan: 2, text: 'M'},
      ],
      ['10', '11'],
      ['20'],
    ]);
    editor.update(
      () => {
        $selectCell(0, 2);
        $unmergeCell();
      },
      {discrete: true},
    );
    expect(editor.read($widths)).toEqual([3, 3, 3]);
    expect(editor.read($texts)).toEqual([
      ['00', '01', 'M'],
      ['10', '11', ''],
      ['20', '', ''],
    ]);
  });
});

describe('pasting a table into a ragged table', () => {
  test('paste a 2x2 table at the last cell of the short row', () => {
    const editor = buildTableEditor(RAGGED);
    editor.update(
      () => {
        const template = $createTableNode();
        for (const texts of [
          ['a', 'b'],
          ['c', 'd'],
        ]) {
          const row = $createTableRowNode();
          for (const text of texts) {
            row.append(
              $createTableCellNode().append(
                $createParagraphNode().append($createTextNode(text)),
              ),
            );
          }
          template.append(row);
        }
        $selectCell(2, 1);
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          throw new Error('Expected a RangeSelection');
        }
        $insertTableIntoGrid(template, selection);
      },
      {discrete: true},
    );
    expect(editor.read($widths)).toEqual([3, 3, 3, 3]);
    expect(editor.read($texts)).toEqual([
      ['00', '01', '02'],
      ['10', '11', '12'],
      ['20', 'a', 'b'],
      ['', 'c', 'd'],
    ]);
  });
});

describe('$padTableRows', () => {
  test('pads short rows and leaves a rectangular table alone', () => {
    const editor = buildTableEditor(RAGGED);
    let changed: boolean | undefined;
    editor.update(
      () => {
        changed = $padTableRows($table());
      },
      {discrete: true},
    );
    expect(changed).toBe(true);
    expect(editor.read($widths)).toEqual([3, 3, 3]);
    editor.update(
      () => {
        changed = $padTableRows($table());
      },
      {discrete: true},
    );
    expect(changed).toBe(false);
  });

  test('fills a hole left of a rowSpan from an earlier row', () => {
    const editor = buildTableEditor([
      ['00', '01', {rowSpan: 2, text: '02'}, '03'],
      ['10'],
    ]);
    editor.update(() => $padTableRows($table()), {discrete: true});
    expect(editor.read($widths)).toEqual([4, 4]);
    expect(editor.read($texts)).toEqual([
      ['00', '01', '02', '03'],
      ['10', '', ''],
    ]);
  });
});
