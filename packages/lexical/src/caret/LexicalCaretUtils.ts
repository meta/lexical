/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {LexicalNode, NodeKey} from '../LexicalNode';

import invariant from '@lexical/internal/invariant';

import {
  $createRangeSelection,
  $getSelection,
  $isRangeSelection,
  type PointType,
  type RangeSelection,
} from '../LexicalSelection';
import {$getSlotNames} from '../LexicalSlot';
import {
  $copyNode,
  $getNodeByKeyOrThrow,
  $isRootOrShadowRoot,
  $isShadowRootNode,
  $removeFromParent,
  $setSelection,
  INTERNAL_$isBlock,
} from '../LexicalUtils';
import {$isElementNode, type ElementNode} from '../nodes/LexicalElementNode';
import {$createParagraphNode} from '../nodes/LexicalParagraphNode';
import {$isRootNode} from '../nodes/LexicalRootNode';
import {
  $createTextNode,
  $isTextNode,
  type TextNode,
} from '../nodes/LexicalTextNode';
import {
  $comparePointCaretNext,
  $getAdjacentChildCaret,
  $getCaretInDirection,
  $getCaretRange,
  $getChildCaret,
  $getCollapsedCaretRange,
  $getSiblingCaret,
  $getTextNodeOffset,
  $getTextPointCaret,
  $isChildCaret,
  $isSiblingCaret,
  $isTextPointCaret,
  type CaretDirection,
  type CaretRange,
  type ChildCaret,
  flipDirection,
  type NodeCaret,
  type PointCaret,
  type RootMode,
  type SiblingCaret,
  type TextPointCaret,
} from './LexicalCaret';

/**
 * @param point
 * @returns a PointCaret for the point
 */
export function $caretFromPoint<D extends CaretDirection>(
  point: Pick<PointType, 'type' | 'key' | 'offset'>,
  direction: D,
): PointCaret<D> {
  const {type, key, offset} = point;
  const node = $getNodeByKeyOrThrow(point.key);
  if (type === 'text') {
    invariant(
      $isTextNode(node),
      '$caretFromPoint: Node with type %s and key %s that does not inherit from TextNode encountered for text point',
      node.getType(),
      key,
    );
    return $getTextPointCaret(node, direction, offset);
  }
  invariant(
    $isElementNode(node),
    '$caretFromPoint: Node with type %s and key %s that does not inherit from ElementNode encountered for element point',
    node.getType(),
    key,
  );
  return $getChildCaretAtIndex(node, point.offset, direction);
}

/**
 * Update the given point in-place from the PointCaret
 *
 * @param point the point to set
 * @param caret the caret to set the point from
 */
export function $setPointFromCaret<D extends CaretDirection>(
  point: PointType,
  caret: PointCaret<D>,
): void {
  const {origin, direction} = caret;
  const isNext = direction === 'next';
  if ($isTextPointCaret(caret)) {
    point.set(origin.getKey(), caret.offset, 'text');
  } else if ($isSiblingCaret(caret)) {
    if ($isTextNode(origin)) {
      point.set(origin.getKey(), $getTextNodeOffset(origin, direction), 'text');
    } else {
      point.set(
        origin.getParentOrThrow().getKey(),
        origin.getIndexWithinParent() + (isNext ? 1 : 0),
        'element',
      );
    }
  } else {
    invariant(
      $isChildCaret(caret) && $isElementNode(origin),
      '$setPointFromCaret: exhaustiveness check',
    );
    point.set(
      origin.getKey(),
      isNext ? 0 : origin.getChildrenSize(),
      'element',
    );
  }
}

/**
 * Set a RangeSelection on the editor from the given CaretRange
 *
 * @returns The new RangeSelection
 */
export function $setSelectionFromCaretRange(
  caretRange: CaretRange,
): RangeSelection {
  const currentSelection = $getSelection();
  const selection = $isRangeSelection(currentSelection)
    ? currentSelection
    : $createRangeSelection();
  $updateRangeSelectionFromCaretRange(selection, caretRange);
  $setSelection(selection);
  return selection;
}

/**
 * Update the points of a RangeSelection based on the given PointCaret.
 */
