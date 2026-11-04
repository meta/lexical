/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createPoint,
  $getDOMSlot,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getSelection,
  $getSiblingCaret,
  $getSlotHost,
  $getTextNodeOffset,
  $isDecoratorNode,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  type ElementNode,
  getDOMSelection,
  getDOMSelectionPoints,
  IS_APPLE_WEBKIT,
  IS_IOS,
  IS_SAFARI,
  isHTMLElement,
  isSelectionWithinEditor,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type PointType,
  type TextNode,
} from 'lexical';

/*
 * Where Lexical's selection normalization at boundaries puts a selection's
 * points at the next update, and where the composition key goes with them:
 * a mirror, without side effects, of LexicalSelection's
 * $normalizeSelectionPointsForBoundaries and $resolveSelectionPointOnBoundary
 * (which every update runs on the selection it reads from the DOM), and of
 * PointType#set moving the composition key with a point that leaves the
 * composed node. BoundaryNormalization.test.ts holds it to what Lexical does.
 */

/** A selection point, by value. */
export interface BoundaryPoint {
  key: NodeKey;
  offset: number;
  type: 'text' | 'element';
}

/**
 * Lexical's $isEmptyCompositionTarget (Safari keeps an empty target), with
 * the composition key as the points set so far left it (`composing`): it
 * reads the editor's, which an earlier set in the same normalization moved.
 */
function isEmptyCompositionTarget(
  node: TextNode,
  composing: NodeKey | null,
): boolean {
  return (
    !IS_IOS &&
    (IS_SAFARI || IS_APPLE_WEBKIT) &&
    node.__text === '' &&
    node.__key === composing
  );
}

/**
 * The point `point` moves to at a boundary ($resolveSelectionPointOnBoundary),
 * or null where it stays.
 */
function $resolved(
  point: BoundaryPoint,
  isBackward: boolean,
  isCollapsed: boolean,
  composing: NodeKey | null,
): BoundaryPoint | null {
  const node = $getNodeByKey(point.key);
  if (!$isTextNode(node) || isEmptyCompositionTarget(node, composing)) {
    return null;
  }
  const before = point.offset === 0;
  if (!before && point.offset !== node.getTextContent().length) {
    return null;
  }
  const direction = before ? 'previous' : 'next';
  const sibling = $getSiblingCaret(node, direction).getNodeAtCaret();
  if (
    before !== isBackward &&
    $isElementNode(sibling) &&
    sibling.isInline() &&
    (!before || !isCollapsed)
  ) {
    return {
      key: sibling.__key,
      offset: before ? sibling.getChildrenSize() : 0,
      type: 'element',
    };
  } else if (before && !isBackward) {
    if ($isTextNode(sibling) && !node.isUnmergeable()) {
      return {
        key: sibling.__key,
        offset: sibling.getTextContent().length,
        type: 'text',
      };
    }
  } else if (sibling === null && (isCollapsed || (!before && isBackward))) {
    const parent = node.getParent();
    if (
      $isElementNode(parent) &&
      parent.isInline() &&
      (before ||
        (!parent.canInsertTextAfter() && parent.getTextContentSize() > 1))
    ) {
      const parentSibling = $getSiblingCaret(
        parent,
        direction,
      ).getNodeAtCaret();
      if ($isTextNode(parentSibling)) {
        return {
          key: parentSibling.__key,
          offset: before ? parentSibling.getTextContent().length : 0,
          type: 'text',
        };
      }
    }
  }
  return null;
}

/**
 * The anchor, the focus and the composition key once Lexical normalized
 * the selection `anchor`..`focus` at boundaries, from composition key
 * `composing`: the points set in Lexical's order (anchor, focus, then a
 * collapsed focus on the anchor), each set moving the composition key from
 * the point's old node to its new one.
 */
