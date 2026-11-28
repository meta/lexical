/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {
  $caretFromPoint,
  $extendCaretToRange,
  $findMatchingParent,
  $getPreviousSelection,
  $getSelection,
  $getSlotFrame,
  $getSlotHost,
  $hasAncestor,
  $isBlockContainer,
  $isChildCaret,
  $isDecoratorNode,
  $isElementNode,
  $isExtendableTextPointCaret,
  $isLeafNode,
  $isRangeSelection,
  $isTabNode,
  $isTextNode,
  $isTextPointCaret,
  $setSelection,
  type BaseSelection,
  type CaretDirection,
  type DecoratorNode,
  type ElementNode,
  flipDirection,
  getStyleObjectFromCSS,
  INTERNAL_$isBlock,
  INTERNAL_isInlineContent,
  type LexicalNode,
  type NodeKey,
  type Point,
  type PointCaret,
  type RangeSelection,
  type TextNode,
} from 'lexical';

import {$getComputedStyleForElement, $getComputedStyleForParent} from './utils';

export function $copyBlockFormatIndent(
  srcNode: ElementNode,
  destNode: ElementNode,
): void {
  const format = srcNode.getFormatType();
  const indent = srcNode.getIndent();
  if (format !== destNode.getFormatType()) {
    destNode.setFormat(format);
  }
  if (indent !== destNode.getIndent()) {
    destNode.setIndent(indent);
  }
}

/**
 * Determine whether a point sits at the leading ('previous') or trailing
 * ('next') edge of `element`'s content — i.e. there is no content between the
 * point and that edge of the element.
 *
 * This is the caret-based generalization of {@link $isAtNodeEnd}. An empty
 * `element` is considered to be at both of its edges. `@lexical/utils`
 * re-exports this as the direction-specific `$isAtStartOfNode` /
 * `$isAtEndOfNode` helpers.
 *
 * @param point - The point to test.
 * @param element - The ancestor element whose edge is tested.
 * @param direction - 'previous' for the start of `element`, 'next' for the end.
 */
export function $isAtEdgeOfElement(
  point: Point,
  element: ElementNode,
  direction: CaretDirection,
): boolean {
  // An extendable TextPointCaret has text remaining in `direction`, so the
  // point is in the middle of a TextNode rather than at the element edge.
  let caret: PointCaret<typeof direction> | null = $caretFromPoint(
    point,
    direction,
  );
  if ($isExtendableTextPointCaret(caret)) {
    return false;
  }
  // Walk up towards element: the point is at the edge only when nothing
  // precedes it in `direction` at every level up to element. The match is read
  // from getParentAtCaret (origin.getParent()) rather than from a CaretRange
  // iteration, because iterating ascends via getParentCaret, which stops at the
  // document root and at shadow-root/slot boundaries — so it would never yield
  // `element` when `element` is itself such a boundary (e.g. a named slot's
  // value, a shadow root).
  for (; caret; caret = caret.getParentCaret()) {
    const parent = caret.getParentAtCaret();
    if (!parent || caret.getNodeAtCaret()) {
      return false;
    }
    if (element.is(parent)) {
      return true;
    }
  }
  return false;
}

/**
 * Determine whether a point sits at the edge of a block in the given
 * direction: 'previous' for the start of the block, 'next' for the end.
 *
 * Unlike {@link $isAtEdgeOfElement}, an empty block is treated as not being at
 * the edge: when an ElementNode is empty it's not possible to distinguish if
 * the selection's intent is the entire block or the edge so we consider it to
 * be the entire block.
 */
function $isPointAtBlockEdge(
  point: Point,
  block: ElementNode,
  direction: CaretDirection,
): boolean {
  const node = point.getNode();
  if ($isElementNode(node) && node.isEmpty()) {
    return false;
  }
  return $isAtEdgeOfElement(point, block, direction);
}

/**
 * Converts all nodes in the selection that are of one block type to another.
 * @param selection - The selected blocks to be converted.
 * @param $createElement - The function that creates the node. eg. $createParagraphNode.
 * @param $afterCreateElement - The function that updates the new node based on the previous one ($copyBlockFormatIndent by default)
 */
