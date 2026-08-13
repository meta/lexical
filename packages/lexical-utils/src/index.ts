/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import invariant from '@lexical/internal/invariant';
import {$isAtEdgeOfElement} from '@lexical/selection';
import {
  $getSlotFrame,
  CAN_USE_BEFORE_INPUT,
  CAN_USE_DOM,
  getParentElement,
  IS_ANDROID,
  IS_ANDROID_CHROME,
  IS_APPLE,
  IS_APPLE_WEBKIT,
  IS_CHROME,
  IS_FIREFOX,
  IS_IOS,
  IS_SAFARI,
} from 'lexical';
import {
  $caretFromPoint,
  $caretRangeFromSelection,
  $cloneWithProperties,
  $comparePointCaretNext,
  $createParagraphNode,
  $findMatchingParent,
  $fullReconcile,
  $getAdjacentChildCaret,
  $getAdjacentSiblingOrParentSiblingCaret,
  $getCaretInDirection,
  $getCaretRange,
  $getCaretRangeInDirection,
  $getChildCaret,
  $getChildCaretOrSelf,
  $getCollapsedCaretRange,
  $getPreviousSelection,
  $getRoot,
  $getSelection,
  $getSiblingCaret,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $getState,
  $insertNodeToNearestRootAtCaret,
  $isChildCaret,
  $isElementNode,
  $isRangeSelection,
  $isSiblingCaret,
  $isSlotHost,
  $isTextPointCaret,
  $normalizeCaret,
  $removeTextFromCaretRange,
  $rewindSiblingCaret,
  $setSelection,
  $setSelectionFromCaretRange,
  $setState,
  $splitAtPointCaretNext,
  type CaretDirection,
  type CaretRange,
  type EditorState,
  type ElementNode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  makeStepwiseIterator,
  type NodeCaret,
  type NodeKey,
  type PasteCommandType,
  type PointCaret,
  type PointType,
  type RangeSelection,
  type SiblingCaret,
  type StateConfig,
  type ValueOrUpdater,
} from 'lexical';

export {default as dedupeSelectionRects} from './dedupeSelectionRects';
export {default as markSelection} from './markSelection';
export {default as positionNodeOnRange} from './positionNodeOnRange';
export {default as selectionAlwaysOnDisplay} from './selectionAlwaysOnDisplay';
export {
  $findMatchingParent,
  $getAdjacentSiblingOrParentSiblingCaret,
  $splitNode,
  addClassNamesToElement,
  isBlockDomNode,
  isHTMLAnchorElement,
  isHTMLElement,
  isInlineDomNode,
  mergeRegister,
  removeClassNamesFromElement,
} from 'lexical';

const __DEV__ = process.env.NODE_ENV !== 'production';
export {
  CAN_USE_BEFORE_INPUT,
  CAN_USE_DOM,
  IS_ANDROID,
  IS_ANDROID_CHROME,
  IS_APPLE,
  IS_APPLE_WEBKIT,
  IS_CHROME,
  IS_FIREFOX,
  IS_IOS,
  IS_SAFARI,
};

/**
 * Returns true if the file type matches the types passed within the acceptableMimeTypes array, false otherwise.
 * The types passed must be strings and are CASE-SENSITIVE.
 * eg. if file is of type 'text' and acceptableMimeTypes = ['TEXT', 'IMAGE'] the function will return false.
 * @param file - The file you want to type check.
 * @param acceptableMimeTypes - An array of strings of types which the file is checked against.
 * @returns true if the file is an acceptable mime type, false otherwise.
 */
export function isMimeType(file: File, acceptableMimeTypes: string[]): boolean {
  for (const acceptableType of acceptableMimeTypes) {
    if (file.type.startsWith(acceptableType)) {
      return true;
    }
  }
  return false;
}

/**
 * Lexical File Reader with:
 *  1. MIME type support
 *  2. batched results (HistoryPlugin compatibility)
 *  3. Order aware (respects the order when multiple Files are passed)
 *
 * const filesResult = await mediaFileReader(files, ['image/']);
 * filesResult.forEach(file => editor.dispatchCommand('INSERT_IMAGE', \\{
 *   src: file.result,
 * \\}));
 */
export function mediaFileReader(
  files: File[],
  acceptableMimeTypes: string[],
): Promise<{file: File; result: string}[]> {
  const filesIterator = files[Symbol.iterator]();
  return new Promise((resolve, reject) => {
    const processed: {file: File; result: string}[] = [];
    const handleNextFile = () => {
      const {done, value: file} = filesIterator.next();
      if (done) {
        return resolve(processed);
      }
      const fileReader = new FileReader();
      fileReader.addEventListener('error', reject);
      fileReader.addEventListener('load', () => {
        const result = fileReader.result;
        if (typeof result === 'string') {
          processed.push({file, result});
        }
        handleNextFile();
      });
      if (isMimeType(file, acceptableMimeTypes)) {
        fileReader.readAsDataURL(file);
      } else {
        handleNextFile();
      }
    };
    handleNextFile();
  });
}

export interface DFSNode {
  readonly depth: number;
  readonly node: LexicalNode;
}

/**
 * "Depth-First Search" starts at the root/top node of a tree and goes as far as it can down a branch end
 * before backtracking and finding a new path. Consider solving a maze by hugging either wall, moving down a
 * branch until you hit a dead-end (leaf) and backtracking to find the nearest branching path and repeat.
 * It will then return all the nodes found in the search in an array of objects.
 * Preorder traversal is used, meaning that nodes are listed in the order of when they are FIRST encountered.
 *
 * Children-only spine: named slot subtrees are skipped. Use {@link $dfsWithSlots}
 * when you need to descend into slots (e.g. character counting, slot-aware
 * content extraction).
 *
 * @param startNode - The node to start the search (inclusive), if omitted, it will start at the root node.
 * @param endNode - The node to end the search (inclusive), if omitted, it will find all descendants of the startingNode. If endNode
 * is an ElementNode, it will stop before visiting any of its children.
 * @returns An array of objects of all the nodes found by the search, including their depth into the tree.
 * \\{depth: number, node: LexicalNode\\} It will always return at least 1 node (the start node).
 */
