/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {PointType} from './LexicalSelection';

import {
  $isElementNode,
  $isTextNode,
  type RangeSelection,
  type TextNode,
} from '.';
import {nodeStatesAreEquivalent} from './LexicalNodeState';
import {getActiveEditor} from './LexicalUpdates';
import {DEFER_COMPOSITION_MERGE_TAG} from './LexicalUpdateTags';
import {$isEmptyCompositionTarget} from './LexicalUtils';

function $canSimpleTextNodesBeMerged(
  node1: TextNode,
  node2: TextNode,
): boolean {
  const node1Mode = node1.__mode;
  const node1Format = node1.__format;
  const node1Style = node1.__style;
  const node2Mode = node2.__mode;
  const node2Format = node2.__format;
  const node2Style = node2.__style;
  const node1State = node1.__state;
  const node2State = node2.__state;
  return (
    (node1Mode === null || node1Mode === node2Mode) &&
    (node1Format === null || node1Format === node2Format) &&
    (node1Style === null || node1Style === node2Style) &&
    (node1.__state === null ||
      node1State === node2State ||
      nodeStatesAreEquivalent(node1State, node2State))
  );
}

function $mergeTextNodes(node1: TextNode, node2: TextNode): TextNode {
  const writableNode1 = node1.mergeWithSibling(node2);

  const normalizedNodes = getActiveEditor()._normalizedNodes;

  normalizedNodes.add(node1.__key);
  normalizedNodes.add(node2.__key);
  return writableNode1;
}

export function $normalizeTextNode(textNode: TextNode): void {
  let node = textNode;

  if ($isEmptyCompositionTarget(node)) {
    return;
  }

  if (node.__text === '' && node.isSimpleText() && !node.isUnmergeable()) {
    node.remove();
    return;
  }

  // An update tagged DEFER_COMPOSITION_MERGE_TAG never merges text into or
  // out of the node being composed: merging rewrites its DOM text node, and
  // the browser's composition range would take in the merged text. Once such
  // a merge was held back, later updates of the same composition hold it back
  // too (each composition step marks the composed node dirty). The nodes merge
  // when the composition ends. Without the tag, text merges as before.
  const editor = getActiveEditor();
  const compositionKey = editor._compositionKey;
  const holdComposition =
    compositionKey !== null &&
    (editor._compositionMergeHeld === compositionKey ||
      editor._updateTags.has(DEFER_COMPOSITION_MERGE_TAG));
  const $holdsMerge = (node1: TextNode, node2: TextNode) => {
    if (
      holdComposition &&
      (node1.__key === compositionKey || node2.__key === compositionKey) &&
      $canSimpleTextNodesBeMerged(node1, node2)
    ) {
      editor._compositionMergeHeld = compositionKey;
      return true;
    }
    return false;
  };

  // Backward
  let previousNode;

  while (
    (previousNode = node.getPreviousSibling()) !== null &&
    $isTextNode(previousNode) &&
    previousNode.isSimpleText() &&
    !previousNode.isUnmergeable()
  ) {
    if ($isEmptyCompositionTarget(previousNode)) {
      break;
    }
    if (previousNode.__text === '') {
      previousNode.remove();
    } else if ($holdsMerge(previousNode, node)) {
      break;
    } else if ($canSimpleTextNodesBeMerged(previousNode, node)) {
      node = $mergeTextNodes(previousNode, node);
      break;
    } else {
      break;
    }
  }

  // Forward
  let nextNode;

  while (
    (nextNode = node.getNextSibling()) !== null &&
    $isTextNode(nextNode) &&
    nextNode.isSimpleText() &&
    !nextNode.isUnmergeable()
  ) {
    if ($isEmptyCompositionTarget(nextNode)) {
      break;
    }
    if (nextNode.__text === '') {
      nextNode.remove();
    } else if ($holdsMerge(node, nextNode)) {
      break;
    } else if ($canSimpleTextNodesBeMerged(node, nextNode)) {
      node = $mergeTextNodes(node, nextNode);
      break;
    } else {
      break;
    }
  }
}

/** Descends element-type anchor and focus points of a RangeSelection toward the deepest text-type points, stopping at non-element leaf nodes. */
export function $normalizeSelection(selection: RangeSelection): RangeSelection {
  $normalizePoint(selection.anchor);
  $normalizePoint(selection.focus);
  return selection;
}

function $normalizePoint(point: PointType): void {
  while (point.type === 'element') {
    const node = point.getNode();
    const offset = point.offset;
    let nextNode;
    let nextOffsetAtEnd;
    if (offset === node.getChildrenSize()) {
      nextNode = node.getChildAtIndex(offset - 1);
      nextOffsetAtEnd = true;
    } else {
      nextNode = node.getChildAtIndex(offset);
      nextOffsetAtEnd = false;
    }
    if ($isTextNode(nextNode)) {
      point.set(
        nextNode.__key,
        nextOffsetAtEnd ? nextNode.getTextContentSize() : 0,
        'text',
        true,
      );
      break;
    } else if (!$isElementNode(nextNode)) {
      break;
    }
    point.set(
      nextNode.__key,
      nextOffsetAtEnd ? nextNode.getChildrenSize() : 0,
      'element',
      true,
    );
  }
}
