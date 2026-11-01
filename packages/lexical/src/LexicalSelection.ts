/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from './LexicalEditor';
import type {EditorState} from './LexicalEditorState';
import type {ElementNode} from './nodes/LexicalElementNode';

import invariant from '@lexical/internal/invariant';

import {
  $caretFromPoint,
  $caretRangeFromSelection,
  $comparePointCaretNext,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $extendCaretToRange,
  $getAdjacentChildCaret,
  $getCaretRange,
  $getCaretRangeInDirection,
  $getChildCaret,
  $getSiblingCaret,
  $getTextNodeOffset,
  $getTextPointCaretSliceForNode,
  $insertNodeToNearestRootAtCaret,
  $isBlockFullySelected,
  $isChildCaret,
  $isDecoratorNode,
  $isElementNode,
  $isExtendableTextPointCaret,
  $isLineBreakNode,
  $isParagraphNode,
  $isRootNode,
  $isSiblingCaret,
  $isTextNode,
  $isTextPointCaret,
  $normalizeCaret,
  $removeTextFromCaretRange,
  $rewindSiblingCaret,
  $setPointFromCaret,
  $setSelection,
  $setSelectionFromCaretRange,
  $splitTextPointCaretSlice,
  $updateRangeSelectionFromCaretRange,
  type CaretRange,
  type ChildCaret,
  COLLABORATION_TAG,
  type LineBreakNode,
  type NodeCaret,
  type PointCaret,
  SKIP_SCROLL_INTO_VIEW_TAG,
  type TextNode,
} from '.';
import {$comparePointCaretNextAcrossSlots} from './caret/LexicalCaret';
import {IS_FIREFOX} from './environment';
import {
  COMPOSITION_SUFFIX,
  DOM_TEXT_TYPE,
  TEXT_TYPE_TO_FORMAT,
} from './LexicalConstants';
import {
  markCollapsedSelectionFormat,
  markSelectionChangeFromDOMUpdate,
} from './LexicalEvents';
import {getIsProcessingMutations} from './LexicalMutations';
import {insertRangeAfter, type LexicalNode, type NodeKey} from './LexicalNode';
import {$normalizeSelection} from './LexicalNormalization';
import {
  $getSelectionSlotFrame,
  $getSlot,
  $getSlotFrame,
  $getSlotHost,
  $getSlotHostKey,
  $getSlotNames,
} from './LexicalSlot';
import {$isBlockContainer} from './LexicalStructure';
import {
  getActiveEditor,
  getActiveEditorState,
  isCurrentlyReadOnlyMode,
} from './LexicalUpdates';
import {SKIP_SELECTION_FOCUS_TAG} from './LexicalUpdateTags';
import {
  $findMatchingParent,
  $getCompositionKey,
  $getDOMSlot,
  $getDOMTextNode,
  $getNearestNodeFromDOMNode,
  $getNearestRootOrShadowRoot,
  $getNodeByKey,
  $getNodeFromDOM,
  $getRoot,
  $hasAncestor,
  $isEmptyCompositionTarget,
  $isInlineElementOrDecoratorNode,
  $isRootOrShadowRoot,
  $isSelectionCapturedInDecoratorInput,
  $isTokenOrSegmented,
  $needsBlockCursorBeside,
  $restoreEmptyContainerParagraph,
  $setCompositionKey,
  doesContainSurrogatePair,
  getActiveElement,
  getActiveElementDeep,
  getCaretRect,
  getComposedEventTarget,
  getComposedStaticRange,
  getDOMSelection,
  getDOMSelectionPoints,
  getDOMSelectionRange,
  getElementByKeyOrThrow,
  getNearestEditorFromDOMNode,
  getNodeKeyFromDOMNode,
  getWindow,
  INTERNAL_$isBlock,
  isDOMCapturingSelection,
  isDOMDocumentNode,
  isDOMNode,
  isDOMShadowRoot,
  isDOMTextNode,
  isHTMLElement,
  isSelectionWithinEditor,
  removeDOMBlockCursorElement,
  scrollIntoViewIfNeeded,
  toggleTextFormatType,
} from './LexicalUtils';
import {$createTabNode} from './nodes/LexicalTabNode';
import {
  $isInlineFormattable,
  $recordDeleted,
  $recordTextInserted,
  type TextFormatType,
} from './nodes/LexicalTextNode';

const __DEV__ = process.env.NODE_ENV !== 'production';

export type TextPointType = {
  _selection: BaseSelection;
  getNode: () => TextNode;
  is: (point: PointType) => boolean;
  isBefore: (point: PointType) => boolean;
  key: NodeKey;
  offset: number;
  set: (
    key: NodeKey,
    offset: number,
    type: 'text' | 'element',
    onlyIfChanged?: boolean,
  ) => void;
  type: 'text';
};

export type ElementPointType = {
  _selection: BaseSelection;
  getNode: () => ElementNode;
  is: (point: PointType) => boolean;
  isBefore: (point: PointType) => boolean;
  key: NodeKey;
  offset: number;
  set: (
    key: NodeKey,
    offset: number,
    type: 'text' | 'element',
    onlyIfChanged?: boolean,
  ) => void;
  type: 'element';
};

export type PointType = TextPointType | ElementPointType;

export class Point {
  key: NodeKey;
  offset: number;
  type: 'text' | 'element';
  _selection: BaseSelection | null;

  constructor(key: NodeKey, offset: number, type: 'text' | 'element') {
    if (__DEV__) {
      // This prevents a circular reference error when serialized as JSON,
      // which happens on unit test failures
      Object.defineProperty(this, '_selection', {
        enumerable: false,
        writable: true,
      });
    }
    this._selection = null;
    this.key = key;
    this.offset = offset;
    this.type = type;
  }

  is(point: PointType): boolean {
    return (
      this.key === point.key &&
      this.offset === point.offset &&
      this.type === point.type
    );
  }

  isBefore(b: PointType): boolean {
    if (this.key === b.key) {
      return this.offset < b.offset;
    }
    const aCaret = $normalizeCaret($caretFromPoint(this, 'next'));
    const bCaret = $normalizeCaret($caretFromPoint(b, 'next'));
    return $comparePointCaretNext(aCaret, bCaret) < 0;
  }

  getNode(): LexicalNode {
    const key = this.key;
    const node = $getNodeByKey(key);
    if (node === null) {
      invariant(false, 'Point.getNode: node not found');
    }
    return node;
  }

  set(
    key: NodeKey,
    offset: number,
    type: 'text' | 'element',
    onlyIfChanged?: boolean,
  ): void {
    const selection = this._selection;
    const oldKey = this.key;
    if (
      onlyIfChanged &&
      this.key === key &&
      this.offset === offset &&
      this.type === type
    ) {
      return;
    }
    this.key = key;
    this.offset = offset;
    this.type = type;
    if (__DEV__) {
      const node = $getNodeByKey(key);
      invariant(
        type === 'text' ? $isTextNode(node) : $isElementNode(node),
        'PointType.set: node with key %s is %s and can not be used for a %s point',
        key,
        node ? node.__type : '[not found]',
        type,
      );
    }
    if (!isCurrentlyReadOnlyMode()) {
      if ($getCompositionKey() === oldKey) {
        $setCompositionKey(key);
      }
      if (selection !== null) {
        selection.setCachedNodes(null);
        if ($isRangeSelection(selection)) {
          selection._cachedIsBackward = null;
        }
        selection.dirty = true;
      }
    }
  }
}

/** Creates a selection endpoint (Point) targeting the given node key at the specified offset. */
export function $createPoint(
  key: NodeKey,
  offset: number,
  type: 'text' | 'element',
): PointType {
  // @ts-expect-error: intentionally cast as we use a class for perf reasons
  return new Point(key, offset, type);
}

function selectPointOnNode(point: PointType, node: LexicalNode): void {
  let key = node.__key;
  let offset = point.offset;
  let type: 'element' | 'text' = 'element';
  if ($isTextNode(node)) {
    type = 'text';
    const textContentLength = node.getTextContentSize();
    if (offset > textContentLength) {
      offset = textContentLength;
    }
  } else if (!$isElementNode(node)) {
    const nextSibling = node.getNextSibling();
    if ($isTextNode(nextSibling)) {
      key = nextSibling.__key;
      offset = 0;
      type = 'text';
    } else {
      const parentNode = node.getParent();
      if (parentNode) {
        key = parentNode.__key;
        offset = node.getIndexWithinParent() + 1;
      }
    }
  }
  point.set(key, offset, type);
}

export function $moveSelectionPointToEnd(
  point: PointType,
  node: LexicalNode,
): void {
  if ($isElementNode(node)) {
    const lastNode = node.getLastDescendant();
    if ($isElementNode(lastNode) || $isTextNode(lastNode)) {
      selectPointOnNode(point, lastNode);
    } else {
      selectPointOnNode(point, node);
    }
  } else {
    selectPointOnNode(point, node);
  }
}

function $transferStartingElementPointToTextPoint(
  start: ElementPointType,
  end: PointType,
  format: number,
  style: string,
): void {
  const element = start.getNode();
  const placementNode = element.getChildAtIndex(start.offset);
  const textNode = $createTextNode();
  textNode.setFormat(format);
  textNode.setStyle(style);
  if ($isParagraphNode(placementNode)) {
    placementNode.splice(0, 0, [textNode]);
  } else if (placementNode !== null) {
    // root or shadow-root + element-mode anchor before a non-paragraph
    // child (typically a sibling block decorator): wrap the new text in
    // a paragraph so it stays a valid block-level child of the root or
    // slot frame. The last-offset branch below already covers shadow
    // roots; the in-the-middle case used to drop a raw text node next
    // to the decorator, which leaves the text without a block ancestor
    // and breaks every downstream getTopLevelElement / $findMatchingParent
    // walk (Cmd+A, Enter, etc.).
    const target = $isRootOrShadowRoot(element)
      ? $createParagraphNode().append(textNode)
      : textNode;
    placementNode.insertBefore(target);
  } else if ($isRootOrShadowRoot(element)) {
    // root or shadow-root + last-offset typing: reuse the empty trailing
    // block when one exists (typical state after a sibling block decorator
    // was deleted) instead of appending a fresh paragraph. The old behavior
    // left a phantom empty paragraph above the user's input.
    const lastChild = element.getLastChild();
    if (
      $isElementNode(lastChild) &&
      !lastChild.isInline() &&
      lastChild.isEmpty()
    ) {
      lastChild.append(textNode);
    } else {
      element.append($createParagraphNode().append(textNode));
    }
  } else {
    element.append(textNode);
  }
  // Transfer the element point to a text point.
  if (start.is(end)) {
    end.set(textNode.__key, 0, 'text');
  }
  start.set(textNode.__key, 0, 'text');
}

/** Prepare the native IME target without routing a document character through commands. */
export function $prepareCompositionTarget(selection: RangeSelection): void {
  $insertText(selection, '', true);
}

function $insertText(
  selection: RangeSelection,
  text: string,
  preparingComposition: boolean,
): void {
  // For non-collapsed selections, inherit format/style from the first
  // selected text node so the replacement preserves the original styling.
  let format = selection.format;
  let style = selection.style;
  if (!selection.isCollapsed()) {
    const firstPoint = selection.focus.isBefore(selection.anchor)
      ? selection.focus
      : selection.anchor;
    const firstNode = firstPoint.getNode();
    if ($isTextNode(firstNode)) {
      format = firstNode.getFormat();
      style = firstNode.getStyle();
    }
    selection.removeText();
    selection.format = format;
    selection.style = style;
    if (text === '' && !preparingComposition) {
      return;
    }
    if ($getCompositionKey() === null) {
      if (selection.anchor.type === 'element') {
        $transferStartingElementPointToTextPoint(
          selection.anchor,
          selection.focus,
          format,
          style,
        );
      }
      $insertTextAtPoint(selection, text, format, style);
      return;
    }
    // Composing: fall through to the collapsed code below.
    // spliceText preserves DOM node identity so the browser's
    // IME tracker stays attached.
  }

  if (selection.anchor.type === 'element') {
    $transferStartingElementPointToTextPoint(
      selection.anchor,
      selection.focus,
      format,
      style,
    );
  }

  const anchorNode = selection.anchor.getNode();
  invariant($isTextNode(anchorNode), 'insertText: anchor is not a text node');
  const offset = selection.anchor.offset;

  const anchorParent = anchorNode.getParentOrThrow();
  const anchorSize = anchorNode.getTextContentSize();
  const needsRedirect =
    $isTokenOrSegmented(anchorNode) ||
    (offset === 0 &&
      (!anchorNode.canInsertTextBefore() ||
        (!anchorParent.canInsertTextBefore() && !anchorNode.__prev))) ||
    (offset === anchorSize &&
      (!anchorNode.canInsertTextAfter() ||
        (!anchorParent.canInsertTextAfter() && !anchorNode.__next)));

  if (needsRedirect) {
    // Token/segmented nodes and nodes whose parent forbids text insertion
    // at the boundary: reposition the cursor to an adjacent insertable
    // node, then recurse.

    // Segmented node with cursor in the middle: convert to normal
    // text node so that the recursive insertText can proceed.
    if (anchorNode.isSegmented() && offset !== 0 && offset !== anchorSize) {
      if ($getCompositionKey() !== null) {
        anchorNode.setMode('normal').setFormat(format).setStyle(style);
        getActiveEditor()._inputState.composedSegmentedKey =
          anchorNode.getKey();
      } else {
        const replacement = $createTextNode(anchorNode.getTextContent());
        replacement.setFormat(format);
        replacement.setStyle(style);
        const isCurrentSelection = $getSelection() === selection;
        anchorNode.replace(replacement);
        // replace() installs a clone of the active selection, so this
        // selection is still anchored to the segmented node that was just
        // detached. Move it onto the replacement and make it current
        // again, otherwise the recursive insertText below resolves an
        // anchor that is no longer in the tree.
        selection.setTextNodeRange(replacement, offset, replacement, offset);
        if (isCurrentSelection && $getSelection() !== selection) {
          $setSelection(selection);
        }
      }
      if (text !== '' || preparingComposition) {
        $insertText(selection, text, preparingComposition);
      }
      return;
    }
    if (text === '' && !preparingComposition) {
      return;
    }
    if (offset === 0 || offset === anchorSize) {
      const before = offset === 0;
      const direction = before ? 'previous' : 'next';
      const sibling = $getSiblingCaret(anchorNode, direction).getNodeAtCaret();
      let target: TextNode;
      if (
        $isTextNode(sibling) &&
        (before
          ? sibling.canInsertTextAfter()
          : sibling.canInsertTextBefore()) &&
        !$isTokenOrSegmented(sibling)
      ) {
        target = sibling;
      } else {
        target = $createTextNode().setFormat(format).setStyle(style);
        const canInsert = before
          ? anchorParent.canInsertTextBefore()
          : anchorParent.canInsertTextAfter();
        $getSiblingCaret(
          canInsert ? anchorNode : anchorParent,
          direction,
        ).insert(target);
      }
      const targetOffset = before ? undefined : 0;
      target.select(targetOffset, targetOffset);
      $insertText(selection, text, preparingComposition);
      return;
    }
    const newNode = $createTextNode(text);
    newNode.setFormat(format);
    newNode.setStyle(style);
    $recordDeleted(anchorNode);
    $recordTextInserted(newNode);
    anchorNode.replace(newNode);
    newNode.select();
    return;
  }

  if (text === '' && !preparingComposition) {
    return;
  }

  const atStartOfInline =
    anchorParent.isInline() && offset === 0 && !anchorNode.__prev;
  const atEndOfInline =
    anchorParent.isInline() && offset === anchorSize && !anchorNode.__next;
  const formatDiffers =
    anchorNode.getFormat() !== format || anchorNode.getStyle() !== style;

  if (atStartOfInline || atEndOfInline || formatDiffers) {
    if (
      anchorNode.getTextContent() === '' &&
      !atStartOfInline &&
      !atEndOfInline
    ) {
      anchorNode.setFormat(format);
      anchorNode.setStyle(style);
    } else {
      $insertTextAtPoint(selection, text, format, style);
      return;
    }
  }

  anchorNode.spliceText(offset, 0, text, true);
  if (anchorNode.isComposing() && selection.anchor.type === 'text') {
    selection.anchor.set(
      selection.anchor.key,
      selection.anchor.offset - text.length,
      selection.anchor.type,
    );
  }
}

function $insertTextAtPoint(
  selection: RangeSelection,
  text: string,
  format: number,
  style: string,
): void {
  const anchorNode = selection.anchor.getNode();
  invariant($isTextNode(anchorNode), 'insertText: anchor is not a text node');
  const offset = selection.anchor.offset;
  const textNode = $createTextNode(text).setFormat(format).setStyle(style);
  $recordTextInserted(textNode);
  const parent = anchorNode.getParentOrThrow();
  const before = offset === 0;
  const atBoundary = before || offset === anchorNode.getTextContentSize();
  if (
    atBoundary &&
    parent.isInline() &&
    !(before ? anchorNode.__prev : anchorNode.__next)
  ) {
    $getSiblingCaret(parent, before ? 'previous' : 'next').insert(textNode);
  } else {
    const origin = atBoundary ? anchorNode : anchorNode.splitText(offset)[0];
    if (before) {
      origin.insertBefore(textNode, false);
    } else {
      origin.insertAfter(textNode, false);
    }
  }
  if (anchorNode.getTextContent() === '' && anchorNode.isAttached()) {
    anchorNode.remove();
  }
  textNode.selectEnd();
  if (textNode.isComposing() && selection.anchor.type === 'text') {
    selection.anchor.set(
      selection.anchor.key,
      selection.anchor.offset - text.length,
      selection.anchor.type,
    );
  }
}

export interface BaseSelection {
  _cachedNodes: LexicalNode[] | null;
  dirty: boolean;

  clone(): BaseSelection;
  extract(): LexicalNode[];
  getNodes(): LexicalNode[];
  getTextContent(): string;
  insertText(text: string): void;
  insertRawText(text: string): void;
  is(selection: null | BaseSelection): boolean;
  insertNodes(nodes: LexicalNode[]): void;
  getStartEndPoints(): null | [PointType, PointType];
  isCollapsed(): boolean;
  isBackward(): boolean;
  getCachedNodes(): LexicalNode[] | null;
  setCachedNodes(nodes: LexicalNode[] | null): void;
}

export class NodeSelection implements BaseSelection {
  _nodes: Set<NodeKey>;
  _cachedNodes: LexicalNode[] | null;
  dirty: boolean;

  constructor(objects: Set<NodeKey>) {
    this._cachedNodes = null;
    this._nodes = objects;
    this.dirty = false;
  }

  getCachedNodes(): LexicalNode[] | null {
    return this._cachedNodes;
  }

  setCachedNodes(nodes: LexicalNode[] | null): void {
    this._cachedNodes = nodes;
  }

  is(selection: null | BaseSelection): boolean {
    if (!$isNodeSelection(selection)) {
      return false;
    }
    const a: Set<NodeKey> = this._nodes;
    const b: Set<NodeKey> = selection._nodes;
    return a.size === b.size && Array.from(a).every(key => b.has(key));
  }

  isCollapsed(): boolean {
    return false;
  }

  isBackward(): boolean {
    return false;
  }

  getStartEndPoints(): null {
    return null;
  }

  add(key: NodeKey): void {
    this.dirty = true;
    this._nodes.add(key);
    this._cachedNodes = null;
  }

  delete(key: NodeKey): void {
    this.dirty = true;
    this._nodes.delete(key);
    this._cachedNodes = null;
  }

  clear(): void {
    this.dirty = true;
    this._nodes.clear();
    this._cachedNodes = null;
  }

  has(key: NodeKey): boolean {
    return this._nodes.has(key);
  }

  clone(): NodeSelection {
    return new NodeSelection(new Set(this._nodes));
  }

  extract(): LexicalNode[] {
    return this.getNodes();
  }

