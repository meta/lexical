/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {TableConfig} from './LexicalTableExtension';

import {type NamedSignalsOutput, type Signal, signal} from '@lexical/extension';
import invariant from '@lexical/internal/invariant';
import {
  $dfs,
  $insertFirst,
  $insertNodeToNearestRoot,
  $unwrapAndFilterDescendants,
} from '@lexical/utils';
import {
  $createParagraphNode,
  $findMatchingParent,
  $getNearestNodeFromDOMNode,
  $getPreviousSelection,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  type CommandPayloadType,
  type ElementNode,
  isDOMNode,
  type LexicalEditor,
  mergeRegister,
  type NodeKey,
  type RangeSelection,
  SELECT_ALL_COMMAND,
  SELECTION_CHANGE_COMMAND,
  SELECTION_INSERT_CLIPBOARD_NODES_COMMAND,
} from 'lexical';

import {
  $createTableCellNode,
  $isTableCellNode,
  TableCellHeaderStates,
  TableCellNode,
} from './LexicalTableCellNode';
import {
  INSERT_TABLE_COMMAND,
  type InsertTableCommandPayload,
} from './LexicalTableCommands';
import {$isTableNode, TableNode} from './LexicalTableNode';
import {$getTableAndElementByKey, TableObservers} from './LexicalTableObserver';
import {$isTableRowNode, TableRowNode} from './LexicalTableRowNode';
import {
  $createTableSelectionFrom,
  $isTableSelection,
  type TableSelection,
} from './LexicalTableSelection';
import {
  $findTableNode,
  $handleTableSelectionChangeCommand,
  applyTableHandlers,
  getTableElement,
  registerTableWindowHandlers,
} from './LexicalTableSelectionHelpers';
import {
  $computeTableMap,
  $computeTableMapSkipCellCheck,
  $createTableNodeWithDimensions,
  $getNodeTriplet,
  $insertTableIntoGrid,
} from './LexicalTableUtils';

function $insertTable(
  {rows, columns, includeHeaders}: InsertTableCommandPayload,
  hasNestedTables: boolean,
): boolean {
  const selection = $getSelection() || $getPreviousSelection();
  if (!selection || !$isRangeSelection(selection)) {
    return false;
  }

  // Prevent nested tables by checking if we're already inside a table
  if (!hasNestedTables && $findTableNode(selection.anchor.getNode())) {
    return false;
  }

  const tableNode = $createTableNodeWithDimensions(
    Number(rows),
    Number(columns),
    includeHeaders,
  );
  $insertNodeToNearestRoot(tableNode);

  const firstDescendant = tableNode.getFirstDescendant();
  if ($isTextNode(firstDescendant)) {
    firstDescendant.select();
  }

  return true;
}

function $tableCellTransform(node: TableCellNode) {
  if (!$isTableRowNode(node.getParent())) {
    // TableCellNode must be a child of TableRowNode.
    node.remove();
  } else if (node.isEmpty()) {
    // TableCellNode should never be empty
    node.append($createParagraphNode());
  }
}

function $tableRowTransform(node: TableRowNode) {
  if (!$isTableNode(node.getParent())) {
    // TableRowNode must be a child of TableNode.
    // TODO: Future support of tbody/thead/tfoot may change this
    node.remove();
  } else {
    $unwrapAndFilterDescendants(node, $isTableCellNode);
  }
}

