/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useLexicalEditable} from '@lexical/react/useLexicalEditable';
import {eventFiles} from '@lexical/rich-text';
import {calculateZoomLevel} from '@lexical/utils';
import {
  $copyNode,
  $createParagraphNode,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $isDecoratorNode,
  $isElementNode,
  $isRootNode,
  $isRootOrShadowRoot,
  $onUpdate,
  BLUR_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  DRAGOVER_COMMAND,
  DROP_COMMAND,
  getActiveElement,
  getActiveElementDeep,
  getComposedEventTarget,
  getParentElement,
  getRootOwnerDocument,
  IS_FIREFOX,
  isHTMLElement,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  type NodeKey,
  registerEventListener,
  registerEventListeners,
} from 'lexical';
import {
  type DragEvent as ReactDragEvent,
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {createPortal} from 'react-dom';

import {Point} from './shared/point';
import {Rectangle} from './shared/rect';

const SPACE = 4;
const TARGET_LINE_HALF_HEIGHT = 2;
const DRAG_DATA_FORMAT = 'application/x-lexical-drag-block';
const TEXT_BOX_HORIZONTAL_PADDING = 28;

const Downward = 1;
const Upward = -1;
const Indeterminate = 0;

let prevIndex = Infinity;

function getCurrentIndex(keysLength: number): number {
  if (keysLength === 0) {
    return Infinity;
  }
  if (prevIndex >= 0 && prevIndex < keysLength) {
    return prevIndex;
  }

  return Math.floor(keysLength / 2);
}

function getTopLevelNodeKeys(editor: LexicalEditor): string[] {
  return editor.read('latest', () => $getRoot().getChildrenKeys());
}

function restoreEditorFocus(
  editor: LexicalEditor,
  rootElement: HTMLElement,
): void {
  rootElement.focus({preventScroll: true});
  editor.update(() => {
    const selection = $getSelection();
    if (selection !== null && !selection.dirty) {
      selection.dirty = true;
    }
  });
}

function getCollapsedMargins(elem: HTMLElement): {
  marginTop: number;
  marginBottom: number;
} {
  const view = elem.ownerDocument.defaultView;
  const getMargin = (
    element: Element | null,
    margin: 'marginTop' | 'marginBottom',
  ): number =>
    element && view ? parseFloat(view.getComputedStyle(element)[margin]) : 0;

  const {marginTop = '0', marginBottom = '0'} = view
    ? view.getComputedStyle(elem)
    : {};
  const prevElemSiblingMarginBottom = getMargin(
    elem.previousElementSibling,
    'marginBottom',
  );
  const nextElemSiblingMarginTop = getMargin(
    elem.nextElementSibling,
    'marginTop',
  );
  const collapsedTopMargin = Math.max(
    parseFloat(marginTop),
    prevElemSiblingMarginBottom,
  );
  const collapsedBottomMargin = Math.max(
    parseFloat(marginBottom),
    nextElemSiblingMarginTop,
  );

  return {marginBottom: collapsedBottomMargin, marginTop: collapsedTopMargin};
}

/**
 * Whether `event` falls within the rows that `elem` occupies: its border box
 * plus its collapsed margins, stretched to the full width of the anchor so
 * the gutter counts too.
 */
function containsEvent(
  elem: HTMLElement,
  anchorElementRect: DOMRect,
  event: MouseEvent,
): {
  result: boolean;
  reason: {isOnTopSide: boolean; isOnBottomSide: boolean};
} {
  const zoom = calculateZoomLevel(elem);
  const point = new Point(event.x / zoom, event.y / zoom);
  const domRect = Rectangle.fromDOM(elem);
  const {marginTop, marginBottom} = getCollapsedMargins(elem);
  const rect = domRect.generateNewRect({
    bottom: domRect.bottom + marginBottom,
    left: anchorElementRect.left,
    right: anchorElementRect.right,
    top: domRect.top - marginTop,
  });
  return rect.contains(point);
}

/**
 * How the plugin treats a block it meets while it walks down from a top-level
 * block to the block under the pointer:
 *
 * - `'draggable'`: the block gets its own handle, and the blocks nested in it
 *   (its block children and the values of its named slots) are looked at too.
 * - `'atomic'`: the block gets its own handle and is dragged as one unit;
 *   nothing inside it gets a handle.
 * - `'transparent'`: the block gets no handle of its own, but the blocks
 *   nested in it do. Over the parts of it that no nested block covers, the
 *   handle belongs to the nearest enclosing block that has one.
 * - `'ignored'`: neither the block nor anything inside it gets a handle; the
 *   pointer over it counts as being over the enclosing block.
 *
 * A top-level block always has a handle, so for it `'transparent'` reads as
 * `'draggable'` and `'ignored'` as `'atomic'`.
 *
 * @experimental The API may change in a future release.
 */
export type DraggableBlockBehavior =
  | 'draggable'
  | 'atomic'
  | 'transparent'
  | 'ignored';

type $GetBlockBehavior = (node: LexicalNode) => DraggableBlockBehavior;

/**
 * The behavior of a block when `$getBlockBehavior` does not decide it. The
 * value of a named slot cannot leave its slot, so it never gets a handle: a
 * shadow-root value (a multi-block region) is transparent, any other value (a
 * single-line field) is ignored. Any other shadow root (a table, a layout
 * container, ...) is one unit. Everything else is draggable.
 */
function $getDefaultBlockBehavior(node: LexicalNode): DraggableBlockBehavior {
  const isShadowRoot = $isElementNode(node) && node.isShadowRoot();
  if ($getSlotHost(node) !== null) {
    return isShadowRoot ? 'transparent' : 'ignored';
  }
  return isShadowRoot ? 'atomic' : 'draggable';
}

/**
 * The blocks directly inside `node`: the values of its named slots, then its
 * block children.
 */
function $getNestedBlocks(node: LexicalNode): LexicalNode[] {
  const blocks: LexicalNode[] = [];
  if (!$isElementNode(node) && !$isDecoratorNode(node)) {
    return blocks;
  }
  for (const name of $getSlotNames(node)) {
    const value = $getSlot(node, name);
    if (value !== null) {
      blocks.push(value);
    }
  }
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      if (
        ($isElementNode(child) || $isDecoratorNode(child)) &&
        !child.isInline()
      ) {
        blocks.push(child);
      }
    }
  }
  return blocks;
}

