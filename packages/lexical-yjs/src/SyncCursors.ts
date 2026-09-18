/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Provider, UserState} from '.';
import type {CollabDecoratorNode} from './CollabDecoratorNode';
import type {CollabLineBreakNode} from './CollabLineBreakNode';
import type {CollabV2Mapping} from './CollabV2Mapping';

import invariant from '@lexical/internal/invariant';
import {createDOMRange, createRectsFromDOMRange} from '@lexical/selection';
import {
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  type BaseSelection,
  getRootOwnerDocument,
  isDOMShadowRoot,
  type LexicalNode,
  type NodeKey,
  type NodeMap,
  type Point,
  setDOMStyleObject,
} from 'lexical';
import {
  type AbsolutePosition,
  compareRelativePositions,
  createAbsolutePositionFromRelativePosition,
  createRelativePositionFromTypeIndex,
  type RelativePosition,
  XmlElement,
  type XmlText,
} from 'yjs';

import {
  type AnyBinding,
  type BaseBinding,
  type Binding,
  type BindingV2,
  isBindingV1,
} from './Bindings';
import {CollabElementNode} from './CollabElementNode';
import {CollabTextNode} from './CollabTextNode';
import {getPositionFromElementAndOffset} from './Utils';

export type CursorSelection = {
  anchor: {
    key: NodeKey;
    offset: number;
  };
  caret: HTMLElement;
  color: string;
  focus: {
    key: NodeKey;
    offset: number;
  };
  /** Modern path: one CSS Custom Highlight per remote cursor. */
  highlight: Highlight | null;
  highlightName: string;
  name: HTMLSpanElement;
  /** Legacy fallback only: absolutely-positioned rect spans, one per visual rect. */
  selections: HTMLElement[];
};

const SUPPORTS_CSS_HIGHLIGHTS =
  typeof Highlight !== 'undefined' &&
  typeof CSS !== 'undefined' &&
  'highlights' in CSS;

/**
 * The subset of a binding that {@link getCursorHighlightSheet} reads. Declared
 * structurally so callers pass a full binding and tests pass a lightweight stub,
 * neither needing a cast.
 *
 * @internal
 */
export interface CursorHighlightSheetBinding {
  cursorHighlightSheet: CSSStyleSheet | null;
  editor: {getRootElement: () => HTMLElement | null};
}

/**
 * Resolve the per-binding stylesheet that hosts `::highlight(...)` rules,
 * re-adopting it into the editor's current tree scope (document or shadow
 * root) on every call.
 *
 * The editor root can move between the light DOM and a shadow root (a
 * shadow-DOM toggle) without recreating the binding, and `::highlight()` rules
 * only apply in the tree scope that owns the highlighted ranges, so the sheet
 * is re-homed each call. A leftover adoption in a previously-used scope is
 * harmless: shadow encapsulation means a rule there cannot match ranges in the
 * new scope.
 *
 * @internal Exported for tests; not part of the package's public API.
 */
export function getCursorHighlightSheet(
  binding: CursorHighlightSheetBinding,
): CSSStyleSheet {
  const rootElement = binding.editor.getRootElement();
  const ownerDocument = getRootOwnerDocument(rootElement);
  let sheet = binding.cursorHighlightSheet;
  if (sheet === null) {
    const view = ownerDocument.defaultView || window;
    sheet = new view.CSSStyleSheet();
    binding.cursorHighlightSheet = sheet;
  }
  const root = rootElement !== null ? rootElement.getRootNode() : null;
  const target: Document | ShadowRoot = isDOMShadowRoot(root)
    ? root
    : ownerDocument;
  if (!target.adoptedStyleSheets.includes(sheet)) {
    target.adoptedStyleSheets = [...target.adoptedStyleSheets, sheet];
  }
  return sheet;
}