export function $dfs(
  startNode?: LexicalNode,
  endNode?: LexicalNode,
): DFSNode[] {
  return Array.from($dfsIterator(startNode, endNode));
}

/**
 * Get the adjacent caret in the same direction
 *
 * @param caret A caret or null
 * @returns `caret.getAdjacentCaret()` or `null`
 */
export function $getAdjacentCaret<D extends CaretDirection>(
  caret: null | NodeCaret<D>,
): null | SiblingCaret<LexicalNode, D> {
  return caret ? caret.getAdjacentCaret() : null;
}

/**
 * Right-to-left mirror of {@link $dfs}. It returns all the nodes found in the
 * search in an array of objects.
 * Preorder traversal is used, meaning that nodes are listed in the order of when they are FIRST encountered.
 *
 * Children-only spine: named slot subtrees are skipped. Use {@link $reverseDfsWithSlots}
 * when you need to descend into slots (e.g. character counting, slot-aware
 * content extraction).
 *
 * The whole traversal is materialized. Use {@link $reverseDfsIterator} to walk
 * it on the fly with O(1) memory.
 *
 * @param startNode - The node to start the search (inclusive), if omitted, it will start at the root node.
 * @param endNode - The node to end the search (inclusive), if omitted, it will find all descendants of the startingNode. If endNode
 * is an ElementNode, it will stop before visiting any of its children.
 * @returns An array of objects of all the nodes found by the search, including their depth into the tree.
 * \\{depth: number, node: LexicalNode\\} It will always return at least 1 node (the start node).
 */
export function $reverseDfs(
  startNode?: LexicalNode,
  endNode?: LexicalNode,
): DFSNode[] {
  return Array.from($reverseDfsIterator(startNode, endNode));
}

/**
 * $dfs iterator (left to right). Tree traversal is done on the fly as new values are requested with O(1) memory.
 * Preorder traversal is used, meaning that nodes are iterated over in the order of when they are FIRST encountered.
 *
 * Children-only spine: named slot subtrees are skipped. Use {@link $dfsWithSlotsIterator}
 * (or {@link $dfsWithSlots}) when you need to descend into slots — e.g. character
 * counting, content extraction, or any cross-tree analysis where slotted content
 * should be visited.
 *
 * @param startNode - The node to start the search (inclusive), if omitted, it will start at the root node.
 * @param endNode - The node to end the search (inclusive), if omitted, it will find all descendants of the startingNode.
 * If endNode is an ElementNode, the iterator will end as soon as it reaches the endNode (no children will be visited).
 * @returns An iterator, each yielded value is a DFSNode. It will always return at least 1 node (the start node).
 */
export function $dfsIterator(
  startNode?: LexicalNode,
  endNode?: LexicalNode,
): IterableIterator<DFSNode> {
  return $dfsCaretIterator('next', startNode, endNode);
}

/**
 * Like {@link $dfs}, but also descends into named slots. Slots are not on the
 * linked-list spine, so each host's slot subtrees are emitted slots-first,
 * right after the host node and before its linked-list children.
 * @experimental
 * @param startNode - The node to start the search (inclusive), defaults to the root node.
 * @param endNode - The node to end the search (inclusive), defaults to all descendants of startNode.
 * Like {@link $dfs}, reaching endNode stops the traversal before visiting any of its
 * children — including its slot subtrees. An endNode strictly inside a slot subtree
 * is never reached (slot subtrees are spliced in whole), so it does not truncate
 * the traversal.
 * @returns An array of DFSNodes. It will always return at least 1 node (the start node).
 */
export function $dfsWithSlots(
  startNode?: LexicalNode,
  endNode?: LexicalNode,
): DFSNode[] {
  return Array.from($dfsWithSlotsIterator(startNode, endNode));
}

/**
 * Slot-aware {@link $dfsIterator}: a host's slot subtrees are emitted
 * slots-first, right after the host node and before its linked-list children.
 * The caret iterator drives the linked-list spine untouched.
 * @experimental
 * @param startNode - The node to start the search (inclusive), defaults to the root node.
 * @param endNode - The node to end the search (inclusive), defaults to all descendants of startNode.
 * Like {@link $dfs}, reaching endNode stops the traversal before visiting any of its
 * children — including its slot subtrees. An endNode strictly inside a slot subtree
 * is never reached (slot subtrees are spliced in whole), so it does not truncate
 * the traversal.
 * @returns An iterator, each yielded value is a DFSNode. It will always return at least 1 node (the start node).
 */
export function* $dfsWithSlotsIterator(
  startNode?: LexicalNode,
  endNode?: LexicalNode,
): IterableIterator<DFSNode> {
  for (const dfsNode of $dfsCaretIterator('next', startNode, endNode)) {
    yield dfsNode;
    const {node, depth} = dfsNode;
    // endNode is an inclusive stop: none of its children are visited, so its
    // slot subtrees must not be either.
    if ($isSlotHost(node) && !node.is(endNode)) {
      for (const name of $getSlotNames(node)) {
        const slot = $getSlot(node, name);
        if (slot !== null) {
          yield* $dfsSubtreeIterator(slot, depth + 1);
        }
      }
    }
  }
}

/**
 * Slots-first preorder traversal of a self-contained subtree (a slot node and
 * everything it owns). Used to splice slot subtrees into $dfsWithSlotsIterator.
 */
