/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getClipboardDataFromSelection,
  copyToClipboard,
} from '@lexical/clipboard';
import invariant from '@lexical/internal/invariant';
import {objectKlassEquals} from '@lexical/utils';
import {
  $caretFromPoint,
  $comparePointCaretNext,
  $createParagraphNode,
  $createRangeSelectionFromDom,
  $createTextNode,
  $extendCaretToRange,
  $findMatchingParent,
  $getAdjacentChildCaret,
  $getChildCaret,
  $getCommonAncestor,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getNodeByKeyOrThrow,
  $getPreviousSelection,
  $getSelection,
  $getSiblingCaret,
  $isChildCaret,
  $isElementNode,
  $isExtendableTextPointCaret,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $isSiblingCaret,
  $isTextNode,
  $normalizeCaret,
  $setPointFromCaret,
  $setSelection,
  addClassNamesToElement,
  type BaseSelection,
  type CaretDirection,
  type ChildCaret,
  COMMAND_PRIORITY_HIGH,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  COPY_COMMAND,
  CUT_COMMAND,
  DELETE_CHARACTER_COMMAND,
  DELETE_LINE_COMMAND,
  DELETE_WORD_COMMAND,
  type EditorState,
  type ElementNode,
  FOCUS_COMMAND,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  getActiveElement,
  getComposedEventTarget,
  getDOMSelection,
  getDOMSelectionPoints,
  getDOMSelectionRange,
  INSERT_PARAGRAPH_COMMAND,
  IS_FIREFOX,
  isDOMDocumentNode,
  isDOMNode,
  isDOMShadowRoot,
  isHTMLElement,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  PASTE_COMMAND,
  type PointCaret,
  type RangeSelection,
  registerEventListener,
  registerEventListeners,
  removeClassNamesFromElement,
  SELECTION_CHANGE_COMMAND,
  type SiblingCaret,
} from 'lexical';

import {$isTableCellNode, type TableCellNode} from './LexicalTableCellNode';
import {
  $getElementForTableNode,
  $isScrollableTablesActive,
  $isTableNode,
  type TableNode,
} from './LexicalTableNode';
import {
  type TableDOMCell,
  type TableDOMRows,
  type TableDOMTable,
  TableObserver,
  type TableObservers,
} from './LexicalTableObserver';
import {$isTableRowNode} from './LexicalTableRowNode';
import {
  $isTableSelection,
  type TableMapType,
  type TableMapValueType,
  type TableSelection,
} from './LexicalTableSelection';
import {
  $computeTableCellRectBoundary,
  $computeTableCellRectSpans,
  $computeTableMap,
  $getNodeTriplet,
  type TableCellRectBoundary,
} from './LexicalTableUtils';

const LEXICAL_ELEMENT_KEY = '__lexicalTableSelection';

function $getTableNodeByKeyOrThrow(key: NodeKey): TableNode {
  const tableNode = $getNodeByKeyOrThrow(key);
  invariant($isTableNode(tableNode), 'Expected TableNode for key %s', key);
  return tableNode;
}

const isPointerDownOnEvent = (event: PointerEvent) => {
  return (event.buttons & 1) === 1;
};

// How far (in CSS pixels) a pointer may travel from where it went down and
// still count as a tap rather than a drag. Touch contacts jitter by a few
// pixels while the finger is lifted, so a tap that lands near a cell border
// is otherwise reported as a move into the neighbouring cell (#8538).
const TAP_SLOP = 10;

// Distance (px) from a scroll container edge at which drag auto-scroll kicks
// in, and the maximum scroll delta applied per animation frame.
const AUTO_SCROLL_EDGE_ZONE = 40;
const AUTO_SCROLL_MAX_STEP = 18;

// Given a pointer position and the start/end edges of a scroll container on one
// axis, return the signed per-frame scroll delta: negative near the start edge,
// positive near the end edge, 0 while outside both edge zones. The delta ramps
// up the deeper the pointer is into the zone (and is capped once it reaches or
// passes the edge).
function autoScrollStep(pos: number, start: number, end: number): number {
  const speed = (depth: number) =>
    Math.max(
      1,
      Math.ceil(
        (Math.min(AUTO_SCROLL_EDGE_ZONE, depth) / AUTO_SCROLL_EDGE_ZONE) *
          AUTO_SCROLL_MAX_STEP,
      ),
    );
  if (pos <= start + AUTO_SCROLL_EDGE_ZONE) {
    return -speed(start + AUTO_SCROLL_EDGE_ZONE - pos);
  }
  if (pos >= end - AUTO_SCROLL_EDGE_ZONE) {
    return speed(pos - (end - AUTO_SCROLL_EDGE_ZONE));
  }
  return 0;
}

export function isHTMLTableElement(el: unknown): el is HTMLTableElement {
  return isHTMLElement(el) && el.nodeName === 'TABLE';
}

export function getTableElement<T extends HTMLElement | null>(
  tableNode: TableNode,
  dom: T,
): HTMLTableElementWithWithTableSelectionState | (T & null) {
  if (!dom) {
    return dom as T & null;
  }
  const element: null | HTMLTableElementWithWithTableSelectionState =
    isHTMLTableElement(dom) ? dom : dom.querySelector('table');
  invariant(
    isHTMLTableElement(element),
    'getTableElement: Expecting table in DOM node for %s of type %s with key %s, not %s',
    tableNode.constructor.name,
    tableNode.getType(),
    tableNode.getKey(),
    dom.nodeName,
  );
  return element;
}

export function getEditorWindow(editor: LexicalEditor): Window | null {
  return editor._window;
}

export function $findParentTableCellNodeInTable(
  tableNode: LexicalNode,
  node: LexicalNode | null,
): TableCellNode | null {
  for (
    let currentNode = node, lastTableCellNode: TableCellNode | null = null;
    currentNode !== null;
    currentNode = currentNode.getParent()
  ) {
    if (tableNode.is(currentNode)) {
      return lastTableCellNode;
    } else if ($isTableCellNode(currentNode)) {
      lastTableCellNode = currentNode;
    }
  }
  return null;
}

const ARROW_KEY_COMMANDS_WITH_DIRECTION = [
  [KEY_ARROW_DOWN_COMMAND, 'down'],
  [KEY_ARROW_UP_COMMAND, 'up'],
  [KEY_ARROW_LEFT_COMMAND, 'backward'],
  [KEY_ARROW_RIGHT_COMMAND, 'forward'],
] as const;
const DELETE_TEXT_COMMANDS = [
  DELETE_WORD_COMMAND,
  DELETE_LINE_COMMAND,
  DELETE_CHARACTER_COMMAND,
] as const;
const DELETE_KEY_COMMANDS = [
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
] as const;

export function registerTableWindowHandlers(
  editor: LexicalEditor,
  tableObservers: TableObservers,
) {
  // Use registerRootListener so the pointerdown handler is (re)attached
  // whenever the root element is set. This is required for the Extension API,
  // where register() runs before the ContentEditable mounts and getRootElement()
  // is still null.
  return editor.registerRootListener(rootElement => {
    if (rootElement === null) {
      return;
    }
    const editorWindow = editor._window;
    if (editorWindow === null) {
      return;
    }

    const pointerDownCallback = (event: PointerEvent) => {
      // Listener is on editorWindow; the composed target is needed so the
      // rootElement.contains check below sees the shadow-internal target.
      const target = getComposedEventTarget(event);
      if (
        event.button !== 0 ||
        !isDOMNode(target) ||
        !rootElement.contains(target)
      ) {
        return;
      }
      const selectionInfo = getTableObserverFromCellNode(target);

      editor.update(() => {
        // Clear highlights from all tables (even one we're actively clicking on)
        const selection = $getSelection();
        if ($isTableSelection(selection)) {
          for (const [observer] of tableObservers.observers.values()) {
            observer.$clearHighlight(false);
          }
          $setSelection(null);
          editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
        }
        if (!selectionInfo) {
          return;
        }
        const {tableObserver, tableElement, cellElement} = selectionInfo;
        $handleTableClick(
          editor,
          event,
          cellElement,
          tableElement,
          tableObserver,
          tableObservers,
        );
      });
    };

    return registerEventListener(
      editorWindow,
      'pointerdown',
      pointerDownCallback,
    );
  });
}

