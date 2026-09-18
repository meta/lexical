/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {InsertTableCommandPayloadHeaders} from '.';
import type {TableDOMTable} from './LexicalTableObserver';

import invariant from '@lexical/internal/invariant';
import {
  $copyNode,
  $createParagraphNode,
  $createTextNode,
  $findMatchingParent,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
  type PointType,
  type RangeSelection,
} from 'lexical';

import {
  $createTableCellNode,
  $isTableCellNode,
  type TableCellHeaderState,
  TableCellHeaderStates,
  TableCellNode,
} from './LexicalTableCellNode';
import {
  $createTableNode,
  $isTableNode,
  type TableNode,
} from './LexicalTableNode';
import {
  $createTableRowNode,
  $isTableRowNode,
  type TableRowNode,
} from './LexicalTableRowNode';
import {
  $isTableSelection,
  type TableMapType,
  type TableMapValueType,
  type TableSelection,
} from './LexicalTableSelection';

export function $createTableNodeWithDimensions(
  rowCount: number,
  columnCount: number,
  includeHeaders: InsertTableCommandPayloadHeaders = true,
): TableNode {
  const tableNode = $createTableNode();

  for (let iRow = 0; iRow < rowCount; iRow++) {
    const tableRowNode = $createTableRowNode();

    for (let iColumn = 0; iColumn < columnCount; iColumn++) {
      let headerState = TableCellHeaderStates.NO_STATUS;

      if (typeof includeHeaders === 'object') {
        if (iRow === 0 && includeHeaders.rows) {
          headerState |= TableCellHeaderStates.ROW;
        }
        if (iColumn === 0 && includeHeaders.columns) {
          headerState |= TableCellHeaderStates.COLUMN;
        }
      } else if (includeHeaders) {
        if (iRow === 0) {
          headerState |= TableCellHeaderStates.ROW;
        }
        if (iColumn === 0) {
          headerState |= TableCellHeaderStates.COLUMN;
        }
      }

      const tableCellNode = $createTableCellNode(headerState);
      const paragraphNode = $createParagraphNode();
      paragraphNode.append($createTextNode());
      tableCellNode.append(paragraphNode);
      tableRowNode.append(tableCellNode);
    }

    tableNode.append(tableRowNode);
  }

  return tableNode;
}

export function $getTableCellNodeFromLexicalNode(
  startingNode: LexicalNode,
): TableCellNode | null {
  const node = $findMatchingParent(startingNode, n => $isTableCellNode(n));

  if ($isTableCellNode(node)) {
    return node;
  }

  return null;
}

export function $getTableRowNodeFromTableCellNodeOrThrow(
  startingNode: LexicalNode,
): TableRowNode {
  const node = $findMatchingParent(startingNode, n => $isTableRowNode(n));

  if ($isTableRowNode(node)) {
    return node;
  }

  throw new Error('Expected table cell to be inside of table row.');
}

export function $getTableNodeFromLexicalNodeOrThrow(
  startingNode: LexicalNode,
): TableNode {
  const node = $findMatchingParent(startingNode, n => $isTableNode(n));

  if ($isTableNode(node)) {
    return node;
  }

  throw new Error('Expected table cell to be inside of table.');
}

export function $getTableRowIndexFromTableCellNode(
  tableCellNode: TableCellNode,
): number {
  const tableRowNode = $getTableRowNodeFromTableCellNodeOrThrow(tableCellNode);
  const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableRowNode);
  return tableNode.getChildren().findIndex(n => n.is(tableRowNode));
}

export function $getTableColumnIndexFromTableCellNode(
  tableCellNode: TableCellNode,
): number {
  const tableRowNode = $getTableRowNodeFromTableCellNodeOrThrow(tableCellNode);
  return tableRowNode.getChildren().findIndex(n => n.is(tableCellNode));
}

export type TableCellSiblings = {
  above: TableCellNode | null | undefined;
  below: TableCellNode | null | undefined;
  left: TableCellNode | null | undefined;
  right: TableCellNode | null | undefined;
};

export function $getTableCellSiblingsFromTableCellNode(
  tableCellNode: TableCellNode,
  table: TableDOMTable,
): TableCellSiblings {
  const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode);
  const {x, y} = tableNode.getCordsFromCellNode(tableCellNode, table);
  return {
    above: tableNode.getCellNodeFromCords(x, y - 1, table),
    below: tableNode.getCellNodeFromCords(x, y + 1, table),
    left: tableNode.getCellNodeFromCords(x - 1, y, table),
    right: tableNode.getCellNodeFromCords(x + 1, y, table),
  };
}

export function $removeTableRowAtIndex(
  tableNode: TableNode,
  indexToDelete: number,
): TableNode {
  const tableRows = tableNode.getChildren();

  if (indexToDelete >= tableRows.length || indexToDelete < 0) {
    throw new Error('Expected table cell to be inside of table row.');
  }

  const targetRowNode = tableRows[indexToDelete];
  targetRowNode.remove();
  return tableNode;
}

/**
 * @deprecated This function does not support merged cells. Use {@link $insertTableRowAtSelection} or {@link $insertTableRowAtNode} instead.
 */
export function $insertTableRow(
  tableNode: TableNode,
  targetIndex: number,
  shouldInsertAfter = true,
  rowCount: number,
  table: TableDOMTable,
): TableNode {
  const tableRows = tableNode.getChildren();

  if (targetIndex >= tableRows.length || targetIndex < 0) {
    throw new Error('Table row target index out of range');
  }

  const targetRowNode = tableRows[targetIndex];

  if ($isTableRowNode(targetRowNode)) {
    for (let r = 0; r < rowCount; r++) {
      const tableRowCells = targetRowNode.getChildren();
      const tableColumnCount = tableRowCells.length;
      const newTableRowNode = $createTableRowNode();

      for (let c = 0; c < tableColumnCount; c++) {
        const tableCellFromTargetRow = tableRowCells[c];

        invariant(
          $isTableCellNode(tableCellFromTargetRow),
          'Expected table cell',
        );

        const {above, below} = $getTableCellSiblingsFromTableCellNode(
          tableCellFromTargetRow,
          table,
        );

        let headerState = TableCellHeaderStates.NO_STATUS;
        const width =
          (above && above.getWidth()) ||
          (below && below.getWidth()) ||
          undefined;

        if (
          (above && above.hasHeaderState(TableCellHeaderStates.COLUMN)) ||
          (below && below.hasHeaderState(TableCellHeaderStates.COLUMN))
        ) {
          headerState |= TableCellHeaderStates.COLUMN;
        }

        const tableCellNode = $createTableCellNode(headerState, 1, width);

        tableCellNode.append($createParagraphNode());

        newTableRowNode.append(tableCellNode);
      }

      if (shouldInsertAfter) {
        targetRowNode.insertAfter(newTableRowNode);
      } else {
        targetRowNode.insertBefore(newTableRowNode);
      }
    }
  } else {
    throw new Error('Row before insertion index does not exist.');
  }

  return tableNode;
}