function* $dfsSubtreeIterator(
  node: LexicalNode,
  depth: number,
): IterableIterator<DFSNode> {
  yield {depth, node};
  const childDepth = depth + 1;
  if ($isSlotHost(node)) {
    for (const name of $getSlotNames(node)) {
      const slot = $getSlot(node, name);
      if (slot !== null) {
        yield* $dfsSubtreeIterator(slot, childDepth);
      }
    }
  }
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      yield* $dfsSubtreeIterator(child, childDepth);
    }
  }
}

function $getEndCaret<D extends CaretDirection>(
  startNode: LexicalNode,
  direction: D,
): null | NodeCaret<D> {
  const rval = $getAdjacentSiblingOrParentSiblingCaret(
    $getSiblingCaret(startNode, direction),
  );
  return rval && rval[0];
}

function $dfsCaretIterator<D extends CaretDirection>(
  direction: D,
  startNode?: LexicalNode,
  endNode?: LexicalNode,
): IterableIterator<DFSNode> {
  const root = $getRoot();
  const start = startNode || root;
  const startCaret = $isElementNode(start)
    ? $getChildCaret(start, direction)
    : $getSiblingCaret(start, direction);
  const startDepth = $getDepth(start);
  const endCaret = endNode
    ? $getAdjacentChildCaret(
        $getChildCaretOrSelf($getSiblingCaret(endNode, direction)),
      ) || $getEndCaret(endNode, direction)
    : $getEndCaret(start, direction);
  let depth = startDepth;
  return makeStepwiseIterator({
    hasNext: (state): state is NodeCaret<'next'> => state !== null,
    initial: startCaret,
    map: state => ({depth, node: state.origin}),
    step: (state: NodeCaret<'next'>) => {
      if (state.isSameNodeCaret(endCaret)) {
        return null;
      }
      if ($isChildCaret(state)) {
        depth++;
      }
      const rval = $getAdjacentSiblingOrParentSiblingCaret(state);
      if (!rval || rval[0].isSameNodeCaret(endCaret)) {
        return null;
      }
      depth += rval[1];
      return rval[0];
    },
  });
}

/**
 * Returns the Node sibling when this exists, otherwise the closest parent sibling. For example
 * R -> P -> T1, T2
 *   -> P2
 * returns T2 for node T1, P2 for node T2, and null for node P2.
 * @param node LexicalNode.
 * @returns An array (tuple) containing the found Lexical node and the depth difference, or null, if this node doesn't exist.
 */
export function $getNextSiblingOrParentSibling(
  node: LexicalNode,
): null | [LexicalNode, number] {
  const rval = $getAdjacentSiblingOrParentSiblingCaret(
    $getSiblingCaret(node, 'next'),
  );
  return rval && [rval[0].origin, rval[1]];
}

export function $getDepth(node: null | LexicalNode): number {
  let depth = -1;
  for (
    let innerNode = node;
    innerNode !== null;
    // A slotted node has no parent; climb its slot host instead.
    innerNode = innerNode.getParent() ?? $getSlotHost(innerNode)
  ) {
    depth++;
  }
  return depth;
}

/**
 * Performs a right-to-left preorder tree traversal.
 * From the starting node it goes to the rightmost child, than backtracks to parent and finds new rightmost path.
 * It will return the next node in traversal sequence after the startingNode.
 * The traversal is similar to $dfs functions above, but the nodes are visited right-to-left, not left-to-right.
 * @param startingNode - The node to start the search.
 * @returns The next node in pre-order right to left traversal sequence or `null`, if the node does not exist
 */
export function $getNextRightPreorderNode(
  startingNode: LexicalNode,
): LexicalNode | null {
  const startCaret = $getChildCaretOrSelf(
    $getSiblingCaret(startingNode, 'previous'),
  );
  const next = $getAdjacentSiblingOrParentSiblingCaret(startCaret, 'root');
  return next && next[0].origin;
}

/**
 * $dfs iterator (right to left). Tree traversal is done on the fly as new values are requested with O(1) memory.
 * @param startNode - The node to start the search, if omitted, it will start at the root node.
 * @param endNode - The node to end the search, if omitted, it will find all descendants of the startingNode.
 * @returns An iterator, each yielded value is a DFSNode. It will always return at least 1 node (the start node).
 */
export function $reverseDfsIterator(
  startNode?: LexicalNode,
  endNode?: LexicalNode,
): IterableIterator<DFSNode> {
  return $dfsCaretIterator('previous', startNode, endNode);
}

/**
 * Like {@link $reverseDfs}, but also descends into named slots. Mirror of
 * {@link $dfsWithSlots}.
 * @experimental
 * @param startNode - The node to start the search (inclusive), defaults to the root node.
 * @param endNode - The node to end the search (inclusive), defaults to all descendants of startNode.
 * Mirroring {@link $dfsWithSlots}, reaching endNode stops the traversal without
 * emitting its slot subtrees. An endNode strictly inside a slot subtree is never
 * reached (slot subtrees are spliced in whole), so it does not truncate the
 * traversal.
 * @returns An array of DFSNodes. It will always return at least 1 node (the start node).
 */
export function $reverseDfsWithSlots(
  startNode?: LexicalNode,
  endNode?: LexicalNode,
): DFSNode[] {
  return Array.from($reverseDfsWithSlotsIterator(startNode, endNode));
}

/**
 * Right-to-left mirror of {@link $dfsWithSlotsIterator}. Forward visits slots
 * before children, so the mirror visits them last: a host's slot subtrees are
 * emitted (in reverse slot order) only once its linked-list subtree is fully
 * traversed. Because the caret spine streams nodes, "left the host subtree" is
 * detected when a node at the host's depth or shallower arrives, flushing the
 * host's pending slots. The caret iterator drives the spine untouched.
 * @experimental
 * @param startNode - The node to start the search (inclusive), defaults to the root node.
 * @param endNode - The node to end the search (inclusive), defaults to all descendants of startNode.
 * Mirroring {@link $dfsWithSlotsIterator}, reaching endNode stops the traversal
 * without emitting its slot subtrees. An endNode strictly inside a slot subtree is
 * never reached (slot subtrees are spliced in whole), so it does not truncate the
 * traversal.
 * @returns An iterator, each yielded value is a DFSNode. It will always return at least 1 node (the start node).
 */