  insertRawText(text: string): void {
    // Do nothing?
  }

  insertText(): void {
    // Do nothing?
  }

  insertNodes(nodes: LexicalNode[]) {
    // Slotted nodes are fixed parts of their host with no parent, so they
    // can't be inserted around or removed (see $removeNode's slot guard).
    // Skip them; if nothing tree-resident is selected there's nowhere to
    // anchor the insertion.
    const selectedNodes = this.getNodes().filter(
      node => $getSlotHostKey(node) === null,
    );
    const selectedNodesLength = selectedNodes.length;
    if (selectedNodesLength === 0) {
      return;
    }
    const lastSelectedNode = selectedNodes[selectedNodesLength - 1];
    let selectionAtEnd: RangeSelection;
    // Insert nodes
    if ($isTextNode(lastSelectedNode)) {
      selectionAtEnd = lastSelectedNode.select();
    } else {
      const index = lastSelectedNode.getIndexWithinParent() + 1;
      selectionAtEnd = lastSelectedNode.getParentOrThrow().select(index, index);
    }
    selectionAtEnd.insertNodes(nodes);
    // Remove selected nodes
    for (let i = 0; i < selectedNodesLength; i++) {
      selectedNodes[i].remove();
    }
  }

  getNodes(): LexicalNode[] {
    const cachedNodes = this._cachedNodes;
    if (cachedNodes !== null) {
      return cachedNodes;
    }
    const objects = this._nodes;
    const nodes = [];
    for (const object of objects) {
      const node = $getNodeByKey(object);
      if (node !== null) {
        nodes.push(node);
      }
    }
    if (!isCurrentlyReadOnlyMode()) {
      this._cachedNodes = nodes;
    }
    return nodes;
  }

  getTextContent(): string {
    const nodes = this.getNodes();
    let textContent = '';
    for (let i = 0; i < nodes.length; i++) {
      textContent += nodes[i].getTextContent();
    }
    return textContent;
  }

  /**
   * Remove all nodes in the NodeSelection. If there were any nodes,
   * replace the selection with a new RangeSelection at the previous
   * location of the first node.
   */
  deleteNodes(): void {
    // Slotted nodes are fixed parts of their host; skip them so we neither
    // build a caret from a parentless node nor hit $removeNode's slot guard.
    const nodes = this.getNodes().filter(
      node => $getSlotHostKey(node) === null,
    );
    if (($getSelection() || $getPreviousSelection()) === this && nodes[0]) {
      const firstCaret = $getSiblingCaret(nodes[0], 'next');
      $setSelectionFromCaretRange($getCaretRange(firstCaret, firstCaret));
    }
    for (const node of nodes) {
      node.remove();
    }
    $ensureRootHasParagraph();
  }
}

function $ensureRootHasParagraph(): void {
  const root = $getRoot();
  // Root slots (such as footnotes) do not replace the editable document body.
  // Deletion inside a slot must keep the selection in that slot.
  if (
    root.getChildrenSize() === 0 &&
    $getSelectionSlotFrame($getSelection()) === null
  ) {
    const paragraph = $createParagraphNode();
    root.append(paragraph);
    paragraph.select();
  }
}

/**
 * The node immediately before the given point within its block, looking
 * through the boundaries of inline elements: a point at the start of a link's
 * text is still "after" whatever precedes the link. Returns null when text or
 * nothing at all precedes the point in its block.
 */
function $getNodeBeforePoint(point: PointType): LexicalNode | null {
  const node = point.getNode();
  if (point.offset > 0) {
    // An element point has the child before it; a text point has characters
    // before it, so no node is adjacent.
    return point.type === 'element' && $isElementNode(node)
      ? node.getChildAtIndex(point.offset - 1)
      : null;
  }
  for (
    let child: LexicalNode | null = node;
    child !== null && !INTERNAL_$isBlock(child) && !$isRootOrShadowRoot(child);
    child = child.getParent()
  ) {
    const previousSibling = child.getPreviousSibling();
    if (previousSibling !== null) {
      return previousSibling;
    }
  }
  return null;
}

/**
 * Two consecutive soft line breaks render an empty line. A point directly
 * after them starts a new visual paragraph, with nothing to its left to
 * continue, so blocks inserted there behave as they do at the start of a
 * block: they keep their own block identity instead of being flattened into
 * the text above the empty line (#4815).
 *
 * A single line break is deliberately not enough. It would be the more
 * consistent rule -- the point is just as much at the start of a line -- but
 * it also decides that a lone pasted paragraph stops continuing the line and
 * becomes its own block, which is a wider change to paste than this fix
 * should make.
 */
function $isPointAfterEmptyLine(point: PointType): boolean {
  const nodeBefore = $getNodeBeforePoint(point);
  return (
    $isLineBreakNode(nodeBefore) &&
    $isLineBreakNode(nodeBefore.getPreviousSibling())
  );
}

/** Returns true if the given value is a RangeSelection. */
export function $isRangeSelection(x: unknown): x is RangeSelection {
  return x instanceof RangeSelection;
}

export class RangeSelection implements BaseSelection {
  format: number;
  style: string;
  anchor: PointType;
  focus: PointType;
  _cachedNodes: LexicalNode[] | null;
  /** @internal */
  _cachedIsBackward: boolean | null;
  dirty: boolean;

  constructor(
    anchor: PointType,
    focus: PointType,
    format: number,
    style: string,
  ) {
    this.anchor = anchor;
    this.focus = focus;
    anchor._selection = this;
    focus._selection = this;
    this._cachedNodes = null;
    this._cachedIsBackward = null;
    this.format = format;
    this.style = style;
    this.dirty = false;
  }

  getCachedNodes(): LexicalNode[] | null {
    return this._cachedNodes;
  }

  setCachedNodes(nodes: LexicalNode[] | null): void {
    this._cachedNodes = nodes;
  }

  /**
   * Used to check if the provided selections is equal to this one by value,
   * including anchor, focus, format, and style properties.
   * @param selection - the Selection to compare this one to.
   * @returns true if the Selections are equal, false otherwise.
   */
  is(selection: null | BaseSelection): boolean {
    if (!$isRangeSelection(selection)) {
      return false;
    }
    return (
      this.anchor.is(selection.anchor) &&
      this.focus.is(selection.focus) &&
      this.format === selection.format &&
      this.style === selection.style
    );
  }

  /**
   * Returns whether the Selection is "collapsed", meaning the anchor and focus are
   * the same node and have the same offset.
   *
   * @returns true if the Selection is collapsed, false otherwise.
   */
  isCollapsed(): boolean {
    return this.anchor.is(this.focus);
  }

  /**
   * Gets all the nodes in the Selection. Uses caching to make it generally suitable
   * for use in hot paths.
   *
   * See also the {@link CaretRange} APIs (starting with
   * {@link $caretRangeFromSelection}), which are likely to provide a better
   * foundation for any operation where partial selection is relevant
   * (e.g. the anchor or focus are inside an ElementNode and TextNode)
   *
   * @returns an Array containing all the nodes in the Selection
   */
  getNodes(): LexicalNode[] {
    const cachedNodes = this._cachedNodes;
    if (cachedNodes !== null) {
      return cachedNodes;
    }
    const range = $getCaretRangeInDirection(
      $caretRangeFromSelection(this),
      'next',
    );
    const nodes = $getNodesFromCaretRangeCompat(range);
    if (__DEV__) {
      if (this.isCollapsed() && nodes.length > 1) {
        invariant(
          false,
          'RangeSelection.getNodes() returned %s > 1 nodes in a collapsed selection',
          String(nodes.length),
        );
      }
    }
    if (!isCurrentlyReadOnlyMode()) {
      this._cachedNodes = nodes;
    }
    return nodes;
  }

  /**
   * Sets this Selection to be of type "text" at the provided anchor and focus values.
   *
   * @param anchorNode - the anchor node to set on the Selection
   * @param anchorOffset - the offset to set on the Selection
   * @param focusNode - the focus node to set on the Selection
   * @param focusOffset - the focus offset to set on the Selection
   */
  setTextNodeRange(
    anchorNode: TextNode,
    anchorOffset: number,
    focusNode: TextNode,
    focusOffset: number,
  ): this {
    this.anchor.set(anchorNode.__key, anchorOffset, 'text');
    this.focus.set(focusNode.__key, focusOffset, 'text');
    return this;
  }