const getHeaderState = (
  currentState: TableCellHeaderState,
  possibleState: TableCellHeaderState,
): TableCellHeaderState => {
  if (
    currentState === TableCellHeaderStates.BOTH ||
    currentState === possibleState
  ) {
    return possibleState;
  }
  return TableCellHeaderStates.NO_STATUS;
};

/**
 * Inserts a table row before or after the current focus cell node,
 * taking into account any spans. If successful, returns the
 * inserted table row node.
 */
export function $insertTableRowAtSelection(
  insertAfter = true,
): TableRowNode | null {
  const selection = $getSelection();
  invariant(
    $isRangeSelection(selection) || $isTableSelection(selection),
    'Expected a RangeSelection or TableSelection',
  );
  const anchor = selection.anchor.getNode();
  const focus = selection.focus.getNode();
  const [anchorCell] = $getNodeTriplet(anchor);
  const [focusCell, , grid] = $getNodeTriplet(focus);
  const [, focusCellMap, anchorCellMap] = $computeTableMap(
    grid,
    focusCell,
    anchorCell,
  );
  const {startRow: anchorStartRow} = anchorCellMap;
  const {startRow: focusStartRow} = focusCellMap;
  if (insertAfter) {
    return $insertTableRowAtNode(
      anchorStartRow + anchorCell.__rowSpan >
        focusStartRow + focusCell.__rowSpan
        ? anchorCell
        : focusCell,
      true,
    );
  } else {
    return $insertTableRowAtNode(
      focusStartRow < anchorStartRow ? focusCell : anchorCell,
      false,
    );
  }
}

/**
 * @deprecated renamed to {@link $insertTableRowAtSelection}
 */
export const $insertTableRow__EXPERIMENTAL = $insertTableRowAtSelection;

/**
 * Inserts a table row before or after the given cell node,
 * taking into account any spans. If successful, returns the
 * inserted table row node.
 */
export function $insertTableRowAtNode(
  cellNode: TableCellNode,
  insertAfter = true,
): TableRowNode | null {
  const [, , grid] = $getNodeTriplet(cellNode);
  const [gridMap, cellMap] = $computeTableMap(grid, cellNode, cellNode);
  const columnCount = gridMap[0].length;
  const {startRow: cellStartRow} = cellMap;
  let insertedRow: TableRowNode | null = null;
  if (insertAfter) {
    const insertAfterEndRow = cellStartRow + cellNode.__rowSpan - 1;
    const insertAfterEndRowMap = gridMap[insertAfterEndRow];
    const newRow = $createTableRowNode();
    for (let i = 0; i < columnCount; i++) {
      const {cell, startRow} = insertAfterEndRowMap[i];
      if (startRow + cell.__rowSpan - 1 <= insertAfterEndRow) {
        const currentCell = insertAfterEndRowMap[i].cell;
        const currentCellHeaderState = currentCell.__headerState;

        const headerState = getHeaderState(
          currentCellHeaderState,
          TableCellHeaderStates.COLUMN,
        );

        newRow.append(
          $createTableCellNode(headerState).append($createParagraphNode()),
        );
      } else {
        cell.setRowSpan(cell.__rowSpan + 1);
      }
    }
    const insertAfterEndRowNode = grid.getChildAtIndex(insertAfterEndRow);
    invariant(
      $isTableRowNode(insertAfterEndRowNode),
      'insertAfterEndRow is not a TableRowNode',
    );
    insertAfterEndRowNode.insertAfter(newRow);
    insertedRow = newRow;
  } else {
    const insertBeforeStartRow = cellStartRow;
    const insertBeforeStartRowMap = gridMap[insertBeforeStartRow];
    const newRow = $createTableRowNode();
    for (let i = 0; i < columnCount; i++) {
      const {cell, startRow} = insertBeforeStartRowMap[i];
      if (startRow === insertBeforeStartRow) {
        const currentCell = insertBeforeStartRowMap[i].cell;
        const currentCellHeaderState = currentCell.__headerState;

        const headerState = getHeaderState(
          currentCellHeaderState,
          TableCellHeaderStates.COLUMN,
        );

        newRow.append(
          $createTableCellNode(headerState).append($createParagraphNode()),
        );
      } else {
        cell.setRowSpan(cell.__rowSpan + 1);
      }
    }
    const insertBeforeStartRowNode = grid.getChildAtIndex(insertBeforeStartRow);
    invariant(
      $isTableRowNode(insertBeforeStartRowNode),
      'insertBeforeStartRow is not a TableRowNode',
    );
    insertBeforeStartRowNode.insertBefore(newRow);
    insertedRow = newRow;
  }
  return insertedRow;
}

/**
 * @deprecated This function does not support merged cells. Use {@link $insertTableColumnAtSelection} or {@link $insertTableColumnAtNode} instead.
 */
export function $insertTableColumn(
  tableNode: TableNode,
  targetIndex: number,
  shouldInsertAfter = true,
  columnCount: number,
  table: TableDOMTable,
): TableNode {
  const tableRows = tableNode.getChildren();

  const tableCellsToBeInserted = [];
  for (let r = 0; r < tableRows.length; r++) {
    const currentTableRowNode = tableRows[r];

    if ($isTableRowNode(currentTableRowNode)) {
      for (let c = 0; c < columnCount; c++) {
        const tableRowChildren = currentTableRowNode.getChildren();
        if (targetIndex >= tableRowChildren.length || targetIndex < 0) {
          throw new Error('Table column target index out of range');
        }

        const targetCell = tableRowChildren[targetIndex];

        invariant($isTableCellNode(targetCell), 'Expected table cell');

        const {left, right} = $getTableCellSiblingsFromTableCellNode(
          targetCell,
          table,
        );

        let headerState = TableCellHeaderStates.NO_STATUS;

        if (
          (left && left.hasHeaderState(TableCellHeaderStates.ROW)) ||
          (right && right.hasHeaderState(TableCellHeaderStates.ROW))
        ) {
          headerState |= TableCellHeaderStates.ROW;
        }

        const newTableCell = $createTableCellNode(headerState);

        newTableCell.append($createParagraphNode());
        tableCellsToBeInserted.push({
          newTableCell,
          targetCell,
        });
      }
    }
  }
  tableCellsToBeInserted.forEach(({newTableCell, targetCell}) => {
    if (shouldInsertAfter) {
      targetCell.insertAfter(newTableCell);
    } else {
      targetCell.insertBefore(newTableCell);
    }
  });

  return tableNode;
}

/**
 * Inserts a column before or after the current focus cell node,
 * taking into account any spans. If successful, returns the
 * first inserted cell node.
 */
