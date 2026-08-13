/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getEditor,
  $isRootNode,
  $isTextNode,
  type ElementNode,
  getRootOwnerDocument,
  getStyleObjectFromCSS,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';

function getDOMTextNode(element: Node | null): Text | null {
  let node = element;

  while (node != null) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node as Text;
    }

    node = node.firstChild;
  }

  return null;
}

function getDOMIndexWithinParent(node: ChildNode): [ParentNode, number] {
  const parent = node.parentNode;

  if (parent == null) {
    throw new Error('Should never happen');
  }

  return [parent, Array.from(parent.childNodes).indexOf(node)];
}

/**
 * Creates a selection range for the DOM.
 * @param editor - The lexical editor.
 * @param anchorNode - The anchor node of a selection.
 * @param _anchorOffset - The amount of space offset from the anchor to the focus.
 * @param focusNode - The current focus.
 * @param _focusOffset - The amount of space offset from the focus to the anchor.
 * @returns The range of selection for the DOM that was created.
 */
export function createDOMRange(
  editor: LexicalEditor,
  anchorNode: LexicalNode,
  _anchorOffset: number,
  focusNode: LexicalNode,
  _focusOffset: number,
): Range | null {
  const anchorKey = anchorNode.getKey();
  const focusKey = focusNode.getKey();
  // Resolve through the editor's own document so iframe / shadow-mounted
  // editors don't end up with a Range bound to the wrong realm.
  const range = getRootOwnerDocument(editor.getRootElement()).createRange();
  let anchorDOM: Node | Text | null = editor.getElementByKey(anchorKey);
  let focusDOM: Node | Text | null = editor.getElementByKey(focusKey);
  let anchorOffset = _anchorOffset;
  let focusOffset = _focusOffset;

  if ($isTextNode(anchorNode)) {
    anchorDOM = getDOMTextNode(anchorDOM);
  }

  if ($isTextNode(focusNode)) {
    focusDOM = getDOMTextNode(focusDOM);
  }

  if (
    anchorNode === undefined ||
    focusNode === undefined ||
    anchorDOM === null ||
    focusDOM === null
  ) {
    return null;
  }

  if (anchorDOM.nodeName === 'BR') {
    [anchorDOM, anchorOffset] = getDOMIndexWithinParent(anchorDOM as ChildNode);
  }

  if (focusDOM.nodeName === 'BR') {
    [focusDOM, focusOffset] = getDOMIndexWithinParent(focusDOM as ChildNode);
  }

  const firstChild = anchorDOM.firstChild;

  if (
    anchorDOM === focusDOM &&
    firstChild != null &&
    firstChild.nodeName === 'BR' &&
    anchorOffset === 0 &&
    focusOffset === 0
  ) {
    focusOffset = 1;
  }

  try {
    range.setStart(anchorDOM, anchorOffset);
    range.setEnd(focusDOM, focusOffset);
  } catch (_e) {
    return null;
  }

  if (
    range.collapsed &&
    (anchorOffset !== focusOffset || anchorKey !== focusKey)
  ) {
    // Range is backwards, we need to reverse it
    range.setStart(focusDOM, focusOffset);
    range.setEnd(anchorDOM, anchorOffset);
  }

  return range;
}

/**
 * Creates DOMRects, generally used to help the editor find a specific location on the screen.
 * @param editor - The lexical editor
 * @param range - A fragment of a document that can contain nodes and parts of text nodes.
 * @returns The selectionRects as an array.
 */
export function createRectsFromDOMRange(
  editor: Pick<LexicalEditor, 'getRootElement'>,
  range: Range,
): DOMRect[] {
  const rootElement = editor.getRootElement();

  if (rootElement === null) {
    return [];
  }
  const rootRect = rootElement.getBoundingClientRect();
  const computedStyle = getComputedStyle(rootElement);
  const rootPadding =
    parseFloat(computedStyle.paddingLeft) +
    parseFloat(computedStyle.paddingRight);
  const selectionRects = Array.from(range.getClientRects());
  let selectionRectsLength = selectionRects.length;
  //sort rects from top left to bottom right.
  selectionRects.sort((a, b) => {
    const top = a.top - b.top;
    // Some rects match position closely, but not perfectly,
    // so we give a 3px tolerance.
    if (Math.abs(top) <= 3) {
      return a.left - b.left;
    }
    return top;
  });
  let prevRect;
  for (let i = 0; i < selectionRectsLength; i++) {
    const selectionRect = selectionRects[i];
    // Exclude rects that overlap preceding Rects in the sorted list.
    const isOverlappingRect =
      prevRect &&
      prevRect.top <= selectionRect.top &&
      prevRect.top + prevRect.height > selectionRect.top &&
      prevRect.left + prevRect.width > selectionRect.left;
    // Exclude selections that span the entire element
    const selectionSpansElement =
      selectionRect.width + rootPadding === rootRect.width;
    if (isOverlappingRect || selectionSpansElement) {
      selectionRects.splice(i--, 1);
      selectionRectsLength--;
      continue;
    }
    prevRect = selectionRect;
  }
  return selectionRects;
}

/**
 * @deprecated Use {@link getStyleObjectFromCSS}, this is just an alias for backwards compatibility.
 */
export const getStyleObjectFromRawCSS = getStyleObjectFromCSS;

/**
 * Serializes a style object into a CSS declaration string, the inverse of
 * {@link getStyleObjectFromCSS}.
 * @param styles - An object mapping CSS property names to their values.
 * @returns A CSS string of the form `prop: value;` for each entry, concatenated together.
 */
export function getCSSFromStyleObject(styles: Record<string, string>): string {
  let css = '';

  for (const style in styles) {
    if (style) {
      css += `${style}: ${styles[style]};`;
    }
  }

  return css;
}

/**
 * Gets the computed DOM styles of the element.
 * @param element - The node to check the styles for.
 * @returns the computed styles of the element or null if there is no DOM element or no default view for the document.
 */
export function $getComputedStyleForElement(
  element: ElementNode,
): CSSStyleDeclaration | null {
  const editor = $getEditor();
  const domElement = editor.getElementByKey(element.getKey());
  if (domElement === null) {
    return null;
  }
  const view = domElement.ownerDocument.defaultView;
  if (view === null) {
    return null;
  }
  return view.getComputedStyle(domElement);
}

/**
 * Gets the computed DOM styles of the parent of the node.
 * @param node - The node to check its parent's styles for.
 * @returns the computed styles of the node, or null if the node has no parent,
 * there is no DOM element, or there is no default view for the document.
 */
export function $getComputedStyleForParent(
  node: LexicalNode,
): CSSStyleDeclaration | null {
  // A named-slot value has no parent — it links up to its host through
  // __slotHost — so there is no parent element to measure. Detached nodes are
  // parentless too. Treat both like a missing DOM element rather than
  // throwing; every caller already handles null.
  const parent = $isRootNode(node) ? node : node.getParent();
  return parent && $getComputedStyleForElement(parent);
}

/**
 * Determines whether a node's parent is RTL.
 * @param node - The node to check whether it is RTL.
 * @returns whether the node is RTL.
 */
export function $isParentRTL(node: LexicalNode): boolean {
  const styles = $getComputedStyleForParent(node);
  return styles !== null && styles.direction === 'rtl';
}