export function $normalizedAtBoundaries(
  anchor: PointType,
  focus: PointType,
  composing: NodeKey | null,
): {anchor: BoundaryPoint; focus: BoundaryPoint; composing: NodeKey | null} {
  let a: BoundaryPoint = {
    key: anchor.key,
    offset: anchor.offset,
    type: anchor.type,
  };
  let f: BoundaryPoint = {
    key: focus.key,
    offset: focus.offset,
    type: focus.type,
  };
  let key = composing;
  const set = (from: BoundaryPoint, to: BoundaryPoint): BoundaryPoint => {
    if (key === from.key) {
      key = to.key;
    }
    return to;
  };
  if (anchor.type === 'text' && focus.type === 'text') {
    const isBackward = anchor.isBefore(focus);
    const isCollapsed = anchor.is(focus);
    const ra = $resolved(a, isBackward, isCollapsed, key);
    if (ra !== null) {
      a = set(a, ra);
    }
    const rf = $resolved(f, !isBackward, isCollapsed, key);
    if (rf !== null) {
      f = set(f, rf);
    }
    if (isCollapsed) {
      f = set(f, {...a});
    }
  }
  return {anchor: a, composing: key, focus: f};
}

/** Lexical's shouldResolveAncestor. */
function shouldResolveAncestor(
  resolvedElement: ElementNode,
  lastPoint: null | PointType,
): boolean {
  const parent = resolvedElement.getParent();
  return (
    lastPoint === null ||
    parent === null ||
    !parent.canBeEmpty() ||
    parent !== lastPoint.getNode()
  );
}

/**
 * Lexical's $internalResolveSelectionPoint, read-only: the point DOM point
 * `dom`/`offset` resolves to (null: none, as Lexical's), on the editor as it
 * is (its DOM and its nodes, whose methods are read as they are now), from
 * the last selection's point `lastPoint`. Undefined where this does not
 * follow Lexical (a block cursor, a slot): the binding then foresees nothing
 * (see YBinding#noteComposed for what catches a move).
 */
function $resolvedDOMPoint(
  dom: Node,
  offset: number,
  lastPoint: null | PointType,
  editor: LexicalEditor,
): BoundaryPoint | null | undefined {
  if (editor._blockCursorElement !== null) {
    return undefined;
  }
  let resolvedOffset = offset;
  let resolvedNode: LexicalNode | null;
  if (isHTMLElement(dom)) {
    let moveSelectionToEnd = false;
    const childNodes = dom.childNodes;
    const childNodesLength = childNodes.length;
    if (resolvedOffset === childNodesLength && childNodesLength > 0) {
      moveSelectionToEnd = true;
      resolvedOffset = childNodesLength - 1;
    }
    const childDOM = childNodes[resolvedOffset];
    resolvedNode =
      childDOM === undefined ? null : $getNearestNodeFromDOMNode(childDOM);
    if ($isTextNode(resolvedNode)) {
      resolvedOffset = $getTextNodeOffset(
        resolvedNode,
        moveSelectionToEnd ? 'next' : 'previous',
      );
    } else {
      let resolvedElement = $getNearestNodeFromDOMNode(dom);
      if (resolvedElement === null) {
        return null;
      }
      if ($isElementNode(resolvedElement)) {
        const elementDOM = editor.getElementByKey(resolvedElement.getKey());
        if (elementDOM === null) {
          return undefined;
        }
        const slot = $getDOMSlot(resolvedElement, elementDOM, editor);
        if (slot.element !== elementDOM) {
          return undefined;
        }
        [resolvedElement, resolvedOffset] = slot.resolveChildIndex(
          resolvedElement,
          elementDOM,
          dom,
          offset,
        );
        if (!$isElementNode(resolvedElement)) {
          return undefined;
        }
        if (
          moveSelectionToEnd &&
          resolvedOffset >= resolvedElement.getChildrenSize()
        ) {
          resolvedOffset = Math.max(0, resolvedElement.getChildrenSize() - 1);
        }
        let child: LexicalNode | null =
          resolvedElement.getChildAtIndex(resolvedOffset);
        if ($isElementNode(child) && shouldResolveAncestor(child, lastPoint)) {
          const descendant: LexicalNode | null = moveSelectionToEnd
            ? child.getLastDescendant()
            : child.getFirstDescendant();
          if (descendant === null) {
            resolvedElement = child;
          } else {
            child = descendant;
            resolvedElement = $isElementNode(child)
              ? child
              : child.getParentOrThrow();
          }
          resolvedOffset = 0;
        }
        if ($isTextNode(child)) {
          return {
            key: child.getKey(),
            offset: $getTextNodeOffset(
              child,
              moveSelectionToEnd ? 'next' : 'previous',
            ),
            type: 'text',
          };
        } else if (child !== resolvedElement && moveSelectionToEnd) {
          resolvedOffset = Math.min(
            (resolvedElement as ElementNode).getChildrenSize(),
            resolvedOffset + 1,
          );
        }
        return {
          key: resolvedElement.getKey(),
          offset: resolvedOffset,
          type: 'element',
        };
      }
      // A leaf (a decorator, a line break): anchored in its parent, before
      // or after it.
      if ($getSlotHost(resolvedElement) !== null) {
        return undefined;
      }
      const index = resolvedElement.getIndexWithinParent();
      const elementDOM = editor.getElementByKey(resolvedElement.getKey());
      let position: 'before' | 'after' = 'after';
      if (
        elementDOM !== null &&
        $getNearestNodeFromDOMNode(dom) === resolvedElement
      ) {
        const slot = $getDOMSlot(resolvedElement, elementDOM, editor);
        if (slot.element !== elementDOM) {
          return undefined;
        } else if (offset === 0 && $isDecoratorNode(resolvedElement)) {
          position = 'before';
        }
      }
      const parent = resolvedElement.getParent();
      if (!$isElementNode(parent)) {
        return null;
      }
      return {
        key: parent.getKey(),
        offset: position === 'before' ? index : index + 1,
        type: 'element',
      };
    }
  } else {
    resolvedNode = $getNearestNodeFromDOMNode(dom);
  }
  if (!$isTextNode(resolvedNode)) {
    return null;
  }
  return {
    key: resolvedNode.getKey(),
    offset: $getTextNodeOffset(resolvedNode, resolvedOffset, 'clamp'),
    type: 'text',
  };
}

