/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {LexicalNode, NodeKey} from '../LexicalNode';
import type {TextNode} from '../nodes/LexicalTextNode';

import devInvariant from '@lexical/internal/devInvariant';
import invariant from '@lexical/internal/invariant';

import {$getSlotHostKey} from '../LexicalSlot';
import {$getRoot, $isRootOrShadowRoot} from '../LexicalUtils';
import {$isElementNode, type ElementNode} from '../nodes/LexicalElementNode';
import {$isRootNode} from '../nodes/LexicalRootNode';

/**
 * The direction of a caret, 'next' points towards the end of the document
 * and 'previous' points towards the beginning
 */
export type CaretDirection = 'next' | 'previous';
/**
 * A type utility to flip next and previous
 */
export type FlipDirection<D extends CaretDirection> =
  (typeof FLIP_DIRECTION)[D];
/**
 * A sibling caret type points from a LexicalNode origin to its next or previous sibling,
 * and a child caret type points from an ElementNode origin to its first or last child.
 */
export type CaretType = 'sibling' | 'child';
/**
 * The RootMode is specified in all caret traversals where the traversal can go up
 * towards the root. 'root' means that it will stop at the document root,
 * and 'shadowRoot' will stop at the document root or any shadow root
 * (per {@link $isRootOrShadowRoot}).
 */
export type RootMode = 'root' | 'shadowRoot';

const FLIP_DIRECTION = {
  next: 'previous',
  previous: 'next',
} as const;

/** @noInheritDoc */
export interface BaseCaret<
  T extends LexicalNode,
  D extends CaretDirection,
  Type,
> extends Iterable<SiblingCaret<LexicalNode, D>> {
  /** The origin node of this caret, typically this is what you will use in traversals */
  readonly origin: T;
  /** sibling for a SiblingCaret (pointing at the next or previous sibling) or child for a ChildCaret (pointing at the first or last child) */
  readonly type: Type;
  /** next if pointing at the next sibling or first child, previous if pointing at the previous sibling or last child */
  readonly direction: D;
  /** Get the ElementNode that is the logical parent (`origin` for `ChildCaret`, `origin.getParent()` for `SiblingCaret`) */
  getParentAtCaret: () => null | ElementNode;
  /** Get the node connected to the origin in the caret's direction, or null if there is no node */
  getNodeAtCaret: () => null | LexicalNode;
  /** Get a new SiblingCaret from getNodeAtCaret() in the same direction. */
  getAdjacentCaret: () => null | SiblingCaret<LexicalNode, D>;
  /**
   * Get a new SiblingCaret with this same node
   */
  getSiblingCaret: () => SiblingCaret<T, D>;
  /** Remove the getNodeAtCaret() node that this caret is pointing towards, if it exists */
  remove: () => this;
  /**
   * Insert a node connected to origin in this direction (before the node that this caret is pointing towards, if any existed).
   * For a `SiblingCaret` this is `origin.insertAfter(node)` for next, or `origin.insertBefore(node)` for previous.
   * For a `ChildCaret` this is `origin.splice(0, 0, [node])` for next or `origin.append(node)` for previous.
   */
  insert: (node: LexicalNode) => this;
  /** If getNodeAtCaret() is not null then replace it with node, otherwise insert node */
  replaceOrInsert: (node: LexicalNode, includeChildren?: boolean) => this;
  /**
   * Splice an iterable (typically an Array) of nodes into this location.
   *
   * @param deleteCount The number of existing nodes to replace or delete
   * @param nodes An iterable of nodes that will be inserted in this location, using replace instead of insert for the first deleteCount nodes
   * @param nodesDirection The direction of the nodes iterable, defaults to 'next'
   */
  splice: (
    deleteCount: number,
    nodes: Iterable<LexicalNode>,
    nodesDirection?: CaretDirection,
  ) => this;
}

/**
 * A RangeSelection expressed as a pair of Carets
 */
export interface CaretRange<
  D extends CaretDirection = CaretDirection,
> extends Iterable<NodeCaret<D>> {
  readonly type: 'node-caret-range';
  readonly direction: D;
  anchor: PointCaret<D>;
  focus: PointCaret<D>;
  /** Return true if anchor and focus are the same caret */
  isCollapsed: () => boolean;
  /**
   * Iterate the carets between anchor and focus in a pre-order fashion, note
   * that this does not include any text slices represented by the anchor and/or
   * focus. Those are accessed separately from getTextSlices.
   *
   * An ElementNode origin will be yielded as a ChildCaret on enter,
   * and a SiblingCaret on leave.
   */
  iterNodeCarets: (rootMode?: RootMode) => IterableIterator<NodeCaret<D>>;
  /**
   * There are between zero and two non-null TextSliceCarets for a CaretRange.
   * Note that when anchor and focus share an origin node the second element
   * will be null because the slice is entirely represented by the first element.
   *
   * `[slice, slice]`: anchor and focus are TextPointCaret with distinct origin nodes
   * `[slice, null]`: anchor is a TextPointCaret
   * `[null, slice]`: focus is a TextPointCaret
   * `[null, null]`: Neither anchor nor focus are TextPointCarets
   */
  getTextSlices: () => TextPointCaretSliceTuple<D>;
}

export interface StepwiseIteratorConfig<State, Stop, Value> {
  readonly initial: State | Stop;
  readonly hasNext: (value: State | Stop) => value is State;
  readonly step: (value: State) => State | Stop;
  readonly map: (value: State) => Value;
}

/**
 * A NodeCaret is the combination of an origin node and a direction
 * that points towards where a connected node will be fetched, inserted,
 * or replaced. A SiblingCaret points from a node to its next or previous
 * sibling, and a ChildCaret points to its first or last child
 * (using next or previous as direction, for symmetry with SiblingCaret).
 *
 * The differences between NodeCaret and PointType are:
 * - NodeCaret can only be used to refer to an entire node (PointCaret is used when a full analog is needed). A PointType of text type can be used to refer to a specific location inside of a TextNode.
 * - NodeCaret stores an origin node, type (sibling or child), and direction (next or previous). A PointType stores a type (text or element), the key of a node, and a text or child offset within that node.
 * - NodeCaret is directional and always refers to a very specific node, eliminating all ambiguity. PointType can refer to the location before or at a node depending on context.
 * - NodeCaret is more robust to nearby mutations, as it relies only on a node's direct connections. An element Any change to the count of previous siblings in an element PointType will invalidate it.
 * - NodeCaret is designed to work more directly with the internal representation of the document tree, making it suitable for use in traversals without performing any redundant work.
 *
 * The caret does *not* update in response to any mutations, you should
 * not persist it across editor updates, and using a caret after its origin
 * node has been removed or replaced may result in runtime errors.
 */
