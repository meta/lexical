/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {
  $createParagraphNode,
  $createPoint,
  $createTextNode,
  $findMatchingParent,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isTextNode,
  $normalizeSelection__EXPERIMENTAL,
  type BaseSelection,
  type ElementNode,
  isCurrentlyReadOnlyMode,
  type LexicalNode,
  type NodeKey,
  type PointType,
  TEXT_TYPE_TO_FORMAT,
  type TextFormatType,
  type TextNode,
} from 'lexical';

import {
  $createTableCellNode,
  $isTableCellNode,
  TableCellHeaderStates,
  type TableCellNode,
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
import {$findTableNode} from './LexicalTableSelectionHelpers';
import {
  $computeTableCellRectBoundary,
  $computeTableMap,
  $getTableCellNodeRect,
  $insertTableIntoGrid,
  $padTableRows,
} from './LexicalTableUtils';

const __DEV__ = process.env.NODE_ENV !== 'production';

export type TableSelectionShape = {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
};

export type TableMapValueType = {
  cell: TableCellNode;
  startRow: number;
  startColumn: number;
};
export type TableMapType = TableMapValueType[][];

function $getCellNodes(tableSelection: TableSelection): {
  anchorCell: TableCellNode;
  anchorNode: TextNode | ElementNode;
  anchorRow: TableRowNode;
  anchorTable: TableNode;
  focusCell: TableCellNode;
  focusNode: TextNode | ElementNode;
  focusRow: TableRowNode;
  focusTable: TableNode;
} {
  const [
    [anchorNode, anchorCell, anchorRow, anchorTable],
    [focusNode, focusCell, focusRow, focusTable],
  ] = (['anchor', 'focus'] as const).map(
    (k): [ElementNode | TextNode, TableCellNode, TableRowNode, TableNode] => {
      const node = tableSelection[k].getNode();
      const cellNode = $findMatchingParent(node, $isTableCellNode);
      invariant(
        $isTableCellNode(cellNode),
        'Expected TableSelection %s to be (or a child of) TableCellNode, got key %s of type %s',
        k,
        node.getKey(),
        node.getType(),
      );
      const rowNode = cellNode.getParent();
      invariant(
        $isTableRowNode(rowNode),
        'Expected TableSelection %s cell parent to be a TableRowNode',
        k,
      );
      const tableNode = rowNode.getParent();
      invariant(
        $isTableNode(tableNode),
        'Expected TableSelection %s row parent to be a TableNode',
        k,
      );
      return [node, cellNode, rowNode, tableNode];
    },
  );
  // TODO: nested tables may violate this
  invariant(
    anchorTable.is(focusTable),
    'Expected TableSelection anchor and focus to be in the same table',
  );
  return {
    anchorCell,
    anchorNode,
    anchorRow,
    anchorTable,
    focusCell,
    focusNode,
    focusRow,
    focusTable,
  };
}

export class TableSelection implements BaseSelection {
  tableKey: NodeKey;
  anchor: PointType;
  focus: PointType;
  _cachedNodes: LexicalNode[] | null;
  dirty: boolean;

  constructor(tableKey: NodeKey, anchor: PointType, focus: PointType) {
    this.anchor = anchor;
    this.focus = focus;
    anchor._selection = this;
    focus._selection = this;
    this._cachedNodes = null;
    this.dirty = false;
    this.tableKey = tableKey;
  }

  getStartEndPoints(): [PointType, PointType] {
    return [this.anchor, this.focus];
  }

  /**
   * {@link $createTableSelection} unfortunately makes it very easy to create
   * nonsense selections, so we have a method to see if the selection probably
   * makes sense.
   *
   * @returns true if the TableSelection is (probably) valid
   */
  isValid(): boolean {
    if (
      this.tableKey === 'root' ||
      this.anchor.key === 'root' ||
      this.anchor.type !== 'element' ||
      this.focus.key === 'root' ||
      this.focus.type !== 'element'
    ) {
      return false;
    }

    // Check if the referenced nodes still exist in the editor
    const tableNode = $getNodeByKey(this.tableKey);
    const anchorNode = $getNodeByKey(this.anchor.key);
    const focusNode = $getNodeByKey(this.focus.key);

    return tableNode !== null && anchorNode !== null && focusNode !== null;
  }

  /**
   * Returns whether the Selection is "backwards", meaning the focus
   * logically precedes the anchor in the EditorState.
   * @returns true if the Selection is backwards, false otherwise.
   */
  isBackward(): boolean {
    return this.focus.isBefore(this.anchor);
  }

  getCachedNodes(): LexicalNode[] | null {
    return this._cachedNodes;
  }

  setCachedNodes(nodes: LexicalNode[] | null): void {
    this._cachedNodes = nodes;
  }

  is(selection: null | BaseSelection): boolean {
    return (
      $isTableSelection(selection) &&
      this.tableKey === selection.tableKey &&
      this.anchor.is(selection.anchor) &&
      this.focus.is(selection.focus)
    );
  }

  set(tableKey: NodeKey, anchorCellKey: NodeKey, focusCellKey: NodeKey): void {
    // note: closure compiler's acorn does not support ||=
    this.dirty =
      this.dirty ||
      tableKey !== this.tableKey ||
      anchorCellKey !== this.anchor.key ||
      focusCellKey !== this.focus.key;
    this.tableKey = tableKey;
    this.anchor.key = anchorCellKey;
    this.focus.key = focusCellKey;
    this._cachedNodes = null;
  }

  clone(): TableSelection {
    return new TableSelection(
      this.tableKey,
      $createPoint(this.anchor.key, this.anchor.offset, this.anchor.type),
      $createPoint(this.focus.key, this.focus.offset, this.focus.type),
    );
  }

  isCollapsed(): boolean {
    return false;
  }

  extract(): LexicalNode[] {
    return this.getNodes();
  }

  insertRawText(text: string): void {
    if (text === '') {
      return;
    }
    const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
    const tsvGrid = trimmed.split('\n').map(line => line.split('\t'));
    const tableNode = $createTableNode();
    for (const row of tsvGrid) {
      const rowNode = $createTableRowNode();
      for (const cellText of row) {
        const cellNode = $createTableCellNode(TableCellHeaderStates.NO_STATUS);
        const paragraph = $createParagraphNode();
        if (cellText) {
          paragraph.append($createTextNode(cellText));
        }
        cellNode.append(paragraph);
        rowNode.append(cellNode);
      }
      tableNode.append(rowNode);
    }
    const {anchorCell, anchorTable, focusCell} = $getCellNodes(this);
    // A grid of values is laid over the selection's rectangle from its
    // top-left cell, whichever corner the selection was made from (it can
    // run right to left or upwards). A single value goes to the cell the
    // selection was started from.
    let startCell = anchorCell;
    const isSingleValue = tsvGrid.length === 1 && tsvGrid[0].length === 1;
    if (!anchorCell.is(focusCell) && !isSingleValue) {
      $padTableRows(anchorTable);
      const [map, anchorMap, focusMap] = $computeTableMap(
        anchorTable,
        anchorCell,
        focusCell,
      );
      const {minRow, minColumn} = $computeTableCellRectBoundary(
        map,
        anchorMap,
        focusMap,
      );
      startCell = map[minRow][minColumn].cell;
    }
    const rangeSelection = startCell.select(0, startCell.getChildrenSize());
    $insertTableIntoGrid(tableNode, rangeSelection);
  }

  insertText(): void {
    // Do nothing?
  }

  /**
   * Returns whether the provided TextFormatType is present on the Selection.
   * This will be true if any text in any of the selected cells' blocks carries
   * the format, and if any block in them would type in that format.
   *
   * @param type the TextFormatType to check for.
   * @returns true if the provided format is currently toggled on the Selection, false otherwise.
   */
  hasFormat(type: TextFormatType): boolean {
    const formatFlag = TEXT_TYPE_TO_FORMAT[type];

    const $cellHasFormat = (node: LexicalNode): boolean => {
      if ($isTextNode(node)) {
        return (node.getFormat() & formatFlag) !== 0;
      }
      if ($isElementNode(node)) {
        // A block's own text format is the format new text in it would be typed
        // in, which is the only thing this method reported before, and only for
        // the cell's first child.
        return (
          (node.getTextFormat() & formatFlag) !== 0 ||
          node.getChildren().some($cellHasFormat)
        );
      }
      return false;
    };

    return this.getNodes().some(
      node => $isTableCellNode(node) && $cellHasFormat(node),
    );
  }

  insertNodes(nodes: LexicalNode[]) {
    const focusNode = this.focus.getNode();
    invariant(
      $isElementNode(focusNode),
      'Expected TableSelection focus to be an ElementNode',
    );
    const selection = $normalizeSelection__EXPERIMENTAL(
      focusNode.select(0, focusNode.getChildrenSize()),
    );
    selection.insertNodes(nodes);
  }

  /** @deprecated Use {@link $computeTableMap} and {@link $computeTableCellRectBoundary} directly. */
  getShape(): TableSelectionShape {
    const {anchorCell, focusCell} = $getCellNodes(this);
    const anchorCellNodeRect = $getTableCellNodeRect(anchorCell);
    invariant(
      anchorCellNodeRect !== null,
      'getCellRect: expected to find AnchorNode',
    );
    const focusCellNodeRect = $getTableCellNodeRect(focusCell);
    invariant(
      focusCellNodeRect !== null,
      'getCellRect: expected to find focusCellNode',
    );

    const startX = Math.min(
      anchorCellNodeRect.columnIndex,
      focusCellNodeRect.columnIndex,
    );
    const stopX = Math.max(
      anchorCellNodeRect.columnIndex + anchorCellNodeRect.colSpan - 1,
      focusCellNodeRect.columnIndex + focusCellNodeRect.colSpan - 1,
    );

    const startY = Math.min(
      anchorCellNodeRect.rowIndex,
      focusCellNodeRect.rowIndex,
    );
    const stopY = Math.max(
      anchorCellNodeRect.rowIndex + anchorCellNodeRect.rowSpan - 1,
      focusCellNodeRect.rowIndex + focusCellNodeRect.rowSpan - 1,
    );

    return {
      fromX: Math.min(startX, stopX),
      fromY: Math.min(startY, stopY),
      toX: Math.max(startX, stopX),
      toY: Math.max(startY, stopY),
    };
  }

  getNodes(): LexicalNode[] {
    if (!this.isValid()) {
      return [];
    }
    const cachedNodes = this._cachedNodes;
    if (cachedNodes !== null) {
      return cachedNodes;
    }

    const {anchorTable: tableNode, anchorCell, focusCell} = $getCellNodes(this);

    const focusCellGrid = focusCell.getParents()[1];
    if (focusCellGrid !== tableNode) {
      if (!tableNode.isParentOf(focusCell)) {
        // focus is on higher Grid level than anchor
        const gridParent = tableNode.getParent();
        invariant(gridParent != null, 'Expected gridParent to have a parent');
        this.set(this.tableKey, gridParent.getKey(), focusCell.getKey());
      } else {
        // anchor is on higher Grid level than focus
        const focusCellParent = focusCellGrid.getParent();
        invariant(
          focusCellParent != null,
          'Expected focusCellParent to have a parent',
        );
        this.set(this.tableKey, focusCell.getKey(), focusCellParent.getKey());
      }
      return this.getNodes();
    }

    // TODO Mapping the whole Grid every time not efficient. We need to compute the entire state only
    // once (on load) and iterate on it as updates occur. However, to do this we need to have the
    // ability to store a state. Killing TableSelection and moving the logic to the plugin would make
    // this possible.
    const [map, cellAMap, cellBMap] = $computeTableMap(
      tableNode,
      anchorCell,
      focusCell,
    );
    const {minColumn, maxColumn, minRow, maxRow} =
      $computeTableCellRectBoundary(map, cellAMap, cellBMap);

    // We use a Map here because merged cells in the grid would otherwise
    // show up multiple times in the nodes array
    const nodeMap: Map<NodeKey, LexicalNode> = new Map([
      [tableNode.getKey(), tableNode],
    ]);
    let lastRow: null | TableRowNode = null;
    // A row the selection spans with no cell of its own in it (only cells
    // spanning from above, or holes in a ragged table) belongs to it when a
    // later row has a cell of its own or a hole there, so that a copy keeps
    // the later rows in place. Trailing rows covered only by spans are left
    // out, as before.
    let lastRowNeeded = minRow - 1;
    for (let i = minRow; i <= maxRow; i++) {
      for (let j = minColumn; j <= maxColumn; j++) {
        const value = map[i][j];
        if (value === undefined || value.startRow === i) {
          lastRowNeeded = i;
          break;
        }
      }
    }
    const rowNodes = tableNode.getChildren();
    for (let i = minRow; i <= maxRow; i++) {
      const rowNode = rowNodes[i];
      if (i <= lastRowNeeded && $isTableRowNode(rowNode)) {
        nodeMap.set(rowNode.getKey(), rowNode);
        lastRow = rowNode;
      }
      for (let j = minColumn; j <= maxColumn; j++) {
        const value = map[i][j];
        if (value === undefined) {
          // A ragged table (rows of different lengths, e.g. after concurrent
          // row and column inserts) has no cell here.
          continue;
        }
        const {cell} = value;
        const currentRow = cell.getParent();
        invariant(
          $isTableRowNode(currentRow),
          'Expected TableCellNode parent to be a TableRowNode',
        );
        if (currentRow !== lastRow) {
          nodeMap.set(currentRow.getKey(), currentRow);
          lastRow = currentRow;
        }
        if (!nodeMap.has(cell.getKey())) {
          $visitRecursively(cell, childNode => {
            nodeMap.set(childNode.getKey(), childNode);
          });
        }
      }
    }
    const nodes = Array.from(nodeMap.values());

    if (!isCurrentlyReadOnlyMode()) {
      this._cachedNodes = nodes;
    }
    return nodes;
  }

  getTextContent(): string {
    const allNodes = this.getNodes();
    const isCellOfTable = (node: LexicalNode): node is TableCellNode => {
      if (!$isTableCellNode(node)) {
        return false;
      }
      const row = node.getParent();
      return $isTableRowNode(row) && row.__parent === this.tableKey;
    };
    const nodes = allNodes.filter(isCellOfTable);
    // The rows of the table that hold no selected cell of their own (rows a
    // ragged table or a row span leaves empty within the selection) are
    // blank lines, so that the lines keep their rows.
    const rowsWithCells = new Set(nodes.map(node => node.__parent));
    let textContent = '';
    let cellIndex = 0;
    for (const node of allNodes) {
      if (isCellOfTable(node)) {
        const row = node.__parent;
        const nextRow = (nodes[cellIndex + 1] || {}).__parent;
        textContent += node.getTextContent() + (nextRow !== row ? '\n' : '\t');
        cellIndex++;
      } else if (
        $isTableRowNode(node) &&
        node.__parent === this.tableKey &&
        !rowsWithCells.has(node.__key)
      ) {
        textContent += '\n';
      }
    }
    return textContent;
  }
}

/** Type guard for {@link TableSelection}. */
export function $isTableSelection(x: unknown): x is TableSelection {
  return x instanceof TableSelection;
}

/** @deprecated Use {@link $createTableSelectionFrom} instead. */
export function $createTableSelection(): TableSelection {
  const anchor = $createPoint('root', 0, 'element');
  const focus = $createPoint('root', 0, 'element');
  return new TableSelection('root', anchor, focus);
}

/**
 * Creates a {@link TableSelection} spanning from `anchorCell` to `focusCell`
 * within `tableNode`. In `__DEV__` mode, validates that both cells belong to
 * the given table and that the table is attached to the editor state.
 *
 * If the current selection is already a TableSelection, it clones and
 * re-targets it (preserving identity for dirty-checking); otherwise it
 * constructs a fresh one.
 */
export function $createTableSelectionFrom(
  tableNode: TableNode,
  anchorCell: TableCellNode,
  focusCell: TableCellNode,
): TableSelection {
  const tableNodeKey = tableNode.getKey();
  const anchorCellKey = anchorCell.getKey();
  const focusCellKey = focusCell.getKey();
  if (__DEV__) {
    invariant(
      tableNode.isAttached(),
      '$createTableSelectionFrom: tableNode %s is not attached',
      tableNodeKey,
    );
    invariant(
      tableNode.is($findTableNode(anchorCell)),
      '$createTableSelectionFrom: anchorCell %s is not in table %s',
      anchorCellKey,
      tableNodeKey,
    );
    invariant(
      tableNode.is($findTableNode(focusCell)),
      '$createTableSelectionFrom: focusCell %s is not in table %s',
      focusCellKey,
      tableNodeKey,
    );
    // TODO: Check for rectangular grid
  }
  const prevSelection = $getSelection();
  const nextSelection = $isTableSelection(prevSelection)
    ? prevSelection.clone()
    : new TableSelection(
        'root',
        $createPoint('root', 0, 'element'),
        $createPoint('root', 0, 'element'),
      );
  nextSelection.set(
    tableNode.getKey(),
    anchorCell.getKey(),
    focusCell.getKey(),
  );
  return nextSelection;
}

/**
 * Depth first visitor
 * @param node The starting node
 * @param $visit The function to call for each node. If the function returns false, then children of this node will not be explored
 */
export function $visitRecursively(
  node: LexicalNode,
  $visit: (childNode: LexicalNode) => boolean | undefined | void,
): void {
  const stack = [[node]];
  for (
    let currentArray = stack.at(-1);
    currentArray !== undefined && stack.length > 0;
    currentArray = stack.at(-1)
  ) {
    const currentNode = currentArray.pop();
    if (currentNode === undefined) {
      stack.pop();
    } else if ($visit(currentNode) !== false && $isElementNode(currentNode)) {
      stack.push(currentNode.getChildren());
    }
  }
}
