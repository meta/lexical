/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import invariant from '@lexical/internal/invariant';
import warnOnlyOnce from '@lexical/internal/warnOnlyOnce';
import {
  $caretRangeFromSelection,
  $cloneWithPropertiesEphemeral,
  $createTextNode,
  $getNodeByKey,
  $getPreviousSelection,
  $getSelection,
  $getTextPointCaretSliceForNode,
  $isElementNode,
  $isRangeSelection,
  $isRootNode,
  $isTextNode,
  $isTokenOrSegmented,
  $splitTextPointCaretSlice,
  type BaseSelection,
  type ElementNode,
  getStyleObjectFromCSS,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type Point,
  type RangeSelection,
  type TextNode,
} from 'lexical';

import {getCSSFromStyleObject} from './utils';

/**
 * Generally used to append text content to HTML and JSON. Grabs the text content and "slices"
 * it to be generated into the new TextNode.
 * @param selection - The selection containing the node whose TextNode is to be edited.
 * @param textNode - The TextNode to be edited.
 * @param mutates - 'clone' to return a clone before mutating, 'self' to update in-place
 * @returns The updated TextNode or clone.
 */
export function $sliceSelectedTextNodeContent<T extends TextNode>(
  selection: BaseSelection,
  textNode: T,
  mutates: 'clone' | 'self' = 'self',
): T {
  const points = selection.getStartEndPoints();
  // Only the node of a text point can be cut short; checking that first
  // keeps a caller that slices every selected node from working out the
  // selection for each of them.
  if (
    points !== null &&
    (points[0].key === textNode.__key || points[1].key === textNode.__key) &&
    textNode.isSelected(selection) &&
    !$isTokenOrSegmented(textNode)
  ) {
    const [start, end] = selection.isBackward()
      ? [points[1], points[0]]
      : points;
    // Text endpoints can trim directly. Element endpoints need caret
    // normalization so equivalent mixed points produce an empty interval.
    const slice =
      $isRangeSelection(selection) &&
      (start.type === 'element' || end.type === 'element')
        ? $getTextPointCaretSliceForNode(
            $caretRangeFromSelection(selection).getTextSlices(),
            textNode,
          )
        : undefined;
    const [startOffset, endOffset] = slice
      ? slice.getSliceIndices()
      : [
          textNode.__key === start.key ? start.offset : 0,
          textNode.__key === end.key ? end.offset : undefined,
        ];
    const text = textNode.__text.slice(startOffset, endOffset);
    // This may be an ephemeral clone: do not resolve getLatest() or insert
    // it into the editor state when changing its own text.
    if (text !== textNode.__text) {
      if (mutates === 'clone') {
        textNode = $cloneWithPropertiesEphemeral(textNode);
      }
      textNode.__text = text;
    }
  }
  return textNode;
}

/**
 * Determines if the current selection is at the end of the node.
 * @param point - The point of the selection to test.
 * @returns true if the provided point offset is in the last possible position, false otherwise.
 */
export function $isAtNodeEnd(point: Point): boolean {
  if (point.type === 'text') {
    return point.offset === point.getNode().getTextContentSize();
  }
  const node = point.getNode();
  invariant(
    $isElementNode(node),
    'isAtNodeEnd: node must be a TextNode or ElementNode',
  );

  return point.offset === node.getChildrenSize();
}

/**
 * Trims text from a node in order to shorten it, eg. to enforce a text's max length. If it deletes text
 * that is an ancestor of the anchor then it will leave 2 indents, otherwise, if no text content exists, it deletes
 * the TextNode. It will move the focus to either the end of any left over text or beginning of a new TextNode.
 * @param editor - The lexical editor.
 * @param anchor - The anchor of the current selection, where the selection should be pointing.
 * @param delCount - The amount of characters to delete. Useful as a dynamic variable eg. textContentSize - maxLength;
 */
