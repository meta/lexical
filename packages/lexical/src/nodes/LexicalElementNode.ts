/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  BaseStaticNodeConfig,
  KlassConstructor,
  LexicalEditor,
  LexicalUpdateJSON,
  Spread,
  TextFormatType,
} from 'lexical';

import invariant from '@lexical/internal/invariant';

import {$isTextNode, type TextNode} from '../index';
import {
  DOUBLE_LINE_BREAK,
  ELEMENT_FORMAT_TO_TYPE,
  ELEMENT_TYPE_TO_FORMAT,
  TEXT_TYPE_TO_FORMAT,
} from '../LexicalConstants';
import {ElementDOMSlot} from '../LexicalDOMSlot';
import {
  $isEphemeral,
  type DOMExportOutput,
  LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type SlotChildNode,
  type SlotHostNode,
} from '../LexicalNode';
import {
  $getSelection,
  $internalMakeRangeSelection,
  $isRangeSelection,
  type BaseSelection,
  moveSelectionPointToSibling,
  type PointType,
  type RangeSelection,
} from '../LexicalSelection';
import {
  $errorOnSlotCycleChild,
  $getSlot,
  $getSlotNames,
  $getSlotsTextContent,
  $getSlotsTextContentSize,
} from '../LexicalSlot';
import {errorOnReadOnly, getActiveEditor} from '../LexicalUpdates';
import {
  $getDOMSlot,
  $getNodeByKey,
  $isRootOrShadowRoot,
  $removeFromParent,
  isHTMLElement,
  toggleTextFormatType,
} from '../LexicalUtils';

export type SerializedElementNode<
  T extends SerializedLexicalNode = SerializedLexicalNode,
> = Spread<
  {
    children: T[];
    direction: 'ltr' | 'rtl' | null;
    format: ElementFormatType;
    indent: number;
    textFormat?: number;
    textStyle?: string;
  },
  SerializedLexicalNode
>;

export type ElementFormatType =
  | 'left'
  | 'start'
  | 'center'
  | 'right'
  | 'end'
  | 'justify'
  | '';

/**
 * Wrap any shadow-root child of `node` that is neither an ElementNode nor a
 * DecoratorNode in a paragraph, so the slot-frame invariant set by
 * `getTopLevelElement` continues to hold for external inputs (URL doc
 * payloads, imported JSON, paste round-trips) that may carry shapes the
 * in-editor mutation paths can no longer produce.
 *
 * Single-node helper: runs as the `$config` `$transform` on ElementNode so
 * the existing dirty-node transform cycle drives the normalization. The
 * in-editor mutation paths (insertText, insertNodes, append/splice via the
 * public API) still fail-fast on the invariant.
 *
 * @internal
 */
