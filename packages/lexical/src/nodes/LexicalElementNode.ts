/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  KlassConstructor,
  LexicalEditor,
  Spread,
  TextFormatType,
} from 'lexical';

import invariant from '@lexical/internal/invariant';

import {
  $collectSiblingNodes,
  $detachNode,
  $detachSiblingRange,
  $insertNodeBetween,
} from '../caret/LexicalCaretTree';
import {$isTextNode, type TextNode} from '../index';
import {
  DOUBLE_LINE_BREAK,
  ELEMENT_FORMAT_TO_TYPE,
  ELEMENT_TYPE_TO_FORMAT,
  TEXT_TYPE_TO_FORMAT,
} from '../LexicalConstants';
import {ElementDOMSlot} from '../LexicalDOMSlot';
import {
  afterCloneElementNode,
  GENERATED_ELEMENT,
} from '../LexicalGeneratedJSON';
import {
  $isEphemeral,
  type DOMExportOutput,
  LexicalNode,
  type LexicalParseJSON,
  type NodeKey,
  type SerializedLexicalNode,
  type SerializedPartial,
  type SlotChildNode,
  type SlotHostNode,
} from '../LexicalNode';
import {$reconcileDecoratorBoundaryAnchors} from '../LexicalReconciler';
import {
  enumValue,
  nodeSchema,
  numberValue,
  stringValue,
  withAccessors,
  withField,
} from '../LexicalSchema';
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
import {INTERNAL_isNodeStructureEnforced} from '../LexicalStructure';
import {errorOnReadOnly, getActiveEditor} from '../LexicalUpdates';
import {
  $getDOMSlot,
  $getNodeByKey,
  $getTextInsideCache,
  $isRootOrShadowRoot,
  getNodeKeyFromDOMNode,
  isDOMUnmanaged,
  isHTMLElement,
  toggleTextFormatType,
} from '../LexicalUtils';

/**
 * No type parameter for the children: a node cannot declare what kind of
 * children it accepts, so any node may appear under any element and
 * `SerializedLexicalNode` is the only type this can honestly give them. The
 * parameter that used to be here promised a narrowing nothing enforces.
 */
export type SerializedElementNode = Spread<
  {
    children: SerializedLexicalNode[];
    direction: 'ltr' | 'rtl' | null;
    format: ElementFormatType;
    indent: number;
    textFormat?: number;
    textStyle?: string;
  },
  SerializedLexicalNode
>;

// Single source of truth for parsing the node-specific properties of a
// SerializedElementNode (those it adds over a SerializedLexicalNode), applied
/**
 * The serialized `format` and the flag it is stored as, in both directions.
 *
 * `''` is the absence of an alignment, stored as 0, and neither constant
 * carries that pair: `getFormatType` spells it as `|| ''` and `setFormat` as
 * `type !== '' ? … : 0`. A lookup table has no fallback to spell it with, so
 * it is an entry here — and having it as an entry is what lets the schema
 * reach the field instead of the accessors.
 *
 * One function per table, each assigned to a plain `const`: a destructuring
 * pattern is not something a bundler will drop, however pure the call feeding
 * it is, so the pair came back in every bundle that imported this module.
 *
 * @__NO_SIDE_EFFECTS__
 */
function formatGetterTable(): Record<number, ElementFormatType> {
  return {...ELEMENT_FORMAT_TO_TYPE, 0: ''};
}

/** @__NO_SIDE_EFFECTS__ */
function formatSetterTable(): Record<ElementFormatType, number> {
  return {...ELEMENT_TYPE_TO_FORMAT, '': 0};
}

const FORMAT_GETTER_TABLE = formatGetterTable();
const FORMAT_SETTER_TABLE = formatSetterTable();