export function $setBlocksType<T extends ElementNode>(
  selection: BaseSelection | null,
  $createElement: () => T,
  $afterCreateElement: (
    prevNodeSrc: ElementNode,
    newNodeDest: T,
  ) => void = $copyBlockFormatIndent,
): void {
  if (!selection) {
    return;
  }
  // Selections tend to not include their containing blocks so we effectively
  // expand it here
  const anchorAndFocus = selection.getStartEndPoints();
  let skipFocus = false;
  let focusBlock: ElementNode | DecoratorNode<unknown> | null = null;
  const blockMap = new Map<NodeKey, ElementNode>();
  if (anchorAndFocus) {
    const [anchor, focus] = anchorAndFocus;
    const anchorBlock = $findMatchingParent(
      anchor.getNode(),
      INTERNAL_$isBlock,
    );
    focusBlock = $findMatchingParent(focus.getNode(), INTERNAL_$isBlock);
    // The focus is the moving edge of the selection, travelling in `direction`
    // (towards the end of the document for a forward selection). When a
    // selection overshoots, its focus lands at the leading edge of focusBlock
    // in that direction — the edge opposite to travel — so focusBlock holds
    // none of the selection and is skipped.
    const direction = selection.isBackward() ? 'previous' : 'next';
    skipFocus =
      $isElementNode(focusBlock) &&
      !focusBlock.is(anchorBlock) &&
      $isPointAtBlockEdge(focus, focusBlock, flipDirection(direction));
    if ($isElementNode(anchorBlock)) {
      blockMap.set(anchorBlock.getKey(), anchorBlock);
    }
    if ($isElementNode(focusBlock) && !skipFocus) {
      blockMap.set(focusBlock.getKey(), focusBlock);
    }
  }
  for (const node of selection.getNodes()) {
    if ($isElementNode(node) && INTERNAL_$isBlock(node)) {
      if (skipFocus && node.is(focusBlock)) {
        continue;
      }
      blockMap.set(node.getKey(), node);
    } else if (!anchorAndFocus) {
      const ancestorBlock = $findMatchingParent(node, INTERNAL_$isBlock);
      if ($isElementNode(ancestorBlock)) {
        blockMap.set(ancestorBlock.getKey(), ancestorBlock);
      }
    }
  }
  // Selection remapping is delegated to LexicalNode.replace (and the
  // ListItemNode.replace override): both remap an element-anchored point
  // on the replaced block to {key: replacement, offset: prevSize + offset}.
  for (const prevNode of blockMap.values()) {
    if ($getSlotHost(prevNode) !== null) {
      continue;
    }
    if ($isBlockContainer(prevNode)) {
      // An empty declared container (roots and shadow roots are never in
      // the map) is not a block to convert: with a selection point in it
      // (either end, in either direction), the new block goes in it, as
      // with $insertList and $wrapNodes. The container stays, so its indent
      // and format are not copied, and the points in it move into the new
      // block (a range keeps its other end). A replacement above may have
      // made a new active selection, so its points count too.
      const points: Point[] = [];
      for (const s of new Set([selection, $getSelection()])) {
        if ($isRangeSelection(s)) {
          for (const point of [s.anchor, s.focus]) {
            if (point.key === prevNode.getKey()) {
              points.push(point);
            }
          }
        }
      }
      if (points.length > 0 && prevNode.isEmpty()) {
        const element = $createElement();
        prevNode.append(element);
        for (const point of points) {
          point.set(element.getKey(), 0, 'element');
        }
      }
      continue;
    }
    const element = $createElement();
    $afterCreateElement(prevNode, element);
    prevNode.replace(element, true);
  }
}

function isPointAttached(point: Point): boolean {
  return point.getNode().isAttached();
}

function $removeParentEmptyElements(startingNode: ElementNode): void {
  let node: ElementNode | null = startingNode;

  while (node !== null && !$isBlockContainer(node)) {
    const latest = node.getLatest();
    const parentNode: ElementNode | null = node.getParent();

    if (latest.getChildrenSize() === 0) {
      node.remove(true);
    }

    node = parentNode;
  }
}

/**
 * The block whose content $wrapNodes moves for `node`: `node` itself or its
 * nearest ancestor that is an element and not inline content, as the node
 * structure normalization counts it (so a link inside a mark, or the
 * character limit's OverflowNode, whose isInline() is false, stays in its
 * block). The walk never leaves the block container (root, shadow root,
 * inline or not, or declared container) that holds `node`: it returns that
 * container when it gets there.
 */