export function $trimTextContentFromAnchor(
  editor: LexicalEditor,
  anchor: Point,
  delCount: number,
): void {
  // Work from the current selection anchor point
  let currentNode: LexicalNode | null = anchor.getNode();
  let remaining: number = delCount;

  if ($isElementNode(currentNode)) {
    const descendantNode = currentNode.getDescendantByIndex(anchor.offset);
    if (descendantNode !== null) {
      currentNode = descendantNode;
    }
  }

  while (remaining > 0 && currentNode !== null) {
    if ($isElementNode(currentNode)) {
      const lastDescendant: null | LexicalNode =
        currentNode.getLastDescendant();
      if (lastDescendant !== null) {
        currentNode = lastDescendant;
      }
    }
    let nextNode: LexicalNode | null = currentNode.getPreviousSibling();
    let additionalElementWhitespace = 0;
    if (nextNode === null) {
      let parent: LexicalNode | null = currentNode.getParentOrThrow();
      let parentSibling: LexicalNode | null = parent.getPreviousSibling();

      while (parentSibling === null) {
        parent = parent.getParent();
        if (parent === null) {
          nextNode = null;
          break;
        }
        parentSibling = parent.getPreviousSibling();
      }
      if (parent !== null) {
        additionalElementWhitespace = parent.isInline() ? 0 : 2;
        nextNode = parentSibling;
      }
    }
    let text = currentNode.getTextContent();
    // If the text is empty, we need to consider adding in two line breaks to match
    // the content if we were to get it from its parent.
    if (text === '' && $isElementNode(currentNode) && !currentNode.isInline()) {
      // TODO: should this be handled in core?
      text = '\n\n';
    }
    const currentNodeSize = text.length;

    if (!$isTextNode(currentNode) || remaining >= currentNodeSize) {
      const parent = currentNode.getParent();
      currentNode.remove();
      if (
        parent != null &&
        parent.getChildrenSize() === 0 &&
        !$isRootNode(parent)
      ) {
        parent.remove();
      }
      remaining -= currentNodeSize + additionalElementWhitespace;
      currentNode = nextNode;
    } else {
      const key = currentNode.getKey();
      // See if we can just revert it to what was in the last editor state
      const prevTextContent: string | null = editor.read('latest', () => {
        const prevNode = $getNodeByKey(key);
        if ($isTextNode(prevNode) && prevNode.isSimpleText()) {
          return prevNode.getTextContent();
        }
        return null;
      });
      const offset = currentNodeSize - remaining;
      const slicedText = text.slice(0, offset);
      if (prevTextContent !== null && prevTextContent !== text) {
        const prevSelection = $getPreviousSelection();
        let target = currentNode;
        if (!currentNode.isSimpleText()) {
          const textNode = $createTextNode(prevTextContent);
          currentNode.replace(textNode);
          target = textNode;
        } else {
          currentNode.setTextContent(prevTextContent);
        }
        if ($isRangeSelection(prevSelection) && prevSelection.isCollapsed()) {
          const prevOffset = prevSelection.anchor.offset;
          target.select(prevOffset, prevOffset);
        }
      } else if (currentNode.isSimpleText()) {
        // Split text
        const isSelected = anchor.key === key;
        let anchorOffset = anchor.offset;
        // Move offset to end if it's less than the remaining number, otherwise
        // we'll have a negative splitStart.
        if (anchorOffset < remaining) {
          anchorOffset = currentNodeSize;
        }
        const splitStart = isSelected ? anchorOffset - remaining : 0;
        const splitEnd = isSelected ? anchorOffset : offset;
        if (isSelected && splitStart === 0) {
          const [excessNode] = currentNode.splitText(splitStart, splitEnd);
          excessNode.remove();
        } else {
          const [, excessNode] = currentNode.splitText(splitStart, splitEnd);
          excessNode.remove();
        }
      } else {
        const textNode = $createTextNode(slicedText);
        currentNode.replace(textNode);
      }
      remaining = 0;
    }
  }
}

/**
 * @deprecated node styles are parsed on demand and not cached eternally
 */
export const $addNodeStyle: (_node: TextNode) => void = warnOnlyOnce(
  '$addNodeStyle is a deprecated no-op and calls should be removed',
);

/**
 * Applies the provided styles to the given TextNode, ElementNode, or
 * collapsed RangeSelection.
 *
 * @param target - The TextNode, ElementNode, or collapsed RangeSelection to apply the styles to
 * @param patch - The patch to apply, which can include multiple styles. \\{CSSProperty: value\\} . Can also accept a function that returns the new property value.
 */