function addCursorHighlightRule(
  binding: BaseBinding,
  highlightName: string,
  color: string,
): void {
  // `color` flows in from peer-controlled awareness state. Reject anything
  // the browser doesn't recognize as a valid <color> so a malicious user can't
  // inject extra declarations through string interpolation below.
  if (!CSS.supports('color', color)) {
    return;
  }
  const sheet = getCursorHighlightSheet(binding);
  const idx = sheet.insertRule(
    `::highlight(${highlightName}) { }`,
    sheet.cssRules.length,
  );
  const rule = sheet.cssRules[idx] as CSSStyleRule;
  // color-mix because the Highlight API doesn't honor opacity on highlights.
  rule.style.setProperty(
    'background-color',
    `color-mix(in srgb, ${color} 30%, transparent)`,
  );
  rule.style.setProperty('color', 'inherit');
}

export function removeCursorHighlightRule(
  binding: BaseBinding,
  highlightName: string,
): void {
  const sheet = binding.cursorHighlightSheet;
  if (sheet === null) {
    return;
  }
  const selector = `::highlight(${highlightName})`;
  for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
    const rule = sheet.cssRules[i] as CSSStyleRule;
    // Structural check rather than `instanceof CSSStyleRule`: editors in
    // different frames have their own `CSSStyleRule` constructor.
    if (rule != null && rule.selectorText === selector) {
      sheet.deleteRule(i);
      return;
    }
  }
}

export type Cursor = {
  color: string;
  name: string;
  selection: null | CursorSelection;
};

function createRelativePosition(
  point: Point,
  binding: Binding,
  assoc: number = 0,
): null | RelativePosition {
  const collabNodeMap = binding.collabNodeMap;
  const collabNode = collabNodeMap.get(point.key);

  if (collabNode === undefined) {
    return null;
  }

  let offset = point.offset;
  let sharedType = collabNode.getSharedType();

  if (collabNode instanceof CollabTextNode) {
    sharedType = collabNode._parent._xmlText;
    const currentOffset = collabNode.getOffset();

    if (currentOffset === -1) {
      return null;
    }

    offset = currentOffset + 1 + offset;
  } else if (
    collabNode instanceof CollabElementNode &&
    point.type === 'element'
  ) {
    const parent = point.getNode();
    invariant($isElementNode(parent), 'Element point must be an element node');
    let accumulatedOffset = 0;
    let i = 0;
    let node = parent.getFirstChild();
    while (node !== null && i++ < offset) {
      if ($isTextNode(node)) {
        accumulatedOffset += node.getTextContentSize() + 1;
      } else {
        accumulatedOffset++;
      }
      node = node.getNextSibling();
    }
    offset = accumulatedOffset;
  }

  return createRelativePositionFromTypeIndex(sharedType, offset, assoc);
}

function createRelativePositionV2(
  point: Point,
  binding: BindingV2,
  assoc: number = 0,
): null | RelativePosition {
  const {mapping} = binding;
  const {offset} = point;
  const node = point.getNode();
  const yType = mapping.getSharedType(node);
  if (yType === undefined) {
    return null;
  }
  if (point.type === 'text') {
    invariant($isTextNode(node), 'Text point must be a text node');
    let prevSibling = node.getPreviousSibling();
    let adjustedOffset = offset;
    while ($isTextNode(prevSibling)) {
      adjustedOffset += prevSibling.getTextContentSize();
      prevSibling = prevSibling.getPreviousSibling();
    }
    return createRelativePositionFromTypeIndex(yType, adjustedOffset, assoc);
  } else if (point.type === 'element') {
    invariant($isElementNode(node), 'Element point must be an element node');
    // `offset` counts lexical children, but the index handed to yjs counts
    // yjs children, and normalizeNodeContent collapses a run of adjacent
    // TextNodes into a single XmlText child. Advance a lexical cursor to
    // `offset` while counting each text run as one yjs child, mirroring
    // $getNodeAndOffsetV2, which consumes one yjs offset per child and then
    // skips the remainder of a text run.
    //
    // Only offsets that fall on a run boundary round trip exactly: yjs has no
    // index for a position *inside* a collapsed run, so an element point in
    // the middle of one (children [Text, Text], offset 1) necessarily decodes
    // back to the end of that run. That is inherent to the serialization, not
    // to this loop.
    let yIndex = 0;
    let lexicalIndex = 0;
    let child = node.getFirstChild();
    while (child !== null && lexicalIndex < offset) {
      let nextSibling = child.getNextSibling();
      lexicalIndex++;
      if ($isTextNode(child)) {
        while ($isTextNode(nextSibling)) {
          nextSibling = nextSibling.getNextSibling();
          lexicalIndex++;
        }
      }
      yIndex++;
      child = nextSibling;
    }
    return createRelativePositionFromTypeIndex(yType, yIndex, assoc);
  }
  return null;
}

