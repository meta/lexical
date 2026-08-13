/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $computeTableMapSkipCellCheck,
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $insertTableColumnAtNode,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $moveTableColumn,
  $moveTableRow,
  $setTableColumnIsHeader,
  $setTableRowIsHeader,
  TableCellHeaderStates,
  TableExtension,
  type TableNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  type LexicalEditorWithDispose,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

function $createTestTable(rows: number, columns: number): TableNode {
  const tableNode = $createTableNode();
  for (let r = 0; r < rows; r++) {
    const row = $createTableRowNode();
    for (let c = 0; c < columns; c++) {
      const cell = $createTableCellNode();
      cell.append($createParagraphNode().append($createTextNode(`r${r}c${c}`)));
      row.append(cell);
    }
    tableNode.append(row);
  }
  return tableNode;
}

function $getTableCellTexts(tableNode: TableNode): string[][] {
  return tableNode.getChildren().map(row =>
    $assertNodeType(row, $isTableRowNode)
      .getChildren()
      .map(cell => $assertNodeType(cell, $isTableCellNode).getTextContent()),
  );
}

function $getHeaderStates(
  table: TableNode,
  flag: (typeof TableCellHeaderStates)[keyof typeof TableCellHeaderStates],
): boolean[][] {
  return table.getChildren().map(row =>
    $assertNodeType(row, $isTableRowNode)
      .getChildren()
      .map(cell =>
        $assertNodeType(cell, $isTableCellNode).hasHeaderState(flag),
      ),
  );
}

let editor: LexicalEditorWithDispose;

beforeEach(() => {
  editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [TableExtension],
      name: 'LexicalTableUtils-test',
    }),
  );
  editor.update(
    () => {
      $getRoot().clear();
    },
    {discrete: true},
  );
});

afterEach(() => {
  editor.dispose();
});

describe('$moveTableColumn', () => {
  test('moves a column forward', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(2, 4));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableColumn(table, 0, 2);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c1', 'r0c2', 'r0c0', 'r0c3'],
        ['r1c1', 'r1c2', 'r1c0', 'r1c3'],
      ]);
    });
  });

  test('moves a column backward', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(2, 4));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableColumn(table, 3, 1);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c0', 'r0c3', 'r0c1', 'r0c2'],
        ['r1c0', 'r1c3', 'r1c1', 'r1c2'],
      ]);
    });
  });

  test('moves a column to the first position', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(2, 3));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableColumn(table, 2, 0);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c2', 'r0c0', 'r0c1'],
        ['r1c2', 'r1c0', 'r1c1'],
      ]);
    });
  });

  test('moves a column to the last position', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(2, 3));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableColumn(table, 0, 2);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c1', 'r0c2', 'r0c0'],
        ['r1c1', 'r1c2', 'r1c0'],
      ]);
    });
  });

  test('is a no-op when origin equals target', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(2, 3));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableColumn(table, 1, 1);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c0', 'r0c1', 'r0c2'],
        ['r1c0', 'r1c1', 'r1c2'],
      ]);
    });
  });

  test('is a no-op when origin is out of bounds', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(2, 3));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableColumn(table, 5, 0);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c0', 'r0c1', 'r0c2'],
        ['r1c0', 'r1c1', 'r1c2'],
      ]);
    });
  });

  test('is a no-op when target is out of bounds', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(2, 3));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableColumn(table, 0, 10);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c0', 'r0c1', 'r0c2'],
        ['r1c0', 'r1c1', 'r1c2'],
      ]);
    });
  });

  test('is a no-op when origin is negative', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(2, 3));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableColumn(table, -1, 0);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c0', 'r0c1', 'r0c2'],
        ['r1c0', 'r1c1', 'r1c2'],
      ]);
    });
  });

  test('reorders colWidths when present', () => {
    editor.update(
      () => {
        const root = $getRoot();
        const table = $createTestTable(2, 4);
        table.setColWidths([100, 200, 300, 400]);
        root.append(table);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableColumn(table, 0, 2);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect(table.getColWidths()).toEqual([200, 300, 100, 400]);
    });
  });

  test('does not modify table with merged cells', () => {
    editor.update(
      () => {
        const root = $getRoot();
        const tableNode = $createTableNode();
        // Row 0: cell spanning 2 columns, then a normal cell
        const row0 = $createTableRowNode();
        const mergedCell = $createTableCellNode();
        mergedCell.setColSpan(2);
        mergedCell.append(
          $createParagraphNode().append($createTextNode('merged')),
        );
        const normalCell = $createTableCellNode();
        normalCell.append(
          $createParagraphNode().append($createTextNode('r0c2')),
        );
        row0.append(mergedCell, normalCell);

        // Row 1: 3 normal cells
        const row1 = $createTableRowNode();
        for (let c = 0; c < 3; c++) {
          const cell = $createTableCellNode();
          cell.append(
            $createParagraphNode().append($createTextNode(`r1c${c}`)),
          );
          row1.append(cell);
        }

        tableNode.append(row0, row1);
        root.append(tableNode);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableColumn(table, 0, 1);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      // Should be unchanged because table has merged cells
      const rows = table.getChildren();
      const firstRow = $assertNodeType(rows[0], $isTableRowNode);
      const firstRowCells = firstRow.getChildren();
      expect(firstRowCells.length).toBe(2); // merged cell + normal cell
      const mergedCell = $assertNodeType(firstRowCells[0], $isTableCellNode);
      expect(mergedCell.getColSpan()).toBe(2);
      expect(mergedCell.getTextContent()).toBe('merged');
    });
  });

  test('swaps adjacent columns', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(3, 2));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableColumn(table, 0, 1);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c1', 'r0c0'],
        ['r1c1', 'r1c0'],
        ['r2c1', 'r2c0'],
      ]);
    });
  });

  test('preserves table structure after move', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(3, 4));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableColumn(table, 1, 3);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      // Verify row and column count is preserved
      const rows = table.getChildren();
      expect(rows.length).toBe(3);
      rows.forEach(row => {
        expect($assertNodeType(row, $isTableRowNode).getChildrenSize()).toBe(4);
      });
    });
  });
});

