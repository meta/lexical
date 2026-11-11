/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $caretRangeFromSelection,
  $createRangeSelectionFromDom,
  $getCaretRange,
  $getCaretRangeInDirection,
  $getChildCaret,
  $getEditor,
  $getPreviousSelection,
  $getSelection,
  $getSiblingCaret,
  $isChildCaret,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isSiblingCaret,
  $isTextPointCaret,
  $normalizeCaret,
  $rewindSiblingCaret,
  $setSelectionFromCaretRange,
  $updateDOMSelection,
  COMMAND_PRIORITY_BEFORE_CRITICAL,
  defineExtension,
  type DOMSelectionBoundaryPoints,
  getDOMSelection,
  getDOMSelectionPoints,
  mergeRegister,
  registerEventListeners,
  safeCast,
  SELECTION_CHANGE_COMMAND,
  SKIP_SCROLL_INTO_VIEW_TAG,
  SKIP_SELECTION_FOCUS_TAG,
} from 'lexical';

import {namedSignals} from './namedSignals';
import {effect, type Signal} from './signals';

export interface NormalizeTripleClickSelectionConfig {
  /** `true` to disable this extension */
  disabled: boolean;
  /**
   * @deprecated No longer used. A triple click now applies to the next
   * selection change however long it takes to arrive, until another click or
   * a non-modifier keydown anywhere in the document cancels it. Kept so existing configurations still
   * type check.
   */
  thresholdMsec: number;
  /**
   * @deprecated No longer used, see `thresholdMsec`.
   */
  dateNow: () => number;
  /** The update function to call when triple click is detected */
  $fixFocusOverselection: () => void;
}

export interface NormalizeTripleClickSelectionOutput {
  /** `true` to disable this extension */
  disabled: Signal<boolean>;
  /**
   * @deprecated No longer used. A triple click now applies to the next
   * selection change however long it takes to arrive, until another click or
   * a non-modifier keydown anywhere in the document cancels it. Kept so existing configurations still
   * type check.
   */
  thresholdMsec: Signal<number>;
  /**
   * @deprecated No longer used, see `thresholdMsec`.
   */
  dateNow: Signal<() => number>;
  /** The update function to call when triple click is detected */
  $fixFocusOverselection: Signal<() => void>;
}

/** Keys that only modify a following key, so pressing one starts nothing */
const MODIFIER_KEYS = new Set([
  'Alt',
  'AltGraph',
  'CapsLock',
  'Control',
  'Fn',
  'Meta',
  'Shift',
]);

const SKIP_TAGS = new Set([
  SKIP_SELECTION_FOCUS_TAG,
  SKIP_SCROLL_INTO_VIEW_TAG,
]);

function $fixFocusOverselection() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return;
  }
  if (!selection.isCollapsed()) {
    // Triple click causing selection to overflow into the nearest element. In that
    // case visually it looks like a single element content is selected, focus node
    // is actually at the beginning of the next element (if present) and any manipulations
    // with selection (formatting) are affecting second element as well
    const range = $getCaretRangeInDirection(
      $caretRangeFromSelection(selection),
      'next',
    );
    let focusCaret = range.focus;
    // Move it out of the next TextNode if none of it is selected
    if (
      $isTextPointCaret(focusCaret) &&
      range.anchor.origin !== focusCaret.origin &&
      focusCaret.offset === 0
    ) {
      focusCaret = $rewindSiblingCaret(focusCaret.getSiblingCaret());
    }
    // Move it behind a single LineBreakNode
    if (
      $isSiblingCaret(focusCaret) &&
      range.anchor.origin !== focusCaret.origin &&
      $isLineBreakNode(focusCaret.origin)
    ) {
      focusCaret = $rewindSiblingCaret(focusCaret);
    }
    // Move the focus out of the start of any elements
    while (
      $isChildCaret(focusCaret) &&
      range.anchor.origin !== focusCaret.origin
    ) {
      focusCaret = $rewindSiblingCaret(
        $getSiblingCaret(focusCaret.origin, 'next'),
      );
    }
    // Move it inside the containing element
    if ($isSiblingCaret(focusCaret) && $isElementNode(focusCaret.origin)) {
      focusCaret = $normalizeCaret(
        $getChildCaret(focusCaret.origin, 'previous'),
      ).getFlipped();
    }
    focusCaret = $normalizeCaret(focusCaret);
    if (!focusCaret.isSamePointCaret(range.focus)) {
      const sel = $setSelectionFromCaretRange(
        $getCaretRange(range.anchor, focusCaret),
      );
      const editor = $getEditor();
      const rootElement = editor.getRootElement();
      const domSelection =
        rootElement && getDOMSelection(rootElement.ownerDocument.defaultView);
      if (domSelection) {
        // This native triple-click correction intentionally updates the browser
        // range synchronously on already-mounted nodes. General selection UI
        // must defer DOM reads until reconciliation has completed.
        $updateDOMSelection(
          $getPreviousSelection(),
          sel,
          $getEditor(),
          domSelection,
          SKIP_TAGS,
          rootElement,
        );
      }
    }
  }
}

/**
 * This extension handles triple-click events and will move the focus
 * towards the anchor in certain conditions to meet expectations.
 * Simply speaking, the focus should prefer to land at the end of a node
 * rather than the beginning of its next sibling, and it should not skip
 * over a LineBreakNode.
 *
 * In order to fix the result visually and avoid a flash of over-selection
 * it will also eagerly manipulate the DOM selection directly.
 *
 * It is conservative in that it only fires this
 * `$fixFocusOverselection` callback on the first selection change after a
 * triple click in the editor (and before any other keydown or click),
 * but it provides the function as an output signal so that it can both
 * be called from other places and it can be replaced or wrapped with
 * different functionality.
 */
