/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from 'lexical';

import {$findMatchingParent} from '@lexical/utils';
import {
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  defineExtension,
  INDENT_CONTENT_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  safeCast,
} from 'lexical';

import {namedSignals} from './namedSignals';
import {effect} from './signals';

const DEFAULT_SWIPE_THRESHOLD = 50;
const DEFAULT_VERTICAL_GUARD = 30;

function $isSelectionInListItem(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return false;
  }
  const node = selection.anchor.getNode();
  const listItem = $findMatchingParent(
    node,
    parent => $isElementNode(parent) && parent.getType() === 'listitem',
  );
  return listItem != null;
}

export function registerTouchIndentation(
  editor: LexicalEditor,
  swipeThreshold: number = DEFAULT_SWIPE_THRESHOLD,
): () => void {
  return editor.registerRootListener(rootElement => {
    if (rootElement !== null) {
      let startX = 0;
      let startY = 0;
      let isSwiping = false;
      let isInListItem = false;

      const handleTouchStart = (event: TouchEvent) => {
        if (event.touches.length > 1) {
          return;
        }
        const touch = event.touches[0];
        if (touch != null && editor.isEditable()) {
          startX = touch.clientX;
          startY = touch.clientY;
          isSwiping = false;
          isInListItem = editor.read(() => $isSelectionInListItem());
        }
      };

      const handleTouchMove = (event: TouchEvent) => {
        if (!isInListItem || event.touches.length > 1) {
          return;
        }
        const touch = event.touches[0];
        if (touch != null) {
          const deltaX = touch.clientX - startX;
          const deltaY = touch.clientY - startY;
          if (
            Math.abs(deltaX) > swipeThreshold &&
            Math.abs(deltaY) < DEFAULT_VERTICAL_GUARD
          ) {
            isSwiping = true;
            event.preventDefault();
          }
        }
      };

      const handleTouchEnd = (event: TouchEvent) => {
        if (!isSwiping) {
          isSwiping = false;
          isInListItem = false;
          return;
        }
        const touch = event.changedTouches[0];
        if (touch != null) {
          const deltaX = touch.clientX - startX;
          const deltaY = touch.clientY - startY;
          if (
            Math.abs(deltaX) > swipeThreshold &&
            Math.abs(deltaY) < DEFAULT_VERTICAL_GUARD
          ) {
            event.preventDefault();
            if (deltaX > 0) {
              editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);
            } else {
              editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
            }
          }
        }
        isSwiping = false;
        isInListItem = false;
      };

      rootElement.addEventListener('touchstart', handleTouchStart, {
        capture: true,
        passive: true,
      });
      rootElement.addEventListener('touchmove', handleTouchMove, {
        capture: true,
        passive: false,
      });
      rootElement.addEventListener('touchend', handleTouchEnd, {
        capture: true,
        passive: false,
      });

      return () => {
        rootElement.removeEventListener('touchstart', handleTouchStart, {
          capture: true,
        });
        rootElement.removeEventListener('touchmove', handleTouchMove, {
          capture: true,
        });
        rootElement.removeEventListener('touchend', handleTouchEnd, {
          capture: true,
        });
      };
    }
  });
}

export interface TouchIndentationConfig {
  disabled: boolean;
  swipeThreshold: number;
}

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
        return registerTouchIndentation(editor, swipeThreshold.value);
      }
    });
  },
});