describe('$moveTableRow', () => {
  test('moves a row forward', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(4, 2));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableRow(table, 0, 2);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r1c0', 'r1c1'],
        ['r2c0', 'r2c1'],
        ['r0c0', 'r0c1'],
        ['r3c0', 'r3c1'],
      ]);
    });
  });

  test('moves a row backward', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(4, 2));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableRow(table, 3, 1);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c0', 'r0c1'],
        ['r3c0', 'r3c1'],
        ['r1c0', 'r1c1'],
        ['r2c0', 'r2c1'],
      ]);
    });
  });

  test('moves a row to the first position', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(4, 2));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableRow(table, 2, 0);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r2c0', 'r2c1'],
        ['r0c0', 'r0c1'],
        ['r1c0', 'r1c1'],
        ['r3c0', 'r3c1'],
      ]);
    });
  });

  test('moves a row to the last position', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(4, 2));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableRow(table, 0, 3);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r1c0', 'r1c1'],
        ['r2c0', 'r2c1'],
        ['r3c0', 'r3c1'],
        ['r0c0', 'r0c1'],
      ]);
    });
  });

  test('is a no-op when origin equals target', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(3, 2));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableRow(table, 1, 1);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c0', 'r0c1'],
        ['r1c0', 'r1c1'],
        ['r2c0', 'r2c1'],
      ]);
    });
  });

  test('is a no-op when origin is out of bounds', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(3, 2));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableRow(table, 3, 0);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c0', 'r0c1'],
        ['r1c0', 'r1c1'],
        ['r2c0', 'r2c1'],
      ]);
    });
  });

  test('is a no-op when target is out of bounds', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(3, 2));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableRow(table, 0, 3);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c0', 'r0c1'],
        ['r1c0', 'r1c1'],
        ['r2c0', 'r2c1'],
      ]);
    });
  });

  test('is a no-op when origin is negative', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(3, 2));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableRow(table, -1, 1);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r0c0', 'r0c1'],
        ['r1c0', 'r1c1'],
        ['r2c0', 'r2c1'],
      ]);
    });
  });

  test('does not modify table with merged cells', () => {
    editor.update(
      () => {
        const root = $getRoot();
        const tableNode = $createTableNode();
        // Row 0: cell spanning 2 columns, then a normal cell
        const row0 = $createTableRowNode();
        const mergedCell = $createTableCellNode();
        mergedCell.setColSpan(2);
        mergedCell.append(
          $createParagraphNode().append($createTextNode('merged')),
        );
        const normalCell = $createTableCellNode();
        normalCell.append(
          $createParagraphNode().append($createTextNode('r0c2')),
        );
        row0.append(mergedCell, normalCell);

        // Row 1: 3 normal cells
        const row1 = $createTableRowNode();
        for (let c = 0; c < 3; c++) {
          const cell = $createTableCellNode();
          cell.append(
            $createParagraphNode().append($createTextNode(`r1c${c}`)),
          );
          row1.append(cell);
        }

        tableNode.append(row0, row1);
        root.append(tableNode);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableRow(table, 0, 1);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      // Should be unchanged because table has merged cells
      const rows = table.getChildren();
      const firstRow = $assertNodeType(rows[0], $isTableRowNode);
      const firstRowCells = firstRow.getChildren();
      expect(firstRowCells.length).toBe(2); // merged cell + normal cell
      const mergedCell = $assertNodeType(firstRowCells[0], $isTableCellNode);
      expect(mergedCell.getColSpan()).toBe(2);
      expect(mergedCell.getTextContent()).toBe('merged');
    });
  });

  test('swaps adjacent rows', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(2, 3));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableRow(table, 0, 1);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r1c0', 'r1c1', 'r1c2'],
        ['r0c0', 'r0c1', 'r0c2'],
      ]);
    });
  });

  test('moves header cells along with the row', () => {
    editor.update(
      () => {
        const root = $getRoot();
        const tableNode = $createTableNode();
        for (let r = 0; r < 3; r++) {
          const row = $createTableRowNode();
          for (let c = 0; c < 2; c++) {
            const cell = $createTableCellNode(
              r === 0
                ? TableCellHeaderStates.ROW
                : TableCellHeaderStates.NO_STATUS,
            );
            cell.append(
              $createParagraphNode().append($createTextNode(`r${r}c${c}`)),
            );
            row.append(cell);
          }
          tableNode.append(row);
        }
        root.append(tableNode);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableRow(table, 0, 2);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getTableCellTexts(table)).toEqual([
        ['r1c0', 'r1c1'],
        ['r2c0', 'r2c1'],
        ['r0c0', 'r0c1'],
      ]);
      const rows = table.getChildren();
      const movedRow = $assertNodeType(rows[2], $isTableRowNode);
      movedRow.getChildren().forEach(cell => {
        expect($assertNodeType(cell, $isTableCellNode).getHeaderStyles()).toBe(
          TableCellHeaderStates.ROW,
        );
      });
    });
  });

  test('preserves table structure after move', () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.append($createTestTable(4, 3));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $moveTableRow(table, 1, 3);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      // Verify row and column count is preserved
      const rows = table.getChildren();
      expect(rows.length).toBe(4);
      rows.forEach(row => {
        expect($assertNodeType(row, $isTableRowNode).getChildrenSize()).toBe(3);
      });
    });
  });
});

