/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {
  $copyNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getEditor,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isParagraphNode,
  $isRootNode,
  $setSelection,
  addClassNamesToElement,
  getDOMSelection,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
  type NodeKey,
  removeClassNamesFromElement,
  SELECTION_CHANGE_COMMAND,
  type TextFormatType,
} from 'lexical';

import {$isTableCellNode, type TableCellNode} from './LexicalTableCellNode';
import {$isTableNode, type TableNode} from './LexicalTableNode';
import {$isTableRowNode} from './LexicalTableRowNode';
import {
  $createTableSelectionFrom,
  $isTableSelection,
  type TableSelection,
} from './LexicalTableSelection';
import {
  $getNearestTableCellInTableFromDOMNode,
  $updateDOMForSelection,
  getTable,
  getTableElement,
  type HTMLTableElementWithWithTableSelectionState,
} from './LexicalTableSelectionHelpers';

export type TableDOMCell = {
  elem: HTMLElement;
  highlighted: boolean;
  hasBackgroundColor: boolean;
  x: number;
  y: number;
};

export type TableDOMRows = ((TableDOMCell | undefined)[] | undefined)[];

export type TableDOMTable = {
  domRows: TableDOMRows;
  columns: number;
  rows: number;
};

export function $getTableAndElementByKey(
  tableNodeKey: NodeKey,
  editor: LexicalEditor = $getEditor(),
): {
  tableNode: TableNode;
  tableElement: HTMLTableElementWithWithTableSelectionState;
} {
  const tableNode = $getNodeByKey(tableNodeKey);
  invariant(
    $isTableNode(tableNode),
    'TableObserver: Expected tableNodeKey %s to be a TableNode',
    tableNodeKey,
  );
  const tableElement = getTableElement(
    tableNode,
    editor.getElementByKey(tableNodeKey),
  );
  invariant(
    tableElement !== null,
    'TableObserver: Expected to find TableElement in DOM for key %s',
    tableNodeKey,
  );
  return {tableElement, tableNode};
}

export type TableNextFocus = {
  tableKey: NodeKey;
  focusCell: TableDOMCell;
  override: boolean;
};

/**
 * Tracks table selection state that sits across all tables.
 */
export class TableObservers {
  observers: Map<
    NodeKey,
    [TableObserver, HTMLTableElementWithWithTableSelectionState]
  >;
  nextFocus: TableNextFocus | null;
  shouldCheckSelectionForTable: NodeKey | null;

  constructor() {
    this.observers = new Map<
      NodeKey,
      [TableObserver, HTMLTableElementWithWithTableSelectionState]
    >();
    this.nextFocus = null;
    this.shouldCheckSelectionForTable = null;
  }

  /**
   * @internal
   * When handling mousemove events we track what the focus cell should be, but
   * the DOM selection may end up somewhere else entirely. We don't have an elegant
   * way to handle this after the DOM selection has been resolved in a
   * SELECTION_CHANGE_COMMAND callback.
   */
  setNextFocus(nextFocus: TableNextFocus | null): void {
    this.nextFocus = nextFocus;
  }

  /** @internal */
  getAndClearNextFocus(): TableNextFocus | null {
    const {nextFocus} = this;
    if (nextFocus !== null) {
      this.nextFocus = null;
    }
    return nextFocus;
  }

  /**
   * @internal
   * Firefox has a strange behavior where pressing the down arrow key from
   * above the table will move the caret after the table and then lexical
   * will select the last cell instead of the first.
   * We do still want to let the browser handle caret movement but we will
   * use this property to "tag" the update so that we can recheck the
   * selection after the event is processed.
   */
  setShouldCheckSelectionForTable(tableKey: NodeKey): void {
    this.shouldCheckSelectionForTable = tableKey;
  }
  /**
   * @internal
   */
  getAndClearShouldCheckSelectionForTable(): NodeKey | null {
    const {shouldCheckSelectionForTable} = this;
    if (shouldCheckSelectionForTable) {
      this.shouldCheckSelectionForTable = null;
      return shouldCheckSelectionForTable;
    }
    return null;
  }

  /**
   * @internal
   * Remove the observer for tableKey from the registry and unregister all
   * of its listeners, e.g. because the table was removed from the document
   * or its DOM was recreated.
   *
   * @returns true if an observer was registered for tableKey
   */
  removeObserver(tableKey: NodeKey): boolean {
    const observerAndElement = this.observers.get(tableKey);
    if (observerAndElement === undefined) {
      return false;
    }
    observerAndElement[0].removeListeners();
    this.observers.delete(tableKey);
    return true;
  }

  /**
   * @internal
   * Remove all observers from the registry and unregister their listeners,
   * e.g. because the table selection observer is being unregistered.
   */
  removeAllObservers(): void {
    for (const tableKey of Array.from(this.observers.keys())) {
      this.removeObserver(tableKey);
    }
  }