export function* $reverseDfsWithSlotsIterator(
  startNode?: LexicalNode,
  endNode?: LexicalNode,
): IterableIterator<DFSNode> {
  const pending: {depth: number; node: LexicalNode}[] = [];
  for (const dfsNode of $dfsCaretIterator('previous', startNode, endNode)) {
    while (
      pending.length > 0 &&
      dfsNode.depth <= pending[pending.length - 1].depth
    ) {
      const host = pending.pop()!;
      yield* $reverseSlotsOf(host.node, host.depth + 1);
    }
    yield dfsNode;
    const {node, depth} = dfsNode;
    // endNode is an inclusive stop: mirror the forward iterator and leave its
    // slot subtrees unvisited rather than flushing them after the stop.
    if (
      $isSlotHost(node) &&
      $getSlotNames(node).length > 0 &&
      !node.is(endNode)
    ) {
      pending.push({depth, node});
    }
  }
  while (pending.length > 0) {
    const host = pending.pop()!;
    yield* $reverseSlotsOf(host.node, host.depth + 1);
  }
}

/** Emit a host's slot subtrees in reverse slot order (mirror of slots-first). */
function* $reverseSlotsOf(
  host: LexicalNode,
  childDepth: number,
): IterableIterator<DFSNode> {
  const names = $getSlotNames(host);
  for (let i = names.length - 1; i >= 0; i--) {
    const slot = $getSlot(host, names[i]);
    if (slot !== null) {
      yield* $reverseDfsSubtreeIterator(slot, childDepth);
    }
  }
}

/**
 * Right-to-left slots-last preorder of a self-contained subtree: children in
 * reverse order, then slots in reverse order. Mirror of $dfsSubtreeIterator.
 */
function* $reverseDfsSubtreeIterator(
  node: LexicalNode,
  depth: number,
): IterableIterator<DFSNode> {
  yield {depth, node};
  const childDepth = depth + 1;
  if ($isElementNode(node)) {
    const children = node.getChildren();
    for (let i = children.length - 1; i >= 0; i--) {
      yield* $reverseDfsSubtreeIterator(children[i], childDepth);
    }
  }
  if ($isSlotHost(node)) {
    yield* $reverseSlotsOf(node, childDepth);
  }
}

/**
 * Takes a node and traverses up its ancestors (toward the root node)
 * in order to find a specific type of node.
 * @param node - the node to begin searching.
 * @param klass - an instance of the type of node to look for.
 * @returns the node of type klass that was passed, or null if none exist.
 */
export function $getNearestNodeOfType<T extends ElementNode>(
  node: LexicalNode,
  klass: Klass<T>,
): T | null {
  let parent: ElementNode | LexicalNode | null = node;

  while (parent != null) {
    if (parent instanceof klass) {
      return parent as T;
    }

    parent = parent.getParent();
  }

  return null;
}

/**
 * Returns the element node of the nearest ancestor, otherwise throws an error.
 * @param startNode - The starting node of the search
 * @returns The ancestor node found
 */
export function $getNearestBlockElementAncestorOrThrow(
  startNode: LexicalNode,
): ElementNode {
  const blockNode = $findMatchingParent(
    startNode,
    node => $isElementNode(node) && !node.isInline(),
  );
  if (!$isElementNode(blockNode)) {
    invariant(
      false,
      'Expected node %s to have closest block element node.',
      startNode.__key,
    );
  }
  return blockNode;
}

/**
 * Checks whether the selection covers the entire block: the selection's
 * start point is at or before the first position inside blockNode and its
 * end point is at or after the last position inside blockNode. A selection
 * that extends beyond the block's boundaries still fully selects the block,
 * and an empty block is fully selected by any selection that touches or
 * surrounds it.
 *
 * @param blockNode - The ElementNode to check, typically a top-level block or the RootNode
 * @param selectionOrRange - The RangeSelection or CaretRange to check
 * @returns true if the selection covers the entire blockNode
 */
export function $isBlockFullySelected(
  blockNode: ElementNode,
  selectionOrRange: RangeSelection | CaretRange,
): boolean {
  const range = $getCaretRangeInDirection(
    $isRangeSelection(selectionOrRange)
      ? $caretRangeFromSelection(selectionOrRange)
      : selectionOrRange,
    'next',
  );
  // A named-slot subtree is isolated from its host through a parentless
  // up-link, so a range inside a slot can never cover a block outside that
  // slot frame (and vice versa) — and the caret comparison below has no
  // common ancestor to walk across the boundary. Different frames are
  // never fully selected; the same frame compares safely within it.
  const anchorFrame = $getSlotFrame(range.anchor.origin);
  const blockFrame = $getSlotFrame(blockNode.getLatest());
  if (
    anchorFrame === null ? blockFrame !== null : !anchorFrame.is(blockFrame)
  ) {
    return false;
  }
  const blockStart = $normalizeCaret($getChildCaret(blockNode, 'next'));
  const blockEnd = $getCaretInDirection(
    $normalizeCaret($getChildCaret(blockNode, 'previous')),
    'next',
  );
  return (
    $comparePointCaretNext(range.anchor, blockStart) <= 0 &&
    $comparePointCaretNext(range.focus, blockEnd) >= 0
  );
}

export type DOMNodeToLexicalConversion = (element: Node) => LexicalNode;

export type DOMNodeToLexicalConversionMap = Record<
  string,
  DOMNodeToLexicalConversion