/** The parent of `node`, or the host of the named slot it is the value of. */
function $getParentOrSlotHost(node: LexicalNode): LexicalNode | null {
  return node.getParent() || $getSlotHost(node);
}

/** Whether `event` is within the columns that `elem` itself occupies. */
function isWithinColumns(elem: HTMLElement, event: MouseEvent): boolean {
  const x = event.x / calculateZoomLevel(elem);
  const {left, right} = elem.getBoundingClientRect();
  return x >= left && x <= right;
}

// Up to this many sibling blocks are checked one by one, which also copes
// with siblings that are not laid out top to bottom (the columns of a
// layout) or not laid out at all (a named slot that is not shown).
const LINEAR_SCAN_MAX_BLOCKS = 16;

/**
 * Where to start looking for the block under the pointer among `blocks`,
 * the blocks directly inside one block. A long run of siblings (the items of
 * a long list) is laid out top to bottom, so the search bisects it for the
 * last block that ends above the pointer; the block under the pointer is
 * that one (its bottom margin counts as part of it) or the next. This keeps
 * a mousemove over a list of thousands of items to a handful of layout
 * reads.
 */
function getFirstBlockIndexNearEvent(
  editor: LexicalEditor,
  blocks: LexicalNode[],
  event: MouseEvent,
): number {
  if (blocks.length <= LINEAR_SCAN_MAX_BLOCKS) {
    return 0;
  }
  let low = 0;
  let high = blocks.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    const elem = editor.getElementByKey(blocks[middle].getKey());
    if (
      elem !== null &&
      elem.getBoundingClientRect().bottom < event.y / calculateZoomLevel(elem)
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return Math.max(0, low - 1);
}

/**
 * Walks down from a top-level block to the deepest nested block under the
 * pointer that has a handle of its own, so that a list item (at any depth)
 * or a paragraph inside a named slot gets its own handle instead of the whole
 * top-level block. `$getBehavior` decides how each block met on the way is
 * treated, see {@link DraggableBlockBehavior}. When no nested block is under
 * the pointer (for example the margin band of a list) the enclosing block is
 * returned, so a whole list can still be dragged from its edge.
 */
function $getNestedBlockElement(
  editor: LexicalEditor,
  elem: HTMLElement,
  anchorElementRect: DOMRect,
  event: MouseEvent,
  $getBehavior: $GetBlockBehavior,
): HTMLElement {
  let node = $getNearestNodeFromDOMNode(elem);
  let blockElem = elem;
  if (node !== null) {
    const behavior = $getBehavior(node);
    if (behavior === 'atomic' || behavior === 'ignored') {
      return blockElem;
    }
  }
  while (node !== null) {
    // Blocks are matched by the rows they occupy, so that the gutter counts.
    // Of several blocks on the same rows (the columns of a layout) the one
    // whose columns the pointer is in wins.
    let match: {
      behavior: DraggableBlockBehavior;
      elem: HTMLElement;
      node: LexicalNode;
    } | null = null;
    const blocks = $getNestedBlocks(node);
    const start = getFirstBlockIndexNearEvent(editor, blocks, event);
    const isLongRun = blocks.length > LINEAR_SCAN_MAX_BLOCKS;
    for (let i = start; i < blocks.length; i++) {
      const child = blocks[i];
      const behavior = $getBehavior(child);
      if (behavior === 'ignored') {
        continue;
      }
      const childElem = editor.getElementByKey(child.getKey());
      if (
        childElem === null ||
        !containsEvent(childElem, anchorElementRect, event).result
      ) {
        if (isLongRun && childElem !== null && i > start) {
          // In a long run of blocks (see getFirstBlockIndexNearEvent) the
          // block after the one just above the pointer is the last one that
          // can be under it.
          break;
        }
        continue;
      }
      if (isWithinColumns(childElem, event)) {
        match = {behavior, elem: childElem, node: child};
        break;
      }
      if (match === null) {
        match = {behavior, elem: childElem, node: child};
      }
    }
    if (match === null) {
      break;
    }
    if (match.behavior !== 'transparent') {
      blockElem = match.elem;
    }
    if (match.behavior === 'atomic') {
      break;
    }
    node = match.node;
  }
  return blockElem;
}

/**
 * Whether `dragged` may become a sibling of `target`. Under the root or a
 * shadow root (the content of a collapsible, a multi-block named slot)
 * anything goes. The value of a named slot has no siblings. A node that
 * requires a parent (a list item) may only sit beside nodes whose parent has
 * the same type as its own, so items move between lists of any type and
 * depth. Any other block may not sit beside such nodes: inside a list it
 * would be turned into a list item or break the list.
 */
function $canDropAsSibling(dragged: LexicalNode, target: LexicalNode): boolean {
  const parent = target.getParent();
  if (parent === null) {
    return false;
  }
  if ($isRootOrShadowRoot(parent)) {
    return true;
  }
  if (dragged.isParentRequired()) {
    const draggedParent = dragged.getParent();
    return (
      draggedParent !== null && draggedParent.getType() === parent.getType()
    );
  }
  return !target.isParentRequired() && !parent.isParentRequired();
}

/**
 * Resolves the block that `dragged` would be inserted next to when dropped on
 * `hoveredElem`: the hovered block, or the nearest ancestor that can take
 * `dragged` as a sibling. This is how a paragraph dragged over a list item
 * targets the enclosing list, so the drop line is only shown where the drop
 * will happen. Returns null when there is no such ancestor, or when the drop
 * would move `dragged` into itself (into its children or its named slots).
 */
function $resolveDropTarget(
  dragged: LexicalNode,
  hoveredElem: HTMLElement,
): LexicalNode | null {
  let target = $getNearestNodeFromDOMNode(hoveredElem);
  while (target !== null && !$canDropAsSibling(dragged, target)) {
    target = $getParentOrSlotHost(target);
  }
  for (
    let ancestor = target !== null ? $getParentOrSlotHost(target) : null;
    ancestor !== null;
    ancestor = $getParentOrSlotHost(ancestor)
  ) {
    if (ancestor.is(dragged)) {
      return null;
    }
  }
  return target;
}

/**
 * Tidies up `parent` after its last child was dragged out of it. A parent
 * that may not be empty (a list) is removed, and so is each ancestor that
 * this leaves empty (the item that held a nested list). A shadow root (the
 * content of a collapsible, a multi-block named slot) stays and gets an
 * empty paragraph, so that there is a block to type in.
 */
function $cleanUpEmptiedParent(parent: LexicalNode | null): void {
  let node = parent;
  let removeEmpty = false;
  while (
    $isElementNode(node) &&
    node.isAttached() &&
    node.isEmpty() &&
    !$isRootOrShadowRoot(node) &&
    $getSlotHost(node) === null &&
    (removeEmpty || !node.canBeEmpty())
  ) {
    const next: LexicalNode | null = node.getParent();
    node.remove(true);
    node = next;
    removeEmpty = true;
  }
  if (
    $isElementNode(node) &&
    node.isAttached() &&
    node.isShadowRoot() &&
    node.getChildrenSize() === 0
  ) {
    node.append($createParagraphNode());
  }
}

/**
 * Whether a drop at `mouseY` goes after the target rather than before it. A
 * top-level target takes a drop before it only from above its top edge (its
 * top margin), as it always did. A nested target (a list item, a block in a
 * shadow root) may have no margin to point at, so its upper half means
 * before; otherwise the place before the first item of a nested list could
 * not be reached.
 */
function isDropAfter(
  targetBlockElem: HTMLElement,
  mouseY: number,
  isNested: boolean,
): boolean {
  const {top, height} = targetBlockElem.getBoundingClientRect();
  return mouseY >= (isNested ? top + height / 2 : top);
}

function $isNestedBlock(node: LexicalNode): boolean {
  return !$isRootNode(node.getParent());
}

function $getDropTargetElement(
  editor: LexicalEditor,
  draggedNodeKey: NodeKey | null,
  hoveredElem: HTMLElement,
): {elem: HTMLElement; isNested: boolean} | null {
  const dragged =
    draggedNodeKey !== null ? $getNodeByKey(draggedNodeKey) : null;
  if (dragged === null) {
    return null;
  }
  const target = $resolveDropTarget(dragged, hoveredElem);
  const elem = target !== null ? editor.getElementByKey(target.getKey()) : null;
  return target !== null && elem !== null
    ? {elem, isNested: $isNestedBlock(target)}
    : null;
}

function getBlockElement(
  anchorElem: HTMLElement,
  editor: LexicalEditor,
  event: MouseEvent,
  $getBehavior: $GetBlockBehavior,
  useEdgeAsDefault = false,
): HTMLElement | null {
  const anchorElementRect = anchorElem.getBoundingClientRect();
  const topLevelNodeKeys = getTopLevelNodeKeys(editor);

  let blockElem: HTMLElement | null = null;

  editor.read('latest', () => {
    if (useEdgeAsDefault) {
      const [firstNode, lastNode] = [
        editor.getElementByKey(topLevelNodeKeys[0]),
        editor.getElementByKey(topLevelNodeKeys[topLevelNodeKeys.length - 1]),
      ];

      const [firstNodeRect, lastNodeRect] = [
        firstNode != null ? firstNode.getBoundingClientRect() : undefined,
        lastNode != null ? lastNode.getBoundingClientRect() : undefined,
      ];

      if (firstNodeRect && lastNodeRect) {
        const firstNodeZoom = calculateZoomLevel(firstNode);
        const lastNodeZoom = calculateZoomLevel(lastNode);
        if (event.y / firstNodeZoom < firstNodeRect.top) {
          blockElem = firstNode;
        } else if (event.y / lastNodeZoom > lastNodeRect.bottom) {
          blockElem = lastNode;
        }

        if (blockElem) {
          return;
        }
      }
    }

    let index = getCurrentIndex(topLevelNodeKeys.length);
    let direction = Indeterminate;

    while (index >= 0 && index < topLevelNodeKeys.length) {
      const key = topLevelNodeKeys[index];
      const elem = editor.getElementByKey(key);
      if (elem === null) {
        break;
      }
      const {
        result,
        reason: {isOnTopSide, isOnBottomSide},
      } = containsEvent(elem, anchorElementRect, event);

      if (result) {
        blockElem = $getNestedBlockElement(
          editor,
          elem,
          anchorElementRect,
          event,
          $getBehavior,
        );
        prevIndex = index;
        break;
      }

      if (direction === Indeterminate) {
        if (isOnTopSide) {
          direction = Upward;
        } else if (isOnBottomSide) {
          direction = Downward;
        } else {
          // stop search block element
          direction = Infinity;
        }
      }

      index += direction;
    }
  });

  return blockElem;
}

function setMenuPosition(
  targetElem: HTMLElement | null,
  floatingElem: HTMLElement,
  anchorElem: HTMLElement,
  zoomLevel: number,
) {
  if (!targetElem) {
    floatingElem.style.display = 'none';
    return;
  }

  const targetRect = targetElem.getBoundingClientRect();
  const targetView = targetElem.ownerDocument.defaultView;
  const targetStyle = targetView
    ? targetView.getComputedStyle(targetElem)
    : null;
  const floatingElemRect = floatingElem.getBoundingClientRect();
  const anchorElementRect = anchorElem.getBoundingClientRect();

  // top left
  let targetCalculateHeight: number = targetStyle
    ? parseInt(targetStyle.lineHeight, 10)
    : NaN;
  if (isNaN(targetCalculateHeight)) {
    // middle
    targetCalculateHeight = targetRect.bottom - targetRect.top;
  }
  const top =
    (targetRect.top +
      (targetCalculateHeight -
        (floatingElemRect.height || targetCalculateHeight)) /
        2 -
      anchorElementRect.top +
      anchorElem.scrollTop) /
    zoomLevel;

  const left = SPACE;

  floatingElem.style.display = 'flex';
  floatingElem.style.opacity = '1';
  floatingElem.style.transform = `translate(${left}px, ${top}px)`;
}

function setDragImage(
  dataTransfer: DataTransfer,
  draggableBlockElem: HTMLElement,
) {
  const {transform} = draggableBlockElem.style;

  // Remove dragImage borders
  draggableBlockElem.style.transform = 'translateZ(0)';
  dataTransfer.setDragImage(draggableBlockElem, 0, 0);

  setTimeout(() => {
    draggableBlockElem.style.transform = transform;
  });
}

function setTargetLine(
  targetLineElem: HTMLElement,
  targetBlockElem: HTMLElement,
  mouseY: number,
  anchorElem: HTMLElement,
  isNested: boolean,
) {
  const {
    top: targetBlockElemTop,
    left: targetBlockElemLeft,
    height: targetBlockElemHeight,
  } = targetBlockElem.getBoundingClientRect();
  const {
    top: anchorTop,
    left: anchorLeft,
    width: anchorWidth,
  } = anchorElem.getBoundingClientRect();
  const {marginTop, marginBottom} = getCollapsedMargins(targetBlockElem);
  let lineTop = targetBlockElemTop;
  if (isDropAfter(targetBlockElem, mouseY, isNested)) {
    lineTop += targetBlockElemHeight + marginBottom / 2;
  } else {
    lineTop -= marginTop / 2;
  }

  const top =
    lineTop - anchorTop - TARGET_LINE_HALF_HEIGHT + anchorElem.scrollTop;
  // The line starts at the target's own left edge, so that it shows the
  // nesting depth of a nested target (a list item in a nested list); for a
  // top-level block it starts where it always did.
  const left = Math.max(
    TEXT_BOX_HORIZONTAL_PADDING - SPACE,
    targetBlockElemLeft - anchorLeft - SPACE,
  );

  targetLineElem.style.transform = `translate(${left}px, ${top}px)`;
  targetLineElem.style.width = `${
    anchorWidth - left - (TEXT_BOX_HORIZONTAL_PADDING - SPACE)
  }px`;
  targetLineElem.style.opacity = '.4';
}

function hideTargetLine(targetLineElem: HTMLElement | null) {
  if (targetLineElem) {
    targetLineElem.style.opacity = '0';
    targetLineElem.style.transform = 'translate(-10000px, -10000px)';
  }
}

function useDraggableBlockMenu(
  editor: LexicalEditor,
  anchorElem: HTMLElement,
  menuRef: React.RefObject<HTMLElement | null>,
  targetLineRef: React.RefObject<HTMLElement | null>,
  isEditable: boolean,
  menuComponent: ReactNode,
  targetLineComponent: ReactNode,
  isOnMenu: (element: HTMLElement) => boolean,
  onElementChanged?: (element: HTMLElement | null) => void,
  $getBlockBehavior?: (
    node: LexicalNode,
  ) => DraggableBlockBehavior | null | undefined,
): JSX.Element {
  const $getBehavior = useCallback(
    (node: LexicalNode): DraggableBlockBehavior =>
      ($getBlockBehavior && $getBlockBehavior(node)) ||
      $getDefaultBlockBehavior(node),
    [$getBlockBehavior],
  );
  const scrollerElem = getParentElement(anchorElem);

  const isDraggingBlockRef = useRef<boolean>(false);
  // The key of the node being dragged, for dragover: the browser does not let
  // dragover read the drag data, and the drop line must only be shown where
  // this particular node can land.
  const draggedNodeKeyRef = useRef<NodeKey | null>(null);
  const [draggableBlockElem, setDraggableBlockElemState] =
    useState<HTMLElement | null>(null);

  const setDraggableBlockElem = useCallback(
    (elem: HTMLElement | null) => {
      setDraggableBlockElemState(elem);
      if (onElementChanged) {
        onElementChanged(elem);
      }
    },
    [onElementChanged],
  );

  useEffect(() => {
    function onMouseMove(event: MouseEvent) {
      const target = getComposedEventTarget(event);
      if (!isHTMLElement(target)) {
        setDraggableBlockElem(null);
        return;
      }

      if (isOnMenu(target)) {
        return;
      }

      const _draggableBlockElem = getBlockElement(
        anchorElem,
        editor,
        event,
        $getBehavior,
      );

      setDraggableBlockElem(_draggableBlockElem);
    }

    function onMouseLeave() {
      setDraggableBlockElem(null);
    }

    if (scrollerElem != null) {
      return registerEventListeners(scrollerElem, {
        mouseleave: onMouseLeave,
        mousemove: onMouseMove,
      });
    }
  }, [
    scrollerElem,
    anchorElem,
    editor,
    isOnMenu,
    setDraggableBlockElem,
    $getBehavior,
  ]);

  useEffect(() => {
    const zoomLevel = calculateZoomLevel(editor.getRootElement(), true);
    if (menuRef.current) {
      setMenuPosition(
        draggableBlockElem,
        menuRef.current,
        anchorElem,
        zoomLevel,
      );
    }
  }, [editor, anchorElem, draggableBlockElem, menuRef]);

  useEffect(() => {
    function $onDragover(event: DragEvent): boolean {
      if (!isDraggingBlockRef.current) {
        return false;
      }
      const [isFileTransfer] = eventFiles(event);
      if (isFileTransfer) {
        return false;
      }
      const pageY = event.pageY;
      // Composed target so the zoom level is read from the real element rather
      // than the shadow host when the editor is in a shadow tree.
      const target = getComposedEventTarget(event);
      if (!isHTMLElement(target)) {
        return false;
      }
      const hoveredBlockElem = getBlockElement(
        anchorElem,
        editor,
        event,
        $getBehavior,
        true,
      );
      const targetLineElem = targetLineRef.current;
      if (hoveredBlockElem === null || targetLineElem === null) {
        return false;
      }
      const dropTarget = $getDropTargetElement(
        editor,
        draggedNodeKeyRef.current,
        hoveredBlockElem,
      );
      if (dropTarget === null) {
        hideTargetLine(targetLineElem);
        return false;
      }
      setTargetLine(
        targetLineElem,
        dropTarget.elem,
        pageY / calculateZoomLevel(target),
        anchorElem,
        dropTarget.isNested,
      );
      // Prevent default event to be able to trigger onDrop events
      event.preventDefault();
      return true;
    }

    function $onDrop(event: DragEvent): boolean {
      if (!isDraggingBlockRef.current) {
        return false;
      }
      const [isFileTransfer] = eventFiles(event);
      if (isFileTransfer) {
        return false;
      }
      const {dataTransfer, pageY} = event;
      // Composed target so the zoom level is read from the real element rather
      // than the shadow host when the editor is in a shadow tree.
      const target = getComposedEventTarget(event);
      const dragData =
        dataTransfer != null ? dataTransfer.getData(DRAG_DATA_FORMAT) : '';
      const draggedNode = $getNodeByKey(dragData);
      if (!draggedNode) {
        return false;
      }
      if (!isHTMLElement(target)) {
        return false;
      }
      const hoveredBlockElem = getBlockElement(
        anchorElem,
        editor,
        event,
        $getBehavior,
        true,
      );
      if (!hoveredBlockElem) {
        return false;
      }
      const targetNode = $resolveDropTarget(draggedNode, hoveredBlockElem);
      const targetBlockElem =
        targetNode !== null
          ? editor.getElementByKey(targetNode.getKey())
          : null;
      if (targetNode === null || targetBlockElem === null) {
        return false;
      }
      if (targetNode === draggedNode) {
        // Firefox-specific fix: Even when no move occurs, restore focus to ensure cursor visibility
        if (IS_FIREFOX) {
          editor.focus();
        }
        return true;
      }
      // A node that requires a parent (a list item) dropped outside such a
      // parent gets an empty copy of the one it came from, so a numbered
      // item dragged out of its list stays a numbered item. The copy is made
      // before the move so the original parent still has its state.
      const draggedParent = draggedNode.getParent();
      const targetParent = targetNode.getParent();
      const nodeToInsert =
        draggedNode.isParentRequired() &&
        draggedParent !== null &&
        targetParent !== null &&
        draggedParent.getType() !== targetParent.getType()
          ? $copyNode(draggedParent).append(draggedNode)
          : draggedNode;
      if (
        isDropAfter(
          targetBlockElem,
          pageY / calculateZoomLevel(target),
          $isNestedBlock(targetNode),
        )
      ) {
        targetNode.insertAfter(nodeToInsert);
      } else {
        targetNode.insertBefore(nodeToInsert);
      }
      $cleanUpEmptiedParent(draggedParent);
      setDraggableBlockElem(null);

      // Firefox-specific fix: Use editor.focus() after drop to properly restore
      // both focus and selection. This ensures cursor visibility immediately.
      if (IS_FIREFOX) {
        // Using $onUpdate ensures this happens after the current update cycle finishes
        $onUpdate(() => {
          editor.focus();
        });
      }

      return true;
    }

    return mergeRegister(
      editor.registerCommand(
        DRAGOVER_COMMAND,
        event => {
          return $onDragover(event);
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        DROP_COMMAND,
        event => {
          return $onDrop(event);
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [anchorElem, editor, targetLineRef, setDraggableBlockElem, $getBehavior]);

  // Firefox-specific: Prevent blur when clicking on drag handle to maintain cursor visibility.
  // Firefox fires blur before dragstart, causing focus loss. We detect this by checking if
  // the blur's relatedTarget is on the menu using isOnMenu, then restore focus synchronously.
  useEffect(() => {
    if (!IS_FIREFOX || !isEditable) {
      return;
    }

    return mergeRegister(
      editor.registerRootListener(rootElement => {
        function onBlur(event: FocusEvent) {
          const relatedTarget = event.relatedTarget;
          if (isHTMLElement(relatedTarget) && isOnMenu(relatedTarget)) {
            // Blur is caused by clicking on drag handle - restore focus immediately
            // to prevent cursor from disappearing. This must be synchronous to work.
            if (rootElement) {
              restoreEditorFocus(editor, rootElement);
            }
            // Prevent the event from propagating to LexicalEvents handler
            event.stopImmediatePropagation();
          }
        }

        if (rootElement) {
          return registerEventListener(rootElement, 'blur', onBlur, true);
        }
      }),
      // Intercept BLUR_COMMAND if focus is on the menu (fallback in case event propagation wasn't stopped)
      editor.registerCommand(
        BLUR_COMMAND,
        () => {
          const rootElement = editor.getRootElement();
          // getActiveElementDeep so the menu is found whether it is portaled
          // into the light DOM or inside a shadow root (where
          // document.activeElement only reports the shadow host).
          const activeElement = getActiveElementDeep(
            getRootOwnerDocument(rootElement),
          );
          if (
            rootElement &&
            isHTMLElement(activeElement) &&
            isOnMenu(activeElement)
          ) {
            // Focus is on menu - restore to root and prevent blur command
            restoreEditorFocus(editor, rootElement);
            return true; // Prevent command from propagating
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [editor, isEditable, isOnMenu]);

  function onDragStart(event: ReactDragEvent<HTMLDivElement>): void {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer || !draggableBlockElem) {
      return;
    }

    setDragImage(dataTransfer, draggableBlockElem);
    let nodeKey = '';
    editor.update(() => {
      const node = $getNearestNodeFromDOMNode(draggableBlockElem);
      if (node) {
        nodeKey = node.getKey();
      }
    });
    isDraggingBlockRef.current = true;
    draggedNodeKeyRef.current = nodeKey;
    dataTransfer.setData(DRAG_DATA_FORMAT, nodeKey);

    // Firefox-specific: Restore focus synchronously after drag starts to prevent cursor loss.
    // The blur handler should have already restored focus, but we do it here as a fallback
    // and to ensure selection is properly maintained during drag.
    if (IS_FIREFOX) {
      const rootElement = editor.getRootElement();
      // getActiveElement rather than document.activeElement, which reports the
      // shadow host when the editor is in a shadow root.
      if (
        rootElement !== null &&
        getActiveElement(rootElement) !== rootElement
      ) {
        // Restore focus synchronously - don't use requestAnimationFrame as blur already happened
        // and we need immediate focus restoration to maintain cursor visibility
        restoreEditorFocus(editor, rootElement);
      }
    }
  }

  function onDragEnd(): void {
    isDraggingBlockRef.current = false;
    draggedNodeKeyRef.current = null;
    hideTargetLine(targetLineRef.current);

    const rootElement = editor.getRootElement();
    if (rootElement !== null && getActiveElement(rootElement) !== rootElement) {
      restoreEditorFocus(editor, rootElement);
    }
  }
  return createPortal(
    <>
      <div draggable={true} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        {isEditable && menuComponent}
      </div>
      {targetLineComponent}
    </>,
    anchorElem,
  );
}

/**
 * Renders a draggable handle and drop-target line that let users reorder
 * blocks by dragging: top-level blocks, and the blocks nested in them (list
 * items at any depth, the blocks of a multi-block named slot) on their own.
 * By default a shadow root (a table, a layout container, ...) is dragged as
 * one unit and nothing inside it gets a handle; `$getBlockBehavior` changes
 * that per node, see {@link DraggableBlockBehavior}. A list item can be
 * dropped into any list, or outside a list where it gets its own list of the
 * same type; any other block dragged over a list lands next to that list.
 * You supply the handle and target-line elements
 * via `menuComponent`/`menuRef` and `targetLineComponent`/`targetLineRef`, an
 * `anchorElem` to portal them into (defaults to `document.body`), and an
 * `isOnMenu` predicate used to detect interactions with the handle.
 *
 * @experimental The API may change in a future release.
 * @returns A portal containing the drag handle and target line.
 */
export function DraggableBlockPlugin_EXPERIMENTAL({
  // eslint-disable-next-line no-restricted-syntax
  anchorElem = document.body,
  menuRef,
  targetLineRef,
  menuComponent,
  targetLineComponent,
  isOnMenu,
  onElementChanged,
  $getBlockBehavior,
}: {
  anchorElem?: HTMLElement;
  menuRef: React.RefObject<HTMLElement | null>;
  targetLineRef: React.RefObject<HTMLElement | null>;
  menuComponent: ReactNode;
  targetLineComponent: ReactNode;
  isOnMenu: (element: HTMLElement) => boolean;
  onElementChanged?: (element: HTMLElement | null) => void;
  /**
   * Decides how the plugin treats a block, see {@link DraggableBlockBehavior}.
   * Return `null` or `undefined` to keep the default for that block. Called
   * with the editor state active. Pass a stable function (module level or
   * `useCallback`).
   */
  $getBlockBehavior?: (
    node: LexicalNode,
  ) => DraggableBlockBehavior | null | undefined;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  // Subscribed rather than read off the editor, so that setEditable() actually
  // re-renders the handle. useLexicalEditable also handles StrictMode and
  // concurrent rendering correctly.
  const isEditable = useLexicalEditable();
  return useDraggableBlockMenu(
    editor,
    anchorElem,
    menuRef,
    targetLineRef,
    isEditable,
    menuComponent,
    targetLineComponent,
    isOnMenu,
    onElementChanged,
    $getBlockBehavior,
  );
}
