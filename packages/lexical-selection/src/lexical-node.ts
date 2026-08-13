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
  $getCharacterOffsets,
  $getNodeByKey,
  $getPreviousSelection,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isRootNode,
  $isTextNode,
  $isTokenOrSegmented,
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
  const anchorAndFocus = selection.getStartEndPoints();
  if (
    textNode.isSelected(selection) &&
    !$isTokenOrSegmented(textNode) &&
    anchorAndFocus !== null
  ) {
    const [anchor, focus] = anchorAndFocus;
    const isBackward = selection.isBackward();
    const anchorNode = anchor.getNode();
    const focusNode = focus.getNode();
    const isAnchor = textNode.is(anchorNode);
    const isFocus = textNode.is(focusNode);

    if (isAnchor || isFocus) {
      const [anchorOffset, focusOffset] = $getCharacterOffsets(selection);
      const isSame = anchorNode.is(focusNode);
      const isFirst = textNode.is(isBackward ? focusNode : anchorNode);
      const isLast = textNode.is(isBackward ? anchorNode : focusNode);
      let startOffset = 0;
      let endOffset = undefined;

      if (isSame) {
        startOffset = anchorOffset > focusOffset ? focusOffset : anchorOffset;
        endOffset = anchorOffset > focusOffset ? anchorOffset : focusOffset;
      } else if (isFirst) {
        const offset = isBackward ? focusOffset : anchorOffset;
        startOffset = offset;
        endOffset = undefined;
      } else if (isLast) {
        const offset = isBackward ? anchorOffset : focusOffset;
        startOffset = 0;
        endOffset = offset;
      }

      // NOTE: This mutates __text directly because the primary use case is to
      // modify a $cloneWithProperties node that should never be added
      // to the EditorState so we must not call getWritable via setTextContent
      const text = textNode.__text.slice(startOffset, endOffset);
      if (text !== textNode.__text) {
        if (mutates === 'clone') {
          textNode = $cloneWithPropertiesEphemeral(textNode);
        }
        textNode.__text = text;
      }
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
      // Annotation breaks a circular inference through the loop (TS7022),
      // remove when the deprecated generic signatures from #8661 are removed
      const lastDescendant: null | LexicalNode =
        currentNode.getLastDescendant();
      if (lastDescendant !== null) {
        currentNode = lastDescendant;
      }
    }
    // Annotation breaks a circular inference through the loop (TS7022),
    // remove when the deprecated generic signatures from #8661 are removed
    let nextNode: LexicalNode | null = currentNode.getPreviousSibling();
    let additionalElementWhitespace = 0;
    if (nextNode === null) {
      let parent: LexicalNode | null = currentNode.getParentOrThrow();
      // Annotation breaks a circular inference through the loop (TS7022),
      // remove when the deprecated generic signatures from #8661 are removed
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
  $forEachSelectedTextNode(textNode => {
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
  const selection = $getSelection();
  if (!selection) {
    return;
  }

  const slicedTextNodes = new Map<
    NodeKey,
    [startIndex: number, endIndex: number]
  >();
  const getSliceIndices = (
    node: TextNode,
  ): [startIndex: number, endIndex: number] =>
    slicedTextNodes.get(node.getKey()) || [0, node.getTextContentSize()];

  if ($isRangeSelection(selection)) {
    for (const slice of $caretRangeFromSelection(selection).getTextSlices()) {
      if (slice) {
        slicedTextNodes.set(
          slice.caret.origin.getKey(),
          slice.getSliceIndices(),
        );
      }
    }
  }

  const selectedNodes = selection.getNodes();
  for (const selectedNode of selectedNodes) {
    if (!($isTextNode(selectedNode) && selectedNode.canHaveFormat())) {
      continue;
    }
    const [startOffset, endOffset] = getSliceIndices(selectedNode);
    // No actual text is selected, so do nothing.
    if (endOffset === startOffset) {
      continue;
    }

    // The entire node is selected or a token/segment, so just format it
    if (
      $isTokenOrSegmented(selectedNode) ||
      (startOffset === 0 && endOffset === selectedNode.getTextContentSize())
    ) {
      fn(selectedNode);
    } else {
      // The node is partially selected, so split it into two or three nodes
      // and style the selected one.
      const splitNodes = selectedNode.splitText(startOffset, endOffset);
      const replacement = splitNodes[startOffset === 0 ? 0 : 1];
      fn(replacement);
    }
  }
  // Prior to NodeCaret #7046 this would have been a side-effect
  // so we do this for test compatibility.
  // TODO: we may want to consider simplifying by removing this
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