export function $patchStyle(
  target: TextNode | RangeSelection | ElementNode,
  patch: Record<
    string,
    | string
    | null
    | ((currentStyleValue: string | null, _target: typeof target) => string)
  >,
): void {
  invariant(
    $isRangeSelection(target)
      ? target.isCollapsed()
      : $isTextNode(target) || $isElementNode(target),
    '$patchStyle must only be called with a TextNode, ElementNode, or collapsed RangeSelection',
  );
  const prevStyles = getStyleObjectFromCSS(
    $isRangeSelection(target)
      ? target.style
      : $isTextNode(target)
        ? target.getStyle()
        : target.getTextStyle(),
  );
  const newStyles = Object.entries(patch).reduce<Record<string, string>>(
    (styles, [key, value]) => {
      if (typeof value === 'function') {
        styles[key] = value(prevStyles[key], target);
      } else if (value === null) {
        delete styles[key];
      } else {
        styles[key] = value;
      }
      return styles;
    },
    {...prevStyles},
  );
  const newCSSText = getCSSFromStyleObject(newStyles);
  if ($isRangeSelection(target) || $isTextNode(target)) {
    target.setStyle(newCSSText);
  } else {
    target.setTextStyle(newCSSText);
  }
}

/**
 * Applies the provided styles to the TextNodes in the provided Selection.
 * Will update partially selected TextNodes by splitting the TextNode and applying
 * the styles to the appropriate one.
 * @param selection - The selected node(s) to update.
 * @param patch - The patch to apply, which can include multiple styles. \\{CSSProperty: value\\} . Can also accept a function that returns the new property value.
 */
export function $patchStyleText(
  selection: BaseSelection,
  patch: Record<
    string,
    | string
    | null
    | ((
        currentStyleValue: string | null,
        target: TextNode | RangeSelection | ElementNode,
      ) => string)
  >,
): void {
  // Shared with the empty-element loop below so that a node patched here is
  // not patched a second time. A function-valued patch is not idempotent —
  // it is evaluated against the value the previous application wrote.
  const patchedElementKeys = new Set<NodeKey>();
  if ($isRangeSelection(selection) && selection.isCollapsed()) {
    $patchStyle(selection, patch);
    const emptyNode = selection.anchor.getNode();
    if ($isElementNode(emptyNode) && emptyNode.isEmpty()) {
      patchedElementKeys.add(emptyNode.getKey());
      $patchStyle(emptyNode, patch);
    }
  }
  $forEachSelectedTextNodeInSelection(selection, textNode => {
    $patchStyle(textNode, patch);
  });

  const nodes = selection.getNodes();
  if (nodes.length > 0) {
    for (const node of nodes) {
      if (
        !$isElementNode(node) ||
        !node.canBeEmpty() ||
        node.getChildrenSize() !== 0
      ) {
        continue;
      }
      const key = node.getKey();
      if (patchedElementKeys.has(key)) {
        continue;
      }
      patchedElementKeys.add(key);
      $patchStyle(node, patch);
    }
  }
}

export function $forEachSelectedTextNode(
  fn: (textNode: TextNode) => void,
): void {
  $forEachSelectedTextNodeInSelection($getSelection(), fn);
}

function $forEachSelectedTextNodeInSelection(
  selection: BaseSelection | null,
  fn: (textNode: TextNode) => void,
): void {
  if (!selection) {
    return;
  }
  const slices = $isRangeSelection(selection)
    ? $caretRangeFromSelection(selection).getTextSlices()
    : [];
  for (const node of selection.getNodes()) {
    if (!$isTextNode(node) || !node.canHaveFormat()) {
      continue;
    }
    const slice = $getTextPointCaretSliceForNode(slices, node);
    if (slice ? slice.distance === 0 : node.getTextContentSize() === 0) {
      continue;
    }
    fn(
      slice && !$isTokenOrSegmented(node)
        ? $splitTextPointCaretSlice(
            slice,
            $isRangeSelection(selection) ? selection : null,
          )!
        : node,
    );
  }
  // Preserve the existing single-text-node forward selection convention.
  if (
    $isRangeSelection(selection) &&
    selection.anchor.type === 'text' &&
    selection.focus.type === 'text' &&
    selection.anchor.key === selection.focus.key
  ) {
    $ensureForwardRangeSelection(selection);
  }
}

/**
 * Ensure that the given RangeSelection is not backwards. If it
 * is backwards, then the anchor and focus points will be swapped
 * in-place. Ensuring that the selection is a writable RangeSelection
 * is the responsibility of the caller (e.g. in a read-only context
 * you will want to clone $getSelection() before using this).
 *
 * @param selection a writable RangeSelection
 */
export function $ensureForwardRangeSelection(selection: RangeSelection): void {
  if (selection.isBackward()) {
    const {anchor, focus} = selection;
    // stash for the in-place swap
    const {key, offset, type} = anchor;
    anchor.set(focus.key, focus.offset, focus.type);
    focus.set(key, offset, type);
  }
}