export function $updateRangeSelectionFromCaretRange(
  selection: RangeSelection,
  caretRange: CaretRange,
): void {
  $setPointFromCaret(selection.anchor, caretRange.anchor);
  $setPointFromCaret(selection.focus, caretRange.focus);
}

/**
 * Get a pair of carets for a RangeSelection.
 *
 * If the focus is before the anchor, then the direction will be
 * 'previous', otherwise the direction will be 'next'.
 */
export function $caretRangeFromSelection(
  selection: RangeSelection,
): CaretRange {
  const {anchor, focus} = selection;
  const anchorCaret = $caretFromPoint(anchor, 'next');
  const focusCaret = $caretFromPoint(focus, 'next');
  const direction =
    $comparePointCaretNext(anchorCaret, focusCaret) <= 0 ? 'next' : 'previous';
  return $getCaretRange(
    $getCaretInDirection(anchorCaret, direction),
    $getCaretInDirection(focusCaret, direction),
  );
}

/**
 * Given a SiblingCaret we can always compute a caret that points to the
 * origin of that caret in the same direction. The adjacent caret of the
 * returned caret will be equivalent to the given caret.
 *
 * @example
 * ```ts
 * siblingCaret.is($rewindSiblingCaret(siblingCaret).getAdjacentCaret())
 * ```
 *
 * @param caret The caret to "rewind"
 * @returns A new caret (ChildCaret or SiblingCaret) with the same direction
 */
export function $rewindSiblingCaret<
  T extends LexicalNode,
  D extends CaretDirection,
>(caret: SiblingCaret<T, D>): NodeCaret<D> {
  const {direction, origin} = caret;
  // Rotate the direction around the origin and get the adjacent node
  const rewindOrigin = $getSiblingCaret(
    origin,
    flipDirection(direction),
  ).getNodeAtCaret();
  return rewindOrigin
    ? $getSiblingCaret(rewindOrigin, direction)
    : $getChildCaret(origin.getParentOrThrow(), direction);
}

function $getAnchorCandidates<D extends CaretDirection>(
  anchor: PointCaret<D>,
  rootMode: RootMode = 'root',
): [PointCaret<D>, ...NodeCaret<D>[]] {
  // These candidates will be the anchor itself, the pointer to the anchor (if different), and then any parents of that
  const carets: [PointCaret<D>, ...NodeCaret<D>[]] = [anchor];
  for (
    let parent = $isChildCaret(anchor)
      ? anchor.getParentCaret(rootMode)
      : anchor.getSiblingCaret();
    parent !== null;
    parent = parent.getParentCaret(rootMode)
  ) {
    carets.push($rewindSiblingCaret(parent));
  }
  return carets;
}

declare const CaretOriginAttachedBrand: unique symbol;
function $isCaretAttached<Caret extends PointCaret<CaretDirection>>(
  caret: null | undefined | Caret,
): caret is Caret & {[CaretOriginAttachedBrand]: never} {
  return !!caret && caret.origin.isAttached();
}

/**
 * Remove all text and nodes in the given range. If the range spans multiple
 * blocks then the remaining contents of the later block will be merged with
 * the earlier block.
 *
 * @param initialRange The range to remove text and nodes from
 * @param sliceMode If 'preserveEmptyTextPointCaret' it will leave an empty TextPointCaret at the anchor for insert if one exists, otherwise empty slices will be removed
 * @returns The new collapsed range (biased towards the earlier node)
 */
