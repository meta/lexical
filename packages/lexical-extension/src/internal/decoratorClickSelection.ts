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
  $createRangeSelection,
  $getAdjacentNode,
  $getCommonAncestor,
  $getCommonAncestorResultBranchOrder,
  $getEditor,
  $getNodeByKey,
  $getSelection,
  $getSiblingCaret,
  $isNodeSelection,
  $isRangeSelection,
  $setPointFromCaret,
  $setSelection,
  IS_APPLE,
  type LexicalNode,
  type NodeKey,
} from 'lexical';

function $selectRangeBetweenNodes(
  origin: LexicalNode,
  target: LexicalNode,
): boolean {
  const common = $getCommonAncestor(origin, target);
  if (!common || common.type !== 'branch') {
    return false;
  }
  const forward = $getCommonAncestorResultBranchOrder(common) < 0;
  const range = $createRangeSelection();
  $setPointFromCaret(
    range.anchor,
    $getSiblingCaret(origin, forward ? 'previous' : 'next'),
  );
  $setPointFromCaret(
    range.focus,
    $getSiblingCaret(target, forward ? 'next' : 'previous'),
  );
  $setSelection(range);
  const inputState = $getEditor()._inputState;
  if (
    !inputState.shiftClick ||
    inputState.shiftClick.origin !== origin.getKey()
  ) {
    inputState.shiftClick = {mouseDown: null, origin: origin.getKey()};
  }
  return true;
}

/**
 * Handles range extension and node toggling for a click on a selectable node.
 * Call from a click command after validating the target.
 *
 * Shift-click extends the current range to include the whole node. From one
 * selected node it creates a range spanning both nodes when they occupy
 * separate branches of the same tree. With multiple selected nodes it toggles
 * membership. Ctrl-click (Command-click on Apple platforms) toggles the node
 * in the current node selection, or replaces any other selection with one
 * that holds only the node.
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
    // Crossing a selected node changes which of its edges anchors the range,
    // whether the previous Shift-click landed on text or another node.
    const gesture = $getEditor()._inputState.shiftClick;
    if (!toggleModifier && node && gesture) {
      const origin = gesture.mouseDown
        ? $getNodeByKey(gesture.origin)
        : $getAdjacentNode(selection.anchor, selection.isBackward());
      if (
        origin &&
        origin.getKey() === gesture.origin &&
        $selectRangeBetweenNodes(origin, node)
      ) {
        return true;
      }
    }
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
      if (event.shiftKey && !toggleModifier) {
        const nodes = selection.getNodes();
        const target = $getNodeByKey(nodeKey);
        if (
          nodes.length === 1 &&
          target &&
          $selectRangeBetweenNodes(nodes[0], target)
        ) {
          return true;
        }
      }
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