function createAbsolutePosition(
  relativePosition: RelativePosition,
  binding: BaseBinding,
): AbsolutePosition | null {
  return createAbsolutePositionFromRelativePosition(
    relativePosition,
    binding.doc,
  );
}

function shouldUpdatePosition(
  currentPos: RelativePosition | null | undefined,
  pos: RelativePosition | null | undefined,
): boolean {
  if (currentPos == null) {
    if (pos != null) {
      return true;
    }
  } else if (pos == null || !compareRelativePositions(currentPos, pos)) {
    return true;
  }

  return false;
}

function createCursor(name: string, color: string): Cursor {
  return {
    color: color,
    name: name,
    selection: null,
  };
}

function destroySelection(binding: BaseBinding, selection: CursorSelection) {
  if (selection.highlight !== null) {
    CSS.highlights.delete(selection.highlightName);
    removeCursorHighlightRule(binding, selection.highlightName);
  }
  const cursorsContainer = binding.cursorsContainer;
  if (cursorsContainer === null) {
    return;
  }
  if (selection.caret.parentNode === cursorsContainer) {
    cursorsContainer.removeChild(selection.caret);
  }
  const selections = selection.selections;
  for (let i = 0; i < selections.length; i++) {
    if (selections[i].parentNode === cursorsContainer) {
      cursorsContainer.removeChild(selections[i]);
    }
  }
}

function destroyCursor(binding: BaseBinding, cursor: Cursor) {
  const selection = cursor.selection;

  if (selection !== null) {
    destroySelection(binding, selection);
  }
}

function createCursorSelection(
  cursor: Cursor,
  binding: BaseBinding,
  clientID: number,
  anchorKey: NodeKey,
  anchorOffset: number,
  focusKey: NodeKey,
  focusOffset: number,
  selectionHighlight: boolean,
  theme: {
    cursor?: string;
    cursorName?: string;
  } = {},
): CursorSelection {
  const color = cursor.color;
  const ownerDocument = getRootOwnerDocument(binding.editor.getRootElement());
  const caret = ownerDocument.createElement('span');
  if (theme.cursor) {
    caret.className = theme.cursor;
    setDOMStyleObject(caret.style, {
      '--lexical-cursor-color': color,
      bottom: '0',
      position: 'absolute',
      right: '-1px',
      top: '0',
    });
  } else {
    setDOMStyleObject(caret.style, {
      'background-color': color,
      bottom: '0',
      position: 'absolute',
      right: '-1px',
      top: '0',
      width: '1px',
      'z-index': '10',
    });
  }
  const name = ownerDocument.createElement('span');
  name.textContent = cursor.name;
  if (theme.cursorName) {
    name.className = theme.cursorName;
  } else {
    setDOMStyleObject(name.style, {
      'background-color': color,
      color: '#fff',
      'font-family': 'Arial',
      'font-size': '12px',
      'font-weight': 'bold',
      left: '-2px',
      'line-height': '12px',
      padding: '2px',
      position: 'absolute',
      top: '-16px',
      'white-space': 'nowrap',
    });
  }
  caret.appendChild(name);

  // CSS.highlights is a document-wide registry, but multiple editors can be
  // mounted in same page.
  const highlightName = `lexical-cursor-${binding.id}-${clientID}`;
  let highlight: Highlight | null = null;
  // Opt-in via the plugin's `selectionHighlight` prop. Without it, fall
  // through to the legacy rect-overlay path so existing setups that style
  // `theme.collaboration.selection` keep working.
  if (selectionHighlight && SUPPORTS_CSS_HIGHLIGHTS) {
    highlight = new Highlight();
    CSS.highlights.set(highlightName, highlight);
    addCursorHighlightRule(binding, highlightName, color);
  }

  return {
    anchor: {
      key: anchorKey,
      offset: anchorOffset,
    },
    caret,
    color,
    focus: {
      key: focusKey,
      offset: focusOffset,
    },
    highlight,
    highlightName,
    name,
    selections: [],
  };
}