function $wrappedBlock(
  node: LexicalNode,
  cache: Map<NodeKey, ElementNode | null> = new Map(),
): ElementNode | null {
  // `cache` holds the block found for each node already walked through, so
  // the nodes of one selection walk each ancestor once.
  const walked: NodeKey[] = [];
  let block: LexicalNode | null = node;
  let found: ElementNode | null | undefined;
  while (found === undefined) {
    if (block === null) {
      found = null;
    } else if (cache.has(block.getKey())) {
      found = cache.get(block.getKey());
    } else if (
      $isBlockContainer(block) ||
      ($isElementNode(block) && !INTERNAL_isInlineContent(block))
    ) {
      found = block;
    } else {
      walked.push(block.getKey());
      block = block.getParent();
    }
  }
  for (const key of walked) {
    cache.set(key, found);
  }
  return found;
}

/**
 * A leaf that is a block of its own (a block decorator, such as a horizontal
 * rule) in an element that is not a block container but holds blocks only
 * (a box that declares no structure): it is wrapped on its own, as it is in a
 * block container. Why: taking its parent for its block moved all the
 * parent's children into one new element, those before the range included,
 * and the new elements then went next to one of them, inside that new
 * element: the update never returned (#9638). Where the parent also holds
 * inline content directly, the parent is the block of that content, and of
 * the leaf, as before: its children move together, and the new elements go
 * where it is. `cache` holds the answer for each parent already looked at.
 */
function $isBlockLeafInElement(
  node: LexicalNode,
  cache: Map<NodeKey, boolean> = new Map(),
): boolean {
  const parent = node.getParent();
  if (
    parent === null ||
    !$isLeafNode(node) ||
    INTERNAL_isInlineContent(node) ||
    $isBlockContainer(parent)
  ) {
    return false;
  }
  let blocksOnly = cache.get(parent.getKey());
  if (blocksOnly === undefined) {
    blocksOnly = parent
      .getChildren()
      .every(child => !INTERNAL_isInlineContent(child));
    cache.set(parent.getKey(), blocksOnly);
  }
  return blocksOnly;
}

/** An empty element that is not inline content. */
function $isEmptyBlock(node: LexicalNode): node is ElementNode {
  return (
    $isElementNode(node) &&
    node.getChildrenSize() === 0 &&
    !INTERNAL_isInlineContent(node)
  );
}

/**
 * The child of block container `container` that holds `node`. `cache`
 * holds the child found for each node already walked through, so the nodes
 * of one selection walk each ancestor once.
 */
function $childIn(
  container: ElementNode,
  node: LexicalNode,
  cache: Map<NodeKey, LexicalNode> = new Map(),
): LexicalNode {
  const walked: NodeKey[] = [];
  let child = node;
  let found = cache.get(child.getKey());
  while (found === undefined) {
    const parent: ElementNode | null = child.getParent();
    if (parent === null || parent.is(container)) {
      found = child;
      break;
    }
    walked.push(child.getKey());
    child = parent;
    found = cache.get(child.getKey());
  }
  for (const key of walked) {
    cache.set(key, found);
  }
  cache.set(node.getKey(), found);
  return found;
}

/**
 * The run of inline content `child`, inline content that is a child of a
 * block container, is in: it and its siblings on both sides up to the
 * nearest ones that are not inline content. $wrapNodes wraps such a run,
 * not the container's children.
 */
function $inlineRun(child: LexicalNode): LexicalNode[] {
  let first = child;
  for (
    let prev = first.getPreviousSibling();
    prev !== null && INTERNAL_isInlineContent(prev);
    prev = prev.getPreviousSibling()
  ) {
    first = prev;
  }
  const run: LexicalNode[] = [];
  for (
    let it: LexicalNode | null = first;
    it !== null && INTERNAL_isInlineContent(it);
    it = it.getNextSibling()
  ) {
    run.push(it);
  }
  return run;
}

/**
 * @deprecated In favor of $setBlockTypes
 * Wraps all nodes in the selection into another node of the type returned by createElement.
 * @param selection - The selection of nodes to be wrapped.
 * @param createElement - A function that creates the wrapping ElementNode. eg. $createParagraphNode.
 * @param wrappingElement - An element to append the wrapped selection and its children to.
 */