  /**
   * @internal
   * Get a snapshot of the registry as [TableNode, TableObserver] pairs for
   * the current editor state. A table's destroyed mutation can be missed
   * entirely (e.g. when it is removed during an update while the editor's
   * root element is detached), so any entry whose table no longer exists
   * is removed from the registry instead of being returned, otherwise such
   * an entry would poison the registry and break every subsequent
   * selection change.
   *
   * Must be called within an editor read or update.
   */
  $getTableNodesAndObservers(): [TableNode, TableObserver][] {
    const tableNodesAndObservers: [TableNode, TableObserver][] = [];
    for (const [tableKey, [tableObserver]] of Array.from(
      this.observers.entries(),
    )) {
      const tableNode = $getNodeByKey(tableKey);
      if ($isTableNode(tableNode)) {
        tableNodesAndObservers.push([tableNode, tableObserver]);
      } else {
        this.removeObserver(tableKey);
      }
    }
    return tableNodesAndObservers;
  }
}

export class TableObserver {
  focusX: number;
  focusY: number;
  listenersToRemove: Set<() => void>;
  table: TableDOMTable;
  isHighlightingCells: boolean;
  anchorX: number;
  anchorY: number;
  tableNodeKey: NodeKey;
  anchorCell: TableDOMCell | null;
  focusCell: TableDOMCell | null;
  anchorCellNodeKey: NodeKey | null;
  focusCellNodeKey: NodeKey | null;
  editor: LexicalEditor;
  tableSelection: TableSelection | null;
  hasHijackedSelectionStyles: boolean;
  isSelecting: boolean;
  /**
   * Whether the pointer gesture currently in progress has travelled beyond
   * the tap slop box, i.e. it is a drag rather than a tap. Only a drag may
   * start a table selection from touch input. Set by the pointermove handler
   * and reset whenever the gesture ends.
   */
  isPointerDrag: boolean;
  /**
   * The cell the pointer gesture currently in progress started on, null when
   * no gesture is in progress. A drag that never leaves this cell is
   * selecting text within it, not selecting cells.
   */
  pointerStartCell: TableDOMCell | null;
  pointerType: string | null;
  abortController: AbortController;
  listenerOptions: {signal: AbortSignal};

  constructor(editor: LexicalEditor, tableNodeKey: string) {
    this.isHighlightingCells = false;
    this.anchorX = -1;
    this.anchorY = -1;
    this.focusX = -1;
    this.focusY = -1;
    this.listenersToRemove = new Set();
    this.tableNodeKey = tableNodeKey;
    this.editor = editor;
    this.table = {
      columns: 0,
      domRows: [],
      rows: 0,
    };
    this.tableSelection = null;
    this.anchorCellNodeKey = null;
    this.focusCellNodeKey = null;
    this.anchorCell = null;
    this.focusCell = null;
    this.hasHijackedSelectionStyles = false;
    this.isSelecting = false;
    this.isPointerDrag = false;
    this.pointerStartCell = null;
    this.pointerType = null;
    this.abortController = new AbortController();
    this.listenerOptions = {signal: this.abortController.signal};
    this.trackTable();
  }

  getTable(): TableDOMTable {
    return this.table;
  }

  removeListeners() {
    this.abortController.abort('removeListeners');
    Array.from(this.listenersToRemove).forEach(removeListener =>
      removeListener(),
    );
    this.listenersToRemove.clear();
  }

  $lookup(): {
    tableNode: TableNode;
    tableElement: HTMLTableElementWithWithTableSelectionState;
  } {
    return $getTableAndElementByKey(this.tableNodeKey, this.editor);
  }

  trackTable() {
    const observer = new MutationObserver(records => {
      this.editor.read('latest', () => {
        let gridNeedsRedraw = false;

        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          const target = record.target;
          const nodeName = target.nodeName;

          if (
            nodeName === 'TABLE' ||
            nodeName === 'TBODY' ||
            nodeName === 'THEAD' ||
            nodeName === 'TR'
          ) {
            gridNeedsRedraw = true;
            break;
          }
        }

        if (!gridNeedsRedraw) {
          return;
        }

        const {tableNode, tableElement} = this.$lookup();
        this.table = getTable(tableNode, tableElement);
      });
    });
    this.listenersToRemove.add(() => observer.disconnect());
    this.editor.read('latest', () => {
      const {tableNode, tableElement} = this.$lookup();
      this.table = getTable(tableNode, tableElement);
      observer.observe(tableElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    });
  }