// by the base LexicalNode.updateFromJSON.
const elementNodeSchema = nodeSchema<ElementNode>()({
  // `direction` and `indent` *are* these fields in both directions —
  // get/setDirection and get/setIndent do nothing else — so they are declared
  // as the fields they are. Each still stands in for the conventional
  // accessor, so a subclass that overrides one reclaims its property (see
  // SchemaFieldBase.method).
  direction: withField(enumValue([null, 'ltr', 'rtl']), {
    field: '__dir',
  }),
  // The serialized `format` is the ElementFormatType string, not the numeric
  // format getFormat() returns — which is the whole of what `getFormatType`
  // and `setFormat` do, so the schema does it instead and reads and writes
  // `__format` directly. Both accessors are still named: the conventional
  // `getFormat` a field would otherwise stand in for returns the flag, not the
  // string, so the read has to say which accessor it means.
  format: withField(
    enumValue(['', 'left', 'start', 'center', 'right', 'end', 'justify']),
    {
      field: '__format',
      getter: 'getFormatType',
      getterTable: FORMAT_GETTER_TABLE,
      setter: 'setFormat',
      setterTable: FORMAT_SETTER_TABLE,
    },
  ),
  // A whole, non-negative number. That is the domain an indent has always
  // had — every writer of one is an indent/outdent step — but nothing used to
  // check it: `ElementNode.setIndent` is a bare field write, so a fractional
  // or negative value in a document was stored verbatim rather than rejected.
  // Stating the domain is what makes such a value parse to 0 instead.
  // Deliberately not capped —
  // `numberValue` falls back to its default rather than clamping, so a maximum
  // here would silently flatten a legitimately deep document to indent 0. The
  // unbounded walk that motivated a cap is ListItemNode.setIndent's, and it is
  // bounded there.
  indent: withField(numberValue(0, {integer: true, min: 0}), {
    field: '__indent',
  }),
  // Persisted only for an element with no text to derive them from (see
  // #7968), which `shouldSerializeTextStyles` decides. Declaring that as the field it is
  // plus the predicate that gates it — rather than reading through
  // `getSerializedTextFormat`/`getSerializedTextStyle` — keeps both on the
  // direct-field path, and lets generated code call the shared predicate once
  // instead of once per property.
  //
  // Naming the wrapper keeps a subclass in charge of its own property: an
  // override of it, or of the `getTextFormat`/`getTextStyle` it computes from
  // — the accessors `exportJSON` read before this schema existed, and the ones
  // a subclass would reach for — abandons the field and calls the wrapper.
  //
  // The write is the field too. `setTextFormat`/`setTextStyle` are bare field
  // writes, so naming them is naming the field; each still stands in for its
  // conventional setter, so a subclass that overrides one reclaims the
  // property on the way in as it does on the way out.
  textFormat: withAccessors(numberValue(), {
    getter: {
      field: '__textFormat',
      method: 'getSerializedTextFormat',
      when: 'shouldSerializeTextStyles',
    },
    setter: {field: '__textFormat'},
  }),
  textStyle: withAccessors(stringValue(), {
    getter: {
      field: '__textStyle',
      method: 'getSerializedTextStyle',
      when: 'shouldSerializeTextStyles',
    },
    setter: {field: '__textStyle'},
  }),
});

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
  // Where NodeStructureExtension enforces declared structure, it wraps these
  // children itself (a root or shadow root holds blocks), after their own
  // repairs: an empty inline element it removes is then never wrapped, which
  // it would be here if this transform ran first.
  if (
    $isRootOrShadowRoot(node) &&
    !INTERNAL_isNodeStructureEnforced(getActiveEditor())
  ) {
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
  exportJSON(compact?: false): SerializedElementNode;
  exportJSON(compact: boolean): SerializedPartial<SerializedElementNode>;
  updateFromJSON(serializedNode: LexicalParseJSON<SerializedElementNode>): this;
  // Both JSON methods are narrowed here rather than overridden: the base
  // implementations already do the right thing for an element — they read
  // elementNodeSchema above, and the base export leads with `children` for
  // anything that passes $isElementNode — so all a real override would
  // contribute is this return type.
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

  // Left to inference rather than annotated `: BaseStaticNodeConfig`. The
  // annotation discarded the record, and with it every element's schema — what
  // `LexicalSchemaInput` walks to compose the properties a node accepts. The
  // cost is that a subclass overriding `$config()` has to name its `extends`,
  // which is the convention every config in the tree already follows.
  $config() {
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
      generated: GENERATED_ELEMENT,
      json: elementNodeSchema,
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

  // Written rather than synthesized from the schema: an element's children
  // and its slot bookkeeping are structure, not serialized properties, so no
  // schema describes where they live. The key test is the other half of that —
  // a clone under a *new* key is a copy of the node, not of its place in the
  // tree, and must not adopt the original's children.
  //
  // Declaring one of these takes the class out of the synthesized
  // `afterCloneFrom` entirely, so the schema's own fields are this method's
  // responsibility too — but not its boilerplate: `afterCloneElementNode` is
  // generated from the same declaration, so adding a property to the schema
  // needs no line here.
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
    // `__style` is not serialized at all, so no schema names it.
    this.__style = prevNode.__style;
    // The five the schema does name: `__dir`, `__format`, `__indent`,
    // `__textFormat` and `__textStyle`.
    afterCloneElementNode(this, prevNode);
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
  getChildren(): LexicalNode[] {
    return $collectSiblingNodes(this.getFirstChild(), 'next');
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
    // Concatenated with a loop rather than push(...spread): one argument per
    // text node overflows the call stack on a document with enough of them.
    for (const name of $getSlotNames(this)) {
      const slot = $getSlot(this, name);
      if ($isElementNode(slot)) {
        for (const textNode of slot.getAllTextNodes()) {
          textNodes.push(textNode);
        }
      }
    }
    let child: LexicalNode | null = this.getFirstChild();
    while (child !== null) {
      if ($isTextNode(child)) {
        textNodes.push(child);
      }
      if ($isElementNode(child)) {
        for (const textNode of child.getAllTextNodes()) {
          textNodes.push(textNode);
        }
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
  getDescendantByIndex(index: number): null | LexicalNode {
    const atEnd = index >= this.getChildrenSize();
    const child = atEnd ? this.getLastChild() : this.getChildAtIndex(index);
    return (
      ($isElementNode(child) &&
        (atEnd ? child.getLastDescendant() : child.getFirstDescendant())) ||
      child
    );
  }
  /**
   * Returns the first child of this node, or null if it has no children.
   */
  getFirstChild(): null | LexicalNode {
    const self = this.getLatest();
    const firstKey = self.__first;
    return firstKey === null ? null : $getNodeByKey(firstKey);
  }
  /**
   * Returns the first child of this node, or throws if it has no children.
   */
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
  getLastChild(): null | LexicalNode {
    const self = this.getLatest();
    const lastKey = self.__last;
    return lastKey === null ? null : $getNodeByKey(lastKey);
  }
  /**
   * Returns the last child of this node, or throws if it has no children.
   */
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
    // NOTE: This implementation will be delegated to
    // LexicalNode.prototype.getTextContentSize when getTextContent is overridden
    // without a corresponding override to this method
    //
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
    return self;
  }
  setStyle(style: string): this {
    const self = this.getWritable();
    self.__style = style || '';
    return self;
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
    return self;
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
    let nodesToRemoveKeys: NodeKey[] = [];
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
      nodesToRemoveKeys = $detachSiblingRange(
        writableSelf,
        nodeBeforeRange === null
          ? this.getFirstChild()
          : nodeBeforeRange.getNextSibling(),
        deleteCount,
        nodeBeforeRange,
      );
    }

    // Retain the writable insertion tail instead of dirtying it again for
    // every child. No boundary needs to be writable for a deletion-only splice.
    let writablePrevNode =
      nodesToInsert.length > 0 && nodeBeforeRange !== null
        ? nodeBeforeRange.getWritable()
        : null;
    for (const nodeToInsert of nodesToInsert) {
      if (writablePrevNode !== null && nodeToInsert.is(writablePrevNode)) {
        nodeBeforeRange = writablePrevNode.getPreviousSibling();
        writablePrevNode = nodeBeforeRange && nodeBeforeRange.getWritable();
      }
      if (nodeAfterRange !== null && nodeToInsert.is(nodeAfterRange)) {
        nodeAfterRange = nodeAfterRange.getNextSibling();
      }
      const writableNodeToInsert = nodeToInsert.getWritable();
      if (writableNodeToInsert.__parent === writableSelfKey) {
        newSize--;
      }
      $detachNode(writableNodeToInsert);
      const nodeKeyToInsert = nodeToInsert.__key;
      // Keep both links valid before detaching the next insertion. It may be
      // nodeAfterRange, whose previous sibling must now be this inserted node.
      $insertNodeBetween(
        writableSelf,
        writableNodeToInsert,
        writablePrevNode,
        nodeAfterRange && nodeAfterRange.getWritable(),
      );
      if (nodeToInsert.__key === writableSelfKey) {
        invariant(false, 'append: attempting to append self');
      }
      nodesToInsertKeys.push(nodeKeyToInsert);
      writablePrevNode = writableNodeToInsert;
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

        for (const point of [selection.anchor, selection.focus]) {
          if (isPointRemoved(point, nodesToRemoveKeySet, nodesToInsertKeySet)) {
            moveSelectionPointToSibling(
              point,
              point.getNode(),
              this,
              nodeBeforeRange,
              nodeAfterRange,
            );
          }
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
        // (see https://github.com/meta/lexical/pull/4025)
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
  /**
   * Whether `textFormat`/`textStyle` are persisted at all: only when there is
   * no text from which they would be set on reconcile (#7968). That is a
   * TextNode child, and for an inline element (a link, a mark) a TextNode
   * anywhere inside it (a mark in a link), whose first text a reconcile takes
   * them from as well. A block keeps the direct-children check, so its JSON
   * is unchanged.
   *
   * @internal
   */
  shouldSerializeTextStyles(): boolean {
    if ($isRootOrShadowRoot(this)) {
      return false;
    }
    return !$hasTextChild(this, this.isInline());
  }

  /** @internal Serialized `textFormat`, or undefined to omit it. */
  getSerializedTextFormat(): number | undefined {
    const textFormat = this.getTextFormat();
    return textFormat !== 0 && this.shouldSerializeTextStyles()
      ? textFormat
      : undefined;
  }

  /** @internal Serialized `textStyle`, or undefined to omit it. */
  getSerializedTextStyle(): string | undefined {
    const textStyle = this.getTextStyle();
    return textStyle !== '' && this.shouldSerializeTextStyles()
      ? textStyle
      : undefined;
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
    // Put back the children of the committed state: they are what is on
    // screen, and what the reconciler diffs the DOM against when this runs
    // inside an update (onInput) that has already changed them.
    editor.read('latest', () => {
      let slot = $getDOMSlot(this, dom, editor);
      const element = slot.element;
      // The edit may have removed a boundary that the slot still names.
      if (slot.after && slot.after.parentNode !== element) {
        slot = slot.withAfter(null);
      }
      if (slot.before && slot.before.parentNode !== element) {
        slot = slot.withBefore(null);
      }
      // Put the managed line break back where the reconciler would if the
      // edit removed or moved a node of it.
      const lineBreak = slot.getManagedLineBreak();
      if (lineBreak) {
        slot.insertManagedLineBreak(lineBreak.nodeName === 'IMG');
      }
      let currentDOM = slot.getFirstChild();
      for (const key of this.getChildrenKeys()) {
        const correctDOM = editor.getElementByKey(key);

        if (!correctDOM) {
          continue;
        }

        // Only move children into place, never replace a node. DOM an
        // extension keeps among the children (keyless, marked with
        // setDOMUnmanaged) stays ahead of the child that follows it; a
        // child with no such follower goes before that DOM, so DOM at the
        // end stays at the end.
        let nextDOM = currentDOM;
        let nextKey: NodeKey | undefined;
        while (
          nextDOM &&
          !(nextKey = getNodeKeyFromDOMNode(nextDOM, editor)) &&
          isDOMUnmanaged(nextDOM)
        ) {
          nextDOM = nextDOM.nextSibling;
        }
        if (nextDOM !== correctDOM) {
          element.insertBefore(
            correctDOM,
            nextKey ? nextDOM : currentDOM || slot.getInsertionAnchor(),
          );
        }
        currentDOM = correctDOM.nextSibling;
      }
      $reconcileDecoratorBoundaryAnchors(this, dom, slot);
    });
  }
}

/** Returns true if the given node is an ElementNode. */
export function $isElementNode(
  node: LexicalNode | null | undefined,
): node is ElementNode {
  return node instanceof ElementNode;
}

/**
 * Whether `element` has a TextNode child or, when `deep`, a TextNode at any
 * depth inside it. Walked rather than materialized with getChildren(), and it
 * exits at the first TextNode. Both callers of shouldSerializeTextStyles test
 * their own value first, so an element with a default textFormat/textStyle
 * (every element that has many non-text children in practice) never reaches
 * this at all.
 */
function $hasTextChild(element: ElementNode, deep: boolean): boolean {
  if (deep) {
    return $hasTextInside(element, $getTextInsideCache());
  }
  for (
    let child = element.getFirstChild();
    child !== null;
    child = child.getNextSibling()
  ) {
    if ($isTextNode(child)) {
      return true;
    }
  }
  return false;
}

/**
 * $hasTextChild's deep walk; with a cache (see $getTextInsideCache), every
 * element it visits is cached.
 */
function $hasTextInside(
  element: ElementNode,
  cache: Map<NodeKey, boolean> | null,
): boolean {
  const key = element.getKey();
  const cached = cache !== null ? cache.get(key) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  let found = false;
  for (
    let child = element.getFirstChild();
    child !== null && !found;
    child = child.getNextSibling()
  ) {
    found =
      $isTextNode(child) ||
      ($isElementNode(child) && $hasTextInside(child, cache));
  }
  if (cache !== null) {
    cache.set(key, found);
  }
  return found;
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
