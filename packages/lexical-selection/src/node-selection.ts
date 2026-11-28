/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $comparePointCaretNext,
  $flushSyncAfterUpdate,
  $getCaretRange,
  $getCaretRangeInDirection,
  $getCollapsedCaretRange,
  $getSiblingCaret,
  $isElementNode,
  $rewindSiblingCaret,
  $setSelectionFromCaretRange,
  type CaretDirection,
  type LexicalNode,
  type NodeSelection,
} from 'lexical';

/**
 * Moves the selection off a node-selected `node` in `direction`, as an arrow
 * key does: to the end of what precedes the node, or to the start of what
 * follows it. Where the node's neighbour in that direction is a block shadow
 * root, the caret is placed between the two instead, where the block cursor
 * is drawn.
 *
 * @param node - The node the NodeSelection holds.
 * @param direction - The direction to move in.
 */
export function $exitNodeSelectionToward(
  node: LexicalNode,
  direction: CaretDirection,
): void {
  const caret = $getSiblingCaret(node, direction);
  const sibling = caret.getAdjacentCaret();
  if (
    sibling !== null &&
    $isElementNode(sibling.origin) &&
    !sibling.origin.isInline() &&
    sibling.origin.isShadowRoot()
  ) {
    $setSelectionFromCaretRange($getCollapsedCaretRange(caret));
  } else if (direction === 'next') {
    node.selectNext(0, 0);
  } else {
    node.selectPrevious();
  }
}

/**
 * Converts a contiguous NodeSelection to the RangeSelection that covers the
 * same siblings, with its focus at the end that `direction` faces. A range
 * can't cover nodes that aren't contiguous siblings without the nodes between
 * them, so such a NodeSelection is left as it is.
 *
 * A conversion calls `$flushSyncAfterUpdate()`, which commits the caller's
 * update synchronously, so that the default action of a keydown being handled
 * extends the new selection: Firefox doesn't pick up a selection committed
 * after the keydown listeners return.
 *
 * @param selection - The NodeSelection to convert.
 * @param direction - The direction the RangeSelection's focus faces.
 * @returns Whether the selection was converted.
 */
export function $convertContiguousNodeSelection(
  selection: NodeSelection,
  direction: CaretDirection,
): boolean {
  const carets = selection
    .getNodes()
    .map(node => $getSiblingCaret(node, 'next'))
    .sort($comparePointCaretNext);
  // At least one node
  const firstCaret = carets[0];
  const lastCaret = carets[carets.length - 1];
  if (!firstCaret || !lastCaret) {
    return false;
  }
  // Check that all nodes are contiguous
  for (let i = 0; i < carets.length - 1; i++) {
    if (!carets[i + 1].origin.is(carets[i].getNodeAtCaret())) {
      return false;
    }
  }
  $setSelectionFromCaretRange(
    $getCaretRangeInDirection(
      $getCaretRange($rewindSiblingCaret(firstCaret), lastCaret),
      direction,
    ),
  );
  $flushSyncAfterUpdate();
  return true;
}
