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
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRootNode,
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
 * Walks down from a top-level block to the deepest nested block under the
 * pointer, so that a list item (at any depth) gets its own handle instead of
 * the whole list. Descent stops at shadow roots (tables, layout containers,
 * collapsibles, ...), which stay one draggable unit, and at blocks with only
 * inline content. When no child block is under the pointer (for example the
 * margin band of a list) the block itself is returned, so a whole list can
 * still be dragged from its edge.
 */
function $getNestedBlockElement(
  editor: LexicalEditor,
  elem: HTMLElement,
  anchorElementRect: DOMRect,
  event: MouseEvent,
): HTMLElement {
  let node = $getNearestNodeFromDOMNode(elem);
  let blockElem = elem;
  descend: while ($isElementNode(node) && !node.isShadowRoot()) {
    for (const child of node.getChildren()) {
      if (!$isElementNode(child) || child.isInline()) {
        continue;
      }
      const childElem = editor.getElementByKey(child.getKey());
      if (
        childElem !== null &&
        containsEvent(childElem, anchorElementRect, event).result
      ) {
        node = child;
        blockElem = childElem;
        continue descend;
      }
    }
    break;
  }
  return blockElem;
}

/**
 * Whether `dragged` may become a sibling of `target`. Under the root anything
 * goes. A node that requires a parent (a list item) may only sit beside nodes
 * whose parent has the same type as its own, so items move between lists of
 * any type and depth. Any other block may not sit beside such nodes: inside a
 * list it would be turned into a list item or break the list.
 */
function $canDropAsSibling(dragged: LexicalNode, target: LexicalNode): boolean {
  const parent = target.getParent();
  if (parent === null) {
    return false;
  }
  if ($isRootNode(parent)) {
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
 * would move `dragged` into itself.
 */
function $resolveDropTarget(
  dragged: LexicalNode,
  hoveredElem: HTMLElement,
): LexicalNode | null {
  let target = $getNearestNodeFromDOMNode(hoveredElem);
  while (target !== null && !$canDropAsSibling(dragged, target)) {
    target = target.getParent();
  }
  if (
    target === null ||
    ($isElementNode(dragged) && dragged.isParentOf(target))
  ) {
    return null;
  }
  return target;
}

function $getDropTargetElement(
  editor: LexicalEditor,
  draggedNodeKey: NodeKey | null,
  hoveredElem: HTMLElement,
): HTMLElement | null {
  const dragged =
    draggedNodeKey !== null ? $getNodeByKey(draggedNodeKey) : null;
  if (dragged === null) {
    return null;
  }
  const target = $resolveDropTarget(dragged, hoveredElem);
  return target !== null ? editor.getElementByKey(target.getKey()) : null;
}

function getBlockElement(
  anchorElem: HTMLElement,
  editor: LexicalEditor,
  event: MouseEvent,
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
  if (mouseY >= targetBlockElemTop) {
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
): JSX.Element {
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

      const _draggableBlockElem = getBlockElement(anchorElem, editor, event);

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
  }, [scrollerElem, anchorElem, editor, isOnMenu, setDraggableBlockElem]);

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
      const hoveredBlockElem = getBlockElement(anchorElem, editor, event, true);
      const targetLineElem = targetLineRef.current;
      if (hoveredBlockElem === null || targetLineElem === null) {
        return false;
      }
      const targetBlockElem = $getDropTargetElement(
        editor,
        draggedNodeKeyRef.current,
        hoveredBlockElem,
      );
      if (targetBlockElem === null) {
        hideTargetLine(targetLineElem);
        return false;
      }
      setTargetLine(
        targetLineElem,
        targetBlockElem,
        pageY / calculateZoomLevel(target),
        anchorElem,
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
      const hoveredBlockElem = getBlockElement(anchorElem, editor, event, true);
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
      const targetBlockElemTop = targetBlockElem.getBoundingClientRect().top;
      if (pageY / calculateZoomLevel(target) >= targetBlockElemTop) {
        targetNode.insertAfter(nodeToInsert);
      } else {
        targetNode.insertBefore(nodeToInsert);
      }
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
  }, [anchorElem, editor, targetLineRef, setDraggableBlockElem]);

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
 * items at any depth) on their own. Descent stops at shadow roots (tables,
 * layout containers, ...), which are dragged as one unit. A list item can be
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
}: {
  anchorElem?: HTMLElement;
  menuRef: React.RefObject<HTMLElement | null>;
  targetLineRef: React.RefObject<HTMLElement | null>;
  menuComponent: ReactNode;
  targetLineComponent: ReactNode;
  isOnMenu: (element: HTMLElement) => boolean;
  onElementChanged?: (element: HTMLElement | null) => void;
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
  );
}