function updateCursor(
  binding: BaseBinding,
  cursor: Cursor,
  nextSelection: null | CursorSelection,
  nodeMap: NodeMap,
  theme: {
    cursor?: string;
    selection?: string;
    selectionBg?: string;
  } = {},
): void {
  const editor = binding.editor;
  const rootElement = editor.getRootElement();
  const cursorsContainer = binding.cursorsContainer;

  if (cursorsContainer === null || rootElement === null) {
    return;
  }

  const ownerDocument = getRootOwnerDocument(rootElement);
  const cursorsContainerOffsetParent = cursorsContainer.offsetParent;
  if (cursorsContainerOffsetParent === null) {
    return;
  }

  const containerRect = cursorsContainerOffsetParent.getBoundingClientRect();
  const prevSelection = cursor.selection;

  if (nextSelection === null) {
    if (prevSelection === null) {
      return;
    } else {
      cursor.selection = null;
      destroySelection(binding, prevSelection);
      return;
    }
  } else {
    cursor.selection = nextSelection;
  }

  const caret = nextSelection.caret;
  const color = nextSelection.color;
  const highlight = nextSelection.highlight;
  const anchor = nextSelection.anchor;
  const focus = nextSelection.focus;
  const anchorKey = anchor.key;
  const focusKey = focus.key;
  const anchorNode = nodeMap.get(anchorKey);
  const focusNode = nodeMap.get(focusKey);

  if (anchorNode == null || focusNode == null) {
    return;
  }

  if (highlight !== null) {
    // modern path: CSS Custom Highlight API
    const range = createDOMRange(
      editor,
      anchorNode,
      anchor.offset,
      focusNode,
      focus.offset,
    );
    if (range === null) {
      return;
    }

    // The browser handles line wrapping, RTL, and font metrics — no rect math.
    highlight.clear();
    if (!range.collapsed) {
      highlight.add(range);
    }

    // Caret stays as a positioned element; anchor it to the focus end.
    const caretRange = range.cloneRange();
    caretRange.collapse(false);
    let caretRect: DOMRect = caretRange.getBoundingClientRect();
    if (caretRect.height === 0 && $isLineBreakNode(focusNode)) {
      // Bare <br>: collapsed range reports zero size. Fall back to the
      // line break's own box so the caret still renders.
      const focusEl = editor.getElementByKey(focusKey) as HTMLElement | null;
      if (focusEl !== null) {
        caretRect = focusEl.getBoundingClientRect();
      }
    }

    setDOMStyleObject(caret.style, {
      'background-color': theme.cursor ? '' : color,
      bottom: '',
      height: `${caretRect.height || 16}px`,
      left: `${caretRect.left - containerRect.left}px`,
      'pointer-events': 'none',
      position: 'absolute',
      right: '',
      top: `${caretRect.top - containerRect.top}px`,
      width: '1px',
      'z-index': '10',
    });

    if (caret.parentNode !== cursorsContainer) {
      cursorsContainer.appendChild(caret);
    }
    return;
  }

  // legacy fallback path: per-rect absolutely-positioned span
  const selections = nextSelection.selections;
  let selectionRects: DOMRect[];

  // In the case of a collapsed selection on a linebreak, we need
  // to improvise as the browser will return nothing here as <br>
  // apparently take up no visual space :/
  // This won't work in all cases, but it's better than just showing
  // nothing all the time.
  if (anchorNode === focusNode && $isLineBreakNode(anchorNode)) {
    const brRect = (
      editor.getElementByKey(anchorKey) as HTMLElement
    ).getBoundingClientRect();
    selectionRects = [brRect];
  } else {
    const range = createDOMRange(
      editor,
      anchorNode,
      anchor.offset,
      focusNode,
      focus.offset,
    );

    if (range === null) {
      return;
    }
    selectionRects = createRectsFromDOMRange(editor, range);
  }

  const selectionsLength = selections.length;
  const selectionRectsLength = selectionRects.length;

  for (let i = 0; i < selectionRectsLength; i++) {
    const selectionRect = selectionRects[i];
    let selection = selections[i];

    if (selection === undefined) {
      selection = ownerDocument.createElement('span');
      selections[i] = selection;
      const selectionBg = ownerDocument.createElement('span');
      if (theme.selectionBg) {
        selectionBg.className = theme.selectionBg;
      }
      selection.appendChild(selectionBg);
      cursorsContainer.appendChild(selection);
    }

    const top = selectionRect.top - containerRect.top;
    const left = selectionRect.left - containerRect.left;
    const positionStyle = {
      height: `${selectionRect.height}px`,
      left: `${left}px`,
      'pointer-events': 'none',
      position: 'absolute',
      top: `${top}px`,
      width: `${selectionRect.width}px`,
    };

    if (theme.selection) {
      selection.className = theme.selection;
      setDOMStyleObject(selection.style, {
        ...positionStyle,
        '--lexical-cursor-color': color,
      });
      setDOMStyleObject((selection.firstChild as HTMLSpanElement).style, {
        height: '100%',
        left: '0',
        position: 'absolute',
        top: '0',
        width: '100%',
      });
    } else {
      setDOMStyleObject(selection.style, positionStyle);
      setDOMStyleObject((selection.firstChild as HTMLSpanElement).style, {
        ...positionStyle,
        'background-color': color,
        left: '0',
        opacity: '0.3',
        top: '0',
        'z-index': '5',
      });
    }

    if (i === selectionRectsLength - 1) {
      if (caret.parentNode !== selection) {
        selection.appendChild(caret);
      }
    }
  }

  for (let i = selectionsLength - 1; i >= selectionRectsLength; i--) {
    const selection = selections[i];
    cursorsContainer.removeChild(selection);
    selections.pop();
  }
}

