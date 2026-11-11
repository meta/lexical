/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {getDOMSelection, getDOMSelectionRange, getParentElement} from 'lexical';

import {getElementScale} from './getElementScale';

const VERTICAL_GAP = 10;
const HORIZONTAL_OFFSET = 5;

export function setFloatingElemPosition(
  targetRect: DOMRect | null,
  floatingElem: HTMLElement,
  anchorElem: HTMLElement,
  isLink: boolean = false,
  verticalGap: number = VERTICAL_GAP,
  horizontalOffset: number = HORIZONTAL_OFFSET,
): void {
  const scrollerElem = getParentElement(anchorElem);

  if (targetRect === null || !scrollerElem) {
    floatingElem.style.opacity = '0';
    floatingElem.style.transform = 'translate(-10000px, -10000px)';
    return;
  }

  const floatingElemRect = floatingElem.getBoundingClientRect();
  const anchorElementRect = anchorElem.getBoundingClientRect();
  const editorScrollerRect = scrollerElem.getBoundingClientRect();

  // Every rect above is in on-screen pixels, so the gaps — which are authored
  // in the anchor's own coordinate space — have to be scaled to match before
  // they are mixed in. The result is converted back at the end.
  const scale = getElementScale(anchorElem);
  const verticalGapPx = verticalGap * scale.y;
  const horizontalOffsetPx = horizontalOffset * scale.x;

  let top = targetRect.top - floatingElemRect.height - verticalGapPx;
  let left = targetRect.left - horizontalOffsetPx;

  // Check if text is end-aligned.
  const domSelection = getDOMSelection(anchorElem.ownerDocument.defaultView);
  const range = domSelection && getDOMSelectionRange(domSelection, anchorElem);
  if (range) {
    const textNode = range.startContainer;
    if (textNode.nodeType === Node.ELEMENT_NODE || textNode.parentElement) {
      const textElement =
        textNode.nodeType === Node.ELEMENT_NODE
          ? (textNode as Element)
          : (textNode.parentElement as Element);
      const textAlign = window.getComputedStyle(textElement).textAlign;

      if (textAlign === 'right' || textAlign === 'end') {
        // For end-aligned text, position the toolbar relative to the text end
        left = targetRect.right - floatingElemRect.width + horizontalOffsetPx;
      }
    }
  }

  if (top < editorScrollerRect.top) {
    // adjusted height for link element if the element is at top
    top +=
      floatingElemRect.height +
      targetRect.height +
      verticalGapPx * (isLink ? 9 : 2);
  }

  if (left + floatingElemRect.width > editorScrollerRect.right) {
    left =
      editorScrollerRect.right - floatingElemRect.width - horizontalOffsetPx;
  }

  if (left < editorScrollerRect.left) {
    left = editorScrollerRect.left + horizontalOffsetPx;
  }

  top = (top - anchorElementRect.top) / scale.y;
  left = (left - anchorElementRect.left) / scale.x;

  floatingElem.style.opacity = '1';
  floatingElem.style.transform = `translate(${left}px, ${top}px)`;
}