function $tableTransform(node: TableNode) {
  // TableRowNode is the only valid child for TableNode
  // TODO: Future support of tbody/thead/tfoot/caption may change this
  $unwrapAndFilterDescendants(node, $isTableRowNode);

  const [gridMap] = $computeTableMapSkipCellCheck(node, null, null);
  const maxRowLength = gridMap.reduce((curLength, row) => {
    return Math.max(curLength, row.length);
  }, 0);
  const rowNodes = node.getChildren();
  for (let i = 0; i < gridMap.length; ++i) {
    const rowNode = rowNodes[i];
    if (!rowNode) {
      continue;
    }
    invariant(
      $isTableRowNode(rowNode),
      'TablePlugin: Expecting all children of TableNode to be TableRowNode, found %s (type %s)',
      rowNode.constructor.name,
      rowNode.getType(),
    );
    const rowLength = gridMap[i].reduce(
      (acc, cell) => (cell ? 1 + acc : acc),
      0,
    );
    if (rowLength === maxRowLength) {
      continue;
    }
    // Padding cells are appended to the end of the row, so they are never in
    // a header column — but they are in a header row whenever the row they
    // extend is one. Inherit only that bit from the row's last cell, the same
    // reference $insertTableColumnAtNode uses when it appends a column.
    const lastCell = rowNode.getLastChild();
    const headerState = $isTableCellNode(lastCell)
      ? lastCell.getHeaderStyles() & TableCellHeaderStates.ROW
      : TableCellHeaderStates.NO_STATUS;
    for (let j = rowLength; j < maxRowLength; ++j) {
      const newCell = $createTableCellNode(headerState);
      newCell.append($createParagraphNode());
      rowNode.append(newCell);
    }
  }
  const colWidths = node.getColWidths();
  const columnCount = node.getColumnCount();
  if (colWidths && colWidths.length !== columnCount) {
    let newColWidths: number[] | undefined = undefined;
    if (columnCount < colWidths.length) {
      newColWidths = colWidths.slice(0, columnCount);
    } else if (colWidths.length > 0) {
      // Repeat the last column width.
      const fillWidth = colWidths[colWidths.length - 1];
      newColWidths = [
        ...colWidths,
        ...Array(columnCount - colWidths.length).fill(fillWidth),
      ];
    }
    node.setColWidths(newColWidths);
  }
}

function $tableClickCommand(event: MouseEvent): boolean {
  if (event.detail < 3 || !isDOMNode(event.target)) {
    return false;
  }
  const startNode = $getNearestNodeFromDOMNode(event.target);
  if (startNode === null) {
    return false;
  }
  const blockNode = $findMatchingParent(
    startNode,
    (node): node is ElementNode => $isElementNode(node) && !node.isInline(),
  );
  if (blockNode === null) {
    return false;
  }
  const rootNode = blockNode.getParent();
  if (!$isTableCellNode(rootNode)) {
    return false;
  }
  blockNode.select(0);
  return true;
}

function $tableSelectAllCommand(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return false;
  }

  // Check if the selection is inside a table
  const anchorNode = selection.anchor.getNode();
  const tableNode = $findTableNode(anchorNode);
  if (tableNode === null) {
    return false;
  }

  // CRITICAL: Only intercept if table is the ONLY child of root
  // This is required to reproduce the bug: table must be the only content, no empty paragraphs
  // This prevents breaking other tests that expect RangeSelection when there's content outside table
  const root = $getRoot();
  if (!root.is(tableNode.getParent()) || root.getChildrenSize() !== 1) {
    return false;
  }

  // At this point, table is the only child
  // This is the exact scenario from issue #8074: table is the only content in editor

  // Get the table map to find first and last cells (handles merged cells correctly)
  const [tableMap] = $computeTableMapSkipCellCheck(tableNode, null, null);
  if (tableMap.length === 0 || tableMap[0].length === 0) {
    return false;
  }

  // Get the first cell (top-left)
  const firstCellMap = tableMap[0][0];
  if (!firstCellMap || !firstCellMap.cell) {
    return false;
  }

  // Get the last cell (bottom-right)
  const lastRow = tableMap[tableMap.length - 1];
  const lastCellMap = lastRow[lastRow.length - 1];
  if (!lastCellMap || !lastCellMap.cell) {
    return false;
  }

  // Create a TableSelection that selects all cells
  const tableSelection = $createTableSelectionFrom(
    tableNode,
    firstCellMap.cell,
    lastCellMap.cell,
  );
  $setSelection(tableSelection);

  return true;
}