export type NodeCaret<D extends CaretDirection = CaretDirection> =
  | SiblingCaret<LexicalNode, D>
  | ChildCaret<ElementNode, D>;

/**
 * A PointCaret is a NodeCaret that also includes a
 * TextPointCaret type which refers to a specific offset of a TextNode.
 * This type is separate because it is not relevant to general node traversal
 * so it doesn't make sense to have it show up except when defining
 * a CaretRange and in those cases there will be at most two of them only
 * at the boundaries.
 *
 * The addition of TextPointCaret allows this type to represent any location
 * that is representable by PointType, as the TextPointCaret refers to a
 * specific offset within a TextNode.
 */
export type PointCaret<D extends CaretDirection = CaretDirection> =
  | TextPointCaret<TextNode, D>
  | SiblingCaret<LexicalNode, D>
  | ChildCaret<ElementNode, D>;

/**
 * A SiblingCaret points from an origin LexicalNode towards its next or previous sibling.
 */
export interface SiblingCaret<
  T extends LexicalNode = LexicalNode,
  D extends CaretDirection = CaretDirection,
> extends BaseCaret<T, D, 'sibling'> {
  /** Get a new caret with the latest origin pointer */
  getLatest: () => SiblingCaret<T, D>;
  /**
   * If the origin of this node is an ElementNode, return the ChildCaret of this origin in the same direction.
   * If the origin is not an ElementNode, this will return null.
   */
  getChildCaret: () => null | ChildCaret<T & ElementNode, D>;
  /**
   * Get the caret in the same direction from the parent of this origin.
   *
   * @param mode 'root' to return null at the root, 'shadowRoot' to return null at the root or any shadow root
   * @returns A SiblingCaret with the parent of this origin, or null if the parent is a root according to mode.
   */
  getParentCaret: (mode?: RootMode) => null | SiblingCaret<ElementNode, D>;
  /**
   * Return true if other is a SiblingCaret or TextPointCaret with the same
   * origin (by node key comparison) and direction.
   */
  isSameNodeCaret: (
    other: null | undefined | PointCaret,
  ) => other is SiblingCaret<T, D> | T extends TextNode
    ? TextPointCaret<T & TextNode, D>
    : never;
  /**
   * Return true if other is a SiblingCaret with the same
   * origin (by node key comparison) and direction.
   */
  isSamePointCaret: (
    other: null | undefined | PointCaret,
  ) => other is SiblingCaret<T, D>;
  /**
   * Get a new NodeCaret with the head and tail of its directional arrow flipped, such that flipping twice is the identity.
   * For example, given a non-empty parent with a firstChild and lastChild, and a second emptyParent node with no children:
   *
   * @example
   * ```
   * caret.getFlipped().getFlipped().is(caret) === true;
   * $getChildCaret(parent, 'next').getFlipped().is($getSiblingCaret(firstChild, 'previous')) === true;
   * $getSiblingCaret(lastChild, 'next').getFlipped().is($getChildCaret(parent, 'previous')) === true;
   * $getSiblingCaret(firstChild, 'next).getFlipped().is($getSiblingCaret(lastChild, 'previous')) === true;
   * $getChildCaret(emptyParent, 'next').getFlipped().is($getChildCaret(emptyParent, 'previous')) === true;
   * ```
   */
  getFlipped: () => NodeCaret<FlipDirection<D>>;
}

/**
 * A ChildCaret points from an origin ElementNode towards its first or last child.
 */
export interface ChildCaret<
  T extends ElementNode = ElementNode,
  D extends CaretDirection = CaretDirection,
> extends BaseCaret<T, D, 'child'> {
  /** Get a new caret with the latest origin pointer */
  getLatest: () => ChildCaret<T, D>;
  getParentCaret: (mode?: RootMode) => null | SiblingCaret<T, D>;
  getParentAtCaret: () => T;
  /** Return this, the ChildCaret is already a child caret of its origin */
  getChildCaret: () => this;
  /**
   * Return true if other is a ChildCaret with the same
   * origin (by node key comparison) and direction.
   */
  isSameNodeCaret: (
    other: null | undefined | PointCaret,
  ) => other is ChildCaret<T, D>;
  /**
   * Return true if other is a ChildCaret with the same
   * origin (by node key comparison) and direction.
   */
  isSamePointCaret: (
    other: null | undefined | PointCaret,
  ) => other is ChildCaret<T, D>;
  /**
   * Get a new NodeCaret with the head and tail of its directional arrow flipped, such that flipping twice is the identity.
   * For example, given a non-empty parent with a firstChild and lastChild, and a second emptyParent node with no children:
   *
   * @example
   * ```
   * caret.getFlipped().getFlipped().is(caret) === true;
   * $getChildCaret(parent, 'next').getFlipped().is($getSiblingCaret(firstChild, 'previous')) === true;
   * $getSiblingCaret(lastChild, 'next').getFlipped().is($getChildCaret(parent, 'previous')) === true;
   * $getSiblingCaret(firstChild, 'next).getFlipped().is($getSiblingCaret(lastChild, 'previous')) === true;
   * $getChildCaret(emptyParent, 'next').getFlipped().is($getChildCaret(emptyParent, 'previous')) === true;
   * ```
   */
  getFlipped: () => NodeCaret<FlipDirection<D>>;
}

/**
 * A TextPointCaret is a special case of a SiblingCaret that also carries
 * an offset used for representing partially selected TextNode at the edges
 * of a CaretRange.
 *
 * The direction determines which part of the text is adjacent to the caret,
 * if next it's all of the text after offset. If previous, it's all of the
 * text before offset.
 *
 * While this can be used in place of any SiblingCaret of a TextNode,
 * the offset into the text will be ignored except in contexts that
 * specifically use the TextPointCaret or PointCaret types.
 */
export interface TextPointCaret<
  T extends TextNode = TextNode,
  D extends CaretDirection = CaretDirection,