type AnyCollabNode =
  | CollabDecoratorNode
  | CollabElementNode
  | CollabTextNode
  | CollabLineBreakNode;

/**
 * @deprecated Use `$getAnchorAndFocusForUserState` instead.
 */
export function getAnchorAndFocusCollabNodesForUserState(
  binding: Binding,
  userState: UserState,
) {
  const {anchorPos, focusPos} = userState;
  let anchorCollabNode: AnyCollabNode | null = null;
  let anchorOffset = 0;
  let focusCollabNode: AnyCollabNode | null = null;
  let focusOffset = 0;

  if (anchorPos !== null && focusPos !== null) {
    const anchorAbsPos = createAbsolutePosition(anchorPos, binding);
    const focusAbsPos = createAbsolutePosition(focusPos, binding);

    if (anchorAbsPos !== null && focusAbsPos !== null) {
      [anchorCollabNode, anchorOffset] = getCollabNodeAndOffset(
        binding,
        anchorAbsPos.type,
        anchorAbsPos.index,
      );
      [focusCollabNode, focusOffset] = getCollabNodeAndOffset(
        binding,
        focusAbsPos.type,
        focusAbsPos.index,
      );
    }
  }

  return {
    anchorCollabNode,
    anchorOffset,
    focusCollabNode,
    focusOffset,
  };
}