export function $insertTableColumnAtSelection(
  insertAfter = true,
): TableCellNode | null {
  const selection = $getSelection();
  invariant(
    $isRangeSelection(selection) || $isTableSelection(selection),
    'Expected a RangeSelection or TableSelection',
  );
  const anchor = selection.anchor.getNode();
  const focus = selection.focus.getNode();
  const [anchorCell] = $getNodeTriplet(anchor);
  const [focusCell, , grid] = $getNodeTriplet(focus);
  const [, focusCellMap, anchorCellMap] = $computeTableMap(
    grid,
    focusCell,
    anchorCell,
  );
  const {startColumn: anchorStartColumn} = anchorCellMap;
  const {startColumn: focusStartColumn} = focusCellMap;
  if (insertAfter) {
    return $insertTableColumnAtNode(
      anchorStartColumn + anchorCell.__colSpan >
        focusStartColumn + focusCell.__colSpan
        ? anchorCell
        : focusCell,
      true,
    );
  } else {
    return $insertTableColumnAtNode(
      focusStartColumn < anchorStartColumn ? focusCell : anchorCell,
      false,
    );
  }
}

/**
 * @deprecated renamed to {@link $insertTableColumnAtSelection}
 */
export const $insertTableColumn__EXPERIMENTAL = $insertTableColumnAtSelection;

/**
 * Inserts a column before or after the given cell node,
 * taking into account any spans. If successful, returns the
 * first inserted cell node.
 */
export function $insertTableColumnAtNode(
  cellNode: TableCellNode,
  insertAfter = true,
  shouldSetSelection = true,
): TableCellNode | null {
  const [, , grid] = $getNodeTriplet(cellNode);
  const [gridMap, cellMap] = $computeTableMap(grid, cellNode, cellNode);
  const rowCount = gridMap.length;
  const {startColumn} = cellMap;
  const insertAfterColumn = insertAfter
    ? startColumn + cellNode.__colSpan - 1
    : startColumn - 1;
  const gridFirstChild = grid.getFirstChild();
  invariant(
    $isTableRowNode(gridFirstChild),
    'Expected firstTable child to be a row',
  );
  let firstInsertedCell: null | TableCellNode = null;
  function $createTableCellNodeForInsertTableColumn(
    headerState: TableCellHeaderState = TableCellHeaderStates.NO_STATUS,
  ) {
    const cell = $createTableCellNode(headerState).append(
      $createParagraphNode(),
    );
    if (firstInsertedCell === null) {
      firstInsertedCell = cell;
    }
    return cell;
  }
  let loopRow: TableRowNode = gridFirstChild;
  for (let i = 0; i < rowCount; i++) {
    if (i !== 0) {
      const currentRow = loopRow.getNextSibling();
      invariant(
        $isTableRowNode(currentRow),
        'Expected row nextSibling to be a row',
      );
      loopRow = currentRow;
    }
    const rowMap = gridMap[i];

    const currentCellHeaderState =
      rowMap[insertAfterColumn < 0 ? 0 : insertAfterColumn].cell.__headerState;

    const headerState = getHeaderState(
      currentCellHeaderState,
      TableCellHeaderStates.ROW,
    );

    if (insertAfterColumn < 0) {
      $insertFirst(
        loopRow,
        $createTableCellNodeForInsertTableColumn(headerState),
      );
      continue;
    }
    const {cell: currentCell, startColumn: currentStartColumn} =
      rowMap[insertAfterColumn];
    if (currentStartColumn + currentCell.__colSpan - 1 <= insertAfterColumn) {
      // Find the last cell this row actually owns at or before the insertion
      // column. Grid positions covered by a rowSpan from an earlier row are not
      // children of this row, so they can not be inserted after. Stepping over
      // the rest of a wide cell's span is only an optimization: those positions
      // map back to the same cell, so visiting them would reach the same
      // answer.
      let insertAfterCell: null | TableCellNode = null;
      for (let column = 0; column <= insertAfterColumn; column++) {
        const currentCellMap = rowMap[column];
        if (currentCellMap.startRow === i) {
          insertAfterCell = currentCellMap.cell;
        }
        if (currentCellMap.cell.__colSpan > 1) {
          column += currentCellMap.cell.__colSpan - 1;
        }
      }
      if (insertAfterCell === null) {
        // Every grid column to the left is covered by a rowSpan from an earlier
        // row, so the new cell is this row's first child.
        $insertFirst(
          loopRow,
          $createTableCellNodeForInsertTableColumn(headerState),
        );
      } else {
        insertAfterCell.insertAfter(
          $createTableCellNodeForInsertTableColumn(headerState),
        );
      }
    } else {
      currentCell.setColSpan(currentCell.__colSpan + 1);
    }
  }
  if (firstInsertedCell !== null && shouldSetSelection) {
    $moveSelectionToCell(firstInsertedCell);
  }
  const colWidths = grid.getColWidths();
  if (colWidths) {
    const newColWidths = [...colWidths];
    const columnIndex = insertAfterColumn < 0 ? 0 : insertAfterColumn;
    const newWidth = newColWidths[columnIndex];
    newColWidths.splice(columnIndex, 0, newWidth);
    grid.setColWidths(newColWidths);
  }
  return firstInsertedCell;
}

/**
 * @deprecated This function does not support merged cells. Use {@link $deleteTableColumnAtSelection} instead.
 */
export function $deleteTableColumn(
  tableNode: TableNode,
  targetIndex: number,
): TableNode {
  const tableRows = tableNode.getChildren();

  for (let i = 0; i < tableRows.length; i++) {
    const currentTableRowNode = tableRows[i];

    if ($isTableRowNode(currentTableRowNode)) {
      const tableRowChildren = currentTableRowNode.getChildren();

      if (targetIndex >= tableRowChildren.length || targetIndex < 0) {
        throw new Error('Table column target index out of range');
      }

      tableRowChildren[targetIndex].remove();
    }
  }

  return tableNode;
}