export function $wrapNodes(
  selection: BaseSelection,
  createElement: () => ElementNode,
  wrappingElement: null | ElementNode = null,
): void {
  const anchorAndFocus = selection.getStartEndPoints();
  const anchor = anchorAndFocus ? anchorAndFocus[0] : null;
  const nodes = selection.getNodes();
  const nodesLength = nodes.length;

  // A selection inside a bare-block named-slot value has nothing eligible to
  // wrap: the slot value is the only block in its virtual scope and its slot
  // assignment is managed by the node or extension that owns the slot, so
  // this is a no-op (same rule as $setBlocksType). A shadow-root slot value
  // or block container value is root-like and wraps its own subtree below,
  // as usual. (A selection never crosses a slot boundary, so checking the
  // anchor covers the whole selection.)
  if (anchor !== null) {
    const slotFrame = $getSlotFrame(anchor.getNode());
    if (slotFrame !== null && !$isBlockContainer(slotFrame)) {
      return;
    }
  }

  if (
    anchor !== null &&
    (nodesLength === 0 ||
      (nodesLength === 1 &&
        anchor.type === 'element' &&
        anchor.getNode().getChildrenSize() === 0))
  ) {
    const target = $wrappedBlock(anchor.getNode());
    if (target === null) {
      return;
    }
    const children = target.getChildren();
    let element = createElement();
    // An empty container stays and the new block goes in it, so the new
    // block does not take the container's indent and format.
    const intoContainer = $isBlockContainer(target);
    if (!intoContainer) {
      element.setFormat(target.getFormatType());
      element.setIndent(target.getIndent());
    }
    children.forEach(child => element.append(child));

    if (wrappingElement) {
      element = wrappingElement.append(element);
    }

    if (intoContainer) {
      target.append(element);
      element.selectStart();
    } else {
      target.replace(element);
    }

    return;
  }

  let topLevelNode = null;
  let descendants: LexicalNode[] = [];
  for (let i = 0; i < nodesLength; i++) {
    const node = nodes[i];
    // Determine whether wrapping has to be broken down into multiple chunks. This can happen if the
    // user selected multiple Root-like nodes that have to be treated separately as if they are
    // their own branch. I.e. you don't want to wrap a whole table, but rather the contents of each
    // of each of the cell nodes.
    if ($isBlockContainer(node)) {
      $wrapNodesImpl(
        selection,
        descendants,
        descendants.length,
        createElement,
        wrappingElement,
      );
      descendants = [];
      topLevelNode = node;
    } else if (
      topLevelNode === null ||
      (topLevelNode !== null && $hasAncestor(node, topLevelNode))
    ) {
      descendants.push(node);
    } else {
      $wrapNodesImpl(
        selection,
        descendants,
        descendants.length,
        createElement,
        wrappingElement,
      );
      descendants = [node];
    }
  }
  $wrapNodesImpl(
    selection,
    descendants,
    descendants.length,
    createElement,
    wrappingElement,
  );
}

/**
 * Wraps each node into a new ElementNode.
 * @param selection - The selection of nodes to wrap.
 * @param nodes - An array of nodes, generally the descendants of the selection.
 * @param nodesLength - The length of nodes.
 * @param createElement - A function that creates the wrapping ElementNode. eg. $createParagraphNode.
 * @param wrappingElement - An element to wrap all the nodes into.
 * @returns
 */