> extends BaseCaret<T, D, 'text'> {
  /** The offset into the string */
  readonly offset: number;
  /** Get a new caret with the latest origin pointer */
  getLatest: () => TextPointCaret<T, D>;
  /**
   * A TextPointCaret can not have a ChildCaret.
   */
  getChildCaret: () => null;
  /**
   * Get the caret in the same direction from the parent of this origin.
   *
   * @param mode 'root' to return null at the root, 'shadowRoot' to return null at the root or any shadow root
   * @returns A SiblingCaret with the parent of this origin, or null if the parent is a root according to mode.
   */
  getParentCaret: (mode?: RootMode) => null | SiblingCaret<ElementNode, D>;
  /**
   * Return true if other is a TextPointCaret or SiblingCaret with the same
   * origin (by node key comparison) and direction.
   */
  isSameNodeCaret: (
    other: null | undefined | PointCaret,
  ) => other is TextPointCaret<T, D> | SiblingCaret<T, D>;
  /**
   * Return true if other is a ChildCaret with the same
   * origin (by node key comparison) and direction.
   */
  isSamePointCaret: (
    other: null | undefined | PointCaret,
  ) => other is TextPointCaret<T, D>;
  /**
   * Get a new TextPointCaret with the head and tail of its directional arrow flipped, such that flipping twice is the identity.
   * For a TextPointCaret this merely flips the direction because the arrow is internal to the node.
   *
   * @example
   * ```
   * caret.getFlipped().getFlipped().is(caret) === true;
   * ```
   */
  getFlipped: () => TextPointCaret<T, FlipDirection<D>>;
}

/**
 * A TextPointCaretSlice is a wrapper for a TextPointCaret that carries a signed
 * distance representing the direction and amount of text selected from the given
 * caret. A negative distance means that text before offset is selected, a
 * positive distance means that text after offset is selected. The offset+distance
 * pair is not affected in any way by the direction of the caret.
 */
export interface TextPointCaretSlice<
  T extends TextNode = TextNode,
  D extends CaretDirection = CaretDirection,
> {
  readonly type: 'slice';
  readonly caret: TextPointCaret<T, D>;
  readonly distance: number;
  /**
   * @returns absolute coordinates into the text (for use with `text.slice(...)`)
   */
  getSliceIndices: () => [startIndex: number, endIndex: number];
  /**
   * @returns The text represented by the slice
   */
  getTextContent: () => string;
  /**
   * @returns The size of the text represented by the slice
   */
  getTextContentSize: () => number;
  /**
   * Remove the slice of text from the contained caret, returning a new
   * TextPointCaret without the wrapper (since the size would be zero).
   *
   * Note that this is a lower-level utility that does not have any specific
   * behavior for 'segmented' or 'token' modes and it will not remove
   * an empty TextNode.
   *
   * @returns The inner TextPointCaret with the same offset and direction
   *          and the latest TextNode origin after mutation
   */
  removeTextSlice(): TextPointCaret<T, D>;
}

/**
 * A utility type to specify that a CaretRange may have zero,
 * one, or two associated TextPointCaretSlice. If the anchor
 * and focus are on the same node, the anchorSlice will contain
 * the slice and focusSlie will be null.
 */
export type TextPointCaretSliceTuple<D extends CaretDirection> = readonly [
  anchorSlice: null | TextPointCaretSlice<TextNode, D>,
  focusSlice: null | TextPointCaretSlice<TextNode, D>,
];

abstract class AbstractCaret<
  T extends LexicalNode,
  D extends CaretDirection,
  Type,
> implements BaseCaret<T, D, Type> {
  abstract readonly type: Type;
  abstract readonly direction: D;
  readonly origin: T;
  abstract getNodeAtCaret(): null | LexicalNode;
  abstract insert(node: LexicalNode): this;
  abstract getParentAtCaret(): null | ElementNode;
  constructor(origin: T) {
    this.origin = origin;
  }
  [Symbol.iterator](): IterableIterator<SiblingCaret<LexicalNode, D>> {
    return makeStepwiseIterator({
      hasNext: $isSiblingCaret,
      initial: this.getAdjacentCaret(),
      map: caret => caret,
      step: (caret: SiblingCaret<LexicalNode, D>) => caret.getAdjacentCaret(),
    });
  }
  getAdjacentCaret(): null | SiblingCaret<LexicalNode, D> {
    return $getSiblingCaret(this.getNodeAtCaret(), this.direction);
  }
  getSiblingCaret(): SiblingCaret<T, D> {
    return $getSiblingCaret(this.origin, this.direction);
  }
  remove(): this {
    const node = this.getNodeAtCaret();
    if (node) {
      node.remove();
    }
    return this;
  }
  replaceOrInsert(node: LexicalNode, includeChildren?: boolean): this {
    const target = this.getNodeAtCaret();
    if (node.is(this.origin) || node.is(target)) {
      // do nothing
    } else if (target === null) {
      this.insert(node);
    } else {
      target.replace(node, includeChildren);
    }
    return this;
  }
  splice(
    deleteCount: number,
    nodes: Iterable<LexicalNode>,
    nodesDirection: CaretDirection = 'next',
  ): this {
    const nodeIter =
      nodesDirection === this.direction ? nodes : Array.from(nodes).reverse();
    let caret: SiblingCaret<LexicalNode, D> | this = this;
    const parent = this.getParentAtCaret();
    const nodesToRemove = new Map<NodeKey, LexicalNode>();
    // Find all of the nodes we expect to remove first, so
    // we don't have to worry about the cases where there is
    // overlap between the nodes to insert and the nodes to
    // remove
    for (
      let removeCaret = caret.getAdjacentCaret();
      removeCaret !== null && nodesToRemove.size < deleteCount;
      removeCaret = removeCaret.getAdjacentCaret()
    ) {
      const writableNode = removeCaret.origin.getWritable();
      nodesToRemove.set(writableNode.getKey(), writableNode);
    }
    // TODO: Optimize this to work directly with node internals
    for (const node of nodeIter) {
      if (nodesToRemove.size > 0) {
        // For some reason `pnpm run tsc-extension` needs this annotation?
        const target: null | LexicalNode = caret.getNodeAtCaret();
        if (target) {
          nodesToRemove.delete(target.getKey());
          nodesToRemove.delete(node.getKey());
          if (target.is(node) || caret.origin.is(node)) {
            // do nothing, it's already in the right place
          } else {
            const nodeParent = node.getParent();
            if (nodeParent && nodeParent.is(parent)) {
              // It's a sibling somewhere else in this node, so unparent it first
              node.remove();
            }
            target.replace(node);
          }
        } else {
          invariant(
            target !== null,
            'NodeCaret.splice: Underflow of expected nodesToRemove during splice (keys: %s)',
            Array.from(nodesToRemove).join(' '),
          );
        }
      } else {
        caret.insert(node);
      }
      caret = $getSiblingCaret(node, this.direction);
    }
    for (const node of nodesToRemove.values()) {
      node.remove();
    }
    return this;
  }
}

