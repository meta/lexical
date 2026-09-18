/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $caretRangeFromSelection,
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
  getDOMSelection,
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
  /** The maximum number of msec from the triple click to expect a selection change, default `100` */
  thresholdMsec: number;
  /** The clock function used for delay-based merging, default `Date.now` */
  dateNow: () => number;
  /** The update function to call when triple click is detected */
  $fixFocusOverselection: () => void;
}

export interface NormalizeTripleClickSelectionOutput {
  /** `true` to disable this extension */
  disabled: Signal<boolean>;
  /** The maximum number of msec from the triple click to expect a selection change, default `100` */
  thresholdMsec: Signal<number>;
  /** The clock function used for delay-based merging, default `Date.now` */
  dateNow: Signal<() => number>;
  /** The update function to call when triple click is detected */
  $fixFocusOverselection: Signal<() => void>;
}

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
 * `$fixFocusOverselection` callback when it has detected a triple click,
 * but it provides the function as an output signal so that it can both
 * be called from other places and it can be replaced or wrapped with
 * different functionality.
 */
export const NormalizeTripleClickSelectionExtension = defineExtension({
  build: (editor, config, state): NormalizeTripleClickSelectionOutput =>
    namedSignals(config),
  config: safeCast<NormalizeTripleClickSelectionConfig>({
    $fixFocusOverselection,
    dateNow: Date.now,
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
        let lastTripleClick = 0;
        const refreshTripleClick = (event: null | MouseEvent) => {
          if (event ? event.detail > 2 : lastTripleClick > 0) {
            const now = stores.dateNow.peek()();
            lastTripleClick =
              (event && event.type === 'mousedown') ||
              now - lastTripleClick <= stores.thresholdMsec.peek()
                ? now
                : 0;
          }
          return lastTripleClick;
        };
        return mergeRegister(
          editor.registerCommand(
            SELECTION_CHANGE_COMMAND,
            () => {
              if (refreshTripleClick(null)) {
                lastTripleClick = 0;
                stores.$fixFocusOverselection.peek()();
              }
              return false;
            },
            COMMAND_PRIORITY_BEFORE_CRITICAL,
          ),
          registerEventListeners(
            rootElement,
            {mousedown: refreshTripleClick, mouseup: refreshTripleClick},
            true,
          ),
        );
      });
    }),
});