export function $wrapNodesImpl(
  selection: BaseSelection,
  nodes: LexicalNode[],
  nodesLength: number,
  createElement: () => ElementNode,
  wrappingElement: null | ElementNode = null,
): void {
  if (nodes.length === 0) {
    return;
  }

  // The first node that is moved, or that an empty block stands for: the
  // nodes before it give nothing to the new elements (a block that the
  // range starts at the end of), so the elements go where it is.
  const firstNode =
    nodes.find(
      (node, i) =>
        i < nodesLength &&
        (($isLeafNode(node) && node.getParent() !== null) ||
          $isEmptyBlock(node)),
    ) ?? nodes[0];
  const elementMapping: Map<NodeKey, ElementNode> = new Map();
  const elements = [];
  // The below logic is to find the right target for us to
  // either insertAfter/insertBefore/append the corresponding
  // elements to. This is made more complicated due to nested
  // structures.
  const blockOf = new Map<NodeKey, ElementNode | null>();
  const childOf = new Map<NodeKey, LexicalNode>();
  const blockLeafParents = new Map<NodeKey, boolean>();
  const emptyElements = new Set();

  // Find any top level empty elements
  for (let i = 0; i < nodesLength; i++) {
    const node = nodes[i];

    if ($isEmptyBlock(node)) {
      emptyElements.add(node.getKey());
    }
  }

  const movedNodes: Set<NodeKey> = new Set();

  // The nodes the moves empty are removed once the new elements are in the
  // document: a removal that adjusts the selection (a list item's) compared
  // a point in a new element with one in the document, which then had no
  // common ancestor.
  const removals: (() => void)[] = [];

  // The block of each node, decided before anything moves: once a block's
  // content is in its new element, a node deep inside it would otherwise
  // find the new element as its block. For inline content directly in a
  // block container, the run it is in (see $inlineRun) stands for the
  // block: the container's blocks are wrapped on their own.
  type Unit = {block: ElementNode; key: NodeKey; run: LexicalNode[] | null};
  const units: (Unit | null)[] = [];
  const runOf = new Map<NodeKey, Unit>();
  for (let i = 0; i < nodesLength; i++) {
    const nodeParent = nodes[i].getParent();
    if (
      nodeParent !== null &&
      $isBlockLeafInElement(nodes[i], blockLeafParents)
    ) {
      units.push({block: nodeParent, key: nodes[i].getKey(), run: [nodes[i]]});
      continue;
    }
    const block =
      nodeParent === null ? null : $wrappedBlock(nodeParent, blockOf);
    if (block === null || !$isBlockContainer(block)) {
      units.push(block && {block, key: block.getKey(), run: null});
      continue;
    }
    const child = $childIn(block, nodes[i], childOf);
    const inline = INTERNAL_isInlineContent(child);
    if (!inline && !$isLeafNode(child)) {
      // A block element in the container: its own content is wrapped.
      units.push(null);
      continue;
    }
    let unit = runOf.get(child.getKey());
    if (unit === undefined) {
      // A block leaf (a decorator) is wrapped on its own.
      const run = inline ? $inlineRun(child) : [child];
      unit = {block, key: run[0].getKey(), run};
      for (const node of run) {
        runOf.set(node.getKey(), unit);
      }
    }
    units.push(unit);
  }

  // Direct text in a mixed block moves all of that block's children. Its
  // nested blocks must not move separately, or the insertion anchor can
  // move inside a new element and the children can change order (#9665).
  const wholeBlocks = new Map<NodeKey, Unit>();
  for (let i = 0; i < nodesLength; i++) {
    const unit = units[i];
    if (unit !== null && unit.run === null && $isLeafNode(nodes[i])) {
      wholeBlocks.set(unit.key, unit);
    }
  }
  const coveringBlocks = new Map<NodeKey, Unit | null>();
  const $coveringBlock = (start: LexicalNode): Unit | null => {
    const walked: NodeKey[] = [];
    let node: LexicalNode | null = start;
    let covering: Unit | null = null;
    while (node !== null && !$isBlockContainer(node)) {
      const key = node.getKey();
      if (coveringBlocks.has(key)) {
        covering = coveringBlocks.get(key) ?? null;
        break;
      }
      walked.push(key);
      node = node.getParent();
    }
    for (let i = walked.length - 1; i >= 0; i--) {
      const key = walked[i];
      covering = covering ?? wholeBlocks.get(key) ?? null;
      coveringBlocks.set(key, covering);
    }
    return covering;
  };
  for (let i = 0; i < nodesLength; i++) {
    const unit = units[i];
    if (unit !== null) {
      units[i] = $coveringBlock(unit.block) ?? unit;
    }
    if (emptyElements.has(nodes[i].getKey()) && $coveringBlock(nodes[i])) {
      emptyElements.delete(nodes[i].getKey());
    }
  }

  const firstUnit = emptyElements.has(firstNode.getKey())
    ? null
    : units[nodes.indexOf(firstNode)];
  const firstNodeBlock =
    firstUnit == null ? $wrappedBlock(firstNode, blockOf) : firstUnit.block;
  if (firstNodeBlock === null) {
    return;
  }
  // Choose the anchor from the whole unit that actually moves, not a
  // descendant whose preceding sibling may move along with that unit.
  let target: LexicalNode =
    firstUnit != null && firstUnit.run !== null
      ? firstUnit.run[0]
      : firstNodeBlock;
  if (firstUnit == null && $isBlockContainer(firstNodeBlock)) {
    const child = $childIn(firstNodeBlock, firstNode, childOf);
    target = INTERNAL_isInlineContent(child) ? $inlineRun(child)[0] : child;
  }

  let targetIsPrevSibling = false;
  while (target !== null) {
    const prevSibling: LexicalNode | null = target.getPreviousSibling();
    if (prevSibling !== null) {
      target = prevSibling;
      targetIsPrevSibling = true;
      break;
    }
    target = target.getParentOrThrow();
    if ($isBlockContainer(target)) {
      break;
    }
  }

  // Move out all leaf nodes into our elements array.
  // If we find a top level empty element, also move make
  // an element for that.
  for (let i = 0; i < nodesLength; i++) {
    const node = nodes[i];
    const unit = units[i];

    if (unit !== null && $isLeafNode(node) && !movedNodes.has(node.getKey())) {
      const parent = unit.block;
      const parentKey = unit.key;

      if (elementMapping.get(parentKey) === undefined) {
        const targetElement = createElement();
        if (unit.run === null) {
          targetElement.setFormat(parent.getFormatType());
          targetElement.setIndent(parent.getIndent());
        }
        elements.push(targetElement);
        elementMapping.set(parentKey, targetElement);
        // Move node and its siblings to the new
        // element.
        const children = unit.run ?? parent.getChildren();
        targetElement.splice(targetElement.getChildrenSize(), 0, children);
        for (const child of children) {
          movedNodes.add(child.getKey());
          if ($isElementNode(child)) {
            // Skip nested leaf nodes if the parent has already been moved
            for (const key of child.getChildrenKeys()) {
              movedNodes.add(key);
            }
          }
        }
        removals.push(() => $removeParentEmptyElements(parent));
      }
    } else if (emptyElements.has(node.getKey())) {
      invariant(
        $isElementNode(node),
        'Expected node in emptyElements to be an ElementNode',
      );
      const targetElement = createElement();
      targetElement.setFormat(node.getFormatType());
      targetElement.setIndent(node.getIndent());
      elements.push(targetElement);
      removals.push(() => node.remove(true));
    }
  }

  if (wrappingElement !== null) {
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      wrappingElement.append(element);
    }
  }
  let lastElement = null;

  // If our target is Root-like, let's see if we can re-adjust
  // so that the target is the first child instead.
  if ($isBlockContainer(target)) {
    if (targetIsPrevSibling) {
      if (wrappingElement !== null) {
        target.insertAfter(wrappingElement);
      } else {
        for (let i = elements.length - 1; i >= 0; i--) {
          const element = elements[i];
          target.insertAfter(element);
        }
      }
    } else {
      // Capture the narrowed type, the reassignment of target below would
      // otherwise widen it back to LexicalNode
      const rootTarget = target;
      const firstChild = rootTarget.getFirstChild();

      if ($isElementNode(firstChild)) {
        target = firstChild;
      }

      if (firstChild === null) {
        if (wrappingElement) {
          rootTarget.append(wrappingElement);
        } else {
          for (let i = 0; i < elements.length; i++) {
            const element = elements[i];
            rootTarget.append(element);
            lastElement = element;
          }
        }
      } else {
        if (wrappingElement !== null) {
          firstChild.insertBefore(wrappingElement);
        } else {
          for (let i = 0; i < elements.length; i++) {
            const element = elements[i];
            firstChild.insertBefore(element);
            lastElement = element;
          }
        }
      }
    }
  } else {
    if (wrappingElement) {
      target.insertAfter(wrappingElement);
    } else {
      for (let i = elements.length - 1; i >= 0; i--) {
        const element = elements[i];
        target.insertAfter(element);
        lastElement = element;
      }
    }
  }

  for (const removal of removals) {
    removal();
  }

  const prevSelection = $getPreviousSelection();

  if (
    $isRangeSelection(prevSelection) &&
    isPointAttached(prevSelection.anchor) &&
    isPointAttached(prevSelection.focus)
  ) {
    $setSelection(prevSelection.clone());
  } else if (lastElement !== null) {
    lastElement.selectEnd();
  } else {
    selection.dirty = true;
  }
}