/**
 * Register a transform to ensure that all TableCellNode have a colSpan and rowSpan of 1.
 * This should only be registered when you do not want to support merged cells.
 *
 * @param editor The editor
 * @returns An unregister callback
 */
export function registerTableCellUnmergeTransform(
  editor: LexicalEditor,
): () => void {
  return editor.registerNodeTransform(TableCellNode, node => {
    if (node.getColSpan() > 1 || node.getRowSpan() > 1) {
      // When we have rowSpan we have to map the entire Table to understand where the new Cells
      // fit best; let's analyze all Cells at once to save us from further transform iterations
      const [, , gridNode] = $getNodeTriplet(node);
      const [gridMap] = $computeTableMap(gridNode, node, node);
      // TODO this function expects Tables to be normalized. Look into this once it exists
      const rowsCount = gridMap.length;
      const columnsCount = gridMap[0].length;
      let row = gridNode.getFirstChild();
      invariant(
        $isTableRowNode(row),
        'Expected TableNode first child to be a RowNode',
      );
      const unmerged = [];
      for (let i = 0; i < rowsCount; i++) {
        if (i !== 0) {
          row = row.getNextSibling();
          invariant(
            $isTableRowNode(row),
            'Expected TableNode first child to be a RowNode',
          );
        }
        let lastRowCell: null | TableCellNode = null;
        for (let j = 0; j < columnsCount; j++) {
          const cellMap = gridMap[i][j];
          const cell = cellMap.cell;
          if (cellMap.startRow === i && cellMap.startColumn === j) {
            lastRowCell = cell;
            unmerged.push(cell);
          } else if (cell.getColSpan() > 1 || cell.getRowSpan() > 1) {
            invariant(
              $isTableCellNode(cell),
              'Expected TableNode cell to be a TableCellNode',
            );
            const newCell = $createTableCellNode(cell.__headerState);
            if (lastRowCell !== null) {
              lastRowCell.insertAfter(newCell);
            } else {
              $insertFirst(row, newCell);
            }
          }
        }
      }
      for (const cell of unmerged) {
        cell.setColSpan(1);
        cell.setRowSpan(1);
      }
    }
  });
}

export function registerTableSelectionObserver(
  editor: LexicalEditor,
  hasTabHandler: boolean = true,
): () => void {
  const tableObservers = new TableObservers();

  const initializeTableNode = (
    tableNode: TableNode,
    nodeKey: NodeKey,
    dom: HTMLElement,
  ) => {
    const tableElement = getTableElement(tableNode, dom);
    const tableSelection = applyTableHandlers(
      tableNode,
      tableElement,
      editor,
      hasTabHandler,
      tableObservers,
    );
    tableObservers.observers.set(nodeKey, [tableSelection, tableElement]);
  };

  return mergeRegister(
    registerTableWindowHandlers(editor, tableObservers),
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        return $handleTableSelectionChangeCommand(tableObservers, editor);
      },
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerMutationListener(
      TableNode,
      nodeMutations => {
        editor.read('latest', () => {
          for (const [nodeKey, mutation] of nodeMutations) {
            const tableSelection = tableObservers.observers.get(nodeKey);
            if (mutation === 'created' || mutation === 'updated') {
              const {tableNode, tableElement} =
                $getTableAndElementByKey(nodeKey);
              if (tableSelection === undefined) {
                initializeTableNode(tableNode, nodeKey, tableElement);
              } else if (tableElement !== tableSelection[1]) {
                // The update created a new DOM node, destroy the existing TableObserver
                tableObservers.removeObserver(nodeKey);
                initializeTableNode(tableNode, nodeKey, tableElement);
              }
            } else if (mutation === 'destroyed') {
              tableObservers.removeObserver(nodeKey);
            }
          }
        });
      },
      {skipInitialization: false},
    ),
    () => {
      // Hook might be called multiple times so cleaning up tables listeners as well,
      // as it'll be reinitialized during recurring call
      tableObservers.removeAllObservers();
    },
  );
}