abstract class AbstractChildCaret<
  T extends ElementNode,
  D extends CaretDirection,
>
  extends AbstractCaret<T, D, 'child'>
  implements ChildCaret<T, D>
{
  readonly type = 'child';
  getLatest(): ChildCaret<T, D> {
    const origin = this.origin.getLatest();
    return origin === this.origin
      ? this
      : $getChildCaret(origin, this.direction);
  }
  /**
   * Get the SiblingCaret from this origin in the same direction.
   *
   * @param mode 'root' to return null at the root, 'shadowRoot' to return null at the root or any shadow root
   * @returns A SiblingCaret with this origin, or null if origin is a root according to mode.
   */
  getParentCaret(mode: RootMode = 'root'): null | SiblingCaret<T, D> {
    return $getSiblingCaret(
      $filterByMode(this.getParentAtCaret(), mode),
      this.direction,
    );
  }
  getFlipped(): NodeCaret<FlipDirection<D>> {
    const dir = flipDirection(this.direction);
    return (
      $getSiblingCaret(this.getNodeAtCaret(), dir) ||
      $getChildCaret(this.origin, dir)
    );
  }
  getParentAtCaret(): T {
    return this.origin;
  }
  getChildCaret(): this {
    return this;
  }
  isSameNodeCaret(
    other: null | undefined | PointCaret,
  ): other is ChildCaret<T, D> {
    return (
      other instanceof AbstractChildCaret &&
      this.direction === other.direction &&
      this.origin.is(other.origin)
    );
  }
  isSamePointCaret(
    other: null | undefined | PointCaret,
  ): other is ChildCaret<T, D> {
    return this.isSameNodeCaret(other);
  }
}

class ChildCaretFirst<T extends ElementNode> extends AbstractChildCaret<
  T,
  'next'
> {
  readonly direction = 'next';
  getNodeAtCaret(): null | LexicalNode {
    return this.origin.getFirstChild();
  }
  insert(node: LexicalNode): this {
    this.origin.splice(0, 0, [node]);
    return this;
  }
}

class ChildCaretLast<T extends ElementNode> extends AbstractChildCaret<
  T,
  'previous'
> {
  readonly direction = 'previous';
  getNodeAtCaret(): null | LexicalNode {
    return this.origin.getLastChild();
  }
  insert(node: LexicalNode): this {
    this.origin.splice(this.origin.getChildrenSize(), 0, [node]);
    return this;
  }
}

const MODE_PREDICATE = {
  root: $isRootNode,
  shadowRoot: $isRootOrShadowRoot,
} as const;

/**
 * Flip a direction ('next' -> 'previous'; 'previous' -> 'next').
 *
 * Note that TypeScript can't prove that FlipDirection is its own
 * inverse (but if you have a concrete 'next' or 'previous' it will
 * simplify accordingly).
 *
 * @param direction A direction
 * @returns The opposite direction
 */
export function flipDirection<D extends CaretDirection>(
  direction: D,
): FlipDirection<D> {
  return FLIP_DIRECTION[direction];
}

function $filterByMode<T extends ElementNode>(
  node: T | null,
  mode: RootMode = 'root',
): T | null {
  if (node === null || MODE_PREDICATE[mode](node)) {
    return null;
  }
  // A slotted node's up-link is __slotHost, not __parent, so getParent() (and
  // thus getParentOrThrow()) returns null on it. It is a hard upward boundary
  // in every mode — like the root — so caret walks must stop at it instead of
  // trying to rewind past a parentless node.
  return $getSlotHostKey(node) === null ? node : null;
}

abstract class AbstractSiblingCaret<
  T extends LexicalNode,
  D extends CaretDirection,
>
  extends AbstractCaret<T, D, 'sibling'>
  implements SiblingCaret<T, D>
{
  readonly type = 'sibling';
  getLatest(): SiblingCaret<T, D> {
    const origin = this.origin.getLatest();
    return origin === this.origin
      ? this
      : $getSiblingCaret(origin, this.direction);
  }
  getSiblingCaret(): this {
    return this;
  }
  getParentAtCaret(): null | ElementNode {
    return this.origin.getParent();
  }
  getChildCaret(): ChildCaret<T & ElementNode, D> | null {
    return $isElementNode(this.origin)
      ? $getChildCaret(this.origin, this.direction)
      : null;
  }
  getParentCaret(mode: RootMode = 'root'): SiblingCaret<ElementNode, D> | null {
    return $getSiblingCaret(
      $filterByMode(this.getParentAtCaret(), mode),
      this.direction,
    );
  }
  getFlipped(): NodeCaret<FlipDirection<D>> {
    const dir = flipDirection(this.direction);
    return (
      $getSiblingCaret(this.getNodeAtCaret(), dir) ||
      $getChildCaret(this.origin.getParentOrThrow(), dir)
    );
  }
  isSamePointCaret(
    other: null | undefined | PointCaret,
  ): other is SiblingCaret<T, D> {
    return (
      other instanceof AbstractSiblingCaret &&
      this.direction === other.direction &&
      this.origin.is(other.origin)
    );
  }
  isSameNodeCaret(
    other: null | undefined | PointCaret,
  ): other is T | SiblingCaret<T, D> extends TextNode
    ? TextPointCaret<T & TextNode, D>
    : never {
    return (
      (other instanceof AbstractSiblingCaret ||
        other instanceof AbstractTextPointCaret) &&
      this.direction === other.direction &&
      this.origin.is(other.origin)
    );
  }
}

abstract class AbstractTextPointCaret<
  T extends TextNode,
  D extends CaretDirection,