describe('$setTableRowIsHeader', () => {
  test('sets a row as header', () => {
    editor.update(
      () => {
        $getRoot().append($createTestTable(3, 3));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $setTableRowIsHeader(table, 0, true);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getHeaderStates(table, TableCellHeaderStates.ROW)).toEqual([
        [true, true, true],
        [false, false, false],
        [false, false, false],
      ]);
    });
  });

  test('clears a header row', () => {
    editor.update(
      () => {
        const table = $createTableNode();
        const headerRow = $createTableRowNode();
        for (let c = 0; c < 3; c++) {
          const cell = $createTableCellNode(TableCellHeaderStates.ROW);
          cell.append($createParagraphNode().append($createTextNode(`h${c}`)));
          headerRow.append(cell);
        }
        table.append(headerRow);
        const bodyRow = $createTableRowNode();
        for (let c = 0; c < 3; c++) {
          const cell = $createTableCellNode();
          cell.append($createParagraphNode().append($createTextNode(`b${c}`)));
          bodyRow.append(cell);
        }
        table.append(bodyRow);
        $getRoot().append(table);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $setTableRowIsHeader(table, 0, false);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getHeaderStates(table, TableCellHeaderStates.ROW)).toEqual([
        [false, false, false],
        [false, false, false],
      ]);
    });
  });

  test('preserves COLUMN bits when setting ROW header', () => {
    editor.update(
      () => {
        const table = $createTableNode();
        const row = $createTableRowNode();
        const cell0 = $createTableCellNode(TableCellHeaderStates.COLUMN);
        cell0.append($createParagraphNode());
        const cell1 = $createTableCellNode();
        cell1.append($createParagraphNode());
        row.append(cell0, cell1);
        table.append(row);
        $getRoot().append(table);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $setTableRowIsHeader(table, 0, true);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getHeaderStates(table, TableCellHeaderStates.ROW)).toEqual([
        [true, true],
      ]);
      expect($getHeaderStates(table, TableCellHeaderStates.COLUMN)).toEqual([
        [true, false],
      ]);
    });
  });

  test('handles colSpan cells', () => {
    editor.update(
      () => {
        const table = $createTableNode();
        const row = $createTableRowNode();
        const spanCell = $createTableCellNode();
        spanCell.setColSpan(2);
        spanCell.append($createParagraphNode());
        const normalCell = $createTableCellNode();
        normalCell.append($createParagraphNode());
        row.append(spanCell, normalCell);
        table.append(row);
        $getRoot().append(table);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $setTableRowIsHeader(table, 0, true);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getHeaderStates(table, TableCellHeaderStates.ROW)).toEqual([
        [true, true],
      ]);
    });
  });

  test('handles rowSpan cells', () => {
    editor.update(
      () => {
        const table = $createTableNode();
        const row0 = $createTableRowNode();
        const spanCell = $createTableCellNode();
        spanCell.setRowSpan(2);
        spanCell.append($createParagraphNode());
        const cell01 = $createTableCellNode();
        cell01.append($createParagraphNode());
        row0.append(spanCell, cell01);

        const row1 = $createTableRowNode();
        const cell11 = $createTableCellNode();
        cell11.append($createParagraphNode());
        row1.append(cell11);

        table.append(row0, row1);
        $getRoot().append(table);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $setTableRowIsHeader(table, 0, true);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getHeaderStates(table, TableCellHeaderStates.ROW)).toEqual([
        [true, true],
        [false],
      ]);
    });
  });

  test('sets a middle row as header', () => {
    editor.update(
      () => {
        $getRoot().append($createTestTable(3, 3));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $setTableRowIsHeader(table, 1, true);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getHeaderStates(table, TableCellHeaderStates.ROW)).toEqual([
        [false, false, false],
        [true, true, true],
        [false, false, false],
      ]);
    });
  });

  test('throws on out-of-range row index', () => {
    editor.update(
      () => {
        $getRoot().append($createTestTable(3, 3));
      },
      {discrete: true},
    );

    expect(() => {
      editor.update(
        () => {
          const table = $assertNodeType(
            $getRoot().getFirstChild(),
            $isTableNode,
          );
          $setTableRowIsHeader(table, 5, true);
        },
        {discrete: true},
      );
    }).toThrow();
  });

  test('clears ROW from BOTH header state, preserving COLUMN', () => {
    editor.update(
      () => {
        const table = $createTableNode();
        const row = $createTableRowNode();
        const cell = $createTableCellNode(TableCellHeaderStates.BOTH);
        cell.append($createParagraphNode());
        row.append(cell);
        table.append(row);
        $getRoot().append(table);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $setTableRowIsHeader(table, 0, false);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getHeaderStates(table, TableCellHeaderStates.ROW)).toEqual([
        [false],
      ]);
      expect($getHeaderStates(table, TableCellHeaderStates.COLUMN)).toEqual([
        [true],
      ]);
    });
  });
});