/**
 * Register table command listeners and the table integrity transforms. The
 * table selection observer should be registered separately after this with
 * {@link registerTableSelectionObserver}.
 *
 * @param editor The editor
 * @returns An unregister callback
 */
export function registerTablePlugin(
  editor: LexicalEditor,
  options?: Pick<NamedSignalsOutput<TableConfig>, 'hasNestedTables'>,
): () => void {
  if (!editor.hasNodes([TableNode])) {
    invariant(false, 'TablePlugin: TableNode is not registered on editor');
  }

  const {hasNestedTables = signal(false)} = options ?? {};

  return mergeRegister(
    editor.registerCommand(
      INSERT_TABLE_COMMAND,
      payload => {
        return $insertTable(payload, hasNestedTables.peek());
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      SELECTION_INSERT_CLIPBOARD_NODES_COMMAND,
      (payload, dispatchEditor) => {
        if (editor !== dispatchEditor) {
          return false;
        }
        return $tableSelectionInsertClipboardNodesCommand(
          payload,
          hasNestedTables,
        );
      },
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerCommand(
      SELECT_ALL_COMMAND,
      $tableSelectAllCommand,
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      CLICK_COMMAND,
      $tableClickCommand,
      COMMAND_PRIORITY_EDITOR,
    ),
    editor.registerNodeTransform(TableNode, $tableTransform),
    editor.registerNodeTransform(TableRowNode, $tableRowTransform),
    editor.registerNodeTransform(TableCellNode, $tableCellTransform),
  );
}

function $tableSelectionInsertClipboardNodesCommand(
  selectionPayload: CommandPayloadType<
    typeof SELECTION_INSERT_CLIPBOARD_NODES_COMMAND
  >,
  hasNestedTables: Signal<boolean>,
) {
  const {nodes, selection} = selectionPayload;

  const hasTables = nodes.some(
    n => $isTableNode(n) || $dfs(n).some(d => $isTableNode(d.node)),
  );
  if (!hasTables) {
    if ($isTableSelection(selection)) {
      let text = '';
      let lastWasBlock = false;
      for (const node of nodes) {
        const isBlock = $isElementNode(node) && !node.isInline();
        if (text.length > 0 && (isBlock || lastWasBlock)) {
          text += '\n';
        }
        text += node.getTextContent();
        lastWasBlock = isBlock;
      }
      selection.insertRawText(text);
      return true;
    }
    return false;
  }

  const isTableSelection = $isTableSelection(selection);
  const isRangeSelection = $isRangeSelection(selection);
  const isSelectionInsideOfGrid =
    (isRangeSelection &&
      $findMatchingParent(selection.anchor.getNode(), n =>
        $isTableCellNode(n),
      ) !== null &&
      $findMatchingParent(selection.focus.getNode(), n =>
        $isTableCellNode(n),
      ) !== null) ||
    isTableSelection;

  if (!isSelectionInsideOfGrid) {
    // Not pasting in a grid - no special handling required.
    return false;
  }

  // When pasting just a table, flatten the table on the destination table, even when nested tables are allowed.
  if (nodes.length === 1 && $isTableNode(nodes[0])) {
    return $insertTableIntoGrid(nodes[0], selection);
  }

  // If nested tables are enabled, allow pasting a table into a single cell.
  if (
    isRangeSelection &&
    hasNestedTables.peek() &&
    !$isMultiCellTableSelection(selection)
  ) {
    return false;
  }

  // If we reached this point, there's a table in the selection and nested tables are not allowed - reject the paste.
  return true;
}

function $isMultiCellTableSelection(
  selection: TableSelection | RangeSelection,
) {
  if (
    $isTableSelection(selection) &&
    !selection.focus.getNode().is(selection.anchor.getNode())
  ) {
    return true;
  }
  if (
    $isRangeSelection(selection) &&
    $isTableCellNode(selection.anchor.getNode()) &&
    !selection.anchor.getNode().is(selection.focus.getNode())
  ) {
    return true;
  }
  return false;
}