export function $removeTextFromCaretRange<D extends CaretDirection>(
  initialRange: CaretRange<D>,
  sliceMode:
    | 'removeEmptySlices'
    | 'preserveEmptyTextSliceCaret' = 'removeEmptySlices',
): CaretRange<D> {
  if (initialRange.isCollapsed()) {
    return initialRange;
  }
  // Always process removals in document order
  const rootMode = 'root';
  const nextDirection = 'next';
  let sliceState = sliceMode;
  const range = $getCaretRangeInDirection(initialRange, nextDirection);

  const anchorCandidates = $getAnchorCandidates(range.anchor, rootMode);
  const focusCandidates = $getAnchorCandidates(
    range.focus.getFlipped(),
    rootMode,
  );

  // Mark the start of each ElementNode
  const seenStart = new Set<NodeKey>();
  // Queue removals to avoid mutating the tree during iteration
  const removedNodes: LexicalNode[] = [];
  for (const caret of range.iterNodeCarets(rootMode)) {
    if ($isChildCaret(caret)) {
      seenStart.add(caret.origin.getKey());
    } else if ($isSiblingCaret(caret)) {
      const {origin} = caret;
      if (!$isElementNode(origin) || seenStart.has(origin.getKey())) {
        removedNodes.push(origin);
      }
    }
  }
  // Use $removeFromParent instead of node.remove() to skip redundant
  // per-node selection restoration — selection is rebuilt from
  // anchor/focus candidates below.
  const removedParents = new Set<ElementNode>();
  for (const node of removedNodes) {
    const parent = node.getParent();
    // Track parents not in seenStart — those in seenStart are traversal
    // boundaries handled by block-merge logic below.
    if (parent !== null && !seenStart.has(parent.getKey())) {
      removedParents.add(parent);
    }
    $removeFromParent(node);
  }
  // Remove inline wrappers (canBeEmpty=false) that became empty
  for (const parent of removedParents) {
    if (
      !parent.canBeEmpty() &&
      !$isRootOrShadowRoot(parent) &&
      parent.isEmpty() &&
      parent.isAttached()
    ) {
      parent.remove();
    }
  }

  // Splice text at the anchor and/or origin.
  // If the text is entirely selected then it is removed (unless it is the first slice and sliceMode is preserveEmptyTextSliceCaret).
  // If it's a token with a non-empty selection then it is removed.
  // Segmented nodes will be copied to a plain text node with the same format
  // and style and set to normal mode.
  for (const slice of range.getTextSlices()) {
    if (!slice) {
      continue;
    }
    const {origin} = slice.caret;
    const contentSize = origin.getTextContentSize();
    const caretBefore = $rewindSiblingCaret(
      $getSiblingCaret(origin, nextDirection),
    );
    const mode = origin.getMode();
    if (
      (Math.abs(slice.distance) === contentSize &&
        sliceState === 'removeEmptySlices') ||
      (mode === 'token' && slice.distance !== 0)
    ) {
      // anchorCandidates[1] should still be valid, it is caretBefore
      caretBefore.remove();
    } else if (slice.distance !== 0) {
      sliceState = 'removeEmptySlices';
      let nextCaret = slice.removeTextSlice();
      const sliceOrigin = slice.caret.origin;
      if (mode === 'segmented') {
        const src = nextCaret.origin;
        const plainTextNode = $createTextNode(src.getTextContent())
          .setStyle(src.getStyle())
          .setFormat(src.getFormat());
        caretBefore.replaceOrInsert(plainTextNode);
        nextCaret = $getTextPointCaret(
          plainTextNode,
          nextDirection,
          nextCaret.offset,
        );
      }
      if (sliceOrigin.is(anchorCandidates[0].origin)) {
        anchorCandidates[0] = nextCaret;
      }
      if (sliceOrigin.is(focusCandidates[0].origin)) {
        focusCandidates[0] = nextCaret.getFlipped();
      }
    }
  }

  // Find the deepest anchor and focus candidates that are
  // still attached
  let anchorCandidate: PointCaret<'next'> | undefined;
  let focusCandidate: PointCaret<'previous'> | undefined;
  for (const candidate of anchorCandidates) {
    if ($isCaretAttached(candidate)) {
      anchorCandidate = $normalizeCaret(candidate);
      break;
    }
  }
  for (const candidate of focusCandidates) {
    if ($isCaretAttached(candidate)) {
      focusCandidate = $normalizeCaret(candidate);
      break;
    }
  }

  // Merge blocks if necessary
  const mergeTargets = $getBlockMergeTargets(
    anchorCandidate,
    focusCandidate,
    seenStart,
  );
  if (mergeTargets) {
    const [anchorBlock, focusBlock] = mergeTargets;
    // always merge blocks later in the document with
    // blocks earlier in the document
    $getChildCaret(anchorBlock, 'previous').splice(0, focusBlock.getChildren());
    // remove empty parent node even if parent node is canBeEmpty
    let parent = focusBlock.getParent();
    focusBlock.remove(true);
    while (parent && parent.isEmpty()) {
      const element = parent;
      parent = parent.getParent();
      element.remove(true);
    }
  } else if (focusCandidate) {
    const focusBlock = $getBlockFromCaret(focusCandidate);
    const focusBlockParent = focusBlock && focusBlock.getParent();
    const topmostShadowRoot =
      focusBlock && focusBlock.getParents().findLast($isShadowRootNode);
    if (
      focusBlock &&
      focusBlockParent &&
      !$isRootNode(focusBlockParent) &&
      focusBlock.isEmpty() &&
      seenStart.has(focusBlock.getKey()) &&
      $getSlotNames(focusBlock).length === 0 &&
      (!topmostShadowRoot || seenStart.has(topmostShadowRoot.getKey()))
    ) {
      focusBlock.remove(true);
      let parent: ElementNode | null = focusBlockParent;
      while (parent && !$isRootNode(parent) && parent.isEmpty()) {
        const grandparent: ElementNode | null = parent.getParent();
        if (
          grandparent &&
          $isRootNode(grandparent) &&
          grandparent.getChildrenSize() <= 1
        ) {
          break;
        }
        const element = parent;
        parent = grandparent;
        element.remove(true);
      }
    }
  }

  // note this caret can be in either direction
  const bestCandidate = [
    anchorCandidate,
    focusCandidate,
    ...anchorCandidates,
    ...focusCandidates,
  ].find($isCaretAttached);
  if (bestCandidate) {
    const anchor = $getCaretInDirection(
      $normalizeCaret(bestCandidate),
      initialRange.direction,
    );
    return $getCollapsedCaretRange(anchor);
  }
  invariant(
    false,
    '$removeTextFromCaretRange: selection was lost, could not find a new anchor given candidates with keys: %s',
    JSON.stringify(anchorCandidates.map(n => n.origin.__key)),
  );
}