  /**
   * Gets the (plain) text content of all the nodes in the selection.
   *
   * @returns a string representing the text content of all the nodes in the Selection
   */
  getTextContent(): string {
    if (this.isCollapsed()) {
      return '';
    }
    const nodes = this.getNodes();
    const slices = $caretRangeFromSelection(this).getTextSlices();
    let textContent = '';
    let prevWasElement = true;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if ($isElementNode(node) && !node.isInline()) {
        if (!prevWasElement) {
          textContent += '\n';
        }
        // Slots are isolated shadow roots, so getNodes() never descends into
        // them; append their text here (slots-first, mirroring
        // ElementNode.getTextContent) so a selection enclosing the host
        // carries its slot content.
        let slotText = '';
        for (const slotName of $getSlotNames(node)) {
          const slot = $getSlot(node, slotName);
          if (slot !== null) {
            slotText += slot.getTextContent();
          }
        }
        if (slotText !== '') {
          textContent += slotText;
          prevWasElement = false;
        } else if (node.isEmpty()) {
          prevWasElement = false;
        } else {
          prevWasElement = true;
        }
      } else {
        prevWasElement = false;
        if ($isTextNode(node)) {
          const slice = $getTextPointCaretSliceForNode(slices, node);
          textContent += slice ? slice.getTextContent() : node.getTextContent();
        } else if ($isDecoratorNode(node) || $isLineBreakNode(node)) {
          textContent += node.getTextContent();
        }
      }
    }
    return textContent;
  }

  /**
   * Attempts to map a DOM selection range onto this Lexical Selection,
   * setting the anchor, focus, and type accordingly
   *
   * @param range a DOM Selection range conforming to the StaticRange interface.
   */
  applyDOMRange(range: StaticRange): void {
    const editor = getActiveEditor();
    const currentEditorState = editor.getEditorState();
    const lastSelection = currentEditorState._selection;
    const resolvedSelectionPoints = $internalResolveSelectionPoints(
      range.startContainer,
      range.startOffset,
      range.endContainer,
      range.endOffset,
      editor,
      lastSelection,
    );
    if (resolvedSelectionPoints === null) {
      return;
    }
    const [anchorPoint, focusPoint, dirty] = resolvedSelectionPoints;
    this.anchor.set(
      anchorPoint.key,
      anchorPoint.offset,
      anchorPoint.type,
      true,
    );
    this.focus.set(focusPoint.key, focusPoint.offset, focusPoint.type, true);
    if (dirty) {
      this.dirty = true;
    }
    // Firefox will use an element point rather than a text point in some cases,
    // so we normalize for that
    $normalizeSelection(this);
  }

  /**
   * Creates a new RangeSelection, copying over all the property values from this one.
   *
   * @returns a new RangeSelection with the same property values as this one.
   */
  clone(): RangeSelection {
    const anchor = this.anchor;
    const focus = this.focus;
    const selection = new RangeSelection(
      $createPoint(anchor.key, anchor.offset, anchor.type),
      $createPoint(focus.key, focus.offset, focus.type),
      this.format,
      this.style,
    );
    return selection;
  }

  /**
   * Toggles the provided format on all the TextNodes in the Selection.
   *
   * @param format a string TextFormatType to toggle on the TextNodes in the selection
   */
  toggleFormat(format: TextFormatType): void {
    this.format = toggleTextFormatType(this.format, format, null);
    this.dirty = true;
  }

  /**
   * Sets the value of the format property on the Selection
   *
   * @param format - the format to set at the value of the format property.
   */
  setFormat(format: number): void {
    this.format = format;
    this.dirty = true;
  }

  /**
   * Sets the value of the style property on the Selection
   *
   * @param style - the style to set at the value of the style property.
   */
  setStyle(style: string): void {
    this.style = style;
    this.dirty = true;
  }

  /**
   * Returns whether the provided TextFormatType is present on the Selection. This will be true if all text nodes in the Selection
   * have the specified format.
   *
   * @param type the TextFormatType to check for.
   * @returns true if the provided format is currently toggled on the Selection, false otherwise.
   */
  hasFormat(type: TextFormatType): boolean {
    const formatFlag = TEXT_TYPE_TO_FORMAT[type];
    return (this.format & formatFlag) !== 0;
  }

  /**
   * Attempts to insert the provided text into the EditorState at the current Selection.
   * converts tabs, newlines, and carriage returns into LexicalNodes.
   *
   * @param text the text to insert into the Selection
   */
  insertRawText(text: string): void {
    this.insertNodes($generateNodesFromRawText(text));
  }

  /**
   * Insert the provided text into the EditorState at the current Selection.
   *
   * @param text the text to insert into the Selection
   */
  insertText(text: string): void {
    $insertText(this, text, false);
  }

  /**
   * Removes the text in the Selection, adjusting the EditorState accordingly.
   */
  removeText(): void {
    const isCurrentSelection = $getSelection() === this;
    const previousAnchorKey = this.anchor.key;
    const newRange = $removeTextFromCaretRange($caretRangeFromSelection(this));
    $updateRangeSelectionFromCaretRange(this, newRange);
    // The caret can end up in a node it did not start in, e.g. backspacing
    // an empty paragraph merges the caret into the end of the previous
    // block. The pending format and style describe the node the caret left,
    // so re-derive them from the node it landed on (#6781).
    if (this.isCollapsed()) {
      $internalRefreshSelectionFormatAndStyle(this, previousAnchorKey);
    }
    if (isCurrentSelection && $getSelection() !== this) {
      $setSelection(this);
    }
  }

  /**
   * Applies the provided format to the TextNodes in the Selection, splitting or
   * merging nodes as necessary.
   *
   * @param formatType the format type to apply to the nodes in the Selection.
   * @param alignWithFormat a 32-bit integer representing formatting flags to align with.
   */
  formatText(
    formatType: TextFormatType,
    alignWithFormat: number | null = null,
  ): void {
    $formatText(this, formatType, alignWithFormat);
  }

  /**
   * Attempts to "intelligently" insert an arbitrary list of Lexical nodes into the EditorState at the
   * current Selection according to a set of heuristics that determine how surrounding nodes
   * should be changed, replaced, or moved to accommodate the incoming ones.
   *
   * @param nodes - the nodes to insert
   */
  insertNodes(nodes: LexicalNode[]): void {
    if (nodes.length === 0) {
      return;
    }
    if (!this.isCollapsed()) {
      this.removeText();
    }
    // Anchor on a slot value root (e.g. after a
    // slot-scoped Cmd+A leaves the selection on the slot's element point)
    // has __parent === null, so the block-finding walk below would throw.
    // Redirect into the slot subtree by collapsing the selection at the
    // slot's first child and re-running insertNodes. Only a container
    // (shadow-root) value needs this: a block-shaped value IS the block, so
    // the block-finding walk below (which stops at a slot host, see
    // $removeTextAndSplitBlock) already lands on it directly at the right
    // offset.
    const anchorNode = this.anchor.getNode();
    if (
      this.anchor.type === 'element' &&
      $isElementNode(anchorNode) &&
      anchorNode.isShadowRoot() &&
      $getSlotHostKey(anchorNode) !== null
    ) {
      // An empty container has no child to redirect into (its caret target
      // is the reconciler's terminating <br>), so seed a paragraph first —
      // insertNodes removes the seed again when block content replaces it.
      let firstChild =
        anchorNode.getFirstChild() ??
        anchorNode.append($createParagraphNode()).getFirstChild();
      // A first child that is a non-element (typically a decorator like
      // HorizontalRuleNode) would re-enter this same branch forever:
      // `firstChild.selectStart()` resolves back to the slot value's own
      // element-mode caret (no sibling, parent = the slot value root), which
      // matches the entry condition above. Seed a paragraph before the
      // non-element first child so the redirected selection lands in a block
      // and the recursion terminates.
      if (firstChild !== null && !$isElementNode(firstChild)) {
        const seed = $createParagraphNode();
        firstChild.insertBefore(seed);
        firstChild = seed;
      }
      if (firstChild !== null) {
        firstChild.selectStart();
        const redirected = $getSelection();
        invariant(
          $isRangeSelection(redirected),
          'Expected RangeSelection after redirecting into slot subtree',
        );
        return redirected.insertNodes(nodes);
      }
    }

    // The anchor is an element point directly on a block container (a root, a
    // shadow root that is not a named-slot host, handled above, or a declared
    // container, see $isBlockContainer). This includes the document root
    // (e.g. an empty editor) and shadow roots that hold block-level children
    // directly — for instance the block cursor between or after the children of
    // a decorator-only container or the playground CollapsibleContentNode.
    // Roots and shadow roots hold blocks (and shadow roots) directly, so splice
    // the nodes in at the anchor offset: a block node (such as a pasted
    // DecoratorNode) goes in as-is, while inline runs are wrapped in a block
    // first since a root/shadow root cannot contain inline children.
    if (this.anchor.type === 'element' && $isBlockContainer(anchorNode)) {
      const blocksParent = $wrapInlineNodes(nodes);
      const nodeToSelect = blocksParent.getLastDescendant();
      anchorNode.splice(this.anchor.offset, 0, blocksParent.getChildren());
      if (nodeToSelect !== null) {
        nodeToSelect.selectEnd();
      }
      return;
    }

    const firstPoint = this.isBackward() ? this.focus : this.anchor;
    let firstNode = firstPoint.getNode();
    let firstBlock = $findMatchingParent(firstNode, INTERNAL_$isBlock);

    const last = nodes[nodes.length - 1]!;

    // CASE 1: insert inside a code block
    if ($isElementNode(firstBlock) && '__language' in firstBlock) {
      if ('__language' in nodes[0]) {
        this.insertText(nodes[0].getTextContent());
      } else {
        const [, index] = $removeTextAndSplitBlock(this);
        firstBlock.splice(index, 0, nodes);
        last.selectEnd();
      }
      return;
    }

    // CASE 2: All elements of the array are inline
    const notInline = (node: LexicalNode) =>
      ($isElementNode(node) || $isDecoratorNode(node)) && !node.isInline();

    if (!nodes.some(notInline)) {
      invariant(
        $isElementNode(firstBlock),
        'Expected node %s of type %s to have a block ElementNode ancestor',
        firstNode.constructor.name,
        firstNode.getType(),
      );
      // The split walk normally ends on firstBlock, but it stops early on an
      // inline ElementNode that cannot be split, which is the only position
      // that preserves the caret for content pasted inside such a node
      // (#6477).
      const [container, index] = $removeTextAndSplitBlock(this, true);
      const insertionParent = $isElementNode(container)
        ? container
        : firstBlock;
      insertionParent.splice(index, 0, nodes);
      last.selectEnd();
      return;
    }

    // CASE 3a: there is non-inline content but no block ancestor to insert it
    // relative to. The element point on a root/shadow root is handled above, so
    // this is a malformed document where an inline-only element directly holds
    // a block child (e.g. a HorizontalRuleNode inside a CollapsibleTitleNode,
    // see #8713) or a non-inline element that reports canBeEmpty() === false.
    // A non-inline node must never become the child of an inline-only element,
    // so enforce the document structure rules with
    // $insertNodeToNearestRootAtCaret, which splits the ancestor chain up to
    // the nearest node that may contain non-inline children (a root or shadow
    // root) and inserts the blocks there. Lists are unaffected: a list item is
    // always a block ancestor, so they fall through to CASE 3 and keep their
    // existing (ListItemNode-aware) paste behavior.
    if (firstBlock === null) {
      const blocksParent = $wrapInlineNodes(nodes);
      const nodeToSelect = blocksParent.getLastDescendant();
      // Split the ancestor chain up to the nearest root or shadow root and
      // insert each block there.
      let caret: PointCaret<'next'> = $caretFromPoint(this.anchor, 'next');
      for (const block of blocksParent.getChildren()) {
        caret = $insertNodeToNearestRootAtCaret(block, caret);
      }
      if (nodeToSelect !== null) {
        nodeToSelect.selectEnd();
      }
      return;
    }

    // CASE 3b: the block cannot receive block siblings. A slot value's
    // virtual root holds exactly one block; a block inside an inline-only
    // element cannot introduce nested blocks either (#8724). Flatten the
    // incoming content in both cases, like pasting into an <input>. A block
    // in a block container (see $isBlockContainer) can.
    // Parent-required nodes such as ListItemNode can relocate inserted
    // siblings to a valid parent, so keep their normal paste behavior.
    if (
      $isElementNode(firstBlock) &&
      ($getSlotHostKey(firstBlock) !== null ||
        (!firstBlock.isParentRequired() &&
          !$isBlockContainer(firstBlock.getParentOrThrow())))
    ) {
      const [, index] = $removeTextAndSplitBlock(this);
      const inlineNodes = $extractInlineFromBlocks(nodes);
      firstBlock.splice(index, 0, inlineNodes);
      const lastInserted = inlineNodes[inlineNodes.length - 1];
      if (lastInserted !== undefined) {
        lastInserted.selectEnd();
      } else {
        firstBlock.select(index, index);
      }
      return;
    }

    // CASE 3: At least 1 element of the array is not inline
    const blocksParent = $wrapInlineNodes(nodes);
    const nodeToSelect = blocksParent.getLastDescendant()!;
    const blocks = blocksParent.getChildren();
    // An empty line before the insertion point reads as a block boundary, so
    // the first inserted block keeps its own block identity instead of being
    // flattened into the text above that empty line (#4815) -- matching what
    // already happens at the start of a block, where firstBlock is empty after
    // the split. The selection is collapsed by now (removeText above), so
    // firstPoint is the insertion point and nothing has split the block yet.
    const isAfterEmptyLine = $isPointAfterEmptyLine(firstPoint);
    const isMergeable = (node: LexicalNode): node is ElementNode =>
      !isAfterEmptyLine &&
      $isElementNode(node) &&
      INTERNAL_$isBlock(node) &&
      !node.isEmpty() &&
      $isElementNode(firstBlock) &&
      (!firstBlock.isEmpty() || firstBlock.canMergeWhenEmpty());

    const shouldInsert = !$isElementNode(firstBlock) || !firstBlock.isEmpty();
    const insertedParagraph = shouldInsert ? this.insertParagraph() : null;
    if (insertedParagraph && !firstBlock.isAttached()) {
      firstNode = this.anchor.getNode();
      firstBlock = $findMatchingParent(firstNode, INTERNAL_$isBlock);
    }
    const lastToInsert: LexicalNode | undefined = blocks[blocks.length - 1];
    let firstToInsert: LexicalNode | undefined = blocks[0];
    if (isMergeable(firstToInsert)) {
      invariant(
        $isElementNode(firstBlock),
        'Expected node %s of type %s to have a block ElementNode ancestor',
        firstNode.constructor.name,
        firstNode.getType(),
      );
      firstBlock.append(...firstToInsert.getChildren());
      firstToInsert = blocks[1];
    }
    if (firstToInsert) {
      invariant(
        firstBlock !== null,
        'Expected node %s of type %s to have a block ancestor',
        firstNode.constructor.name,
        firstNode.getType(),
      );
      insertRangeAfter(firstBlock, firstToInsert);
    }
    const lastInsertedBlock = $findMatchingParent(
      nodeToSelect,
      INTERNAL_$isBlock,
    );

    // Mark where the inserted content ends before the split-off content is
    // moved in after it. selectEnd() has to happen first because nodeToSelect
    // can be the node that receives those children: pasted content ending in
    // an empty block (as the playground's own copy does) makes that empty
    // block nodeToSelect, and selecting its end afterwards would put the caret
    // past the text that moved in -- at the end of the document rather than at
    // the join. A text nodeToSelect is unaffected either way, since the
    // children land beside it rather than inside it.
    const insertSelection = nodeToSelect.selectEnd();

    if (insertedParagraph) {
      if (
        $isElementNode(lastInsertedBlock) &&
        (insertedParagraph.canMergeWhenEmpty() ||
          INTERNAL_$isBlock(lastToInsert))
      ) {
        lastInsertedBlock.append(...insertedParagraph.getChildren());
        insertedParagraph.remove();
      } else if (insertedParagraph.isEmpty()) {
        // The split-off paragraph could not be merged into the last inserted
        // block (a block-level DecoratorNode is not an ElementNode, and a
        // container element such as a ListNode is not INTERNAL_$isBlock), but
        // it holds no content either: it only exists because the caret sat at
        // the end of the target block. Keeping it would leave a stray empty
        // paragraph after the inserted node, while the non-empty case (a
        // mid-block caret) keeps the content after the caret.
        insertedParagraph.remove();
      }
    }
    if ($isElementNode(firstBlock) && firstBlock.isEmpty()) {
      firstBlock.remove();
    }

    // To understand this take a look at the test "can wrap post-linebreak nodes into new element"
    const lastChild = $isElementNode(firstBlock)
      ? firstBlock.getLastChild()
      : null;
    if ($isLineBreakNode(lastChild) && lastInsertedBlock !== firstBlock) {
      lastChild.remove();
    }

    // Resolve the marked caret onto the text beside it. It is an element point
    // whenever nodeToSelect was an element with nothing after the caret -- an
    // empty block that has since received the split-off content, or a
    // block-level decorator -- and the caret should not read differently from
    // every other insertion here just because of the shape of what was pasted.
    const normalizedCaret = $normalizeCaret(
      $caretFromPoint(insertSelection.anchor, 'next'),
    );
    $setPointFromCaret(insertSelection.anchor, normalizedCaret);
    $setPointFromCaret(insertSelection.focus, normalizedCaret);
  }

  /**
   * Inserts a new ParagraphNode into the EditorState at the current Selection
   *
   * @returns the newly inserted node.
   */
  insertParagraph(): ElementNode | null {
    // The root/shadow-root branch below only splices a paragraph in, so the
    // selected content has to go first. $removeTextAndSplitBlock further down
    // does this for the other branches, but a select-all whose points stay at
    // the element level (a document that is a single shadow root, see
    // $selectAll) lands on the branch below and would otherwise keep the
    // content it was replacing.
    if (!this.isCollapsed()) {
      this.removeText();
    }
    const anchorNode = this.anchor.getNode();
    if (this.anchor.type === 'element' && $isBlockContainer(anchorNode)) {
      const paragraph = $createParagraphNode();
      anchorNode.splice(this.anchor.offset, 0, [paragraph]);
      paragraph.select();
      return paragraph;
    }
    const [, index] = $removeTextAndSplitBlock(this);
    const block = $findMatchingParent(this.anchor.getNode(), INTERNAL_$isBlock);
    if (block !== null && $getSlotHostKey(block) !== null) {
      // The block IS the slot value: its virtual shadow root holds exactly
      // one block, so there is no position for a sibling paragraph. Mirrors
      // Enter in a single-line input — a no-op (hosts may map it to focus
      // movement).
      return null;
    }
    invariant(
      $isElementNode(block),
      'Expected ancestor to be a block ElementNode',
    );
    const firstToAppend = block.getChildAtIndex(index);
    const nodesToInsert = firstToAppend
      ? [firstToAppend, ...firstToAppend.getNextSiblings()]
      : [];
    const newBlock = block.insertNewAfter(this, false) as ElementNode | null;
    if (newBlock) {
      newBlock.append(...nodesToInsert);
      newBlock.selectStart();
      return newBlock;
    }
    // if newBlock is null, it means that block is of type CodeNode.
    return null;
  }

  /**
   * Inserts a logical linebreak, which may be a new LineBreakNode or a new ParagraphNode, into the EditorState at the
   * current Selection.
   */
  insertLineBreak(selectStart?: boolean): void {
    const lineBreak = $createLineBreakNode();
    this.insertNodes([lineBreak]);
    // this is used in MacOS with the command 'ctrl-O' (openLineBreak)
    if (selectStart) {
      const parent = lineBreak.getParentOrThrow();
      const index = lineBreak.getIndexWithinParent();
      parent.select(index, index);
    }
  }

  /**
   * Extracts the nodes in the Selection, splitting nodes where necessary
   * to get offset-level precision.
   *
   * @returns The nodes in the Selection
   */
  extract(): LexicalNode[] {
    const nodes = this.getNodes();
    if (this.isCollapsed()) {
      return [...nodes];
    }
    const backward = this.isBackward();
    const slices = $caretRangeFromSelection(this).getTextSlices();
    const extracted: LexicalNode[] = [];
    for (const node of nodes) {
      const slice = $getTextPointCaretSliceForNode(slices, node);
      const replacement = slice ? $splitTextPointCaretSlice(slice, this) : node;
      if (replacement !== null) {
        extracted.push(replacement);
      }
    }
    // Preserve extract's single-text-node selection convention, including
    // ranges originally expressed with element points.
    if (
      nodes.length === 1 &&
      extracted.length === 1 &&
      $isTextNode(extracted[0])
    ) {
      const node = extracted[0];
      const [start, end] = backward
        ? [this.focus, this.anchor]
        : [this.anchor, this.focus];
      start.set(node.getKey(), 0, 'text');
      end.set(node.getKey(), node.getTextContentSize(), 'text');
    }
    return extracted;
  }

  /**
   * Modifies the Selection according to the parameters and a set of heuristics that account for
   * various node types. Can be used to safely move or extend selection by one logical "unit" without
   * dealing explicitly with all the possible node types.
   *
   * @param alter the type of modification to perform
   * @param isBackward whether or not selection is backwards
   * @param granularity the granularity at which to apply the modification
   */
  modify(
    alter: 'move' | 'extend',
    isBackward: boolean,
    granularity: 'character' | 'word' | 'lineboundary',
  ): void {
    if (
      $modifySelectionAroundDecoratorsAndBlocks(
        this,
        alter,
        isBackward,
        granularity,
      )
    ) {
      return;
    }
    const collapse = alter === 'move';

    const editor = getActiveEditor();
    const domSelection = getDOMSelection(getWindow(editor));

    if (!domSelection) {
      return;
    }
    const blockCursorElement = editor._blockCursorElement;
    const rootElement = editor._rootElement;
    const focusNode = this.focus.getNode();
    // Remove the block cursor element if it exists. This will ensure selection
    // works as intended. If we leave it in the DOM all sorts of strange bugs
    // occur. :/
    if (
      rootElement !== null &&
      blockCursorElement !== null &&
      $isElementNode(focusNode) &&
      !focusNode.isInline() &&
      !focusNode.canBeEmpty()
    ) {
      removeDOMBlockCursorElement(blockCursorElement, editor, rootElement);
    }
    const focusKeyedDOM = getElementByKeyOrThrow(editor, this.focus.key);
    let nextFocusDOM: HTMLElement | Text | null = focusKeyedDOM;
    if (this.focus.type === 'text') {
      nextFocusDOM = $isTextNode(focusNode)
        ? $getDOMTextNode(focusNode, focusKeyedDOM, editor)
        : null;
    }
    if (this.dirty) {
      const anchorKeyedDOM = getElementByKeyOrThrow(editor, this.anchor.key);
      let nextAnchorDOM: HTMLElement | Text | null = anchorKeyedDOM;
      if (this.anchor.type === 'text') {
        const node = this.anchor.getNode();
        nextAnchorDOM = $isTextNode(node)
          ? $getDOMTextNode(node, anchorKeyedDOM, editor)
          : null;
      }
      if (nextAnchorDOM && nextFocusDOM) {
        setDOMSelectionBaseAndExtent(
          domSelection,
          nextAnchorDOM,
          this.anchor.offset,
          nextFocusDOM,
          this.focus.offset,
        );
      }
    }
    // When focus sits at a TextNode boundary, pre-normalize the DOM
    // selection into the adjacent sibling's Text node so that the
    // native Selection.modify can cross inline-grid/flex spans (#7301).
    if (
      granularity === 'character' &&
      $isTextNode(focusNode) &&
      focusNode.isUnmergeable()
    ) {
      const atBoundary = isBackward
        ? this.focus.offset === 0
        : this.focus.offset === focusNode.getTextContentSize();
      if (atBoundary) {
        const sibling = $getSiblingCaret(
          focusNode,
          isBackward ? 'previous' : 'next',
        ).getNodeAtCaret();
        if ($isTextNode(sibling)) {
          if (collapse) {
            const sibKeyedDOM = editor.getElementByKey(sibling.getKey());
            const sibDOM = sibKeyedDOM
              ? $getDOMTextNode(sibling, sibKeyedDOM, editor)
              : null;
            if (sibDOM) {
              const sibOffset = isBackward ? sibDOM.length : 0;
              setDOMSelectionBaseAndExtent(
                domSelection,
                sibDOM,
                sibOffset,
                sibDOM,
                sibOffset,
              );
            }
          } else {
            // For extend (used by deleteCharacter), native Selection.modify
            // cannot cross inline-grid span boundaries even after
            // pre-normalization. Set the Lexical selection directly and
            // return early to skip the native moveNativeSelection call.
            const sibLen = sibling.getTextContentSize();
            if (isBackward) {
              this.focus.set(sibling.__key, sibLen - 1, 'text');
            } else {
              this.focus.set(sibling.__key, 1, 'text');
            }
            this.dirty = true;
            return;
          }
        }
      }
    }
    // We use the DOM selection.modify API here to "tell" us what the selection
    // will be. We then use it to update the Lexical selection accordingly. This
    // is much more reliable than waiting for a beforeinput and using the ranges
    // from getTargetRanges(), and is also better than trying to do it ourselves
    // using Intl.Segmenter or other workarounds that struggle with word segments
    // and line segments (especially with word wrapping and non-Roman languages).
    moveNativeSelection(
      domSelection,
      alter,
      isBackward ? 'backward' : 'forward',
      granularity,
      rootElement,
    );
    // Guard against no ranges
    if (domSelection.rangeCount > 0) {
      // Inside a DOM shadow root getRangeAt(0) is retargeted to the host;
      // read the composed StaticRange (real nodes) where available.
      const composedRange = getComposedStaticRange(
        domSelection,
        editor._rootElement,
      );
      const range = composedRange || domSelection.getRangeAt(0);
      // Apply the DOM selection to our Lexical selection.
      const anchorNode = this.anchor.getNode();
      const root = $isRootNode(anchorNode)
        ? anchorNode
        : $getNearestRootOrShadowRoot(anchorNode);
      this.applyDOMRange(range);
      this.dirty = true;
      if (!collapse) {
        $shrinkSelectionToRoot(this, isBackward, root);

        // Because a range works on start and end, we might need to flip
        // the anchor and focus points to match what the DOM has, not what
        // the range has specifically. Inside a shadow root anchorNode is
        // retargeted to the host, so use the standard Selection.direction.
        // If a future engine ships getComposedRanges without direction
        // this falls through to forward; backward fidelity is the known
        // limitation documented on getDOMSelectionPoints.
        const anchorIsAtRangeStart = composedRange
          ? domSelection.direction !== 'backward'
          : domSelection.anchorNode === range.startContainer &&
            domSelection.anchorOffset === range.startOffset;
        if (!anchorIsAtRangeStart) {
          $swapPoints(this);
        }
      }
    }
    if (granularity === 'lineboundary') {
      $modifySelectionAroundDecoratorsAndBlocks(
        this,
        alter,
        isBackward,
        granularity,
        'decorators',
      );
    }
  }
  /**
   * Helper for handling forward character and word deletion that prevents element nodes
   * like a table, columns layout being destroyed
   *
   * @param anchor the anchor
   * @param anchorNode the anchor node in the selection
   * @param isBackward whether or not selection is backwards
   */
  forwardDeletion(
    anchor: PointType,
    anchorNode: TextNode | ElementNode,
    isBackward: boolean,
  ): boolean {
    if (
      !isBackward &&
      // Delete forward handle case
      ((anchor.type === 'element' &&
        $isElementNode(anchorNode) &&
        anchor.offset === anchorNode.getChildrenSize()) ||
        (anchor.type === 'text' &&
          anchor.offset === anchorNode.getTextContentSize()))
    ) {
      const parent = anchorNode.getParent();
      const nextSibling =
        anchorNode.getNextSibling() ||
        (parent === null ? null : parent.getNextSibling());

      if ($isElementNode(nextSibling) && nextSibling.isShadowRoot()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Performs one logical character deletion operation on the EditorState based on the current Selection.
   * Handles different node types.
   *
   * @param isBackward whether or not the selection is backwards.
   */
  deleteCharacter(isBackward: boolean): void {
    const wasCollapsed = this.isCollapsed();
    if (this.isCollapsed()) {
      const anchor = this.anchor;
      let anchorNode: TextNode | ElementNode | null = anchor.getNode();
      if (this.forwardDeletion(anchor, anchorNode, isBackward)) {
        // Forward deletion stops at an adjacent shadow root (e.g. a table)
        // because its content must not be merged into the block at the
        // anchor. When that block is empty there is nothing to merge, so we
        // fall through to the caret walk below, which removes the empty block
        // and leaves the shadow root in place — the same result backwards
        // delete already produces. This is restricted to a shadow root that is
        // a sibling of the anchor block, so deleting forwards at the end of a
        // shadow root (e.g. the last block of a table cell) still bails out.
        // See #8075.
        const nextSibling = $isElementNode(anchorNode)
          ? anchorNode.getNextSibling()
          : null;
        if (
          !(
            $isElementNode(anchorNode) &&
            anchorNode.isEmpty() &&
            $isElementNode(nextSibling) &&
            nextSibling.isShadowRoot()
          )
        ) {
          return;
        }
      }
      const direction = isBackward ? 'previous' : 'next';
      const initialCaret = $caretFromPoint(anchor, direction);
      const initialRange = $extendCaretToRange(initialCaret);
      if (
        initialRange
          .getTextSlices()
          .every(slice => slice === null || slice.distance === 0)
      ) {
        // The caret is an element point sitting directly beside a node that
        // renders a block cursor ($needsBlockCursorBeside). There is no text
        // position between the two, so the only thing the keystroke can mean
        // is "delete that node", exactly as the DecoratorNode case below
        // does. Decorators are left to that branch since it also honours
        // isIsolated(); an ElementNode host (a shadow root such as a table or
        // a slot-bearing card) has no such opt-out and was previously left
        // untouched, because the loop below descends into it as a ChildCaret
        // and bails out at the shadow root instead of deleting it.
        if (anchor.type === 'element') {
          const adjacent = initialCaret.getNodeAtCaret();
          if ($isElementNode(adjacent) && $needsBlockCursorBeside(adjacent)) {
            const container = adjacent.getParent();
            adjacent.remove();
            // Removing the only block leaves the container (the root, or a
            // shadow root such as a table cell) with nowhere to put a caret.
            const restored = $restoreEmptyContainerParagraph(
              container,
              adjacent,
            );
            if (restored !== null) {
              restored.selectStart();
            }
            return;
          }
        }
        // There's no text in the direction of the deletion so we can explore our options
        let state:
          | {type: 'initial'}
          | {
              type: 'merge-next-block';
              block: ElementNode;
            }
          | {
              type: 'merge-block';
              caret: ChildCaret<ElementNode, typeof direction>;
              block: ElementNode;
            } = {type: 'initial'};
        for (const caret of initialRange.iterNodeCarets('shadowRoot')) {
          if ($isChildCaret(caret)) {
            if (caret.origin.isInline()) {
              // fall through when descending an inline
            } else if (caret.origin.isShadowRoot()) {
              if (state.type === 'merge-block') {
                break;
              }
              // Don't merge with a shadow root block
              if (
                $isElementNode(initialRange.anchor.origin) &&
                initialRange.anchor.origin.isEmpty()
              ) {
                // delete an empty paragraph like the DecoratorNode case
                const normCaret = $normalizeCaret(caret);
                $updateRangeSelectionFromCaretRange(
                  this,
                  $getCaretRange(normCaret, normCaret),
                );
                initialRange.anchor.origin.remove();
              }
              return;
            } else if (
              state.type === 'merge-next-block' ||
              state.type === 'merge-block'
            ) {
              // Keep descending ChildCaret to find which block to merge with
              state = {block: state.block, caret, type: 'merge-block'};
            }
          } else if (state.type === 'merge-block') {
            break;
          } else if ($isSiblingCaret(caret)) {
            if ($isElementNode(caret.origin)) {
              if (!caret.origin.isInline()) {
                state = {block: caret.origin, type: 'merge-next-block'};
              } else if (!caret.origin.isParentOf(initialRange.anchor.origin)) {
                break;
              }
              continue;
            } else if ($isDecoratorNode(caret.origin)) {
              if (caret.origin.isIsolated()) {
                // do nothing, shouldn't delete an isolated decorator
              } else if (
                state.type === 'merge-next-block' &&
                (caret.origin.isKeyboardSelectable() ||
                  !caret.origin.isInline()) &&
                $isElementNode(initialRange.anchor.origin) &&
                initialRange.anchor.origin.isEmpty()
              ) {
                // If the anchor is an empty element that is adjacent to a
                // decorator then we remove the paragraph and select the
                // decorator
                initialRange.anchor.origin.remove();
                const nodeSelection = $createNodeSelection();
                nodeSelection.add(caret.origin.getKey());
                $setSelection(nodeSelection);
              } else {
                // When the anchor is not an empty element then the
                // adjacent decorator is removed
                const decorator = caret.origin;
                const container = decorator.getParent();
                decorator.remove();
                const restored = $restoreEmptyContainerParagraph(
                  container,
                  decorator,
                );
                if (restored !== null) {
                  restored.selectStart();
                }
              }
              // always stop when a decorator is encountered
              return;
            } else if ($isLineBreakNode(caret.origin)) {
              // A LineBreakNode is a single deletable unit, same as a
              // decorator: remove it directly instead of falling through to
              // the slot-edge boundary check below with nothing deleted.
              caret.origin.remove();
              return;
            }
            break;
          }
        }
        if (state.type === 'merge-block') {
          // `block` is the anchor-side block; `caret.origin` is the
          // adjacent (previous-direction) block we descended into.
          const {caret, block} = state;
          // The cross-block merge below removes `block` (it merges into the
          // adjacent block). If `block` owns slots, that removal would discard
          // them, since slots are not children and are not carried over. Leave
          // the caret in place instead: unlike an adjacent decorator host,
          // which backspace removes as a whole unit (slots included, #8904),
          // merging would keep the host's children while silently dropping
          // its slots.
          if ($getSlotNames(block).length > 0) {
            return;
          }
          // Empty adjacent block at the same nesting level: remove it
          // instead of merging, so the current block's type (e.g.
          // heading) survives. Limiting to a shared parent leaves
          // structural wrappers like a ListNode containing an empty
          // ListItemNode to the default cross-block merge — the
          // ListNode is not considered empty just because its only
          // child is.
          if (
            caret.origin.isEmpty() &&
            !block.isEmpty() &&
            caret.origin.getParent() === block.getParent()
          ) {
            caret.origin.remove(true);
            return;
          }
          $updateRangeSelectionFromCaretRange(
            this,
            $getCaretRange(
              !caret.origin.isEmpty() && block.isEmpty()
                ? $rewindSiblingCaret($getSiblingCaret(block, caret.direction))
                : initialRange.anchor,
              caret,
            ),
          );
          return this.removeText();
        }
        // No text lies in the deletion direction and nothing in scope was
        // found to delete, so the caret sits at a slot edge. A slot value is
        // nested within its host's DOM, so the boundary lives only in the
        // model: the native caret measurement below would cross it and
        // select into the host. Stop when that edge is a slot value — the
        // slot link is a virtual shadow root, so this applies whether or not
        // the value is itself a shadow root; an ordinary (non-slotted)
        // shadow root keeps the native behavior.
        for (let node: LexicalNode | null = anchor.getNode(); node !== null; ) {
          if ($getSlotHostKey(node) !== null) {
            return;
          }
          if ($isElementNode(node) && node.isShadowRoot()) {
            break;
          }
          node = node.getParent();
        }
      }

      // Handle the deletion around decorators.
      const focus = this.focus;
      // Extend the selection in the model rather than with the native
      // modify('extend'), which would clobber the X11 PRIMARY selection.
      // See https://github.com/meta/lexical/issues/8766
      $extendSelectionForDeletion(this, isBackward, 'character');

      if (!this.isCollapsed()) {
        const focusNode = focus.type === 'text' ? focus.getNode() : null;
        anchorNode = anchor.type === 'text' ? anchor.getNode() : null;

        if (focusNode !== null && focusNode.isSegmented()) {
          const offset = focus.offset;
          const textContentSize = focusNode.getTextContentSize();
          if (
            focusNode.is(anchorNode) ||
            (isBackward && offset !== textContentSize) ||
            (!isBackward && offset !== 0)
          ) {
            $removeSegment(focusNode, isBackward, offset);
            return;
          }
        } else if (anchorNode !== null && anchorNode.isSegmented()) {
          const offset = anchor.offset;
          const textContentSize = anchorNode.getTextContentSize();
          if (
            anchorNode.is(focusNode) ||
            (isBackward && offset !== 0) ||
            (!isBackward && offset !== textContentSize)
          ) {
            $removeSegment(anchorNode, isBackward, offset);
            return;
          }
        }
        $updateCaretSelectionForUnicodeCharacter(this, isBackward);
      } else if (isBackward && anchor.offset === 0) {
        // Special handling around rich text nodes
        if ($collapseAtStart(this, anchor.getNode())) {
          return;
        }
      }
    }
    if (!wasCollapsed) {
      // Widen a whole-document range to the blocks themselves, so this removes
      // them outright rather than emptying them and leaving the last one behind
      // as an empty heading/quote/list (#5835).
      INTERNAL_$expandSelectionToWholeDocument(this);
    }
    this.removeText();
    if (
      isBackward &&
      !wasCollapsed &&
      this.isCollapsed() &&
      this.anchor.type === 'element' &&
      this.anchor.offset === 0
    ) {
      $ensureRootHasParagraph();
    }
  }

  /**
   * Performs one logical line deletion operation on the EditorState based on the current Selection.
   * Handles different node types.
   *
   * @param isBackward whether or not the selection is backwards.
   */
  deleteLine(isBackward: boolean): void {
    $deleteTextByGranularity(this, isBackward, 'lineboundary');
  }

  /**
   * Performs one logical word deletion operation on the EditorState based on the current Selection.
   * Handles different node types.
   *
   * @param isBackward whether or not the selection is backwards.
   */
  deleteWord(isBackward: boolean): void {
    $deleteTextByGranularity(this, isBackward, 'word');
  }

  /**
   * Returns whether the Selection is "backwards", meaning the focus
   * logically precedes the anchor in the EditorState.
   * @returns true if the Selection is backwards, false otherwise.
   */
  isBackward(): boolean {
    const cached = this._cachedIsBackward;
    if (cached !== null) {
      return cached;
    }
    const isBackward = this.focus.isBefore(this.anchor);
    if (!isCurrentlyReadOnlyMode()) {
      this._cachedIsBackward = isBackward;
    }
    return isBackward;
  }

  getStartEndPoints(): [PointType, PointType] {
    return [this.anchor, this.focus];
  }
}

/** Returns true if the given value is a NodeSelection. */
export function $isNodeSelection(x: unknown): x is NodeSelection {
  return x instanceof NodeSelection;
}

/** Shared word/line deletion after any operation-specific redirection. */
function $deleteTextByGranularity(
  selection: RangeSelection,
  isBackward: boolean,
  granularity: 'word' | 'lineboundary',
): void {
  const wasCollapsed = selection.isCollapsed();
  const {anchor, focus} = selection;
  // Set when the deletion stops at a slot boundary, which it never crosses.
  let stoppedAtSlot = false;
  if (wasCollapsed) {
    if (
      granularity === 'word' &&
      selection.forwardDeletion(anchor, anchor.getNode(), isBackward)
    ) {
      return;
    }
    stoppedAtSlot = $extendSelectionForDeletion(
      selection,
      isBackward,
      granularity,
    );
    if (granularity === 'lineboundary') {
      $stopLineDeletionAtLineBreak(selection);
    }
  }
  // Line deletion must remain in one block; word deletion may cross blocks.
  if (
    granularity === 'lineboundary' &&
    !selection.isCollapsed() &&
    $findMatchingParent(anchor.getNode(), INTERNAL_$isBlock) !==
      $findMatchingParent(focus.getNode(), INTERNAL_$isBlock)
  ) {
    focus.set(anchor.key, anchor.offset, anchor.type);
  }
  if (selection.isCollapsed()) {
    // Stopped at a slot boundary with nothing before it: a no-op.
    if (!stoppedAtSlot) {
      selection.deleteCharacter(isBackward);
    }
  } else {
    // An existing whole-document selection deletes its blocks (#5835).
    // Extending a collapsed caret over a word or line keeps that block.
    if (!wasCollapsed) {
      INTERNAL_$expandSelectionToWholeDocument(selection);
    }
    selection.removeText();
  }
}

/**
 * Pulls a line deletion's focus back to the anchor's side of the first
 * LineBreakNode between them, since a line ends at a hard break. The native
 * measurement can land past one when a line begins with an inline decorator:
 * Chromium may have no caret position between it and the <br> (#6916), and
 * then measures the line's start on the line before. From the start of a line
 * the selection ends up collapsed, and deleteCharacter removes the break.
 */
function $stopLineDeletionAtLineBreak(selection: RangeSelection): void {
  for (const caret of $caretRangeFromSelection(selection).iterNodeCarets(
    'shadowRoot',
  )) {
    if ($isSiblingCaret(caret) && $isLineBreakNode(caret.origin)) {
      $setPointFromCaret(selection.focus, $rewindSiblingCaret(caret));
      return;
    }
  }
}

/**
 * Apply a pure bitmask transform to every formattable node, using caret
 * slices to isolate partially selected text. ElementNodes use textFormat.
 */
function $updateTextFormat(
  selection: RangeSelection | NodeSelection,
  applyFormat: (format: number) => number,
): void {
  if ($isNodeSelection(selection)) {
    for (const node of selection.getNodes()) {
      if ($isInlineFormattable(node)) {
        node.setFormat(applyFormat(node.getFormat()));
      }
    }
    return;
  }

  const nodes = selection.isCollapsed() ? [] : selection.getNodes();
  const slices = nodes.length
    ? $caretRangeFromSelection(selection).getTextSlices()
    : [];
  let hasText = false;
  let skippedStart: PointType | undefined;
  let firstText: TextNode | undefined;
  let firstFormat: number | undefined;
  let lastFormat = 0;
  for (const node of nodes) {
    if ($isTextNode(node)) {
      // Main's multi-text-node path moves a skipped text-edge start to
      // the first formatted node, including when the final slice is empty.
      if (skippedStart && firstText) {
        skippedStart.set(firstText.__key, 0, 'text');
        skippedStart = undefined;
      }
      const slice = $getTextPointCaretSliceForNode(slices, node);
      if (!hasText && slice && slice.distance === 0) {
        const start = selection.isBackward()
          ? selection.focus
          : selection.anchor;
        if (start.type === 'text' && start.key === node.__key) {
          skippedStart = start;
        }
      }
      hasText = true;
      if (slice && slice.distance === 0) {
        continue;
      }
      const nextFormat = applyFormat(node.getFormat());
      const originalSize = skippedStart ? node.getTextContentSize() : 0;
      const replacement =
        slice && !$isTokenOrSegmented(node)
          ? $splitTextPointCaretSlice(slice, selection)
          : node;
      if (replacement !== null) {
        replacement.setFormat(nextFormat);
        if (firstFormat === undefined) {
          firstFormat = nextFormat;
          firstText = replacement;
          // A single partial TextNode also repins the text endpoints after
          // splitting. A whole-node or atomic-node selection keeps them.
          if (
            skippedStart &&
            replacement.getTextContentSize() !== originalSize
          ) {
            skippedStart.set(replacement.__key, 0, 'text');
            skippedStart = undefined;
          }
        }
        lastFormat = nextFormat;
      }
    } else if ($isElementNode(node)) {
      node.setTextFormat(applyFormat(node.getTextFormat()));
    } else if ($isInlineFormattable(node)) {
      node.setFormat(applyFormat(node.getFormat()));
    }
  }
  if (!hasText) {
    selection.setFormat(applyFormat(selection.format));
    $setCompositionKey(null);
  } else if (firstFormat !== undefined) {
    selection.format = firstFormat | lastFormat;
  }
}

/**
 * Explicitly sets or unsets text formats on the selection. Unlike $formatText
 * which toggles based on the current selection state, this function sets each
 * specified format to the exact boolean value provided. Mutually exclusive
 * formats (subscript/superscript, lowercase/uppercase/capitalize) are
 * reconciled by {@link toggleTextFormatType}, with later entries winning when
 * the requested formats conflict.
 *
 * @param selection - the selection whose nodes should be formatted.
 * @param formats - a partial record mapping TextFormatType to boolean.
 */
export function $setTextFormat(
  selection: RangeSelection | NodeSelection,
  formats: Partial<Record<TextFormatType, boolean>>,
): void {
  const entries: [TextFormatType, boolean][] = [];
  for (const [type, value] of Object.entries(formats) as [
    TextFormatType,
    boolean | undefined,
  ][]) {
    if (typeof value === 'boolean') {
      entries.push([type, value]);
    }
  }
  if (entries.length === 0) {
    return;
  }
  $updateTextFormat(selection, format => {
    for (const [type, value] of entries) {
      format = toggleTextFormatType(
        format,
        type,
        value ? TEXT_TYPE_TO_FORMAT[type] : 0,
      );
    }
    return format;
  });
}

/**
 * Applies the provided format to TextNodes and inline formattable nodes
 * (e.g. DecoratorTextNode) in the selection, splitting or merging TextNodes
 * as necessary and aligning all formattable nodes to the same target format.
 *
 * For RangeSelection the toggle direction is determined by the selection's
 * computed format (intersection of all text nodes) when no explicit alignment
 * is given. For NodeSelection each node is toggled independently when no
 * explicit alignment is given, since there is no TextNode to use as an
 * alignment reference.
 *
 * @param selection - the selection whose nodes should be formatted.
 * @param formatType - the format type to apply.
 * @param alignWithFormat - optional 32-bit bitmask to align with.
 */
export function $formatText(
  selection: RangeSelection | NodeSelection,
  formatType: TextFormatType,
  alignWithFormat: number | null = null,
): void {
  const effectiveAlign =
    alignWithFormat === null && $isRangeSelection(selection)
      ? toggleTextFormatType(selection.format, formatType, null)
      : alignWithFormat;
  $updateTextFormat(selection, format =>
    toggleTextFormatType(format, formatType, effectiveAlign),
  );
}

function getCharacterOffset(point: PointType): number {
  const offset = point.offset;
  if (point.type === 'text') {
    return offset;
  }

  const parent = point.getNode();
  return offset === parent.getChildrenSize()
    ? parent.getTextContent().length
    : 0;
}

/** Returns the character offsets of the selection's anchor and focus points as an [anchor, focus] tuple. */
export function $getCharacterOffsets(
  selection: BaseSelection,
): [number, number] {
  const anchorAndFocus = selection.getStartEndPoints();
  if (anchorAndFocus === null) {
    return [0, 0];
  }
  const [anchor, focus] = anchorAndFocus;
  if (
    anchor.type === 'element' &&
    focus.type === 'element' &&
    anchor.key === focus.key &&
    anchor.offset === focus.offset
  ) {
    return [0, 0];
  }
  return [getCharacterOffset(anchor), getCharacterOffset(focus)];
}

function $collapseAtStart(
  selection: RangeSelection,
  startNode: LexicalNode,
): boolean {
  for (
    let node: null | LexicalNode = startNode;
    node;
    node = node.getParent()
  ) {
    if ($isElementNode(node)) {
      if (node.collapseAtStart(selection)) {
        return true;
      }
      if ($isRootOrShadowRoot(node)) {
        break;
      }
    }
    if (node.getPreviousSibling()) {
      break;
    }
  }
  return false;
}

/**
 * When `selection` covers the whole document, widen it to the root's own
 * element points, so the range describes the top-level blocks themselves
 * rather than only the text inside them.
 *
 * A delete over that range then removes the blocks outright and leaves the
 * editor on a fresh empty paragraph, instead of gutting them and leaving an
 * empty heading, quote or list behind that keeps its type and styles the next
 * character typed (#5835). It also keeps a cut honest: what lands on the
 * clipboard is what leaves the document, so Cmd+X then Cmd+V restores the
 * blocks rather than their bare text.
 *
 * Widening rather than deleting-then-repairing is what makes this safe for
 * every block type. The range simply contains the blocks, so nothing has to
 * decide whether a heading, a nested list, a code block or a third-party node
 * should dissolve, and no node is destroyed that the user did not select.
 *
 * A no-op for anything else: a range that stops short of either end is an
 * ordinary edit inside the blocks it touches, and a select-all scoped to a
 * named slot never covers the root.
 */
export function INTERNAL_$expandSelectionToWholeDocument(
  selection: RangeSelection,
): void {
  const root = $getRoot();
  if (root.isEmpty() || !$isBlockFullySelected(root, selection)) {
    return;
  }
  selection.anchor.set(root.getKey(), 0, 'element');
  selection.focus.set(root.getKey(), root.getChildrenSize(), 'element');
}

function $swapPoints(selection: RangeSelection): void {
  const focus = selection.focus;
  const anchor = selection.anchor;
  const anchorKey = anchor.key;
  const anchorOffset = anchor.offset;
  const anchorType = anchor.type;

  anchor.set(focus.key, focus.offset, focus.type, true);
  focus.set(anchorKey, anchorOffset, anchorType, true);
}

/**
 * True when `node` is a DOM Text node with at least one code unit on the
 * `direction` side of `offset`, so a character-granularity caret movement in
 * that direction must land inside the very same text node.
 */
function canMoveWithinDOMText(
  node: Node | null,
  offset: number,
  direction: 'backward' | 'forward' | 'left' | 'right',
): boolean {
  if (node === null || node.nodeType !== DOM_TEXT_TYPE) {
    return false;
  }
  if (direction === 'backward') {
    return offset > 0;
  } else if (direction === 'forward') {
    return offset < (node as Text).length;
  }
  // 'left'/'right' are visual directions, so which side of the offset they
  // consume depends on the bidi level; no caller uses them today.
  return false;
}

function moveNativeSelection(
  domSelection: Selection,
  alter: 'move' | 'extend',
  direction: 'backward' | 'forward' | 'left' | 'right',
  granularity: 'character' | 'word' | 'lineboundary',
  rootElement: HTMLElement | null,
): void {
  // A caret that sits where a line soft-wraps has two visual positions for
  // one DOM offset (end of the previous line, start of the next), and which
  // one it takes is a piece of engine state that the DOM selection API does
  // not expose. Firefox spends the first modify() call flipping between them
  // instead of moving, which leaves the caret — and therefore a backspace
  // measured from it — exactly where it started (#9100).
  const points =
    granularity === 'character'
      ? getDOMSelectionPoints(domSelection, rootElement)
      : null;
  // In the light DOM these alias the live Selection, so snapshot them.
  const focusNode = points && points.focusNode;
  const focusOffset = points ? points.focusOffset : 0;
  // Selection.modify() method applies a change to the current selection or cursor position,
  // but is still non-standard in some browsers.
  domSelection.modify(alter, direction, granularity);
  if (
    points === null ||
    !canMoveWithinDOMText(focusNode, focusOffset, direction)
  ) {
    return;
  }
  const nextPoints = getDOMSelectionPoints(domSelection, rootElement);
  if (
    nextPoints.focusNode === focusNode &&
    nextPoints.focusOffset === focusOffset
  ) {
    // Nothing moved even though the character to cross is in this very text
    // node, so the call was consumed by the line-affinity flip described
    // above. Ask for the movement again; a caret that genuinely cannot move
    // (the start or end of the document) stays put on this call too.
    domSelection.modify(alter, direction, granularity);
  }
}

/**
 * Validate that the selection respects `root` (the nearest root or shadow
 * root): if any selected node lies outside of it, shrink the selection to the
 * valid edge in the given direction. The valid node check is a safeguard
 * against an invalid selection, for which getNodes() returns an empty array.
 *
 * @returns true if the selection was shrunk
 */
function $shrinkSelectionToRoot(
  selection: RangeSelection,
  isBackward: boolean,
  root: LexicalNode,
): boolean {
  const nodes = selection.getNodes();
  const validNodes = nodes.filter(node => $hasAncestor(node, root));
  if (validNodes.length === 0 || validNodes.length === nodes.length) {
    return false;
  }
  const edgeNode = isBackward
    ? validNodes[0]
    : validNodes[validNodes.length - 1];
  const edgeElement = $isElementNode(edgeNode)
    ? edgeNode
    : edgeNode.getParentOrThrow();
  if (isBackward) {
    edgeElement.selectStart();
  } else {
    edgeElement.selectEnd();
  }
  return true;
}

/**
 * Extend a collapsed selection by one unit (`character`, `word` or
 * `lineboundary`) in the deletion direction without ever creating a
 * non-collapsed DOM selection.
 *
 * On Linux/X11, browsers propagate any non-collapsed DOM selection made
 * during a user gesture to the PRIMARY selection (the middle-click paste
 * buffer), so a deletion must never pass through a transient non-collapsed
 * DOM selection or every Backspace/Delete overwrites the user's paste
 * buffer (https://github.com/meta/lexical/issues/8766). A collapsed
 * caret never takes PRIMARY ownership, so the DOM caret is moved with the
 * native `modify('move')` to measure where the engine places the unit
 * boundary, and the `[original .. landed]` range is constructed in the
 * model only. `applyDOMRange` reads just the range's boundary points (it
 * never touches the DOM selection), giving the same point resolution,
 * decorator endpoint normalization, shadow-root shrink validation and
 * anchor/focus orientation as a native selection extension would, while
 * the DOM selection is only ever collapsed.
 *
 * When the measurement is not possible — no DOM selection or no
 * `Selection.modify` (headless environments can polyfill it), or an
 * unresolvable anchor — the selection is left collapsed, so the deletion
 * becomes a no-op for that keystroke.
 *
 * Returns true when the focus was stopped at a slot boundary.
 */
function $extendSelectionForDeletion(
  selection: RangeSelection,
  isBackward: boolean,
  granularity: 'character' | 'word' | 'lineboundary',
): boolean {
  // Decorator/block handling, resolved in the model exactly as modify() does.
  if (
    $modifySelectionAroundDecoratorsAndBlocks(
      selection,
      'extend',
      isBackward,
      granularity,
    )
  ) {
    return false;
  }
  const editor = getActiveEditor();
  const domSelection = getDOMSelection(getWindow(editor));
  if (!domSelection || typeof domSelection.modify !== 'function') {
    return false;
  }
  const blockCursorElement = editor._blockCursorElement;
  const rootElement = editor._rootElement;
  const anchor = selection.anchor;
  const focusNode = selection.focus.getNode();
  // A block cursor element left in the DOM would corrupt element offsets.
  if (
    rootElement !== null &&
    blockCursorElement !== null &&
    $isElementNode(focusNode) &&
    !focusNode.isInline() &&
    !focusNode.canBeEmpty()
  ) {
    removeDOMBlockCursorElement(blockCursorElement, editor, rootElement);
  }
  const $resolvePointDOM = (point: PointType): HTMLElement | Text | null => {
    const pointNode = point.getNode();
    const keyedDOM = editor.getElementByKey(point.key);
    return keyedDOM !== null && point.type === 'text' && $isTextNode(pointNode)
      ? $getDOMTextNode(pointNode, keyedDOM, editor)
      : keyedDOM;
  };
  // Resolve the model anchor to a DOM position (one end of the final range).
  const anchorNode = anchor.getNode();
  const anchorDOM = $resolvePointDOM(anchor);
  if (anchorDOM === null) {
    return false;
  }
  const anchorOffset = anchor.offset;
  // Measure from the FOCUS: the decorator/block pre-pass above may have
  // hopped the model focus past an inline decorator and returned false — the
  // shape where native caret movement is unreliable (it can refuse to move a
  // caret adjacent to contenteditable=false content). modify() runs the
  // native extend from the extent (the hopped focus); do the same here. For
  // an untouched collapsed selection the focus is the anchor.
  const wasCollapsed = selection.isCollapsed();
  const focus = selection.focus;
  const focusDOM = wasCollapsed ? anchorDOM : $resolvePointDOM(focus);
  if (focusDOM === null) {
    return false;
  }
  const focusOffset = focus.offset;
  // Sync a COLLAPSED DOM caret at the measurement origin (base === extent),
  // then move it by one unit to measure the engine's boundary. Neither
  // operation touches PRIMARY.
  setDOMSelectionBaseAndExtent(
    domSelection,
    focusDOM,
    focusOffset,
    focusDOM,
    focusOffset,
  );
  moveNativeSelection(
    domSelection,
    'move',
    isBackward ? 'backward' : 'forward',
    granularity,
    rootElement,
  );
  if (domSelection.rangeCount === 0) {
    return false;
  }
  // Inside a DOM shadow root getRangeAt(0) is retargeted to the host; read the
  // composed StaticRange (real nodes) where available. After a 'move' the DOM
  // selection is collapsed, so start === end === the landed caret.
  const landedRange =
    getComposedStaticRange(domSelection, rootElement) ||
    domSelection.getRangeAt(0);
  let landedContainer = landedRange.startContainer;
  let landedOffset = landedRange.startOffset;
  if (
    granularity === 'lineboundary' &&
    isDOMTextNode(landedContainer) &&
    getNearestEditorFromDOMNode(landedContainer) === editor
  ) {
    const landedNode = $getNodeFromDOM(landedContainer);
    if (
      $isDecoratorNode(landedNode) &&
      landedNode.isInline() &&
      !landedNode.isIsolated()
    ) {
      const decoratorDOM = editor.getElementByKey(landedNode.getKey());
      if (decoratorDOM !== null && decoratorDOM.contains(landedContainer)) {
        // A native line boundary can land in a decorator's private text.
        // Resolve it at the atomic node's edge; that text is not a TextNode
        // and applyDOMRange would otherwise leave the selection collapsed.
        landedContainer = decoratorDOM;
        landedOffset = isBackward ? 0 : decoratorDOM.childNodes.length;
      }
    }
  }
  // Native 'move' cannot cross inline-grid/flex span boundaries (#7301).
  // When at the deletion-side edge of an unmergeable TextNode, extend into
  // the adjacent sibling directly instead of relying on the native result.
  if (
    wasCollapsed &&
    granularity === 'character' &&
    anchor.type === 'text' &&
    $isTextNode(anchorNode) &&
    anchorNode.isUnmergeable()
  ) {
    const boundaryOffset = isBackward ? 0 : anchorNode.getTextContentSize();
    if (anchorOffset === boundaryOffset) {
      const sibling = $getSiblingCaret(
        anchorNode,
        isBackward ? 'previous' : 'next',
      ).getNodeAtCaret();
      if ($isTextNode(sibling)) {
        const sibOffset = isBackward ? sibling.getTextContentSize() - 1 : 1;
        selection.focus.set(sibling.__key, sibOffset, 'text');
        selection.dirty = true;
        return false;
      }
    }
  }
  // In-node character deletion (the common case): keep the focus in the
  // anchor's own text node. A native 'move' reports a caret that lands on a
  // text-node boundary as a position in the *adjacent* node, and that
  // representation changes how a later insertion (e.g. at a format or
  // keyword boundary) resolves. When the move lands inside the anchor node
  // its offset is used directly; landing on the node's edge is clamped to
  // that edge. Word/line deletions legitimately span nodes, so they use the
  // general path below.
  if (wasCollapsed && granularity === 'character' && anchor.type === 'text') {
    // The deletion-side edge of the anchor's text.
    const edgeOffset = isBackward ? 0 : anchorNode.getTextContentSize();
    const clampedOffset =
      landedContainer === anchorDOM
        ? landedOffset
        : anchorOffset !== edgeOffset
          ? edgeOffset
          : -1;
    if (clampedOffset >= 0) {
      if (clampedOffset !== anchorOffset) {
        selection.focus.set(anchor.key, clampedOffset, 'text');
        selection.dirty = true;
      }
      return false;
    }
  }
  // A slot boundary lives only in the model, so the native move can cross it.
  // Deletion never does: stop the focus at the boundary instead. Resolving
  // the range would clamp it into the landed point's frame and move the caret
  // out of its slot.
  const landedNode =
    editor._slotsUsed && $getNearestNodeFromDOMNode(landedContainer);
  const anchorFrame = landedNode ? $getSlotFrame(anchorNode) : null;
  const landedFrame = landedNode ? $getSlotFrame(landedNode) : null;
  if (
    landedNode &&
    !$isSameFrame(landedFrame, anchorFrame) &&
    $setPointAtSlotBoundary(
      selection.focus,
      anchorNode,
      anchorFrame,
      landedFrame,
      'deletion',
      () => !isBackward,
    )
  ) {
    return true;
  }
  // General path: reconstruct, in document order, the [original .. landed]
  // range a native extend would have produced. applyDOMRange only reads these
  // four boundary properties into the model, so a plain StaticRange-shaped
  // object is sufficient (and avoids a StaticRange constructor dependency).
  const [startContainer, startOffset, endContainer, endOffset] = isBackward
    ? [landedContainer, landedOffset, anchorDOM, anchorOffset]
    : [anchorDOM, anchorOffset, landedContainer, landedOffset];
  const root = $isRootNode(anchorNode)
    ? anchorNode
    : $getNearestRootOrShadowRoot(anchorNode);
  selection.applyDOMRange({
    collapsed: false,
    endContainer,
    endOffset,
    startContainer,
    startOffset,
  } as unknown as StaticRange);
  selection.dirty = true;
  if (!$shrinkSelectionToRoot(selection, isBackward, root) && isBackward) {
    // applyDOMRange set anchor = range start (the landed point); the deletion
    // anchor must stay at the original caret, so restore that orientation.
    $swapPoints(selection);
  }
  return false;
}

// Sets point, the focus of a selection or deletion whose anchor is in
// anchorFrame and whose focus is in focusFrame, to the slot boundary in the
// anchor's frame: the edge of the anchor's slot when the focus is outside it,
// the edge of the children of the host that owns focusFrame when that host is
// the frame's root or contains the anchor, and otherwise beside the host,
// past it for a selection (which keeps the host whole) and before it for a
// deletion (which stops at it). A deletion's focus then descends toward the
// anchor, as applyDOMRange would resolve it, so line deletion finds it in the
// anchor's block. The direction is resolved only when there is a boundary.
// Returns false when there is none.
function $setPointAtSlotBoundary(
  point: PointType,
  anchorNode: LexicalNode | null,
  anchorFrame: LexicalNode | null,
  focusFrame: LexicalNode | null,
  mode: 'selection' | 'deletion',
  resolveFocusAfterAnchor: () => boolean,
): boolean {
  const host = focusFrame && $getSlotHostInFrame(focusFrame, anchorFrame);
  if (host === null && anchorFrame === null) {
    return false;
  }
  const focusAfterAnchor = resolveFocusAfterAnchor();
  const hostParent = host && host.getParent();
  let parent: ElementNode;
  let offset: number;
  if (
    host === null ||
    hostParent === null ||
    (anchorNode !== null &&
      (host.is(anchorNode) || host.isParentOf(anchorNode)))
  ) {
    const edge = host || anchorFrame;
    if (!$isElementNode(edge)) {
      if (edge !== null) {
        $setPointToFrameEdge(point, edge, focusAfterAnchor);
      }
      return true;
    }
    parent = edge;
    offset = focusAfterAnchor ? edge.getChildrenSize() : 0;
  } else {
    parent = hostParent;
    offset =
      host.getIndexWithinParent() +
      (focusAfterAnchor === (mode === 'selection') ? 1 : 0);
  }
  if (mode === 'deletion') {
    $setDeletionFocus(point, parent, offset, !focusAfterAnchor);
  } else {
    point.set(parent.getKey(), offset, 'element');
  }
  return true;
}

// Sets focus to offset in parent, descending into the child on the anchor's
// side (before it for a forward deletion) down to text, but not into a
// shadow root or a non-element.
function $setDeletionFocus(
  focus: PointType,
  parent: ElementNode,
  offset: number,
  isBackward: boolean,
): void {
  for (;;) {
    const child = parent.getChildAtIndex(isBackward ? offset : offset - 1);
    if ($isTextNode(child)) {
      focus.set(
        child.getKey(),
        isBackward ? 0 : child.getTextContentSize(),
        'text',
      );
      return;
    }
    if (!$isElementNode(child) || $isRootOrShadowRoot(child)) {
      break;
    }
    parent = child;
    offset = isBackward ? 0 : child.getChildrenSize();
  }
  focus.set(parent.getKey(), offset, 'element');
}

/**
 * Called by `RangeSelection.deleteCharacter` to determine if
 * `$extendSelectionForDeletion` extended the selection further
 * than a user would expect for that operation.
 *
 * A short(?) JavaScript string vs. Unicode primer:
 *
 * Strings in JavaScript use an UTF-16 encoding, and the offsets into a
 * string are based on those UTF-16 *code units*. This is basically a
 * historical mistake (though logical at that time, decades ago), but
 * can never really be fixed for compatibility reasons.
 *
 * In Unicode, a *code point* is the combination of one or more *code units*.
 * and the range of a *code point* can fit into 21 bits.
 *
 * Every valid *code point* can be represented with one or two
 * *UTF-16 code units*. One unit is used when the code point is in the
 * Basic Multilingual Plane (BMP) and is `< 0xFFFF`. Anything outside
 * of that plane is encoded with a *surrogate pair* of *code units* and
 * `/[\uD800-\uDBFF][\uDC00-\uDFFF]/` is a regex that you could use to
 * find any valid *surrogate pair*. As far as Unicode is concerned, these
 * pairs represent a single *code point*, but in JavaScript, these pairs
 * have a length of 2 (`pair.charCodeAt(n)` is really returning a
 * UTF-16 *code unit*, not a unicode *code point*). It is possible to request
 * a *code point* with `pair.codePointAt(0)` and enumerate code points
 * in a string with `[...string]` but the offsets we work with, and
 * the string length, are based in *code units* so that functionality
 * is unfortunately not very useful here.
 *
 * This only gets us as far as *code points*. We now know that we must
 * consider that each *code point* can have a length of 1 or 2 in JavaScript
 * string distance. It gets even trickier because the visual representation
 * of a character is a *grapheme* (approximately what the user thinks of
 * as a character). A *grapheme* is one or more *code points*, and can
 * essentially be arbitrarily long, as there are many ways to combine
 * them.
 *
 * The native caret measurement has already extended our selection by one
 * *grapheme* in the direction we want to delete. Sounds great, it's done
 * a lot of awfully tricky work for us because this functionality has only
 * recently become available in JavaScript via `Intl.Segmenter`. The
 * problem is that in many cases the expected behavior of backspace or
 * delete is *not always to delete a whole grapheme*. In some languages
 * it's always expected that backspace ought to delete one code point, not the
 * whole grapheme. In other situations such as emoji that use variation
 * selectors you *do* want to delete the whole *grapheme*.
 *
 * In a few situations the behavior is even application dependent, such as
 * with latin languages where you have multiple ways to represent the same
 * character visually (e.g. a letter with an accent in one code point, or a
 * letter followed by a combining mark in a second code point); some apps will
 * delete the whole grapheme and others will delete only the combining mark,
 * probably based on whether they perform some sort of *normalization* on their
 * input to ensure that only one form is used when two sequences of code points
 * can represent the same visual character. Lexical currently chooses not
 * to perform any normalization so this type of combining marks will be
 * deleted as a *code point* without deleting the whole *grapheme*.
 *
 * See also:
 * https://www.unicode.org/versions/Unicode16.0.0/core-spec/chapter-2/#G25564
 * https://www.unicode.org/versions/Unicode16.0.0/core-spec/chapter-3/#G30602
 * https://www.unicode.org/versions/Unicode16.0.0/core-spec/chapter-3/#G49537
 * https://mathiasbynens.be/notes/javascript-unicode
 */
function $updateCaretSelectionForUnicodeCharacter(
  selection: RangeSelection,
  isBackward: boolean,
): void {
  const anchor = selection.anchor;
  const focus = selection.focus;
  const anchorNode = anchor.getNode();
  const focusNode = focus.getNode();

  if (
    anchorNode === focusNode &&
    anchor.type === 'text' &&
    focus.type === 'text'
  ) {
    // Handling of multibyte characters
    const anchorOffset = anchor.offset;
    const focusOffset = focus.offset;
    const isBefore = anchorOffset < focusOffset;
    const startOffset = isBefore ? anchorOffset : focusOffset;
    const endOffset = isBefore ? focusOffset : anchorOffset;
    const characterOffset = endOffset - 1;

    if (startOffset !== characterOffset) {
      const text = anchorNode.getTextContent().slice(startOffset, endOffset);
      if (shouldDeleteExactlyOneCodeUnit(text)) {
        if (isBackward) {
          focus.set(focus.key, characterOffset, focus.type);
        } else {
          anchor.set(anchor.key, characterOffset, anchor.type);
        }
      }
    }
  }
}

function shouldDeleteExactlyOneCodeUnit(text: string) {
  if (__DEV__) {
    invariant(
      text.length > 1,
      'shouldDeleteExactlyOneCodeUnit: expecting to be called only with sequences of two or more code units',
    );
  }
  return !(doesContainSurrogatePair(text) || doesContainEmoji(text));
}

/**
 * Given the wall of text in $updateCaretSelectionForUnicodeCharacter, you'd
 * think that the solution might be complex, but the only currently known
 * cases given the above constraints where we want to delete a whole grapheme
 * are when emoji is involved. Since ES6 we can use unicode character classes
 * in regexp which makes this simple.
 *
 * It may make sense to add to this heuristic in the future if other
 * edge cases are discovered, which is why detailed notes remain.
 *
 * This is implemented with runtime feature detection and will always
 * return false on pre-2020 platforms that do not have unicode character
 * class support.
 */
/**
 * Feature-detect Unicode property escapes and return the emoji test. A
 * function declared side-effect free (so the build annotates the call below)
 * rather than an IIFE at module scope: an IIFE containing a `try` is a side
 * effect to bundlers, which would pin this module — and with it most of
 * `lexical` — into every bundle that imports it.
 *
 * @__NO_SIDE_EFFECTS__
 */
function createEmojiTest(): (text: string) => boolean {
  try {
    const re = new RegExp('\\p{Emoji}', 'u');
    const test = re.test.bind(re);
    // Sanity check a few emoji to make sure the regexp was parsed
    // and works correctly. Any one of these should be sufficient,
    // but they're cheap and it only runs once.
    if (
      // Emoji in the BMP (heart) with variation selector
      test('\u2764\ufe0f') &&
      // Emoji in the BMP (#) with variation selector
      test('#\ufe0f\u20e3') &&
      // Emoji outside the BMP (thumbs up) that is encoded with a surrogate pair
      test('\ud83d\udc4d')
    ) {
      return test;
    }
  } catch (_e) {
    // SyntaxError
  }
  // fallback, surrogate pair already checked
  return () => false;
}

const doesContainEmoji: (text: string) => boolean = createEmojiTest();

function $removeSegment(
  node: TextNode,
  isBackward: boolean,
  offset: number,
): void {
  const textNode = node;
  const textContent = textNode.getTextContent();
  const split = textContent.split(/(?=\s)/g);
  const splitLength = split.length;
  let segmentOffset = 0;
  let restoreOffset: number | undefined = 0;

  for (let i = 0; i < splitLength; i++) {
    const text = split[i];
    const isLast = i === splitLength - 1;
    restoreOffset = segmentOffset;
    segmentOffset += text.length;

    if (
      (isBackward && segmentOffset === offset) ||
      segmentOffset > offset ||
      isLast
    ) {
      split.splice(i, 1);
      if (isLast) {
        restoreOffset = undefined;
      }
      break;
    }
  }
  const nextTextContent = split.join('').trim();

  if (nextTextContent === '') {
    textNode.remove();
  } else {
    textNode.setTextContent(nextTextContent);
    textNode.select(restoreOffset, restoreOffset);
  }
}

function shouldResolveAncestor(
  resolvedElement: ElementNode,
  resolvedOffset: number,
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

export function $internalResolveSelectionPoint(
  dom: Node,
  offset: number,
  lastPoint: null | PointType,
  editor: LexicalEditor,
): null | [point: PointType, dirty: boolean] {
  let resolvedOffset = offset;
  let resolvedNode: TextNode | LexicalNode | null;
  // True when the DOM position is not directly representable in the
  // Lexical tree (e.g. the caret landed inside a void/empty element
  // such as <col> or in another unmanaged subtree) and the resolution
  // had to walk up to a Lexical ancestor. The caller marks the
  // resulting selection dirty so the reconciler writes a valid DOM
  // caret back instead of leaving the user's cursor "stuck" inside
  // unmanaged DOM.
  let dirty = false;
  // If we have selection on an element, we will
  // need to figure out (using the offset) what text
  // node should be selected.

  if (isHTMLElement(dom)) {
    // Resolve element to a ElementNode, or TextNode, or null
    let moveSelectionToEnd = false;
    // Given we're moving selection to another node, selection is
    // definitely dirty.
    // We use the anchor to find which child node to select
    const childNodes = dom.childNodes;
    const childNodesLength = childNodes.length;
    const blockCursorElement = editor._blockCursorElement;
    // If the anchor is the same as length, then this means we
    // need to select the very last text node.
    if (resolvedOffset === childNodesLength && childNodesLength > 0) {
      moveSelectionToEnd = true;
      resolvedOffset = childNodesLength - 1;
    }
    if (
      getNodeKeyFromDOMNode(dom, editor) === undefined &&
      !isDOMCapturingSelection(dom, editor)
    ) {
      // The DOM caret is sitting on a node that has no Lexical key
      // (e.g. <col> inside an unmanaged <colgroup>, or any unmanaged
      // scaffolding around a DOMSlot — wrap elements, contenteditable=false
      // labels, badges, etc.). Resolution will walk up to find a Lexical
      // ancestor below, so the resulting Lexical position will not
      // correspond to where the DOM caret currently is. Mark the
      // selection dirty so the reconciler writes a valid DOM caret back
      // at the resolved Lexical position.
      //
      // Exclusions split across the two guard clauses:
      //  - The first clause (`key !== undefined`) covers any DOM node
      //    with a `__lexicalKey_*` attribute — Lexical-managed elements
      //    and the editor root (stashed in `resetEditor`).
      //  - `isDOMCapturingSelection` covers DecoratorNode subtrees (which
      //    own their own DOM) and subtrees marked via
      //    `setDOMUnmanaged(dom, {captureSelection: true})` —
      //    extension-owned widgets that keep a native caret.
      //
      // Void elements that ARE Lexical nodes (LineBreakNode <br>,
      // empty decorator containers, etc.) have keys, so this check
      // leaves their existing resolution-to-parent behavior alone.
      dirty = true;
    }
    let childDOM = childNodes[resolvedOffset];
    let hasBlockCursor = false;
    if (childDOM === blockCursorElement) {
      childDOM = childNodes[resolvedOffset + 1];
      hasBlockCursor = true;
    } else if (blockCursorElement !== null) {
      const blockCursorElementParent = blockCursorElement.parentNode;
      if (dom === blockCursorElementParent) {
        const blockCursorOffset = Array.prototype.indexOf.call(
          blockCursorElementParent.children,
          blockCursorElement,
        );
        if (offset > blockCursorOffset) {
          resolvedOffset--;
        }
      }
    }
    resolvedNode = $getNodeFromDOM(childDOM);

    if ($isTextNode(resolvedNode)) {
      resolvedOffset = $getTextNodeOffset(
        resolvedNode,
        moveSelectionToEnd ? 'next' : 'previous',
      );
    } else {
      let resolvedElement = $getNodeFromDOM(dom);
      // Ensure resolvedElement is actually a element.
      if (resolvedElement === null) {
        return null;
      }
      if ($isElementNode(resolvedElement)) {
        const elementDOM = editor.getElementByKey(resolvedElement.getKey());
        invariant(
          elementDOM !== null,
          '$internalResolveSelectionPoint: node in DOM but not keyToDOMMap',
        );
        const slot = $getDOMSlot(resolvedElement, elementDOM, editor);
        [resolvedElement, resolvedOffset] = slot.resolveChildIndex(
          resolvedElement,
          elementDOM,
          dom,
          offset,
        );
        // This is just a typescript workaround, it is true but lost due to mutability
        invariant(
          $isElementNode(resolvedElement),
          '$internalResolveSelectionPoint: resolvedElement is not an ElementNode',
        );
        if (
          moveSelectionToEnd &&
          resolvedOffset >= resolvedElement.getChildrenSize()
        ) {
          resolvedOffset = Math.max(0, resolvedElement.getChildrenSize() - 1);
        }
        let child = resolvedElement.getChildAtIndex(resolvedOffset);
        if (
          $isElementNode(child) &&
          shouldResolveAncestor(child, resolvedOffset, lastPoint)
        ) {
          const descendant = moveSelectionToEnd
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
          resolvedNode = child;
          resolvedElement = null;
          resolvedOffset = $getTextNodeOffset(
            child,
            moveSelectionToEnd ? 'next' : 'previous',
          );
        } else if (
          child !== resolvedElement &&
          moveSelectionToEnd &&
          !hasBlockCursor
        ) {
          invariant($isElementNode(resolvedElement), 'invariant');
          resolvedOffset = Math.min(
            resolvedElement.getChildrenSize(),
            resolvedOffset + 1,
          );
        }
      } else {
        // A slot value is parentless — it links up to its host via
        // `__slotHost` and behaves like a shadow root. Anchor the caret
        // adjacent to the host (a normal child of its parent), since the slot
        // value itself has no parent to anchor in. Non-slotted leaves anchor
        // in their own parent as before.
        const slotHost = $getSlotHost(resolvedElement);
        const anchorNode = slotHost !== null ? slotHost : resolvedElement;
        const index = anchorNode.getIndexWithinParent();
        // For wrap patterns (slot exposes an inner content element via
        // `withElement`) defer to `slot.resolveLeafPosition` so the
        // wrap's structure determines "before vs after". For bare leaf
        // DOM we preserve the historical rule: only a DecoratorNode at
        // DOM offset 0 resolves to "before"; everything else (including
        // bare LineBreakNode) resolves to "after".
        const elementDOM = editor.getElementByKey(resolvedElement.getKey());
        let position: 'before' | 'after' = 'after';
        if (elementDOM !== null && $getNodeFromDOM(dom) === resolvedElement) {
          const slot = $getDOMSlot(resolvedElement, elementDOM, editor);
          if (slot.element !== elementDOM) {
            position = slot.resolveLeafPosition(elementDOM, dom, offset);
          } else if (offset === 0 && $isDecoratorNode(resolvedElement)) {
            position = 'before';
          }
        }
        resolvedOffset = position === 'before' ? index : index + 1;
        resolvedElement = anchorNode.getParentOrThrow();
      }
      if ($isElementNode(resolvedElement)) {
        return [
          $createPoint(resolvedElement.__key, resolvedOffset, 'element'),
          dirty,
        ];
      }
    }
  } else {
    // TextNode or null
    resolvedNode = $getNodeFromDOM(dom);
  }
  if (!$isTextNode(resolvedNode)) {
    return null;
  }
  return [
    $createPoint(
      resolvedNode.__key,
      $getTextNodeOffset(resolvedNode, resolvedOffset, 'clamp'),
      'text',
    ),
    dirty,
  ];
}

function $resolveSelectionPointOnBoundary(
  point: TextPointType,
  isBackward: boolean,
  isCollapsed: boolean,
): void {
  const node = point.getNode();
  if ($isEmptyCompositionTarget(node)) {
    // Keep the native IME's empty target rather than moving into the body.
    return;
  }
  const before = point.offset === 0;
  if (!before && point.offset !== node.getTextContent().length) {
    return;
  }
  const direction = before ? 'previous' : 'next';
  const sibling = $getSiblingCaret(node, direction).getNodeAtCaret();
  if (
    before !== isBackward &&
    $isElementNode(sibling) &&
    sibling.isInline() &&
    (!before || !isCollapsed)
  ) {
    point.set(sibling.__key, before ? sibling.getChildrenSize() : 0, 'element');
  } else if (before && !isBackward) {
    if ($isTextNode(sibling) && !node.isUnmergeable()) {
      point.set(sibling.__key, sibling.getTextContent().length, 'text');
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
        point.set(
          parentSibling.__key,
          before ? parentSibling.getTextContent().length : 0,
          'text',
        );
      }
    }
  }
}

function $normalizeSelectionPointsForBoundaries(
  anchor: PointType,
  focus: PointType,
  lastSelection: null | BaseSelection,
): void {
  if (anchor.type === 'text' && focus.type === 'text') {
    const isBackward = anchor.isBefore(focus);
    const isCollapsed = anchor.is(focus);

    // Attempt to normalize the offset to the previous sibling if we're at the
    // start of a text node and the sibling is a text node or inline element.
    $resolveSelectionPointOnBoundary(anchor, isBackward, isCollapsed);
    $resolveSelectionPointOnBoundary(focus, !isBackward, isCollapsed);

    if (isCollapsed) {
      focus.set(anchor.key, anchor.offset, anchor.type);
    }
  }
}

// The innermost slot-root ancestor of a point
// (a node whose up-pointer is __slotHost, not __parent), or null when the
// point is not inside any slot. Walking via getParent() naturally stops at a
// slot root because a slotted node's __parent is null. Non-slot trees have
// __slotHost === null everywhere, so this always returns null there.
export function $getPointSlotFrame(point: PointType): LexicalNode | null {
  const node = $getNodeByKey(point.key);
  return node === null ? null : $getSlotFrame(node);
}

// Slots are shadow-root-isolated: a RangeSelection must not straddle a slot
// boundary. When the anchor and focus are in different frames, clamp the
// focus into the anchor's frame (anchor-frame rule), keeping
// keyboard/mouse/programmatic results consistent. The direction is resolved
// (resolveFocusAfterAnchor) only on an actual straddle, because the
// DOM-read and programmatic callers determine it differently (DOM order vs
// the default slots-before-children rendering order). Returns true when it mutated the focus point. No-op
// (returns false) when both points share a frame — including the all-null
// case in non-slot trees, so behavior there is unchanged.
function $clampSelectionPointsToSlotFrame(
  anchorPoint: PointType,
  focusPoint: PointType,
  resolveFocusAfterAnchor: () => boolean,
): boolean {
  const anchorFrame = $getPointSlotFrame(anchorPoint);
  const focusFrame = $getPointSlotFrame(focusPoint);
  return (
    !$isSameFrame(anchorFrame, focusFrame) &&
    $setPointAtSlotBoundary(
      focusPoint,
      $getNodeByKey(anchorPoint.key),
      anchorFrame,
      focusFrame,
      'selection',
      resolveFocusAfterAnchor,
    )
  );
}

export function $isSameFrame(
  a: LexicalNode | null,
  b: LexicalNode | null,
): boolean {
  return a === null ? b === null : a.is(b);
}

// Sets point to the start or end of frame.
function $setPointToFrameEdge(
  point: PointType,
  frame: LexicalNode,
  atEnd: boolean,
): void {
  if ($isElementNode(frame)) {
    point.set(frame.getKey(), atEnd ? frame.getChildrenSize() : 0, 'element');
  } else {
    point.set(frame.getKey(), atEnd ? frame.getTextContentSize() : 0, 'text');
  }
}

// The host whose own frame is target (null for the main tree) and that owns
// frame, directly or through nested slots; null when there is none.
function $getSlotHostInFrame(
  frame: LexicalNode,
  target: LexicalNode | null,
): LexicalNode | null {
  for (let host = $getSlotHost(frame); host !== null; ) {
    const hostFrame = $getSlotFrame(host);
    if ($isSameFrame(hostFrame, target)) {
      // A host outside every slot is in the main tree only when attached.
      return hostFrame !== null || host.isAttached() ? host : null;
    }
    host = hostFrame && $getSlotHost(hostFrame);
  }
  return null;
}

/**
 * Programmatic counterpart of the DOM-read clamp: applied when a
 * RangeSelection is committed via $setSelection so an API-built selection
 * cannot straddle a slot boundary either. Direction comes from the default
 * slots-before-children rendering order
 * ({@link $comparePointCaretNextAcrossSlots}), not from the DOM, since
 * $setSelection also runs in headless mode where there is no DOM. An app that
 * mounts slot DOM elsewhere can see the focus clamped to the opposite edge
 * from where its DOM order would put it.
 * Marks the selection dirty when it mutates a point. No-op for non-slot trees
 * (both frames null), evaluated before any direction work, so non-slot and
 * headless callers are unaffected.
 *
 * @experimental named-slots
 * @internal
 */
export function $clampRangeSelectionToSlotFrame(
  selection: RangeSelection,
): boolean {
  const clamped = $clampSelectionPointsToSlotFrame(
    selection.anchor,
    selection.focus,
    () =>
      // Points are not normalized: that would move a point just before an
      // element host into its children, past the host's slot content.
      $comparePointCaretNextAcrossSlots(
        $caretFromPoint(selection.anchor, 'next'),
        $caretFromPoint(selection.focus, 'next'),
      ) !== 1,
  );
  if (clamped) {
    selection.dirty = true;
  }
  return clamped;
}

// Whether DOM point (b, bOffset) is at or after (a, aOffset), without the
// exceptions Range.comparePoint throws for stale offsets or separate trees.
function isDOMPointAtOrAfter(
  a: Node,
  aOffset: number,
  b: Node,
  bOffset: number,
): boolean {
  if (a === b) {
    return bOffset >= aOffset;
  }
  const position = a.compareDocumentPosition(b);
  if (position & Node.DOCUMENT_POSITION_CONTAINED_BY) {
    return getIndexOfChildContaining(a, b) >= aOffset;
  }
  if (position & Node.DOCUMENT_POSITION_CONTAINS) {
    return bOffset > getIndexOfChildContaining(b, a);
  }
  return (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

// The index within parent of its child that is or contains node.
function getIndexOfChildContaining(parent: Node, node: Node): number {
  let child: Node | null = node;
  while (child !== null && child.parentNode !== parent) {
    child = child.parentNode;
  }
  let index = 0;
  for (let n = child && child.previousSibling; n; n = n.previousSibling) {
    index++;
  }
  return index;
}

function $internalResolveSelectionPoints(
  anchorDOM: null | Node,
  anchorOffset: number,
  focusDOM: null | Node,
  focusOffset: number,
  editor: LexicalEditor,
  lastSelection: null | BaseSelection,
): null | [anchor: PointType, focus: PointType, dirty: boolean] {
  if (
    anchorDOM === null ||
    focusDOM === null ||
    !isSelectionWithinEditor(editor, anchorDOM, focusDOM)
  ) {
    return null;
  }
  const resolvedAnchor = $internalResolveSelectionPoint(
    anchorDOM,
    anchorOffset,
    $isRangeSelection(lastSelection) ? lastSelection.anchor : null,
    editor,
  );
  if (resolvedAnchor === null) {
    return null;
  }
  const resolvedFocus = $internalResolveSelectionPoint(
    focusDOM,
    focusOffset,
    $isRangeSelection(lastSelection) ? lastSelection.focus : null,
    editor,
  );
  if (resolvedFocus === null) {
    return null;
  }
  const [resolvedAnchorPoint, anchorDirty] = resolvedAnchor;
  const [resolvedFocusPoint, focusDirty] = resolvedFocus;
  if (__DEV__) {
    $validatePoint('anchor', resolvedAnchorPoint);
    $validatePoint('focus', resolvedFocusPoint);
  }
  if (
    resolvedAnchorPoint.type === 'element' &&
    resolvedFocusPoint.type === 'element'
  ) {
    const anchorNode = $getNodeFromDOM(anchorDOM);
    const focusNode = $getNodeFromDOM(focusDOM);
    // Ensure if we're selecting the content of a decorator that we
    // return null for this point, as it's not in the controlled scope
    // of Lexical.
    if ($isDecoratorNode(anchorNode) && $isDecoratorNode(focusNode)) {
      return null;
    }
  }

  // Clamp a slot-straddling drag into the
  // anchor's frame before normalization cleans up the resulting edge points.
  // The DOM order of the selection's points gives the drag direction, which
  // follows wherever the app mounted the slot DOM. Gated on `_slotsUsed`
  // so editors that never slot anything skip the walk, mirroring the
  // commit-time and `$setSelection` clamps.
  const slotClamped =
    editor._slotsUsed &&
    $clampSelectionPointsToSlotFrame(
      resolvedAnchorPoint,
      resolvedFocusPoint,
      () => isDOMPointAtOrAfter(anchorDOM, anchorOffset, focusDOM, focusOffset),
    );

  // Handle normalization of selection when it is at the boundaries.
  $normalizeSelectionPointsForBoundaries(
    resolvedAnchorPoint,
    resolvedFocusPoint,
    lastSelection,
  );

  return [
    resolvedAnchorPoint,
    resolvedFocusPoint,
    anchorDirty || focusDirty || slotClamped,
  ];
}

/** Returns true if the given node is a non-inline ElementNode. */
export function $isBlockElementNode(
  node: LexicalNode | null | undefined,
): node is ElementNode {
  return $isElementNode(node) && !node.isInline();
}

// This is used to make a selection when the existing
// selection is null, i.e. forcing selection on the editor
// when it current exists outside the editor.

export function $internalMakeRangeSelection(
  anchorKey: NodeKey,
  anchorOffset: number,
  focusKey: NodeKey,
  focusOffset: number,
  anchorType: 'text' | 'element',
  focusType: 'text' | 'element',
): RangeSelection {
  const editorState = getActiveEditorState();
  const selection = new RangeSelection(
    $createPoint(anchorKey, anchorOffset, anchorType),
    $createPoint(focusKey, focusOffset, focusType),
    0,
    '',
  );
  selection.dirty = true;
  editorState._selection = selection;
  return selection;
}

/** Creates a detached RangeSelection anchored at the root element origin (offset 0). */
export function $createRangeSelection(): RangeSelection {
  const anchor = $createPoint('root', 0, 'element');
  const focus = $createPoint('root', 0, 'element');
  return new RangeSelection(anchor, focus, 0, '');
}

/** Creates an empty NodeSelection with no selected node keys. */
export function $createNodeSelection(): NodeSelection {
  return new NodeSelection(new Set());
}

export function $internalCreateSelection(
  editor: LexicalEditor,
  event: UIEvent | Event | null,
): null | BaseSelection {
  const currentEditorState = editor.getEditorState();
  const lastSelection = currentEditorState._selection;
  const domSelection = getDOMSelection(getWindow(editor));

  if ($isRangeSelection(lastSelection) || lastSelection == null) {
    return $internalCreateRangeSelection(
      lastSelection,
      domSelection,
      editor,
      event,
    );
  }
  return lastSelection.clone();
}

/** Creates a RangeSelection from the given DOM selection, or returns null if one cannot be resolved. */
export function $createRangeSelectionFromDom(
  domSelection: Selection | null,
  editor: LexicalEditor,
): null | RangeSelection {
  return $internalCreateRangeSelection(null, domSelection, editor, null);
}

// Keys whose keydown handlers move the caret or edit at it themselves. Their
// shortcuts with Control or Meta do too (Control+H deletes backward on Apple
// platforms, Control or Meta+B formats), as can a paste, cut or copy that
// follows the keydown, so a keydown with either modifier counts as well.
const SELECTION_KEYS = /* @__PURE__ */ new Set([
  ' ',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Backspace',
  'Delete',
  'End',
  'Enter',
  'Home',
  'Tab',
]);

export function $internalCreateRangeSelection(
  lastSelection: null | BaseSelection,
  domSelection: Selection | null,
  editor: LexicalEditor,
  event: UIEvent | Event | null,
): null | RangeSelection {
  const windowObj = editor._window;
  if (windowObj === null) {
    return null;
  }
  // When we create a selection, we try to use the previous
  // selection where possible, unless an actual user selection
  // change has occurred. When we do need to create a new selection
  // we validate we can have text nodes for both anchor and focus
  // nodes. If that holds true, we then return that selection
  // as a mutable object that we use for the editor state for this
  // update cycle. If a selection gets changed, and requires a
  // update to native DOM selection, it gets marked as "dirty".
  // If the selection changes, but matches with the existing
  // DOM selection, then we only need to sync it. Otherwise,
  // we generally bail out of doing an update to selection during
  // reconciliation unless there are dirty nodes that need
  // reconciling.

  const windowEvent = event || windowObj.event;
  const eventType = windowEvent ? windowEvent.type : undefined;
  const isSelectionChange = eventType === 'selectionchange';
  // Chromium coalesces selectionchange events, so a caret move made natively
  // by one arrow key can still be unreported when the next keydown arrives
  // (key repeat, or a busy main thread). Reading the DOM here keeps that
  // keydown from acting on the caret from before the native move. Only a
  // keydown sent to this editor can follow such a move in it: a shortcut
  // handled elsewhere (a toolbar, a dialog, a global hotkey) that updates
  // this editor acts at the editor's own selection, not at a DOM selection
  // left behind in its root.
  const keyDown = eventType === 'keydown' && (windowEvent as KeyboardEvent);
  const target = keyDown && getComposedEventTarget(keyDown);
  const isSelectionKeyDown =
    keyDown &&
    (keyDown.ctrlKey || keyDown.metaKey || SELECTION_KEYS.has(keyDown.key)) &&
    isDOMNode(target) &&
    getNearestEditorFromDOMNode(target) === editor;
  const useDOMSelection =
    !getIsProcessingMutations() &&
    (isSelectionChange ||
      isSelectionKeyDown ||
      eventType === 'beforeinput' ||
      eventType === 'compositionstart' ||
      eventType === 'compositionend' ||
      (eventType === 'click' &&
        windowEvent &&
        (windowEvent as InputEvent).detail === 3) ||
      eventType === 'drop' ||
      eventType === undefined);
  let anchorDOM, focusDOM, anchorOffset, focusOffset;

  if (!$isRangeSelection(lastSelection) || useDOMSelection) {
    if (domSelection === null) {
      return null;
    }
    const points = getDOMSelectionPoints(domSelection, editor._rootElement);
    anchorDOM = points.anchorNode;
    focusDOM = points.focusNode;
    anchorOffset = points.anchorOffset;
    focusOffset = points.focusOffset;
    if (
      (isSelectionChange || isSelectionKeyDown || eventType === undefined) &&
      $isRangeSelection(lastSelection) &&
      !isSelectionWithinEditor(editor, anchorDOM, focusDOM)
    ) {
      return lastSelection.clone();
    }
  } else {
    return lastSelection.clone();
  }
  // Let's resolve the text nodes from the offsets and DOM nodes we have from
  // native selection.
  const resolvedSelectionPoints = $internalResolveSelectionPoints(
    anchorDOM,
    anchorOffset,
    focusDOM,
    focusOffset,
    editor,
    lastSelection,
  );
  if (resolvedSelectionPoints === null) {
    return null;
  }
  const [resolvedAnchorPoint, resolvedFocusPoint, dirty] =
    resolvedSelectionPoints;
  const previousRange = $isRangeSelection(lastSelection) ? lastSelection : null;
  const newSelection = new RangeSelection(
    resolvedAnchorPoint,
    resolvedFocusPoint,
    previousRange ? previousRange.format : 0,
    previousRange ? previousRange.style : '',
  );
  if (previousRange) {
    $internalRefreshSelectionFormatAndStyle(
      newSelection,
      previousRange.anchor.key,
    );
  }
  // This new selection is not published yet. Only point resolution decides
  // whether the DOM must be corrected; refreshing its format is not a move.
  newSelection.dirty = dirty;
  return newSelection;
}

/**
 * Re-reads the format and style that a collapsed insertion would use from the
 * selection's anchor, after `removeText` left the caret in a node it did not
 * start in (#6781).
 *
 * {@link $internalCreateRangeSelection} already does this for every selection
 * change that originates in the DOM (a click, an arrow key), which is why
 * those keep the toolbar in sync.
 *
 * Landing on the same node is not a move: a format toggled on a collapsed
 * caret is armed for the next insertion and is deliberately not backed by the
 * node yet, so it must survive being re-selected in place.
 *
 * Deliberately *not* called from `ElementNode.select()`/`TextNode.select()`:
 * those are how nearly every edit repositions its own caret, so refreshing
 * there discards a format armed with Cmd+B on the way through Enter,
 * Shift+Enter and paste.
 */
export function $internalRefreshSelectionFormatAndStyle(
  selection: RangeSelection,
  previousAnchorKey: NodeKey,
): void {
  const anchor = selection.anchor;
  if (anchor.key === previousAnchorKey) {
    return;
  }
  const anchorNode = anchor.getNode();
  let format = 0;
  let style = '';
  if ($isTextNode(anchorNode)) {
    format = anchorNode.getFormat();
    style = anchorNode.getStyle();
  } else if ($isElementNode(anchorNode)) {
    format = anchorNode.getTextFormat();
    style = anchorNode.getTextStyle();
  }
  if (selection.format !== format || selection.style !== style) {
    selection.format = format;
    selection.style = style;
    selection.dirty = true;
  }
}

function $validatePoint(name: 'anchor' | 'focus', point: PointType): void {
  const node = $getNodeByKey(point.key);
  invariant(
    node !== undefined,
    '$validatePoint: %s key %s not found in current editorState',
    name,
    point.key,
  );
  if (point.type === 'text') {
    invariant(
      $isTextNode(node),
      '$validatePoint: %s key %s is not a TextNode',
      name,
      point.key,
    );
    const size = node.getTextContentSize();
    invariant(
      point.offset <= size,
      '$validatePoint: %s point.offset > node.getTextContentSize() (%s > %s)',
      name,
      String(point.offset),
      String(size),
    );
  } else {
    invariant(
      $isElementNode(node),
      '$validatePoint: %s key %s is not an ElementNode',
      name,
      point.key,
    );
    const size = node.getChildrenSize();
    invariant(
      point.offset <= size,
      '$validatePoint: %s point.offset > node.getChildrenSize() (%s > %s)',
      name,
      String(point.offset),
      String(size),
    );
  }
}

/** Returns the current selection of the active editor state, or null if none exists. */
export function $getSelection(): null | BaseSelection {
  const editorState = getActiveEditorState();
  return editorState._selection;
}

/** Returns the selection from the previous editor state, or null if none existed. */
export function $getPreviousSelection(): null | BaseSelection {
  const editor = getActiveEditor();
  return editor._editorState._selection;
}

/**
 * Whether `selection` has a point directly on `parentNode`, which is exactly
 * the condition under which
 * {@link $updateElementSelectionOnCreateDeleteNode} does anything at all.
 * @internal
 *
 * Every caller of that function has to compute a child offset first, and
 * `getIndexWithinParent` walks the parent's children from the first one, so
 * doing it unconditionally makes a bulk insert or removal quadratic (#5194).
 * Guarding the walk with this predicate skips it whenever the update would
 * be a no-op. It is the same test the early return uses, so the two cannot
 * drift apart.
 *
 * Note that a point *inside* `parentNode` (a text point on one of its
 * descendants, say) does not count: the function only shifts offsets that
 * are element-anchored on `parentNode` itself.
 *
 * This function is for internal use of the library.
 * Please do not use it as it may change in the future.
 */
export function $selectionTouchesElement(
  selection: RangeSelection,
  parentNode: LexicalNode,
): boolean {
  const parentKey = parentNode.__key;
  return (
    selection.anchor.key === parentKey || selection.focus.key === parentKey
  );
}

export function $updateElementSelectionOnCreateDeleteNode(
  selection: RangeSelection,
  parentNode: LexicalNode,
  nodeOffset: number,
  times = 1,
): void {
  if (!$selectionTouchesElement(selection, parentNode)) {
    return;
  }
  // Both endpoints obey the same offset rule, regardless of range direction
  // or collapse. Then resolve each element point to an adjacent text child.
  for (const point of [selection.anchor, selection.focus]) {
    if (
      point.key === parentNode.__key &&
      ((nodeOffset <= point.offset && times > 0) ||
        (nodeOffset < point.offset && times < 0))
    ) {
      point.set(parentNode.__key, Math.max(0, point.offset + times), 'element');
    }
    const node = point.getNode();
    if ($isElementNode(node)) {
      const size = node.getChildrenSize();
      const atEnd = point.offset >= size;
      const child = node.getChildAtIndex(atEnd ? size - 1 : point.offset);
      if ($isTextNode(child)) {
        point.set(child.__key, atEnd ? child.getTextContentSize() : 0, 'text');
      }
    }
  }
}

export function applySelectionTransforms(
  nextEditorState: EditorState,
  editor: LexicalEditor,
): void {
  const prevEditorState = editor.getEditorState();
  const prevSelection = prevEditorState._selection;
  const nextSelection = nextEditorState._selection;
  if ($isRangeSelection(nextSelection)) {
    const anchor = nextSelection.anchor;
    const focus = nextSelection.focus;
    let anchorNode;

    if (anchor.type === 'text') {
      anchorNode = anchor.getNode();
      anchorNode.selectionTransform(prevSelection, nextSelection);
    }
    if (focus.type === 'text') {
      const focusNode = focus.getNode();
      if (anchorNode !== focusNode) {
        focusNode.selectionTransform(prevSelection, nextSelection);
      }
    }
  }
}

export function moveSelectionPointToSibling(
  point: PointType,
  node: LexicalNode,
  parent: ElementNode,
  prevSibling: LexicalNode | null,
  nextSibling: LexicalNode | null,
): void {
  const sibling = prevSibling || nextSibling;
  if ($isTextNode(sibling) || $isElementNode(sibling)) {
    const isText = $isTextNode(sibling);
    point.set(
      sibling.__key,
      prevSibling === null
        ? 0
        : isText
          ? sibling.getTextContentSize()
          : sibling.getChildrenSize(),
      isText ? 'text' : 'element',
    );
  } else {
    const offset = node.getIndexWithinParent();
    point.set(
      parent.__key,
      offset === -1 ? parent.getChildrenSize() : offset,
      'element',
    );
  }
}

export function adjustPointOffsetForMergedSibling(
  point: PointType,
  isBefore: boolean,
  key: NodeKey,
  target: TextNode,
  textLength: number,
): void {
  if (point.type === 'text') {
    point.set(key, point.offset + (isBefore ? 0 : textLength), 'text');
  } else if (point.offset > target.getIndexWithinParent()) {
    point.set(point.key, point.offset - 1, 'element');
  }
}

function setDOMSelectionBaseAndExtent(
  domSelection: Selection,
  nextAnchorDOM: HTMLElement | Text,
  nextAnchorOffset: number,
  nextFocusDOM: HTMLElement | Text,
  nextFocusOffset: number,
): void {
  // Apply the updated selection to the DOM. Note: this will trigger
  // a "selectionchange" event, although it will be asynchronous.
  try {
    domSelection.setBaseAndExtent(
      nextAnchorDOM,
      nextAnchorOffset,
      nextFocusDOM,
      nextFocusOffset,
    );
  } catch (error) {
    // If we encounter an error, continue. This can sometimes
    // occur with FF and there's no good reason as to why it
    // should happen.
    if (__DEV__) {
      console.warn(error);
    }
  }
}

/**
 * @internal
 *
 * The DOM element and offset for a point at `offset` in `node`: in an
 * element's DOM slot, counting the DOM the editor renders ahead of its
 * children, or in the keyed DOM of any other node.
 */
export function $getElementAndOffsetForPoint(
  editor: LexicalEditor,
  node: LexicalNode,
  offset: number,
): [HTMLElement, number] {
  const element = getElementByKeyOrThrow(editor, node.getKey());
  if ($isElementNode(node)) {
    const slot = $getDOMSlot(node, element, editor);
    return [slot.element, offset + slot.getFirstChildOffset()];
  }
  return [element, offset];
}

/**
 * The DOM node that a caret at an element point is measured on to scroll it
 * into view: the child at `offset` in the element's slot, which the caret is
 * just before. When that child is the keyed DOM of a leaf node whose DOM slot
 * is an element inside it, like a <br> that a DOMRenderExtension override
 * wraps in a <span>, the caret is next to that inner element. The wrapper
 * can be much wider, for example when it also draws something at the start
 * of the next line, so it is not measured.
 */
function $getElementPointScrollTarget(
  editor: LexicalEditor,
  slotElement: Node,
  offset: number,
): HTMLElement | Text | null {
  const child = slotElement.childNodes[offset];
  if (!isHTMLElement(child)) {
    return (child as Text | undefined) || null;
  }
  const key = getNodeKeyFromDOMNode(child, editor);
  const node = key !== undefined ? $getNodeByKey(key) : null;
  return node !== null && !$isElementNode(node)
    ? $getDOMSlot(node, child, editor).element
    : child;
}

/** @internal */
export function $updateDOMSelection(
  prevSelection: BaseSelection | null,
  nextSelection: BaseSelection | null,
  editor: LexicalEditor,
  domSelection: Selection,
  tags: Set<string>,
  rootElement: HTMLElement,
): void {
  const rootForActive = rootElement.getRootNode();
  const activeElement =
    isDOMDocumentNode(rootForActive) || isDOMShadowRoot(rootForActive)
      ? getActiveElementDeep(rootForActive)
      : null;

  // TODO: make this not hard-coded, and add another config option
  // that makes this configurable.
  if (
    (tags.has(COLLABORATION_TAG) && activeElement !== rootElement) ||
    (activeElement !== null &&
      $isSelectionCapturedInDecoratorInput(activeElement, activeElement))
  ) {
    return;
  }

  // Resolve the live DOM selection's boundary points through any enclosing
  // DOM shadow roots; Selection.anchorNode/focusNode are retargeted to the
  // shadow host, so the comparisons below read composed points instead. In
  // the light DOM getDOMSelectionPoints returns `domSelection` itself (no
  // Selection property reads happen here), so `currentPoints` aliases it
  // and preserves the deferred reads described below. The matching live
  // Range is computed lazily in `getCurrentRange()` so the scroll-into-view
  // fallback below is the only path that pays `getRangeAt(0)`'s layout
  // flush — `getDOMSelectionRangeAndPoints()` (the public helper) still
  // returns both eagerly for external callers.
  const currentPoints = getDOMSelectionPoints(domSelection, rootElement);
  let currentRangeCache: Range | null | undefined;
  const getCurrentRange = (): Range | null => {
    if (currentRangeCache === undefined) {
      // Resolve through any enclosing shadow roots: getRangeAt(0) alone is
      // retargeted to the shadow host inside a shadow tree, so the
      // scroll-into-view rect below would measure the host instead of the
      // caret. getDOMSelectionRange falls back to getRangeAt(0) in the light
      // DOM.
      currentRangeCache = getDOMSelectionRange(domSelection, rootElement);
    }
    return currentRangeCache;
  };

  if (!$isRangeSelection(nextSelection)) {
    // We don't remove selection if the prevSelection is null because
    // of editor.setRootElement(). If this occurs on init when the
    // editor is already focused, then this can cause the editor to
    // lose focus.
    if (
      prevSelection !== null &&
      isSelectionWithinEditor(
        editor,
        currentPoints.anchorNode,
        currentPoints.focusNode,
      )
    ) {
      domSelection.removeAllRanges();
    }

    return;
  }

  // DOM Selection property reads (anchorNode, focusNode, anchorOffset,
  // focusOffset) are deferred to their single point of use in the diff
  // check below, and guarded by a cheap domSelection.type check first.
  // These reads force the browser to resolve the selection against the
  // current layout, triggering synchronous style/layout recalculation.

  const anchor = nextSelection.anchor;
  const focus = nextSelection.focus;
  const anchorNode = anchor.getNode();
  const focusNode = focus.getNode();
  const [anchorDOM, nextAnchorOffset] = $getElementAndOffsetForPoint(
    editor,
    anchorNode,
    anchor.offset,
  );
  const [focusDOM, modelFocusOffset] = $getElementAndOffsetForPoint(
    editor,
    focusNode,
    focus.offset,
  );
  const nextFormat = nextSelection.format;
  const nextStyle = nextSelection.style;
  const isCollapsed = nextSelection.isCollapsed();
  let nextAnchorNode: HTMLElement | Text | null = anchorDOM;
  let nextFocusNode: HTMLElement | Text | null = focusDOM;
  let anchorFormatOrStyleChanged = false;

  if (anchor.type === 'text') {
    nextAnchorNode = $isTextNode(anchorNode)
      ? $getDOMTextNode(anchorNode, anchorDOM, editor)
      : null;
    anchorFormatOrStyleChanged =
      anchorNode.getFormat() !== nextFormat ||
      anchorNode.getStyle() !== nextStyle;
  } else if (
    $isRangeSelection(prevSelection) &&
    prevSelection.anchor.type === 'text'
  ) {
    anchorFormatOrStyleChanged = true;
  }

  if (focus.type === 'text') {
    nextFocusNode = $isTextNode(focusNode)
      ? $getDOMTextNode(focusNode, focusDOM, editor)
      : null;
  }

  // If we can't get an underlying text node for selection, then
  // we should avoid setting selection to something incorrect.
  if (nextAnchorNode === null || nextFocusNode === null) {
    return;
  }

  // Select the rendered suffix so WebKit replaces it in the empty target.
  // A collapsed caret at its start can insert into the previous text node.
  const nextFocusOffset =
    isCollapsed &&
    $isTextNode(focusNode) &&
    $isEmptyCompositionTarget(focusNode) &&
    isDOMTextNode(nextFocusNode) &&
    nextFocusNode.nodeValue === COMPOSITION_SUFFIX
      ? COMPOSITION_SUFFIX.length
      : modelFocusOffset;

  if (
    isCollapsed &&
    (prevSelection === null ||
      anchorFormatOrStyleChanged ||
      ($isRangeSelection(prevSelection) &&
        (prevSelection.format !== nextFormat ||
          prevSelection.style !== nextStyle)))
  ) {
    markCollapsedSelectionFormat(
      editor,
      nextFormat,
      nextStyle,
      // The Lexical offset, which onSelectionChange compares, rather than
      // the DOM one, which also counts the DOM the editor renders between
      // an element's children.
      anchor.offset,
      anchor.key,
      performance.now(),
    );
  }

  // Diff against the native DOM selection to ensure we don't do
  // an unnecessary selection update. We also skip this check if
  // we're moving selection to within an element, as this can
  // sometimes be problematic around scrolling.
  if (
    !(domSelection.type === 'Range' && isCollapsed) && // Badly interpreted range selection when collapsed - #1482
    currentPoints.anchorOffset === nextAnchorOffset &&
    currentPoints.focusOffset === nextFocusOffset &&
    currentPoints.anchorNode === nextAnchorNode &&
    currentPoints.focusNode === nextFocusNode
  ) {
    // If the root element does not have focus, ensure it has focus — but
    // not when the deep-focused element belongs to a different editor
    // (e.g. the inner editor of a coexisting outer-editor / shadow-editor
    // pair). Stealing focus there breaks the user's typing flow.
    if (activeElement === null || !rootElement.contains(activeElement)) {
      const focusEditor =
        activeElement !== null
          ? getNearestEditorFromDOMNode(activeElement)
          : null;
      if (
        (focusEditor === null || focusEditor === editor) &&
        !tags.has(SKIP_SELECTION_FOCUS_TAG)
      ) {
        rootElement.focus({
          preventScroll: true,
        });
      }
    }
    if (anchor.type !== 'element') {
      return;
    }
  }

  // Apply the updated selection to the DOM. Note: this will trigger
  // a "selectionchange" event, although it will be asynchronous.
  setDOMSelectionBaseAndExtent(
    domSelection,
    nextAnchorNode,
    nextAnchorOffset,
    nextFocusNode,
    nextFocusOffset,
  );

  // Firefox-specific fix: After setting DOM selection, ensure root element has focus
  // to maintain cursor visibility. Firefox requires focus to be on the root element
  // for the cursor to be visible, especially after operations like drag that may
  // cause focus loss. This is critical for collapsed selections (cursor).
  if (
    IS_FIREFOX &&
    nextSelection.isCollapsed() &&
    rootElement !== null &&
    !tags.has(SKIP_SELECTION_FOCUS_TAG)
  ) {
    // Shallow active element for the containment check: rootElement.contains()
    // does not cross shadow boundaries, so a host-retargeted result gives the
    // correct containment outcome (and avoids a false "outside" when focus is
    // in a nested decorator shadow inside this editor).
    const focusedElement = getActiveElement(rootElement);
    if (focusedElement === null || !rootElement.contains(focusedElement)) {
      // Don't steal focus when the active element belongs to a *different*
      // editor (e.g. the inner editor of a coexisting outer-editor /
      // shadow-editor pair). Resolve the *deep* focused element for this
      // attribution: a shallow read returns the other editor's shadow host,
      // which getNearestEditorFromDOMNode can't map back to that editor, so
      // the guard would otherwise wrongly steal focus from a shadow-mounted
      // sibling.
      const deepFocusedElement = getActiveElementDeep(
        rootElement.ownerDocument,
      );
      const focusEditor =
        deepFocusedElement !== null
          ? getNearestEditorFromDOMNode(deepFocusedElement)
          : null;
      if (focusEditor === null || focusEditor === editor) {
        // Restore focus immediately to ensure cursor visibility.
        // Note: We rely on the normal selection update mechanism to ensure the
        // cursor is visible. Using requestAnimationFrame here could cause race
        // conditions where another update changes the selection before the rAF
        // callback executes.
        rootElement.focus({preventScroll: true});
      }
    }
  }

  if (
    !tags.has(SKIP_SCROLL_INTO_VIEW_TAG) &&
    nextSelection.isCollapsed() &&
    rootElement !== null &&
    // Re-read the active element rather than a value cached before the focus
    // restore / selection mutation above, which can become stale (e.g. when
    // setting the DOM selection focuses the contentEditable as a side effect).
    // Shallow is sufficient here for the same reason as the Firefox branch
    // above: the equality check doesn't cross the shadow boundary.
    rootElement === getActiveElement(rootElement)
  ) {
    const selectionTarget: null | Range | HTMLElement | Text =
      $isRangeSelection(nextSelection) &&
      nextSelection.anchor.type === 'element'
        ? $getElementPointScrollTarget(editor, nextAnchorNode, nextAnchorOffset)
        : getCurrentRange();
    if (selectionTarget !== null) {
      let selectionRect: DOMRect;
      if (isDOMTextNode(selectionTarget)) {
        const range = selectionTarget.ownerDocument.createRange();
        range.selectNode(selectionTarget);
        selectionRect = range.getBoundingClientRect();
      } else if (isHTMLElement(selectionTarget)) {
        selectionRect = selectionTarget.getBoundingClientRect();
      } else {
        selectionRect = getCaretRect(selectionTarget);
      }
      scrollIntoViewIfNeeded(
        editor,
        selectionRect,
        rootElement,
        nextAnchorNode,
      );
    }
  }

  markSelectionChangeFromDOMUpdate(
    editor,
    nextAnchorNode,
    nextAnchorOffset,
    nextFocusNode,
    nextFocusOffset,
  );
}

/** Inserts nodes into the current selection, falling back to the previous selection or the end of the root. */
export function $insertNodes(nodes: LexicalNode[]) {
  let selection = $getSelection() || $getPreviousSelection();

  if (selection === null) {
    selection = $getRoot().selectEnd();
  }
  selection.insertNodes(nodes);
}

/**
 * Push-lexer visitor passed to {@link tokenizeRawText}. The tokenizer
 * invokes one callback per token it emits; empty text runs are
 * suppressed, so `text` is only invoked with a non-empty string.
 */
export interface RawTextVisitor {
  readonly linebreak: () => void;
  readonly tab: () => void;
  readonly text: (text: string) => void;
}

/**
 * Push-lex a raw text string into `linebreak` (`\n` / `\r\n`), `tab`
 * (`\t`), and `text` (everything else) tokens, dispatching each to the
 * matching callback on `visitor` in source order.
 *
 * Shared by {@link $generateNodesFromRawText} (which builds
 * `LineBreakNode` / `TabNode` / `TextNode` siblings) and by
 * `@lexical/clipboard`'s default `text/plain` clipboard importer
 * (which maps `linebreak` to a real paragraph break via
 * `insertParagraph` so multi-line plain text becomes multi-paragraph
 * rich text). Empty text runs are dropped so callers don't need to
 * special-case them.
 */
export function tokenizeRawText(text: string, visitor: RawTextVisitor): void {
  for (const part of text.split(/(\r?\n|\t)/)) {
    if (part === '\n' || part === '\r\n') {
      visitor.linebreak();
    } else if (part === '\t') {
      visitor.tab();
    } else if (part !== '') {
      visitor.text(part);
    }
  }
}

/**
 * Convert a raw text string into a flat array of `TextNode`,
 * `LineBreakNode`, and `TabNode` siblings, splitting on `\n`, `\r\n`,
 * and `\t`. Use this when you need the same `\n` / `\t` → real-node
 * conversion that {@link RangeSelection.insertRawText} performs but
 * without a selection — e.g. when building a `CodeNode`'s children
 * inside a DOM-import rule.
 */
export function $generateNodesFromRawText(
  text: string,
): (TextNode | LineBreakNode)[] {
  const nodes: (TextNode | LineBreakNode)[] = [];
  tokenizeRawText(text, {
    linebreak: () => nodes.push($createLineBreakNode()),
    tab: () => nodes.push($createTabNode()),
    text: part => nodes.push($createTextNode(part)),
  });
  return nodes;
}

/** Returns the text content of the current selection, or an empty string if no selection exists. */
export function $getTextContent(): string {
  const selection = $getSelection();
  if (selection === null) {
    return '';
  }
  return selection.getTextContent();
}

// Inline projection of a pasted node list for a
// block-shaped slot value (insertNodes CASE 3b): inline nodes pass through,
// non-inline elements contribute their inline content recursively, line
// breaks are stripped (the <input> value-sanitization analogy for newlines),
// and non-inline decorators are dropped.
function $extractInlineFromBlocks(nodes: LexicalNode[]): LexicalNode[] {
  const inlineNodes: LexicalNode[] = [];
  for (const node of nodes) {
    if ($isLineBreakNode(node)) {
      continue;
    }
    if (($isElementNode(node) || $isDecoratorNode(node)) && !node.isInline()) {
      if ($isElementNode(node)) {
        inlineNodes.push(...$extractInlineFromBlocks(node.getChildren()));
      }
      continue;
    }
    inlineNodes.push(node);
  }
  return inlineNodes;
}

/**
 * Removes the selected text and splits the ancestor chain at the anchor up to
 * the nearest block, returning the node the caller should insert into and the
 * index within it.
 *
 * @param stopAtUnsplittableNode - when true, stop the walk on an ElementNode
 * that cannot be split instead of continuing past it, see
 * {@link $splitNodeAtPoint}. The walk below never visits a block, so in
 * practice this only ever stops on an inline ElementNode.
 */
function $removeTextAndSplitBlock(
  selection: RangeSelection,
  stopAtUnsplittableNode = false,
): [container: LexicalNode, offset: number] {
  let selection_ = selection;
  if (!selection.isCollapsed()) {
    selection_.removeText();
  }
  // A new selection can originate as a result of node replacement, in which case is registered via
  // $setSelection
  const newSelection = $getSelection();
  if ($isRangeSelection(newSelection)) {
    selection_ = newSelection;
  }

  invariant(
    $isRangeSelection(selection_),
    'Unexpected dirty selection to be null',
  );

  const anchor = selection_.anchor;
  let node = anchor.getNode();
  let offset = anchor.offset;

  // A slotted node is the virtual scope root (its parent is null), so the
  // split walk must stop there even when it is not INTERNAL_$isBlock itself
  // (e.g. a container-shaped slot value with element children) — otherwise
  // $splitNodeAtPoint's parentless fallback would append a stray paragraph
  // to the document root.
  while (!INTERNAL_$isBlock(node) && $getSlotHostKey(node) === null) {
    const prevNode = node;
    [node, offset] = $splitNodeAtPoint(node, offset, stopAtUnsplittableNode);
    if (prevNode.is(node)) {
      break;
    }
  }

  return [node, offset];
}

/**
 * Splits `node` at `offset`, returning the parent that now holds the two
 * halves and the index between them.
 *
 * @param stopAtUnsplittableNode - an ElementNode is split by moving the
 * children after `offset` into the node returned by its `insertNewAfter()`,
 * but that returns null for any ElementNode that does not implement it (the
 * base class default). Such a node cannot be split, and continuing the walk
 * would move the insertion point past the whole node, so inline content
 * pasted with the caret inside it would land after it instead of at the caret
 * (#6477). When this is true the unsplittable node itself is returned so the
 * caller inserts into it at `offset`; when false the previous behavior of
 * ascending to the parent is kept. This does not itself test `isInline()` —
 * the only caller that passes true is {@link $removeTextAndSplitBlock}, whose
 * walk stops before it reaches a block.
 */
function $splitNodeAtPoint(
  node: LexicalNode,
  offset: number,
  stopAtUnsplittableNode = false,
): [parent: ElementNode, offset: number] {
  const parent = node.getParent();
  if (!parent) {
    const paragraph = $createParagraphNode();
    $getRoot().append(paragraph);
    paragraph.select();
    return [$getRoot(), 0];
  }

  if ($isTextNode(node)) {
    const split = node.splitText(offset);
    if (split.length === 0) {
      return [parent, node.getIndexWithinParent()];
    }
    const x = offset === 0 ? 0 : 1;
    const index = split[0].getIndexWithinParent() + x;

    return [parent, index];
  }

  if (!$isElementNode(node) || offset === 0) {
    return [parent, node.getIndexWithinParent()];
  }

  const firstToAppend = node.getChildAtIndex(offset);
  if (firstToAppend) {
    const insertPoint = new RangeSelection(
      $createPoint(node.__key, offset, 'element'),
      $createPoint(node.__key, offset, 'element'),
      0,
      '',
    );
    const newElement = node.insertNewAfter(insertPoint) as ElementNode | null;
    if (newElement) {
      newElement.append(firstToAppend, ...firstToAppend.getNextSiblings());
    } else if (stopAtUnsplittableNode) {
      return [node, offset];
    }
  }
  return [parent, node.getIndexWithinParent() + 1];
}

function $isInlineRunNode(node: LexicalNode): boolean {
  return (
    $isLineBreakNode(node) ||
    $isInlineElementOrDecoratorNode(node) ||
    $isTextNode(node) ||
    node.isParentRequired()
  );
}

function $wrapInlineNodes(nodes: LexicalNode[]) {
  // We temporarily insert the topLevelNodes into an arbitrary ElementNode,
  // since insertAfter does not work on nodes that have no parent (TO-DO: fix that).
  const virtualRoot = $createParagraphNode();

  let currentBlock: ElementNode | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if ($isInlineRunNode(node)) {
      if (currentBlock === null) {
        currentBlock = node.createParentElementNode();
        virtualRoot.append(currentBlock);
        // A LineBreakNode that is an entire run by itself collapses to an
        // empty paragraph, since the block boundary already provides the
        // visual newline (the form that clipboard pastes ending in a
        // trailing <br> rely on, and the same policy as
        // $paragraphPackageRun in @lexical/html). A linebreak followed by
        // more inline content in the same run is preserved.
        const nextNode: LexicalNode | undefined = nodes[i + 1];
        if (
          $isLineBreakNode(node) &&
          (nextNode === undefined || !$isInlineRunNode(nextNode))
        ) {
          continue;
        }
      }
      currentBlock.append(node);
    } else {
      virtualRoot.append(node);
      currentBlock = null;
    }
  }

  return virtualRoot;
}

/**
 * Get all nodes in a CaretRange in a way that complies with all of the
 * quirks of the original RangeSelection.getNodes().
 *
 * @param range The CaretRange
 */
function $getNodesFromCaretRangeCompat(
  // getNodes returned nodes in document order
  range: CaretRange<'next'>,
): LexicalNode[] {
  const nodes: LexicalNode[] = [];
  const [beforeSlice, afterSlice] = range.getTextSlices();
  if (beforeSlice) {
    nodes.push(beforeSlice.caret.origin);
  }
  const seenAncestors = new Set<ElementNode>();
  // Enter/exit events are nested. Only leading ancestors lack an included
  // enter event, so a depth counter can skip repeated elements on exit.
  let openElements = 0;
  for (const caret of range) {
    if ($isChildCaret(caret)) {
      // Emulate the leading under-selection behavior of getNodes by
      // ignoring the 'enter' of any ElementNode until we've seen a
      // SiblingCaret
      const {origin} = caret;
      if (nodes.length === 0) {
        seenAncestors.add(origin);
      } else {
        openElements++;
        nodes.push(origin);
      }
    } else {
      const {origin} = caret;
      if (!$isElementNode(origin) || openElements === 0) {
        nodes.push(origin);
      } else {
        openElements--;
      }
    }
  }
  if (afterSlice) {
    nodes.push(afterSlice.caret.origin);
  }
  // Emulate the trailing underselection behavior when the last offset of
  // an element is selected
  if (
    $isSiblingCaret(range.focus) &&
    $isElementNode(range.focus.origin) &&
    range.focus.getNodeAtCaret() === null
  ) {
    for (
      let reverseCaret: null | NodeCaret<'previous'> = $getChildCaret(
        range.focus.origin,
        'previous',
      );
      $isChildCaret(reverseCaret) &&
      seenAncestors.has(reverseCaret.origin) &&
      !reverseCaret.origin.isEmpty() &&
      reverseCaret.origin.is(nodes[nodes.length - 1]);
      reverseCaret = $getAdjacentChildCaret(reverseCaret)
    ) {
      seenAncestors.delete(reverseCaret.origin);
      nodes.pop();
    }
  }
  while (nodes.length > 1) {
    const lastIncludedNode = nodes[nodes.length - 1];
    if ($isElementNode(lastIncludedNode)) {
      if (
        // A non-empty included element at the tail has not exited yet:
        // otherwise one of its descendants would follow it in nodes.
        openElements > 0 ||
        lastIncludedNode.isEmpty() ||
        seenAncestors.has(lastIncludedNode)
      ) {
        // fall through to break
      } else {
        nodes.pop();
        continue;
      }
    }
    break;
  }
  if (nodes.length === 0 && range.isCollapsed()) {
    // Emulate the collapsed behavior of getNodes by returning the descendant
    const normCaret = $normalizeCaret(range.anchor);
    const flippedNormCaret = $normalizeCaret(range.anchor.getFlipped());
    const $getCandidate = (caret: PointCaret): LexicalNode | null =>
      $isTextPointCaret(caret) ? caret.origin : caret.getNodeAtCaret();
    const node =
      $getCandidate(normCaret) ||
      $getCandidate(flippedNormCaret) ||
      (range.anchor.getNodeAtCaret()
        ? normCaret.origin
        : flippedNormCaret.origin);
    nodes.push(node);
  }
  return nodes;
}

/**
 * @internal
 *
 * Modify the focus of the focus around possible decorators and blocks and return true
 * if the movement is done.
 */
function $modifySelectionAroundDecoratorsAndBlocks(
  selection: RangeSelection,
  alter: 'move' | 'extend',
  isBackward: boolean,
  granularity: 'character' | 'word' | 'lineboundary',
  mode: 'decorators-and-blocks' | 'decorators' = 'decorators-and-blocks',
): boolean {
  if (
    alter === 'move' &&
    granularity === 'character' &&
    !selection.isCollapsed()
  ) {
    // moving left or right when the selection isn't collapsed will
    // just set the anchor to the focus or vice versa depending on
    // direction
    const [src, dst] =
      isBackward === selection.isBackward()
        ? [selection.focus, selection.anchor]
        : [selection.anchor, selection.focus];
    dst.set(src.key, src.offset, src.type);
    return true;
  }
  const initialFocus = $caretFromPoint(
    selection.focus,
    isBackward ? 'previous' : 'next',
  );
  const isLineBoundary = granularity === 'lineboundary';
  const collapse = alter === 'move';
  let focus = initialFocus;
  let checkForBlock = mode === 'decorators-and-blocks';
  // An isolated decorator stops the caret. Resolving that here rather than
  // falling through to the native measurement is what makes it a defined
  // behavior: left to the engine it was neither — Firefox stepped over the
  // decorator while Chromium trapped the caret on the near side of it with no
  // way past by keyboard.
  let isolated = false;
  if (!$isExtendableTextPointCaret(focus)) {
    for (const siblingCaret of focus) {
      checkForBlock = false;
      const {origin} = siblingCaret;
      if ($isDecoratorNode(origin)) {
        if (origin.isIsolated()) {
          isolated = true;
          break;
        }
        focus = siblingCaret;
        if (isLineBoundary && origin.isInline()) {
          continue;
        }
      }
      break;
    }
    if (isolated) {
      // Handled, with the selection deliberately left where it is.
      return true;
    }
    if (checkForBlock) {
      for (const nextCaret of $extendCaretToRange(initialFocus).iterNodeCarets(
        alter === 'extend' ? 'shadowRoot' : 'root',
      )) {
        if ($isChildCaret(nextCaret)) {
          if (!nextCaret.origin.isInline()) {
            focus = nextCaret;
          }
        } else if ($isElementNode(nextCaret.origin)) {
          continue;
        } else if (
          $isDecoratorNode(nextCaret.origin) &&
          !nextCaret.origin.isInline()
        ) {
          focus = nextCaret;
        }
        break;
      }
    }
  }
  if (focus === initialFocus) {
    return false;
  }
  // After this point checkForBlock is true if and only if we moved to a
  // different block, so we should stop regardless of the granularity
  if (
    collapse &&
    !isLineBoundary &&
    $isDecoratorNode(focus.origin) &&
    focus.origin.isKeyboardSelectable()
  ) {
    // Make it possible to move selection from range selection to
    // node selection on the node.
    const nodeSelection = $createNodeSelection();
    nodeSelection.add(focus.origin.getKey());
    $setSelection(nodeSelection);
    return true;
  }
  focus = $normalizeCaret(focus);
  if (collapse) {
    $setPointFromCaret(selection.anchor, focus);
  }
  $setPointFromCaret(selection.focus, focus);
  return checkForBlock || !isLineBoundary;
}