>;

/**
 * Attempts to resolve nested element nodes of the same type into a single node of that type.
 * It is generally used for marks/commenting
 * @param editor - The lexical editor
 * @param targetNode - The target for the nested element to be extracted from.
 * @param cloneNode - See {@link $createMarkNode}
 * @param handleOverlap - Handles any overlap between the node to extract and the targetNode
 * @returns The lexical editor
 */
export function registerNestedElementResolver<N extends ElementNode>(
  editor: LexicalEditor,
  targetNode: Klass<N>,
  cloneNode: (from: N) => N,
  handleOverlap: (from: N, to: N) => void,
): () => void {
  const $isTargetNode = (node: LexicalNode | null | undefined): node is N => {
    return node instanceof targetNode;
  };

  const $findMatch = (node: N): {child: ElementNode; parent: N} | null => {
    // First validate we don't have any children that are of the target,
    // as we need to handle them first.
    const children = node.getChildren();

    for (let i = 0; i < children.length; i++) {
      const child = children[i];

      if ($isTargetNode(child)) {
        return null;
      }
    }

    let parentNode: ElementNode | null = node;
    let childNode: ElementNode = node;

    while (parentNode !== null) {
      childNode = parentNode;
      parentNode = parentNode.getParent();

      if ($isTargetNode(parentNode)) {
        return {child: childNode, parent: parentNode};
      }
    }

    return null;
  };

  const $elementNodeTransform = (node: N) => {
    const match = $findMatch(node);

    if (match !== null) {
      const {child, parent} = match;

      // Simple path, we can move child out and siblings into a new parent.

      if (child.is(node)) {
        handleOverlap(parent, node);
        const nextSiblings = child.getNextSiblings();
        const nextSiblingsLength = nextSiblings.length;
        parent.insertAfter(child);

        if (nextSiblingsLength !== 0) {
          const newParent = cloneNode(parent);
          child.insertAfter(newParent);

          for (let i = 0; i < nextSiblingsLength; i++) {
            newParent.append(nextSiblings[i]);
          }
        }

        if (!parent.canBeEmpty() && parent.getChildrenSize() === 0) {
          parent.remove();
        }
      } else {
        // Complex path, we have a deep node that isn't a child of the
        // target parent.
        // TODO: implement this functionality
      }
    }
  };

  return editor.registerNodeTransform(targetNode, $elementNodeTransform);
}

/**
 * Clones the editor and marks it as dirty to be reconciled. If there was a selection,
 * it would be set back to its previous state, or null otherwise.
 * @param editor - The lexical editor
 * @param editorState - The editor's state
 */
export function $restoreEditorState(
  editor: LexicalEditor,
  editorState: EditorState,
): void {
  const nodeMap = new Map();
  const activeEditorState = editor._pendingEditorState;

  for (const [key, node] of editorState._nodeMap) {
    nodeMap.set(key, $cloneWithProperties(node));
  }

  if (activeEditorState) {
    activeEditorState._nodeMap = nodeMap;
  }

  $fullReconcile();
  const selection = editorState._selection;
  $setSelection(selection === null ? null : selection.clone());
}

/**
 * If the selected insertion area is the root/shadow root node (see {@link lexical!$isRootOrShadowRoot}),
 * the node will be appended there, otherwise, it will be inserted before the insertion area.
 * If there is no selection where the node is to be inserted, it will be appended after any current nodes
 * within the tree, as a child of the root node. A paragraph will then be added after the inserted node and selected.
 * @param node - The node to be inserted
 * @returns The node after its insertion
 */
export function $insertNodeToNearestRoot<T extends LexicalNode>(node: T): T {
  const selection = $getSelection() || $getPreviousSelection();
  let initialCaret: undefined | PointCaret<'next'>;
  if ($isRangeSelection(selection)) {
    initialCaret = $caretFromPoint(selection.focus, 'next');
  } else {
    if (selection != null) {
      const nodes = selection.getNodes();
      const lastNode = nodes[nodes.length - 1];
      if (lastNode) {
        initialCaret = $getSiblingCaret(lastNode, 'next');
      }
    }
    initialCaret =
      initialCaret ||
      $getChildCaret($getRoot(), 'previous')
        .getFlipped()
        .insert($createParagraphNode());
  }
  const insertCaret = $insertNodeToNearestRootAtCaret(node, initialCaret);
  const adjacent = $getAdjacentChildCaret(insertCaret);
  const selectionCaret = $isChildCaret(adjacent)
    ? $normalizeCaret(adjacent)
    : insertCaret;
  $setSelectionFromCaretRange($getCollapsedCaretRange(selectionCaret));
  return node.getLatest();
}

// Re-exported from the `lexical` core package for backwards compatibility.
export {$insertNodeToNearestRootAtCaret};

/**
 * Inserts a node into leaf — the deepest accessible node at the carriage position
 * @param node - The node to be inserted
 */
export function $insertNodeIntoLeaf(node: LexicalNode): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    if (selection) {
      selection.insertNodes([node]);
    }
    return;
  }
  const caretRange = $caretRangeFromSelection(selection);
  let insertCaret = $getCaretRangeInDirection(
    $removeTextFromCaretRange(caretRange),
    'next',
  ).anchor;
  if ($isTextPointCaret(insertCaret)) {
    const nextAnchor = $splitAtPointCaretNext(insertCaret);
    if (!nextAnchor) {
      return;
    }
    insertCaret = nextAnchor;
  }
  const focus = insertCaret.getFlipped();
  focus.insert(node);
  $setSelectionFromCaretRange($getCaretRange(focus, focus));
}

/**
 * Wraps the node into another node created from a createElementNode function, eg. $createParagraphNode
 * @param node - Node to be wrapped.
 * @param createElementNode - Creates a new lexical element to wrap the to-be-wrapped node and returns it.
 * @returns A new lexical element with the previous node appended within (as a child, including its children).
 */