>
  extends AbstractCaret<T, D, 'text'>
  implements TextPointCaret<T, D>
{
  readonly type = 'text';
  readonly offset: number;
  abstract readonly direction: D;
  constructor(origin: T, offset: number) {
    super(origin);
    this.offset = offset;
  }
  getLatest(): TextPointCaret<T, D> {
    const origin = this.origin.getLatest();
    return origin === this.origin
      ? this
      : $getTextPointCaret(origin, this.direction, this.offset);
  }
  getParentAtCaret(): null | ElementNode {
    return this.origin.getParent();
  }
  getChildCaret(): null {
    return null;
  }
  getParentCaret(mode: RootMode = 'root'): SiblingCaret<ElementNode, D> | null {
    return $getSiblingCaret(
      $filterByMode(this.getParentAtCaret(), mode),
      this.direction,
    );
  }
  getFlipped(): TextPointCaret<T, FlipDirection<D>> {
    return $getTextPointCaret(
      this.origin,
      flipDirection(this.direction),
      this.offset,
    );
  }
  isSamePointCaret(
    other: null | undefined | PointCaret,
  ): other is TextPointCaret<T, D> {
    return (
      other instanceof AbstractTextPointCaret &&
      this.direction === other.direction &&
      this.origin.is(other.origin) &&
      this.offset === other.offset
    );
  }
  isSameNodeCaret(
    other: null | undefined | PointCaret,
  ): other is SiblingCaret<T, D> | TextPointCaret<T, D> {
    return (
      (other instanceof AbstractSiblingCaret ||
        other instanceof AbstractTextPointCaret) &&
      this.direction === other.direction &&
      this.origin.is(other.origin)
    );
  }
  getSiblingCaret(): SiblingCaret<T, D> {
    return $getSiblingCaret(this.origin, this.direction);
  }
}
/**
 * Guard to check if the given caret is specifically a TextPointCaret
 *
 * @param caret Any caret
 * @returns true if it is a TextPointCaret
 */
export function $isTextPointCaret<D extends CaretDirection>(
  caret: null | undefined | PointCaret<D>,
): caret is TextPointCaret<TextNode, D> {
  return caret instanceof AbstractTextPointCaret;
}

/**
 * Guard to check if the given argument is any type of caret
 *
 * @param caret
 * @returns true if caret is any type of caret
 */
export function $isNodeCaret<D extends CaretDirection>(
  caret: null | undefined | PointCaret<D>,
): caret is PointCaret<D> {
  return caret instanceof AbstractCaret;
}

/**
 * Guard to check if the given argument is specifically a SiblingCaret (or TextPointCaret)
 *
 * @param caret
 * @returns true if caret is a SiblingCaret
 */
export function $isSiblingCaret<D extends CaretDirection>(
  caret: null | undefined | PointCaret<D>,
): caret is SiblingCaret<LexicalNode, D> {
  return caret instanceof AbstractSiblingCaret;
}

/**
 * Guard to check if the given argument is specifically a ChildCaret

 * @param caret 
 * @returns true if caret is a ChildCaret
 */
export function $isChildCaret<D extends CaretDirection>(
  caret: null | undefined | PointCaret<D>,
): caret is ChildCaret<ElementNode, D> {
  return caret instanceof AbstractChildCaret;
}

class SiblingCaretNext<T extends LexicalNode> extends AbstractSiblingCaret<
  T,
  'next'
> {
  readonly direction = 'next';
  getNodeAtCaret(): null | LexicalNode {
    return this.origin.getNextSibling();
  }
  insert(node: LexicalNode): this {
    this.origin.insertAfter(node);
    return this;
  }
}

class SiblingCaretPrevious<T extends LexicalNode> extends AbstractSiblingCaret<
  T,
  'previous'
> {
  readonly direction = 'previous';
  getNodeAtCaret(): null | LexicalNode {
    return this.origin.getPreviousSibling();
  }
  insert(node: LexicalNode): this {
    this.origin.insertBefore(node);
    return this;
  }
}

class TextPointCaretNext<T extends TextNode> extends AbstractTextPointCaret<
  T,
  'next'
> {
  readonly direction = 'next';
  getNodeAtCaret(): null | LexicalNode {
    return this.origin.getNextSibling();
  }
  insert(node: LexicalNode): this {
    this.origin.insertAfter(node);
    return this;
  }
}

class TextPointCaretPrevious<T extends TextNode> extends AbstractTextPointCaret<
  T,
  'previous'
> {
  readonly direction = 'previous';
  getNodeAtCaret(): null | LexicalNode {
    return this.origin.getPreviousSibling();
  }
  insert(node: LexicalNode): this {
    this.origin.insertBefore(node);
    return this;
  }
}

const TEXT_CTOR = {
  next: TextPointCaretNext,
  previous: TextPointCaretPrevious,
} as const;

const SIBLING_CTOR = {
  next: SiblingCaretNext,
  previous: SiblingCaretPrevious,
} as const;

const CHILD_CTOR = {
  next: ChildCaretFirst,
  previous: ChildCaretLast,
};

/**
 * Get a caret that points at the next or previous sibling of the given origin node.
 *
 * @param origin The origin node
 * @param direction 'next' or 'previous'
 * @returns null if origin is null, otherwise a SiblingCaret for this origin and direction
 */
export function $getSiblingCaret<
  T extends LexicalNode,
  D extends CaretDirection,
>(origin: T, direction: D): SiblingCaret<T, D>;
export function $getSiblingCaret<
  T extends LexicalNode,
  D extends CaretDirection,
>(origin: null | T, direction: D): null | SiblingCaret<T, D>;
export function $getSiblingCaret(
  origin: null | LexicalNode,
  direction: CaretDirection,
): null | SiblingCaret<LexicalNode, CaretDirection> {
  return origin ? new SIBLING_CTOR[direction](origin) : null;
}

/**
 * Construct a TextPointCaret
 *
 * @param origin The TextNode
 * @param direction The direction (next points to the end of the text, previous points to the beginning)
 * @param offset The offset into the text in absolute positive string coordinates (0 is the start)
 * @returns a TextPointCaret
 */
export function $getTextPointCaret<
  T extends TextNode,
  D extends CaretDirection,