  $clearHighlight(setEmptySelection: boolean = true): void {
    const editor = this.editor;
    this.isHighlightingCells = false;
    this.anchorX = -1;
    this.anchorY = -1;
    this.focusX = -1;
    this.focusY = -1;
    this.tableSelection = null;
    this.anchorCellNodeKey = null;
    this.focusCellNodeKey = null;
    this.anchorCell = null;
    this.focusCell = null;
    this.hasHijackedSelectionStyles = false;

    this.$enableHighlightStyle();

    const {tableNode, tableElement} = this.$lookup();
    const grid = getTable(tableNode, tableElement);
    $updateDOMForSelection(editor, grid, null);
    if (setEmptySelection && $getSelection() !== null) {
      $setSelection(null);
      editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
    }
  }

  $enableHighlightStyle() {
    const editor = this.editor;
    const {tableElement} = this.$lookup();

    removeClassNamesFromElement(
      tableElement,
      editor._config.theme.tableSelection,
    );
    tableElement.classList.remove('disable-selection');
    this.hasHijackedSelectionStyles = false;
  }

  $disableHighlightStyle() {
    const {tableElement} = this.$lookup();
    addClassNamesToElement(
      tableElement,
      this.editor._config.theme.tableSelection,
    );
    this.hasHijackedSelectionStyles = true;
  }

  $updateTableTableSelection(selection: TableSelection | null): void {
    if (selection !== null) {
      invariant(
        selection.tableKey === this.tableNodeKey,
        "TableObserver.$updateTableTableSelection: selection.tableKey !== this.tableNodeKey ('%s' !== '%s')",
        selection.tableKey,
        this.tableNodeKey,
      );
      const editor = this.editor;
      this.tableSelection = selection;
      this.isHighlightingCells = true;
      this.$disableHighlightStyle();
      this.updateDOMSelection();
      $updateDOMForSelection(editor, this.table, this.tableSelection);
    } else {
      this.$clearHighlight();
    }
  }

  /** @internal */
  updateDOMSelection() {
    if (this.anchorCell !== null && this.focusCell !== null) {
      const domSelection = getDOMSelection(this.editor._window);
      // We are not using a native selection for tables, and if we
      // set one then the reconciler will undo it.
      // TODO - it would make sense to have one so that native
      //        copy/paste worked. Right now we have to emulate with
      //        keyboard events but it won't fire if triggered from the menu
      if (domSelection && domSelection.rangeCount > 0) {
        domSelection.removeAllRanges();
      }
    }
  }

  $setFocusCellForSelection(cell: TableDOMCell, ignoreStart = false): boolean {
    const editor = this.editor;
    const {tableNode} = this.$lookup();

    const cellX = cell.x;
    const cellY = cell.y;
    this.focusCell = cell;

    // Enable highlighting if: ignoreStart is true, or anchor differs from focus,
    // or we have valid tableSelection with anchor (for first drag after column switch)
    if (!this.isHighlightingCells) {
      const shouldEnable =
        ignoreStart ||
        this.anchorX !== cellX ||
        this.anchorY !== cellY ||
        (this.tableSelection != null && this.anchorCellNodeKey != null);
      if (shouldEnable) {
        this.isHighlightingCells = true;
        this.$disableHighlightStyle();
      }
    }

    // Skip if we're trying to select the same cell we already have selected
    // But only if focusX/focusY are valid (not -1, which means not reset)
    if (
      this.focusX !== -1 &&
      this.focusY !== -1 &&
      cellX === this.focusX &&
      cellY === this.focusY
    ) {
      return false;
    }

    this.focusX = cellX;
    this.focusY = cellY;

    if (this.isHighlightingCells) {
      const focusTableCellNode = $getNearestTableCellInTableFromDOMNode(
        tableNode,
        cell.elem,
      );

      if (this.tableSelection != null && this.anchorCellNodeKey != null) {
        let targetCellNode = focusTableCellNode;

        // Fallback: use coordinates if DOM lookup failed (handles timing issues on first drag)
        if (targetCellNode === null && ignoreStart) {
          targetCellNode = tableNode.getCellNodeFromCords(
            cellX,
            cellY,
            this.table,
          );
        }

        if (targetCellNode !== null) {
          const anchorTableCell = this.$getAnchorTableCellOrThrow();
          this.focusCellNodeKey = targetCellNode.getKey();
          this.tableSelection = $createTableSelectionFrom(
            tableNode,
            anchorTableCell,
            targetCellNode,
          );

          $setSelection(this.tableSelection);
          editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
          $updateDOMForSelection(editor, this.table, this.tableSelection);
          return true;
        }
      }
    }
    return false;
  }

  $getAnchorTableCell(): TableCellNode | null {
    const node = this.anchorCellNodeKey
      ? $getNodeByKey(this.anchorCellNodeKey)
      : null;
    return $isTableCellNode(node) ? node : null;
  }
  $getAnchorTableCellOrThrow(): TableCellNode {
    const anchorTableCell = this.$getAnchorTableCell();
    invariant(
      anchorTableCell !== null,
      'TableObserver anchorTableCell is null',
    );
    return anchorTableCell;
  }