function $getBlockFromCaret(
  caret: PointCaret<CaretDirection>,
): ElementNode | null {
  if ($isChildCaret(caret)) {
    const origin = caret.origin;
    if (INTERNAL_$isBlock(origin)) {
      return origin;
    }
  } else {
    const parent = caret.getParentAtCaret();
    if (parent && INTERNAL_$isBlock(parent)) {
      return parent;
    }
  }
  return null;
}

/**
 * Determine if the two caret origins are in distinct blocks that
 * should be merged.
 *
 * The returned block pair will be the closest blocks to their
 * common ancestor, and must be no shadow roots between
 * the blocks and their respective carets. If two distinct
 * blocks matching this criteria are not found, this will return
 * null.
 */
function $getBlockMergeTargets(
  anchor: null | undefined | PointCaret<'next'>,
  focus: null | undefined | PointCaret<'previous'>,
  seenStart: Set<NodeKey>,
): null | [ElementNode, ElementNode] {
  if (!anchor || !focus) {
    return null;
  }
  const anchorParent = anchor.getParentAtCaret();
  const focusParent = focus.getParentAtCaret();
  if (!anchorParent || !focusParent) {
    return null;
  }
  // TODO refactor when we have a better primitive for common ancestor
  const anchorElements = anchorParent.getParents().reverse();
  anchorElements.push(anchorParent);
  const focusElements = focusParent.getParents().reverse();
  focusElements.push(focusParent);
  const maxLen = Math.min(anchorElements.length, focusElements.length);
  let commonAncestorCount: number;
  for (
    commonAncestorCount = 0;
    commonAncestorCount < maxLen &&
    anchorElements[commonAncestorCount] === focusElements[commonAncestorCount];
    commonAncestorCount++
  ) {
    // just traverse the ancestors
  }
  const $getBlock = (
    arr: readonly ElementNode[],
    predicate: (node: ElementNode) => boolean,
  ): ElementNode | undefined => {
    let block: ElementNode | undefined;
    for (let i = commonAncestorCount; i < arr.length; i++) {
      const ancestor = arr[i];
      if ($isRootOrShadowRoot(ancestor)) {
        return;
      } else if (!block && predicate(ancestor)) {
        block = ancestor;
      }
    }
    return block;
  };
  const anchorBlock = $getBlock(anchorElements, INTERNAL_$isBlock);
  const focusBlock =
    anchorBlock &&
    $getBlock(
      focusElements,
      node => seenStart.has(node.getKey()) && INTERNAL_$isBlock(node),
    );
  // A merge removes focusBlock with remove(true), which discards any slots it
  // owns (slots are not children, so they are not spliced onto anchorBlock).
  // Refuse to merge away a slot-bearing host so its slots can only be removed
  // as a unit by an explicit host deletion, never silently via backspace.
  if (focusBlock && $getSlotNames(focusBlock).length > 0) {
    return null;
  }
  return anchorBlock && focusBlock ? [anchorBlock, focusBlock] : null;
}