/**
 * What the editor's next update makes of the selection and the composition
 * key, foreseen read-only (no update, no app code but node methods that
 * read, which Lexical calls as it makes the selection): the stages Lexical
 * runs to make an update's selection from the DOM selection (as it does for
 * the input events of a composition): the DOM selection read
 * (getDOMSelectionPoints; outside the editor, the last selection kept), its
 * points resolved ($resolvedDOMPoint), and normalized at boundaries, where
 * a point that leaves the node composed in takes the composition key with
 * it ($normalizedAtBoundaries). Null: the next update has no range
 * selection, the composition key stays. Undefined: not foreseen (see
 * $resolvedDOMPoint; slots). Selection transforms (an app's node method
 * that writes) are not foreseen: see YBinding#noteComposed.
 */
export function $nextUpdateSelection(editor: LexicalEditor):
  | {
      anchor: BoundaryPoint;
      focus: BoundaryPoint;
      composing: NodeKey | null;
    }
  | null
  | undefined {
  const composing = editor._compositionKey;
  const last = $getSelection();
  const window = editor._window;
  const domSelection = window === null ? null : getDOMSelection(window);
  const keep = () =>
    $isRangeSelection(last)
      ? {
          anchor: pointOf(last.anchor),
          composing,
          focus: pointOf(last.focus),
        }
      : null;
  if (domSelection === null) {
    return null;
  }
  const {anchorNode, anchorOffset, focusNode, focusOffset} =
    getDOMSelectionPoints(domSelection, editor._rootElement);
  if (!isSelectionWithinEditor(editor, anchorNode, focusNode)) {
    return keep();
  }
  if (anchorNode === null || focusNode === null) {
    return null;
  }
  const lastRange = $isRangeSelection(last) ? last : null;
  const anchor = $resolvedDOMPoint(
    anchorNode,
    anchorOffset,
    lastRange === null ? null : lastRange.anchor,
    editor,
  );
  const focus = $resolvedDOMPoint(
    focusNode,
    focusOffset,
    lastRange === null ? null : lastRange.focus,
    editor,
  );
  if (anchor === undefined || focus === undefined || editor._slotsUsed) {
    return undefined;
  }
  if (anchor === null || focus === null) {
    return null;
  }
  if (
    anchor.type === 'element' &&
    focus.type === 'element' &&
    $isDecoratorNode($getNearestNodeFromDOMNode(anchorNode)) &&
    $isDecoratorNode($getNearestNodeFromDOMNode(focusNode))
  ) {
    return null;
  }
  return $normalizedAtBoundaries(
    $createPoint(anchor.key, anchor.offset, anchor.type),
    $createPoint(focus.key, focus.offset, focus.type),
    composing,
  );
}

const pointOf = (p: PointType): BoundaryPoint => ({
  key: p.key,
  offset: p.offset,
  type: p.type,
});