/**
 * Tests if the selection's parent element has vertical writing mode.
 * @param selection - The selection whose parent to test.
 * @returns true if the selection's parent has vertical writing mode (writing-mode: vertical-rl), false otherwise.
 */
function $isEditorVerticalOrientation(selection: RangeSelection): boolean {
  const computedStyle = $getComputedStyle(selection);
  return computedStyle !== null && computedStyle.writingMode === 'vertical-rl';
}

/**
 * Gets the computed DOM styles of the parent of the selection's anchor node.
 * @param selection - The selection to check the styles for.
 * @returns the computed styles of the node or null if there is no DOM element or no default view for the document.
 */
function $getComputedStyle(
  selection: RangeSelection,
): CSSStyleDeclaration | null {
  const anchorNode = selection.anchor.getNode();
  if ($isElementNode(anchorNode)) {
    return $getComputedStyleForElement(anchorNode);
  }
  return $getComputedStyleForParent(anchorNode);
}

/**
 * Determines if the default character selection should be overridden. Used with DecoratorNodes
 * @param selection - The selection whose default character selection may need to be overridden.
 * @param isBackward - Is the selection backwards (the focus comes before the anchor)?
 * @returns true if it should be overridden, false if not.
 */
export function $shouldOverrideDefaultCharacterSelection(
  selection: RangeSelection,
  isBackward: boolean,
): boolean {
  const isVertical = $isEditorVerticalOrientation(selection);

  // In vertical writing mode, we adjust the direction for correct caret movement
  let adjustedIsBackward = isVertical ? !isBackward : isBackward;

  // In right-to-left writing mode, we invert the direction for correct caret movement
  if ($isParentElementRTL(selection)) {
    adjustedIsBackward = !adjustedIsBackward;
  }

  const focusCaret = $caretFromPoint(
    selection.focus,
    adjustedIsBackward ? 'previous' : 'next',
  );
  if ($isExtendableTextPointCaret(focusCaret)) {
    return false;
  }
  // At an unmergeable TextNode boundary adjacent to another plain TextNode,
  // override so Lexical's modify() can pre-normalize across inline-grid/flex
  // spans (#7301). Restricted to unmergeable nodes to avoid disrupting
  // format-affinity at normal bold/italic boundaries.
  if (
    $isTextPointCaret(focusCaret) &&
    !$isTabNode(focusCaret.origin) &&
    focusCaret.origin.isUnmergeable()
  ) {
    const sibling = focusCaret.getNodeAtCaret();
    if ($isTextNode(sibling) && !$isTabNode(sibling)) {
      return true;
    }
  }
  for (const nextCaret of $extendCaretToRange(focusCaret)) {
    if ($isChildCaret(nextCaret)) {
      return !nextCaret.origin.isInline();
    } else if ($isElementNode(nextCaret.origin)) {
      continue;
    } else if ($isDecoratorNode(nextCaret.origin)) {
      return true;
    }
    break;
  }
  return false;
}

