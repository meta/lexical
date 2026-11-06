/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {LexicalEditor, LexicalNode, NodeKey} from 'lexical';

import {effect, namedSignals, type Signal} from '@lexical/extension';
import {$findMatchingParent} from '@lexical/utils';
import {
  $addUpdateTag,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  defineExtension,
  getActiveElement,
  INDENT_CONTENT_COMMAND,
  isDOMNode,
  OUTDENT_CONTENT_COMMAND,
  registerEventListeners,
  safeCast,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical';

import {$isListItemNode} from './LexicalListItemNode';

const DEFAULT_SWIPE_THRESHOLD = 50;
const DEFAULT_VERTICAL_GUARD = 50;

/**
 * Returns the key of the list item under the given DOM target, or null if
 * the target is not inside a list item.
 */
function $getListItemKeyFromTarget(target: EventTarget | null): NodeKey | null {
  if (!isDOMNode(target)) {
    return null;
  }
  const node = $getNearestNodeFromDOMNode(target);
  if (node === null) {
    return null;
  }
  const listItem = $findMatchingParent(node, $isListItemNode);
  return listItem && listItem.getKey();
}

/** True if `node` is `ancestor` or one of its descendants. */
function $isWithin(node: LexicalNode, ancestor: LexicalNode): boolean {
  return node.is(ancestor) || ancestor.isParentOf(node);
}

/** True if the focused element is the editor root or inside it. */
function editorHasFocus(editor: LexicalEditor): boolean {
  const rootElement = editor.getRootElement();
  if (rootElement === null) {
    return false;
  }
  const activeElement = getActiveElement(rootElement);
  return activeElement !== null && rootElement.contains(activeElement);
}

function $indentListItem(
  editor: LexicalEditor,
  listItemKey: NodeKey,
  indent: boolean,
): void {
  const listItem = $getNodeByKey(listItemKey);
  if (!$isListItemNode(listItem)) {
    return;
  }
  const command = indent ? INDENT_CONTENT_COMMAND : OUTDENT_CONTENT_COMMAND;
  const selection = $getSelection();

  // A blurred editor keeps its Lexical selection. Applying it to the DOM
  // would focus the editor again, so in that case leave the DOM alone.
  const hasFocus = editorHasFocus(editor);

  let selectionTouchesItem = false;
  if ($isRangeSelection(selection)) {
    const anchorNode = selection.anchor.getNode();
    const focusNode = selection.focus.getNode();

    // The selection is entirely in the swiped item, so the command already
    // targets it. Leave the selection alone to keep exact text positions.
    if (
      $findMatchingParent(anchorNode, node => node.is(listItem)) &&
      $findMatchingParent(focusNode, node => node.is(listItem))
    ) {
      if (!hasFocus) {
        $addUpdateTag(SKIP_DOM_SELECTION_TAG);
      }
      editor.dispatchCommand(command, undefined);
      return;
    }

    selectionTouchesItem =
      $isWithin(anchorNode, listItem) || $isWithin(focusNode, listItem);
  }

  const previousSelection = selection && selection.clone();

  // Use commands instead of `setIndent` so any restrictions in their
  // handlers are respected.
  listItem.selectEnd();
  editor.dispatchCommand(command, undefined);

  // Preserve the native selection only if it isn't inside the item that was
  // just moved in the DOM (otherwise Lexical must re-apply it), or if the
  // editor isn't focused (re-applying it would steal focus).
  if (!selectionTouchesItem || !hasFocus) {
    $addUpdateTag(SKIP_DOM_SELECTION_TAG);
  }
  $setSelection(previousSelection);
}

function registerTouchIndentation(
  editor: LexicalEditor,
  swipeThreshold: Signal<number>,
): () => void {
  return editor.registerRootListener(rootElement => {
    if (rootElement !== null) {
      let startX = 0;
      let startY = 0;
      let isSwiping = false;
      let targetListItemKey: NodeKey | null = null;

      const reset = () => {
        isSwiping = false;
        targetListItemKey = null;
      };

      const handleTouchStart = (event: TouchEvent) => {
        reset();
        if (event.touches.length > 1) {
          return;
        }
        const touch = event.touches[0];
        if (touch != null && editor.isEditable()) {
          startX = touch.clientX;
          startY = touch.clientY;
          targetListItemKey = editor.read('latest', () =>
            $getListItemKeyFromTarget(event.target),
          );
        }
      };

      const handleTouchMove = (event: TouchEvent) => {
        if (targetListItemKey === null || event.touches.length > 1) {
          return;
        }
        const touch = event.touches[0];
        if (touch != null) {
          const deltaX = touch.clientX - startX;
          const deltaY = touch.clientY - startY;
          if (
            Math.abs(deltaX) > swipeThreshold.peek() &&
            Math.abs(deltaY) < DEFAULT_VERTICAL_GUARD
          ) {
            isSwiping = true;
            event.preventDefault();
          }
        }
      };

      const handleTouchEnd = (event: TouchEvent) => {
        const listItemKey = targetListItemKey;
        const wasSwiping = isSwiping;
        reset();
        if (!wasSwiping || listItemKey === null) {
          return;
        }
        const touch = event.changedTouches[0];
        if (touch != null) {
          const deltaX = touch.clientX - startX;
          const deltaY = touch.clientY - startY;
          if (
            Math.abs(deltaX) > swipeThreshold.peek() &&
            Math.abs(deltaY) < DEFAULT_VERTICAL_GUARD
          ) {
            editor.update(() => {
              $indentListItem(editor, listItemKey, deltaX > 0);
            });
          }
        }
      };

      return registerEventListeners(
        rootElement,
        {
          touchend: handleTouchEnd,
          touchmove: handleTouchMove,
          touchstart: handleTouchStart,
        },
        {
          capture: true,
          passive: false,
        },
      );
    }
  });
}

export interface TouchIndentationConfig {
  /**
   * Turns swipe-to-indent off when `true`. Defaults to `false`.
   * This can be changed at runtime and takes effect immediately.
   */
  disabled: boolean;
  /**
   * The minimum horizontal distance, in pixels, a finger must travel
   * before a swipe counts as an indent or outdent. Defaults to `50`.
   *
   * Lower values make swiping more sensitive. Higher values require a
   * longer swipe and help avoid accidental indents.
   */
  swipeThreshold: number;
}

/**
 * Adds swipe gestures for indenting list items on touch devices.
 *
 * Swiping right on a list item with one finger indents it, and swiping
 * left outdents it. The swipe applies to the list item you touch, even if
 * the caret is somewhere else in the editor, and the caret stays where it
 * was. The gesture only counts if the swipe is mostly horizontal, so
 * normal vertical scrolling and text selection are not affected. Swipes
 * are ignored when the editor is read-only or when more than one finger
 * is touching the screen.
 */
export const TouchIndentationExtension = defineExtension({
  build(editor, config, state) {
    return namedSignals(config);
  },
  config: safeCast<TouchIndentationConfig>({
    disabled: false,
    swipeThreshold: DEFAULT_SWIPE_THRESHOLD,
  }),
  name: '@lexical/extension/TouchIndentation',
  register(editor, config, state) {
    const {disabled, swipeThreshold} = state.getOutput();
    return effect(() => {
      if (!disabled.value) {
        return registerTouchIndentation(editor, swipeThreshold);
      }
    });
  },
});
