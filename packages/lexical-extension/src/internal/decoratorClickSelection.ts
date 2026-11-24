/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createNodeSelection,
  $createPoint,
  $getCommonAncestor,
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $setSelection,
  IS_APPLE,
  type NodeKey,
} from 'lexical';

/**
 * Handles range extension and node toggling for a click on a selectable node.
 * Call from a click command after validating the target.
 *
 * Shift-click extends the current range to include the whole node, or toggles
 * the node in the current node selection. Ctrl-click (Command-click on Apple
 * platforms) toggles the node in the current node selection, or replaces any
 * other selection with one that holds only the node.
 *
 * Returns `false`, leaving the selection unchanged, for an unmodified or
 * non-primary click, and for a Shift-click that has no node selection to add
 * to and that no range can express: there is no range selection, its anchor is
 * inside the node, or its anchor and the node are in different slot trees. The
 * caller then has to apply its own selection.
 *
 * @param event - The click event.
 * @param nodeKey - The key of the clicked node.
 * @returns Whether the modifier gesture was handled.
 * @experimental
 */
export function $handleDecoratorClickModifiers(
  event: MouseEvent,
  nodeKey: NodeKey,
): boolean {
  const toggleModifier = IS_APPLE ? event.metaKey : event.ctrlKey;
  if (event.button !== 0 || (!event.shiftKey && !toggleModifier)) {
    return false;
  }

  const selection = $getSelection();
  if (event.shiftKey && $isRangeSelection(selection)) {
    const node = $getNodeByKey(nodeKey);
    const parent = node === null ? null : node.getParent();
    const common = node && $getCommonAncestor(selection.anchor.getNode(), node);
    // A range with an anchor inside the target cannot include the whole node.
    // Named slots can also separate the target and anchor into distinct trees.
    if (
      node !== null &&
      parent != null &&
      common !== null &&
      !common.commonAncestor.is(node)
    ) {
      const parentKey = parent.getKey();
      const index = node.getIndexWithinParent();
      const after = $createPoint(parentKey, index + 1, 'element');
      selection.focus.set(
        parentKey,
        selection.anchor.isBefore(after) ? index + 1 : index,
        'element',
      );
      return true;
    }
  }

  if (toggleModifier || (event.shiftKey && $isNodeSelection(selection))) {
    if ($isNodeSelection(selection)) {
      if (selection.has(nodeKey)) {
        selection.delete(nodeKey);
      } else {
        selection.add(nodeKey);
      }
    } else {
      const nodeSelection = $createNodeSelection();
      nodeSelection.add(nodeKey);
      $setSelection(nodeSelection);
    }
    return true;
  }

  return false;
}