export function $deleteTableRowAtSelection(): void {
  const selection = $getSelection();
  invariant(
    $isRangeSelection(selection) || $isTableSelection(selection),
    'Expected a RangeSelection or TableSelection',
  );
  const [anchor, focus] = selection.isBackward()
    ? [selection.focus.getNode(), selection.anchor.getNode()]
    : [selection.anchor.getNode(), selection.focus.getNode()];
  const [anchorCell, , grid] = $getNodeTriplet(anchor);
  const [focusCell] = $getNodeTriplet(focus);
  const [gridMap, anchorCellMap, focusCellMap] = $computeTableMap(
    grid,
    anchorCell,
    focusCell,
  );
  const {startRow: anchorStartRow} = anchorCellMap;
  const {startRow: focusStartRow} = focusCellMap;
  const focusEndRow = focusStartRow + focusCell.__rowSpan - 1;
  if (gridMap.length === focusEndRow - anchorStartRow + 1) {
    // Empty grid. Move the selection out of the table before removing it,
    // otherwise a TableSelection is left pointing at cells that no longer
    // exist — $deleteTableColumnAtSelection and TableObserver.$clearText both
    // call selectPrevious() here for the same reason.
    grid.selectPrevious();
    grid.remove();
    return;
  }
  const columnCount = gridMap[0].length;
  const nextRow = gridMap[focusEndRow + 1];
  const nextRowNode = grid.getChildAtIndex(focusEndRow + 1);
  for (let row = focusEndRow; row >= anchorStartRow; row--) {
    for (let column = columnCount - 1; column >= 0; column--) {
      const {
        cell,
        startRow: cellStartRow,
        startColumn: cellStartColumn,
      } = gridMap[row][column];
      if (cellStartColumn !== column) {
        // Don't repeat work for the same Cell
        continue;
      }
      // Rows overflowing top or bottom have to be trimmed
      if (
        cellStartRow < anchorStartRow ||
        cellStartRow + cell.__rowSpan - 1 > focusEndRow
      ) {
        const intersectionStart = Math.max(cellStartRow, anchorStartRow);
        const intersectionEnd = Math.min(
          cell.__rowSpan + cellStartRow - 1,
          focusEndRow,
        );

        const overflowRowsCount =
          intersectionStart <= intersectionEnd
            ? intersectionEnd - intersectionStart + 1
            : 0;
        cell.setRowSpan(cell.__rowSpan - overflowRowsCount);
      }
      // Rows overflowing bottom have to be moved to the next row
      if (
        cellStartRow >= anchorStartRow &&
        cellStartRow + cell.__rowSpan - 1 > focusEndRow &&
        // Handle overflow only once
        row === focusEndRow
      ) {
        invariant($isTableRowNode(nextRowNode), 'Expected a TableRowNode');
        let insertAfterCell: null | TableCellNode = null;
        for (let columnIndex = 0; columnIndex < column; columnIndex++) {
          const currentCellMap = nextRow[columnIndex];
          const currentCell = currentCellMap.cell;
          // Checking the cell having startRow as same as nextRow
          if (currentCellMap.startRow === row + 1) {
            insertAfterCell = currentCell;
          }
          if (currentCell.__colSpan > 1) {
            columnIndex += currentCell.__colSpan - 1;
          }
        }
        if (insertAfterCell === null) {
          $insertFirst(nextRowNode, cell);
        } else {
          insertAfterCell.insertAfter(cell);
        }
      }
    }
    const rowNode = grid.getChildAtIndex(row);
    invariant(
      $isTableRowNode(rowNode),
      'Expected TableNode childAtIndex(%s) to be RowNode',
      String(row),
    );
    rowNode.remove();
  }
  if (nextRow !== undefined) {
    const {cell} = nextRow[0];
    $moveSelectionToCell(cell);
  } else {
    const previousRow = gridMap[anchorStartRow - 1];
    const {cell} = previousRow[0];
    $moveSelectionToCell(cell);
  }
}

/**
 * @deprecated renamed to {@link $deleteTableRowAtSelection}
 */
export const $deleteTableRow__EXPERIMENTAL = $deleteTableRowAtSelection;

export function $deleteTableColumnAtSelection(): void {
  const selection = $getSelection();
  invariant(
    $isRangeSelection(selection) || $isTableSelection(selection),
    'Expected a RangeSelection or TableSelection',
  );
  const anchor = selection.anchor.getNode();
  const focus = selection.focus.getNode();
  const [anchorCell, , grid] = $getNodeTriplet(anchor);
  const [focusCell] = $getNodeTriplet(focus);
  const [gridMap, anchorCellMap, focusCellMap] = $computeTableMap(
    grid,
    anchorCell,
    focusCell,
  );
  const {startColumn: anchorStartColumn} = anchorCellMap;
  const {startRow: focusStartRow, startColumn: focusStartColumn} = focusCellMap;
  const startColumn = Math.min(anchorStartColumn, focusStartColumn);
  const endColumn = Math.max(
    anchorStartColumn + anchorCell.__colSpan - 1,
    focusStartColumn + focusCell.__colSpan - 1,
  );
  const selectedColumnCount = endColumn - startColumn + 1;
  const columnCount = gridMap[0].length;
  if (columnCount === endColumn - startColumn + 1) {
    // Empty grid
    grid.selectPrevious();
    grid.remove();
    return;
  }
  const rowCount = gridMap.length;
  for (let row = 0; row < rowCount; row++) {
    for (let column = startColumn; column <= endColumn; column++) {
      const {cell, startColumn: cellStartColumn} = gridMap[row][column];
      if (cellStartColumn < startColumn) {
        if (column === startColumn) {
          const overflowLeft = startColumn - cellStartColumn;
          // Overflowing left
          cell.setColSpan(
            cell.__colSpan -
              // Possible overflow right too
              Math.min(selectedColumnCount, cell.__colSpan - overflowLeft),
          );
        }
      } else if (cellStartColumn + cell.__colSpan - 1 > endColumn) {
        if (column === endColumn) {
          // Overflowing right
          const inSelectedArea = endColumn - cellStartColumn + 1;
          cell.setColSpan(cell.__colSpan - inSelectedArea);
        }
      } else {
        cell.remove();
      }
    }
  }
  const focusRowMap = gridMap[focusStartRow];
  const nextColumn =
    anchorStartColumn > focusStartColumn
      ? focusRowMap[anchorStartColumn + anchorCell.__colSpan]
      : focusRowMap[focusStartColumn + focusCell.__colSpan];
  if (nextColumn !== undefined) {
    const {cell} = nextColumn;
    $moveSelectionToCell(cell);
  } else {
    const previousRow =
      focusStartColumn < anchorStartColumn
        ? focusRowMap[focusStartColumn - 1]
        : focusRowMap[anchorStartColumn - 1];
    const {cell} = previousRow;
    $moveSelectionToCell(cell);
  }
  const colWidths = grid.getColWidths();
  if (colWidths) {
    const newColWidths = [...colWidths];
    newColWidths.splice(startColumn, selectedColumnCount);
    grid.setColWidths(newColWidths);
  }
}

/**
 * @deprecated renamed to {@link $deleteTableColumnAtSelection}
 */
export const $deleteTableColumn__EXPERIMENTAL = $deleteTableColumnAtSelection;

function $moveSelectionToCell(cell: TableCellNode): void {
  const firstDescendant = cell.getFirstDescendant();
  if (firstDescendant == null) {
    cell.selectStart();
  } else {
    firstDescendant.getParentOrThrow().selectStart();
  }
}

function $insertFirst(parent: ElementNode, node: LexicalNode): void {
  const firstChild = parent.getFirstChild();
  if (firstChild !== null) {
    firstChild.insertBefore(node);
  } else {
    parent.append(node);
  }
}