function $normalizeShadowRootChildren(node: ElementNode): void {
  if ($isRootOrShadowRoot(node)) {
    let block: ElementNode | null = null;
    for (const child of node.getChildren()) {
      block = child.isInline()
        ? (block || child.replace(child.createParentElementNode())).append(
            child,
          )
        : null;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ElementNode {
  getTopLevelElement(): ElementNode | null;
  getTopLevelElementOrThrow(): ElementNode;
}

/** @noInheritDoc */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ElementNode
  extends LexicalNode
  implements SlotHostNode, SlotChildNode
{
  /** @internal */
  declare ['constructor']: KlassConstructor<typeof ElementNode>;
  /** @internal */
  __first: null | NodeKey;
  /** @internal */
  __last: null | NodeKey;
  /** @internal */
  __size: number;
  /** @internal */
  __format: number;
  /** @internal */
  __style: string;
  /** @internal */
  __indent: number;
  /** @internal */
  __dir: 'ltr' | 'rtl' | null;
  /** @internal */
  __textFormat: number;
  /** @internal */
  __textStyle: string;
  /** @internal */
  __slotHost: null | NodeKey;
  /** @internal */
  __slots: null | Map<string, NodeKey>;

  // Specific type information is discarded for backwards compatibility,
  // there is nothing meaninful to gain from requiring `{extends: ElementNode}`
  // with the current shape here (just a `$transform`)
  $config(): BaseStaticNodeConfig {
    return this.config(Symbol.for('ElementNode'), {
      /*
       * Built-in normalize for shadow-root ElementNodes: wraps any direct child
       * that is neither an ElementNode nor a DecoratorNode in a paragraph, so
       * the slot-frame invariant set by `getTopLevelElement` continues to hold
       * for external inputs (URL doc payloads, imported JSON, paste round-trips)
       * that may carry shapes the in-editor mutation paths can no longer
       * produce. In-editor mutation paths still fail-fast on the invariant.
       *
       * Runs as a static transform so the existing dirty-node transform cycle
       * drives it — typing paths cover their own dirty bookkeeping, hydrate
       * paths (`setEditorState`) dirty-mark slot hosts so the cycle picks them
       * up.
       */
      $transform: $normalizeShadowRootChildren,
      extends: LexicalNode,
    });
  }

  constructor(key?: NodeKey) {
    super(key);
    this.__first = null;
    this.__last = null;
    this.__size = 0;
    this.__format = 0;
    this.__style = '';
    this.__indent = 0;
    this.__dir = null;
    this.__textFormat = 0;
    this.__textStyle = '';
    this.__slotHost = null;
    this.__slots = null;
  }

  afterCloneFrom(prevNode: this) {
    super.afterCloneFrom(prevNode);
    if (this.__key === prevNode.__key) {
      this.__first = prevNode.__first;
      this.__last = prevNode.__last;
      this.__size = prevNode.__size;
      this.__slotHost = prevNode.__slotHost;
      invariant(
        this.__slotHost === null || this.__parent === null,
        'ElementNode: node %s is both slotted into host %s and a child of parent %s; __slotHost and __parent are mutually exclusive',
        this.__key,
        String(this.__slotHost),
        String(this.__parent),
      );
      // Copy-on-write: share the map across versions; the LexicalSlot
      // mutators clone it on a version's first write (owner ledger), so a
      // host cloned for any non-slot change pays no per-version Map copy.
      this.__slots = prevNode.__slots;
    }
    this.__indent = prevNode.__indent;
    this.__format = prevNode.__format;
    this.__style = prevNode.__style;
    this.__dir = prevNode.__dir;
    this.__textFormat = prevNode.__textFormat;
    this.__textStyle = prevNode.__textStyle;
  }

  getFormat(): number {
    const self = this.getLatest();
    return self.__format;
  }
  getFormatType(): ElementFormatType {
    const format = this.getFormat();
    return ELEMENT_FORMAT_TO_TYPE[format] || '';
  }
  getStyle(): string {
    const self = this.getLatest();
    return self.__style;
  }
  getIndent(): number {
    const self = this.getLatest();
    return self.__indent;
  }
  /**
   * Returns the children of this node, in document order.
   */
  getChildren(): LexicalNode[];
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `element.getChildren() as T[]`, and will be
   * removed in a future release. Call this method without a type argument
   * and narrow the results with a type guard instead.
   */
  getChildren<T extends LexicalNode>(): T[];
  getChildren(): LexicalNode[] {
    const children: LexicalNode[] = [];
    let child = this.getFirstChild();
    while (child !== null) {
      children.push(child);
      child = child.getNextSibling();
    }
    return children;
  }
  getChildrenKeys(): NodeKey[] {
    const children: NodeKey[] = [];
    let child = this.getFirstChild();
    while (child !== null) {
      children.push(child.__key);
      child = child.getNextSibling();
    }
    return children;
  }
  getChildrenSize(): number {
    const self = this.getLatest();
    return self.__size;
  }
  isEmpty(): boolean {
    // A host that holds content only in its slots is not empty: otherwise
    // $removeNode would cascade-prune it once its last child is gone and orphan
    // the slot subtrees.
    return this.getChildrenSize() === 0 && $getSlotNames(this).length === 0;
  }
  isDirty(): boolean {
    const editor = getActiveEditor();
    const dirtyElements = editor._dirtyElements;
    return dirtyElements !== null && dirtyElements.has(this.__key);
  }
  isLastChild(): boolean {
    const self = this.getLatest();
    const parentLastChild = this.getParentOrThrow().getLastChild();
    return parentLastChild !== null && parentLastChild.is(self);
  }
  getAllTextNodes(): TextNode[] {
    const textNodes: TextNode[] = [];
    // Slots are read slots-first, ahead of the linked-list children, to match
    // getTextContent. This is a content read; descendant navigation
    // (getFirstDescendant / getLastDescendant) stays children-only so slots
    // never leak into selection placement. A slot value is always a non-inline
    // element or decorator (setSlot enforces this), so only element slots
    // contribute text nodes.
    for (const name of $getSlotNames(this)) {
      const slot = $getSlot(this, name);
      if ($isElementNode(slot)) {
        textNodes.push(...slot.getAllTextNodes());
      }
    }
    let child: LexicalNode | null = this.getFirstChild();
    while (child !== null) {
      if ($isTextNode(child)) {
        textNodes.push(child);
      }
      if ($isElementNode(child)) {
        const subChildrenNodes = child.getAllTextNodes();
        textNodes.push(...subChildrenNodes);
      }
      child = child.getNextSibling();
    }
    return textNodes;
  }
  /**
   * Returns the deepest first descendant of this node,
   * or null if it has no children.
   *
   * Descendant navigation is children-only by design: it feeds selectStart /
   * selectEnd and selection, which must not see slots (slots are isolated).
   */
  getFirstDescendant(): null | LexicalNode;
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `element.getFirstDescendant() as T | null`, and will be
   * removed in a future release. Call this method without a type argument
   * and narrow the result with a type guard instead.
   */
  getFirstDescendant<T extends LexicalNode>(): null | T;
  getFirstDescendant(): null | LexicalNode {
    let node = this.getFirstChild();
    while ($isElementNode(node)) {
      const child = node.getFirstChild();
      if (child === null) {
        break;
      }
      node = child;
    }
    return node;
  }
  /**
   * Returns the deepest last descendant of this node,
   * or null if it has no children.
   */
  getLastDescendant(): null | LexicalNode;
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `element.getLastDescendant() as T | null`, and will be
   * removed in a future release. Call this method without a type argument
   * and narrow the result with a type guard instead.
   */
  getLastDescendant<T extends LexicalNode>(): null | T;
  getLastDescendant(): null | LexicalNode {
    let node = this.getLastChild();
    while ($isElementNode(node)) {
      const child = node.getLastChild();
      if (child === null) {
        break;
      }
      node = child;
    }
    return node;
  }
  /**
   * Returns the deepest descendant corresponding to the child at the given
   * index, or null if this node has no children.
   */
  getDescendantByIndex(index: number): null | LexicalNode;
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `element.getDescendantByIndex(index) as T | null`, and
   * will be removed in a future release. Call this method without a type
   * argument and narrow the result with a type guard instead.
   */
  getDescendantByIndex<T extends LexicalNode>(index: number): null | T;
  getDescendantByIndex(index: number): null | LexicalNode {
    const children = this.getChildren();
    const childrenLength = children.length;
    // For non-empty element nodes, we resolve its descendant
    // (either a leaf node or the bottom-most element)
    if (index >= childrenLength) {
      const resolvedNode = children[childrenLength - 1];
      return (
        ($isElementNode(resolvedNode) && resolvedNode.getLastDescendant()) ||
        resolvedNode ||
        null
      );
    }
    const resolvedNode = children[index];
    return (
      ($isElementNode(resolvedNode) && resolvedNode.getFirstDescendant()) ||
      resolvedNode ||
      null
    );
  }
  /**
   * Returns the first child of this node, or null if it has no children.
   */
  getFirstChild(): null | LexicalNode;
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `element.getFirstChild() as T | null`, and will be
   * removed in a future release. Call this method without a type argument
   * and narrow the result with a type guard instead.
   */
  getFirstChild<T extends LexicalNode>(): null | T;
  getFirstChild(): null | LexicalNode {
    const self = this.getLatest();
    const firstKey = self.__first;
    return firstKey === null ? null : $getNodeByKey(firstKey);
  }
  /**
   * Returns the first child of this node, or throws if it has no children.
   */
  getFirstChildOrThrow(): LexicalNode;
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `element.getFirstChildOrThrow() as T`, and will be
   * removed in a future release. Call this method without a type argument
   * and narrow the result with a type guard instead.
   */
  getFirstChildOrThrow<T extends LexicalNode>(): T;
  getFirstChildOrThrow(): LexicalNode {
    const firstChild = this.getFirstChild();
    if (firstChild === null) {
      invariant(false, 'Expected node %s to have a first child.', this.__key);
    }
    return firstChild;
  }
  /**
   * Returns the last child of this node, or null if it has no children.
   */
  getLastChild(): null | LexicalNode;
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `element.getLastChild() as T | null`, and will be
   * removed in a future release. Call this method without a type argument
   * and narrow the result with a type guard instead.
   */
  getLastChild<T extends LexicalNode>(): null | T;
  getLastChild(): null | LexicalNode {
    const self = this.getLatest();
    const lastKey = self.__last;
    return lastKey === null ? null : $getNodeByKey(lastKey);
  }
  /**
   * Returns the last child of this node, or throws if it has no children.
   */
  getLastChildOrThrow(): LexicalNode;
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `element.getLastChildOrThrow() as T`, and will be
   * removed in a future release. Call this method without a type argument
   * and narrow the result with a type guard instead.
   */
  getLastChildOrThrow<T extends LexicalNode>(): T;
  getLastChildOrThrow(): LexicalNode {
    const lastChild = this.getLastChild();
    if (lastChild === null) {
      invariant(false, 'Expected node %s to have a last child.', this.__key);
    }
    return lastChild;
  }
  /**
   * Returns the child of this node at the given index, or null if
   * the index is out of range.
   */
  getChildAtIndex(index: number): null | LexicalNode;
  /**
   * @deprecated The type parameter is an unchecked and unsafe cast,
   * equivalent to `element.getChildAtIndex(index) as T | null`, and will
   * be removed in a future release. Call this method without a type
   * argument and narrow the result with a type guard instead.
   */
  getChildAtIndex<T extends LexicalNode>(index: number): null | T;
  getChildAtIndex(index: number): null | LexicalNode {
    const size = this.getChildrenSize();
    let node: null | LexicalNode;
    let i;
    if (index < size / 2) {
      node = this.getFirstChild();
      i = 0;
      while (node !== null && i <= index) {
        if (i === index) {
          return node;
        }
        node = node.getNextSibling();
        i++;
      }
      return null;
    }
    node = this.getLastChild();
    i = size - 1;
    while (node !== null && i >= index) {
      if (i === index) {
        return node;
      }
      node = node.getPreviousSibling();
      i--;
    }
    return null;
  }
  getTextContent(): string {
    // Slots are read slots-first, ahead of the linked-list children.
    let textContent = $getSlotsTextContent(this);
    const children = this.getChildren();
    const childrenLength = children.length;
    for (let i = 0; i < childrenLength; i++) {
      const child = children[i];
      textContent += child.getTextContent();
      if (
        // this is an inline $textContentRequiresDoubleLinebreakAtEnd(child)
        $isElementNode(child) &&
        i !== childrenLength - 1 &&
        !child.isInline()
      ) {
        textContent += DOUBLE_LINE_BREAK;
      }
    }
    return textContent;
  }
  getTextContentSize(): number {
    // Slots are counted slots-first, ahead of the linked-list children.
    let textContentSize = $getSlotsTextContentSize(this);
    const children = this.getChildren();
    const childrenLength = children.length;
    for (let i = 0; i < childrenLength; i++) {
      const child = children[i];
      textContentSize += child.getTextContentSize();
      if (
        // This is an inline $textContentRequiresDoubleLinebreakAtEnd(child)
        $isElementNode(child) &&
        i !== childrenLength - 1 &&
        !child.isInline()
      ) {
        textContentSize += DOUBLE_LINE_BREAK.length;
      }
    }
    return textContentSize;
  }
  getDirection(): 'ltr' | 'rtl' | null {
    const self = this.getLatest();
    return self.__dir;
  }
  getTextFormat(): number {
    const self = this.getLatest();
    return self.__textFormat;
  }
  hasFormat(type: ElementFormatType): boolean {
    if (type !== '') {
      const formatFlag = ELEMENT_TYPE_TO_FORMAT[type];
      return (this.getFormat() & formatFlag) !== 0;
    }
    return false;
  }
  hasTextFormat(type: TextFormatType): boolean {
    const formatFlag = TEXT_TYPE_TO_FORMAT[type];
    return (this.getTextFormat() & formatFlag) !== 0;
  }
  /**
   * Returns the format flags applied to the node as a 32-bit integer.
   *
   * @returns a number representing the TextFormatTypes applied to the node.
   */
  getFormatFlags(type: TextFormatType, alignWithFormat: null | number): number {
    const self = this.getLatest();
    const format = self.__textFormat;
    return toggleTextFormatType(format, type, alignWithFormat);
  }

  getTextStyle(): string {
    const self = this.getLatest();
    return self.__textStyle;
  }

  // Mutators

  select(_anchorOffset?: number, _focusOffset?: number): RangeSelection {
    errorOnReadOnly();
    const selection = $getSelection();
    let anchorOffset = _anchorOffset;
    let focusOffset = _focusOffset;
    const childrenCount = this.getChildrenSize();
    if (!this.canBeEmpty()) {
      if (_anchorOffset === 0 && _focusOffset === 0) {
        const firstChild = this.getFirstChild();
        if ($isTextNode(firstChild) || $isElementNode(firstChild)) {
          return firstChild.select(0, 0);
        }
      } else if (
        (_anchorOffset === undefined || _anchorOffset === childrenCount) &&
        (_focusOffset === undefined || _focusOffset === childrenCount)
      ) {
        const lastChild = this.getLastChild();
        if ($isTextNode(lastChild) || $isElementNode(lastChild)) {
          return lastChild.select();
        }
      }
    }
    if (anchorOffset === undefined) {
      anchorOffset = childrenCount;
    }
    if (focusOffset === undefined) {
      focusOffset = childrenCount;
    }
    const key = this.__key;
    if (!$isRangeSelection(selection)) {
      return $internalMakeRangeSelection(
        key,
        anchorOffset,
        key,
        focusOffset,
        'element',
        'element',
      );
    } else {
      selection.anchor.set(key, anchorOffset, 'element');
      selection.focus.set(key, focusOffset, 'element');
      selection.dirty = true;
    }
    return selection;
  }
  selectStart(): RangeSelection {
    const firstNode = this.getFirstDescendant();
    return firstNode ? firstNode.selectStart() : this.select();
  }
  selectEnd(): RangeSelection {
    const lastNode = this.getLastDescendant();
    return lastNode ? lastNode.selectEnd() : this.select();
  }
  clear(): this {
    const writableSelf = this.getWritable();
    const children = this.getChildren();
    children.forEach(child => child.remove());
    return writableSelf;
  }
  append(...nodesToAppend: LexicalNode[]): this {
    return this.splice(this.getChildrenSize(), 0, nodesToAppend);
  }
  setDirection(direction: 'ltr' | 'rtl' | null): this {
    const self = this.getWritable();
    self.__dir = direction;
    return self;
  }
  setFormat(type: ElementFormatType): this {
    const self = this.getWritable();
    self.__format = type !== '' ? ELEMENT_TYPE_TO_FORMAT[type] || 0 : 0;
    return this;
  }
  setStyle(style: string): this {
    const self = this.getWritable();
    self.__style = style || '';
    return this;
  }
  setTextFormat(type: number): this {
    const self = this.getWritable();
    self.__textFormat = type;
    return self;
  }
  setTextStyle(style: string): this {
    const self = this.getWritable();
    self.__textStyle = style;
    return self;
  }
  setIndent(indentLevel: number): this {
    const self = this.getWritable();
    self.__indent = indentLevel;
    return this;
  }
  splice(
    start: number,
    deleteCount: number,
    nodesToInsert: LexicalNode[],
  ): this {
    invariant(
      !$isEphemeral(this),
      'ElementNode.splice: Ephemeral nodes can not mutate their children (key %s type %s)',
      this.__key,
      this.__type,
    );
    const oldSize = this.getChildrenSize();
    const writableSelf = this.getWritable();
    invariant(
      start + deleteCount <= oldSize,
      'ElementNode.splice: start + deleteCount > oldSize (%s + %s > %s)',
      String(start),
      String(deleteCount),
      String(oldSize),
    );
    // Before any mutation: a child insertion must not close a cycle through a
    // slot up-link (the reverse direction of $setSlot's cycle invariant).
    for (const nodeToInsert of nodesToInsert) {
      $errorOnSlotCycleChild(writableSelf, nodeToInsert);
    }
    const writableSelfKey = writableSelf.__key;
    const nodesToInsertKeys = [];
    const nodesToRemoveKeys = [];
    let nodeAfterRange = this.getChildAtIndex(start + deleteCount);
    let nodeBeforeRange = null;
    let newSize = oldSize - deleteCount + nodesToInsert.length;

    if (start !== 0) {
      if (start === oldSize) {
        nodeBeforeRange = this.getLastChild();
      } else {
        const node = this.getChildAtIndex(start);
        if (node !== null) {
          nodeBeforeRange = node.getPreviousSibling();
        }
      }
    }

    if (deleteCount > 0) {
      let nodeToDelete =
        nodeBeforeRange === null
          ? this.getFirstChild()
          : nodeBeforeRange.getNextSibling();
      for (let i = 0; i < deleteCount; i++) {
        if (nodeToDelete === null) {
          invariant(false, 'splice: sibling not found');
        }
        const nextSibling = nodeToDelete.getNextSibling();
        const nodeKeyToDelete = nodeToDelete.__key;
        const writableNodeToDelete = nodeToDelete.getWritable();
        $removeFromParent(writableNodeToDelete);
        nodesToRemoveKeys.push(nodeKeyToDelete);
        nodeToDelete = nextSibling;
      }
    }

    let prevNode = nodeBeforeRange;
    for (const nodeToInsert of nodesToInsert) {
      if (prevNode !== null && nodeToInsert.is(prevNode)) {
        nodeBeforeRange = prevNode = prevNode.getPreviousSibling();
      }
      if (nodeAfterRange !== null && nodeToInsert.is(nodeAfterRange)) {
        nodeAfterRange = nodeAfterRange.getNextSibling();
      }
      const writableNodeToInsert = nodeToInsert.getWritable();
      if (writableNodeToInsert.__parent === writableSelfKey) {
        newSize--;
      }
      $removeFromParent(writableNodeToInsert);
      const nodeKeyToInsert = nodeToInsert.__key;
      if (prevNode === null) {
        writableSelf.__first = nodeKeyToInsert;
        writableNodeToInsert.__prev = null;
      } else {
        const writablePrevNode = prevNode.getWritable();
        writablePrevNode.__next = nodeKeyToInsert;
        writableNodeToInsert.__prev = writablePrevNode.__key;
      }
      if (nodeToInsert.__key === writableSelfKey) {
        invariant(false, 'append: attempting to append self');
      }
      // Set child parent to self
      writableNodeToInsert.__parent = writableSelfKey;
      nodesToInsertKeys.push(nodeKeyToInsert);
      prevNode = nodeToInsert;
    }

    if (nodeAfterRange === null) {
      if (prevNode !== null) {
        const writablePrevNode = prevNode.getWritable();
        writablePrevNode.__next = null;
        writableSelf.__last = prevNode.__key;
      }
    } else {
      const writableNodeAfterRange = nodeAfterRange.getWritable();
      if (prevNode !== null) {
        const writablePrevNode = prevNode.getWritable();
        writableNodeAfterRange.__prev = prevNode.__key;
        writablePrevNode.__next = nodeAfterRange.__key;
      } else {
        writableNodeAfterRange.__prev = null;
      }
    }

    writableSelf.__size = newSize;

    // In case of deletion we need to adjust selection, unlink removed nodes
    // and clean up node itself if it becomes empty. None of these needed
    // for insertion-only cases
    if (nodesToRemoveKeys.length) {
      // Adjusting selection, in case node that was anchor/focus will be deleted
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        const nodesToRemoveKeySet = new Set(nodesToRemoveKeys);
        const nodesToInsertKeySet = new Set(nodesToInsertKeys);

        const {anchor, focus} = selection;
        if (isPointRemoved(anchor, nodesToRemoveKeySet, nodesToInsertKeySet)) {
          moveSelectionPointToSibling(
            anchor,
            anchor.getNode(),
            this,
            nodeBeforeRange,
            nodeAfterRange,
          );
        }
        if (isPointRemoved(focus, nodesToRemoveKeySet, nodesToInsertKeySet)) {
          moveSelectionPointToSibling(
            focus,
            focus.getNode(),
            this,
            nodeBeforeRange,
            nodeAfterRange,
          );
        }
        // Cleanup if node can't be empty
        if (newSize === 0 && !this.canBeEmpty() && !$isRootOrShadowRoot(this)) {
          this.remove();
        }
      }
    }

    return writableSelf;
  }
  /**
   * @experimental
   *
   * An ElementNode subclass can override this to control where its children
   * are inserted into the DOM, e.g. to add a wrapping node or accessory nodes
   * before or after the children. The root of the node returned by createDOM
   * must still be exactly one HTMLElement.
   */
  getDOMSlot(element: HTMLElement): ElementDOMSlot<HTMLElement> {
    return new ElementDOMSlot(element);
  }
  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const {element} = super.exportDOM(editor);
    if (isHTMLElement(element)) {
      const indent = this.getIndent();
      if (indent > 0) {
        // padding-inline-start is not widely supported in email HTML
        // (see https://www.caniemail.com/features/css-padding-inline-start-end/),
        // If you want to use HTML output for email, consider overriding the serialization
        // to use `padding-right` in RTL languages, `padding-left` in `LTR` languages, or
        // `text-indent` if you are ok with first-line indents.
        // We recommend keeping multiples of 40px to maintain consistency with list-items
        // (see https://github.com/facebook/lexical/pull/4025)
        element.style.paddingInlineStart = `${indent * 40}px`;
        // Authoritative round-trip signal. padding-inline-start can be a
        // non-40px multiple (custom `--lexical-indent-base-value`) or a
        // `calc(...)` expression on the live DOM, neither of which the
        // padding-based heuristic in setNodeIndentFromDOM can recover.
        element.setAttribute('data-lexical-indent', String(indent));
      }
      const direction = this.getDirection();
      if (direction) {
        element.dir = direction;
      }
    }

    return {element};
  }
  // JSON serialization
  exportJSON(): SerializedElementNode {
    const json: SerializedElementNode = {
      children: [],
      direction: this.getDirection(),
      format: this.getFormatType(),
      indent: this.getIndent(),
      // As an exception here we invoke super at the end for historical reasons.
      // Namely, to preserve the order of the properties and not to break the tests
      // that use the serialized string representation.
      ...super.exportJSON(),
    };
    const textFormat = this.getTextFormat();
    const textStyle = this.getTextStyle();
    // Only persist for cases when there are no TextNode children from which
    // these would be set on reconcile (#7968)
    if (
      (textFormat !== 0 || textStyle !== '') &&
      !$isRootOrShadowRoot(this) &&
      !this.getChildren().some($isTextNode)
    ) {
      if (textFormat !== 0) {
        json.textFormat = textFormat;
      }
      if (textStyle !== '') {
        json.textStyle = textStyle;
      }
    }
    return json;
  }
  updateFromJSON(
    serializedNode: LexicalUpdateJSON<SerializedElementNode>,
  ): this {
    return super
      .updateFromJSON(serializedNode)
      .setFormat(serializedNode.format)
      .setIndent(serializedNode.indent)
      .setDirection(serializedNode.direction)
      .setTextFormat(serializedNode.textFormat || 0)
      .setTextStyle(serializedNode.textStyle || '');
  }
  // These are intended to be extends for specific element heuristics.
  insertNewAfter(
    selection: RangeSelection,
    restoreSelection?: boolean,
  ): null | LexicalNode {
    return null;
  }
  canIndent(): boolean {
    return true;
  }
  /*
   * This method controls the behavior of the node during backwards
   * deletion (i.e., backspace) when selection is at the beginning of
   * the node (offset 0). You may use this to have the node replace
   * itself, change its state, or do nothing. When you do make such
   * a change, you should return true.
   *
   * When true is returned, the collapse phase will stop.
   * When false is returned, and isInline() is true, and getPreviousSibling() is null,
   * then this function will be called on its parent.
   */
  collapseAtStart(selection: RangeSelection): boolean {
    return false;
  }
  excludeFromCopy(destination?: 'clone' | 'html'): boolean {
    return false;
  }
  /** @deprecated @internal */
  canReplaceWith(replacement: LexicalNode): boolean {
    return true;
  }
  /** @deprecated @internal */
  canInsertAfter(node: LexicalNode): boolean {
    return true;
  }
  canBeEmpty(): boolean {
    return true;
  }
  canInsertTextBefore(): boolean {
    return true;
  }
  canInsertTextAfter(): boolean {
    return true;
  }

  /**
   * If the method is overridden and returns true, ensure that `canBeEmpty()`
   * returns false for the inline node to work correctly
   */
  isInline(): boolean {
    return false;
  }
  // A shadow root is a Node that behaves like RootNode. The shadow root (and RootNode) mark the
  // end of the hierarchy, most implementations should treat it as there's nothing (upwards)
  // beyond this point. For example, node.getTopLevelElement(), when performed inside a TableCellNode
  // will return the immediate first child underneath TableCellNode instead of RootNode.
  isShadowRoot(): boolean {
    return false;
  }
  /** @deprecated @internal */
  canMergeWith(node: ElementNode): boolean {
    return false;
  }
  extractWithChild(
    child: LexicalNode,
    selection: BaseSelection | null,
    destination: 'clone' | 'html',
  ): boolean {
    return false;
  }

  /**
   * Determines whether this node, when empty, can merge with a first block
   * of nodes being inserted.
   *
   * This method is specifically called in {@link RangeSelection.insertNodes}
   * to determine merging behavior during nodes insertion.
   *
   * @example
   * // In a ListItemNode or QuoteNode implementation:
   * canMergeWhenEmpty(): true {
   *  return true;
   * }
   */
  canMergeWhenEmpty(): boolean {
    return false;
  }

  /** @internal */
  reconcileObservedMutation(dom: HTMLElement, editor: LexicalEditor): void {
    const slot = $getDOMSlot(this, dom, editor);
    let currentDOM = slot.getFirstChild();
    for (
      let currentNode = this.getFirstChild();
      currentNode;
      currentNode = currentNode.getNextSibling()
    ) {
      const correctDOM = editor.getElementByKey(currentNode.getKey());

      if (correctDOM === null) {
        continue;
      }

      if (currentDOM == null) {
        slot.insertChild(correctDOM);
        currentDOM = correctDOM;
      } else if (currentDOM !== correctDOM) {
        slot.replaceChild(correctDOM, currentDOM);
      }

      currentDOM = currentDOM.nextSibling;
    }
  }
}

/** Returns true if the given node is an ElementNode. */
export function $isElementNode(
  node: LexicalNode | null | undefined,
): node is ElementNode {
  return node instanceof ElementNode;
}

function isPointRemoved(
  point: PointType,
  nodesToRemoveKeySet: Set<NodeKey>,
  nodesToInsertKeySet: Set<NodeKey>,
): boolean {
  let node: ElementNode | TextNode | null = point.getNode();
  while (node) {
    const nodeKey = node.__key;
    if (nodesToRemoveKeySet.has(nodeKey) && !nodesToInsertKeySet.has(nodeKey)) {
      return true;
    }
    node = node.getParent();
  }
  return false;
}