export function $wrapNodeInElement<T extends ElementNode>(
  node: LexicalNode,
  createElementNode: () => T,
): T {
  const elementNode = createElementNode();
  node.replace(elementNode);
  elementNode.append(node);
  return elementNode;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ObjectKlass<T> = new (...args: any[]) => T;

/**
 * @param object = The instance of the type
 * @param objectClass = The class of the type
 * @returns Whether the object is has the same Klass of the objectClass, ignoring the difference across window (e.g. different iframes)
 */
export function objectKlassEquals<T>(
  object: unknown,
  objectClass: ObjectKlass<T>,
): object is T {
  return object !== null
    ? Object.getPrototypeOf(object).constructor.name === objectClass.name
    : false;
}

// Clipboard may contain files that we aren't allowed to read. While the event is arguably useless,
// in certain occasions, we want to know whether it was a file transfer, as opposed to text. We
// control this with the first boolean flag.
export function eventFiles(
  event: DragEvent | PasteCommandType,
): [boolean, File[], boolean] {
  let dataTransfer: null | DataTransfer = null;
  if (objectKlassEquals(event, DragEvent)) {
    dataTransfer = event.dataTransfer;
  } else if (objectKlassEquals(event, ClipboardEvent)) {
    dataTransfer = event.clipboardData;
  }

  if (dataTransfer === null) {
    return [false, [], false];
  }

  const types = dataTransfer.types;
  const hasFiles = types.includes('Files');
  const hasContent =
    types.includes('text/html') || types.includes('text/plain');
  return [hasFiles, Array.from(dataTransfer.files), hasContent];
}

/**
 * @deprecated Use Array filter or flatMap
 *
 * Filter the nodes
 * @param nodes Array of nodes that needs to be filtered
 * @param filterFn A filter function that returns node if the current node satisfies the condition otherwise null
 * @returns Array of filtered nodes
 */

export function $filter<T>(
  nodes: LexicalNode[],
  filterFn: (node: LexicalNode) => null | T,
): T[] {
  const result: T[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = filterFn(nodes[i]);
    if (node !== null) {
      result.push(node);
    }
  }
  return result;
}

/**
 * Applies the provided callback to each indentable block element in the Selection
 *
 * @param indentOrOutdent callback for performing the indent or outdent action
 * on a given block element.
 * @returns true if at least one block was handled, false otherwise.
 */
export function $handleIndentAndOutdent(
  indentOrOutdent: (block: ElementNode) => void,
): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return false;
  }
  const alreadyHandled = new Set();
  const nodes = selection.getNodes();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const key = node.getKey();
    if (alreadyHandled.has(key)) {
      continue;
    }
    const parentBlock = $findMatchingParent(
      node,
      (parentNode): parentNode is ElementNode =>
        $isElementNode(parentNode) && !parentNode.isInline(),
    );
    if (parentBlock === null) {
      continue;
    }
    const parentKey = parentBlock.getKey();
    if (parentBlock.canIndent() && !alreadyHandled.has(parentKey)) {
      alreadyHandled.add(parentKey);
      indentOrOutdent(parentBlock);
    }
  }
  return alreadyHandled.size > 0;
}

/**
 * Appends the node before the first child of the parent node
 * @param parent A parent node
 * @param node Node that needs to be appended
 */
export function $insertFirst(parent: ElementNode, node: LexicalNode): void {
  $getChildCaret(parent, 'next').insert(node);
}

let NEEDS_MANUAL_ZOOM = IS_FIREFOX || !CAN_USE_DOM ? false : undefined;
function needsManualZoom(): boolean {
  if (NEEDS_MANUAL_ZOOM === undefined) {
    // If the browser implements standardized CSS zoom, then the client rect
    // will be wider after zoom is applied
    // https://chromestatus.com/feature/5198254868529152
    // https://github.com/facebook/lexical/issues/6863
    // eslint-disable-next-line no-restricted-syntax
    const div = document.createElement('div');
    div.style.position = 'absolute';
    div.style.opacity = '0';
    div.style.width = '100px';
    div.style.left = '-1000px';
    // eslint-disable-next-line no-restricted-syntax
    document.body.appendChild(div);
    const noZoom = div.getBoundingClientRect();
    div.style.setProperty('zoom', '2');
    NEEDS_MANUAL_ZOOM = div.getBoundingClientRect().width === noZoom.width;
    // eslint-disable-next-line no-restricted-syntax
    document.body.removeChild(div);
  }
  return NEEDS_MANUAL_ZOOM;
}

/**
 * Calculates the zoom level of an element as a result of using
 * css zoom property. For browsers that implement standardized CSS
 * zoom (Firefox, Chrome >= 128), this will always return 1.
 * @param element
 * @param useManualZoom - If true, always use zoom level will be calculated manually, otherwise it will be calculated on as needed basis.
 */
export function calculateZoomLevel(
  element: Element | null,
  useManualZoom: boolean = false,
): number {
  let zoom = 1;
  if (needsManualZoom() || useManualZoom) {
    // Read styles from the element's own realm so an iframe-mounted editor's
    // zoom isn't computed through the top-level window (cross-realm
    // getComputedStyle can return an empty zoom).
    const win = (element && element.ownerDocument.defaultView) || window;
    while (element) {
      zoom *= Number(win.getComputedStyle(element).getPropertyValue('zoom'));
      element = getParentElement(element);
    }
  }
  return zoom;
}

/**
 * Checks if the editor is a nested editor created by LexicalNestedComposer
 */
export function $isEditorIsNestedEditor(editor: LexicalEditor): boolean {
  return editor._parentEditor !== null;
}