describe('$setTableColumnIsHeader', () => {
  test('sets a column as header', () => {
    editor.update(
      () => {
        $getRoot().append($createTestTable(3, 3));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $setTableColumnIsHeader(table, 0, true);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getHeaderStates(table, TableCellHeaderStates.COLUMN)).toEqual([
        [true, false, false],
        [true, false, false],
        [true, false, false],
      ]);
    });
  });

  test('clears a header column', () => {
    editor.update(
      () => {
        const table = $createTableNode();
        for (let r = 0; r < 3; r++) {
          const row = $createTableRowNode();
          const headerCell = $createTableCellNode(TableCellHeaderStates.COLUMN);
          headerCell.append($createParagraphNode());
          const normalCell = $createTableCellNode();
          normalCell.append($createParagraphNode());
          row.append(headerCell, normalCell);
          table.append(row);
        }
        $getRoot().append(table);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $setTableColumnIsHeader(table, 0, false);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getHeaderStates(table, TableCellHeaderStates.COLUMN)).toEqual([
        [false, false],
        [false, false],
        [false, false],
      ]);
    });
  });

  test('preserves ROW bits when setting COLUMN header', () => {
    editor.update(
      () => {
        const table = $createTableNode();
        const row = $createTableRowNode();
        const cell0 = $createTableCellNode(TableCellHeaderStates.ROW);
        cell0.append($createParagraphNode());
        const cell1 = $createTableCellNode(TableCellHeaderStates.ROW);
        cell1.append($createParagraphNode());
        row.append(cell0, cell1);
        table.append(row);
        $getRoot().append(table);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $setTableColumnIsHeader(table, 0, true);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getHeaderStates(table, TableCellHeaderStates.COLUMN)).toEqual([
        [true, false],
      ]);
      expect($getHeaderStates(table, TableCellHeaderStates.ROW)).toEqual([
        [true, true],
      ]);
    });
  });

  test('handles rowSpan cells', () => {
    editor.update(
      () => {
        const table = $createTableNode();
        const row0 = $createTableRowNode();
        const spanCell = $createTableCellNode();
        spanCell.setRowSpan(2);
        spanCell.append($createParagraphNode());
        const cell01 = $createTableCellNode();
        cell01.append($createParagraphNode());
        row0.append(spanCell, cell01);

        const row1 = $createTableRowNode();
        const cell11 = $createTableCellNode();
        cell11.append($createParagraphNode());
        row1.append(cell11);

        table.append(row0, row1);
        $getRoot().append(table);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $setTableColumnIsHeader(table, 0, true);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getHeaderStates(table, TableCellHeaderStates.COLUMN)).toEqual([
        [true, false],
        [false],
      ]);
    });
  });

  test('throws on out-of-range column index', () => {
    editor.update(
      () => {
        $getRoot().append($createTestTable(3, 3));
      },
      {discrete: true},
    );

    expect(() => {
      editor.update(
        () => {
          const table = $assertNodeType(
            $getRoot().getFirstChild(),
            $isTableNode,
          );
          $setTableColumnIsHeader(table, 5, true);
        },
        {discrete: true},
      );
    }).toThrow();
  });

  test('clears COLUMN from BOTH header state, preserving ROW', () => {
    editor.update(
      () => {
        const table = $createTableNode();
        const row = $createTableRowNode();
        const cell = $createTableCellNode(TableCellHeaderStates.BOTH);
        cell.append($createParagraphNode());
        row.append(cell);
        table.append(row);
        $getRoot().append(table);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        $setTableColumnIsHeader(table, 0, false);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getHeaderStates(table, TableCellHeaderStates.COLUMN)).toEqual([
        [false],
      ]);
      expect($getHeaderStates(table, TableCellHeaderStates.ROW)).toEqual([
        [true],
      ]);
    });
  });
});

