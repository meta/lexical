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
  $getEditor,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getPreviousSelection,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $normalizeSelection__EXPERIMENTAL,
  $setSelection,
  CLICK_COMMAND,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  type CommandPayloadType,
  type EditorState,
  type ElementNode,
  HISTORIC_TAG,
  HISTORY_MERGE_TAG,
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
  $syncTableSelectionObservers,
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
  $padTableRows,
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

/**
 * Per update (its pending editor state), by table, the rows that lost cells
 * in the update (see $tableRowTransform): what the table's transform pads
 * when the update did not change the table's rows (see $tableTransform).
 */
const rowsLost = new WeakMap<EditorState, Map<NodeKey, Set<NodeKey>>>();

/** The rows of `table` that lost cells in the running update, if any. */
function $rowsLost(table: TableNode): Set<NodeKey> | undefined {
  const pending = $getEditor()._pendingEditorState;
  const tables = pending === null ? undefined : rowsLost.get(pending);
  return tables === undefined ? undefined : tables.get(table.getKey());
}

function $tableCellTransform(node: TableCellNode) {
  const row = node.getParent();
  if (!$isTableRowNode(row)) {
    // TableCellNode must be a child of TableRowNode.
    node.remove();
    return;
  }
  if (node.isEmpty()) {
    // TableCellNode should never be empty
    node.append($createParagraphNode());
  }
  // A cell changed (its span raised) after rows of its table lost cells in
  // this update: the table's width may have changed, so the table's
  // transform pads those rows again.
  const table = row.getParent();
  if ($isTableNode(table) && $rowsLost(table) !== undefined) {
    table.markDirty();
  }
}

function $tableRowTransform(node: TableRowNode) {
  const table = node.getParent();
  if (!$isTableNode(table)) {
    // TableRowNode must be a child of TableNode.
    // TODO: Future support of tbody/thead/tfoot may change this
    node.remove();
  } else {
    $unwrapAndFilterDescendants(node, $isTableCellNode);
    // A row that lost cells (a delete across cells removes some) can be
    // shorter than the table. The table's transform pads it, and Lexical
    // runs that only on a table marked dirty itself, which a change to one
    // of its rows does not do. A row that gained cells (a column insert, an
    // app's own padding of its rows, which may count cells where the table
    // counts grid positions) is left as its author made it: padding it to
    // the table's width had two clients that each pad the rows they created
    // pad each other's rows again without end. A row that changed after
    // rows lost cells in this update (it grew) marks the table again, so
    // those rows are padded to the width the table has now.
    const editor = $getEditor();
    const pending = editor._pendingEditorState;
    const previous = editor._editorState._nodeMap.get(node.getKey());
    if (
      pending !== null &&
      $isTableRowNode(previous) &&
      node.getChildrenSize() < previous.__size
    ) {
      let tables = rowsLost.get(pending);
      if (tables === undefined) {
        tables = new Map();
        rowsLost.set(pending, tables);
      }
      let rows = tables.get(table.getKey());
      if (rows === undefined) {
        rows = new Set();
        tables.set(table.getKey(), rows);
      }
      rows.add(node.getKey());
      table.markDirty();
    } else if ($rowsLost(table) !== undefined) {
      table.markDirty();
    }
  }
}

/**
 * Whether the running update left the rows of `table` as they were (the
 * same rows in the same order, in a table that was there before it).
 */
function $sameRows(table: TableNode): boolean {
  const before = $getEditor()._editorState._nodeMap;
  const previous = before.get(table.getKey());
  if (!$isTableNode(previous)) {
    return false;
  }
  const keys = table.getChildrenKeys();
  let key = previous.__first;
  for (const current of keys) {
    if (key !== current) {
      return false;
    }
    const row = before.get(key);
    key = row === undefined ? null : row.__next;
  }
  return key === null;
}