/**
 * Return the deepest ChildCaret that has initialCaret's origin
 * as an ancestor, or initialCaret if the origin is not an ElementNode
 * or is already the deepest ChildCaret.
 *
 * This is generally used when normalizing because there is
 * "zero distance" between these locations.
 *
 * @param initialCaret
 * @returns Either a deeper ChildCaret or the given initialCaret
 */
function $getDeepestChildOrSelf<
  Caret extends null | PointCaret<CaretDirection>,
>(
  initialCaret: Caret,
): ChildCaret<ElementNode, NonNullable<Caret>['direction']> | Caret {
  let caret: ChildCaret<ElementNode, NonNullable<Caret>['direction']> | Caret =
    initialCaret;
  while ($isChildCaret(caret)) {
    const adjacent = $getAdjacentChildCaret(caret);
    if (!$isChildCaret(adjacent)) {
      break;
    }
    caret = adjacent;
  }
  return caret;
}

/**
 * Normalize a caret to the deepest equivalent PointCaret.
 * This will return a TextPointCaret with the offset set according
 * to the direction if given a caret with a TextNode origin
 * or a caret with an ElementNode origin with the deepest ChildCaret
 * having an adjacent TextNode.
 *
 * If given a TextPointCaret, it will be returned, as no normalization
 * is required when an offset is already present.
 *
 * @param initialCaret
 * @returns The normalized PointCaret
 */
export function $normalizeCaret<D extends CaretDirection>(
  initialCaret: PointCaret<D>,
): PointCaret<D> {
  const caret = $getDeepestChildOrSelf(initialCaret.getLatest());
  const {direction} = caret;
  if ($isTextNode(caret.origin)) {
    return $isTextPointCaret(caret)
      ? caret
      : $getTextPointCaret(caret.origin, direction, direction);
  }
  const adj = caret.getAdjacentCaret();
  return $isSiblingCaret(adj) && $isTextNode(adj.origin)
    ? $getTextPointCaret(adj.origin, direction, flipDirection(direction))
    : caret;
}

declare const PointCaretIsExtendableBrand: unique symbol;
/**
 * Determine whether the TextPointCaret's offset can be extended further without leaving the TextNode.
 * Returns false if the given caret is not a TextPointCaret or the offset can not be moved further in
 * direction.
 *
 * @param caret A PointCaret
 * @returns true if caret is a TextPointCaret with an offset that is not at the end of the text given the direction.
 */
export function $isExtendableTextPointCaret<D extends CaretDirection>(
  caret: PointCaret<D>,
): caret is TextPointCaret<TextNode, D> & {
  [PointCaretIsExtendableBrand]: never;
} {
  return (
    $isTextPointCaret(caret) &&
    caret.offset !== $getTextNodeOffset(caret.origin, caret.direction)
  );
}

/**
 * Return the range if it's in the given direction, otherwise
 * construct a new range using a flipped focus as the anchor
 * and a flipped anchor as the focus. This transformation
 * preserves the section of the document that it's working
 * with, but reverses the order of iteration.
 *
 * @param range Any CaretRange
 * @param direction The desired direction
 * @returns A CaretRange in direction
 */
