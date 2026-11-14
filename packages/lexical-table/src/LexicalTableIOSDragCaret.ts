/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  getComposedEventTarget,
  isHTMLElement,
  type LexicalEditor,
  mergeRegister,
  registerEventListener,
  registerEventListeners,
} from 'lexical';

/**
 * On iOS, a long press drag across table cells keeps moving the native caret
 * while the table selection keeps clearing it, so the caret flickers for the
 * whole gesture. The caret is hidden while a finger is down on a table cell
 * and restored when the touch ends.
 *
 * This reduces the flicker rather than removing it: the caret iOS draws
 * around its magnifier during the gesture is not affected by `caret-color`.
 */
export function registerIOSTableDragCaretHiding(
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
    // Passive, so a touch scroll starting in the editor does not wait on it.
    const options = {capture: true, passive: true};
    // The inline caret-color found at touchstart, or null when not hiding.
    let restoreCaretColor: null | string = null;
    let removeTargetListeners = () => {};

    // Core's block cursor also writes the root's caret-color: it sets
    // `transparent` while shown and removes the property when it goes away,
    // which can happen mid-gesture. Restoring the touchstart value blindly
    // would then leave the caret hidden everywhere.
    const restore = () => {
      removeTargetListeners();
      const saved = restoreCaretColor;
      restoreCaretColor = null;
      if (
        saved === null ||
        // Changed by someone else during the gesture: theirs now.
        rootElement.style.caretColor !== 'transparent' ||
        // The block cursor is shown and owns the transparent caret.
        rootElement.querySelector('[data-lexical-cursor]') !== null
      ) {
        return;
      }
      rootElement.style.caretColor = saved;
    };

    const onTouchStart = (event: TouchEvent) => {
      const target = getComposedEventTarget(event);
      if (
        restoreCaretColor !== null ||
        !editor.isEditable() ||
        !isHTMLElement(target)
      ) {
        return;
      }
      const cell = target.closest('td,th');
      // Else an editor inside a page <td> hides its caret on every touch.
      if (cell === null || !rootElement.contains(cell)) {
        return;
      }
      restoreCaretColor = rootElement.style.caretColor;
      rootElement.style.caretColor = 'transparent';
      // A touch keeps its target even when it is removed mid-touch (the
      // empty cell overlay's timer), and its lift then never reaches the window.
      removeTargetListeners = registerEventListeners(
        target,
        {touchcancel: onTouchEnd, touchend: onTouchEnd},
        options,
      );
    };

    const onTouchEnd = (event: TouchEvent) => {
      // A second finger lifting is not the end of the gesture.
      if (restoreCaretColor !== null && event.touches.length === 0) {
        restore();
      }
    };

    return mergeRegister(
      registerEventListener(rootElement, 'touchstart', onTouchStart, options),
      // On the window, since the finger can be lifted outside the editor.
      registerEventListeners(
        view,
        {touchcancel: onTouchEnd, touchend: onTouchEnd},
        options,
      ),
      restore,
    );
  });
}
