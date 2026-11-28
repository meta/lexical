/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A table can be ragged in the editor state: collaborators' concurrent row
// and column inserts leave short rows that are their authors' to pad (#9539),
// and an editor without the table transform keeps what it loads. Its HTML
// export is still a rectangle (#9453): the exported rows are padded, and the
// editor state is left as it is.

import {buildEditorFromExtensions} from '@lexical/extension';
import {$generateHtmlFromNodes} from '@lexical/html';
import {
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableCellHeaderStates,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import {
  $getRoot,
  defineExtension,
  type LexicalEditor,
  type SerializedEditorState,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {COLUMN_WIDTH} from '../../constants';

type CellSpec = {colSpan?: number; headerState?: number};
type RowSpec = (number | CellSpec)[];

// Rows are given as lists of cells; a number is shorthand for that many plain
// cells. e.g. [[3], [1]] is a table whose rows have 3 and 1 cells.
function expandRow(spec: RowSpec): CellSpec[] {
  return spec.flatMap(item =>
    typeof item === 'number'
      ? Array.from({length: item}, (): CellSpec => ({}))
      : [item],
  );
}

function serializedTable(
  rows: RowSpec[],
  colWidths?: number[],
): SerializedEditorState {
  const paragraph = {
    children: [],
    direction: null,
    format: '',
    indent: 0,
    textFormat: 0,
    textStyle: '',
    type: 'paragraph',
    version: 1,
  };
  return {
    root: {
      children: [
        {
          children: rows.map(spec => ({
            children: expandRow(spec).map(({colSpan = 1, headerState = 0}) => ({
              backgroundColor: null,
              children: [paragraph],
              colSpan,
              direction: null,
              format: '',
              headerState,
              indent: 0,
              rowSpan: 1,
              type: 'tablecell',
              version: 1,
              width: null,
            })),
            direction: null,
            format: '',
            indent: 0,
            type: 'tablerow',
            version: 1,
          })),
          colWidths,
          direction: null,
          format: '',
          indent: 0,
          type: 'table',
          version: 1,
        },
        paragraph,
      ],
      direction: null,
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  } as unknown as SerializedEditorState;
}

// An editor without the table transform: what it loads stays as it is.
function loadRagged(rows: RowSpec[], colWidths?: number[]): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      name: '[ragged-table-export]',
      nodes: [TableNode, TableRowNode, TableCellNode],
    }),
  );
  onTestFinished(() => editor.dispose());
  editor.setEditorState(
    editor.parseEditorState(serializedTable(rows, colWidths)),
  );
  return editor;
}

// The number of grid columns each row of the first table covers.
function rowWidths(editor: LexicalEditor): number[] {
  return editor.read(() => {
    const table = $getRoot().getChildren().find($isTableNode);
    if (!table) {
      throw new Error('Expected a table');
    }
    return table
      .getChildren()
      .filter($isTableRowNode)
      .map(row =>
        row
          .getChildren()
          .filter($isTableCellNode)
          .reduce((acc, cell) => acc + cell.getColSpan(), 0),
      );
  });
}

function exportedRows(editor: LexicalEditor): HTMLTableRowElement[] {
  const html = editor.read(() => $generateHtmlFromNodes(editor));
  const container = document.createElement('div');
  container.innerHTML = html;
  return Array.from(container.querySelectorAll('tr'));
}

describe('HTML export of a ragged table (#9453)', () => {
  test('is a rectangle, and the editor state stays ragged', () => {
    const editor = loadRagged([[3], [1], [2]]);
    expect(exportedRows(editor).map(tr => tr.cells.length)).toEqual([3, 3, 3]);
    expect(rowWidths(editor)).toEqual([3, 1, 2]);
  });

  test('pads rows to the widest row, counting spans', () => {
    const editor = loadRagged([[{colSpan: 2}, 1], [1]]);
    const [first, second] = exportedRows(editor);
    expect(first.cells.length).toBe(2);
    expect(second.cells.length).toBe(3);
  });

  test('pads a header row with <th> cells', () => {
    const editor = loadRagged([
      [{headerState: TableCellHeaderStates.ROW}],
      [2],
    ]);
    const [headerRow, bodyRow] = exportedRows(editor);
    expect(Array.from(headerRow.cells, c => c.tagName)).toEqual(['TH', 'TH']);
    expect(Array.from(bodyRow.cells, c => c.tagName)).toEqual(['TD', 'TD']);
  });

  test('gives padding cells the width of a new cell, as $padTableRows would', () => {
    // Resized columns: the table's colWidths do not set the cells' widths.
    const editor = loadRagged([[3], [1]], [200, 300, 400]);
    const [, short] = exportedRows(editor);
    expect(short.cells[1].style.width).toBe(`${COLUMN_WIDTH}px`);
    expect(short.cells[2].style.width).toBe(`${COLUMN_WIDTH}px`);
  });

  test('leaves a rectangular table as it is', () => {
    const editor = loadRagged([[2], [{colSpan: 2}]]);
    expect(exportedRows(editor).map(tr => tr.cells.length)).toEqual([2, 1]);
  });
});