export function $mergeCells(cellNodes: TableCellNode[]): TableCellNode | null {
  if (cellNodes.length === 0) {
    return null;
  }

  // Find the table node
  const tableNode = $getTableNodeFromLexicalNodeOrThrow(cellNodes[0]);
  const [gridMap] = $computeTableMapSkipCellCheck(tableNode, null, null);

  // Find the boundaries of the selection including merged cells
  let minRow = Infinity;
  let maxRow = -Infinity;
  let minCol = Infinity;
  let maxCol = -Infinity;

  // First pass: find the actual boundaries considering merged cells
  const processedCells = new Set();
  for (const row of gridMap) {
    for (const mapCell of row) {
      if (!mapCell || !mapCell.cell) {
        continue;
      }

      const cellKey = mapCell.cell.getKey();
      if (processedCells.has(cellKey)) {
        continue;
      }

      if (cellNodes.some(cell => cell.is(mapCell.cell))) {
        processedCells.add(cellKey);
        // Get the actual position of this cell in the grid
        const cellStartRow = mapCell.startRow;
        const cellStartCol = mapCell.startColumn;
        const cellRowSpan = mapCell.cell.__rowSpan || 1;
        const cellColSpan = mapCell.cell.__colSpan || 1;

        // Update boundaries considering the cell's actual position and span
        minRow = Math.min(minRow, cellStartRow);
        maxRow = Math.max(maxRow, cellStartRow + cellRowSpan - 1);
        minCol = Math.min(minCol, cellStartCol);
        maxCol = Math.max(maxCol, cellStartCol + cellColSpan - 1);
      }
    }
  }

  // Validate boundaries
  if (minRow === Infinity || minCol === Infinity) {
    return null;
  }

  // The total span of the merged cell
  const totalRowSpan = maxRow - minRow + 1;
  const totalColSpan = maxCol - minCol + 1;

  // Use the top-left cell as the target cell
  const targetCellMap = gridMap[minRow][minCol];
  if (!targetCellMap.cell) {
    return null;
  }
  const targetCell = targetCellMap.cell;

  // Set the spans for the target cell
  targetCell.setColSpan(totalColSpan);
  targetCell.setRowSpan(totalRowSpan);

  // Move content from other cells to the target cell
  const seenCells = new Set([targetCell.getKey()]);

  // Second pass: merge content and remove other cells
  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      const mapCell = gridMap[row][col];
      if (!mapCell.cell) {
        continue;
      }

      const currentCell = mapCell.cell;
      const key = currentCell.getKey();

      if (!seenCells.has(key)) {
        seenCells.add(key);
        const isEmpty = $cellContainsEmptyParagraph(currentCell);
        if (!isEmpty) {
          targetCell.append(...currentCell.getChildren());
        }
        currentCell.remove();
      }
    }
  }

  // Ensure target cell has content
  if (targetCell.getChildrenSize() === 0) {
    targetCell.append($createParagraphNode());
  }

  return targetCell;
}

function $cellContainsEmptyParagraph(cell: TableCellNode): boolean {
  if (cell.getChildrenSize() !== 1) {
    return false;
  }
  const firstChild = cell.getFirstChildOrThrow();
  if (!$isParagraphNode(firstChild) || !firstChild.isEmpty()) {
    return false;
  }
  return true;
}

export function $unmergeCell(): void {
  const selection = $getSelection();
  invariant(
    $isRangeSelection(selection) || $isTableSelection(selection),
    'Expected a RangeSelection or TableSelection',
  );
  const anchor = selection.anchor.getNode();
  const cellNode = $findMatchingParent(anchor, $isTableCellNode);
  invariant(
    $isTableCellNode(cellNode),
    'Expected to find a parent TableCellNode',
  );
  return $unmergeCellNode(cellNode);
}

/**
 * Unmerges the given cell, splitting it back into individual cells.
 * Unlike {@link $unmergeCell}, this does not depend on the current
 * selection. No-op if the cell is not merged.
 *
 * @param cellNode The merged cell to split.
 */
export function $unmergeCellNode(cellNode: TableCellNode): void {
  const [cell, row, grid] = $getNodeTriplet(cellNode);
  const colSpan = cell.__colSpan;
  const rowSpan = cell.__rowSpan;
  if (colSpan === 1 && rowSpan === 1) {
    return;
  }
  const [map, cellMap] = $computeTableMap(grid, cell, cell);
  const {startColumn, startRow} = cellMap;
  // Create a heuristic for what the style of the unmerged cells should be
  // based on whether every row or column already had that state before the
  // unmerge.
  const baseColStyle = cell.__headerState & TableCellHeaderStates.COLUMN;
  const colStyles = Array.from({length: colSpan}, (_v, i) => {
    let colStyle = baseColStyle;
    for (let rowIdx = 0; colStyle !== 0 && rowIdx < map.length; rowIdx++) {
      colStyle &= map[rowIdx][i + startColumn].cell.__headerState;
    }
    return colStyle;
  });
  const baseRowStyle = cell.__headerState & TableCellHeaderStates.ROW;
  const rowStyles = Array.from({length: rowSpan}, (_v, i) => {
    let rowStyle = baseRowStyle;
    for (let colIdx = 0; rowStyle !== 0 && colIdx < map[0].length; colIdx++) {
      rowStyle &= map[i + startRow][colIdx].cell.__headerState;
    }
    return rowStyle;
  });

  // The cells the merged cell splits into cover the region the merged cell
  // covered, so they keep its presentation: the background and vertical align
  // it carries as a TableCellNode, and the format, style, direction and indent
  // it carries as an ElementNode. $copyNode carries all of it, preserves a
  // TableCellNode subclass, and returns the copy childless. Only the state that
  // describes a position rather than the cell is reset — the spans, set by the
  // loops below, the header state, recomputed above, and the width, which
  // measured a cell colSpan grid columns wide and which every other path that
  // creates a cell here leaves to the table's colWidths.
  const $createSplitCell = (headerState: TableCellHeaderState) =>
    $copyNode(cell)
      .setColSpan(1)
      .setRowSpan(1)
      .setHeaderStyles(headerState)
      .setWidth(undefined)
      .append($createParagraphNode());

  if (colSpan > 1) {
    for (let i = 1; i < colSpan; i++) {
      cell.insertAfter($createSplitCell(colStyles[i] | rowStyles[0]));
    }
    cell.setColSpan(1);
  }

  if (rowSpan > 1) {
    let currentRowNode;
    for (let i = 1; i < rowSpan; i++) {
      const currentRow = startRow + i;
      const currentRowMap = map[currentRow];
      currentRowNode = (currentRowNode || row).getNextSibling();
      invariant(
        $isTableRowNode(currentRowNode),
        'Expected row next sibling to be a row',
      );
      let insertAfterCell: null | TableCellNode = null;
      for (let column = 0; column < startColumn; column++) {
        const currentCellMap = currentRowMap[column];
        const currentCell = currentCellMap.cell;
        if (currentCellMap.startRow === currentRow) {
          insertAfterCell = currentCell;
        }
        if (currentCell.__colSpan > 1) {
          column += currentCell.__colSpan - 1;
        }
      }
      if (insertAfterCell === null) {
        for (let j = colSpan - 1; j >= 0; j--) {
          $insertFirst(
            currentRowNode,
            $createSplitCell(colStyles[j] | rowStyles[i]),
          );
        }
      } else {
        for (let j = colSpan - 1; j >= 0; j--) {
          insertAfterCell.insertAfter(
            $createSplitCell(colStyles[j] | rowStyles[i]),
          );
        }
      }
    }
    cell.setRowSpan(1);
  }
}