/**
 * A depth first last-to-first traversal of root that stops at each node that matches
 * $predicate and ensures that its parent is root. This is typically used to discard
 * invalid or unsupported wrapping nodes. For example, a TableNode must only have
 * TableRowNode as children, but an importer might add invalid nodes based on
 * caption, tbody, thead, etc. and this will unwrap and discard those.
 *
 * @param root The root to start the traversal
 * @param $predicate Should return true for nodes that are permitted to be children of root
 * @returns true if this unwrapped or removed any nodes
 */
export function $unwrapAndFilterDescendants(
  root: ElementNode,
  $predicate: (node: LexicalNode) => boolean,
): boolean {
  return $unwrapAndFilterDescendantsImpl(root, $predicate, null);
}

function $unwrapAndFilterDescendantsImpl(
  root: ElementNode,
  $predicate: (node: LexicalNode) => boolean,
  $onSuccess: null | ((node: LexicalNode) => void),
): boolean {
  let didMutate = false;
  for (const node of $lastToFirstIterator(root)) {
    if ($predicate(node)) {
      if ($onSuccess !== null) {
        $onSuccess(node);
      }
      continue;
    }
    didMutate = true;
    if ($isElementNode(node)) {
      $unwrapAndFilterDescendantsImpl(
        node,
        $predicate,
        $onSuccess || (child => node.insertAfter(child)),
      );
    }
    node.remove();
  }
  return didMutate;
}

/**
 * A depth first traversal of the children array that stops at and collects
 * each node that `$predicate` matches. This is typically used to discard
 * invalid or unsupported wrapping nodes on a children array in the `after`
 * of an {@link lexical!DOMConversionOutput}. For example, a TableNode must only have
 * TableRowNode as children, but an importer might add invalid nodes based on
 * caption, tbody, thead, etc. and this will unwrap and discard those.
 *
 * This function is read-only and performs no mutation operations, which makes
 * it suitable for import and export purposes but likely not for any in-place
 * mutation. You should use {@link $unwrapAndFilterDescendants} for in-place
 * mutations such as node transforms.
 *
 * @param children The children to traverse
 * @param $predicate Should return true for nodes that are permitted to be children of root
 * @returns The children or their descendants that match $predicate
 */
export function $descendantsMatching<T extends LexicalNode>(
  children: LexicalNode[],
  $predicate: (node: LexicalNode) => node is T,
): T[];
export function $descendantsMatching(
  children: LexicalNode[],
  $predicate: (node: LexicalNode) => boolean,
): LexicalNode[] {
  const result: LexicalNode[] = [];
  const stack = Array.from(children).reverse();
  for (let child = stack.pop(); child !== undefined; child = stack.pop()) {
    if ($predicate(child)) {
      result.push(child);
    } else if ($isElementNode(child)) {
      for (const grandchild of $lastToFirstIterator(child)) {
        stack.push(grandchild);
      }
    }
  }
  return result;
}

/**
 * Return an iterator that yields each child of node from first to last, taking
 * care to preserve the next sibling before yielding the value in case the caller
 * removes the yielded node.
 *
 * @param node The node whose children to iterate
 * @returns An iterator of the node's children
 */
export function $firstToLastIterator(node: ElementNode): Iterable<LexicalNode> {
  return $childIterator($getChildCaret(node, 'next'));
}

/**
 * Return an iterator that yields each child of node from last to first, taking
 * care to preserve the previous sibling before yielding the value in case the caller
 * removes the yielded node.
 *
 * @param node The node whose children to iterate
 * @returns An iterator of the node's children
 */
export function $lastToFirstIterator(node: ElementNode): Iterable<LexicalNode> {
  return $childIterator($getChildCaret(node, 'previous'));
}

function $childIterator<D extends CaretDirection>(
  startCaret: NodeCaret<D>,
): IterableIterator<LexicalNode> {
  const seen = __DEV__ ? new Set<NodeKey>() : null;
  return makeStepwiseIterator({
    hasNext: $isSiblingCaret,
    initial: startCaret.getAdjacentCaret(),
    map: caret => {
      const origin = caret.origin.getLatest();
      if (__DEV__ && seen !== null) {
        const key = origin.getKey();
        invariant(
          !seen.has(key),
          '$childIterator: Cycle detected, node with key %s has already been traversed',
          String(key),
        );
        seen.add(key);
      }
      return origin;
    },
    step: (caret: SiblingCaret<LexicalNode, D>) => caret.getAdjacentCaret(),
  });
}

/**
 * Replace this node with its children
 *
 * @param node The ElementNode to unwrap and remove
 */
export function $unwrapNode(node: ElementNode): void {
  $rewindSiblingCaret($getSiblingCaret(node, 'next')).splice(
    1,
    node.getChildren(),
  );
}

/**
 * A wrapper that creates bound functions and methods for the
 * StateConfig to save some boilerplate when defining methods
 * or exporting only the accessors from your modules rather
 * than exposing the StateConfig directly.
 */
export interface StateConfigWrapper<K extends string, V> {
  /** A reference to the stateConfig */
  readonly stateConfig: StateConfig<K, V>;
  /** `(node) => $getState(node, stateConfig)` */
  readonly $get: <T extends LexicalNode>(node: T) => V;
  /** `(node, valueOrUpdater) => $setState(node, stateConfig, valueOrUpdater)` */
  readonly $set: <T extends LexicalNode>(
    node: T,
    valueOrUpdater: ValueOrUpdater<V>,
  ) => T;
  /** `[$get, $set]` */
  readonly accessors: readonly [$get: this['$get'], $set: this['$set']];
  /**
   * `() => function () { return $get(this) }`
   *
   * Should be called with an explicit `this` type parameter.
   *
   * @example
   * ```ts
   * class MyNode {
   *   // …
   *   myGetter = myWrapper.makeGetterMethod<this>();
   * }
   * ```
   */
  makeGetterMethod<T extends LexicalNode>(): (this: T) => V;
  /**
   * `() => function (valueOrUpdater) { return $set(this, valueOrUpdater) }`
   *
   * Must be called with an explicit `this` type parameter.
   *
   * @example
   * ```ts
   * class MyNode {
   *   // …
   *   mySetter = myWrapper.makeSetterMethod<this>();
   * }
   * ```
   */
  makeSetterMethod<T extends LexicalNode>(): (
    this: T,
    valueOrUpdater: ValueOrUpdater<V>,
  ) => T;
}