>(
  origin: T,
  direction: D,
  offset: number | CaretDirection,
): TextPointCaret<T, D>;
export function $getTextPointCaret<
  T extends TextNode,
  D extends CaretDirection,
>(
  origin: null | T,
  direction: D,
  offset: number | CaretDirection,
): null | TextPointCaret<T, D>;
export function $getTextPointCaret(
  origin: TextNode | null,
  direction: CaretDirection,
  offset: number | CaretDirection,
): null | TextPointCaret<TextNode, CaretDirection> {
  return origin
    ? new TEXT_CTOR[direction](origin, $getTextNodeOffset(origin, offset))
    : null;
}

/**
 * Get a normalized offset into a TextNode given a numeric offset or a
 * direction for which end of the string to use. Throws in dev if the offset
 * is not in the bounds of the text content size.
 *
 * @param origin a TextNode
 * @param offset An absolute offset into the TextNode string, or a direction for which end to use as the offset
 * @param mode If 'error' (the default) out of bounds offsets will be an error in dev. Otherwise it will clamp to a valid offset.
 * @returns An absolute offset into the TextNode string
 */
export function $getTextNodeOffset(
  origin: TextNode,
  offset: number | CaretDirection,
  mode: 'error' | 'clamp' = 'error',
): number {
  const size = origin.getTextContentSize();
  let numericOffset =
    offset === 'next' ? size : offset === 'previous' ? 0 : offset;
  if (numericOffset < 0 || numericOffset > size) {
    devInvariant(
      mode === 'clamp',
      '$getTextNodeOffset: invalid offset %s for size %s at key %s',
      String(offset),
      String(size),
      origin.getKey(),
    );
    // Clamp invalid offsets in prod
    numericOffset = numericOffset < 0 ? 0 : size;
  }
  return numericOffset;
}

/**
 * Construct a TextPointCaretSlice given a TextPointCaret and a signed distance. The
 * distance should be negative to slice text before the caret's offset, and positive
 * to slice text after the offset. The direction of the caret itself is not
 * relevant to the string coordinates when working with a TextPointCaretSlice
 * but mutation operations will preserve the direction.
 *
 * @param caret
 * @param distance
 * @returns TextPointCaretSlice
 */
export function $getTextPointCaretSlice<
  T extends TextNode,
  D extends CaretDirection,
>(caret: TextPointCaret<T, D>, distance: number): TextPointCaretSlice<T, D> {
  return new TextPointCaretSliceImpl(caret, distance);
}

/**
 * Get a caret that points at the first or last child of the given origin node,
 * which must be an ElementNode.
 *
 * @param origin The origin ElementNode
 * @param direction 'next' for first child or 'previous' for last child
 * @returns null if origin is null or not an ElementNode, otherwise a ChildCaret for this origin and direction
 */
export function $getChildCaret<T extends ElementNode, D extends CaretDirection>(
  origin: T,
  direction: D,
): ChildCaret<T, D>;
export function $getChildCaret(
  origin: null | LexicalNode,
  direction: CaretDirection,
): null | ChildCaret<ElementNode, CaretDirection> {
  return $isElementNode(origin) ? new CHILD_CTOR[direction](origin) : null;
}

/**
 * Gets the ChildCaret if one is possible at this caret origin, otherwise return the caret
 */
export function $getChildCaretOrSelf<Caret extends PointCaret | null>(
  caret: Caret,
): Caret | ChildCaret<ElementNode, NonNullable<Caret>['direction']> {
  return (caret && caret.getChildCaret()) || caret;
}

/**
 * Gets the adjacent caret, if not-null and if the origin of the adjacent caret is an ElementNode, then return
 * the ChildCaret. This can be used along with the getParentAdjacentCaret method to perform a full DFS
 * style traversal of the tree.
 *
 * @param caret The caret to start at
 */
export function $getAdjacentChildCaret<D extends CaretDirection>(
  caret: null | NodeCaret<D>,
): null | NodeCaret<D> {
  return caret && $getChildCaretOrSelf(caret.getAdjacentCaret());
}

class CaretRangeImpl<D extends CaretDirection> implements CaretRange<D> {
  readonly type = 'node-caret-range';
  readonly direction: D;
  anchor: PointCaret<D>;
  focus: PointCaret<D>;
  constructor(anchor: PointCaret<D>, focus: PointCaret<D>, direction: D) {
    this.anchor = anchor;
    this.focus = focus;
    this.direction = direction;
  }
  getLatest(): CaretRange<D> {
    const anchor = this.anchor.getLatest();
    const focus = this.focus.getLatest();
    return anchor === this.anchor && focus === this.focus
      ? this
      : new CaretRangeImpl(anchor, focus, this.direction);
  }
  isCollapsed(): boolean {
    return this.anchor.isSamePointCaret(this.focus);
  }
  getTextSlices(): TextPointCaretSliceTuple<D> {
    const getSlice = (k: 'anchor' | 'focus') => {
      const caret = this[k].getLatest();
      return $isTextPointCaret(caret)
        ? $getSliceFromTextPointCaret(caret, k)
        : null;
    };
    const anchorSlice = getSlice('anchor');
    const focusSlice = getSlice('focus');
    if (anchorSlice && focusSlice) {
      const {caret: anchorCaret} = anchorSlice;
      const {caret: focusCaret} = focusSlice;
      if (anchorCaret.isSameNodeCaret(focusCaret)) {
        return [
          $getTextPointCaretSlice(
            anchorCaret,
            focusCaret.offset - anchorCaret.offset,
          ),
          null,
        ];
      }
    }
    return [anchorSlice, focusSlice];
  }
  iterNodeCarets(rootMode: RootMode = 'root'): IterableIterator<NodeCaret<D>> {
    const anchor = $isTextPointCaret(this.anchor)
      ? this.anchor.getSiblingCaret()
      : this.anchor.getLatest();
    const focus = this.focus.getLatest();
    const isTextFocus = $isTextPointCaret(focus);
    const step = (state: NodeCaret<D>) =>
      state.isSameNodeCaret(focus)
        ? null
        : $getAdjacentChildCaret(state) || state.getParentCaret(rootMode);
    return makeStepwiseIterator({
      hasNext: (state: null | NodeCaret<D>): state is NodeCaret<D> =>
        state !== null && !(isTextFocus && focus.isSameNodeCaret(state)),
      initial: anchor.isSameNodeCaret(focus) ? null : step(anchor),
      map: state => state,
      step,
    });
  }
  [Symbol.iterator](): IterableIterator<NodeCaret<D>> {
    return this.iterNodeCarets('root');
  }
}