export function $getAnchorAndFocusForUserState(
  binding: AnyBinding,
  userState: UserState,
): {
  anchorKey: NodeKey | null;
  anchorOffset: number;
  focusKey: NodeKey | null;
  focusOffset: number;
} {
  const {anchorPos, focusPos} = userState;
  const anchorAbsPos = anchorPos
    ? createAbsolutePosition(anchorPos, binding)
    : null;
  const focusAbsPos = focusPos
    ? createAbsolutePosition(focusPos, binding)
    : null;

  if (anchorAbsPos === null || focusAbsPos === null) {
    return {
      anchorKey: null,
      anchorOffset: 0,
      focusKey: null,
      focusOffset: 0,
    };
  }

  if (isBindingV1(binding)) {
    const [anchorCollabNode, anchorOffset] = getCollabNodeAndOffset(
      binding,
      anchorAbsPos.type,
      anchorAbsPos.index,
    );
    const [focusCollabNode, focusOffset] = getCollabNodeAndOffset(
      binding,
      focusAbsPos.type,
      focusAbsPos.index,
    );
    return {
      anchorKey: anchorCollabNode !== null ? anchorCollabNode.getKey() : null,
      anchorOffset,
      focusKey: focusCollabNode !== null ? focusCollabNode.getKey() : null,
      focusOffset,
    };
  }

  let [anchorNode, anchorOffset] = $getNodeAndOffsetV2(
    binding.mapping,
    anchorAbsPos,
  );
  let [focusNode, focusOffset] = $getNodeAndOffsetV2(
    binding.mapping,
    focusAbsPos,
  );
  // For a non-collapsed selection, if the start of the selection is as the end of a text node,
  // move it to the beginning of the next text node (if one exists).
  if (
    focusNode &&
    anchorNode &&
    (focusNode !== anchorNode || focusOffset !== anchorOffset)
  ) {
    const isBackwards = focusNode.isBefore(anchorNode);
    const startNode = isBackwards ? focusNode : anchorNode;
    const startOffset = isBackwards ? focusOffset : anchorOffset;
    if (
      $isTextNode(startNode) &&
      $isTextNode(startNode.getNextSibling()) &&
      startOffset === startNode.getTextContentSize()
    ) {
      if (isBackwards) {
        focusNode = startNode.getNextSibling();
        focusOffset = 0;
      } else {
        anchorNode = startNode.getNextSibling();
        anchorOffset = 0;
      }
    }
  }
  return {
    anchorKey: anchorNode !== null ? anchorNode.getKey() : null,
    anchorOffset,
    focusKey: focusNode !== null ? focusNode.getKey() : null,
    focusOffset,
  };
}

export function $syncLocalCursorPosition(
  binding: AnyBinding,
  provider: Provider,
): void {
  const awareness = provider.awareness;
  const localState = awareness.getLocalState();

  if (localState === null) {
    return;
  }

  const {anchorKey, anchorOffset, focusKey, focusOffset} =
    $getAnchorAndFocusForUserState(binding, localState);

  if (anchorKey !== null && focusKey !== null) {
    const selection = $getSelection();

    if (!$isRangeSelection(selection)) {
      return;
    }

    $setPoint(selection.anchor, anchorKey, anchorOffset);
    $setPoint(selection.focus, focusKey, focusOffset);
  }
}

function $setPoint(point: Point, key: NodeKey, offset: number): void {
  if (point.key !== key || point.offset !== offset) {
    let anchorNode = $getNodeByKey(key);
    if (
      anchorNode !== null &&
      !$isElementNode(anchorNode) &&
      !$isTextNode(anchorNode)
    ) {
      const parent = anchorNode.getParentOrThrow();
      key = parent.getKey();
      offset = anchorNode.getIndexWithinParent();
      anchorNode = parent;
    }
    point.set(key, offset, $isElementNode(anchorNode) ? 'element' : 'text');
  }
}

/**
 * Whether `sharedType` is inside the subtree this binding is bound to.
 *
 * Several editors can share one Yjs `Doc` (see the `rootName` and `getXmlText`
 * binding options), which also puts them on one awareness channel, so a peer's
 * position can describe a place in another editor's subtree. V1 resolves a
 * position through the collab node cached on the shared type
 * (`sharedType._collabNode`), which belongs to whichever binding materialized
 * it and carries `NodeKey`s that only mean something in that binding's editor.
 *
 * The test walks the yjs type tree rather than the collab nodes: a cached
 * collab node outlives the binding that created it (`destroy` does not clear
 * `_collabNode`, and a later binding reuses the node without re-parenting it),
 * so its `_parent` chain can still end at a previous binding's root even for a
 * position that is squarely inside this one.
 */
function isSharedTypeInBinding(
  binding: Binding,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharedType: any,
): boolean {
  const rootSharedType = binding.root.getSharedType();
  let type: null | {parent: unknown} = sharedType;
  while (type != null) {
    if (type === rootSharedType) {
      return true;
    }
    type = type.parent as null | {parent: unknown};
  }
  return false;
}