/**
 * EXPERIMENTAL
 *
 * A convenience interface for working with {@link $getState} and
 * {@link $setState}.
 *
 * @param stateConfig The stateConfig to wrap with convenience functionality
 * @returns a StateWrapper
 */
export function makeStateWrapper<K extends string, V>(
  stateConfig: StateConfig<K, V>,
): StateConfigWrapper<K, V> {
  const $get: StateConfigWrapper<K, V>['$get'] = node =>
    $getState(node, stateConfig);
  const $set: StateConfigWrapper<K, V>['$set'] = (node, valueOrUpdater) =>
    $setState(node, stateConfig, valueOrUpdater);
  return {
    $get,
    $set,
    accessors: [$get, $set],
    makeGetterMethod: () =>
      function $getter() {
        return $get(this);
      },
    makeSetterMethod: () =>
      function $setter(valueOrUpdater) {
        return $set(this, valueOrUpdater);
      },
    stateConfig,
  };
}

/**
 * Inserts a new paragraph before a container node when the cursor moves outside the container element
 *
 * Intended for use ArrowLeft/ArrowUp keyboard handlers to allow the user to break out
 * of a container node by creating a new paragraph before it.
 *
 * A paragraph is inserted if that the cursor is positioned at the beginning inside the container,
 * and the container itself is the first element in the document and has no preceding sibling
 *
 * When a paragraph is inserted the selection is moved to it and, if the
 * triggering keyboard event is provided, its default action is prevented so
 * the browser does not additionally move the selection. Relying on the native
 * caret movement is not portable: Chromium moves into the freshly inserted
 * paragraph while Firefox leaves the caret inside the container.
 *
 * @param $isContainerNode - Type guard identifying the container node type to escape from.
 * @param event - The keyboard event that triggered the escape, if any. Its
 *   default action is prevented when a paragraph is inserted.
 * @returns `true` if a paragraph was inserted, `false` otherwise.
 */
export function $onEscapeUp(
  $isContainerNode: (node?: LexicalNode | null) => node is ElementNode,
  event?: KeyboardEvent | null,
) {
  const selection = $getSelection();
  if ($isRangeSelection(selection) && selection.isCollapsed()) {
    const containerNode = $findMatchingParent(
      selection.anchor.getNode(),
      $isContainerNode,
    );
    if (containerNode) {
      const parent = containerNode.getParent();
      if (
        parent !== null &&
        parent.getFirstChild() === containerNode &&
        $isAtStartOfNode(selection.anchor, containerNode)
      ) {
        containerNode.insertBefore($createParagraphNode()).selectEnd();
        if (event) {
          event.preventDefault();
        }
        return true;
      }
    }
  }

  return false;
}

/**
 * Inserts a new paragraph after a container node when the cursor moves outside the container element
 *
 * Intended for use ArrowRight/ArrowDown keyboard handlers to allow the user to break out
 * of a container node by creating a new paragraph after it.
 *
 * A paragraph is inserted if that the cursor is positioned at the ending inside the container,
 * and the container itself is the last element in the document and has no next sibling
 *
 * When a paragraph is inserted the selection is moved to it and, if the
 * triggering keyboard event is provided, its default action is prevented so
 * the browser does not additionally move the selection. Relying on the native
 * caret movement is not portable: Chromium moves into the freshly inserted
 * paragraph while Firefox leaves the caret inside the container.
 *
 * @param $isContainerNode - Type guard identifying the container node type to escape from.
 * @param event - The keyboard event that triggered the escape, if any. Its
 *   default action is prevented when a paragraph is inserted.
 * @returns `true` if a paragraph was inserted, `false` otherwise.
 */
export function $onEscapeDown(
  $isContainerNode: (node?: LexicalNode | null) => node is ElementNode,
  event?: KeyboardEvent | null,
) {
  const selection = $getSelection();
  if ($isRangeSelection(selection) && selection.isCollapsed()) {
    const containerNode = $findMatchingParent(
      selection.anchor.getNode(),
      $isContainerNode,
    );
    if (containerNode) {
      const parent = containerNode.getParent();
      if (
        parent !== null &&
        parent.getLastChild() === containerNode &&
        $isAtEndOfNode(selection.anchor, containerNode)
      ) {
        containerNode.insertAfter($createParagraphNode()).selectEnd();
        if (event) {
          event.preventDefault();
        }
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether the collapsed `point` sits at the very start of `node`'s content —
 * on its first descendant (or on the empty node itself) at offset 0. Shared by
 * {@link $onEscapeUp} and slot-aware variants so the "at the leading edge of a
 * container" test stays in one place.
 */
export function $isAtStartOfNode(point: PointType, node: ElementNode): boolean {
  return $isAtEdgeOfElement(point, node, 'previous');
}

/**
 * Whether the collapsed `point` sits at the very end of `node`'s content — on
 * its last descendant (or on the empty node itself) at that node's end. Shared
 * by {@link $onEscapeDown} and slot-aware variants so the "at the trailing edge
 * of a container" test stays in one place.
 */
export function $isAtEndOfNode(point: PointType, node: ElementNode): boolean {
  return $isAtEdgeOfElement(point, node, 'next');
}

export {getScrollParent} from './getScrollParent';