function $tableTransform(node: TableNode) {
  // TableRowNode is the only valid child for TableNode
  // TODO: Future support of tbody/thead/tfoot/caption may change this
  $unwrapAndFilterDescendants(node, $isTableRowNode);

  // A new table, or one whose rows the update changed (a row added,
  // removed or moved), gets all its rows padded. One whose rows are the ones
  // it had gets the rows that lost cells padded, and no other, also when
  // the update changed only the table itself (its striping): the other
  // short rows (a table ragged by collaborators' concurrent row and column
  // inserts) are their authors' to pad, and a client padding them at the
  // same time as their authors duplicates cells, which makes the other rows
  // short in turn.
  const rows = $rowsLost(node);
  if (!$sameRows(node)) {
    $padTableRows(node);
  } else if (rows !== undefined) {
    $padTableRows(node, row => rows.has(row.getKey()));
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

/**
 * Returns true if the rows of `tableNode` do not all cover the same number of
 * grid columns (spans included), i.e. if $padTableRows would add cells.
 *
 * Most tables are plain rectangles with no spans, so that case is answered
 * from the row sizes alone; the table map is only computed when a span makes
 * the row sizes ambiguous.
 */
function $isTableRagged(tableNode: TableNode): boolean {
  let width: number | null = null;
  let hasSpans = false;
  for (const row of tableNode.getChildren()) {
    if (!$isTableRowNode(row)) {
      continue;
    }
    let rowWidth = 0;
    for (const cell of row.getChildren()) {
      if ($isTableCellNode(cell)) {
        if (cell.getColSpan() > 1 || cell.getRowSpan() > 1) {
          hasSpans = true;
          break;
        }
        rowWidth++;
      }
    }
    if (hasSpans) {
      break;
    }
    if (width === null) {
      width = rowWidth;
    } else if (width !== rowWidth) {
      return true;
    }
  }
  if (!hasSpans) {
    return false;
  }
  const [gridMap] = $computeTableMapSkipCellCheck(tableNode, null, null);
  const maxRowLength = gridMap.reduce(
    (curLength, row) => Math.max(curLength, row.length),
    0,
  );
  return gridMap.some(
    row => row.reduce((acc, cell) => (cell ? 1 + acc : acc), 0) < maxRowLength,
  );
}

/**
 * Pads tables that a committed update left ragged (issue #9453).
 *
 * The TableNode transform already pads every table that an update marks
 * dirty, and that covers JSON loaded through setEditorState, since a parsed
 * editor state marks all of its nodes dirty. What it cannot cover is an update
 * that skipped transforms, so this listener catches those after the fact.
 *
 * Two kinds of update are deliberately left alone:
 *
 * - Collaboration updates. Every peer receives the same remote change, so if
 *   each one padded it, the CRDT would keep all of the appended cells and the
 *   row would end up wider than the rest. Those tables stay ragged in the
 *   model until a local edit or table command pads them (as in issue #9375), and
 *   TableNode.exportDOM pads its output in the meantime.
 * - Undo and redo, so that padding never rewrites the history being replayed.
 *
 * The padding itself is tagged HISTORY_MERGE_TAG so it never becomes an undo
 * step of its own.
 */
function registerRaggedTableNormalization(editor: LexicalEditor): () => void {
  return editor.registerUpdateListener(({dirtyElements, editorState, tags}) => {
    if (
      dirtyElements.size === 0 ||
      tags.has(COLLABORATION_TAG) ||
      tags.has(HISTORIC_TAG)
    ) {
      return;
    }
    const raggedKeys = editorState.read(() => {
      const keys: NodeKey[] = [];
      for (const key of dirtyElements.keys()) {
        const node = $getNodeByKey(key);
        if ($isTableNode(node) && $isTableRagged(node)) {
          keys.push(key);
        }
      }
      return keys;
    });
    if (raggedKeys.length === 0) {
      return;
    }
    editor.update(
      () => {
        for (const key of raggedKeys) {
          const node = $getNodeByKey(key);
          if ($isTableNode(node)) {
            $padTableRows(node);
          }
        }
      },
      {tag: HISTORY_MERGE_TAG},
    );
  });
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
  // Select the block with the text points a native selection of it resolves
  // to. Outside Apple platforms, WebKit fires no selectionchange when element
  // points cover the same text as the DOM selection (as after a double click
  // on a one-word block), so nothing would replace them in the DOM.
  $normalizeSelection__EXPERIMENTAL(blockNode.select(0));
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
  let selectionNeedsSync = false;

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
    // Register once so attaching/replacing a root cannot reorder HIGH listeners.
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        if (editor.getRootElement() === null) {
          return false;
        }
        selectionNeedsSync = true;
        return $handleTableSelectionChangeCommand(tableObservers, editor);
      },
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerUpdateListener(({dirtyElements}) => {
      if (!selectionNeedsSync) {
        // Cell/row changes dirty their table ancestor without necessarily
        // mutating the TableNode itself or changing the selection. Replaced
        // cell DOM still needs its selection highlight restored.
        for (const key of dirtyElements.keys()) {
          if (tableObservers.observers.has(key)) {
            selectionNeedsSync = true;
            break;
          }
        }
      }
      if (selectionNeedsSync) {
        // Mutation listeners have initialized new observers. Synchronize once,
        // even if normalization notified several times before this commit.
        selectionNeedsSync = false;
        if (editor.getRootElement() !== null) {
          editor.read('latest', () => {
            $syncTableSelectionObservers(tableObservers, editor);
          });
        }
      }
    }),
    editor.registerMutationListener(
      TableNode,
      nodeMutations => {
        selectionNeedsSync = true;
        editor.read('latest', () => {
          for (const [nodeKey, mutation] of nodeMutations) {
            const tableSelection = tableObservers.observers.get(nodeKey);
            if (mutation === 'created' || mutation === 'updated') {
              if (editor.getElementByKey(nodeKey) === null) {
                // The table is not rendered, as when the editor has no root
                // element yet. The reconciler reports it as created when it
                // renders it, and the observer attaches then.
                tableObservers.removeObserver(nodeKey);
                continue;
              }
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
    registerRaggedTableNormalization(editor),
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