/**
 * Moves the selection according to the arguments.
 * @param selection - The selected text or nodes.
 * @param isHoldingShift - Is the shift key being held down during the operation.
 * @param isBackward - Is the selection selected backwards (the focus comes before the anchor)?
 * @param granularity - The distance to adjust the current selection.
 */
export function $moveCaretSelection(
  selection: RangeSelection,
  isHoldingShift: boolean,
  isBackward: boolean,
  granularity: 'character' | 'word' | 'lineboundary',
): void {
  selection.modify(isHoldingShift ? 'extend' : 'move', isBackward, granularity);
}

/**
 * Tests a parent element for right to left direction.
 * @param selection - The selection whose parent is to be tested.
 * @returns true if the selections' parent element has a direction of 'rtl' (right to left), false otherwise.
 */
export function $isParentElementRTL(selection: RangeSelection): boolean {
  const computedStyle = $getComputedStyle(selection);
  return computedStyle !== null && computedStyle.direction === 'rtl';
}

/**
 * Moves selection by character according to arguments.
 * @param selection - The selection of the characters to move.
 * @param isHoldingShift - Is the shift key being held down during the operation.
 * @param isBackward - Is the selection backward (the focus comes before the anchor)?
 */
export function $moveCharacter(
  selection: RangeSelection,
  isHoldingShift: boolean,
  isBackward: boolean,
): void {
  const isRTL = $isParentElementRTL(selection);
  const isVertical = $isEditorVerticalOrientation(selection);

  // In vertical-rl writing mode, arrow key directions need to be flipped
  // to match the visual flow of text (top to bottom, right to left)
  let adjustedIsBackward;

  if (isVertical) {
    // In vertical-rl mode, we need to completely invert the direction
    // Left arrow (backward) should move down (forward)
    // Right arrow (forward) should move up (backward)
    adjustedIsBackward = !isBackward;
  } else if (isRTL) {
    // In horizontal RTL mode, use the standard RTL behavior
    adjustedIsBackward = !isBackward;
  } else {
    // Standard LTR horizontal text
    adjustedIsBackward = isBackward;
  }

  // Apply the direction adjustment to move the caret
  $moveCaretSelection(
    selection,
    isHoldingShift,
    adjustedIsBackward,
    'character',
  );
}