function $handleTableClick(
  editor: LexicalEditor,
  event: PointerEvent,
  selectedDOMCell: TableDOMCell,
  tableElement: HTMLTableElementWithWithTableSelectionState,
  tableObserver: TableObserver,
  tableObservers: TableObservers,
) {
  const editorWindow = editor._window;
  if (!editorWindow) {
    return;
  }
  const createPointerHandlers = (startingCell: TableDOMCell) => {
    if (tableObserver.isSelecting) {
      return;
    }
    tableObserver.isSelecting = true;
    tableObserver.isPointerDrag = false;
    tableObserver.pointerStartCell = startingCell;

    const isTouch = event.pointerType === 'touch';
    // The pointer that owns this gesture. Moves and lifts belonging to any
    // other pointer — a second finger, a stylus resting on the screen — are a
    // different gesture and must not drive this one.
    const gesturePointerId = event.pointerId;
    const startClientX = event.clientX;
    const startClientY = event.clientY;

    // Whether this gesture has established its own anchor cell. Non-touch
    // gestures anchor at pointerdown, so they start out anchored. A touch tap
    // must not enter table selection mode, so on touch the anchor is deferred
    // until the gesture becomes a drag that crosses into another cell:
    // anchoring eagerly leaves state behind that turns the next tap into a
    // table selection (#8538).
    let hasAnchorForGesture = !isTouch;

    // Set the anchor immediately so a drag that never gets a click still has
    // one (handles direct drag without click).
    if (!isTouch && tableObserver.anchorCell === null) {
      editor.update(() => {
        tableObserver.$setAnchorCellForSelection(startingCell);
      });
    }

    let lastClientX = event.clientX;
    let lastClientY = event.clientY;
    let autoScrollRafId: number | null = null;
    // Removes every listener below. Assigned once they are defined; nothing
    // can call stopSelecting before then, since only those listeners do.
    let removeGestureListeners: (() => void) | null = null;

    // Events from other pointers belong to other gestures. Environments that
    // synthesise PointerEvents without a pointerId leave both sides undefined,
    // which matches, so nothing is filtered out there.
    const isGesturePointer = (pointerEvent: PointerEvent): boolean =>
      pointerEvent.pointerId === gesturePointerId;

    // Whether the pointer has travelled beyond the tap slop box. Written so
    // that non-finite coordinates (again, synthesised events) fall through as
    // "moved": slop can't be measured there, and the cell-crossing check in
    // applyFocusCell still applies.
    const isBeyondTapSlop = (clientX: number, clientY: number): boolean =>
      !(
        Math.abs(clientX - startClientX) <= TAP_SLOP &&
        Math.abs(clientY - startClientY) <= TAP_SLOP
      );

    const stopSelecting = () => {
      tableObserver.isSelecting = false;
      tableObserver.isPointerDrag = false;
      tableObserver.pointerStartCell = null;
      if (autoScrollRafId !== null) {
        editorWindow.cancelAnimationFrame(autoScrollRafId);
        autoScrollRafId = null;
      }
      if (removeGestureListeners !== null) {
        removeGestureListeners();
        removeGestureListeners = null;
      }
    };

    // Resolve the table cell under the given viewport coordinates via the
    // table's own root so elementsFromPoint isn't retargeted; narrow with the
    // type guards rather than casting so the detached-table case (Node) falls
    // through to no hit-test.
    const resolveFocusCellFromPoint = (
      clientX: number,
      clientY: number,
    ): TableDOMCell | null => {
      const tableRoot = tableElement.getRootNode();
      if (!isDOMDocumentNode(tableRoot) && !isDOMShadowRoot(tableRoot)) {
        return null;
      }
      for (const el of tableRoot.elementsFromPoint(clientX, clientY)) {
        const cell = getDOMCellInTableFromTarget(tableElement, el);
        if (cell) {
          return cell;
        }
      }
      return null;
    };

    const applyFocusCell = (focusCell: TableDOMCell, override: boolean) => {
      // A deferred (touch) gesture only starts a table selection once it is a
      // drag that has left the cell it started in. Taps jitter, so neither a
      // move within the slop box nor a hit-test landing back in the starting
      // cell is enough to commit to one (#8538).
      if (
        !hasAnchorForGesture &&
        (!tableObserver.isPointerDrag || focusCell.elem === startingCell.elem)
      ) {
        return;
      }
      // Fallback: set anchor if still missing (handles race conditions), or
      // adopt the cell the gesture started on now that a deferred gesture has
      // become a drag, so the selection covers where the drag began rather
      // than whatever anchor an earlier gesture left behind.
      if (tableObserver.anchorCell === null || !hasAnchorForGesture) {
        const anchorCell = hasAnchorForGesture ? focusCell : startingCell;
        editor.update(() => {
          tableObserver.$setAnchorCellForSelection(anchorCell);
        });
      }
      hasAnchorForGesture = true;
      if (
        tableObserver.focusCell === null ||
        focusCell.elem !== tableObserver.focusCell.elem
      ) {
        tableObservers.setNextFocus({
          focusCell,
          override,
          tableKey: tableObserver.tableNodeKey,
        });
        editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
      }
    };

    // Walk up from the table to the nearest ancestor that can actually scroll
    // on the requested axis (the scrollable-tables wrapper for 'x'). Returns
    // null when none is found, in which case the caller may fall back to the
    // window.
    const findScrollContainer = (axis: 'x' | 'y'): HTMLElement | null => {
      for (
        let el: HTMLElement | null = tableElement.parentElement;
        el;
        el = el.parentElement
      ) {
        const canScroll =
          axis === 'x'
            ? el.scrollWidth > el.clientWidth
            : el.scrollHeight > el.clientHeight;
        if (canScroll) {
          const style = editorWindow.getComputedStyle(el);
          const overflow = axis === 'x' ? style.overflowX : style.overflowY;
          if (overflow === 'auto' || overflow === 'scroll') {
            return el;
          }
        }
      }
      return null;
    };

    // Scroll `container` (or the window when null) on `axis` if the pointer is
    // within the edge zone. Returns whether it actually scrolled.
    const scrollAxis = (
      container: HTMLElement | null,
      pos: number,
      axis: 'x' | 'y',
    ): boolean => {
      let start: number;
      let end: number;
      if (container === null) {
        start = 0;
        end = axis === 'x' ? editorWindow.innerWidth : editorWindow.innerHeight;
      } else {
        const rect = container.getBoundingClientRect();
        start = axis === 'x' ? rect.left : rect.top;
        end = axis === 'x' ? rect.right : rect.bottom;
      }
      const step = autoScrollStep(pos, start, end);
      if (step === 0) {
        return false;
      }
      if (container === null) {
        const before =
          axis === 'x' ? editorWindow.scrollX : editorWindow.scrollY;
        editorWindow.scrollBy(axis === 'x' ? step : 0, axis === 'x' ? 0 : step);
        return (
          (axis === 'x' ? editorWindow.scrollX : editorWindow.scrollY) !==
          before
        );
      }
      if (axis === 'x') {
        const before = container.scrollLeft;
        container.scrollLeft += step;
        return container.scrollLeft !== before;
      }
      const before = container.scrollTop;
      container.scrollTop += step;
      return container.scrollTop !== before;
    };

    // Clamp the last pointer position into the visible bounds of the scroll
    // container(s) so a pointer dragged past an edge still hit-tests onto the
    // newly-revealed cell instead of empty space beyond the table.
    const clampHitPoint = (
      hContainer: HTMLElement | null,
      vContainer: HTMLElement | null,
    ): [number, number] => {
      let x = lastClientX;
      let y = lastClientY;
      if (hContainer === null) {
        x = Math.min(Math.max(x, 1), editorWindow.innerWidth - 1);
      } else {
        const rect = hContainer.getBoundingClientRect();
        x = Math.min(Math.max(x, rect.left + 1), rect.right - 1);
      }
      if (vContainer === null) {
        y = Math.min(Math.max(y, 1), editorWindow.innerHeight - 1);
      } else {
        const rect = vContainer.getBoundingClientRect();
        y = Math.min(Math.max(y, rect.top + 1), rect.bottom - 1);
      }
      return [x, y];
    };

    const isNearScrollEdge = (): boolean => {
      const hContainer = findScrollContainer('x');
      if (hContainer !== null) {
        const rect = hContainer.getBoundingClientRect();
        if (autoScrollStep(lastClientX, rect.left, rect.right) !== 0) {
          return true;
        }
      }
      const vContainer = findScrollContainer('y');
      const vStart =
        vContainer === null ? 0 : vContainer.getBoundingClientRect().top;
      const vEnd =
        vContainer === null
          ? editorWindow.innerHeight
          : vContainer.getBoundingClientRect().bottom;
      return autoScrollStep(lastClientY, vStart, vEnd) !== 0;
    };

    const tickAutoScroll = () => {
      autoScrollRafId = null;
      if (!tableObserver.isSelecting) {
        return;
      }
      const hContainer = findScrollContainer('x');
      const vContainer = findScrollContainer('y');
      // Only the table's own wrapper scrolls horizontally; pages don't
      // auto-scroll sideways. Vertically we fall back to the window.
      const scrolledX =
        hContainer !== null && scrollAxis(hContainer, lastClientX, 'x');
      const scrolledY = scrollAxis(vContainer, lastClientY, 'y');
      if (scrolledX || scrolledY) {
        const [hitX, hitY] = clampHitPoint(hContainer, vContainer);
        const focusCell = resolveFocusCellFromPoint(hitX, hitY);
        if (focusCell) {
          applyFocusCell(focusCell, false);
        }
        autoScrollRafId = editorWindow.requestAnimationFrame(tickAutoScroll);
      }
    };

    const maybeStartAutoScroll = () => {
      // Touch taps don't initiate table selection, so they shouldn't scroll.
      // A touch drag that has become one still needs to reach the columns
      // past the edge of a scrollable table, so gate on the tap, not on the
      // pointer type.
      if (
        autoScrollRafId !== null ||
        (isTouch && !tableObserver.isPointerDrag) ||
        !isNearScrollEdge()
      ) {
        return;
      }
      autoScrollRafId = editorWindow.requestAnimationFrame(tickAutoScroll);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (isGesturePointer(upEvent)) {
        stopSelecting();
      }
    };

    // A gesture also ends when the browser takes it away: a touch that turns
    // into a scroll fires pointercancel and never a pointerup, and pointer
    // capture (implicit for touch) can be lost to another element. Without
    // these the observer stays in selecting mode indefinitely — the stale
    // pointermove listener keeps driving selections from this gesture's
    // starting cell, and createPointerHandlers refuses to start any later
    // gesture, so every subsequent tap selects cells (#8538).
    const onPointerGestureEnd = (endEvent: PointerEvent) => {
      if (isGesturePointer(endEvent)) {
        stopSelecting();
      }
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!isGesturePointer(moveEvent)) {
        return;
      }
      if (!isPointerDownOnEvent(moveEvent) && tableObserver.isSelecting) {
        stopSelecting();
        return;
      }
      const moveTarget = getComposedEventTarget(moveEvent);
      if (!isDOMNode(moveTarget)) {
        return;
      }
      lastClientX = moveEvent.clientX;
      lastClientY = moveEvent.clientY;
      if (
        !tableObserver.isPointerDrag &&
        isBeyondTapSlop(lastClientX, lastClientY)
      ) {
        tableObserver.isPointerDrag = true;
      }
      let focusCell: null | TableDOMCell = null;
      // In firefox the moveEvent.target may be captured so we must always
      // consult the coordinates #7245
      const override = !(IS_FIREFOX || tableElement.contains(moveTarget));
      if (override) {
        focusCell = getDOMCellInTableFromTarget(tableElement, moveTarget);
      } else {
        focusCell = resolveFocusCellFromPoint(
          moveEvent.clientX,
          moveEvent.clientY,
        );
      }
      if (focusCell) {
        applyFocusCell(focusCell, override);
      }
      // Keep the selection reachable when dragging toward/past an edge of a
      // scrollable table (#7153).
      maybeStartAutoScroll();
    };
    removeGestureListeners = registerEventListeners(
      editorWindow,
      {
        lostpointercapture: onPointerGestureEnd,
        pointercancel: onPointerGestureEnd,
        pointermove: onPointerMove,
        pointerup: onPointerUp,
      },
      tableObserver.listenerOptions,
    );
  };

  tableObserver.pointerType = event.pointerType;
  const tableNode = $getTableNodeByKeyOrThrow(tableObserver.tableNodeKey);
  const prevSelection = $getPreviousSelection();
  // We can't trust Firefox to do the right thing with the selection and
  // we don't have a proper state machine to do this "correctly" but
  // if we go ahead and make the table selection now it will work.
  //
  // Only the nearest cell's observer is given the pointerdown
  // (getTableObserverFromCellNode resolves one), so shift-clicking into a table
  // nested inside a cell arrives here with `tableNode` set to that nested table
  // and a previous anchor in the cell around it — outside `tableNode`, so
  // $isSelectionInTable alone would skip it and leave the case to Firefox,
  // which resets the anchor to the start of the cell. The branches below do
  // resolve it, so widen to it and to nothing else: an anchor in an unrelated
  // table is not something they can resolve, and the second one would put the
  // focus on this table's edge rather than on the cell that was clicked.
  const prevAnchorNestedCell =
    $isRangeSelection(prevSelection) || $isTableSelection(prevSelection)
      ? $findCellNode(prevSelection.anchor.getNode())
      : null;
  const isShiftClickIntoNestedTable =
    prevAnchorNestedCell !== null && prevAnchorNestedCell.isParentOf(tableNode);
  if (
    IS_FIREFOX &&
    event.shiftKey &&
    ($isRangeSelection(prevSelection) || $isTableSelection(prevSelection)) &&
    ($isSelectionInTable(prevSelection, tableNode) ||
      isShiftClickIntoNestedTable)
  ) {
    const prevAnchorNode = prevSelection.anchor.getNode();
    const prevAnchorCell = $findParentTableCellNodeInTable(
      tableNode,
      prevSelection.anchor.getNode(),
    );
    if (prevAnchorCell) {
      const prevAnchorDOMCell = $getObserverCellFromCellNodeOrThrow(
        tableObserver,
        prevAnchorCell,
      );
      // Only when the two ends are in different cells is there a table
      // selection to make. A shift-click out of a nested table arrives here
      // with both in the same one: the anchor sits inside that table, and
      // $findParentTableCellNodeInTable walks past it to the cell of
      // `tableNode` that contains it, which is also the cell that was clicked.
      // Building a TableSelection from that covers the single cell end to end
      // — "erroneously selects the entire outer cell". What belongs there is an
      // ordinary range inside the cell, which the engine resolves on its own.
      if (prevAnchorDOMCell.elem !== selectedDOMCell.elem) {
        tableObserver.$setAnchorCellForSelection(prevAnchorDOMCell);
        tableObserver.$setFocusCellForSelection(selectedDOMCell);
        stopEvent(event);
      } else if (event.pointerType !== 'touch') {
        // No table selection to make, but the observer's anchor still has to
        // follow the pointer down: createPointerHandlers only adopts its
        // `startingCell` when `anchorCell` is null, so leaving a cell from an
        // earlier click in place would anchor a drag started here on that one.
        // This records the cell without touching the selection.
        tableObserver.$setAnchorCellForSelection(selectedDOMCell);
      }
    } else {
      const newSelection = tableNode.isBefore(prevAnchorNode)
        ? tableNode.selectStart()
        : tableNode.selectEnd();
      newSelection.anchor.set(
        prevSelection.anchor.key,
        prevSelection.anchor.offset,
        prevSelection.anchor.type,
      );
      // The selection above is the answer, so the native shift-click must not
      // also run: Firefox would resolve its own, anchored at the start of the
      // cell, and the selectionchange import would overwrite this one.
      stopEvent(event);
    }
  } else {
    // Only set anchor cell for selection if this is not a simple touch tap
    // Touch taps should not initiate table selection mode
    if (event.pointerType !== 'touch') {
      tableObserver.$setAnchorCellForSelection(selectedDOMCell);
    }
  }

  // Pass the target cell to createPointerHandlers so it can be used as anchor
  // if user drags directly without clicking first
  createPointerHandlers(selectedDOMCell);
}

