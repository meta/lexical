/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createRangeSelection,
  $isDecoratorNode,
  $isElementNode,
  $isTextNode,
  defineExtension,
  type ElementNode,
  type LexicalNode,
  type RangeSelection,
  type TextNode,
} from 'lexical';

import {
  $createMarkNode,
  $isMarkNode,
  MarkNode,
  type SerializedMarkNode,
} from './MarkNode';

export function $unwrapMarkNode(node: MarkNode): void {
  const children = node.getChildren();
  let target = null;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (target === null) {
      node.insertBefore(child);
    } else {
      target.insertAfter(child);
    }
    target = child;
  }
  node.remove();
}

export function $wrapSelectionInMarkNode(
  selection: RangeSelection,
  isBackward: boolean,
  id: string,
  createNode?: (ids: string[]) => MarkNode,
): void {
  // Force a forwards selection since append is used, ignore the argument.
  // A new selection is used to avoid side-effects of flipping the given
  // selection
  const forwardSelection = $createRangeSelection();
  const [startPoint, endPoint] = selection.isBackward()
    ? [selection.focus, selection.anchor]
    : [selection.anchor, selection.focus];
  forwardSelection.anchor.set(
    startPoint.key,
    startPoint.offset,
    startPoint.type,
  );
  forwardSelection.focus.set(endPoint.key, endPoint.offset, endPoint.type);

  let currentNodeParent: ElementNode | null | undefined;
  let lastCreatedMarkNode: MarkNode | undefined;

  // Note that extract will split text nodes at the boundaries
  const nodes = forwardSelection.extract();
  // We only want wrap adjacent text nodes, line break nodes
  // and inline element nodes. For decorator nodes and block
  // element nodes, we step out of their boundary and start
  // again after, if there are more nodes.
  for (const node of nodes) {
    if (
      $isElementNode(lastCreatedMarkNode) &&
      lastCreatedMarkNode.isParentOf(node)
    ) {
      // If the current node is a child of the last created mark node, there is nothing to do here
      continue;
    }
    let targetNode: LexicalNode | null = null;

    if ($isTextNode(node)) {
      // Case 1: The node is a text node and we can include it
      targetNode = node;
    } else if ($isMarkNode(node)) {
      // Case 2: the node is a mark node and we can ignore it as a target,
      // moving on to its children. Note that when we make a mark inside
      // another mark, it may ultimately be unnested by a call to
      // `registerNestedElementResolver<MarkNode>` somewhere else in the
      // codebase.
      continue;
    } else if (
      ($isElementNode(node) || $isDecoratorNode(node)) &&
      node.isInline()
    ) {
      // Case 3: inline element/decorator nodes can be added in their entirety
      // to the new mark
      targetNode = node;
    }

    if (targetNode !== null) {
      // Now that we have a target node for wrapping with a mark, we can run
      // through special cases.
      if (targetNode && targetNode.is(currentNodeParent)) {
        // The current node is a child of the target node to be wrapped, there
        // is nothing to do here.
        continue;
      }
      const parentNode = targetNode.getParent();
      if (parentNode == null || !parentNode.is(currentNodeParent)) {
        // If the parent node is not the current node's parent node, we can
        // clear the last created mark node.
        lastCreatedMarkNode = undefined;
      }

      currentNodeParent = parentNode;

      if (lastCreatedMarkNode === undefined) {
        // If we don't have a created mark node, we can make one
        const createMarkNode = createNode || $createMarkNode;
        lastCreatedMarkNode = createMarkNode([id]);
        targetNode.insertBefore(lastCreatedMarkNode);
      }

      // Add the target node to be wrapped in the latest created mark node
      lastCreatedMarkNode.append(targetNode);
    } else {
      // If we don't have a target node to wrap we can clear our state and
      // continue on with the next node
      currentNodeParent = undefined;
      lastCreatedMarkNode = undefined;
    }
  }
  // Make selection collapsed at the end
  if ($isElementNode(lastCreatedMarkNode)) {
    if (isBackward) {
      lastCreatedMarkNode.selectStart();
    } else {
      lastCreatedMarkNode.selectEnd();
    }
  }
}

export function $getMarkIDs(node: TextNode, offset: number): null | string[] {
  let currentNode: LexicalNode | null = node;
  while (currentNode !== null) {
    if ($isMarkNode(currentNode)) {
      return currentNode.getIDs();
    } else if (
      $isTextNode(currentNode) &&
      offset === currentNode.getTextContentSize()
    ) {
      const nextSibling = currentNode.getNextSibling();
      if ($isMarkNode(nextSibling)) {
        return nextSibling.getIDs();
      }
    }
    currentNode = currentNode.getParent();
  }
  return null;
}

/**
 * Configures {@link MarkNode}
 */
export const MarkExtension = defineExtension({
  name: '@lexical/mark',
  nodes: () => [MarkNode],
});

export {$createMarkNode, $isMarkNode, MarkNode, SerializedMarkNode};