export function $computeTableMap(
  tableNode: TableNode,
  cellA: TableCellNode,
  cellB: TableCellNode,
): [TableMapType, TableMapValueType, TableMapValueType] {
  const [tableMap, cellAValue, cellBValue] = $computeTableMapSkipCellCheck(
    tableNode,
    cellA,
    cellB,
  );
  invariant(cellAValue !== null, 'Anchor not found in Table');
  invariant(cellBValue !== null, 'Focus not found in Table');
  return [tableMap, cellAValue, cellBValue];
}

export function $computeTableMapSkipCellCheck(
  tableNode: TableNode,
  cellA: null | TableCellNode,
  cellB: null | TableCellNode,
): [
  tableMap: TableMapType,
  cellAValue: TableMapValueType | null,
  cellBValue: TableMapValueType | null,
] {
  const tableMap: TableMapType = [];
  let cellAValue: null | TableMapValueType = null;
  let cellBValue: null | TableMapValueType = null;
  function getMapRow(i: number) {
    let row = tableMap[i];
    if (row === undefined) {
      tableMap[i] = row = [];
    }
    return row;
  }
  const gridChildren = tableNode.getChildren();
  for (let rowIdx = 0; rowIdx < gridChildren.length; rowIdx++) {
    const row = gridChildren[rowIdx];
    invariant(
      $isTableRowNode(row),
      'Expected TableNode children to be TableRowNode',
    );
    const startMapRow = getMapRow(rowIdx);
    for (
      let cell = row.getFirstChild(), colIdx = 0;
      cell != null;
      cell = cell.getNextSibling()
    ) {
      invariant(
        $isTableCellNode(cell),
        'Expected TableRowNode children to be TableCellNode',
      );
      // Skip past any columns that were merged from a higher row
      while (startMapRow[colIdx] !== undefined) {
        colIdx++;
      }
      const value: TableMapValueType = {
        cell,
        startColumn: colIdx,
        startRow: rowIdx,
      };
      const {__rowSpan: rowSpan, __colSpan: colSpan} = cell;
      for (let j = 0; j < rowSpan; j++) {
        if (rowIdx + j >= gridChildren.length) {
          // The table is non-rectangular with a rowSpan
          // below the last <tr> in the table.
          // We should probably handle this with a node transform
          // to ensure that tables are always rectangular but this
          // will avoid crashes such as #6584
          // Note that there are probably still latent bugs
          // regarding colSpan or general cell count mismatches.
          break;
        }
        const mapRow = getMapRow(rowIdx + j);
        for (let i = 0; i < colSpan; i++) {
          mapRow[colIdx + i] = value;
        }
      }
      if (cellA !== null && cellAValue === null && cellA.is(cell)) {
        cellAValue = value;
      }
      if (cellB !== null && cellBValue === null && cellB.is(cell)) {
        cellBValue = value;
      }
    }
  }
  return [tableMap, cellAValue, cellBValue];
}

export function $getNodeTriplet(
  source: PointType | LexicalNode | TableCellNode,
): [TableCellNode, TableRowNode, TableNode] {
  let cell: TableCellNode;
  if (source instanceof TableCellNode) {
    cell = source;
  } else if ('__type' in source) {
    const cell_ = $findMatchingParent(source, $isTableCellNode);
    invariant(
      $isTableCellNode(cell_),
      'Expected to find a parent TableCellNode',
    );
    cell = cell_;
  } else {
    const cell_ = $findMatchingParent(source.getNode(), $isTableCellNode);
    invariant(
      $isTableCellNode(cell_),
      'Expected to find a parent TableCellNode',
    );
    cell = cell_;
  }
  const row = cell.getParent();
  invariant(
    $isTableRowNode(row),
    'Expected TableCellNode to have a parent TableRowNode',
  );
  const grid = row.getParent();
  invariant(
    $isTableNode(grid),
    'Expected TableRowNode to have a parent TableNode',
  );
  return [cell, row, grid];
}

export interface TableCellRectBoundary {
  minColumn: number;
  minRow: number;
  maxColumn: number;
  maxRow: number;
}

export interface TableCellRectSpans {
  topSpan: number;
  leftSpan: number;
  rightSpan: number;
  bottomSpan: number;
}

export function $computeTableCellRectSpans(
  map: TableMapType,
  boundary: TableCellRectBoundary,
): TableCellRectSpans {
  const {minColumn, maxColumn, minRow, maxRow} = boundary;
  let topSpan = 1;
  let leftSpan = 1;
  let rightSpan = 1;
  let bottomSpan = 1;
  const topRow = map[minRow];
  const bottomRow = map[maxRow];
  for (let col = minColumn; col <= maxColumn; col++) {
    topSpan = Math.max(topSpan, topRow[col].cell.__rowSpan);
    bottomSpan = Math.max(bottomSpan, bottomRow[col].cell.__rowSpan);
  }
  for (let row = minRow; row <= maxRow; row++) {
    leftSpan = Math.max(leftSpan, map[row][minColumn].cell.__colSpan);
    rightSpan = Math.max(rightSpan, map[row][maxColumn].cell.__colSpan);
  }
  return {bottomSpan, leftSpan, rightSpan, topSpan};
}

/**
 * Compute the bounding rectangle of two table cells in a table map,
 * expanding iteratively to include any merged cells that overlap the boundary.
 */
export function $computeTableCellRectBoundary(
  map: TableMapType,
  cellAMap: TableMapValueType,
  cellBMap: TableMapValueType,
): TableCellRectBoundary {
  // Initial boundaries based on the anchor and focus cells
  let minColumn = Math.min(cellAMap.startColumn, cellBMap.startColumn);
  let minRow = Math.min(cellAMap.startRow, cellBMap.startRow);
  let maxColumn = Math.max(
    cellAMap.startColumn + cellAMap.cell.__colSpan - 1,
    cellBMap.startColumn + cellBMap.cell.__colSpan - 1,
  );
  let maxRow = Math.max(
    cellAMap.startRow + cellAMap.cell.__rowSpan - 1,
    cellBMap.startRow + cellBMap.cell.__rowSpan - 1,
  );

  // Keep expanding until we have a complete rectangle
  let hasChanges;
  do {
    hasChanges = false;

    // Check all cells in the table
    for (let row = 0; row < map.length; row++) {
      for (let col = 0; col < map[0].length; col++) {
        const cell = map[row][col];
        if (!cell) {
          continue;
        }

        const cellEndCol = cell.startColumn + cell.cell.__colSpan - 1;
        const cellEndRow = cell.startRow + cell.cell.__rowSpan - 1;

        // Check if this cell intersects with our current selection rectangle
        const intersectsHorizontally =
          cell.startColumn <= maxColumn && cellEndCol >= minColumn;
        const intersectsVertically =
          cell.startRow <= maxRow && cellEndRow >= minRow;

        // If the cell intersects either horizontally or vertically
        if (intersectsHorizontally && intersectsVertically) {
          // Expand boundaries to include this cell completely
          const newMinColumn = Math.min(minColumn, cell.startColumn);
          const newMaxColumn = Math.max(maxColumn, cellEndCol);
          const newMinRow = Math.min(minRow, cell.startRow);
          const newMaxRow = Math.max(maxRow, cellEndRow);

          // Check if boundaries changed
          if (
            newMinColumn !== minColumn ||
            newMaxColumn !== maxColumn ||
            newMinRow !== minRow ||
            newMaxRow !== maxRow
          ) {
            minColumn = newMinColumn;
            maxColumn = newMaxColumn;
            minRow = newMinRow;
            maxRow = newMaxRow;
            hasChanges = true;
          }
        }
      }
    }
  } while (hasChanges);

  return {
    maxColumn,
    maxRow,
    minColumn,
    minRow,
  };
}

