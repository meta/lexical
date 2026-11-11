/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {
  $createOverflowNode,
  $isOverflowNode,
  OverflowNode,
} from '@lexical/overflow';
import {$rootTextContent} from '@lexical/text';
import {$dfsWithSlots, $unwrapNode} from '@lexical/utils';
import {
  $findMatchingParent,
  $getSelection,
  $getSlotHost,
  $isElementNode,
  $isLeafNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  DELETE_CHARACTER_COMMAND,
  HISTORY_MERGE_TAG,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
} from 'lexical';
import {useEffect} from 'react';

type OptionalProps = {
  remainingCharacters?: (characters: number) => void;
  strlen?: (input: string) => number;
};

export function useCharacterLimit(
  editor: LexicalEditor,
  maxCharacters: number,
  optional: OptionalProps = Object.freeze({}),
): void {
  const {
    strlen = input => input.length,
    // UTF-16
    remainingCharacters = () => {
      return;
    },
  } = optional;

  useEffect(() => {
    if (!editor.hasNodes([OverflowNode])) {
      invariant(
        false,
        'useCharacterLimit: OverflowNode not registered on editor',
      );
    }
  }, [editor]);

  useEffect(() => {
    let text = editor.read('latest', $rootTextContent);
    let lastComputedTextLength: null | number = null;

    // Not `$`-prefixed: this runs outside an update/read context (from the
    // effect body and from listener callbacks) and opens its own
    // editor.update() for the OverflowNode wrapping.
    function updateCharacterLimit(): void {
      const textLength = strlen(text);
      const textLengthAboveThreshold =
        textLength > maxCharacters ||
        (lastComputedTextLength !== null &&
          lastComputedTextLength > maxCharacters);
      const diff = maxCharacters - textLength;

      remainingCharacters(diff);

      if (lastComputedTextLength === null || textLengthAboveThreshold) {
        const offset = findOffset(text, maxCharacters, strlen);
        editor.update(
          () => {
            $wrapOverflowedNodes(offset);
          },
          {
            tag: HISTORY_MERGE_TAG,
          },
        );
      }

      lastComputedTextLength = textLength;
    }

    // Derive the count from the content that is already there before
    // subscribing. registerUpdateListener does not fire on registration, so
    // otherwise both the reported count and the OverflowNode wrapping stay at
    // their initial values until the next edit.
    updateCharacterLimit();

    return mergeRegister(
      editor.registerTextContentListener((currentText: string) => {
        text = currentText;
      }),
      editor.registerUpdateListener(({dirtyLeaves, dirtyElements}) => {
        const isComposing = editor.isComposing();
        const hasContentChanges =
          dirtyLeaves.size > 0 || dirtyElements.size > 0;

        if (isComposing || !hasContentChanges) {
          return;
        }

        updateCharacterLimit();
      }),
      editor.registerCommand(
        DELETE_CHARACTER_COMMAND,
        isBackward => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return false;
          }
          const anchorNode = selection.anchor.getNode();
          const overflow = anchorNode.getParent();
          const overflowParent = overflow ? overflow.getParent() : null;
          const parentNext = overflowParent
            ? overflowParent.getNextSibling()
            : null;
          selection.deleteCharacter(isBackward);
          if (overflowParent && overflowParent.isEmpty()) {
            overflowParent.remove();
          } else if ($isElementNode(parentNext) && parentNext.isEmpty()) {
            parentNext.remove();
          }
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [editor, maxCharacters, remainingCharacters, strlen]);
}

function findOffset(
  text: string,
  maxCharacters: number,
  strlen: (input: string) => number,
): number {
  let offsetUtf16 = 0;
  let offset = 0;

  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter();
    const graphemes = segmenter.segment(text);

    for (const {segment: grapheme} of graphemes) {
      const nextOffset = offset + strlen(grapheme);

      if (nextOffset > maxCharacters) {
        break;
      }

      offset = nextOffset;
      offsetUtf16 += grapheme.length;
    }
  } else {
    const codepoints = Array.from(text);
    const codepointsLength = codepoints.length;

    for (let i = 0; i < codepointsLength; i++) {
      const codepoint = codepoints[i];
      const nextOffset = offset + strlen(codepoint);

      if (nextOffset > maxCharacters) {
        break;
      }

      offset = nextOffset;
      offsetUtf16 += codepoint.length;
    }
  }

  return offsetUtf16;
}

export function $wrapOverflowedNodes(offset: number): void {
  // $dfsWithSlots (not $dfs) so slot-bearing hosts contribute their slot
  // subtree text to the character count and overflow wrapping. Without this
  // a slot-host (e.g. Card with title/body) would report 0 characters and
  // overflow logic would never wrap slotted content.
  const dfsNodes = $dfsWithSlots();
  const dfsNodesLength = dfsNodes.length;
  let accumulatedLength = 0;

  for (let i = 0; i < dfsNodesLength; i += 1) {
    const {node} = dfsNodes[i];

    // ElementNode.getTextContent() inserts '\n\n' after each non-inline
    // element child that is not the last child. findOffset counts those
    // separators (via $rootTextContent), so the DFS must count them too.
    const prevSibling = node.getPreviousSibling();
    if ($isElementNode(prevSibling) && !prevSibling.isInline()) {
      accumulatedLength += 2;
    }

    // Slot value roots (a non-inline DecoratorNode slotted into a host) are
    // leaf nodes with __parent === null; wrapping them in OverflowNode would
    // call node.replace() and throw, so they stay out of the wrap loop. Their
    // text still funds `offset` (root text content folds slotted decorator
    // text in via getSlotsTextContent), so the budget is advanced for them
    // below. Element slot values need no special case: their interior is
    // counted leaf-by-leaf like any other subtree.
    const isSlotValueLeaf = $isLeafNode(node) && $getSlotHost(node) !== null;
    const needsOverflowParent =
      $isLeafNode(node) &&
      !isSlotValueLeaf &&
      !$findMatchingParent(node, $isOverflowNode);

    if ($isOverflowNode(node)) {
      const previousLength = accumulatedLength;
      const nextLength = accumulatedLength + node.getTextContentSize();

      if (nextLength <= offset) {
        const parent = node.getParent();
        const previousSibling = node.getPreviousSibling();
        const nextSibling = node.getNextSibling();
        $unwrapNode(node);
        const selection = $getSelection();

        // Restore selection when the overflow children are removed
        if (
          $isRangeSelection(selection) &&
          (!selection.anchor.getNode().isAttached() ||
            !selection.focus.getNode().isAttached())
        ) {
          if ($isTextNode(previousSibling)) {
            previousSibling.select();
          } else if ($isTextNode(nextSibling)) {
            nextSibling.select();
          } else if (parent !== null) {
            parent.select();
          }
        }
      } else if (previousLength < offset) {
        const descendant = node.getFirstDescendant();
        const descendantLength =
          descendant !== null ? descendant.getTextContentSize() : 0;
        const previousPlusDescendantLength = previousLength + descendantLength;
        // For simple text we can redimension the overflow into a smaller and more accurate
        // container
        const firstDescendantIsSimpleText =
          $isTextNode(descendant) && descendant.isSimpleText();
        const firstDescendantDoesNotOverflow =
          previousPlusDescendantLength <= offset;

        if (firstDescendantIsSimpleText || firstDescendantDoesNotOverflow) {
          $unwrapNode(node);
        }
      }
    } else if (isSlotValueLeaf) {
      // Skipped by the wrap loop, but its text is part of the offset budget;
      // without this the wrap boundary lands late by the decorator's size.
      accumulatedLength += node.getTextContentSize();
    } else if (needsOverflowParent) {
      const previousAccumulatedLength = accumulatedLength;
      accumulatedLength += node.getTextContentSize();

      if (accumulatedLength > offset && !$isOverflowNode(node.getParent())) {
        const previousSelection = $getSelection();
        let overflowNode;

        // For simple text we can improve the limit accuracy by splitting the TextNode
        // on the split point
        if (
          previousAccumulatedLength < offset &&
          $isTextNode(node) &&
          node.isSimpleText()
        ) {
          const [, overflowedText] = node.splitText(
            offset - previousAccumulatedLength,
          );
          overflowNode = $wrapNode(overflowedText);
        } else {
          overflowNode = $wrapNode(node);
        }

        if (previousSelection !== null) {
          $setSelection(previousSelection);
        }

        $mergePrevious(overflowNode);
        const nextNode = overflowNode.getNextSibling();
        if ($isOverflowNode(nextNode)) {
          $mergePrevious(nextNode);
        }
      }
    }
  }
}

function $wrapNode(node: LexicalNode): OverflowNode {
  const overflowNode = $createOverflowNode();
  node.replace(overflowNode);
  overflowNode.append(node);
  return overflowNode;
}

export function $mergePrevious(overflowNode: OverflowNode): void {
  const previousNode = overflowNode.getPreviousSibling();

  if (!$isOverflowNode(previousNode)) {
    return;
  }

  const firstChild = overflowNode.getFirstChild();
  const previousNodeChildren = previousNode.getChildren();
  const previousNodeChildrenLength = previousNodeChildren.length;

  if (firstChild === null) {
    overflowNode.append(...previousNodeChildren);
  } else {
    for (let i = 0; i < previousNodeChildrenLength; i++) {
      firstChild.insertBefore(previousNodeChildren[i]);
    }
  }

  const selection = $getSelection();

  if ($isRangeSelection(selection)) {
    const anchor = selection.anchor;
    const anchorNode = anchor.getNode();
    const focus = selection.focus;
    const focusNode = focus.getNode();

    if (anchorNode.is(previousNode)) {
      anchor.set(overflowNode.getKey(), anchor.offset, 'element');
    } else if (anchorNode.is(overflowNode)) {
      anchor.set(
        overflowNode.getKey(),
        previousNodeChildrenLength + anchor.offset,
        'element',
      );
    }

    if (focusNode.is(previousNode)) {
      focus.set(overflowNode.getKey(), focus.offset, 'element');
    } else if (focusNode.is(overflowNode)) {
      focus.set(
        overflowNode.getKey(),
        previousNodeChildrenLength + focus.offset,
        'element',
      );
    }
  }

  previousNode.remove();
}