export function $getCaretRangeInDirection<D extends CaretDirection>(
  range: CaretRange<CaretDirection>,
  direction: D,
): CaretRange<D> {
  if (range.direction === direction) {
    return range as CaretRange<D>;
  }
  return $getCaretRange(
    // focus and anchor get flipped here
    $getCaretInDirection(range.focus, direction),
    $getCaretInDirection(range.anchor, direction),
  );
}

/**
 * Get a caret pointing at the child at the given index, or the last
 * caret in that node if out of bounds.
 *
 * @param parent An ElementNode
 * @param index The index of the origin for the caret
 * @returns A caret pointing towards the node at that index
 */
export function $getChildCaretAtIndex<D extends CaretDirection>(
  parent: ElementNode,
  index: number,
  direction: D,
): NodeCaret<D> {
  let caret: NodeCaret<'next'> = $getChildCaret(parent, 'next');
  for (let i = 0; i < index; i++) {
    const nextCaret: null | SiblingCaret<LexicalNode, 'next'> =
      caret.getAdjacentCaret();
    if (nextCaret === null) {
      break;
    }
    caret = nextCaret;
  }
  return $getCaretInDirection(caret, direction);
}

/**
 * Returns the Node sibling when this exists, otherwise the closest parent sibling. For example
 * R -> P -> T1, T2
 *   -> P2
 * returns T2 for node T1, P2 for node T2, and null for node P2.
 * @param startCaret The initial caret
 * @param rootMode The root mode, 'root' (default) or 'shadowRoot'
 * @returns An array (tuple) containing the found caret and the depth difference, or null, if this node doesn't exist.
 */
export function $getAdjacentSiblingOrParentSiblingCaret<
  D extends CaretDirection,
>(
  startCaret: NodeCaret<D>,
  rootMode: RootMode = 'root',
): null | [NodeCaret<D>, number] {
  let depthDiff = 0;
  let caret = startCaret;
  let nextCaret = $getAdjacentChildCaret(caret);
  while (nextCaret === null) {
    depthDiff--;
    nextCaret = caret.getParentCaret(rootMode);
    if (!nextCaret) {
      return null;
    }
    caret = nextCaret;
    nextCaret = $getAdjacentChildCaret(caret);
  }
  return nextCaret && [nextCaret, depthDiff];
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
  const siblings = [];
  for (
    let caret = initialCaret.getAdjacentCaret();
    caret;
    caret = caret.getAdjacentCaret()
  ) {
    siblings.push(caret.origin);
  }
  return siblings;
}

export function $splitTextPointCaret<D extends CaretDirection>(
  textPointCaret: TextPointCaret<TextNode, D>,
): NodeCaret<D> {
  const {origin, offset, direction} = textPointCaret;
  if (offset === $getTextNodeOffset(origin, direction)) {
    return textPointCaret.getSiblingCaret();
  } else if (offset === $getTextNodeOffset(origin, flipDirection(direction))) {
    return $rewindSiblingCaret(textPointCaret.getSiblingCaret());
  }
  const [textNode] = origin.splitText(offset);
  invariant(
    $isTextNode(textNode),
    '$splitTextPointCaret: splitText must return at least one TextNode',
  );
  return $getCaretInDirection($getSiblingCaret(textNode, 'next'), direction);
}

export interface SplitAtPointCaretNextOptions {
  /** The function to create the right side of a split ElementNode (default {@link $copyNode}) */
  $copyElementNode?: (node: ElementNode) => ElementNode;
  /** The function to split a TextNode (default {@link $splitTextPointCaret}) */
  $splitTextPointCaretNext?: (
    caret: TextPointCaret<TextNode, 'next'>,
  ) => NodeCaret<'next'>;
  /** If the parent matches rootMode a split will not occur, default is 'shadowRoot' */
  rootMode?: RootMode;
  /**
   * If `element.canBeEmpty()` and it would create an empty split, this function will be
   * called with the element and 'first' | 'last'. If it returns false, the empty
   * split will not be created. Default is `() => true` to always split when possible.
   */
  $shouldSplit?: (node: ElementNode, edge: 'first' | 'last') => boolean;
  /**
   * If the destination would create an empty split on both sides, then
   * remove it instead of splitting. Default `false`.
   */
  removeEmptyDestination?: boolean;
}