  $getFocusTableCell(): TableCellNode | null {
    const node = this.focusCellNodeKey
      ? $getNodeByKey(this.focusCellNodeKey)
      : null;
    return $isTableCellNode(node) ? node : null;
  }

  $getFocusTableCellOrThrow(): TableCellNode {
    const focusTableCell = this.$getFocusTableCell();
    invariant(focusTableCell !== null, 'TableObserver focusTableCell is null');
    return focusTableCell;
  }

  $setAnchorCellForSelection(cell: TableDOMCell) {
    this.isHighlightingCells = false;
    this.anchorCell = cell;
    this.anchorX = cell.x;
    this.anchorY = cell.y;
    // Reset focus state to prevent stale values from previous selections
    this.focusX = -1;
    this.focusY = -1;
    this.focusCell = null;
    this.focusCellNodeKey = null;

    const {tableNode} = this.$lookup();
    const anchorTableCellNode = $getNearestTableCellInTableFromDOMNode(
      tableNode,
      cell.elem,
    );

    if (anchorTableCellNode !== null) {
      const anchorNodeKey = anchorTableCellNode.getKey();
      if (this.tableSelection != null) {
        this.tableSelection = this.tableSelection.clone();
        this.tableSelection.set(
          tableNode.getKey(),
          anchorNodeKey,
          anchorNodeKey,
        );
      } else {
        this.tableSelection = $createTableSelectionFrom(
          tableNode,
          anchorTableCellNode,
          anchorTableCellNode,
        );
      }
      this.anchorCellNodeKey = anchorNodeKey;
    }
  }

  $formatCells(type: TextFormatType) {
    const selection = $getSelection();

    invariant($isTableSelection(selection), 'Expected Table selection');

    const formatSelection = $createRangeSelection();

    const anchor = formatSelection.anchor;
    const focus = formatSelection.focus;

    const cellNodes = selection.getNodes().filter($isTableCellNode);
    invariant(cellNodes.length > 0, 'No table cells present');
    const paragraph = cellNodes[0].getFirstChild();
    const alignFormatWith = $isParagraphNode(paragraph)
      ? paragraph.getFormatFlags(type, null)
      : null;

    cellNodes.forEach((cellNode: TableCellNode) => {
      anchor.set(cellNode.getKey(), 0, 'element');
      focus.set(cellNode.getKey(), cellNode.getChildrenSize(), 'element');
      formatSelection.formatText(type, alignFormatWith);
    });

    $setSelection(selection);

    this.editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
  }

  $clearText() {
    const {editor} = this;
    const tableNode = $getNodeByKey(this.tableNodeKey);

    if (!$isTableNode(tableNode)) {
      throw new Error('Expected TableNode.');
    }

    const selection = $getSelection();

    invariant($isTableSelection(selection), 'Expected TableSelection');

    const selectedNodes = selection.getNodes().filter($isTableCellNode);

    // Check if the entire table is selected by verifying first and last cells
    const firstRow = tableNode.getFirstChild();
    const lastRow = tableNode.getLastChild();

    const isEntireTableSelected =
      selectedNodes.length > 0 &&
      firstRow !== null &&
      lastRow !== null &&
      $isTableRowNode(firstRow) &&
      $isTableRowNode(lastRow) &&
      selectedNodes[0] === firstRow.getFirstChild() &&
      selectedNodes[selectedNodes.length - 1] === lastRow.getLastChild();

    if (isEntireTableSelected) {
      tableNode.selectPrevious();
      const parent = tableNode.getParent();
      // Delete entire table
      tableNode.remove();
      // Handle case when table was the only node
      if ($isRootNode(parent) && parent.isEmpty()) {
        editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND);
      }
      return;
    }

    selectedNodes.forEach(cellNode => {
      if ($isElementNode(cellNode)) {
        // Clearing a cell empties its content; it does not reset how that
        // content is laid out. A fresh ParagraphNode would start with no
        // format, style, direction or indent, so the cell's paragraph is
        // copied instead when there is one — $copyNode carries that state and
        // returns it childless.
        const firstChild = cellNode.getFirstChild();
        const paragraphNode = $isParagraphNode(firstChild)
          ? $copyNode(firstChild)
          : $createParagraphNode();
        const textNode = $createTextNode();
        paragraphNode.append(textNode);
        cellNode.append(paragraphNode);
        cellNode.getChildren().forEach(child => {
          if (child !== paragraphNode) {
            child.remove();
          }
        });
      }
    });

    $updateDOMForSelection(editor, this.table, null);

    $setSelection(null);

    editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
  }
}
