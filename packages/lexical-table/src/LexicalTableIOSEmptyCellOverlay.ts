/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  getComposedEventTarget,
  getDOMSelection,
  getDOMSelectionPoints,
  isHTMLElement,
  type LexicalEditor,
  mergeRegister,
  type NodeKey,
  registerEventListeners,
  setDOMUnmanaged,
} from 'lexical';

import {TAP_SLOP} from './constants';
import {
  $isTableCellNode,
  EMPTY_CELL_OVERLAY_ATTRIBUTE,
} from './LexicalTableCellNode';
import {$isCellEmpty} from './LexicalTableUtils';

// iOS treats a second tap within about 350ms as a double tap.
const DOUBLE_TAP_WINDOW_MS = 500;
// A touch held longer is a long press, not the first tap of a double tap.
const TAP_MAX_MS = 500;

/**
 * A double tap in an empty cell makes iOS select back to the previous word,
 * outside the table, before the page can react (#9347). After a tap, the cell
 * is briefly covered by a non-editable overlay so the second tap lands on it
 * instead; it is uncovered otherwise so long press still works.
 */
export function registerIOSEmptyCellOverlays(
  editor: LexicalEditor,
): () => void {
  return editor.registerRootListener(rootElement => {
    if (rootElement === null) {
      return;
    }
    const view = rootElement.ownerDocument.defaultView;
    if (view === null) {
      return;
    }
    let current: null | {
      cellKey: NodeKey;
      overlay: HTMLElement;
      restorePosition: null | string;
      timer: number;
    } = null;
    let touchStart: null | {x: number; y: number; time: number} = null;
    const clear = () => {
      if (current !== null) {
        view.clearTimeout(current.timer);
        const cellDOM = current.overlay.parentElement;
        if (cellDOM !== null && current.restorePosition !== null) {
          cellDOM.style.position = current.restorePosition;
        }
        current.overlay.remove();
        current = null;
      }
    };

    const isOverlayEvent = (event: Event): boolean =>
      current !== null && getComposedEventTarget(event) === current.overlay;

    const cellOf = (event: Event): HTMLElement | null => {
      const target = getComposedEventTarget(event);
      return isHTMLElement(target)
        ? target.closest<HTMLElement>('td,th')
        : null;
    };

    const coverCell = (cellDOM: HTMLElement) => {
      if (!editor.isEditable() || !rootElement.contains(cellDOM)) {
        return;
      }
      // Already covered by this tap's pointerdown: only restart the window.
      if (current !== null && current.overlay.parentElement === cellDOM) {
        view.clearTimeout(current.timer);
        current.timer = view.setTimeout(clear, DOUBLE_TAP_WINDOW_MS);
        return;
      }
      const cellKey = editor.read('latest', () => {
        const cell = $getNearestNodeFromDOMNode(cellDOM);
        return $isTableCellNode(cell) && $isCellEmpty(cell)
          ? cell.getKey()
          : null;
      });
      if (cellKey === null) {
        return;
      }
      clear();
      const overlay = rootElement.ownerDocument.createElement('div');
      overlay.setAttribute(EMPTY_CELL_OVERLAY_ATTRIBUTE, 'true');
      overlay.contentEditable = 'false';
      overlay.style.cssText =
        'position:absolute;top:0;right:0;bottom:0;left:0;' +
        '-webkit-user-select:none;user-select:none;' +
        '-webkit-touch-callout:none;touch-action:manipulation';
      setDOMUnmanaged(overlay);
      // The overlay needs a positioned cell to cover it; restored with the
      // overlay so the cell is left as its theme styled it.
      let restorePosition: null | string = null;
      if (view.getComputedStyle(cellDOM).position === 'static') {
        restorePosition = cellDOM.style.position;
        cellDOM.style.position = 'relative';
      }
      cellDOM.append(overlay);
      current = {
        cellKey,
        overlay,
        restorePosition,
        timer: view.setTimeout(clear, DOUBLE_TAP_WINDOW_MS),
      };
    };

    const onPointerDown = (event: PointerEvent) => {
      touchStart =
        event.pointerType === 'touch'
          ? {time: Date.now(), x: event.clientX, y: event.clientY}
          : null;
      if (isOverlayEvent(event)) {
        // The overlay is not editable; letting the tap through would blur
        // the editor and drop the keyboard before the caret is placed.
        event.preventDefault();
        return;
      }
      // A tap on the cell that already holds the caret gets no pointerup
      // until iOS knows whether a second tap follows, so cover it now.
      const cellDOM = cellOf(event);
      const domSelection = getDOMSelection(view);
      if (
        touchStart !== null &&
        cellDOM !== null &&
        domSelection !== null &&
        domSelection.isCollapsed &&
        cellDOM.contains(
          getDOMSelectionPoints(domSelection, rootElement).anchorNode,
        )
      ) {
        coverCell(cellDOM);
      }
    };

    // Only after a tap: covering after a drag or long press would end the
    // selection it made.
    const onPointerUp = (event: PointerEvent) => {
      const start = touchStart;
      touchStart = null;
      const cellDOM = cellOf(event);
      if (
        start !== null &&
        cellDOM !== null &&
        !isOverlayEvent(event) &&
        Date.now() - start.time <= TAP_MAX_MS &&
        Math.abs(event.clientX - start.x) <= TAP_SLOP &&
        Math.abs(event.clientY - start.y) <= TAP_SLOP
      ) {
        coverCell(cellDOM);
      }
    };

    const onClick = (event: MouseEvent) => {
      if (current === null || !isOverlayEvent(event)) {
        return;
      }
      const {cellKey} = current;
      // Focus inside the tap's click so iOS opens the keyboard.
      rootElement.focus({preventScroll: true});
      editor.update(() => {
        const cell = $getNodeByKey(cellKey);
        if ($isTableCellNode(cell)) {
          cell.selectStart();
        }
      });
    };

    return mergeRegister(
      // Capture, so this runs before the table and root handlers.
      registerEventListeners(
        rootElement,
        {click: onClick, pointerdown: onPointerDown, pointerup: onPointerUp},
        true,
      ),
      // The overlay must not cover text typed within the window.
      editor.registerUpdateListener(({dirtyElements}) => {
        if (current === null || !dirtyElements.has(current.cellKey)) {
          return;
        }
        const {cellKey} = current;
        const isEmpty = editor.read('latest', () => {
          const cell = $getNodeByKey(cellKey);
          return $isTableCellNode(cell) && $isCellEmpty(cell);
        });
        if (!isEmpty) {
          clear();
        }
      }),
      clear,
    );
  });
}