function $alwaysSplit(_node: ElementNode, _edge: 'first' | 'last'): true {
  return true;
}

/**
 * Split a node at a PointCaret and return a NodeCaret at that point, or null if the
 * node can't be split. This is non-recursive and will only perform at most one split.
 *
 * @returns The NodeCaret pointing to the location of the split (or null if a split is not possible)
 */
export function $splitAtPointCaretNext(
  pointCaret: PointCaret<'next'>,
  {
    $copyElementNode = $copyNode,
    $splitTextPointCaretNext = $splitTextPointCaret,
    rootMode = 'shadowRoot',
    $shouldSplit = $alwaysSplit,
    removeEmptyDestination = false,
  }: SplitAtPointCaretNextOptions = {},
): null | NodeCaret<'next'> {
  if ($isTextPointCaret(pointCaret)) {
    return $splitTextPointCaretNext(pointCaret);
  }
  const parentCaret = pointCaret.getParentCaret(rootMode);
  if (parentCaret) {
    const {origin} = parentCaret;
    if ($isChildCaret(pointCaret)) {
      const beforeParentCaret = $rewindSiblingCaret(parentCaret);
      if (removeEmptyDestination && origin.isEmpty()) {
        origin.remove();
        return beforeParentCaret;
      }
      if (!(origin.canBeEmpty() && $shouldSplit(origin, 'first'))) {
        return beforeParentCaret;
      }
    }
    const siblings = $getAdjacentNodes(pointCaret);
    if (
      siblings.length > 0 ||
      (!removeEmptyDestination &&
        origin.canBeEmpty() &&
        $shouldSplit(origin, 'last'))
    ) {
      // Split and insert the siblings into the new tree
      parentCaret.insert($copyElementNode(origin).splice(0, 0, siblings));
    }
  }
  return parentCaret;
}

/**
 * If the insertion caret is the root/shadow root node (see {@link $isRootOrShadowRoot}),
 * the node will be inserted there, otherwise the parent nodes will be split according to the
 * given options.
 * @param node - The node to be inserted
 * @param caret - The location to insert or split from
 * @returns The node after its insertion
 */
export function $insertNodeToNearestRootAtCaret<
  T extends LexicalNode,
  D extends CaretDirection,
>(
  node: T,
  caret: PointCaret<D>,
  options?: SplitAtPointCaretNextOptions,
): NodeCaret<D> {
  let insertCaret: PointCaret<'next'> = $getCaretInDirection(caret, 'next');
  // Normalize boundary cases for TextPointCaret
  if ($isTextPointCaret(insertCaret)) {
    if (insertCaret.offset === 0) {
      insertCaret = $getSiblingCaret(
        insertCaret.origin,
        'previous',
      ).getFlipped();
    } else if (insertCaret.offset === insertCaret.origin.getTextContentSize()) {
      insertCaret = $getSiblingCaret(insertCaret.origin, 'next');
    }
  }
  // Make sure we have a distinct node as the origin
  if (insertCaret.origin.is(node)) {
    invariant(
      $isSiblingCaret(insertCaret),
      '$insertNodeToNearestRootAtCaret node %s of type %s can not be inserted into itself',
      node.getKey(),
      node.getType(),
    );
    insertCaret = $rewindSiblingCaret(insertCaret);
  }
  // Handle split boundary conditions where node is being inserted adjacent to itself
  if (
    node.is(insertCaret.getNodeAtCaret()) ||
    node.is(insertCaret.getFlipped().getNodeAtCaret())
  ) {
    node.remove(true);
  }
  for (
    let nextCaret: null | PointCaret<'next'> = insertCaret;
    nextCaret;
    nextCaret = $splitAtPointCaretNext(nextCaret, options)
  ) {
    insertCaret = nextCaret;
  }
  invariant(
    !$isTextPointCaret(insertCaret),
    '$insertNodeToNearestRootAtCaret: An unattached TextNode can not be split',
  );
  insertCaret.insert(
    node.isInline() ? $createParagraphNode().append(node) : node,
  );
  return $getCaretInDirection(
    $getSiblingCaret(node.getLatest(), 'next'),
    caret.direction,
  );
}