export const NormalizeTripleClickSelectionExtension = defineExtension({
  build: (editor, config, state): NormalizeTripleClickSelectionOutput =>
    namedSignals(config),
  config: safeCast<NormalizeTripleClickSelectionConfig>({
    $fixFocusOverselection,
    // Unused (deprecated). Wrapped rather than passing `Date.now` itself: a
    // module-scope property read is a side effect to bundlers, which would pin
    // this extension into every bundle that imports the module.
    dateNow: () => Date.now(),
    disabled: false,
    thresholdMsec: 100,
  }),
  name: '@lexical/NormalizeTripleClickSelection',
  register: (editor, config, state) =>
    effect(() => {
      const stores = state.getOutput();
      if (stores.disabled.value) {
        return;
      }
      return editor.registerRootListener(rootElement => {
        if (!rootElement) {
          return;
        }
        // Armed by a triple (or later) click's mousedown and consumed by the
        // next selection change. This is ordered by events rather than by a
        // clock: the browser applies the paragraph selection as the default
        // action of that mousedown, so any selection change after it reads at
        // least that selection, however late the selectionchange event is
        // handled on a busy machine. Any other pointerdown, mousedown or
        // keydown in the document (including a toolbar outside the editor,
        // even one that cancels its mousedown to keep focus) starts a new
        // interaction and disarms it. Modifier keys on their own don't, since
        // they only begin a shortcut.
        //
        // The arm has no time limit, so a triple click that changed nothing
        // stays armed. A selection change still only gets trimmed when it
        // matches the DOM selection, i.e. it came from the browser rather
        // than from code (undo, collab, a third-click handler), whose new
        // selection is not in the DOM yet when the change is reported.
        //
        // Once a selection set by code has been written to the DOM, the
        // browser's selection is gone, and the selectionchange reporting that
        // write would match the DOM too. So the arm is dropped without a trim
        // when the commit of such a selection changes the DOM selection (unless
        // that happened while the mousedown was still being dispatched, since
        // its default action then replaces it with the browser's selection),
        // and when the triple click's mousedown was cancelled, since the
        // browser then makes no selection at all.
        let armingEvent: MouseEvent | null = null;
        // The DOM selection when a selection set by code was reported, until
        // that update is committed
        let domPointsBeforeCode: null | DOMSelectionBoundaryPoints = null;
        const disarm = () => {
          armingEvent = null;
          domPointsBeforeCode = null;
        };
        const readDOMPoints = (): DOMSelectionBoundaryPoints => {
          const domSelection = getDOMSelection(
            rootElement.ownerDocument.defaultView,
          );
          if (domSelection === null) {
            return {
              anchorNode: null,
              anchorOffset: 0,
              focusNode: null,
              focusOffset: 0,
            };
          }
          const {anchorNode, anchorOffset, focusNode, focusOffset} =
            getDOMSelectionPoints(domSelection, rootElement);
          return {anchorNode, anchorOffset, focusNode, focusOffset};
        };
        const isSameDOMPoints = (
          a: DOMSelectionBoundaryPoints,
          b: DOMSelectionBoundaryPoints,
        ) =>
          a.anchorNode === b.anchorNode &&
          a.anchorOffset === b.anchorOffset &&
          a.focusNode === b.focusNode &&
          a.focusOffset === b.focusOffset;
        const $isDOMSelection = () => {
          const selection = $getSelection();
          const fromDOM = $createRangeSelectionFromDom(
            getDOMSelection(rootElement.ownerDocument.defaultView),
            editor,
          );
          return (
            $isRangeSelection(selection) &&
            fromDOM !== null &&
            // Points only: the browser's selection carries the format and
            // style of the selected text, the one rebuilt from the DOM doesn't
            selection.anchor.is(fromDOM.anchor) &&
            selection.focus.is(fromDOM.focus)
          );
        };
        return mergeRegister(
          editor.registerCommand(
            SELECTION_CHANGE_COMMAND,
            () => {
              if (armingEvent === null) {
                return false;
              }
              if (armingEvent.defaultPrevented) {
                disarm();
              } else if ($isDOMSelection()) {
                disarm();
                stores.$fixFocusOverselection.peek()();
              } else if (domPointsBeforeCode === null) {
                domPointsBeforeCode = readDOMPoints();
              }
              return false;
            },
            COMMAND_PRIORITY_BEFORE_CRITICAL,
          ),
          editor.registerUpdateListener(() => {
            if (armingEvent === null || domPointsBeforeCode === null) {
              return;
            }
            if (
              armingEvent.eventPhase === Event.NONE &&
              !isSameDOMPoints(domPointsBeforeCode, readDOMPoints())
            ) {
              disarm();
            } else {
              domPointsBeforeCode = null;
            }
          }),
          registerEventListeners(
            rootElement.ownerDocument,
            {
              keydown: (event: KeyboardEvent) => {
                if (!MODIFIER_KEYS.has(event.key)) {
                  disarm();
                }
              },

              mousedown: (event: MouseEvent) => {
                disarm();
                // composedPath sees through shadow roots that retarget the event
                if (
                  event.detail > 2 &&
                  event.composedPath().includes(rootElement)
                ) {
                  armingEvent = event;
                }
              },
              // Not cancelled by preventDefault, unlike mousedown, and always
              // dispatched before it (with detail 0)
              pointerdown: disarm,
            },
            true,
          ),
        );
      });
    }),
});