export function applyTableHandlers(
  tableNode: TableNode,
  element: HTMLElement,
  editor: LexicalEditor,
  hasTabHandler: boolean,
  tableObservers: TableObservers,
): TableObserver {
  const rootElement = editor.getRootElement();
  const editorWindow = getEditorWindow(editor);
  invariant(
    rootElement !== null && editorWindow !== null,
    'applyTableHandlers: editor has no root element set',
  );

  const tableObserver = new TableObserver(editor, tableNode.getKey());

  const tableElement = getTableElement(tableNode, element);
  attachTableObserverToTableElement(tableElement, tableObserver);
  tableObserver.listenersToRemove.add(() =>
    detachTableObserverFromTableElement(tableElement, tableObserver),
  );

  const onTripleClick = (event: MouseEvent) => {
    const target = getComposedEventTarget(event);
    if (event.detail >= 3 && isDOMNode(target)) {
      const targetCell = getDOMCellFromTarget(target);
      if (targetCell !== null) {
        event.preventDefault();
      }
    }
  };
  tableObserver.listenersToRemove.add(
    registerEventListener(
      tableElement,
      'mousedown',
      onTripleClick,
      tableObserver.listenerOptions,
    ),
  );

  for (const [command, direction] of ARROW_KEY_COMMANDS_WITH_DIRECTION) {
    tableObserver.listenersToRemove.add(
      editor.registerCommand(
        command,
        event =>
          $handleArrowKey(
            editor,
            event,
            direction,
            tableNode,
            tableObserver,
            tableObservers,
          ),
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }

  tableObserver.listenersToRemove.add(
    editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      event => {
        const selection = $getSelection();
        if ($isTableSelection(selection)) {
          const focusCellNode = $findParentTableCellNodeInTable(
            tableNode,
            selection.focus.getNode(),
          );
          if (focusCellNode !== null) {
            stopEvent(event);
            focusCellNode.selectEnd();
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    ),
  );

  const $deleteTextHandler = () => {
    const selection = $getSelection();

    if (!$isSelectionInTable(selection, tableNode)) {
      return false;
    }

    if ($isTableSelection(selection)) {
      tableObserver.$clearText();

      return true;
    }

    return false;
  };

  for (const command of DELETE_TEXT_COMMANDS) {
    tableObserver.listenersToRemove.add(
      editor.registerCommand(
        command,
        $deleteTextHandler,
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }

  const $deleteCellHandler = (
    event: KeyboardEvent | ClipboardEvent | null,
  ): boolean => {
    const selection = $getSelection();
    if (!($isTableSelection(selection) || $isRangeSelection(selection))) {
      return false;
    }

    // If the selection is inside the table but should remove the whole table
    // we expand the selection so that both the anchor and focus are outside
    // the table and the editor's command listener will handle the delete
    const isAnchorInside = tableNode.isParentOf(selection.anchor.getNode());
    const isFocusInside = tableNode.isParentOf(selection.focus.getNode());
    if (isAnchorInside !== isFocusInside) {
      const tablePoint = isAnchorInside ? 'anchor' : 'focus';
      const outerPoint = isAnchorInside ? 'focus' : 'anchor';
      // Preserve the outer point
      const {key, offset, type} = selection[outerPoint];
      // Expand the selection around the table
      const newSelection =
        tableNode[
          selection[tablePoint].isBefore(selection[outerPoint])
            ? 'selectPrevious'
            : 'selectNext'
        ]();
      // Restore the outer point of the selection
      newSelection[outerPoint].set(key, offset, type);
      // Let the base implementation handle the rest
      return false;
    }

    if (!$isSelectionInTable(selection, tableNode)) {
      return false;
    }

    if ($isTableSelection(selection)) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      tableObserver.$clearText();

      return true;
    }

    return false;
  };

  for (const command of DELETE_KEY_COMMANDS) {
    tableObserver.listenersToRemove.add(
      editor.registerCommand(
        command,
        $deleteCellHandler,
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }

  tableObserver.listenersToRemove.add(
    editor.registerCommand(
      CUT_COMMAND,
      event => {
        const selection = $getSelection();
        if (selection) {
          if (!($isTableSelection(selection) || $isRangeSelection(selection))) {
            return false;
          }
          // Copying to the clipboard is async so we must capture the data
          // before we delete it
          void copyToClipboard(
            editor,
            objectKlassEquals(event, ClipboardEvent) ? event : null,
            $getClipboardDataFromSelection(selection),
          );
          const intercepted = $deleteCellHandler(event);
          if ($isRangeSelection(selection)) {
            selection.removeText();
            return true;
          }
          return intercepted;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    ),
  );

  // When TableSelection clears native selection ranges (removeAllRanges),
  // browsers redirect paste events to <body> instead of the rootElement.
  // Intercept at the document level and forward to PASTE_COMMAND.
  const doc = rootElement.ownerDocument;
  tableObserver.listenersToRemove.add(
    registerEventListener(doc, 'paste', (event: ClipboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const shouldIntercept = editor.read('latest', () => {
        const selection = $getSelection();
        return (
          rootElement.contains(doc.activeElement) &&
          $isTableSelection(selection) &&
          $isSelectionInTable(selection, tableNode)
        );
      });
      if (shouldIntercept) {
        event.preventDefault();
        editor.dispatchCommand(PASTE_COMMAND, event);
      }
    }),
  );

  // In read-only mode (contentEditable=false), Firefox fires the native copy
  // event on the document rather than on the root element, so the core
  // PASS_THROUGH copy listener never sees it. We intercept at the document
  // level and forward to COPY_COMMAND. Unlike the paste listener above, we
  // skip events whose target is inside the rootElement — those are already
  // handled by the core copy listener which runs regardless of isEditable.
  tableObserver.listenersToRemove.add(
    registerEventListener(doc, 'copy', (event: ClipboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const target = getComposedEventTarget(event);
      if (
        target === rootElement ||
        (isDOMNode(target) && rootElement.contains(target))
      ) {
        return;
      }
      const shouldIntercept = editor.read('latest', () => {
        const selection = $getSelection();
        return (
          rootElement.contains(getActiveElement(rootElement)) &&
          $isTableSelection(selection) &&
          $isSelectionInTable(selection, tableNode)
        );
      });
      if (shouldIntercept) {
        event.preventDefault();
        editor.dispatchCommand(COPY_COMMAND, event);
      }
    }),
  );

  tableObserver.listenersToRemove.add(
    editor.registerCommand(
      FORMAT_TEXT_COMMAND,
      payload => {
        const selection = $getSelection();

        if (!$isSelectionInTable(selection, tableNode)) {
          return false;
        }

        if ($isTableSelection(selection)) {
          tableObserver.$formatCells(payload);

          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    ),
  );

  tableObserver.listenersToRemove.add(
    editor.registerCommand(
      FORMAT_ELEMENT_COMMAND,
      formatType => {
        const selection = $getSelection();
        if (
          !$isTableSelection(selection) ||
          !$isSelectionInTable(selection, tableNode)
        ) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const focusNode = selection.focus.getNode();
        if (!$isTableCellNode(anchorNode) || !$isTableCellNode(focusNode)) {
          return false;
        }

        const [tableMap, anchorCell, focusCell] = $computeTableMap(
          tableNode,
          anchorNode,
          focusNode,
        );
        // The same rect TableSelection.getNodes() walks. A naive min/max over
        // the two cells' own spans is not enough: a merged cell that straddles
        // the boundary pulls the rect outwards, and $computeTableCellRectBoundary
        // iterates until it stops growing. Using the smaller rect here left the
        // cells that only the expansion brings in selected and highlighted but
        // unformatted.
        const {minColumn, maxColumn, minRow, maxRow} =
          $computeTableCellRectBoundary(tableMap, anchorCell, focusCell);

        if (
          minRow === 0 &&
          minColumn === 0 &&
          maxRow === tableMap.length - 1 &&
          maxColumn === tableMap[0].length - 1
        ) {
          tableNode.setFormat(formatType);
          return true;
        }

        const visited = new Set<TableCellNode>();
        for (let i = minRow; i <= maxRow; i++) {
          for (let j = minColumn; j <= maxColumn; j++) {
            const cell = tableMap[i][j].cell;
            if (visited.has(cell)) {
              continue;
            }
            visited.add(cell);
            cell.setFormat(formatType);

            const cellChildren = cell.getChildren();
            for (let k = 0; k < cellChildren.length; k++) {
              const child = cellChildren[k];
              if ($isElementNode(child) && !child.isInline()) {
                child.setFormat(formatType);
              }
            }
          }
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    ),
  );

  tableObserver.listenersToRemove.add(
    editor.registerCommand(
      CONTROLLED_TEXT_INSERTION_COMMAND,
      payload => {
        const selection = $getSelection();

        if (!$isSelectionInTable(selection, tableNode)) {
          return false;
        }

        if ($isTableSelection(selection)) {
          tableObserver.$clearHighlight();

          return false;
        } else if ($isRangeSelection(selection)) {
          const tableCellNode = $findMatchingParent(
            selection.anchor.getNode(),
            n => $isTableCellNode(n),
          );

          if (!$isTableCellNode(tableCellNode)) {
            return false;
          }

          if (typeof payload === 'string') {
            const edgePosition = $getTableEdgeCursorPosition(
              editor,
              selection,
              tableNode,
            );
            if (edgePosition) {
              $insertParagraphAtTableEdge(edgePosition, tableNode, [
                $createTextNode(payload),
              ]);
              return true;
            }
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    ),
  );

  if (hasTabHandler) {
    tableObserver.listenersToRemove.add(
      editor.registerCommand(
        KEY_TAB_COMMAND,
        event => {
          const selection = $getSelection();
          if (
            !$isRangeSelection(selection) ||
            !selection.isCollapsed() ||
            !$isSelectionInTable(selection, tableNode)
          ) {
            return false;
          }

          const tableCellNode = $findCellNode(selection.anchor.getNode());
          if (
            tableCellNode === null ||
            !tableNode.is($findTableNode(tableCellNode))
          ) {
            return false;
          }

          stopEvent(event);
          $selectAdjacentCell(
            tableCellNode,
            event.shiftKey ? 'previous' : 'next',
          );

          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }

  tableObserver.listenersToRemove.add(
    editor.registerCommand(
      FOCUS_COMMAND,
      payload => {
        return tableNode.isSelected();
      },
      COMMAND_PRIORITY_HIGH,
    ),
  );

  tableObserver.listenersToRemove.add(
    editor.registerCommand(
      INSERT_PARAGRAPH_COMMAND,
      () => {
        const selection = $getSelection();
        if (
          !$isRangeSelection(selection) ||
          !selection.isCollapsed() ||
          !$isSelectionInTable(selection, tableNode)
        ) {
          return false;
        }
        const edgePosition = $getTableEdgeCursorPosition(
          editor,
          selection,
          tableNode,
        );
        if (edgePosition) {
          $insertParagraphAtTableEdge(edgePosition, tableNode);
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    ),
  );

  return tableObserver;
}

/** @internal */
export function $handleTableSelectionChangeCommand(
  tableObservers: TableObservers,
  editor: LexicalEditor,
) {
  const selection = $getSelection();
  const prevSelection = $getPreviousSelection();

  const nextFocus = tableObservers.getAndClearNextFocus();
  if (nextFocus !== null) {
    const {tableKey, focusCell} = nextFocus;
    const observerAndTable = tableObservers.observers.get(tableKey);
    invariant(
      !!observerAndTable,
      'tableObserver not found for tableKey: %s',
      tableKey,
    );
    const [tableObserver] = observerAndTable;
    if (
      $isTableSelection(selection) &&
      selection.tableKey === tableObserver.tableNodeKey
    ) {
      if (
        focusCell.x === tableObserver.focusX &&
        focusCell.y === tableObserver.focusY
      ) {
        // The selection is already the correct table selection
        return false;
      } else {
        tableObserver.$setFocusCellForSelection(focusCell);
        return true;
      }
    } else if (
      tableObserver.anchorCell !== null &&
      tableObserver.anchorCellNodeKey !== null &&
      focusCell.elem !== tableObserver.anchorCell.elem &&
      tableObserver.tableSelection !== null
    ) {
      // The selection has crossed cells
      // If we have an anchor cell set and tableSelection initialized,
      // we have all the necessary state to create the selection.
      // The presence of nextFocus means we're dragging, so process it.
      // Use ignoreStart=true to ensure isHighlightingCells is set correctly
      // on the first drag attempt, especially when switching columns.
      tableObserver.$setFocusCellForSelection(focusCell, true);
      return true;
    }
  }
  const shouldCheckSelectionForTable =
    tableObservers.getAndClearShouldCheckSelectionForTable();
  // If they pressed the down arrow with the selection outside of the
  // table, and then the selection ends up in the table but not in the
  // first cell, then move the selection to the first cell.
  if (
    !!shouldCheckSelectionForTable &&
    $isRangeSelection(prevSelection) &&
    $isRangeSelection(selection) &&
    selection.isCollapsed()
  ) {
    // The table may have been removed before this selection change
    // was dispatched, in which case there is nothing to check
    const tableNode = $getNodeByKey(shouldCheckSelectionForTable);
    if ($isTableNode(tableNode)) {
      const anchor = selection.anchor.getNode();
      const firstRow = tableNode.getFirstChild();
      const anchorCell = $findCellNode(anchor);
      if (anchorCell !== null && $isTableRowNode(firstRow)) {
        const firstCell = firstRow.getFirstChild();
        if (
          $isTableCellNode(firstCell) &&
          tableNode.is(
            $findMatchingParent(
              anchorCell,
              node => node.is(tableNode) || node.is(firstCell),
            ),
          )
        ) {
          // The selection moved to the table, but not in the first cell
          firstCell.selectStart();
          return true;
        }
      }
    }
  }

  if ($isTableSelection(selection)) {
    $fixTableSelectionForSelectedTable(editor, selection);
  }

  if ($isRangeSelection(selection)) {
    $fixRangeSelectionForSelectedTable(selection, tableObservers);
  }

  // Generic selection logic that runs across every table observer when the selection changes.
  // Note: the selection might have changed in the code above, which re-dispatches the selection change command
  // and gets handled here on the second pass. This should be refactored.
  for (const [
    tableNode,
    tableObserver,
  ] of tableObservers.$getTableNodesAndObservers()) {
    $syncTableSelectionState(editor, tableNode, tableObserver);
  }

  return false;
}

/**
 * Handles cases where range selections cross into, out of, or within tables.
 */
function $fixRangeSelectionForSelectedTable(
  selection: RangeSelection,
  tableObservers: TableObservers,
) {
  const prevSelection = $getPreviousSelection();
  const {anchor, focus} = selection;
  const anchorNode = anchor.getNode();
  const focusNode = focus.getNode();
  // Using explicit comparison with table node to ensure it's not a nested table
  // as in that case we'll leave selection resolving to that table
  const anchorCellNode = $findCellNode(anchorNode);
  const focusCellNode = $findCellNode(focusNode);
  const anchorCellTable = anchorCellNode
    ? $findTableNode(anchorCellNode)
    : null;
  const focusCellTable = focusCellNode ? $findTableNode(focusCellNode) : null;
  const isBackward = selection.isBackward();

  const isSameTable =
    anchorCellNode &&
    focusCellNode &&
    anchorCellTable &&
    focusCellTable &&
    anchorCellTable.is(focusCellTable);

  // The focus should be moved (to cover the whole focus table) if it is moved outside of the anchor's table.
  // For example, when dragging from outside a table into it.
  const shouldMoveFocus =
    focusCellTable &&
    (!anchorCellTable || anchorCellTable.isParentOf(focusCellTable));
  // The anchor should be moved (to cover the whole anchor table) if the focus is moved outside of the anchor table.
  // For example, when dragging from inside a table out of it.
  const shouldMoveAnchor =
    anchorCellTable &&
    (!focusCellTable || focusCellTable.isParentOf(anchorCellTable));

  if (shouldMoveFocus) {
    // Select the whole focus table.
    const newSelection = selection.clone();
    const [tableMap] = $computeTableMap(
      focusCellTable,
      focusCellNode!,
      focusCellNode!,
    );
    const firstCell = tableMap[0][0].cell;
    const lastCell = tableMap[tableMap.length - 1].at(-1)!.cell;
    newSelection.focus.set(
      isBackward ? firstCell.getKey() : lastCell.getKey(),
      isBackward ? 0 : lastCell.getChildrenSize(),
      'element',
    );
    $setSelection(newSelection);
  } else if (shouldMoveAnchor) {
    // Select the whole anchor table.
    const newSelection = selection.clone();
    const [tableMap] = $computeTableMap(
      anchorCellTable,
      anchorCellNode!,
      anchorCellNode!,
    );
    const firstCell = tableMap[0][0].cell;
    const lastCell = tableMap[tableMap.length - 1].at(-1)!.cell;
    newSelection.anchor.set(
      isBackward ? lastCell.getKey() : firstCell.getKey(),
      isBackward ? lastCell.getChildrenSize() : 0,
      'element',
    );
    $setSelection(newSelection);
  } else if (isSameTable) {
    // Handle case when selection spans across multiple cells but still
    // has range selection, then we convert it into table selection
    // For example, this fires when dragging up from first cell, outside of the table, or when clicking a cell
    // then shift-clicking another cell.
    const observerInfo = tableObservers.observers.get(anchorCellTable.getKey());
    invariant(
      !!observerInfo,
      'tableObserver not found for tableKey: %s',
      anchorCellTable.getKey(),
    );
    const [tableObserver] = observerInfo;
    if (!anchorCellNode.is(focusCellNode)) {
      tableObserver.$setAnchorCellForSelection(
        $getObserverCellFromCellNodeOrThrow(tableObserver, anchorCellNode),
      );
      tableObserver.$setFocusCellForSelection(
        $getObserverCellFromCellNodeOrThrow(tableObserver, focusCellNode),
        true,
      );
    }

    // Handle case when the pointer type is touch and the current and
    // previous selection are collapsed, and the previous anchor and current
    // focus cell nodes are different, then we convert it into table selection.
    // This must only happen for a gesture that is actually dragging across
    // cells: a tap places a caret in a new cell while the pointer is still
    // down, so keying off isSelecting alone converts consecutive taps into a
    // table selection (#8538).
    if (
      tableObserver.pointerType === 'touch' &&
      tableObserver.isSelecting &&
      tableObserver.isPointerDrag &&
      selection.isCollapsed() &&
      $isRangeSelection(prevSelection) &&
      prevSelection.isCollapsed()
    ) {
      const prevAnchorCellNode = $findCellNode(prevSelection.anchor.getNode());
      // Being a drag is not enough: it has to have left the cell it started
      // on. A drag that stays inside one cell is selecting text there, and
      // the caret the browser moves as it goes would otherwise be paired with
      // whatever cell the previous gesture left in the range selection,
      // producing exactly the multi-cell selection tapping is meant to avoid.
      const {pointerStartCell} = tableObserver;
      const hasLeftStartCell =
        pointerStartCell !== null &&
        $getObserverCellFromCellNodeOrThrow(tableObserver, focusCellNode)
          .elem !== pointerStartCell.elem;
      if (
        hasLeftStartCell &&
        prevAnchorCellNode &&
        !prevAnchorCellNode.is(focusCellNode)
      ) {
        tableObserver.$setAnchorCellForSelection(
          $getObserverCellFromCellNodeOrThrow(
            tableObserver,
            prevAnchorCellNode,
          ),
        );
        tableObserver.$setFocusCellForSelection(
          $getObserverCellFromCellNodeOrThrow(tableObserver, focusCellNode),
          true,
        );
        tableObserver.pointerType = null;
      }
    }
  }
}

/**
 * Ensures that a TableSelection is automatically changed to a RangeSelection when the selection goes outside of the table.
 */
function $fixTableSelectionForSelectedTable(
  editor: LexicalEditor,
  selection: TableSelection,
) {
  const editorWindow = getEditorWindow(editor);
  const prevSelection = $getPreviousSelection();
  if (!selection.is(prevSelection)) {
    return;
  }
  const tableNode = $getTableNodeByKeyOrThrow(selection.tableKey);
  // if selection goes outside of the table we need to change it to Range selection
  const domSelection = getDOMSelection(editorWindow);
  const points =
    domSelection &&
    getDOMSelectionPoints(domSelection, editor.getRootElement());
  if (domSelection && points && points.anchorNode && points.focusNode) {
    const focusNode = $getNearestNodeFromDOMNode(points.focusNode);
    const isFocusOutside = focusNode && !tableNode.isParentOf(focusNode);

    const anchorNode = $getNearestNodeFromDOMNode(points.anchorNode);
    const isAnchorInside = anchorNode && tableNode.isParentOf(anchorNode);

    if (isFocusOutside && isAnchorInside && domSelection.rangeCount > 0) {
      const newSelection = $createRangeSelectionFromDom(domSelection, editor);
      if (newSelection) {
        newSelection.anchor.set(
          tableNode.getKey(),
          selection.isBackward() ? tableNode.getChildrenSize() : 0,
          'element',
        );
        domSelection.removeAllRanges();
        $setSelection(newSelection);
      }
    }
  }
}

// Handle keeping the table observer/DOM in sync with the selection.
function $syncTableSelectionState(
  editor: LexicalEditor,
  tableNode: TableNode,
  tableObserver: TableObserver,
) {
  const selection = $getSelection();
  const prevSelection = $getPreviousSelection();
  if (
    selection &&
    !selection.is(prevSelection) &&
    ($isTableSelection(selection) || $isTableSelection(prevSelection)) &&
    tableObserver.tableSelection &&
    !tableObserver.tableSelection.is(prevSelection)
  ) {
    if (
      $isTableSelection(selection) &&
      selection.tableKey === tableObserver.tableNodeKey
    ) {
      tableObserver.$updateTableTableSelection(selection);
    } else if (
      !$isTableSelection(selection) &&
      $isTableSelection(prevSelection) &&
      prevSelection.tableKey === tableObserver.tableNodeKey
    ) {
      tableObserver.$updateTableTableSelection(null);
    }
  }

  if (tableObserver.hasHijackedSelectionStyles && !tableNode.isSelected()) {
    $removeHighlightStyleToTable(editor, tableObserver);
  } else if (
    !tableObserver.hasHijackedSelectionStyles &&
    tableNode.isSelected()
  ) {
    $addHighlightStyleToTable(editor, tableObserver);
  }
}

export type HTMLTableElementWithWithTableSelectionState = HTMLTableElement & {
  [LEXICAL_ELEMENT_KEY]?: TableObserver | undefined;
};

export function detachTableObserverFromTableElement(
  tableElement: HTMLTableElementWithWithTableSelectionState,
  tableObserver: TableObserver,
) {
  if (getTableObserverFromTableElement(tableElement) === tableObserver) {
    delete tableElement[LEXICAL_ELEMENT_KEY];
  }
}

export function attachTableObserverToTableElement(
  tableElement: HTMLTableElementWithWithTableSelectionState,
  tableObserver: TableObserver,
) {
  invariant(
    getTableObserverFromTableElement(tableElement) === null,
    'tableElement already has an attached TableObserver',
  );
  tableElement[LEXICAL_ELEMENT_KEY] = tableObserver;
}

export function getTableObserverFromTableElement(
  tableElement: HTMLTableElementWithWithTableSelectionState,
): TableObserver | null {
  return tableElement[LEXICAL_ELEMENT_KEY] || null;
}

function getTableObserverFromCellNode(node: null | Node): {
  tableObserver: TableObserver;
  tableElement: HTMLTableElementWithWithTableSelectionState;
  cellElement: TableDOMCell;
} | null {
  const cellNode = getDOMCellFromTarget(node);
  if (cellNode === null) {
    return null;
  }
  let currentNode: ParentNode | Node | null = cellNode.elem;
  while (currentNode != null) {
    const nodeName = currentNode.nodeName;
    if (
      nodeName === 'TABLE' &&
      LEXICAL_ELEMENT_KEY in currentNode &&
      !!currentNode[LEXICAL_ELEMENT_KEY]
    ) {
      return {
        cellElement: cellNode,
        tableElement:
          currentNode as HTMLTableElementWithWithTableSelectionState,
        tableObserver: currentNode[LEXICAL_ELEMENT_KEY] as TableObserver,
      };
    }
    currentNode = currentNode.parentNode;
  }
  return null;
}

export function getDOMCellFromTarget(node: null | Node): TableDOMCell | null {
  let currentNode: ParentNode | Node | null = node;

  while (currentNode != null) {
    const nodeName = currentNode.nodeName;

    if (nodeName === 'TD' || nodeName === 'TH') {
      // @ts-expect-error: internal field
      const cell = currentNode._cell;

      if (cell === undefined) {
        return null;
      }

      return cell;
    }

    currentNode = currentNode.parentNode;
  }

  return null;
}

export function getDOMCellInTableFromTarget(
  table: HTMLTableElementWithWithTableSelectionState,
  node: null | Node,
): TableDOMCell | null {
  if (!table.contains(node)) {
    return null;
  }
  let cell: null | TableDOMCell = null;
  for (
    let currentNode: ParentNode | Node | null = node;
    currentNode != null;
    currentNode = currentNode.parentNode
  ) {
    if (currentNode === table) {
      return cell;
    }
    const nodeName = currentNode.nodeName;
    if (nodeName === 'TD' || nodeName === 'TH') {
      // @ts-expect-error: internal field
      cell = currentNode._cell || null;
    }
  }
  return null;
}

export function doesTargetContainText(node: Node): boolean {
  const currentNode: ParentNode | Node | null = node;

  if (currentNode !== null) {
    const nodeName = currentNode.nodeName;

    if (nodeName === 'SPAN') {
      return true;
    }
  }
  return false;
}

export function getTable(
  tableNode: TableNode,
  dom: HTMLElement,
): TableDOMTable {
  const tableElement = getTableElement(tableNode, dom);
  const domRows: TableDOMRows = [];
  const grid = {
    columns: 0,
    domRows,
    rows: 0,
  };
  let currentNode = tableElement.querySelector('tr') as ChildNode | null;
  let x = 0;
  let y = 0;
  domRows.length = 0;

  while (currentNode != null) {
    const nodeMame = currentNode.nodeName;

    if (nodeMame === 'TD' || nodeMame === 'TH') {
      const elem = currentNode as HTMLElement;
      const cell = {
        elem,
        hasBackgroundColor: elem.style.backgroundColor !== '',
        highlighted: false,
        x,
        y,
      };

      // @ts-expect-error: internal field
      currentNode._cell = cell;

      let row = domRows[y];
      if (row === undefined) {
        row = domRows[y] = [];
      }

      row[x] = cell;
    } else {
      const child = currentNode.firstChild;

      if (child != null) {
        currentNode = child;
        continue;
      }
    }

    const sibling = currentNode.nextSibling;

    if (sibling != null) {
      x++;
      currentNode = sibling;
      continue;
    }

    const parent = currentNode.parentNode;

    if (parent != null) {
      const parentSibling = parent.nextSibling;

      if (parentSibling == null) {
        break;
      }

      y++;
      x = 0;
      currentNode = parentSibling;
    }
  }

  grid.columns = x + 1;
  grid.rows = y + 1;

  return grid;
}

export function $updateDOMForSelection(
  editor: LexicalEditor,
  table: TableDOMTable,
  selection: TableSelection | RangeSelection | null,
) {
  const selectedCellNodes = new Set(selection ? selection.getNodes() : []);
  $forEachTableCell(table, (cell, lexicalNode) => {
    const elem = cell.elem;

    if (selectedCellNodes.has(lexicalNode)) {
      cell.highlighted = true;
      $addHighlightToDOM(editor, cell);
    } else {
      cell.highlighted = false;
      $removeHighlightFromDOM(editor, cell);
      if (!elem.getAttribute('style')) {
        elem.removeAttribute('style');
      }
    }
  });
}

export function $forEachTableCell(
  grid: TableDOMTable,
  cb: (
    cell: TableDOMCell,
    lexicalNode: LexicalNode,
    cords: {
      x: number;
      y: number;
    },
  ) => void,
) {
  const {domRows} = grid;

  for (let y = 0; y < domRows.length; y++) {
    const row = domRows[y];
    if (!row) {
      continue;
    }

    for (let x = 0; x < row.length; x++) {
      const cell = row[x];
      if (!cell) {
        continue;
      }
      const lexicalNode = $getNearestNodeFromDOMNode(cell.elem);

      if (lexicalNode !== null) {
        cb(cell, lexicalNode, {
          x,
          y,
        });
      }
    }
  }
}

export function $addHighlightStyleToTable(
  editor: LexicalEditor,
  tableSelection: TableObserver,
) {
  tableSelection.$disableHighlightStyle();
  $forEachTableCell(tableSelection.table, cell => {
    cell.highlighted = true;
    $addHighlightToDOM(editor, cell);
  });
}

export function $removeHighlightStyleToTable(
  editor: LexicalEditor,
  tableObserver: TableObserver,
) {
  tableObserver.$enableHighlightStyle();
  $forEachTableCell(tableObserver.table, cell => {
    const elem = cell.elem;
    cell.highlighted = false;
    $removeHighlightFromDOM(editor, cell);

    if (!elem.getAttribute('style')) {
      elem.removeAttribute('style');
    }
  });
}

function $selectAdjacentCell(
  tableCellNode: TableCellNode,
  direction: 'next' | 'previous',
) {
  const siblingMethod =
    direction === 'next' ? 'getNextSibling' : 'getPreviousSibling';
  const childMethod = direction === 'next' ? 'getFirstChild' : 'getLastChild';
  const sibling = tableCellNode[siblingMethod]();
  if ($isElementNode(sibling)) {
    return sibling.selectEnd();
  }
  const parentRow = $findMatchingParent(tableCellNode, $isTableRowNode);
  invariant(parentRow !== null, 'selectAdjacentCell: Cell not in table row');
  for (
    let nextRow = parentRow[siblingMethod]();
    $isTableRowNode(nextRow);
    nextRow = nextRow[siblingMethod]()
  ) {
    const child = nextRow[childMethod]();
    if ($isElementNode(child)) {
      return child.selectEnd();
    }
  }
  const parentTable = $findMatchingParent(parentRow, $isTableNode);
  invariant(parentTable !== null, 'selectAdjacentCell: Row not in table');
  return direction === 'next'
    ? parentTable.selectNext()
    : parentTable.selectPrevious();
}

type Direction = 'backward' | 'forward' | 'up' | 'down';

const selectTableNodeInDirection = (
  tableObserver: TableObserver,
  tableNode: TableNode,
  x: number,
  y: number,
  direction: Direction,
): boolean => {
  const isForward = direction === 'forward';

  switch (direction) {
    case 'backward':
    case 'forward':
      if (x !== (isForward ? tableObserver.table.columns - 1 : 0)) {
        selectTableCellNode(
          tableNode.getCellNodeFromCordsOrThrow(
            x + (isForward ? 1 : -1),
            y,
            tableObserver.table,
          ),
          isForward,
        );
      } else {
        if (y !== (isForward ? tableObserver.table.rows - 1 : 0)) {
          selectTableCellNode(
            tableNode.getCellNodeFromCordsOrThrow(
              isForward ? 0 : tableObserver.table.columns - 1,
              y + (isForward ? 1 : -1),
              tableObserver.table,
            ),
            isForward,
          );
        } else if (!isForward) {
          tableNode.selectPrevious();
        } else {
          tableNode.selectNext();
        }
      }

      return true;

    case 'up':
      if (y !== 0) {
        selectTableCellNode(
          tableNode.getCellNodeFromCordsOrThrow(x, y - 1, tableObserver.table),
          false,
        );
      } else {
        tableNode.selectPrevious();
      }

      return true;

    case 'down':
      if (y !== tableObserver.table.rows - 1) {
        selectTableCellNode(
          tableNode.getCellNodeFromCordsOrThrow(x, y + 1, tableObserver.table),
          true,
        );
      } else {
        tableNode.selectNext();
      }

      return true;
    default:
      return false;
  }
};

type Corner = ['minColumn' | 'maxColumn', 'minRow' | 'maxRow'];
function getCorner(
  rect: TableCellRectBoundary,
  cellValue: TableMapValueType,
): Corner | null {
  let colName: 'minColumn' | 'maxColumn';
  let rowName: 'minRow' | 'maxRow';
  if (cellValue.startColumn === rect.minColumn) {
    colName = 'minColumn';
  } else if (
    cellValue.startColumn + cellValue.cell.__colSpan - 1 ===
    rect.maxColumn
  ) {
    colName = 'maxColumn';
  } else {
    return null;
  }
  if (cellValue.startRow === rect.minRow) {
    rowName = 'minRow';
  } else if (
    cellValue.startRow + cellValue.cell.__rowSpan - 1 ===
    rect.maxRow
  ) {
    rowName = 'maxRow';
  } else {
    return null;
  }
  return [colName, rowName];
}

/**
 * Resolve the corner of `rect` that the anchor sits on.
 *
 * `$computeTableCellRectBoundary` grows the rect until it contains every
 * merged cell that straddles an edge, so the anchor is not guaranteed to be at
 * a corner of the result — a cell merged across the rect's edge pushes that
 * edge past the anchor. Fall back to the corner opposite the focus, and when
 * the focus is not at a corner either, to the top-left.
 *
 * TODO the last fallback doesn't have to be arbitrary, use the closest corner
 * instead.
 */
function getAnchorCorner(
  rect: TableCellRectBoundary,
  anchorCellValue: TableMapValueType,
  focusCellValue: TableMapValueType,
): Corner {
  const anchorCorner = getCorner(rect, anchorCellValue);
  if (anchorCorner) {
    return anchorCorner;
  }
  const focusCorner = getCorner(rect, focusCellValue);
  if (focusCorner) {
    return oppositeCorner(focusCorner);
  }
  return ['minColumn', 'minRow'];
}

function oppositeCorner([colName, rowName]: Corner): Corner {
  return [
    colName === 'minColumn' ? 'maxColumn' : 'minColumn',
    rowName === 'minRow' ? 'maxRow' : 'minRow',
  ];
}

function cellAtCornerOrThrow(
  tableMap: TableMapType,
  rect: TableCellRectBoundary,
  [colName, rowName]: Corner,
): TableMapValueType {
  const rowNum = rect[rowName];
  const rowMap = tableMap[rowNum];
  invariant(
    rowMap !== undefined,
    'cellAtCornerOrThrow: %s = %s missing in tableMap',
    rowName,
    String(rowNum),
  );
  const colNum = rect[colName];
  const cell = rowMap[colNum];
  invariant(
    cell !== undefined,
    'cellAtCornerOrThrow: %s = %s missing in tableMap',
    colName,
    String(colNum),
  );
  return cell;
}

function $extractRectCorners(
  tableMap: TableMapType,
  anchorCellValue: TableMapValueType,
  newFocusCellValue: TableMapValueType,
) {
  // We are sure that the focus now either contracts or expands the rect
  // but both the anchor and focus might be moved to ensure a rectangle
  // given a potentially ragged merge shape
  const rect = $computeTableCellRectBoundary(
    tableMap,
    anchorCellValue,
    newFocusCellValue,
  );
  const anchorCorner = getAnchorCorner(
    rect,
    anchorCellValue,
    newFocusCellValue,
  );
  return [
    cellAtCornerOrThrow(tableMap, rect, anchorCorner),
    cellAtCornerOrThrow(tableMap, rect, oppositeCorner(anchorCorner)),
  ];
}

function $adjustFocusInDirection(
  tableObserver: TableObserver,
  tableMap: TableMapType,
  anchorCellValue: TableMapValueType,
  focusCellValue: TableMapValueType,
  direction: Direction,
): boolean {
  const rect = $computeTableCellRectBoundary(
    tableMap,
    anchorCellValue,
    focusCellValue,
  );
  const spans = $computeTableCellRectSpans(tableMap, rect);
  const {topSpan, leftSpan, bottomSpan, rightSpan} = spans;
  const anchorCorner = getAnchorCorner(rect, anchorCellValue, focusCellValue);
  const [focusColumn, focusRow] = oppositeCorner(anchorCorner);
  let fCol = rect[focusColumn];
  let fRow = rect[focusRow];
  if (direction === 'forward') {
    fCol += focusColumn === 'maxColumn' ? 1 : leftSpan;
  } else if (direction === 'backward') {
    fCol -= focusColumn === 'minColumn' ? 1 : rightSpan;
  } else if (direction === 'down') {
    fRow += focusRow === 'maxRow' ? 1 : topSpan;
  } else if (direction === 'up') {
    fRow -= focusRow === 'minRow' ? 1 : bottomSpan;
  }
  const targetRowMap = tableMap[fRow];
  if (targetRowMap === undefined) {
    return false;
  }
  const newFocusCellValue = targetRowMap[fCol];
  if (newFocusCellValue === undefined) {
    return false;
  }
  // We can be certain that anchorCellValue and newFocusCellValue are
  // contained within the desired selection, but we are not certain if
  // they need to be expanded or not to maintain a rectangular shape
  const [finalAnchorCell, finalFocusCell] = $extractRectCorners(
    tableMap,
    anchorCellValue,
    newFocusCellValue,
  );
  const anchorDOM = $getObserverCellFromCellNodeOrThrow(
    tableObserver,
    finalAnchorCell.cell,
  )!;
  const focusDOM = $getObserverCellFromCellNodeOrThrow(
    tableObserver,
    finalFocusCell.cell,
  );
  tableObserver.$setAnchorCellForSelection(anchorDOM);
  tableObserver.$setFocusCellForSelection(focusDOM, true);
  return true;
}

function $isSelectionInTable(
  selection: null | BaseSelection,
  tableNode: TableNode,
): boolean {
  if ($isRangeSelection(selection) || $isTableSelection(selection)) {
    // TODO this should probably return false if there's an unrelated
    //      shadow root between the node and the table (e.g. another table,
    //      collapsible, etc.)
    const isAnchorInside = tableNode.isParentOf(selection.anchor.getNode());
    const isFocusInside = tableNode.isParentOf(selection.focus.getNode());

    return isAnchorInside && isFocusInside;
  }

  return false;
}

function selectTableCellNode(tableCell: TableCellNode, fromStart: boolean) {
  if (fromStart) {
    tableCell.selectStart();
  } else {
    tableCell.selectEnd();
  }
}

function $addHighlightToDOM(editor: LexicalEditor, cell: TableDOMCell): void {
  const element = cell.elem;
  const editorThemeClasses = editor._config.theme;
  const node = $getNearestNodeFromDOMNode(element);
  invariant(
    $isTableCellNode(node),
    'Expected to find LexicalNode from Table Cell DOMNode',
  );
  addClassNamesToElement(element, editorThemeClasses.tableCellSelected);
}

function $removeHighlightFromDOM(
  editor: LexicalEditor,
  cell: TableDOMCell,
): void {
  const element = cell.elem;
  const node = $getNearestNodeFromDOMNode(element);
  invariant(
    $isTableCellNode(node),
    'Expected to find LexicalNode from Table Cell DOMNode',
  );
  const editorThemeClasses = editor._config.theme;
  removeClassNamesFromElement(element, editorThemeClasses.tableCellSelected);
}

export function $findCellNode(node: LexicalNode): null | TableCellNode {
  const cellNode = $findMatchingParent(node, $isTableCellNode);
  return $isTableCellNode(cellNode) ? cellNode : null;
}

export function $findTableNode(node: LexicalNode): null | TableNode {
  const tableNode = $findMatchingParent(node, $isTableNode);
  return $isTableNode(tableNode) ? tableNode : null;
}

function $getBlockParentIfFirstNode(node: LexicalNode): ElementNode | null {
  for (
    let prevNode = node, currentNode: LexicalNode | null = node;
    currentNode !== null;
    prevNode = currentNode, currentNode = currentNode.getParent()
  ) {
    if ($isElementNode(currentNode)) {
      if (
        currentNode !== prevNode &&
        currentNode.getFirstChild() !== prevNode
      ) {
        // Not the first child or the initial node
        return null;
      } else if (!currentNode.isInline()) {
        return currentNode;
      }
    }
  }
  return null;
}

function $handleHorizontalArrowKeyRangeSelection(
  editor: LexicalEditor,
  event: KeyboardEvent,
  selection: RangeSelection,
  alter: 'extend' | 'move',
  isBackward: boolean,
  tableNode: TableNode,
  tableObserver: TableObserver,
): boolean {
  const initialFocus = $caretFromPoint(
    selection.focus,
    isBackward ? 'previous' : 'next',
  );
  if ($isExtendableTextPointCaret(initialFocus)) {
    return false;
  }
  let lastCaret = initialFocus;
  // TableCellNode is the only shadow root we are interested in piercing so
  // we find the last internal caret and then check its parent
  for (const nextCaret of $extendCaretToRange(initialFocus).iterNodeCarets(
    'shadowRoot',
  )) {
    if (!($isSiblingCaret(nextCaret) && $isElementNode(nextCaret.origin))) {
      return false;
    }
    lastCaret = nextCaret;
  }
  const lastCaretParent = lastCaret.getParentAtCaret();
  if (!$isTableCellNode(lastCaretParent)) {
    return false;
  }
  const anchorCell = lastCaretParent;
  const focusCaret = $findNextTableCell(
    $getSiblingCaret(anchorCell, lastCaret.direction),
  );
  const anchorCellTable = $findMatchingParent(anchorCell, $isTableNode);
  if (!(anchorCellTable && anchorCellTable.is(tableNode))) {
    return false;
  }
  const anchorCellDOM = editor.getElementByKey(anchorCell.getKey());
  const anchorDOMCell = getDOMCellFromTarget(anchorCellDOM);
  if (!anchorCellDOM || !anchorDOMCell) {
    return false;
  }

  const anchorCellTableElement = $getElementForTableNode(
    editor,
    anchorCellTable,
  );
  tableObserver.table = anchorCellTableElement;
  if (!focusCaret) {
    if (alter === 'extend') {
      // extend the selection from a range inside the cell to a table selection of the cell
      tableObserver.$setAnchorCellForSelection(anchorDOMCell);
      tableObserver.$setFocusCellForSelection(anchorDOMCell, true);
    } else {
      // exit the table
      const outerFocusCaret = $getTableExitCaret(
        $getSiblingCaret(anchorCellTable, initialFocus.direction),
      );
      $setPointFromCaret(selection.anchor, outerFocusCaret);
      $setPointFromCaret(selection.focus, outerFocusCaret);
    }
  } else if (alter === 'extend') {
    const focusDOMCell = getDOMCellFromTarget(
      editor.getElementByKey(focusCaret.origin.getKey()),
    );
    if (!focusDOMCell) {
      return false;
    }
    tableObserver.$setAnchorCellForSelection(anchorDOMCell);
    tableObserver.$setFocusCellForSelection(focusDOMCell, true);
  } else {
    // alter === 'move'
    const innerFocusCaret = $normalizeCaret(focusCaret);
    $setPointFromCaret(selection.anchor, innerFocusCaret);
    $setPointFromCaret(selection.focus, innerFocusCaret);
  }
  stopEvent(event);
  return true;
}

function $getTableExitCaret<D extends CaretDirection>(
  initialCaret: SiblingCaret<TableNode, D>,
): PointCaret<D> {
  const adjacent = $getAdjacentChildCaret(initialCaret);
  return $isChildCaret(adjacent) ? $normalizeCaret(adjacent) : initialCaret;
}

function $findNextTableCell<D extends CaretDirection>(
  initialCaret: SiblingCaret<TableCellNode, D>,
): null | ChildCaret<TableCellNode, D> {
  for (const nextCaret of $extendCaretToRange(initialCaret).iterNodeCarets(
    'root',
  )) {
    const {origin} = nextCaret;
    if ($isTableCellNode(origin)) {
      // not sure why ts isn't narrowing here (even if the guard is on nextCaret.origin)
      // but returning a new caret is fine
      if ($isChildCaret(nextCaret)) {
        return $getChildCaret(origin, initialCaret.direction);
      }
    } else if (!$isTableRowNode(origin)) {
      break;
    }
  }
  return null;
}

/**
 * True when the selection focus sits before `tableNode` in document order —
 * the only side an ArrowDown can move the caret into the table from.
 */
function $isSelectionBeforeTable(
  selection: null | BaseSelection,
  tableNode: TableNode,
): boolean {
  if (!$isRangeSelection(selection)) {
    return false;
  }
  const focusCaret = $caretFromPoint(selection.focus, 'next');
  // A ChildCaret is ordered at the table's 'enter' (pre-order) position, so
  // any caret strictly before it is outside of and above the table.
  const tableCaret = $getChildCaret(tableNode, 'next');
  return (
    $getCommonAncestor(focusCaret.origin, tableCaret.origin) !== null &&
    $comparePointCaretNext(focusCaret, tableCaret) < 0
  );
}

function $handleArrowKey(
  editor: LexicalEditor,
  event: KeyboardEvent,
  direction: Direction,
  tableNode: TableNode,
  tableObserver: TableObserver,
  tableObservers: TableObservers,
): boolean {
  if (
    (direction === 'up' || direction === 'down') &&
    isTypeaheadMenuInView(editor)
  ) {
    return false;
  }

  const selection = $getSelection();

  // Handle arrow key into a table (including from a table into a nested table)
  if (!$isSelectionInTable(selection, tableNode)) {
    if ($isRangeSelection(selection)) {
      if (direction === 'backward') {
        if (selection.focus.offset > 0) {
          return false;
        }
        const parentNode = $getBlockParentIfFirstNode(
          selection.focus.getNode(),
        );
        if (!parentNode) {
          return false;
        }
        const siblingNode = parentNode.getPreviousSibling();
        if (!$isTableNode(siblingNode)) {
          return false;
        }
        stopEvent(event);
        if (event.shiftKey) {
          selection.focus.set(
            siblingNode.getParentOrThrow().getKey(),
            siblingNode.getIndexWithinParent(),
            'element',
          );
        } else {
          siblingNode.selectEnd();
        }
        return true;
      } else if (
        event.shiftKey &&
        (direction === 'up' || direction === 'down')
      ) {
        const focusNode = selection.focus.getNode();
        const isTableUnselect =
          !selection.isCollapsed() &&
          ((direction === 'up' && !selection.isBackward()) ||
            (direction === 'down' && selection.isBackward()));
        if (isTableUnselect) {
          let focusParentNode = $findMatchingParent(focusNode, n =>
            $isTableNode(n),
          );
          if ($isTableCellNode(focusParentNode)) {
            focusParentNode = $findMatchingParent(
              focusParentNode,
              $isTableNode,
            );
          }
          if (focusParentNode !== tableNode) {
            return false;
          }
          if (!focusParentNode) {
            return false;
          }
          const sibling =
            direction === 'down'
              ? focusParentNode.getNextSibling()
              : focusParentNode.getPreviousSibling();
          if (!sibling) {
            return false;
          }
          let newOffset = 0;
          if (direction === 'up') {
            if ($isElementNode(sibling)) {
              newOffset = sibling.getChildrenSize();
            }
          }
          let newFocusNode = sibling;
          if (direction === 'up') {
            if ($isElementNode(sibling)) {
              const lastCell = sibling.getLastChild();
              newFocusNode = lastCell ? lastCell : sibling;
              newOffset = $isTextNode(newFocusNode)
                ? newFocusNode.getTextContentSize()
                : 0;
            }
          }
          const newSelection = selection.clone();

          newSelection.focus.set(
            newFocusNode.getKey(),
            newOffset,
            $isTextNode(newFocusNode) ? 'text' : 'element',
          );
          $setSelection(newSelection);
          stopEvent(event);
          return true;
        } else if ($isRootOrShadowRoot(focusNode)) {
          const selectedNode =
            direction === 'up'
              ? selection.getNodes()[selection.getNodes().length - 1]
              : selection.getNodes()[0];
          if (selectedNode) {
            const tableCellNode = $findParentTableCellNodeInTable(
              tableNode,
              selectedNode,
            );
            if (tableCellNode !== null) {
              const firstDescendant = tableNode.getFirstDescendant();
              const lastDescendant = tableNode.getLastDescendant();
              if (!firstDescendant || !lastDescendant) {
                return false;
              }
              const [firstCellNode] = $getNodeTriplet(firstDescendant);
              const [lastCellNode] = $getNodeTriplet(lastDescendant);
              const firstCellCoords = tableNode.getCordsFromCellNode(
                firstCellNode,
                tableObserver.table,
              );
              const lastCellCoords = tableNode.getCordsFromCellNode(
                lastCellNode,
                tableObserver.table,
              );
              const firstCellDOM = tableNode.getDOMCellFromCordsOrThrow(
                firstCellCoords.x,
                firstCellCoords.y,
                tableObserver.table,
              );
              const lastCellDOM = tableNode.getDOMCellFromCordsOrThrow(
                lastCellCoords.x,
                lastCellCoords.y,
                tableObserver.table,
              );
              tableObserver.$setAnchorCellForSelection(firstCellDOM);
              tableObserver.$setFocusCellForSelection(lastCellDOM, true);
              return true;
            }
          }
          return false;
        } else {
          let focusParentNode = $findMatchingParent(
            focusNode,
            n => $isElementNode(n) && !n.isInline(),
          );
          if ($isTableCellNode(focusParentNode)) {
            focusParentNode = $findMatchingParent(
              focusParentNode,
              $isTableNode,
            );
          }
          if (!focusParentNode) {
            return false;
          }
          const sibling =
            direction === 'down'
              ? focusParentNode.getNextSibling()
              : focusParentNode.getPreviousSibling();
          if (
            $isTableNode(sibling) &&
            tableObserver.tableNodeKey === sibling.getKey()
          ) {
            const firstDescendant = sibling.getFirstDescendant();
            const lastDescendant = sibling.getLastDescendant();
            if (!firstDescendant || !lastDescendant) {
              return false;
            }
            const [firstCellNode] = $getNodeTriplet(firstDescendant);
            const [lastCellNode] = $getNodeTriplet(lastDescendant);
            const newSelection = selection.clone();
            newSelection.focus.set(
              (direction === 'up' ? firstCellNode : lastCellNode).getKey(),
              direction === 'up' ? 0 : lastCellNode.getChildrenSize(),
              'element',
            );
            stopEvent(event);
            $setSelection(newSelection);
            return true;
          }
        }
      }
    }
    if (
      direction === 'down' &&
      $isScrollableTablesActive(editor) &&
      // Only arm the workaround when ArrowDown could actually move the caret
      // into the table. From a caret after the table (e.g. the block cursor
      // below a trailing table) ArrowDown moves nothing, so the flag would
      // survive to be consumed by an unrelated later selection change — an
      // ArrowUp back into the last row would then be snapped to the first
      // cell.
      $isSelectionBeforeTable(selection, tableNode)
    ) {
      // Enable Firefox workaround
      tableObservers.setShouldCheckSelectionForTable(tableNode.getKey());
    }
    return false;
  }

  if ($isRangeSelection(selection)) {
    if (direction === 'backward' || direction === 'forward') {
      const alter = event.shiftKey ? 'extend' : 'move';
      return $handleHorizontalArrowKeyRangeSelection(
        editor,
        event,
        selection,
        alter,
        direction === 'backward',
        tableNode,
        tableObserver,
      );
    }

    if (selection.isCollapsed()) {
      const {anchor, focus} = selection;
      const anchorCellNode = $findMatchingParent(
        anchor.getNode(),
        $isTableCellNode,
      );
      const focusCellNode = $findMatchingParent(
        focus.getNode(),
        $isTableCellNode,
      );
      if (
        !$isTableCellNode(anchorCellNode) ||
        !anchorCellNode.is(focusCellNode)
      ) {
        return false;
      }
      const anchorCellTable = $findTableNode(anchorCellNode);
      if (anchorCellTable !== tableNode && anchorCellTable != null) {
        const anchorCellTableElement = getTableElement(
          anchorCellTable,
          editor.getElementByKey(anchorCellTable.getKey()),
        );
        if (anchorCellTableElement != null) {
          tableObserver.table = getTable(
            anchorCellTable,
            anchorCellTableElement,
          );
          return $handleArrowKey(
            editor,
            event,
            direction,
            anchorCellTable,
            tableObserver,
            tableObservers,
          );
        }
      }

      const anchorCellDom = editor.getElementByKey(anchorCellNode.__key);
      const anchorDOM = editor.getElementByKey(anchor.key);
      if (anchorDOM == null || anchorCellDom == null) {
        return false;
      }

      let edgeSelectionRect;
      if (anchor.type === 'element') {
        edgeSelectionRect = anchorDOM.getBoundingClientRect();
      } else {
        const domSelection = getDOMSelection(getEditorWindow(editor));
        if (domSelection === null || domSelection.rangeCount === 0) {
          return false;
        }

        // getDOMSelectionRange rather than getRangeAt(0), which is retargeted
        // to the shadow host when the editor is in a shadow tree
        const range = getDOMSelectionRange(
          domSelection,
          editor.getRootElement(),
        );
        if (range === null) {
          return false;
        }
        edgeSelectionRect = range.getBoundingClientRect();
      }

      const edgeChild =
        direction === 'up'
          ? anchorCellNode.getFirstChild()
          : anchorCellNode.getLastChild();
      if (edgeChild == null) {
        return false;
      }

      const edgeChildDOM = editor.getElementByKey(edgeChild.__key);

      if (edgeChildDOM == null) {
        return false;
      }

      const edgeRect = edgeChildDOM.getBoundingClientRect();
      const isExiting =
        direction === 'up'
          ? edgeRect.top > edgeSelectionRect.top - edgeSelectionRect.height
          : edgeSelectionRect.bottom + edgeSelectionRect.height >
            edgeRect.bottom;

      if (isExiting) {
        stopEvent(event);

        const cords = tableNode.getCordsFromCellNode(
          anchorCellNode,
          tableObserver.table,
        );

        if (event.shiftKey) {
          const cell = tableNode.getDOMCellFromCordsOrThrow(
            cords.x,
            cords.y,
            tableObserver.table,
          );
          tableObserver.$setAnchorCellForSelection(cell);
          tableObserver.$setFocusCellForSelection(cell, true);
        } else {
          return selectTableNodeInDirection(
            tableObserver,
            tableNode,
            cords.x,
            cords.y,
            direction,
          );
        }

        return true;
      }
    }
  } else if ($isTableSelection(selection)) {
    const {anchor, focus, tableKey} = selection;
    if (tableKey !== tableNode.getKey()) {
      return false;
    }
    const anchorCellNode = $findMatchingParent(
      anchor.getNode(),
      $isTableCellNode,
    );
    const focusCellNode = $findMatchingParent(
      focus.getNode(),
      $isTableCellNode,
    );

    const [tableNodeFromSelection] = selection.getNodes();
    invariant(
      $isTableNode(tableNodeFromSelection),
      '$handleArrowKey: TableSelection.getNodes()[0] expected to be TableNode',
    );
    const tableElement = getTableElement(
      tableNodeFromSelection,
      editor.getElementByKey(tableNodeFromSelection.getKey()),
    );
    if (
      !$isTableCellNode(anchorCellNode) ||
      !$isTableCellNode(focusCellNode) ||
      !$isTableNode(tableNodeFromSelection) ||
      tableElement == null
    ) {
      return false;
    }
    tableObserver.$updateTableTableSelection(selection);

    const grid = getTable(tableNodeFromSelection, tableElement);
    const cordsAnchor = tableNode.getCordsFromCellNode(anchorCellNode, grid);
    const anchorCell = tableNode.getDOMCellFromCordsOrThrow(
      cordsAnchor.x,
      cordsAnchor.y,
      grid,
    );
    tableObserver.$setAnchorCellForSelection(anchorCell);

    stopEvent(event);

    if (event.shiftKey) {
      const [tableMap, anchorValue, focusValue] = $computeTableMap(
        tableNode,
        anchorCellNode,
        focusCellNode,
      );
      return $adjustFocusInDirection(
        tableObserver,
        tableMap,
        anchorValue,
        focusValue,
        direction,
      );
    } else {
      focusCellNode.selectEnd();
    }

    return true;
  }

  return false;
}

function stopEvent(event: Event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  event.stopPropagation();
}

function isTypeaheadMenuInView(editor: LexicalEditor) {
  // There is no inbuilt way to check if the component picker is in view
  // but we can check if the root DOM element has the aria-controls attribute "typeahead-menu".
  const root = editor.getRootElement();
  if (!root) {
    return false;
  }
  return (
    root.hasAttribute('aria-controls') &&
    root.getAttribute('aria-controls') === 'typeahead-menu'
  );
}

function $insertParagraphAtTableEdge(
  edgePosition: 'first' | 'last',
  tableNode: TableNode,
  children?: LexicalNode[],
) {
  const paragraphNode = $createParagraphNode();
  if (edgePosition === 'first') {
    tableNode.insertBefore(paragraphNode);
  } else {
    tableNode.insertAfter(paragraphNode);
  }
  paragraphNode.append(...(children || []));
  paragraphNode.selectEnd();
}

function $getTableEdgeCursorPosition(
  editor: LexicalEditor,
  selection: RangeSelection,
  tableNode: TableNode,
) {
  const tableNodeParent = tableNode.getParent();
  if (!tableNodeParent) {
    return undefined;
  }

  // TODO: Add support for nested tables
  const domSelection = getDOMSelection(getEditorWindow(editor));
  if (!domSelection) {
    return undefined;
  }
  const domAnchorNode = getDOMSelectionPoints(
    domSelection,
    editor.getRootElement(),
  ).anchorNode;
  const tableNodeParentDOM = editor.getElementByKey(tableNodeParent.getKey());
  const tableElement = getTableElement(
    tableNode,
    editor.getElementByKey(tableNode.getKey()),
  );
  // We are only interested in the scenario where the
  // native selection anchor is:
  // - at or inside the table's parent DOM
  // - and NOT at or inside the table DOM
  // It may be adjacent to the table DOM (e.g. in a wrapper)
  if (
    !domAnchorNode ||
    !tableNodeParentDOM ||
    !tableElement ||
    !tableNodeParentDOM.contains(domAnchorNode) ||
    tableElement.contains(domAnchorNode)
  ) {
    return undefined;
  }

  const anchorCellNode = $findMatchingParent(selection.anchor.getNode(), n =>
    $isTableCellNode(n),
  ) as TableCellNode | null;
  if (!anchorCellNode) {
    return undefined;
  }

  const parentTable = $findMatchingParent(anchorCellNode, n => $isTableNode(n));
  if (!$isTableNode(parentTable) || !parentTable.is(tableNode)) {
    return undefined;
  }

  const [tableMap, cellValue] = $computeTableMap(
    tableNode,
    anchorCellNode,
    anchorCellNode,
  );
  const firstCell = tableMap[0][0];
  const lastCell = tableMap[tableMap.length - 1][tableMap[0].length - 1];
  const {startRow, startColumn} = cellValue;

  const isAtFirstCell =
    startRow === firstCell.startRow && startColumn === firstCell.startColumn;
  const isAtLastCell =
    startRow === lastCell.startRow && startColumn === lastCell.startColumn;

  if (isAtFirstCell) {
    return 'first';
  } else if (isAtLastCell) {
    return 'last';
  } else {
    return undefined;
  }
}

export function $getObserverCellFromCellNodeOrThrow(
  tableObserver: TableObserver,
  tableCellNode: TableCellNode,
): TableDOMCell {
  const {tableNode} = tableObserver.$lookup();
  const currentCords = tableNode.getCordsFromCellNode(
    tableCellNode,
    tableObserver.table,
  );
  return tableNode.getDOMCellFromCordsOrThrow(
    currentCords.x,
    currentCords.y,
    tableObserver.table,
  );
}

export function $getNearestTableCellInTableFromDOMNode(
  tableNode: TableNode,
  startingDOM: Node,
  editorState?: EditorState,
) {
  return $findParentTableCellNodeInTable(
    tableNode,
    $getNearestNodeFromDOMNode(startingDOM, editorState),
  );
}