class TextPointCaretSliceImpl<
  T extends TextNode,
  D extends CaretDirection,
> implements TextPointCaretSlice<T, D> {
  readonly type = 'slice';
  readonly caret: TextPointCaret<T, D>;
  readonly distance: number;
  constructor(caret: TextPointCaret<T, D>, distance: number) {
    this.caret = caret;
    this.distance = distance;
  }
  getSliceIndices(): [startIndex: number, endIndex: number] {
    const {
      distance,
      caret: {offset},
    } = this;
    const offsetB = offset + distance;
    return offsetB < offset ? [offsetB, offset] : [offset, offsetB];
  }

  getTextContent(): string {
    const [startIndex, endIndex] = this.getSliceIndices();
    return this.caret.origin.getTextContent().slice(startIndex, endIndex);
  }

  getTextContentSize(): number {
    return Math.abs(this.distance);
  }

  removeTextSlice(): TextPointCaret<T, D> {
    const {
      caret: {origin, direction},
    } = this;
    const [indexStart, indexEnd] = this.getSliceIndices();
    const text = origin.getTextContent();
    return $getTextPointCaret(
      origin.setTextContent(text.slice(0, indexStart) + text.slice(indexEnd)),
      direction,
      indexStart,
    );
  }
}

function $getSliceFromTextPointCaret<
  T extends TextNode,
  D extends CaretDirection,
>(
  caret: TextPointCaret<T, D>,
  anchorOrFocus: 'anchor' | 'focus',
): TextPointCaretSlice<T, D> {
  const {direction, origin} = caret;
  const offsetB = $getTextNodeOffset(
    origin,
    anchorOrFocus === 'focus' ? flipDirection(direction) : direction,
  );
  return $getTextPointCaretSlice(caret, offsetB - caret.offset);
}

/**
 * Guard to check for a TextPointCaretSlice
 *
 * @param caretOrSlice A caret or slice
 * @returns true if caretOrSlice is a TextPointCaretSlice
 */
export function $isTextPointCaretSlice<D extends CaretDirection>(
  caretOrSlice:
    | null
    | undefined
    | PointCaret<D>
    | TextPointCaretSlice<TextNode, D>,
): caretOrSlice is TextPointCaretSlice<TextNode, D> {
  return caretOrSlice instanceof TextPointCaretSliceImpl;
}

/**
 * Return the caret if it's in the given direction, otherwise return
 * caret.getFlipped().
 *
 * @param caret Any PointCaret
 * @param direction The desired direction
 * @returns A PointCaret in direction
 */
export function $getCaretInDirection<
  Caret extends PointCaret<CaretDirection>,
  D extends CaretDirection,
>(
  caret: Caret,
  direction: D,
):
  | NodeCaret<D>
  | (Caret extends TextPointCaret<TextNode, CaretDirection>
      ? TextPointCaret<TextNode, D>
      : never) {
  return (caret.direction === direction ? caret : caret.getFlipped()) as
    | NodeCaret<D>
    | (Caret extends TextPointCaret<TextNode, CaretDirection>
        ? TextPointCaret<TextNode, D>
        : never);
}

/**
 * Construct a CaretRange that starts at anchor and goes to the end of the
 * document in the anchor caret's direction.
 */
export function $extendCaretToRange<D extends CaretDirection>(
  anchor: PointCaret<D>,
): CaretRange<D> {
  // Use an in-document point to represent the end,
  // iteration is inclusive of the endpoint.
  return $getCaretRange(
    anchor,
    $getCaretInDirection(
      $getChildCaret($getRoot(), flipDirection(anchor.direction)),
      anchor.direction,
    ),
  );
}

/**
 * Construct a collapsed CaretRange that starts and ends at anchor.
 */
export function $getCollapsedCaretRange<D extends CaretDirection>(
  anchor: PointCaret<D>,
): CaretRange<D> {
  return $getCaretRange(anchor, anchor);
}

/**
 * Construct a CaretRange from anchor and focus carets pointing in the
 * same direction. In order to get the expected behavior,
 * the anchor must point towards the focus or be the same point.
 *
 * In the 'next' direction the anchor should be at or before the
 * focus in the document. In the 'previous' direction the anchor
 * should be at or after the focus in the document
 * (similar to a backwards RangeSelection).
 *
 * @param anchor
 * @param focus
 * @returns a CaretRange
 */
export function $getCaretRange<D extends CaretDirection>(
  anchor: PointCaret<D>,
  focus: PointCaret<D>,
): CaretRange<D> {
  invariant(
    anchor.direction === focus.direction,
    '$getCaretRange: anchor and focus must be in the same direction',
  );
  return new CaretRangeImpl(anchor, focus, anchor.direction);
}

/**
 * A generalized utility for creating a stepwise iterator
 * based on:
 *
 * - an initial state
 * - a stop guard that returns true if the iteration is over, this
 *   is typically used to detect a sentinel value such as null or
 *   undefined from the state but may return true for other conditions
 *   as well
 * - a step function that advances the state (this will be called
 *   after map each time next() is called to prepare the next state)
 * - a map function that will be called that may transform the state
 *   before returning it. It will only be called once for each next()
 *   call when stop(state) === false
 *
 * @param config
 * @returns An IterableIterator
 */
export function makeStepwiseIterator<State, Stop, Value>(
  config: StepwiseIteratorConfig<State, Stop, Value>,
): IterableIterator<Value> {
  const {initial, hasNext, step, map} = config;
  let state = initial;
  return {
    [Symbol.iterator]() {
      return this;
    },
    next(): IteratorResult<Value> {
      if (!hasNext(state)) {
        return {done: true, value: undefined};
      }
      const rval = {done: false, value: map(state)};
      state = step(state);
      return rval;
    },
  };
}

function compareNumber(a: number, b: number): -1 | 0 | 1 {
  return Math.sign(a - b) as -1 | 0 | 1;
}