/**
 * Checks if the table does not have any merged cells.
 *
 * @param table Table to check for if it has any merged cells.
 * @returns True if the table does not have any merged cells, false otherwise.
 */
export function $isSimpleTable(table: TableNode): boolean {
  const rows = table.getChildren();
  let columns: null | number = null;
  for (const row of rows) {
    if (!$isTableRowNode(row)) {
      return false;
    }
    if (columns === null) {
      columns = row.getChildrenSize();
    }
    if (row.getChildrenSize() !== columns) {
      return false;
    }
    const cells = row.getChildren();
    for (const cell of cells) {
      if (
        !$isTableCellNode(cell) ||
        cell.getRowSpan() !== 1 ||
        cell.getColSpan() !== 1
      ) {
        return false;
      }
    }
  }
  return (columns || 0) > 0;
}

/**
 * Moves a column from one position to another within a simple (non-merged) table.
 *
 * @param tableNode The table node to modify.
 * @param originColumn The index of the column to move.
 * @param targetColumn The index to move the column to.
 */
export function $moveTableColumn(
  tableNode: TableNode,
  originColumn: number,
  targetColumn: number,
): void {
  if (originColumn === targetColumn) {
    return;
  }
  const columnCount = tableNode.getColumnCount();
  if (
    originColumn < 0 ||
    originColumn >= columnCount ||
    targetColumn < 0 ||
    targetColumn >= columnCount
  ) {
    return;
  }
  if (!$isSimpleTable(tableNode)) {
    return;
  }
  const rows = tableNode.getChildren().filter($isTableRowNode);
  rows.forEach(row => {
    const cells = row.getChildren();
    const [moved] = cells.splice(originColumn, 1);
    cells.splice(targetColumn, 0, moved);
    row.splice(0, cells.length, cells);
  });
  const colWidths = tableNode.getColWidths();
  if (colWidths && colWidths.length === columnCount) {
    const newWidths = [...colWidths];
    const [movedWidth] = newWidths.splice(originColumn, 1);
    newWidths.splice(targetColumn, 0, movedWidth);
    tableNode.setColWidths(newWidths);
  }
}

/**
 * Moves a row from one position to another within a simple (non-merged) table.
 *
 * @param tableNode The table node to modify.
 * @param originRow The index of the row to move.
 * @param targetRow The index to move the row to.
 */
export function $moveTableRow(
  tableNode: TableNode,
  originRow: number,
  targetRow: number,
): void {
  if (originRow === targetRow) {
    return;
  }
  const rows = tableNode.getChildren().filter($isTableRowNode);
  const rowCount = rows.length;
  if (
    originRow < 0 ||
    originRow >= rowCount ||
    targetRow < 0 ||
    targetRow >= rowCount
  ) {
    return;
  }
  if (!$isSimpleTable(tableNode)) {
    return;
  }
  const originRowNode = rows[originRow];
  const targetRowNode = rows[targetRow];
  if (targetRow > originRow) {
    targetRowNode.insertAfter(originRowNode);
  } else {
    targetRowNode.insertBefore(originRowNode);
  }
}

export function $getTableCellNodeRect(tableCellNode: TableCellNode): {
  rowIndex: number;
  columnIndex: number;
  rowSpan: number;
  colSpan: number;
} | null {
  const [cellNode, , gridNode] = $getNodeTriplet(tableCellNode);
  const rows = gridNode.getChildren().filter($isTableRowNode);
  const rowCount = rows.length;
  const columnCount = rows[0].getChildren().length;

  // Create a matrix of the same size as the table to track the position of each cell
  const cellMatrix = new Array(rowCount);
  for (let i = 0; i < rowCount; i++) {
    cellMatrix[i] = new Array(columnCount);
  }

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row = rows[rowIndex];
    const cells = row.getChildren().filter($isTableCellNode);
    let columnIndex = 0;

    for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
      // Find the next available position in the matrix, skip the position of merged cells
      while (cellMatrix[rowIndex][columnIndex]) {
        columnIndex++;
      }

      const cell = cells[cellIndex];
      const rowSpan = cell.__rowSpan || 1;
      const colSpan = cell.__colSpan || 1;

      // Put the cell into the corresponding position in the matrix
      for (let i = 0; i < rowSpan; i++) {
        for (let j = 0; j < colSpan; j++) {
          cellMatrix[rowIndex + i][columnIndex + j] = cell;
        }
      }

      // Return to the original index, row span and column span of the cell.
      if (cellNode === cell) {
        return {
          colSpan,
          columnIndex,
          rowIndex,
          rowSpan,
        };
      }

      columnIndex += colSpan;
    }
  }

  return null;
}