describe('$insertTableColumnAtNode', () => {
  // Renders the resolved grid (accounting for row/col spans) as a matrix of the
  // text at each grid coordinate, so column alignment across rows is asserted
  // directly rather than via raw DOM child order.
  function $getGridTexts(table: TableNode): string[][] {
    const [tableMap] = $computeTableMapSkipCellCheck(table, null, null);
    return tableMap.map(row => row.map(({cell}) => cell.getTextContent()));
  }

  test('walks left by each visited cell colSpan when a row is spanned', () => {
    // Grid:
    //   row0: [A0][X(rowSpan=2)][C(colSpan=2,rowSpan=2)][D0]
    //   row1: [A1]                                      [D1]
    editor.update(
      () => {
        const $mkCell = (text: string) =>
          $createTableCellNode().append(
            $createParagraphNode().append($createTextNode(text)),
          );
        const x = $mkCell('X');
        x.setRowSpan(2);
        const c = $mkCell('C');
        c.setColSpan(2);
        c.setRowSpan(2);
        const row0 = $createTableRowNode().append(
          $mkCell('A0'),
          x,
          c,
          $mkCell('D0'),
        );
        const row1 = $createTableRowNode().append($mkCell('A1'), $mkCell('D1'));
        $getRoot().append($createTableNode().append(row0, row1));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        const [tableMap] = $computeTableMapSkipCellCheck(table, null, null);
        // C occupies grid columns 2-3 of row 0; insert a column after it.
        $insertTableColumnAtNode(tableMap[0][2].cell, true, false);
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
      expect($getGridTexts(table)).toEqual([
        ['A0', 'X', 'C', 'C', '', 'D0'],
        ['A1', 'X', 'C', 'C', '', 'D1'],
      ]);
    });
  });
});