function getCollabNodeAndOffset(
  binding: Binding,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharedType: any,
  offset: number,
): [null | AnyCollabNode, number] {
  const collabNode = sharedType._collabNode;

  if (collabNode === undefined || !isSharedTypeInBinding(binding, sharedType)) {
    return [null, 0];
  }

  if (collabNode instanceof CollabElementNode) {
    const {node, offset: collabNodeOffset} = getPositionFromElementAndOffset(
      collabNode,
      offset,
      true,
    );

    if (node === null) {
      return [collabNode, collabNode._children.length];
    } else {
      return [node, collabNodeOffset];
    }
  }

  return [null, 0];
}

function $getNodeAndOffsetV2(
  mapping: CollabV2Mapping,
  absolutePosition: AbsolutePosition,
): [null | LexicalNode, number] {
  const yType = absolutePosition.type as XmlElement | XmlText;
  const yOffset = absolutePosition.index;
  if (yType instanceof XmlElement) {
    const node = mapping.get(yType);
    if (node === undefined) {
      return [null, 0];
    }
    if (!$isElementNode(node)) {
      return [node, yOffset];
    }
    let remainingYOffset = yOffset;
    let lexicalOffset = 0;
    const children = node.getChildren();
    while (remainingYOffset > 0 && lexicalOffset < children.length) {
      const child = children[lexicalOffset];
      remainingYOffset -= 1;
      lexicalOffset += 1;
      if ($isTextNode(child)) {
        while (
          lexicalOffset < children.length &&
          $isTextNode(children[lexicalOffset])
        ) {
          lexicalOffset += 1;
        }
      }
    }
    return [node, lexicalOffset];
  } else {
    const nodes = mapping.get(yType);
    if (nodes === undefined) {
      return [null, 0];
    }
    let i = 0;
    let adjustedOffset = yOffset;
    while (
      adjustedOffset > nodes[i].getTextContentSize() &&
      i + 1 < nodes.length
    ) {
      adjustedOffset -= nodes[i].getTextContentSize();
      i++;
    }
    const textNode = nodes[i];
    return [textNode, Math.min(adjustedOffset, textNode.getTextContentSize())];
  }
}

export type SyncCursorPositionsFn = (
  binding: AnyBinding,
  provider: Provider,
  options?: SyncCursorPositionsOptions,
) => void;

export type SyncCursorPositionsOptions = {
  getAwarenessStates?: (
    binding: BaseBinding,
    provider: Provider,
  ) => Map<number, UserState>;
  // Opt in to the CSS Custom Highlight API rendering for remote selections.
  // Plumbed in from the React collaboration plugin's `selectionHighlight` prop.
  selectionHighlight?: boolean;
};

function getAwarenessStatesDefault(
  _binding: BaseBinding,
  provider: Provider,
): Map<number, UserState> {
  return provider.awareness.getStates();
}