export function $insertTableIntoGrid(
  tableNode: TableNode,
  selection: RangeSelection | TableSelection,
) {
  const anchorAndFocus = selection.getStartEndPoints();
  const isTableSel = $isTableSelection(selection);

  if (anchorAndFocus === null) {
    return false;
  }

  const [anchor, focus] = anchorAndFocus;
  const [anchorCellNode, anchorRowNode, gridNode] = $getNodeTriplet(anchor);
  const focusCellNode = $findMatchingParent(focus.getNode(), n =>
    $isTableCellNode(n),
  );

  if (
    !$isTableCellNode(anchorCellNode) ||
    !$isTableCellNode(focusCellNode) ||
    !$isTableRowNode(anchorRowNode) ||
    !$isTableNode(gridNode)
  ) {
    return false;
  }

  const [initialGridMap, anchorCellMap, focusCellMap] = $computeTableMap(
    gridNode,
    anchorCellNode,
    focusCellNode,
  );
  const [templateGridMap] = $computeTableMapSkipCellCheck(
    tableNode,
    null,
    null,
  );
  const initialRowCount = initialGridMap.length;
  const initialColCount = initialRowCount > 0 ? initialGridMap[0].length : 0;

  // If we have a range selection, we'll fit the template grid into the
  // table, growing the table if necessary.
  let startRow = anchorCellMap.startRow;
  let startCol = anchorCellMap.startColumn;
  let affectedRowCount = templateGridMap.length;
  let affectedColCount = affectedRowCount > 0 ? templateGridMap[0].length : 0;

  if (isTableSel) {
    const selectionBoundary = $computeTableCellRectBoundary(
      initialGridMap,
      anchorCellMap,
      focusCellMap,
    );
    const selectionRowCount =
      selectionBoundary.maxRow - selectionBoundary.minRow + 1;
    const selectionColCount =
      selectionBoundary.maxColumn - selectionBoundary.minColumn + 1;
    startRow = selectionBoundary.minRow;
    startCol = selectionBoundary.minColumn;
    affectedRowCount = Math.min(affectedRowCount, selectionRowCount);
    affectedColCount = Math.min(affectedColCount, selectionColCount);
  }

  // Step 1: Unmerge all merged cells within the affected area
  let didPerformMergeOperations = false;
  const lastRowForUnmerge =
    Math.min(initialRowCount, startRow + affectedRowCount) - 1;
  const lastColForUnmerge =
    Math.min(initialColCount, startCol + affectedColCount) - 1;
  const unmergedKeys = new Set<NodeKey>();
  for (let row = startRow; row <= lastRowForUnmerge; row++) {
    for (let col = startCol; col <= lastColForUnmerge; col++) {
      const cellMap = initialGridMap[row][col];
      if (unmergedKeys.has(cellMap.cell.getKey())) {
        continue; // cell was a merged cell that was already handled
      }
      if (cellMap.cell.__rowSpan === 1 && cellMap.cell.__colSpan === 1) {
        continue; // cell is not a merged cell
      }
      $unmergeCellNode(cellMap.cell);
      unmergedKeys.add(cellMap.cell.getKey());
      didPerformMergeOperations = true;
    }
  }

  let [interimGridMap] = $computeTableMapSkipCellCheck(
    gridNode.getWritable(),
    null,
    null,
  );

  // Step 2: Expand current table (if needed)
  const rowsToInsert = affectedRowCount - initialRowCount + startRow;
  for (let i = 0; i < rowsToInsert; i++) {
    const cellMap = interimGridMap[initialRowCount - 1][0];
    $insertTableRowAtNode(cellMap.cell);
  }
  const colsToInsert = affectedColCount - initialColCount + startCol;
  for (let i = 0; i < colsToInsert; i++) {
    const cellMap = interimGridMap[0][initialColCount - 1];
    $insertTableColumnAtNode(cellMap.cell, true, false);
  }

  [interimGridMap] = $computeTableMapSkipCellCheck(
    gridNode.getWritable(),
    null,
    null,
  );

  // Step 3: Merge cells and set cell content, to match template grid
  for (let row = startRow; row < startRow + affectedRowCount; row++) {
    for (let col = startCol; col < startCol + affectedColCount; col++) {
      const templateRow = row - startRow;
      const templateCol = col - startCol;
      const templateCellMap = templateGridMap[templateRow][templateCol];
      if (
        templateCellMap.startRow !== templateRow ||
        templateCellMap.startColumn !== templateCol
      ) {
        continue; // cell is a merged cell that was already handled
      }

      const templateCell = templateCellMap.cell;
      if (templateCell.__rowSpan !== 1 || templateCell.__colSpan !== 1) {
        const cellsToMerge = [];
        const lastRowForMerge =
          Math.min(row + templateCell.__rowSpan, startRow + affectedRowCount) -
          1;
        const lastColForMerge =
          Math.min(col + templateCell.__colSpan, startCol + affectedColCount) -
          1;
        for (let r = row; r <= lastRowForMerge; r++) {
          for (let c = col; c <= lastColForMerge; c++) {
            const cellMap = interimGridMap[r][c];
            cellsToMerge.push(cellMap.cell);
          }
        }
        $mergeCells(cellsToMerge);
        didPerformMergeOperations = true;
      }

      const {cell} = interimGridMap[row][col];
      const backgroundColor = templateCell.getBackgroundColor();
      if (backgroundColor !== null && backgroundColor !== undefined) {
        cell.setBackgroundColor(backgroundColor);
      }
      const verticalAlign = templateCell.getVerticalAlign();
      if (verticalAlign !== undefined) {
        cell.setVerticalAlign(verticalAlign);
      }
      const originalChildren = cell.getChildren();
      templateCell.getChildren().forEach(child => {
        if ($isTextNode(child)) {
          const paragraphNode = $createParagraphNode();
          paragraphNode.append(child);
          cell.append(child);
        } else {
          cell.append(child);
        }
      });
      originalChildren.forEach(n => n.remove());
    }
  }

  if (isTableSel && didPerformMergeOperations) {
    // reset the table selection in case the anchor or focus cell was
    // removed via merge operations
    const [finalGridMap] = $computeTableMapSkipCellCheck(
      gridNode.getWritable(),
      null,
      null,
    );
    const newAnchorCellMap =
      finalGridMap[anchorCellMap.startRow][anchorCellMap.startColumn];
    newAnchorCellMap.cell.selectEnd();
  }

  return true;
}

export function $setTableRowIsHeader(
  tableNode: TableNode,
  rowIndex: number,
  isHeader: boolean,
): void {
  const [gridMap] = $computeTableMapSkipCellCheck(tableNode, null, null);
  invariant(
    rowIndex >= 0 && rowIndex < gridMap.length,
    'Table row index %s out of range',
    String(rowIndex),
  );
  const rowMap = gridMap[rowIndex];
  const headerState = isHeader
    ? TableCellHeaderStates.ROW
    : TableCellHeaderStates.NO_STATUS;
  const visited = new Set<TableCellNode>();
  for (let col = 0; col < rowMap.length; col++) {
    const mapCell = rowMap[col];
    if (mapCell == null) {
      continue;
    }
    if (!visited.has(mapCell.cell)) {
      visited.add(mapCell.cell);
      mapCell.cell.setHeaderStyles(headerState, TableCellHeaderStates.ROW);
    }
  }
}

export function $setTableColumnIsHeader(
  tableNode: TableNode,
  columnIndex: number,
  isHeader: boolean,
): void {
  const [gridMap] = $computeTableMapSkipCellCheck(tableNode, null, null);
  invariant(
    gridMap.length > 0 && columnIndex >= 0 && columnIndex < gridMap[0].length,
    'Table column index %s out of range',
    String(columnIndex),
  );
  const headerState = isHeader
    ? TableCellHeaderStates.COLUMN
    : TableCellHeaderStates.NO_STATUS;
  const visited = new Set<TableCellNode>();
  for (let row = 0; row < gridMap.length; row++) {
    const mapCell = gridMap[row][columnIndex];
    if (mapCell == null) {
      continue;
    }
    if (!visited.has(mapCell.cell)) {
      visited.add(mapCell.cell);
      mapCell.cell.setHeaderStyles(headerState, TableCellHeaderStates.COLUMN);
    }
  }
}
