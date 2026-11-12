/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalNode, NodeKey} from '../LexicalNode';
import type {ElementNode} from '../nodes/LexicalElementNode';
import type {CaretDirection, NodeCaret, SiblingCaret} from './LexicalCaret';

import invariant from '@lexical/internal/invariant';

import {$isElementNode, $isTextNode} from '../index';
import {
  $getSelection,
  $isRangeSelection,
  $selectionTouchesElement,
  $updateElementSelectionOnCreateDeleteNode,
  type PointType,
  type RangeSelection,
} from '../LexicalSelection';
import {
  $errorOnSlotCycleChild,
  $getSlotHost,
  $getSlotHostKey,
} from '../LexicalSlot';
import {
  errorOnReadOnly,
  getActiveEditor,
  getActiveEditorState,
} from '../LexicalUpdates';
import {errorOnInsertTextNodeOnRoot} from '../LexicalUtils';
import {$textEditLog} from '../nodes/LexicalTextNode';

/**
 * Connect the two sides of a child-list gap. Null denotes the parent's
 * first/last boundary. Callers own the parent/size updates and must pass
 * writable nodes, obtained through getWritable for copy-on-write and dirtying.
 */
function $linkSiblings(
  writableParent: ElementNode,
  writablePrevious: LexicalNode | null,
  writableNext: LexicalNode | null,
): void {
  const previousKey = writablePrevious === null ? null : writablePrevious.__key;
  const nextKey = writableNext === null ? null : writableNext.__key;
  if (writablePrevious === null) {
    writableParent.__first = nextKey;
  } else {
    writablePrevious.__next = nextKey;
  }
  if (writableNext === null) {
    writableParent.__last = previousKey;
  } else {
    writableNext.__prev = previousKey;
  }
}

// Record the operation rather than infer it from changed sibling pointers:
// shifted siblings also have different pointers, but must keep their identity.
// The removal is also an entry of the text edits (EditorState#_textEdits),
// while the editor records those.
function $recordNodeMove(node: LexicalNode, parent: ElementNode): void {
  const editor = getActiveEditor();
  if (editor._recordTextEdits) {
    $textEditLog(editor).push(['detach', node.__key, parent.__key]);
  }
  if (!editor._recordNodeMoves) {
    return;
  }
  const prevNodeMap = editor._editorState._nodeMap;
  if (prevNodeMap.has(node.__key)) {
    const editorState = getActiveEditorState();
    const movedNodes = (editorState._movedNodes ||= new WeakMap());
    let movedKeys = movedNodes.get(prevNodeMap);
    if (movedKeys === undefined) {
      movedKeys = new Set();
      movedNodes.set(prevNodeMap, movedKeys);
    }
    movedKeys.add(node.__key);
  }
}

/** Insert into a gap, repairing both boundaries. All nodes must be writable. */
export function $insertNodeBetween(
  writableParent: ElementNode,
  writableNode: LexicalNode,
  writablePrevious: LexicalNode | null,
  writableNext: LexicalNode | null,
): void {
  const key = writableNode.__key;
  if (writablePrevious === null) {
    writableParent.__first = key;
  } else {
    writablePrevious.__next = key;
  }
  if (writableNext === null) {
    writableParent.__last = key;
  } else {
    writableNext.__prev = key;
  }
  writableNode.__prev =
    writablePrevious === null ? null : writablePrevious.__key;
  writableNode.__next = writableNext === null ? null : writableNext.__key;
  writableNode.__parent = writableParent.__key;
  const editor = getActiveEditor();
  if (editor._recordTextEdits) {
    // An entry of the text edits (EditorState#_textEdits).
    $textEditLog(editor).push([
      'attach',
      key,
      writableParent.__key,
      writableNode.__prev,
      writableNode.__next,
      $isTextNode(writableNode) ? writableNode.__text : null,
    ]);
  }
}

/**
 * Unlink a writable child without selection bookkeeping. Detached nodes are
 * not modified. Callers obtain getWritable once before entering this layer.
 */
export function $detachNode(writableNode: LexicalNode): void {
  // Keep the original $removeFromParent message to preserve its error code.
  invariant(
    $getSlotHostKey(writableNode) === null,
    '$removeFromParent: node %s is slotted into host %s; a slotted node and a child are mutually exclusive. Remove it from its slot first.',
    writableNode.__key,
    String($getSlotHostKey(writableNode)),
  );
  const parent = writableNode.getParent();
  if (parent !== null) {
    const writableParent = parent.getWritable();
    $recordNodeMove(writableNode, writableParent);
    const previous = writableNode.getPreviousSibling();
    const next = writableNode.getNextSibling();
    $linkSiblings(
      writableParent,
      previous && previous.getWritable(),
      next && next.getWritable(),
    );
    writableNode.__prev = null;
    writableNode.__next = null;
    writableNode.__parent = null;
    writableParent.__size--;
  }
}

/**
 * Detach a contiguous child range, repairing its outer boundaries once.
 * Resolve all writable nodes before changing links so clone hooks see a
 * consistent tree. The caller handles selection repair.
 */
export function $detachSiblingRange(
  writableParent: ElementNode,
  first: LexicalNode | null,
  count: number,
  before: LexicalNode | null,
): NodeKey[] {
  const nodes: LexicalNode[] = [];
  let node = first;
  for (let i = 0; i < count; i++) {
    invariant(node !== null, 'splice: sibling not found');
    const next = node.getNextSibling();
    nodes.push(node.getWritable());
    node = next;
  }
  const previous = before && before.getWritable();
  const next = node && node.getWritable();
  $linkSiblings(writableParent, previous, next);
  writableParent.__size -= nodes.length;
  return nodes.map(writable => {
    $recordNodeMove(writable, writableParent);
    writable.__prev = null;
    writable.__next = null;
    writable.__parent = null;
    return writable.__key;
  });
}