/**
 * A total ordering for `PointCaret<'next'>`, based on
 * the same order that a {@link CaretRange} would iterate
 * them.
 *
 * For a given origin node:
 * - ChildCaret comes before SiblingCaret
 * - TextPointCaret comes before SiblingCaret
 *
 * An exception is thrown when a and b do not have any
 * common ancestor.
 *
 * This ordering is a sort of mix of pre-order and post-order
 * because each ElementNode will show up as a ChildCaret
 * on 'enter' (pre-order) and a SiblingCaret on 'leave' (post-order).
 *
 * @param a
 * @param b
 * @returns -1 if a comes before b, 0 if a and b are the same, or 1 if a comes after b
 */
export function $comparePointCaretNext(
  a: PointCaret<'next'>,
  b: PointCaret<'next'>,
): -1 | 0 | 1 {
  const compare = $getCommonAncestor(a.origin, b.origin);
  invariant(
    compare !== null,
    '$comparePointCaretNext: a (key %s) and b (key %s) do not have a common ancestor',
    a.origin.getKey(),
    b.origin.getKey(),
  );
  switch (compare.type) {
    case 'same': {
      const aIsText = a.type === 'text';
      const bIsText = b.type === 'text';
      return aIsText && bIsText
        ? compareNumber(a.offset, b.offset)
        : a.type === b.type
          ? 0
          : aIsText
            ? -1
            : bIsText
              ? 1
              : a.type === 'child'
                ? -1
                : 1;
    }
    case 'ancestor': {
      return a.type === 'child' ? -1 : 1;
    }
    case 'descendant': {
      return b.type === 'child' ? 1 : -1;
    }
    case 'branch': {
      return $getCommonAncestorResultBranchOrder(compare);
    }
  }
}

/**
 * Return the ordering of siblings in a {@link CommonAncestorResultBranch}
 * @param compare Returns -1 if a precedes b, 1 otherwise
 */
export function $getCommonAncestorResultBranchOrder<
  A extends LexicalNode,
  B extends LexicalNode,
>(compare: CommonAncestorResultBranch<A, B>): -1 | 1 {
  const {a, b} = compare;
  const aKey = a.__key;
  const bKey = b.__key;
  let na: null | LexicalNode = a;
  let nb: null | LexicalNode = b;
  for (; na && nb; na = na.getNextSibling(), nb = nb.getNextSibling()) {
    if (na.__key === bKey) {
      return -1;
    } else if (nb.__key === aKey) {
      return 1;
    }
  }
  return na === null ? 1 : -1;
}

/**
 * The two compared nodes are the same
 */
export interface CommonAncestorResultSame<A extends LexicalNode> {
  readonly type: 'same';
  readonly commonAncestor: A;
}
/**
 * Node a was a descendant of node b, and not the same node
 */
export interface CommonAncestorResultDescendant<B extends ElementNode> {
  readonly type: 'descendant';
  readonly commonAncestor: B;
}
/**
 * Node a is an ancestor of node b, and not the same node
 */
export interface CommonAncestorResultAncestor<A extends ElementNode> {
  readonly type: 'ancestor';
  readonly commonAncestor: A;
}
/**
 * Node a and node b have a common ancestor but are on different branches,
 * the `a` and `b` properties of this result are the ancestors of a and b
 * that are children of the commonAncestor. Since they are siblings, their
 * positions are comparable to determine order in the document.
 */
export interface CommonAncestorResultBranch<
  A extends LexicalNode,
  B extends LexicalNode,
> {
  readonly type: 'branch';
  readonly commonAncestor: ElementNode;
  /** The ancestor of `a` that is a child of `commonAncestor`  */
  readonly a: A | ElementNode;
  /** The ancestor of `b` that is a child of `commonAncestor`  */
  readonly b: B | ElementNode;
}
/**
 * The result of comparing two nodes that share some common ancestor
 */
export type CommonAncestorResult<
  A extends LexicalNode,
  B extends LexicalNode,
> =
  | CommonAncestorResultSame<A>
  | CommonAncestorResultAncestor<A & ElementNode>
  | CommonAncestorResultDescendant<B & ElementNode>
  | CommonAncestorResultBranch<A, B>;

function $isSameNode<T extends LexicalNode>(
  reference: T,
  other: LexicalNode,
): other is T {
  return other.is(reference);
}

function $initialElementTuple(
  node: LexicalNode,
): [ElementNode | null, LexicalNode | null] {
  return $isElementNode(node)
    ? [node.getLatest(), null]
    : [node.getParent(), node.getLatest()];
}

/**
 * Find a common ancestor of a and b and return a detailed result object,
 * or null if there is no common ancestor between the two nodes.
 *
 * The result object will have a commonAncestor property, and the other
 * properties can be used to quickly compare these positions in the tree.
 *
 * @param a A LexicalNode
 * @param b A LexicalNode
 * @returns A comparison result between the two nodes or null if they have no common ancestor
 */
export function $getCommonAncestor<
  A extends LexicalNode,
  B extends LexicalNode,
>(a: A, b: B): null | CommonAncestorResult<A, B> {
  if (a.is(b)) {
    return {commonAncestor: a, type: 'same'};
  }
  // Map of parent -> child entries based on a and its ancestors
  const aMap = new Map<ElementNode, LexicalNode | null>();
  for (
    let [parent, child] = $initialElementTuple(a);
    parent;
    child = parent, parent = parent.getParent()
  ) {
    aMap.set(parent, child);
  }
  for (
    let [parent, child] = $initialElementTuple(b);
    parent;
    child = parent, parent = parent.getParent()
  ) {
    const aChild = aMap.get(parent);
    if (aChild === undefined) {
      // keep going
    } else if (aChild === null) {
      // a is the ancestor
      invariant(
        $isSameNode(a, parent),
        '$originComparison: ancestor logic error',
      );
      return {commonAncestor: parent, type: 'ancestor'};
    } else if (child === null) {
      // b is the ancestor
      invariant(
        $isSameNode(b, parent),
        '$originComparison: descendant logic error',
      );
      return {commonAncestor: parent, type: 'descendant'};
    } else {
      invariant(
        ($isElementNode(aChild) || $isSameNode(a, aChild)) &&
          ($isElementNode(child) || $isSameNode(b, child)) &&
          parent.is(aChild.getParent()) &&
          parent.is(child.getParent()),
        '$originComparison: branch logic error',
      );
      return {
        a: aChild,
        b: child,
        commonAncestor: parent,
        type: 'branch',
      };
    }
  }
  return null;
}