/**
 * Returns the current value of a CSS property for Nodes, if set. If not set, it returns the defaultValue.
 * @param node - The node whose style value to get.
 * @param styleProperty - The CSS style property.
 * @param defaultValue - The default value for the property.
 * @returns The value of the property for node.
 */
function $getNodeStyleValueForProperty(
  node: TextNode,
  styleProperty: string,
  defaultValue: string,
): string {
  const css = node.getStyle();
  const styleObject = getStyleObjectFromCSS(css);

  if (styleObject !== null) {
    return styleObject[styleProperty] || defaultValue;
  }

  return defaultValue;
}

/**
 * Returns the current value of a CSS property for TextNodes in the Selection, if set. If not set, it returns the defaultValue.
 * If all TextNodes do not have the same value, it returns an empty string.
 * @param selection - The selection of TextNodes whose value to find.
 * @param styleProperty - The CSS style property.
 * @param defaultValue - The default value for the property, defaults to an empty string.
 * @returns The value of the property for the selected TextNodes.
 */
export function $getSelectionStyleValueForProperty(
  selection: BaseSelection,
  styleProperty: string,
  defaultValue = '',
): string {
  let styleValue: string | null = null;
  const nodes = selection.getNodes();

  // The anchor/focus boundary handling below is specific to RangeSelection;
  // other selection types (e.g. table) style every node they contain.
  let startNode: LexicalNode | undefined;
  let endNode: LexicalNode | undefined;
  if ($isRangeSelection(selection)) {
    if (selection.isCollapsed() && selection.style !== '') {
      const styleObject = getStyleObjectFromCSS(selection.style);

      if (styleObject !== null && styleProperty in styleObject) {
        return styleObject[styleProperty];
      }
    }
    const {anchor, focus} = selection;
    const isBackward = selection.isBackward();
    const firstNode = isBackward ? focus.getNode() : anchor.getNode();
    const lastNode = isBackward ? anchor.getNode() : focus.getNode();
    const startOffset = isBackward ? focus.offset : anchor.offset;
    const endOffset = isBackward ? anchor.offset : focus.offset;
    // A boundary node contributes no styled text when the selection merely
    // touches its edge: the first node when the start offset is at its very
    // end, and the last node when the end offset is at its very beginning.
    if (
      $isTextNode(firstNode) &&
      startOffset === firstNode.getTextContentSize()
    ) {
      startNode = firstNode;
    }
    if (endOffset === 0) {
      endNode = lastNode;
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    // Skip the excluded boundary node for this position (startNode at the
    // head, endNode elsewhere); both are undefined when nothing is excluded.
    if ($isTextNode(node) && !node.is(i === 0 ? startNode : endNode)) {
      const nodeStyleValue = $getNodeStyleValueForProperty(
        node,
        styleProperty,
        defaultValue,
      );

      if (styleValue === null) {
        styleValue = nodeStyleValue;
      } else if (styleValue !== nodeStyleValue) {
        // multiple text nodes are in the selection and they don't all
        // have the same style.
        styleValue = '';
        break;
      }
    }
  }

  return styleValue === null ? defaultValue : styleValue;
}