/**
 * Detach a writable child and repair element offsets in the old parent. Return
 * points that followed it before repair, so insertAfter can move them (#6031).
 */
export function $detachNodeWithSelection(
  node: LexicalNode,
  selection: RangeSelection | null,
): PointType[] | null {
  const parent = selection && node.getParent();
  // Keep bulk moves linear when no element point observes the index (#5194).
  const index =
    selection && parent && $selectionTouchesElement(selection, parent)
      ? node.getIndexWithinParent()
      : -1;
  const points =
    selection && parent && index !== -1
      ? [selection.anchor, selection.focus].filter(
          point =>
            point.type === 'element' &&
            point.key === parent.__key &&
            point.offset === index + 1,
        )
      : null;
  if (selection && parent && index !== -1) {
    // Offset repair needs direction while both points still share a tree.
    // One point may follow this node while the other stays on its parent.
    selection.isBackward();
  }
  $detachNode(node);
  if (selection && parent && index !== -1) {
    $updateElementSelectionOnCreateDeleteNode(selection, parent, index, -1);
  }
  if (selection) {
    // Reinsertion can reverse text-only ranges without changing either point.
    selection._cachedIsBackward = null;
  }
  return points;
}

/**
 * Shared insertion in a sibling caret direction, without allocating a caret
 * in the base node methods. Public carets still dispatch through those methods
 * so subclass overrides run.
 */
export function $insertSibling(
  origin: LexicalNode,
  direction: CaretDirection,
  node: LexicalNode,
  restoreSelection: boolean,
): LexicalNode {
  errorOnReadOnly();
  const isNext = direction === 'next';
  errorOnInsertTextNodeOnRoot(origin, node);
  const writableOrigin = origin.getWritable();
  const writableNode = node.getWritable();
  $errorOnSlotCycleChild(origin.getParentOrThrow(), writableNode);
  const currentSelection = $getSelection();
  const selection =
    restoreSelection && $isRangeSelection(currentSelection)
      ? currentSelection
      : null;
  const points = $detachNodeWithSelection(writableNode, selection);
  const parent = origin.getParentOrThrow().getWritable();
  // Before insertion this is the new node's index in either direction.
  const index =
    selection &&
    ((isNext && points !== null && points.length > 0) ||
      $selectionTouchesElement(selection, parent))
      ? origin.getIndexWithinParent() + (isNext ? 1 : 0)
      : -1;
  const sibling = isNext
    ? origin.getNextSibling()
    : origin.getPreviousSibling();
  const writableSibling = sibling && sibling.getWritable();
  $insertNodeBetween(
    parent,
    writableNode,
    isNext ? writableOrigin : writableSibling,
    isNext ? writableSibling : writableOrigin,
  );
  parent.__size++;
  if (selection && index !== -1) {
    $updateElementSelectionOnCreateDeleteNode(selection, parent, index);
    if (isNext && points !== null) {
      for (const point of points) {
        point.set(parent.__key, index + 1, 'element');
      }
    }
  }
  return node;
}

/**
 * Select the sibling at this caret, preserving the node methods' placement
 * rules for text, elements, decorators and slot roots.
 * @internal
 */
export function $selectAdjacentNode(
  caret: SiblingCaret,
  anchorOffset?: number,
  focusOffset?: number,
): RangeSelection {
  errorOnReadOnly();
  const {origin, direction} = caret;
  const isNext = direction === 'next';
  // Slot roots have no linked-list parent. Delegate through the host's public
  // method so custom selection behavior is preserved there too.
  const slotHost = $getSlotHost(origin);
  if (slotHost !== null) {
    return isNext
      ? slotHost.selectNext(anchorOffset, focusOffset)
      : slotHost.selectPrevious(anchorOffset, focusOffset);
  }
  const sibling = caret.getNodeAtCaret();
  const parent = origin.getParentOrThrow();
  if (sibling === null) {
    return isNext ? parent.select() : parent.select(0, 0);
  }
  if ($isElementNode(sibling)) {
    return isNext ? sibling.select(0, 0) : sibling.select();
  }
  if ($isTextNode(sibling)) {
    return sibling.select(anchorOffset, focusOffset);
  }
  const index = sibling.getIndexWithinParent() + (isNext ? 0 : 1);
  return parent.select(index, index);
}

/**
 * Get the adjacent nodes to initialCaret in the given direction.
 *
 * @example
 * ```ts
 * expect($getAdjacentNodes($getChildCaret(parent, 'next'))).toEqual(parent.getChildren());
 * expect($getAdjacentNodes($getChildCaret(parent, 'previous'))).toEqual(parent.getChildren().reverse());
 * expect($getAdjacentNodes($getSiblingCaret(node, 'next'))).toEqual(node.getNextSiblings());
 * expect($getAdjacentNodes($getSiblingCaret(node, 'previous'))).toEqual(node.getPreviousSiblings().reverse());
 * ```
 *
 * @param initialCaret The caret to start at (the origin will not be included)
 * @returns An array of siblings.
 */
export function $getAdjacentNodes(
  initialCaret: NodeCaret<CaretDirection>,
): LexicalNode[] {
  return $collectSiblingNodes(
    initialCaret.getNodeAtCaret(),
    initialCaret.direction,
  );
}

/** Collect siblings including start, without allocating intermediate carets. */
export function $collectSiblingNodes(
  start: LexicalNode | null,
  direction: CaretDirection,
): LexicalNode[] {
  const siblings: LexicalNode[] = [];
  for (
    let node = start;
    node !== null;
    node =
      direction === 'next' ? node.getNextSibling() : node.getPreviousSibling()
  ) {
    siblings.push(node);
  }
  return siblings;
}