export function syncCursorPositions(
  binding: AnyBinding,
  provider: Provider,
  options?: SyncCursorPositionsOptions,
): void {
  const {
    getAwarenessStates = getAwarenessStatesDefault,
    selectionHighlight = false,
  } = options ?? {};
  const awarenessStates = Array.from(getAwarenessStates(binding, provider));
  const localClientID = binding.clientID;
  const cursors = binding.cursors;
  const editor = binding.editor;
  const collabTheme = editor._config.theme.collaboration;
  const nodeMap = editor._editorState._nodeMap;
  const visitedClientIDs = new Set();

  for (let i = 0; i < awarenessStates.length; i++) {
    const awarenessState = awarenessStates[i];
    const [clientID, awareness] = awarenessState;

    if (clientID !== 0 && clientID !== localClientID) {
      visitedClientIDs.add(clientID);
      const {name, color, focusing} = awareness;
      let selection = null;

      let cursor = cursors.get(clientID);

      if (cursor === undefined) {
        cursor = createCursor(name, color);
        cursors.set(clientID, cursor);
      } else if (cursor.name !== name || cursor.color !== color) {
        // Awareness is mutable: a peer can rename itself or change colour at
        // any time (the React plugin republishes local state whenever its
        // `username` / `cursorColor` props change). The name and colour are
        // baked into the caret DOM and the ::highlight() rule when the
        // selection is built, so drop the stale selection here and let the
        // code below rebuild it from the new values.
        destroyCursor(binding, cursor);
        cursor.name = name;
        cursor.color = color;
        cursor.selection = null;
      }

      if (focusing) {
        const {anchorKey, anchorOffset, focusKey, focusOffset} = editor.read(
          () => $getAnchorAndFocusForUserState(binding, awareness),
        );

        if (anchorKey !== null && focusKey !== null) {
          selection = cursor.selection;

          if (selection === null) {
            selection = createCursorSelection(
              cursor,
              binding,
              clientID,
              anchorKey,
              anchorOffset,
              focusKey,
              focusOffset,
              selectionHighlight,
              collabTheme,
            );
          } else {
            const anchor = selection.anchor;
            const focus = selection.focus;
            anchor.key = anchorKey;
            anchor.offset = anchorOffset;
            focus.key = focusKey;
            focus.offset = focusOffset;
          }
        }
      }

      updateCursor(binding, cursor, selection, nodeMap, collabTheme);
    }
  }

  const allClientIDs = Array.from(cursors.keys());

  for (let i = 0; i < allClientIDs.length; i++) {
    const clientID = allClientIDs[i];

    if (!visitedClientIDs.has(clientID)) {
      const cursor = cursors.get(clientID);

      if (cursor !== undefined) {
        destroyCursor(binding, cursor);
        cursors.delete(clientID);
      }
    }
  }
}

export function syncLexicalSelectionToYjs(
  binding: AnyBinding,
  provider: Provider,
  prevSelection: null | BaseSelection,
  nextSelection: null | BaseSelection,
): void {
  const awareness = provider.awareness;
  const localState = awareness.getLocalState();

  if (localState === null) {
    return;
  }

  const {
    anchorPos: currentAnchorPos,
    focusPos: currentFocusPos,
    name,
    color,
    focusing,
    awarenessData,
  } = localState;
  let anchorPos = null;
  let focusPos = null;

  if (
    nextSelection === null ||
    (currentAnchorPos !== null && !nextSelection.is(prevSelection))
  ) {
    if (prevSelection === null) {
      return;
    }
  }

  if ($isRangeSelection(nextSelection)) {
    // For a non-collapsed range, give each endpoint an assoc that sticks it to
    // the character it should track rather than the gap between characters:
    //   left endpoint  (assoc >= 0): anchors to the first selected character,
    //                                so inserts before the selection stay outside.
    //   right endpoint (assoc  < 0): anchors to the last selected character,
    //                                so inserts after the selection stay outside.
    // Collapsed carets keep assoc = 0 on both sides (the default) so the caret
    // naturally follows typing, matching the pre-existing behaviour.
    const isCollapsed = nextSelection.isCollapsed();
    const isBackward = !isCollapsed && nextSelection.isBackward();
    const anchorAssoc = isBackward ? -1 : 0;
    const focusAssoc = !isCollapsed && !isBackward ? -1 : 0;
    if (isBindingV1(binding)) {
      anchorPos = createRelativePosition(
        nextSelection.anchor,
        binding,
        anchorAssoc,
      );
      focusPos = createRelativePosition(
        nextSelection.focus,
        binding,
        focusAssoc,
      );
    } else {
      anchorPos = createRelativePositionV2(
        nextSelection.anchor,
        binding,
        anchorAssoc,
      );
      focusPos = createRelativePositionV2(
        nextSelection.focus,
        binding,
        focusAssoc,
      );
    }
  }

  if (
    shouldUpdatePosition(currentAnchorPos, anchorPos) ||
    shouldUpdatePosition(currentFocusPos, focusPos)
  ) {
    awareness.setLocalState({
      ...localState,
      anchorPos,
      awarenessData,
      color,
      focusPos,
      focusing,
      name,
    });
  }
}
