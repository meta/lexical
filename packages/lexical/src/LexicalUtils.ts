/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {EditorState} from './LexicalEditorState';
import type {RootNode} from './nodes/LexicalRootNode';

import invariant from '@lexical/internal/invariant';

import {
  $createTextNode,
  $getPreviousSelection,
  $getSelection,
  $getTextNodeOffset,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isRootNode,
  $isTabNode,
  $isTextNode,
  DecoratorNode,
  DEFAULT_EDITOR_DOM_CONFIG,
  type ElementFormatType,
  ElementNode,
  HISTORY_MERGE_TAG,
  type LineBreakNode,
  normalizeClassNames,
  type UpdateTag,
} from '.';
import {
  CAN_USE_DOM,
  IS_APPLE,
  IS_APPLE_WEBKIT,
  IS_IOS,
  IS_SAFARI,
} from './environment';
import {
  COMPOSITION_START_CHAR,
  COMPOSITION_SUFFIX,
  DOM_DOCUMENT_FRAGMENT_TYPE,
  DOM_DOCUMENT_TYPE,
  DOM_ELEMENT_TYPE,
  DOM_TEXT_TYPE,
  ELEMENT_TYPE_TO_FORMAT,
  HAS_DIRTY_NODES,
  LTR_REGEX,
  NO_DIRTY_NODES,
  PROTOTYPE_CONFIG_METHOD,
  RTL_REGEX,
  TEXT_TYPE_TO_FORMAT,
} from './LexicalConstants';
import {type DOMSlot, ElementDOMSlot} from './LexicalDOMSlot';
import {
  type AnyLexicalCommand,
  type CommandPayloadArgs,
  type CommandPayloadType,
  type DOMSlotForNode,
  type EditorConfig,
  type EditorDOMRenderConfig,
  type EditorThemeClasses,
  type Klass,
  LexicalEditor,
  type MutatedNodes,
  type MutationListeners,
  type NodeMutation,
  type RegisteredNode,
  type RegisteredNodes,
} from './LexicalEditor';
import {flushRootMutations} from './LexicalMutations';
import {
  $isEphemeral,
  $isLexicalNode,
  $markEphemeral,
  LexicalNode,
  type LexicalPrivateDOM,
  type NodeKey,
  type NodeMap,
  type StaticNodeConfigValue,
} from './LexicalNode';
import {$normalizeSelection} from './LexicalNormalization';
import {
  $clampRangeSelectionToSlotFrame,
  type BaseSelection,
  type PointType,
  type RangeSelection,
} from './LexicalSelection';
import {
  $getSlot,
  $getSlotHostKey,
  $isSlotChild,
  $isSlotHost,
} from './LexicalSlot';
import {
  errorOnInfiniteTransforms,
  errorOnReadOnly,
  getActiveEditor,
  getActiveEditorState,
  internalGetActiveEditor,
  internalGetActiveEditorState,
  isCurrentlyReadOnlyMode,
  triggerCommandListeners,
} from './LexicalUpdates';
import {TabNode} from './nodes/LexicalTabNode';
import {type TextFormatType, TextNode} from './nodes/LexicalTextNode';

const __DEV__ = process.env.NODE_ENV !== 'production';

export const emptyFunction = () => {
  return;
};

let pendingNodeToClone: null | LexicalNode = null;
export function setPendingNodeToClone(pendingNode: null | LexicalNode): void {
  pendingNodeToClone = pendingNode;
}
export function getPendingNodeToClone(): null | LexicalNode {
  const node = pendingNodeToClone;
  pendingNodeToClone = null;
  return node;
}

// Internal, module-private sentinel passed as the second argument to an
// auto-synthesized clone (see getStaticNodeConfig) by the internal clone
// wrappers ($cloneWithProperties / $copyNode). Those wrappers are contractually
// responsible for calling `afterCloneFrom(node)` on the result exactly once, so
// they pass this sentinel to tell the synthesized clone NOT to call it too.
//
// An auto-synthesized clone has no explicit body, so when it is called *without*
// this sentinel — i.e. directly as `NodeClass.clone(node)`, a documented and
// idiomatic pattern before the $config() port — it must copy the source node's
// properties itself, otherwise callers silently get a default-constructed node
// with lost state (e.g. HeadingNode's tag reverting to 'h1').
//
// The signal is per-call rather than a module global, so it is unaffected by
// reentrancy: a clone (or afterCloneFrom) that happens to clone another node,
// even in another editor, does not accidentally suppress that node's own
// afterCloneFrom. It is also un-spoofable by external callers because the
// sentinel is not exported. afterCloneFrom is not guaranteed idempotent (some
// nodes accumulate state there, e.g. a version counter), so it is critical that
// it runs exactly once per clone regardless of call path.
const INTERNAL_SKIP_AFTER_CLONE_FROM: unique symbol = Symbol(
  'INTERNAL_SKIP_AFTER_CLONE_FROM',
);

let keyCounter = 1;

/** Resets the internal key counter, primarily for deterministic test output. */
export function resetRandomKey(): void {
  keyCounter = 1;
}

export function generateRandomKey(): string {
  return '' + keyCounter++;
}

/**
 * @internal
 */
export function getRegisteredNodeOrThrow(
  editor: LexicalEditor,
  nodeType: string,
): RegisteredNode {
  const registeredNode = getRegisteredNode(editor, nodeType);
  if (registeredNode === undefined) {
    invariant(false, 'registeredNode: Type %s not found', nodeType);
  }
  return registeredNode;
}

/**
 * @internal
 */
export function getRegisteredNode(
  editor: LexicalEditor,
  nodeType: string,
): undefined | RegisteredNode {
  return editor._nodes.get(nodeType);
}

export const isArray = Array.isArray;

/** @internal */
export const scheduleMicroTask: (fn: () => void) => void =
  typeof queueMicrotask === 'function'
    ? queueMicrotask
    : fn => {
        // No window prefix intended (#1400)
        Promise.resolve().then(fn);
      };

/** Returns true if the active element (resolved from the anchor's root) is a decorator's own input (e.g. an input, textarea, or foreign contentEditable) rather than Lexical-managed content. */
export function $isSelectionCapturedInDecoratorInput(
  anchorDOM: Node,
  preResolvedActiveElement?: Element | null,
): boolean {
  const activeElement =
    preResolvedActiveElement !== undefined
      ? preResolvedActiveElement
      : (() => {
          const root = anchorDOM.getRootNode();
          return isDOMDocumentNode(root) || isDOMShadowRoot(root)
            ? getActiveElementDeep(root)
            : null;
        })();

  if (!isHTMLElement(activeElement)) {
    return false;
  }
  // @experimental named-slots. A slot container is contentEditable inside an
  // otherwise non-editable decorator host, but its content is Lexical-managed —
  // not a foreign editor input — so it must stay under Lexical's DOM-selection
  // control instead of being treated as captured.
  if (activeElement.hasAttribute('data-lexical-slot')) {
    return false;
  }
  const nearestNode = $getNearestNodeFromDOMNode(activeElement);
  const nodeName = activeElement.nodeName;
  return (
    $isLexicalNode(nearestNode) &&
    (nodeName === 'INPUT' ||
      nodeName === 'TEXTAREA' ||
      (activeElement.contentEditable === 'true' &&
        getEditorPropertyFromDOMNode(activeElement) == null))
  );
}
/** @deprecated renamed to {@link $isSelectionCapturedInDecoratorInput} by @lexical/eslint-plugin rules-of-lexical */
export const isSelectionCapturedInDecoratorInput =
  $isSelectionCapturedInDecoratorInput;

/** Returns true if the given DOM anchor and focus nodes are inside the editor's root element and not captured by a decorator input. */
export function isSelectionWithinEditor(
  editor: LexicalEditor,
  anchorDOM: null | Node,
  focusDOM: null | Node,
): boolean {
  const rootElement = editor.getRootElement();
  if (!rootElement) {
    return false;
  }
  try {
    if (
      !anchorDOM ||
      !rootElement.contains(anchorDOM) ||
      !rootElement.contains(focusDOM)
    ) {
      return false;
    }
  } catch (_error) {
    return false;
  }
  return (
    getNearestEditorFromDOMNode(anchorDOM) === editor &&
    editor.read(
      'latest',
      () => !$isSelectionCapturedInDecoratorInput(anchorDOM),
    )
  );
}

/**
 * @returns true if the given argument is a LexicalEditor instance from this build of Lexical
 */
export function isLexicalEditor(editor: unknown): editor is LexicalEditor {
  // Check instanceof to prevent issues with multiple embedded Lexical installations
  return editor instanceof LexicalEditor;
}

/** Returns the nearest LexicalEditor instance by walking up the DOM tree from the given node, or null if none is found. */
export function getNearestEditorFromDOMNode(
  node: Node | null,
): LexicalEditor | null {
  let currentNode = node;
  while (currentNode != null) {
    const editor = getEditorPropertyFromDOMNode(currentNode);
    if (isLexicalEditor(editor)) {
      return editor;
    }
    currentNode = getParentElement(currentNode);
  }
  return null;
}

/** @internal */
export function getEditorPropertyFromDOMNode(node: Node | null): unknown {
  // @ts-expect-error: internal field
  return node ? node.__lexicalEditor : null;
}

/** Returns the text direction ('ltr' or 'rtl') of the given string, or null if it contains no strong directional characters. */
export function getTextDirection(text: string): 'ltr' | 'rtl' | null {
  if (RTL_REGEX.test(text)) {
    return 'rtl';
  }
  if (LTR_REGEX.test(text)) {
    return 'ltr';
  }
  return null;
}

/**
 * Return true if the TextNode is a TabNode or is in token mode.
 */
export function $isTokenOrTab(node: TextNode): boolean {
  return $isTabNode(node) || node.isToken();
}

/**
 * Return true if the TextNode is a TabNode, or is in token or segmented mode.
 */
export function $isTokenOrSegmented(node: TextNode): boolean {
  return $isTokenOrTab(node) || node.isSegmented();
}

/**
 * @param node - The element being tested
 * @returns Returns true if node is an DOM Text node, false otherwise.
 */
export function isDOMTextNode(node: unknown): node is Text {
  return isDOMNode(node) && node.nodeType === DOM_TEXT_TYPE;
}

/**
 * @param node - The element being tested
 * @returns Returns true if node is an DOM Document node, false otherwise.
 */
export function isDOMDocumentNode(node: unknown): node is Document {
  return isDOMNode(node) && node.nodeType === DOM_DOCUMENT_TYPE;
}

/** Returns the first DOM Text node found by descending the firstChild chain from the given node, or null. */
export function getDOMTextNode(element: Node | null): Text | null {
  let node = element;
  while (node != null) {
    if (isDOMTextNode(node)) {
      return node;
    }
    node = node.firstChild;
  }
  return null;
}

/** Toggles the given text format type on a format bitmask, clearing mutually exclusive formats (subscript/superscript, lowercase/uppercase/capitalize). */
export function toggleTextFormatType(
  format: number,
  type: TextFormatType,
  alignWithFormat: null | number,
): number {
  const activeFormat = TEXT_TYPE_TO_FORMAT[type];
  if (
    alignWithFormat !== null &&
    (format & activeFormat) === (alignWithFormat & activeFormat)
  ) {
    return format;
  }
  let newFormat = format ^ activeFormat;
  if (type === 'subscript') {
    newFormat &= ~TEXT_TYPE_TO_FORMAT.superscript;
  } else if (type === 'superscript') {
    newFormat &= ~TEXT_TYPE_TO_FORMAT.subscript;
  } else if (type === 'lowercase') {
    newFormat &= ~TEXT_TYPE_TO_FORMAT.uppercase;
    newFormat &= ~TEXT_TYPE_TO_FORMAT.capitalize;
  } else if (type === 'uppercase') {
    newFormat &= ~TEXT_TYPE_TO_FORMAT.lowercase;
    newFormat &= ~TEXT_TYPE_TO_FORMAT.capitalize;
  } else if (type === 'capitalize') {
    newFormat &= ~TEXT_TYPE_TO_FORMAT.lowercase;
    newFormat &= ~TEXT_TYPE_TO_FORMAT.uppercase;
  }
  return newFormat;
}

/** Returns true if the given node is a leaf (TextNode, LineBreakNode, or DecoratorNode). */
export function $isLeafNode(
  node: LexicalNode | null | undefined,
): node is TextNode | LineBreakNode | DecoratorNode<unknown> {
  return $isTextNode(node) || $isLineBreakNode(node) || $isDecoratorNode(node);
}

export function $setNodeKey(
  node: LexicalNode,
  existingKey: NodeKey | null | undefined,
): void {
  const pendingNode = getPendingNodeToClone();
  existingKey = existingKey || (pendingNode && pendingNode.__key);
  if (existingKey != null) {
    if (__DEV__) {
      errorOnNodeKeyConstructorMismatch(node, existingKey, pendingNode);
    }
    node.__key = existingKey;
    return;
  }
  errorOnReadOnly();
  errorOnInfiniteTransforms();
  const editor = getActiveEditor();
  const editorState = getActiveEditorState();
  const key = generateRandomKey();
  editorState._nodeMap.set(key, node);
  // TODO Split this function into leaf/element
  if ($isElementNode(node)) {
    editor._dirtyElements.set(key, true);
  } else {
    editor._dirtyLeaves.add(key);
  }
  editor._cloneNotNeeded.add(key);
  // Don't downgrade FULL_RECONCILE; upgrade only when nothing has been marked yet.
  if (editor._dirtyType === NO_DIRTY_NODES) {
    editor._dirtyType = HAS_DIRTY_NODES;
  }
  node.__key = key;
}

function errorOnNodeKeyConstructorMismatch(
  node: LexicalNode,
  existingKey: NodeKey,
  pendingNode: null | LexicalNode,
) {
  const editorState = internalGetActiveEditorState();
  if (!editorState) {
    // tests expect to be able to do this kind of clone without an active editor state
    return;
  }
  const existingNode = editorState._nodeMap.get(existingKey);
  if (pendingNode) {
    invariant(
      existingKey === pendingNode.__key,
      'Lexical node with constructor %s (type %s) has an incorrect clone implementation, got %s for nodeKey when expecting %s',
      node.constructor.name,
      node.getType(),
      String(existingKey),
      pendingNode.__key,
    );
  }
  if (existingNode && existingNode.constructor !== node.constructor) {
    // Lifted condition to if statement because the inverted logic is a bit confusing
    if (node.constructor.name !== existingNode.constructor.name) {
      invariant(
        false,
        'Lexical node with constructor %s attempted to re-use key from node in active editor state with constructor %s. Keys must not be re-used when the type is changed.',
        node.constructor.name,
        existingNode.constructor.name,
      );
    } else {
      invariant(
        false,
        'Lexical node with constructor %s attempted to re-use key from node in active editor state with different constructor with the same name (possibly due to invalid Hot Module Replacement). Keys must not be re-used when the type is changed.',
        node.constructor.name,
      );
    }
  }
}

type IntentionallyMarkedAsDirtyElement = boolean;

function internalMarkParentElementsAsDirty(
  parentKey: NodeKey,
  nodeMap: NodeMap,
  dirtyElements: Map<NodeKey, IntentionallyMarkedAsDirtyElement>,
): void {
  let nextParentKey: string | null = parentKey;
  while (nextParentKey !== null) {
    if (dirtyElements.has(nextParentKey)) {
      return;
    }
    const node = nodeMap.get(nextParentKey);
    if (node === undefined) {
      break;
    }
    dirtyElements.set(nextParentKey, false);
    // @experimental named-slots. A slotted node has no __parent; its
    // up-pointer is __slotHost. Crossing that boundary here lets a slot
    // content edit dirty the host so it re-reconciles. Non-slot trees keep
    // __slotHost === null, so this is the plain __parent walk there.
    nextParentKey =
      node.__parent !== null
        ? node.__parent
        : $isSlotChild(node)
          ? node.__slotHost
          : null;
  }
}

/**
 * Removes a node from its parent, updating all necessary pointers and links.
 * @internal
 *
 * This function does not adjust the editor's current selection. Callers
 * that need element-anchored offsets in the old parent to track the child
 * count change must call `$updateElementSelectionOnCreateDeleteNode` (with
 * `times = -1`) after invoking this — see `$removeNode`, `replace`,
 * `insertBefore`, and `insertAfter` for the pattern.
 *
 * This function is for internal use of the library.
 * Please do not use it as it may change in the future.
 */
export function $removeFromParent(node: LexicalNode): void {
  invariant(
    $getSlotHostKey(node) === null,
    '$removeFromParent: node %s is slotted into host %s; a slotted node and a child are mutually exclusive. Remove it from its slot first.',
    node.__key,
    String($getSlotHostKey(node)),
  );
  const oldParent = node.getParent();
  if (oldParent !== null) {
    const writableNode = node.getWritable();
    const writableParent = oldParent.getWritable();
    const prevSibling = node.getPreviousSibling();
    const nextSibling = node.getNextSibling();

    // Store sibling keys
    const nextSiblingKey = nextSibling !== null ? nextSibling.__key : null;
    const prevSiblingKey = prevSibling !== null ? prevSibling.__key : null;

    // Get writable siblings once
    const writablePrevSibling =
      prevSibling !== null ? prevSibling.getWritable() : null;
    const writableNextSibling =
      nextSibling !== null ? nextSibling.getWritable() : null;

    // Update parent's first/last pointers
    if (prevSibling === null) {
      writableParent.__first = nextSiblingKey;
    }
    if (nextSibling === null) {
      writableParent.__last = prevSiblingKey;
    }

    // Update sibling links
    if (writablePrevSibling !== null) {
      writablePrevSibling.__next = nextSiblingKey;
    }
    if (writableNextSibling !== null) {
      writableNextSibling.__prev = prevSiblingKey;
    }

    // Clear node's links
    writableNode.__prev = null;
    writableNode.__next = null;
    writableNode.__parent = null;

    // Update parent size
    writableParent.__size--;
  }
}
/** @deprecated renamed to {@link $removeFromParent} by @lexical/eslint-plugin rules-of-lexical */
export const removeFromParent = $removeFromParent;

// Never use this function directly! It will break
// the cloning heuristic. Instead use node.getWritable().
export function internalMarkNodeAsDirty(node: LexicalNode): void {
  errorOnInfiniteTransforms();
  invariant(
    !$isEphemeral(node),
    'internalMarkNodeAsDirty: Ephemeral nodes must not be marked as dirty (key %s type %s)',
    node.__key,
    node.__type,
  );
  const latest = node.getLatest();
  // @experimental named-slots. A slotted node's up-pointer is __slotHost,
  // not __parent; start the dirty walk from whichever is set so a slot
  // content edit propagates into the host. Non-slot trees keep
  // __slotHost === null, so this is the plain __parent start there.
  const parent =
    latest.__parent !== null
      ? latest.__parent
      : $isSlotChild(latest)
        ? latest.__slotHost
        : null;
  const editorState = getActiveEditorState();
  const editor = getActiveEditor();
  const nodeMap = editorState._nodeMap;
  const dirtyElements = editor._dirtyElements;
  if (parent !== null) {
    internalMarkParentElementsAsDirty(parent, nodeMap, dirtyElements);
  }
  const key = latest.__key;
  // Don't downgrade FULL_RECONCILE; upgrade only when nothing has been marked yet.
  if (editor._dirtyType === NO_DIRTY_NODES) {
    editor._dirtyType = HAS_DIRTY_NODES;
  }
  if ($isElementNode(node)) {
    dirtyElements.set(key, true);
  } else {
    editor._dirtyLeaves.add(key);
  }
}

export function internalMarkSiblingsAsDirty(node: LexicalNode) {
  const previousNode = node.getPreviousSibling();
  const nextNode = node.getNextSibling();
  if (previousNode !== null) {
    internalMarkNodeAsDirty(previousNode);
  }
  if (nextNode !== null) {
    internalMarkNodeAsDirty(nextNode);
  }
}

/** Sets the active composition key, marking the previous and new composition nodes as dirty for re-rendering. */
export function $setCompositionKey(compositionKey: null | NodeKey): void {
  errorOnReadOnly();
  const editor = getActiveEditor();
  const previousCompositionKey = editor._compositionKey;
  if (compositionKey !== previousCompositionKey) {
    editor._compositionKey = compositionKey;
    if (previousCompositionKey !== null) {
      const node = $getNodeByKey(previousCompositionKey);
      if (node !== null) {
        node.getWritable();
      }
    }
    if (compositionKey !== null) {
      const node = $getNodeByKey(compositionKey);
      if (node !== null) {
        node.getWritable();
      }
    }
  }
}

export function $getCompositionKey(): null | NodeKey {
  if (isCurrentlyReadOnlyMode()) {
    return null;
  }
  const editor = getActiveEditor();
  return editor._compositionKey;
}

/**
 * Returns the node with the given key from the active EditorState
 * (or the given EditorState), or null if it does not exist.
 */
export function $getNodeByKey(
  key: NodeKey,
  _editorState?: EditorState,
): LexicalNode | null;
/**
 * @deprecated The type parameter is an unchecked and unsafe cast,
 * equivalent to `$getNodeByKey(key) as T | null`, and will be removed
 * in a future release. Call this function without a type argument and
 * narrow the result with a type guard instead.
 */
export function $getNodeByKey<T extends LexicalNode>(
  key: NodeKey,
  _editorState?: EditorState,
): T | null;
export function $getNodeByKey(
  key: NodeKey,
  _editorState?: EditorState,
): LexicalNode | null {
  const editorState = _editorState || getActiveEditorState();
  const node = editorState._nodeMap.get(key);
  if (node === undefined) {
    return null;
  }
  return node;
}

/** Returns the LexicalNode directly associated with the given DOM node, or null if the DOM node has no Lexical key. */
export function $getNodeFromDOMNode(
  dom: Node,
  editorState?: EditorState,
): LexicalNode | null {
  const editor = getActiveEditor();
  const key = getNodeKeyFromDOMNode(dom, editor);
  if (key !== undefined) {
    return $getNodeByKey(key, editorState);
  }
  return null;
}

export function setNodeKeyOnDOMNode(
  dom: Node,
  editor: LexicalEditor,
  key: NodeKey,
) {
  const prop = `__lexicalKey_${editor._key}`;
  (dom as Node & Record<typeof prop, NodeKey | undefined>)[prop] = key;
}

export function clearNodeKeyOnDOMNode(dom: Node, editor: LexicalEditor) {
  const prop = `__lexicalKey_${editor._key}`;
  delete (dom as Node & Record<typeof prop, NodeKey | undefined>)[prop];
}

export function getNodeKeyFromDOMNode(
  dom: Node,
  editor: LexicalEditor,
): NodeKey | undefined {
  const prop = `__lexicalKey_${editor._key}`;
  return (dom as Node & Record<typeof prop, NodeKey | undefined>)[prop];
}

/** Returns the nearest LexicalNode by walking up the DOM tree from the given node, or null if no Lexical node is found. */
export function $getNearestNodeFromDOMNode(
  startingDOM: Node,
  editorState?: EditorState,
): LexicalNode | null {
  let dom: Node | null = startingDOM;
  while (dom != null) {
    const node = $getNodeFromDOMNode(dom, editorState);
    if (node !== null) {
      return node;
    }
    dom = getParentElement(dom);
  }
  return null;
}

export function cloneDecorators(
  editor: LexicalEditor,
): Record<NodeKey, unknown> {
  const currentDecorators = editor._decorators;
  const pendingDecorators = Object.assign({}, currentDecorators);
  editor._pendingDecorators = pendingDecorators;
  return pendingDecorators;
}

export function getEditorStateTextContent(editorState: EditorState): string {
  return editorState.read(() => $getRoot().getTextContent());
}

export function markNodesWithTypesAsDirty(
  editor: LexicalEditor,
  types: string[],
): void {
  // We only need to mark nodes dirty if they were in the previous state.
  // If they aren't, then they are by definition dirty already.
  const cachedMap = getCachedTypeToNodeMap(editor.getEditorState());
  const dirtyNodeMaps: NodeMap[] = [];
  for (const type of types) {
    const nodeMap = cachedMap.get(type);
    if (nodeMap) {
      // By construction these are non-empty
      dirtyNodeMaps.push(nodeMap);
    }
  }
  // Nothing to mark dirty, no update necessary
  if (dirtyNodeMaps.length === 0) {
    return;
  }
  editor.update(
    () => {
      for (const nodeMap of dirtyNodeMaps) {
        for (const nodeKey of nodeMap.keys()) {
          // We are only concerned with nodes that are still in the latest NodeMap,
          // if they no longer exist then markDirty would raise an exception
          const latest = $getNodeByKey(nodeKey);
          if (latest) {
            latest.markDirty();
          }
        }
      }
    },
    editor._pendingEditorState === null
      ? {
          tag: HISTORY_MERGE_TAG,
        }
      : undefined,
  );
}

/** Returns the RootNode of the active EditorState. */
export function $getRoot(): RootNode {
  return internalGetRoot(getActiveEditorState());
}

export function internalGetRoot(editorState: EditorState): RootNode {
  return editorState._nodeMap.get('root') as RootNode;
}

/** Sets the current selection in the active EditorState, marking it dirty and clamping to slot boundaries when applicable. */
export function $setSelection(selection: null | BaseSelection): void {
  errorOnReadOnly();
  const editorState = getActiveEditorState();
  if (selection !== null) {
    if (__DEV__) {
      if (Object.isFrozen(selection)) {
        invariant(
          false,
          '$setSelection called on frozen selection object. Ensure selection is cloned before passing in.',
        );
      }
    }
    selection.dirty = true;
    selection.setCachedNodes(null);
    // @experimental named-slots. A RangeSelection committed through the API
    // must not straddle a slot boundary (slots are shadow-root-isolated), the
    // programmatic counterpart of the DOM-read clamp in selection resolution.
    // Gated on `_slotsUsed` so editors that never slot anything skip the walk,
    // mirroring the commit-time clamp.
    if ($isRangeSelection(selection) && getActiveEditor()._slotsUsed) {
      $clampRangeSelectionToSlotFrame(selection);
    }
  }
  editorState._selection = selection;
}

export function $flushMutations(): void {
  errorOnReadOnly();
  const editor = getActiveEditor();
  flushRootMutations(editor);
}

export function $getNodeFromDOM(dom: Node): null | LexicalNode {
  const editor = getActiveEditor();
  const nodeKey = getNodeKeyFromDOMTree(dom, editor);
  if (nodeKey === null) {
    return null;
  }
  return $getNodeByKey(nodeKey);
}

function getNodeKeyFromDOMTree(
  // Note that node here refers to a DOM Node, not an Lexical Node
  dom: Node,
  editor: LexicalEditor,
): NodeKey | null {
  let node: Node | null = dom;
  while (node != null) {
    const key = getNodeKeyFromDOMNode(node, editor);
    if (key !== undefined) {
      return key;
    }
    node = getParentElement(node);
  }
  return null;
}

/**
 * Return true if `str` contains any valid surrogate pair.
 *
 * See also $updateCaretSelectionForUnicodeCharacter for
 * a discussion on when and why this is useful.
 */
export function doesContainSurrogatePair(str: string): boolean {
  return /[\uD800-\uDBFF][\uDC00-\uDFFF]/g.test(str);
}

export function getEditorsToPropagate(editor: LexicalEditor): LexicalEditor[] {
  const editorsToPropagate: LexicalEditor[] = [];
  for (
    let currentEditor: LexicalEditor | null = editor;
    currentEditor !== null;
    currentEditor = currentEditor._parentEditor
  ) {
    editorsToPropagate.push(currentEditor);
  }
  return editorsToPropagate;
}

export function createUID(): string {
  return Math.random()
    .toString(36)
    .replace(/[^a-z]+/g, '')
    .substring(0, 5);
}

export function getAnchorTextFromDOM(anchorNode: Node): null | string {
  return isDOMTextNode(anchorNode) ? anchorNode.nodeValue : null;
}

export function $updateSelectedTextFromDOM(
  isCompositionEnd: boolean,
  editor: LexicalEditor,
  data?: string,
): void {
  // Update the text content with the latest composition text
  const domSelection = getDOMSelection(getWindow(editor));
  if (domSelection === null) {
    return;
  }
  const points = getDOMSelectionPoints(domSelection, editor._rootElement);
  const anchorNode = points.anchorNode;
  let {anchorOffset, focusOffset} = points;
  if (anchorNode !== null) {
    let textContent = getAnchorTextFromDOM(anchorNode);
    const node = $getNearestNodeFromDOMNode(anchorNode);
    if (textContent !== null && $isTextNode(node)) {
      // Data is intentionally truthy, as we check for boolean, null and empty string.
      if (
        (textContent === COMPOSITION_SUFFIX ||
          textContent === COMPOSITION_START_CHAR) &&
        data
      ) {
        const offset = data.length;
        textContent = data;
        anchorOffset = offset;
        focusOffset = offset;
      }

      if (textContent !== null) {
        $updateTextNodeFromDOMContent(
          node,
          textContent,
          anchorOffset,
          focusOffset,
          isCompositionEnd,
        );
      }
    }
  }
}

export function $updateTextNodeFromDOMContent(
  textNode: TextNode,
  textContent: string,
  anchorOffset: null | number,
  focusOffset: null | number,
  compositionEnd: boolean,
): void {
  let node = textNode;

  if (node.isAttached() && (compositionEnd || !node.isDirty())) {
    const isComposing = node.isComposing();

    if (node.isToken() && isComposing) {
      return;
    }

    let normalizedTextContent = textContent;

    if (isComposing || compositionEnd) {
      if (textContent.endsWith(COMPOSITION_SUFFIX)) {
        normalizedTextContent = textContent.slice(
          0,
          -COMPOSITION_SUFFIX.length,
        );
      }
      if (compositionEnd) {
        const char = COMPOSITION_START_CHAR;
        let index;
        while ((index = normalizedTextContent.indexOf(char)) !== -1) {
          normalizedTextContent =
            normalizedTextContent.slice(0, index) +
            normalizedTextContent.slice(index + char.length);

          if (anchorOffset !== null && anchorOffset > index) {
            anchorOffset = Math.max(index, anchorOffset - char.length);
          }

          if (focusOffset !== null && focusOffset > index) {
            focusOffset = Math.max(index, focusOffset - char.length);
          }
        }
      }
    }
    const prevTextContent = node.getTextContent();
    if (compositionEnd || normalizedTextContent !== prevTextContent) {
      const selection = $getSelection();

      if (normalizedTextContent === '') {
        $setCompositionKey(null);
        if (!IS_SAFARI && !IS_IOS && !IS_APPLE_WEBKIT) {
          // For composition (mainly Android), we have to remove the node on a later update
          const editor = getActiveEditor();
          $setTextContentWithSelection(node, '', selection);

          setTimeout(() => {
            editor.update(() => {
              if (node.isAttached() && node.getTextContent() === '') {
                node.remove();
              }
            });
          }, 20);
        } else {
          node.remove();
        }
        return;
      }
      const parent = node.getParent();
      const prevSelection = $getPreviousSelection();
      const prevTextContentSize = node.getTextContentSize();
      const compositionKey = $getCompositionKey();
      const nodeKey = node.getKey();

      if (
        (node.isToken() && !isComposing) ||
        (compositionKey !== null &&
          nodeKey === compositionKey &&
          !isComposing) ||
        // Check if character was added at the start or boundaries when not insertable, and we need
        // to clear this input from occurring as that action wasn't permitted.
        ($isRangeSelection(prevSelection) &&
          ((parent !== null &&
            !parent.canInsertTextBefore() &&
            prevSelection.anchor.offset === 0) ||
            (prevSelection.anchor.key === textNode.__key &&
              prevSelection.anchor.offset === 0 &&
              !node.canInsertTextBefore() &&
              !isComposing) ||
            (prevSelection.focus.key === textNode.__key &&
              prevSelection.focus.offset === prevTextContentSize &&
              !node.canInsertTextAfter() &&
              !isComposing)))
      ) {
        node.markDirty();
        return;
      }

      if (
        !$isRangeSelection(selection) ||
        anchorOffset === null ||
        focusOffset === null
      ) {
        $setTextContentWithSelection(node, normalizedTextContent, selection);
        return;
      }
      selection.setTextNodeRange(node, anchorOffset, node, focusOffset);

      if (node.isSegmented()) {
        const originalTextContent = node.getTextContent();
        const replacement = $createTextNode(originalTextContent);
        node.replace(replacement);
        node = replacement;
      }
      $setTextContentWithSelection(node, normalizedTextContent, selection);
    }
  }
}

function $setTextContentWithSelection(
  node: TextNode,
  textContent: string,
  selection: BaseSelection | null,
) {
  node.setTextContent(textContent);
  if ($isRangeSelection(selection)) {
    const key = node.getKey();
    let pointMutated = false;
    for (const k of ['anchor', 'focus'] as const) {
      const pt = selection[k];
      if (pt.type === 'text' && pt.key === key) {
        pt.offset = $getTextNodeOffset(node, pt.offset, 'clamp');
        pointMutated = true;
      }
    }
    if (pointMutated) {
      selection._cachedNodes = null;
      selection._cachedIsBackward = null;
    }
  }
}

function $previousSiblingDoesNotAcceptText(node: TextNode): boolean {
  const previousSibling = node.getPreviousSibling();

  return (
    ($isTextNode(previousSibling) ||
      ($isElementNode(previousSibling) && previousSibling.isInline())) &&
    !previousSibling.canInsertTextAfter()
  );
}

// This function is connected to $shouldPreventDefaultAndInsertText and determines whether the
// TextNode boundaries are writable or we should use the previous/next sibling instead. For example,
// in the case of a LinkNode, boundaries are not writable.
export function $shouldInsertTextAfterOrBeforeTextNode(
  selection: RangeSelection,
  node: TextNode,
): boolean {
  if (node.isSegmented()) {
    return true;
  }
  if (!selection.isCollapsed()) {
    return false;
  }
  const offset = selection.anchor.offset;
  const parent = node.getParentOrThrow();
  const isToken = $isTokenOrTab(node);
  if (offset === 0) {
    return (
      !node.canInsertTextBefore() ||
      (!parent.canInsertTextBefore() && !node.isComposing()) ||
      isToken ||
      $previousSiblingDoesNotAcceptText(node)
    );
  } else if (offset === node.getTextContentSize()) {
    return (
      !node.canInsertTextAfter() ||
      (!parent.canInsertTextAfter() && !node.isComposing()) ||
      isToken
    );
  } else {
    return false;
  }
}

/**
 * A KeyboardEvent or structurally similar object with a string `key` as well
 * as `altKey`, `ctrlKey`, `metaKey`, and `shiftKey` boolean properties.
 */
export type KeyboardEventModifiers = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
>;

/**
 * A record of keyboard modifiers that must be enabled.
 * If the value is `'any'` then the modifier key's state is ignored.
 * If the value is `true` then the modifier key must be pressed.
 * If the value is `false` or the property is omitted then the modifier key must
 * not be pressed.
 */
export type KeyboardEventModifierMask = {
  [K in Exclude<keyof KeyboardEventModifiers, 'key'>]?:
    | boolean
    | undefined
    | 'any';
};

function matchModifier(
  event: KeyboardEventModifiers,
  mask: KeyboardEventModifierMask,
  prop: keyof KeyboardEventModifierMask,
): boolean {
  const expected = mask[prop] || false;
  return expected === 'any' || expected === event[prop];
}

/**
 * Match a KeyboardEvent with its expected modifier state
 *
 * @param event A KeyboardEvent, or structurally similar object
 * @param mask An object specifying the expected state of the modifiers
 * @returns true if the event matches
 */
export function isModifierMatch(
  event: KeyboardEventModifiers,
  mask: KeyboardEventModifierMask,
): boolean {
  return (
    matchModifier(event, mask, 'altKey') &&
    matchModifier(event, mask, 'ctrlKey') &&
    matchModifier(event, mask, 'shiftKey') &&
    matchModifier(event, mask, 'metaKey')
  );
}

/**
 * Match a KeyboardEvent with its expected state
 *
 * @param event A KeyboardEvent, or structurally similar object
 * @param expectedKey The string to compare with event.key (case insensitive)
 * @param mask An object specifying the expected state of the modifiers
 * @returns true if the event matches
 */
export function isExactShortcutMatch(
  event: KeyboardEventModifiers,
  expectedKey: string,
  mask: KeyboardEventModifierMask,
): boolean {
  if (!isModifierMatch(event, mask)) {
    return false;
  }

  if (event.key.toLowerCase() === expectedKey.toLowerCase()) {
    // For special keys like Enter, Tab, ArrowUp, etc.
    // For default keys with English-based keyboard layout.
    return true;
  }

  if (expectedKey.length > 1) {
    // For non English-based keyboard layout but the key is a special key, we must not match it by `event.code`.
    return false;
  }

  if (event.key.length === 1 && event.key.charCodeAt(0) <= 127) {
    // For ASCII keys we must not match it by `event.code` because it would break remapped layouts (English (US) Dvorak, etc.).
    return false;
  }

  // Fallback for number keys
  if (event.code.startsWith('Digit') && /^\d$/.test(expectedKey)) {
    return event.code === `Digit${expectedKey}`;
  }

  const expectedCode = 'Key' + expectedKey.toUpperCase();

  // For default keys with not English-based keyboard layouts where `event.key` is non-ASCII, match by `event.code`.
  return event.code === expectedCode;
}

const CONTROL_OR_META = {ctrlKey: !IS_APPLE, metaKey: IS_APPLE};
const CONTROL_OR_ALT = {altKey: IS_APPLE, ctrlKey: !IS_APPLE};

export function isTab(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'Tab', {
    shiftKey: 'any',
  });
}

export function isBold(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'b', CONTROL_OR_META);
}

export function isItalic(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'i', CONTROL_OR_META);
}

export function isUnderline(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'u', CONTROL_OR_META);
}

export function isParagraph(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'Enter', {
    altKey: 'any',
    ctrlKey: 'any',
    metaKey: 'any',
  });
}

export function isLineBreak(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'Enter', {
    altKey: 'any',
    ctrlKey: 'any',
    metaKey: 'any',
    shiftKey: true,
  });
}

// Inserts a new line after the selection

export function isOpenLineBreak(event: KeyboardEventModifiers): boolean {
  // 79 = KeyO
  return IS_APPLE && isExactShortcutMatch(event, 'o', {ctrlKey: true});
}

export function isDeleteWordBackward(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'Backspace', CONTROL_OR_ALT);
}

export function isDeleteWordForward(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'Delete', CONTROL_OR_ALT);
}

export function isDeleteLineBackward(event: KeyboardEventModifiers): boolean {
  return IS_APPLE && isExactShortcutMatch(event, 'Backspace', {metaKey: true});
}

export function isDeleteLineForward(event: KeyboardEventModifiers): boolean {
  return (
    IS_APPLE &&
    (isExactShortcutMatch(event, 'Delete', {metaKey: true}) ||
      isExactShortcutMatch(event, 'k', {ctrlKey: true}))
  );
}

export function isDeleteBackward(event: KeyboardEventModifiers): boolean {
  return (
    isExactShortcutMatch(event, 'Backspace', {shiftKey: 'any'}) ||
    (IS_APPLE && isExactShortcutMatch(event, 'h', {ctrlKey: true}))
  );
}

export function isDeleteForward(event: KeyboardEventModifiers): boolean {
  return (
    isExactShortcutMatch(event, 'Delete', {}) ||
    (IS_APPLE && isExactShortcutMatch(event, 'd', {ctrlKey: true}))
  );
}

export function isUndo(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'z', CONTROL_OR_META);
}

export function isRedo(event: KeyboardEventModifiers): boolean {
  if (IS_APPLE) {
    return isExactShortcutMatch(event, 'z', {metaKey: true, shiftKey: true});
  }
  return (
    isExactShortcutMatch(event, 'y', {ctrlKey: true}) ||
    isExactShortcutMatch(event, 'z', {ctrlKey: true, shiftKey: true})
  );
}

export function isCopy(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'c', CONTROL_OR_META);
}

export function isCut(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'x', CONTROL_OR_META);
}

export function isMoveBackward(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'ArrowLeft', {
    shiftKey: 'any',
  });
}

export function isMoveToStart(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'ArrowLeft', {
    ...CONTROL_OR_META,
    shiftKey: 'any',
  });
}

export function isMoveForward(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'ArrowRight', {
    shiftKey: 'any',
  });
}

export function isMoveToEnd(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'ArrowRight', {
    ...CONTROL_OR_META,
    shiftKey: 'any',
  });
}

export function isMoveUp(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'ArrowUp', {
    altKey: 'any',
    shiftKey: 'any',
  });
}

export function isMoveDown(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'ArrowDown', {
    altKey: 'any',
    shiftKey: 'any',
  });
}

export function isModifier(event: KeyboardEventModifiers): boolean {
  return event.ctrlKey || event.shiftKey || event.altKey || event.metaKey;
}

export function isSpace(event: KeyboardEventModifiers): boolean {
  return event.key === ' ';
}

export function controlOrMeta(metaKey: boolean, ctrlKey: boolean): boolean {
  if (IS_APPLE) {
    return metaKey;
  }
  return ctrlKey;
}

export function isBackspace(event: KeyboardEventModifiers): boolean {
  return event.key === 'Backspace';
}

export function isEscape(event: KeyboardEventModifiers): boolean {
  return event.key === 'Escape';
}

export function isDelete(event: KeyboardEventModifiers): boolean {
  return event.key === 'Delete';
}

export function isSelectAll(event: KeyboardEventModifiers): boolean {
  return isExactShortcutMatch(event, 'a', CONTROL_OR_META);
}

/** Selects all content within the root. If a selection is provided, scopes to the nearest root or shadow root; otherwise creates a new RangeSelection spanning the entire root. */
export function $selectAll(selection?: RangeSelection | null): RangeSelection {
  const root = $getRoot();

  if ($isRangeSelection(selection)) {
    const anchor = selection.anchor;
    const focus = selection.focus;
    const anchorNode = anchor.getNode();
    // `RootNode.getTopLevelElementOrThrow` always throws by design, so when
    // the caret is at the root's element-level (typically after deleting
    // every top-level child) fall through to the regular "select all root
    // children" path before the throw fires.
    if ($isRootNode(anchorNode)) {
      anchor.set(anchorNode.getKey(), 0, 'element');
      focus.set(anchorNode.getKey(), anchorNode.getChildrenSize(), 'element');
      $normalizeSelection(selection);
      return selection;
    }
    const topParent = anchorNode.getTopLevelElementOrThrow();
    // A slot value's getTopLevelElement stops at itself (slot boundary) and
    // its __parent is null (its up-link is __slotHost), so getParentOrThrow
    // would throw. Scope SELECT_ALL to the slot value's contents instead —
    // anchor at its first child, focus at its last — which matches the
    // shadow-root semantics the slot boundary advertises. The
    // `$isElementNode` narrow guards `getChildrenSize` (a non-inline
    // DecoratorNode is also a valid slot-value shape but has no children
    // channel).
    const parent = topParent.getParent();
    if (parent === null) {
      // ElementNode-shaped slot value: scope selection to its contents.
      // A non-inline DecoratorNode is also a valid slot value but carries no
      // children channel; the explicit narrow surfaces a future protocol
      // drift instead of throwing at `getChildrenSize`. The Decorator
      // branch is currently unreachable from any RangeSelection anchor
      // because a non-inline decorator slot value has no editable text.
      if ($isElementNode(topParent)) {
        anchor.set(topParent.getKey(), 0, 'element');
        focus.set(topParent.getKey(), topParent.getChildrenSize(), 'element');
        $normalizeSelection(selection);
      }
      return selection;
    }
    const rootNode = parent;
    anchor.set(rootNode.getKey(), 0, 'element');
    focus.set(rootNode.getKey(), rootNode.getChildrenSize(), 'element');
    $normalizeSelection(selection);
    return selection;
  } else {
    // Create a new RangeSelection
    const newSelection = root.select(0, root.getChildrenSize());
    $setSelection($normalizeSelection(newSelection));
    return newSelection;
  }
}

export function getCachedClassNameArray(
  classNamesTheme: EditorThemeClasses,
  classNameThemeType: string,
): string[] {
  if (classNamesTheme.__lexicalClassNameCache === undefined) {
    classNamesTheme.__lexicalClassNameCache = {};
  }
  const classNamesCache = classNamesTheme.__lexicalClassNameCache;
  const cachedClassNames = classNamesCache[classNameThemeType];
  if (cachedClassNames !== undefined) {
    return cachedClassNames;
  }
  const classNames = classNamesTheme[classNameThemeType];
  // As we're using classList, we need
  // to handle className tokens that have spaces.
  // The easiest way to do this to convert the
  // className tokens to an array that can be
  // applied to classList.add()/remove().
  if (typeof classNames === 'string') {
    const classNamesArr = normalizeClassNames(classNames);
    classNamesCache[classNameThemeType] = classNamesArr;
    return classNamesArr;
  }
  return classNames;
}

export function setMutatedNode(
  mutatedNodes: MutatedNodes,
  registeredNodes: RegisteredNodes,
  mutationListeners: MutationListeners,
  node: LexicalNode,
  mutation: NodeMutation,
) {
  if (mutationListeners.size === 0) {
    return;
  }
  const nodeType = node.__type;
  const nodeKey = node.__key;
  const registeredNode = registeredNodes.get(nodeType);
  if (registeredNode === undefined) {
    invariant(false, 'Type %s not in registeredNodes', nodeType);
  }
  const klass = registeredNode.klass;
  let mutatedNodesByType = mutatedNodes.get(klass);
  if (mutatedNodesByType === undefined) {
    mutatedNodesByType = new Map();
    mutatedNodes.set(klass, mutatedNodesByType);
  }
  const prevMutation = mutatedNodesByType.get(nodeKey);
  // If the node has already been "destroyed", yet we are
  // re-making it, then this means a move likely happened.
  // We should change the mutation to be that of "updated"
  // instead.
  const isMove = prevMutation === 'destroyed' && mutation === 'created';
  if (prevMutation === undefined || isMove) {
    mutatedNodesByType.set(nodeKey, isMove ? 'updated' : mutation);
  }
}
/**
 * Returns all nodes of the given type in the active editor state.
 *
 * Consider {@link LexicalEditor.registerMutationListener} with
 * `skipInitialization: false` instead if you need to track these nodes over
 * time rather than read them once.
 */
export function $nodesOfType<T extends LexicalNode>(klass: Klass<T>): T[] {
  const klassType = klass.getType();
  const editorState = getActiveEditorState();
  if (editorState._readOnly) {
    const nodes = getCachedTypeToNodeMap(editorState).get(klassType) as
      | undefined
      | Map<string, T>;
    return nodes ? Array.from(nodes.values()) : [];
  }
  const nodes = editorState._nodeMap;
  const nodesOfType: T[] = [];
  for (const [, node] of nodes) {
    if (
      node instanceof klass &&
      node.__type === klassType &&
      node.isAttached()
    ) {
      nodesOfType.push(node as T);
    }
  }
  return nodesOfType;
}

function resolveElement(
  element: ElementNode,
  isBackward: boolean,
  focusOffset: number,
): LexicalNode | null {
  const parent = element.getParent();
  let offset = focusOffset;
  let block = element;
  if (parent !== null) {
    if (isBackward && focusOffset === 0) {
      offset = block.getIndexWithinParent();
      block = parent;
    } else if (!isBackward && focusOffset === block.getChildrenSize()) {
      offset = block.getIndexWithinParent() + 1;
      block = parent;
    }
  }
  return block.getChildAtIndex(isBackward ? offset - 1 : offset);
}

/** Returns the node adjacent to the given selection point in the specified direction, or null if at a boundary. */
export function $getAdjacentNode(
  focus: PointType,
  isBackward: boolean,
): null | LexicalNode {
  const focusOffset = focus.offset;
  if (focus.type === 'element') {
    const block = focus.getNode();
    return resolveElement(block, isBackward, focusOffset);
  } else {
    const focusNode = focus.getNode();
    if (
      (isBackward && focusOffset === 0) ||
      (!isBackward && focusOffset === focusNode.getTextContentSize())
    ) {
      const possibleNode = isBackward
        ? focusNode.getPreviousSibling()
        : focusNode.getNextSibling();
      if (possibleNode === null) {
        return resolveElement(
          focusNode.getParentOrThrow(),
          isBackward,
          focusNode.getIndexWithinParent() + (isBackward ? 0 : 1),
        );
      }
      return possibleNode;
    }
  }
  return null;
}

export function isFirefoxClipboardEvents(editor: LexicalEditor): boolean {
  const event = getWindow(editor).event;
  const inputType = event && (event as InputEvent).inputType;
  return (
    inputType === 'insertFromPaste' ||
    inputType === 'insertFromPasteAsQuotation'
  );
}

export function dispatchCommand<TCommand extends AnyLexicalCommand>(
  editor: LexicalEditor,
  command: TCommand,
  ...args: CommandPayloadArgs<CommandPayloadType<TCommand>>
): boolean {
  return triggerCommandListeners(
    editor,
    command,
    args[0] as CommandPayloadType<TCommand>,
    editor,
  );
}

export function getElementByKeyOrThrow(
  editor: LexicalEditor,
  key: NodeKey,
): HTMLElement {
  const element = editor._keyToDOMMap.get(key);

  if (element === undefined) {
    invariant(
      false,
      'Reconciliation: could not find DOM element for node key %s',
      key,
    );
  }

  return element;
}

/** Returns the parent element of a DOM node, crossing shadow root boundaries and following slot assignments. */
export function getParentElement(node: Node): HTMLElement | null {
  const parentElement =
    (node as HTMLSlotElement).assignedSlot || node.parentElement;
  if (parentElement !== null) {
    return parentElement;
  }
  // node.parentElement is null when the parent is a ShadowRoot (a
  // DocumentFragment, not an Element). Cross the shadow boundary to the host so
  // ancestor walks (getScrollParent, calculateZoomLevel) continue into the
  // enclosing light-DOM tree instead of stopping at the boundary.
  const parentNode = node.parentNode;
  return isDOMShadowRoot(parentNode) ? (parentNode.host as HTMLElement) : null;
}

/** Returns the owner Document of the given EventTarget, or the target itself if it is a Document. */
export function getDOMOwnerDocument(
  target: EventTarget | null,
): Document | null {
  return isDOMDocumentNode(target)
    ? target
    : isHTMLElement(target)
      ? target.ownerDocument
      : null;
}

export function scrollIntoViewIfNeeded(
  editor: LexicalEditor,
  selectionRect: DOMRect,
  rootElement: HTMLElement,
): void {
  const doc = getDOMOwnerDocument(rootElement);
  const defaultView = getDefaultView(doc);

  if (doc === null || defaultView === null) {
    return;
  }
  // A caret inside the editor can never sit entirely above the editor's own top
  // edge. Safari violates this for a collapsed caret in RTL text: it returns a
  // degenerate, out-of-bounds selection rect and reports the caret as
  // `selection.type === 'Range'`, which routes execution here (the `#1482` case
  // in `$updateDOMSelection`). Feeding that rect to the scroller jumps the
  // viewport up on every keystroke. Guard only this above-the-editor case — a
  // rect below the editor is the normal "scroll the caret into view" path and is
  // deliberately left untouched. See #2495.
  const rootRect = rootElement.getBoundingClientRect();
  if (selectionRect.bottom < rootRect.top) {
    return;
  }
  let {top: currentTop, bottom: currentBottom} = selectionRect;
  let targetTop = 0;
  let targetBottom = 0;
  let element: HTMLElement | null = rootElement;

  while (element !== null) {
    const isBodyElement = element === doc.body;
    if (isBodyElement) {
      // On mobile, the on-screen keyboard shrinks the visual viewport but
      // not the layout viewport (innerHeight).
      // selectionRect comes from getBoundingClientRect in layout-viewport coords,
      // so we must compare against visualViewport bounds,
      // or the caret stays behind the keyboard.
      const visualViewport = defaultView.visualViewport;
      if (visualViewport) {
        const offsetTop = visualViewport.offsetTop;
        targetTop = offsetTop;
        targetBottom = offsetTop + visualViewport.height;
      } else {
        targetTop = 0;
        targetBottom = getWindow(editor).innerHeight;
      }
      // Account for CSS scroll-padding on the document element
      const computedStyle = defaultView.getComputedStyle(doc.documentElement);
      const scrollPaddingTop = parseFloat(computedStyle.scrollPaddingTop);
      const scrollPaddingBottom = parseFloat(computedStyle.scrollPaddingBottom);
      if (isFinite(scrollPaddingTop)) {
        targetTop += scrollPaddingTop;
      }
      if (isFinite(scrollPaddingBottom)) {
        targetBottom -= scrollPaddingBottom;
      }
    } else {
      // Reuse the rect already measured for the guard above on the first
      // iteration (element === rootElement) to avoid a second layout flush.
      const targetRect =
        element === rootElement ? rootRect : element.getBoundingClientRect();
      targetTop = targetRect.top;
      targetBottom = targetRect.bottom;
    }
    let diff = 0;

    if (currentTop < targetTop) {
      diff = -(targetTop - currentTop);
    } else if (currentBottom > targetBottom) {
      diff = currentBottom - targetBottom;
    }

    if (diff !== 0) {
      if (isBodyElement) {
        // Only handles scrolling of Y axis
        defaultView.scrollBy(0, diff);
      } else {
        const scrollTop = element.scrollTop;
        element.scrollTop += diff;
        const yOffset = element.scrollTop - scrollTop;
        currentTop -= yOffset;
        currentBottom -= yOffset;
      }
    }
    if (isBodyElement) {
      break;
    }
    element = getParentElement(element);
  }
}

/** Returns true if the given tag has been added to the current update via $addUpdateTag. */
export function $hasUpdateTag(tag: UpdateTag): boolean {
  const editor = getActiveEditor();
  return editor._updateTags.has(tag);
}

/** Adds a tag to the current update, which can be read by update listeners and $hasUpdateTag. */
export function $addUpdateTag(tag: UpdateTag): void {
  errorOnReadOnly();
  const editor = getActiveEditor();
  editor._updateTags.add(tag);
}

/**
 * Add a function to run after the current update. This will run after any
 * `onUpdate` function already supplied to `editor.update()`, as well as any
 * functions added with previous calls to `$onUpdate`.
 *
 * @param updateFn The function to run after the current update.
 */
export function $onUpdate(updateFn: () => void): void {
  errorOnReadOnly();
  const editor = getActiveEditor();
  editor._deferred.push(updateFn);
}

export function $maybeMoveChildrenSelectionToParent(
  parentNode: LexicalNode,
): BaseSelection | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !$isElementNode(parentNode)) {
    return selection;
  }
  const {anchor, focus} = selection;
  const anchorNode = anchor.getNode();
  const focusNode = focus.getNode();
  if ($hasAncestor(anchorNode, parentNode)) {
    anchor.set(parentNode.__key, 0, 'element');
  }
  if ($hasAncestor(focusNode, parentNode)) {
    focus.set(parentNode.__key, 0, 'element');
  }
  return selection;
}

/** Returns true if targetNode is an ancestor of child by walking up the parent chain. */
export function $hasAncestor(
  child: LexicalNode,
  targetNode: LexicalNode,
): boolean {
  let parent = child.getParent();
  while (parent !== null) {
    if (parent.is(targetNode)) {
      return true;
    }
    parent = parent.getParent();
  }
  return false;
}

export function getDefaultView(domElem: EventTarget | null): Window | null {
  const ownerDoc = getDOMOwnerDocument(domElem);
  return ownerDoc ? ownerDoc.defaultView : null;
}

export function getWindow(editor: LexicalEditor): Window {
  const windowObj = editor._window;
  if (windowObj === null) {
    invariant(false, 'window object not found');
  }
  return windowObj;
}

const InlineNodeBrand: unique symbol = Symbol.for('@lexical/InlineNodeBrand');

/** Returns true if the given node is an inline ElementNode or an inline DecoratorNode. */
export function $isInlineElementOrDecoratorNode<T>(node: LexicalNode): node is (
  | ElementNode
  | DecoratorNode<T>
) & {
  isInline(): true;
  [InlineNodeBrand]: never;
} {
  return (
    ($isElementNode(node) && node.isInline()) ||
    ($isDecoratorNode(node) && node.isInline())
  );
}

/** Returns the given node itself (if it is a slot boundary) or its nearest ancestor that is a RootNode, ShadowRootNode, or slot boundary. */
export function $getNearestRootOrShadowRoot(
  node: LexicalNode,
): RootNode | ElementNode {
  let current = node.getLatest();
  while (current !== null) {
    // The slot link is a virtual shadow root: a slotted node is the root of
    // its own isolated scope (its parent is null), so it is the nearest
    // scope root for everything inside it — including itself.
    if ($getSlotHostKey(current) !== null && $isElementNode(current)) {
      return current;
    }
    const parent = current.getParentOrThrow();
    if ($isRootOrShadowRoot(parent)) {
      return parent;
    }
    current = parent;
  }
  return current;
}

const ShadowRootNodeBrand: unique symbol = Symbol.for(
  '@lexical/ShadowRootNodeBrand',
);
export interface ShadowRootNode extends ElementNode {
  [ShadowRootNodeBrand]: never;
  isShadowRoot(): true;
}

/** Returns true if the given node is an ElementNode whose isShadowRoot() returns true. */
export function $isShadowRootNode(
  node: null | LexicalNode,
): node is ShadowRootNode {
  return $isElementNode(node) && node.isShadowRoot();
}

/** Returns true if the given node is a RootNode or a ShadowRootNode. */
export function $isRootOrShadowRoot(
  node: null | LexicalNode,
): node is RootNode | ShadowRootNode {
  return $isRootNode(node) || $isShadowRootNode(node);
}

/**
 * Returns a shallow clone of node with a new key. All properties of the node
 * will be copied to the new node (by `clone` and then `afterCloneFrom`),
 * except those related to parent/sibling/child
 * relationships in the `EditorState`. This means that the copy must be
 * separately added to the document, and it will not have any children.
 *
 * @param node - The node to be copied.
 * @param skipReset - If true (default false) skip the call to resetOnCopyNodeFrom
 * @returns The copy of the node.
 */
export function $copyNode<T extends LexicalNode>(
  node: T,
  skipReset = false,
): T {
  const copy = (
    node.constructor.clone as (
      data: LexicalNode,
      internalSkipAfterCloneFrom?: typeof INTERNAL_SKIP_AFTER_CLONE_FROM,
    ) => T
  )(node, INTERNAL_SKIP_AFTER_CLONE_FROM);
  $setNodeKey(copy, null);
  copy.afterCloneFrom(node);
  if (!skipReset) {
    copy.resetOnCopyNodeFrom(node);
  }
  return copy;
}

/** Applies any registered node replacement for the given node's type, returning the replacement node or the original if none is registered. */
export function $applyNodeReplacement<N extends LexicalNode>(node: N): N {
  const editor = getActiveEditor();
  const nodeType = node.getType();
  const registeredNode = getRegisteredNode(editor, nodeType);
  invariant(
    registeredNode !== undefined,
    '$applyNodeReplacement node %s with type %s must be registered to the editor. You can do this by passing the node class via the "nodes" array in the editor config.',
    node.constructor.name,
    nodeType,
  );
  const {replace, replaceWithKlass} = registeredNode;
  if (replace !== null) {
    const replacementNode = replace(node);
    const replacementNodeKlass = replacementNode.constructor;
    if (replaceWithKlass !== null) {
      invariant(
        replacementNode instanceof replaceWithKlass,
        '$applyNodeReplacement failed. Expected replacement node to be an instance of %s with type %s but returned %s with type %s from original node %s with type %s',
        replaceWithKlass.name,
        replaceWithKlass.getType(),
        replacementNodeKlass.name,
        replacementNodeKlass.getType(),
        node.constructor.name,
        nodeType,
      );
    } else {
      invariant(
        replacementNode instanceof node.constructor &&
          replacementNodeKlass !== node.constructor,
        '$applyNodeReplacement failed. Ensure replacement node %s with type %s is a subclass of the original node %s with type %s.',
        replacementNodeKlass.name,
        replacementNodeKlass.getType(),
        node.constructor.name,
        nodeType,
      );
    }
    invariant(
      replacementNode.__key !== node.__key,
      '$applyNodeReplacement failed. Ensure that the key argument is *not* used in your replace function (from node %s with type %s to node %s with type %s), Node keys must never be re-used except by the static clone method.',
      node.constructor.name,
      nodeType,
      replacementNodeKlass.name,
      replacementNodeKlass.getType(),
    );
    return replacementNode as N;
  }
  return node;
}

export function errorOnInsertTextNodeOnRoot(
  node: LexicalNode,
  insertNode: LexicalNode,
): void {
  const parentNode = node.getParent();
  if (
    $isRootNode(parentNode) &&
    !$isElementNode(insertNode) &&
    !$isDecoratorNode(insertNode)
  ) {
    invariant(
      false,
      'Only element or decorator nodes can be inserted in to the root node',
    );
  }
}

/**
 * Returns the node with the given key from the active EditorState,
 * or throws if it does not exist.
 */
export function $getNodeByKeyOrThrow(key: NodeKey): LexicalNode;
/**
 * @deprecated The type parameter is an unchecked and unsafe cast,
 * equivalent to `$getNodeByKeyOrThrow(key) as N`, and will be removed
 * in a future release. Call this function without a type argument and
 * narrow the result with a type guard instead.
 */
export function $getNodeByKeyOrThrow<N extends LexicalNode>(key: NodeKey): N;
export function $getNodeByKeyOrThrow(key: NodeKey): LexicalNode {
  const node = $getNodeByKey(key);
  if (node === null) {
    invariant(
      false,
      "Expected node with key %s to exist but it's not in the nodeMap.",
      key,
    );
  }
  return node;
}

function $createBlockCursorElement(editorConfig: EditorConfig): HTMLDivElement {
  const theme = editorConfig.theme;
  const element = $getDocument().createElement('div');
  element.contentEditable = 'false';
  element.setAttribute('data-lexical-cursor', 'true');
  let blockCursorTheme = theme.blockCursor;
  if (blockCursorTheme !== undefined) {
    if (typeof blockCursorTheme === 'string') {
      const classNamesArr = normalizeClassNames(blockCursorTheme);
      // @ts-expect-error: intentional
      blockCursorTheme = theme.blockCursor = classNamesArr;
    }
    if (blockCursorTheme !== undefined) {
      element.classList.add(...blockCursorTheme);
    }
  }
  return element;
}

/**
 * Returns true if the given node needs a block cursor given an adjacent selection,
 * the node must be non-inline and one of:
 * - DecoratorNode
 * - ShadowRootNode with a parent that is not also a ShadowRootNode
 * - An ElementNode that can't be empty
 */
export function $needsBlockCursorBeside(node: null | LexicalNode): boolean {
  if (!node || node.isInline()) {
    return false;
  }
  if ($isDecoratorNode(node)) {
    return true;
  }
  if ($isElementNode(node)) {
    if (node.isShadowRoot()) {
      const parent = node.getParent();
      return !($isElementNode(parent) && parent.isShadowRoot());
    }
    return !node.canBeEmpty();
  }
  return false;
}

export function removeDOMBlockCursorElement(
  blockCursorElement: HTMLElement,
  editor: LexicalEditor,
  rootElement: HTMLElement,
) {
  rootElement.style.removeProperty('caret-color');
  editor._blockCursorElement = null;
  const parentElement = blockCursorElement.parentElement;
  if (parentElement !== null) {
    parentElement.removeChild(blockCursorElement);
  }
}

export function $updateDOMBlockCursorElement(
  editor: LexicalEditor,
  rootElement: HTMLElement,
  nextSelection: null | BaseSelection,
): void {
  let blockCursorElement = editor._blockCursorElement;

  if (
    $isRangeSelection(nextSelection) &&
    nextSelection.isCollapsed() &&
    nextSelection.anchor.type === 'element' &&
    // getActiveElement rather than document.activeElement, which reports the
    // shadow host (outside rootElement) when the editor is in a shadow root
    rootElement.contains(getActiveElement(rootElement))
  ) {
    const anchor = nextSelection.anchor;
    const elementNode = anchor.getNode();
    const offset = anchor.offset;
    const elementNodeSize = elementNode.getChildrenSize();
    let isBlockCursor = false;
    let insertBeforeElement: null | HTMLElement = null;

    if (offset === elementNodeSize) {
      const child = elementNode.getChildAtIndex(offset - 1);
      if ($needsBlockCursorBeside(child)) {
        isBlockCursor = true;
      }
    } else {
      const child = elementNode.getChildAtIndex(offset);
      if (child !== null && $needsBlockCursorBeside(child)) {
        isBlockCursor = true;
        insertBeforeElement = editor.getElementByKey(child.__key);
      }
    }
    if (isBlockCursor) {
      // Route through the slot so the cursor lands in the content-bearing
      // element. For a node whose `getDOMSlot` wraps its content, the keyed
      // DOM is the wrapper but the managed children (and `insertBeforeElement`)
      // live in `slot.element`; inserting into the keyed wrapper would throw
      // because the reference node is not its child.
      const elementDOM = $getDOMSlot(
        elementNode,
        editor.getElementByKey(elementNode.__key) as HTMLElement,
        editor,
      ).element;
      if (blockCursorElement === null) {
        editor._blockCursorElement = blockCursorElement =
          $createBlockCursorElement(editor._config);
      }
      rootElement.style.caretColor = 'transparent';
      if (insertBeforeElement === null) {
        elementDOM.appendChild(blockCursorElement);
      } else {
        elementDOM.insertBefore(blockCursorElement, insertBeforeElement);
      }
      return;
    }
  }
  // Remove cursor
  if (blockCursorElement !== null) {
    removeDOMBlockCursorElement(blockCursorElement, editor, rootElement);
  }
}

/**
 * Returns the selection for the given window, or the global window if null.
 * Will return null if {@link CAN_USE_DOM} is false.
 *
 * @param targetWindow The window to get the selection from
 * @returns a Selection or null
 */
export function getDOMSelection(targetWindow: null | Window): null | Selection {
  return !CAN_USE_DOM ? null : (targetWindow || window).getSelection();
}

/**
 * Returns the selection for the defaultView of the ownerDocument of given EventTarget.
 *
 * @param eventTarget The node to get the selection from
 * @returns a Selection or null
 */
export function getDOMSelectionFromTarget(
  eventTarget: null | EventTarget,
): null | Selection {
  const defaultView = getDefaultView(eventTarget);
  return defaultView ? defaultView.getSelection() : null;
}

/**
 * @param node A value that may be a DOM ShadowRoot.
 * @returns True if node is a DOM ShadowRoot (an open or closed shadow tree
 *   root), false otherwise. A ShadowRoot is a DocumentFragment with a host.
 *
 * @experimental Shape may change as shadow DOM support stabilizes.
 */
export function isDOMShadowRoot(node: unknown): node is ShadowRoot {
  return isDocumentFragment(node) && 'host' in node;
}

/**
 * Collects the DOM ShadowRoots between `node` and its document, innermost
 * first. Returns an empty array when `node` is in the light DOM (its root is
 * the Document) or is detached.
 *
 * Uses the standard {@link https://developer.mozilla.org/docs/Web/API/Node/getRootNode | Node.getRootNode}
 * and `ShadowRoot.host` platform APIs to walk out of any nested shadow trees.
 *
 * @param node The DOM node to start from (typically the editor root element).
 * @returns The enclosing ShadowRoots, innermost first.
 *
 * @experimental Shape may change as shadow DOM support stabilizes.
 */
const EMPTY_SHADOW_ROOTS: ShadowRoot[] = [];

export function getDOMShadowRoots(node: Node): ShadowRoot[] {
  const root = node.getRootNode();
  if (root === node || !isDOMShadowRoot(root)) {
    return EMPTY_SHADOW_ROOTS;
  }
  const shadowRoots: ShadowRoot[] = [root];
  let current: Node = root.host;
  for (;;) {
    const nextRoot = current.getRootNode();
    if (nextRoot === current || !isDOMShadowRoot(nextRoot)) {
      break;
    }
    shadowRoots.push(nextRoot);
    current = nextRoot.host;
  }
  return shadowRoots;
}

/**
 * Walks `root` and every open shadow root nested inside it, yielding each
 * element that matches `selector`. `querySelectorAll` does not pierce
 * shadow boundaries on its own; this descent does.
 *
 * @internal
 */
export function* findAllLexicalElementsDeep(
  initialRoot: Document | ShadowRoot,
): Generator<Element> {
  const roots = [initialRoot];
  let root;
  while ((root = roots.pop())) {
    yield* root.querySelectorAll('[data-lexical-editor="true"]');
    // Resolve the owning document by nodeType, not `instanceof Document`:
    // a Document from another realm (e.g. an iframe) is not an instance of
    // this realm's Document constructor, so `instanceof` would misclassify it
    // and fall back to the global `document`. A ShadowRoot's ownerDocument is
    // always its (realm-correct) Document.
    const doc = isDOMDocumentNode(root) ? root : root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el;
    while ((el = walker.nextNode() as null | Element)) {
      if (el.shadowRoot) {
        roots.push(el.shadowRoot);
      }
    }
  }
}

/**
 * Resolves the document that hosts an editor's root element, falling
 * back to the global `document` when the editor isn't mounted. Use this
 * over `editor.getRootElement()?.ownerDocument ?? document` so iframe /
 * shadow-mounted editors land in the right realm.
 *
 * @internal
 */
export function getRootOwnerDocument(
  rootElement: HTMLElement | null,
): Document {
  return rootElement !== null ? rootElement.ownerDocument : document;
}

/**
 * Returns the {@link Document} that owns the active editor's root element.
 * Falls back to `globalThis.document` when there is no active editor (e.g.
 * a node method such as `createDOM` / `exportDOM` is invoked headlessly,
 * outside of `editor.update()` / `editor.read()`), or when the active
 * editor has no root element (e.g. headless mode with
 * {@link @lexical/headless!withDOM | withDOM}).
 *
 * Use this inside `createDOM`, `updateDOM`, and `exportDOM` instead of the
 * bare `document` global so the node works correctly when the editor lives
 * inside a Shadow DOM or a cross-origin `<iframe>`.
 *
 * Unlike most `$`-prefixed helpers, this does NOT require an ambient active
 * editor: it must remain callable from `createDOM` / `exportDOM`, which are
 * public methods that consumers may legitimately call while serializing
 * nodes headlessly. Throwing here would silently break every node whose DOM
 * methods were migrated off the bare `document` global.
 */
export function $getDocument(): Document {
  const editor = internalGetActiveEditor();
  return getRootOwnerDocument(editor !== null ? editor._rootElement : null);
}

/**
 * A subset of `Selection` covering the four boundary-point fields Lexical
 * reads plus `direction`. Designed so a `Selection` instance can be returned
 * where a `DOMSelectionBoundaryPoints` is expected (see {@link getDOMSelectionPoints}).
 *
 * `direction` is the standard
 * {@link https://developer.mozilla.org/docs/Web/API/Selection/direction | Selection.direction}
 * pass-through: `'forward'` / `'backward'` / `'none'` when the engine
 * implements it, or `undefined` when a future engine ships
 * `getComposedRanges` without `direction` (no current shipping
 * configuration matches — every engine that ships the former also ships
 * the latter). In the undefined case anchor/focus default to the composed
 * StaticRange's tree order; callers needing strict backward fidelity
 * inside a shadow root should check `direction !== undefined`.
 *
 * @experimental Shape may change as shadow DOM support stabilizes.
 */
export interface DOMSelectionBoundaryPoints {
  anchorNode: Node | null;
  anchorOffset: number;
  direction?: undefined | 'forward' | 'backward' | 'none';
  focusNode: Node | null;
  focusOffset: number;
}

/**
 * Resolves a DOM Selection's range through any DOM ShadowRoots enclosing
 * `rootElement`, using the standard
 * {@link https://developer.mozilla.org/docs/Web/API/Selection/getComposedRanges | Selection.getComposedRanges}
 * platform API.
 *
 * When a selection is inside a shadow tree the browser retargets
 * `Selection.getRangeAt`/`anchorNode`/`focusNode` to the shadow host, which
 * hides the real nodes Lexical needs to resolve. Passing the enclosing shadow
 * roots to `getComposedRanges` returns the un-retargeted boundary points as a
 * {@link https://developer.mozilla.org/docs/Web/API/StaticRange | StaticRange}
 * (in tree order, i.e. start before end).
 *
 * @returns The composed StaticRange, or `null` when `rootElement` is in the
 *   light DOM, the platform does not implement `getComposedRanges`, or there
 *   is no selection.
 *
 * @experimental Shape may change as shadow DOM support stabilizes.
 */
export function getComposedStaticRange(
  domSelection: Selection,
  rootElement: HTMLElement | null,
): StaticRange | null {
  if (
    rootElement === null ||
    typeof domSelection.getComposedRanges !== 'function'
  ) {
    return null;
  }
  const shadowRoots = getDOMShadowRoots(rootElement);
  if (shadowRoots.length === 0) {
    return null;
  }
  // Prefer the standard dictionary form (Chrome, modern WebKit, Firefox);
  // fall back to the legacy variadic form shipped by Safari 17–18.1. A
  // browser that doesn't understand the dictionary may return an empty array
  // rather than throwing, so check the result on each attempt before
  // degrading.
  const getComposedRanges = domSelection.getComposedRanges as (
    ...args: unknown[]
  ) => StaticRange[];
  try {
    const dictRange = getComposedRanges.call(domSelection, {shadowRoots})[0];
    if (dictRange !== undefined) {
      return dictRange;
    }
  } catch (_error) {
    // Try the legacy variadic form.
  }
  try {
    const variadicRange = getComposedRanges.apply(domSelection, shadowRoots)[0];
    if (variadicRange !== undefined) {
      return variadicRange;
    }
  } catch (_error) {
    // Both forms failed — degrade.
  }
  return null;
}

/**
 * Returns a live DOM Range for the Selection, resolved through any DOM
 * ShadowRoots enclosing `rootElement`. Inside a shadow tree
 * `Selection.getRangeAt(0)` is retargeted to the shadow host, so this builds a
 * Range from the composed boundary points instead (see
 * {@link getComposedStaticRange}); in the light DOM it returns
 * `getRangeAt(0)` unchanged. Use this instead of `getRangeAt(0)` when the
 * Range is needed for layout (e.g. `getBoundingClientRect`), which a
 * StaticRange cannot provide.
 *
 * @returns A live Range, or null when the selection has no ranges.
 *
 * @experimental Shape may change as shadow DOM support stabilizes.
 */
export function getDOMSelectionRange(
  domSelection: Selection,
  rootElement: HTMLElement | null,
): Range | null {
  const staticRange = getComposedStaticRange(domSelection, rootElement);
  if (staticRange !== null) {
    const range = staticRangeToLiveRange(staticRange);
    if (range !== null) {
      return range;
    }
  }
  return domSelection.rangeCount > 0 ? domSelection.getRangeAt(0) : null;
}

/**
 * Resolves a DOM Selection's anchor/focus boundary points through any DOM
 * ShadowRoots enclosing `rootElement`. Inside a shadow tree the boundary
 * points come from {@link getComposedStaticRange} mapped back onto
 * anchor/focus with the standard
 * {@link https://developer.mozilla.org/docs/Web/API/Selection/direction | Selection.direction};
 * in the light DOM (or when `getComposedRanges` is unavailable) the Selection's
 * own anchorNode/focusNode are already correct, so the Selection is returned
 * as-is (it satisfies {@link DOMSelectionBoundaryPoints}).
 *
 * Use this instead of reading `Selection.anchorNode`/`focusNode` directly,
 * which are retargeted to the shadow host inside a shadow tree.
 *
 * @remarks
 * The two return paths have different read semantics:
 * - light DOM: the return aliases `domSelection`, so subsequent reads
 *   reflect any post-call selection changes. The aliasing is intentional;
 *   each `Selection` property read forces a synchronous style/layout
 *   recalculation, so `$updateDOMSelection` defers these reads until they
 *   are actually needed.
 * - shadow DOM: the return is a snapshot taken at call time, including
 *   `direction`. If a future engine ships `getComposedRanges` without
 *   `Selection.direction` (no current shipping configuration matches),
 *   the snapshot's `direction` is `undefined` and anchor/focus default
 *   to the StaticRange's tree order — a backward selection will appear
 *   forward.
 *
 * Read the four points immediately after the call, or compare identity
 * via `points === domSelection` to detect when the return aliases
 * `domSelection`, rather than caching the returned reference across
 * selection mutations.
 *
 * @experimental Shape may change as shadow DOM support stabilizes.
 */
export function getDOMSelectionPoints(
  domSelection: Selection,
  rootElement: HTMLElement | null,
): DOMSelectionBoundaryPoints {
  const staticRange = getComposedStaticRange(domSelection, rootElement);
  if (staticRange === null) {
    return domSelection as DOMSelectionBoundaryPoints;
  }
  return staticRangeToPoints(staticRange, readDirection(domSelection));
}

/**
 * Resolves the live DOM Range (for layout reads like `getBoundingClientRect`)
 * and the anchor/focus boundary points in one pass, sharing a single
 * {@link getComposedStaticRange} read rather than computing it twice as a
 * call to {@link getDOMSelectionRange} followed by {@link getDOMSelectionPoints}
 * would. Use this at sites that need both shapes from the same selection.
 *
 * @returns The composed Range plus the boundary points; the Range is null
 *   when the selection has no ranges.
 *
 * @experimental Shape may change as shadow DOM support stabilizes.
 */
export function getDOMSelectionRangeAndPoints(
  domSelection: Selection,
  rootElement: HTMLElement | null,
): {points: DOMSelectionBoundaryPoints; range: Range | null} {
  const staticRange = getComposedStaticRange(domSelection, rootElement);
  if (staticRange === null) {
    return {
      points: domSelection as DOMSelectionBoundaryPoints,
      range: domSelection.rangeCount > 0 ? domSelection.getRangeAt(0) : null,
    };
  }
  const range =
    staticRangeToLiveRange(staticRange) ??
    (domSelection.rangeCount > 0 ? domSelection.getRangeAt(0) : null);
  return {
    points: staticRangeToPoints(staticRange, readDirection(domSelection)),
    range,
  };
}

// Build a live DOM Range from a StaticRange's endpoints, in the container's
// own document so iframe / shadow trees resolve to the right Range constructor.
// Returns null when the container is detached or the endpoints reject (the
// caller can fall back to `domSelection.getRangeAt(0)` in that case).
function staticRangeToLiveRange(staticRange: StaticRange): Range | null {
  const doc = staticRange.startContainer.ownerDocument;
  if (doc === null) {
    return null;
  }
  const range = doc.createRange();
  try {
    range.setStart(staticRange.startContainer, staticRange.startOffset);
    range.setEnd(staticRange.endContainer, staticRange.endOffset);
    return range;
  } catch (_error) {
    return null;
  }
}

// Map a StaticRange + Selection.direction to anchor/focus pairs. Selection
// returns boundaries in tree order, so a backward direction reverses the
// pair before mapping (matching what Selection.anchorNode/focusNode would
// have reported in the light DOM). 'none' and undefined map to forward
// (anchor=start): a 'none' selection is directionless (e.g. created via
// Selection.addRange), which the spec pins to anchor=start/focus=end, so the
// forward mapping is correct — only directional APIs ever report 'backward'.
function staticRangeToPoints(
  staticRange: StaticRange,
  direction: 'forward' | 'backward' | 'none' | undefined,
): DOMSelectionBoundaryPoints {
  const {startContainer, startOffset, endContainer, endOffset} = staticRange;
  return direction === 'backward'
    ? {
        anchorNode: endContainer,
        anchorOffset: endOffset,
        direction,
        focusNode: startContainer,
        focusOffset: startOffset,
      }
    : {
        anchorNode: startContainer,
        anchorOffset: startOffset,
        direction,
        focusNode: endContainer,
        focusOffset: endOffset,
      };
}

function readDirection(
  domSelection: Selection,
): 'forward' | 'backward' | 'none' | undefined {
  return domSelection.direction as undefined | 'forward' | 'backward' | 'none';
}

/**
 * Returns the focused element within the same Document or ShadowRoot as
 * `node`, using the standard `DocumentOrShadowRoot.activeElement`.
 *
 * Unlike `document.activeElement` — which is retargeted to the outermost
 * shadow host when focus is inside a shadow tree — this returns the focused
 * element within `node`'s own tree (e.g. the editor's contentEditable when it
 * lives inside a shadow root).
 *
 * @param node A node whose tree's active element is wanted.
 * @returns The active element, or null.
 *
 * @experimental Shape may change as shadow DOM support stabilizes.
 */
export function getActiveElement(node: Node): Element | null {
  const root = node.getRootNode();
  return isDOMDocumentNode(root) || isDOMShadowRoot(root)
    ? root.activeElement
    : null;
}

/**
 * Descends from `root.activeElement` through nested open ShadowRoots to the
 * deepest focused element. `document.activeElement` only reports the outermost
 * shadow host; this walks into the shadow trees via `ShadowRoot.activeElement`
 * to find the element that actually has focus.
 *
 * @param root The Document or ShadowRoot to start from.
 * @returns The deepest active element, or null.
 *
 * @experimental Shape may change as shadow DOM support stabilizes.
 */
export function getActiveElementDeep(
  root: Document | ShadowRoot,
): Element | null {
  let active: Element | null = root.activeElement;
  while (active !== null && active.shadowRoot !== null) {
    const inner = active.shadowRoot.activeElement;
    if (inner === null) {
      break;
    }
    active = inner;
  }
  return active;
}

/**
 * Returns the un-retargeted event target — the real element the user
 * interacted with — for events observed by a listener above an enclosing
 * DOM shadow root. `Event.target` is retargeted to the outermost shadow
 * host in that case, hiding the actual element; `composedPath()[0]`
 * returns the original target for `composed: true` events (most
 * user-agent UI events: click, mousedown, pointerdown, focusin, etc.).
 * Falls back to `event.target` when `composedPath` is unavailable or
 * returns an empty array (e.g. the event has already finished
 * dispatching).
 *
 * Pairs with the shadow-aware helpers above
 * ({@link getDOMSelectionPoints}, {@link getActiveElement}) for the
 * event side of the shadow boundary — useful when an
 * `Element.contains(target)` check needs to test against an editor root
 * inside a shadow tree.
 *
 * @param event The dispatched event.
 * @returns The un-retargeted target, or null when the event has none.
 *
 * @experimental Shape may change as shadow DOM support stabilizes.
 */
export function getComposedEventTarget(event: Event): EventTarget | null {
  const target = event.target;
  if (
    target !== null &&
    isHTMLElement(target) &&
    target.shadowRoot !== null &&
    typeof event.composedPath === 'function'
  ) {
    const path = event.composedPath();
    if (path.length > 0) {
      return path[0];
    }
  }
  return target;
}

/** Splits an ElementNode at the given child offset, returning [original, newCopy]. The original is mutated (children after offset moved out); the first element may be null per the return type contract. Recursively splits ancestors up to the nearest root or shadow root. */
export function $splitNode(
  node: ElementNode,
  offset: number,
): [ElementNode | null, ElementNode] {
  let startNode = node.getChildAtIndex(offset);
  if (startNode == null) {
    startNode = node;
  }

  invariant(
    !$isRootOrShadowRoot(node),
    'Can not call $splitNode() on root element',
  );

  const recurse = <T extends LexicalNode>(
    currentNode: T,
  ): [ElementNode, ElementNode, T] => {
    const parent = currentNode.getParentOrThrow();
    const isParentRoot = $isRootOrShadowRoot(parent);
    // The node we start split from (leaf) is moved, but its recursive
    // parents are copied to create separate tree
    const nodeToMove =
      currentNode === startNode && !isParentRoot
        ? currentNode
        : $copyNode(currentNode);

    if (isParentRoot) {
      invariant(
        $isElementNode(currentNode) && $isElementNode(nodeToMove),
        'Children of a root must be ElementNode',
      );

      currentNode.insertAfter(nodeToMove);
      return [currentNode, nodeToMove, nodeToMove];
    } else {
      const [leftTree, rightTree, newParent] = recurse(parent);
      const nextSiblings = currentNode.getNextSiblings();

      newParent.append(nodeToMove, ...nextSiblings);
      return [leftTree, rightTree, nodeToMove];
    }
  };

  const [leftTree, rightTree] = recurse(startNode);

  return [leftTree, rightTree];
}

/**
 * @param x - The element being tested
 * @returns Returns true if x is an HTML anchor tag, false otherwise
 */
export function isHTMLAnchorElement(x: unknown): x is HTMLAnchorElement {
  return isHTMLElement(x) && x.tagName === 'A';
}

/**
 * @param x - The element being tested
 * @returns Returns true if x is an HTML `<tr>` element, false otherwise
 */
export function isHTMLTableRowElement(x: unknown): x is HTMLTableRowElement {
  return isHTMLElement(x) && x.tagName === 'TR';
}

/**
 * @param x - The element being tested
 * @returns Returns true if x is an HTML `<td>` or `<th>` element, false
 *   otherwise
 */
export function isHTMLTableCellElement(x: unknown): x is HTMLTableCellElement {
  return isHTMLElement(x) && (x.tagName === 'TD' || x.tagName === 'TH');
}

/**
 * @param x - The element being tested
 * @returns Returns true if x is an HTML element, false otherwise.
 */
export function isHTMLElement(x: unknown): x is HTMLElement {
  return isDOMNode(x) && x.nodeType === DOM_ELEMENT_TYPE;
}

/**
 * @param x - The element being tested
 * @returns Returns true if x is a DOM Node, false otherwise.
 */
export function isDOMNode(x: unknown): x is Node {
  return (
    typeof x === 'object' &&
    x !== null &&
    'nodeType' in x &&
    typeof x.nodeType === 'number'
  );
}

/**
 * @param x - The element being testing
 * @returns Returns true if x is a document fragment, false otherwise.
 */
export function isDocumentFragment(x: unknown): x is DocumentFragment {
  return isDOMNode(x) && x.nodeType === DOM_DOCUMENT_FRAGMENT_TYPE;
}

const INLINE_TAG_RE =
  /^(a|abbr|acronym|b|cite|code|del|em|i|ins|kbd|label|mark|output|q|ruby|s|samp|span|strong|sub|sup|time|u|tt|var|#text)$/i;

/**
 *
 * @param node - the Dom Node to check
 * @returns if the Dom Node is an inline node
 */
export function isInlineDomNode(
  node: Node,
): node is (HTMLElement | Text) & {[InlineDOMBrand]: never} {
  return isHTMLElement(node) && node.style.display.startsWith('inline')
    ? true
    : INLINE_TAG_RE.test(node.nodeName);
}

const BlockDOMBrand = Symbol.for('@lexical/BlockDOMBrand');
const InlineDOMBrand = Symbol.for('@lexical/InlineDOMBrand');

const BLOCK_TAG_RE =
  /^(address|article|aside|blockquote|canvas|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h1|h2|h3|h4|h5|h6|header|hr|li|main|nav|noscript|ol|p|pre|section|table|td|tfoot|ul|video)$/i;

/**
 *
 * @param node - the Dom Node to check
 * @returns if the Dom Node is a block node
 */
export function isBlockDomNode(
  node: Node,
): node is HTMLElement & {[BlockDOMBrand]: never} {
  return isHTMLElement(node) && node.style.display.startsWith('inline')
    ? false
    : BLOCK_TAG_RE.test(node.nodeName);
}

const BlockNodeBrand: unique symbol = Symbol.for('@lexical/BlockNodeBrand');

/**
 * @internal
 *
 * This function is for internal use of the library.
 * Please do not use it as it may change in the future.
 *
 * This function returns true for a DecoratorNode that is not inline OR
 * an ElementNode that is:
 * - not a root or shadow root
 * - not inline
 * - can't be empty
 * - has no children or an inline first child
 */
export function INTERNAL_$isBlock(
  node: LexicalNode,
): node is (ElementNode | DecoratorNode<unknown>) & {[BlockNodeBrand]: never} {
  if ($isDecoratorNode(node) && !node.isInline()) {
    return true;
  }
  if (!$isElementNode(node) || $isRootOrShadowRoot(node)) {
    return false;
  }

  const firstChild = node.getFirstChild();
  const isLeafElement =
    firstChild === null ||
    $isLineBreakNode(firstChild) ||
    $isTextNode(firstChild) ||
    firstChild.isInline();

  return !node.isInline() && node.canBeEmpty() !== false && isLeafElement;
}

/**
 * Utility function for accessing current active editor instance.
 * @returns Current active editor
 */
export function $getEditor(): LexicalEditor {
  return getActiveEditor();
}

/**
 * @experimental
 *
 * Read the editor's `$getDOMSlot` configuration (defaulting to the base
 * implementation when no override is registered via {@link DOMRenderExtension}).
 * Cross-package consumers (`@lexical/utils`, `@lexical/react`) use this to
 * route selection / DOM lookups through extension-configured slots.
 */
export function $getEditorDOMRenderConfig(
  editor: LexicalEditor = $getEditor(),
): EditorDOMRenderConfig {
  return editor._config.dom || DEFAULT_EDITOR_DOM_CONFIG;
}

/**
 * @experimental
 *
 * Resolve the DOM slot for a node through the configured `$getDOMSlot` hook,
 * narrowing the return type via {@link DOMSlotForNode}: for an `ElementNode`
 * the result is an {@link ElementDOMSlot} (with children-management methods),
 * for non-Element nodes the base {@link DOMSlot} pointing at the keyed DOM.
 *
 * Invariants if an extension override returns a slot that doesn't match the
 * expected narrow type for the node (extension contract violation).
 */
export function $getDOMSlot<N extends LexicalNode>(
  node: N,
  dom: HTMLElement,
  editor: LexicalEditor = $getEditor(),
): DOMSlotForNode<N> {
  const slot = $getEditorDOMRenderConfig(editor).$getDOMSlot(node, dom, editor);
  if ($isElementNode(node)) {
    invariant(
      $isElementDOMSlot(slot),
      '$getDOMSlot: expected ElementDOMSlot for ElementNode (key %s type %s)',
      node.getKey(),
      node.getType(),
    );
  }
  return slot;
}

/**
 * @internal
 *
 * Returns the scaffolding container element that `host`'s named slot renders
 * into, or null if the slot is empty or not yet rendered. The container is the
 * parent of the slotted node's DOM, resolved by key so it is found wherever it
 * sits — the reconciler parks it as a hidden placeholder in the host DOM, and
 * an explicit mount ({@link mountSlotContainer}) may relocate it; this lookup
 * still resolves it after that relocation. Editor-time analog of the
 * reconciler's internal `$slotContainerForKey`, which resolves the same
 * container from the reconcile-time DOM map instead of
 * `editor.getElementByKey`.
 */
export function $getSlotContainer(
  host: LexicalNode,
  name: string,
  editor: LexicalEditor = $getEditor(),
): HTMLElement | null {
  const slot = $getSlot(host, name);
  if (slot === null) {
    return null;
  }
  const slotDom = editor.getElementByKey(slot.getKey());
  return slotDom !== null ? slotDom.parentElement : null;
}

/**
 * @experimental
 *
 * Attach a host's named-slot container to `target` and make it visible.
 * The reconciler renders every slot subtree synchronously into a hidden
 * (`display: 'none'`) placeholder container parked slots-first in the host
 * DOM; nothing is visible until the host explicitly attaches the container
 * somewhere — mirroring how `getDOMSlot` gives an element control over where
 * its linked-list children render. This helper moves the container into
 * `target` (a no-op when it is already there, so mounting in place just
 * reveals it) and clears the inline `display` so the container renders as a
 * normal block that stylesheets may restyle. It deliberately does NOT use
 * `display: 'contents'`: Chromium cannot reliably edit inside a boxless
 * contenteditable subtree (caret hit-testing resolves clicks to a
 * neighboring box and native text insertion is dropped).
 *
 * Idempotent and framework-independent: lexical-react's `useLexicalSlotRef`
 * wraps it, and a node class or extension can call it directly (e.g. from a
 * mutation listener) to control slot placement without React.
 *
 * @returns the container, or null when the slot (or its DOM) does not exist
 * yet — e.g. before the host's first reconciliation.
 */
export function mountSlotContainer(
  editor: LexicalEditor,
  nodeKey: NodeKey,
  slotName: string,
  target: HTMLElement,
): HTMLElement | null {
  const container = editor.read('latest', () => {
    const host = $getNodeByKey(nodeKey);
    return host !== null ? $getSlotContainer(host, slotName, editor) : null;
  });
  if (container !== null) {
    if (container.parentElement !== target) {
      target.appendChild(container);
    }
    container.style.display = '';
  }
  return container;
}

/**
 * @experimental
 *
 * Reverse of {@link mountSlotContainer}: hide `container` again and park it
 * back in the host's DOM as the leading hidden placeholder, where the
 * reconciler manages it. Call when the mount target goes away while the host
 * remains (e.g. chrome unmount) so the slot subtree stays in the document
 * instead of leaving with the detached target.
 */
export function unmountSlotContainer(
  editor: LexicalEditor,
  nodeKey: NodeKey,
  container: HTMLElement,
): void {
  container.style.display = 'none';
  const hostDom = editor.getElementByKey(nodeKey);
  if (hostDom !== null && container.parentElement !== hostDom) {
    hostDom.insertBefore(container, hostDom.firstChild);
  }
}

/**
 * @experimental
 *
 * Type guard narrowing a {@link DOMSlot} to an {@link ElementDOMSlot}, which
 * exposes children-management methods like `insertChild` and the managed
 * line-break helpers.
 */
export function $isElementDOMSlot(
  slot: DOMSlot<HTMLElement>,
): slot is ElementDOMSlot<HTMLElement> {
  return slot instanceof ElementDOMSlot;
}

/**
 * @experimental
 *
 * Resolve the actual text DOM (`Text`) for a `TextNode` through the
 * configured `$getDOMSlot` hook. Unlike the plain {@link getDOMTextNode}
 * which descends the first child chain from a raw element, this routes
 * through the slot so an extension wrapping the text node's keyed DOM
 * (e.g. one that injects a `contentEditable=false` sibling before the
 * text) still points at the correct content element.
 */
export function $getDOMTextNode(
  node: TextNode,
  dom: HTMLElement,
  editor: LexicalEditor = $getEditor(),
): Text | null {
  const slot = $getDOMSlot(node, dom, editor);
  return getDOMTextNode(slot.element);
}

/** @internal */
export type TypeToNodeMap = Map<string, NodeMap>;
/**
 * @internal
 * Compute a cached Map of node type to nodes for a frozen EditorState
 */
const cachedNodeMaps = new WeakMap<EditorState, TypeToNodeMap>();
const EMPTY_TYPE_TO_NODE_MAP: TypeToNodeMap = new Map();
export function getCachedTypeToNodeMap(
  editorState: EditorState,
): TypeToNodeMap {
  // If this is a new Editor it may have a writable this._editorState
  // with only a 'root' entry.
  if (!editorState._readOnly && editorState.isEmpty()) {
    return EMPTY_TYPE_TO_NODE_MAP;
  }
  invariant(
    editorState._readOnly,
    'getCachedTypeToNodeMap called with a writable EditorState',
  );
  let typeToNodeMap = cachedNodeMaps.get(editorState);
  if (!typeToNodeMap) {
    typeToNodeMap = computeTypeToNodeMap(editorState);
    cachedNodeMaps.set(editorState, typeToNodeMap);
  }
  return typeToNodeMap;
}

/**
 * @internal
 * Compute a Map of node type to nodes for an EditorState
 */
function computeTypeToNodeMap(editorState: EditorState): TypeToNodeMap {
  const typeToNodeMap = new Map();
  for (const [nodeKey, node] of editorState._nodeMap) {
    const nodeType = node.__type;
    let nodeMap = typeToNodeMap.get(nodeType);
    if (!nodeMap) {
      nodeMap = new Map();
      typeToNodeMap.set(nodeType, nodeMap);
    }
    nodeMap.set(nodeKey, node);
  }
  return typeToNodeMap;
}

/**
 * Returns a clone of a node using `node.constructor.clone()` followed by
 * `clone.afterCloneFrom(node)`. The resulting clone must have the same key,
 * parent/next/prev pointers, and other properties that are not set by
 * `node.constructor.clone` (format, style, etc.). This is primarily used by
 * {@link LexicalNode.getWritable} to create a writable version of an
 * existing node. The clone is the same logical node as the original node,
 * do not try and use this function to duplicate or copy an existing node.
 *
 * Does not mutate the EditorState.
 * @param latestNode - The node to be cloned.
 * @returns The clone of the node.
 */
export function $cloneWithProperties<T extends LexicalNode>(latestNode: T): T {
  const constructor = latestNode.constructor;
  const mutableNode = (
    constructor.clone as (
      data: LexicalNode,
      internalSkipAfterCloneFrom?: typeof INTERNAL_SKIP_AFTER_CLONE_FROM,
    ) => T
  )(latestNode, INTERNAL_SKIP_AFTER_CLONE_FROM);
  mutableNode.afterCloneFrom(latestNode);
  if (__DEV__) {
    invariant(
      mutableNode.__key === latestNode.__key,
      "$cloneWithProperties: %s.clone(node) (with type '%s') did not return a node with the same key, make sure to specify node.__key as the last argument to the constructor",
      constructor.name,
      constructor.getType(),
    );
    invariant(
      mutableNode.__parent === latestNode.__parent &&
        mutableNode.__next === latestNode.__next &&
        mutableNode.__prev === latestNode.__prev,
      "$cloneWithProperties: %s.clone(node) (with type '%s') overrode afterCloneFrom but did not call super.afterCloneFrom(prevNode)",
      constructor.name,
      constructor.getType(),
    );
    if ($isSlotChild(mutableNode) && $isSlotChild(latestNode)) {
      invariant(
        mutableNode.__slotHost === latestNode.__slotHost,
        "$cloneWithProperties: %s.clone(node) (with type '%s') overrode afterCloneFrom but did not preserve __slotHost",
        constructor.name,
        constructor.getType(),
      );
    }
    if ($isSlotHost(mutableNode) && $isSlotHost(latestNode)) {
      const mutSlots = mutableNode.__slots;
      const latSlots = latestNode.__slots;
      const slotsMatch =
        mutSlots === latSlots ||
        (mutSlots !== null &&
          latSlots !== null &&
          mutSlots.size === latSlots.size &&
          Array.from(mutSlots).every(([k, v]) => latSlots.get(k) === v));
      invariant(
        slotsMatch,
        "$cloneWithProperties: %s.clone(node) (with type '%s') overrode afterCloneFrom but did not preserve __slots",
        constructor.name,
        constructor.getType(),
      );
    }
  }
  return mutableNode;
}

/**
 * Returns a clone with {@link $cloneWithProperties} and then "detaches"
 * it from the state by overriding its getLatest and getWritable to always
 * return this. This node can not be added to an EditorState or become the
 * parent, child, or sibling of another node. It is primarily only useful
 * for making in-place temporary modifications to a TextNode when
 * serializing a partial slice.
 *
 * Does not mutate the EditorState.
 * @param latestNode - The node to be cloned.
 * @returns The clone of the node.
 */
export function $cloneWithPropertiesEphemeral<T extends LexicalNode>(
  latestNode: T,
): T {
  return $markEphemeral($cloneWithProperties(latestNode));
}

/** Reads the indent level from a DOM element's `data-lexical-indent` attribute or `paddingInlineStart` style, and applies it to the given ElementNode. */
export function setNodeIndentFromDOM(
  elementDom: HTMLElement,
  elementNode: ElementNode,
) {
  // Prefer the authoritative attribute Lexical writes in exportDOM, since the
  // padding-inline-start fallback can't recover a custom
  // `--lexical-indent-base-value` or the reconciler's `calc(...)` form.
  const indentAttr = elementDom.getAttribute('data-lexical-indent');
  if (indentAttr !== null) {
    const parsed = parseInt(indentAttr, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      elementNode.setIndent(parsed);
      return;
    }
  }
  const indentSize = parseInt(elementDom.style.paddingInlineStart, 10) || 0;
  const indent = Math.round(indentSize / 40);
  elementNode.setIndent(indent);
}

/**
 * Reads the `dir` attribute from a DOM element and applies it to the given
 * ElementNode via {@link ElementNode.setDirection} when it is a valid direction
 * value (`'ltr'` or `'rtl'`). Other values, including missing or empty `dir`,
 * leave the node unchanged. Useful inside `importDOM` converters to preserve
 * explicit text direction from imported HTML.
 *
 * @param node - The ElementNode to update.
 * @param domNode - The source HTMLElement whose `dir` attribute is read.
 * @returns The node, with its direction set when the source `dir` was valid.
 */
export function $setDirectionFromDOM<T extends ElementNode>(
  node: T,
  domNode: HTMLElement,
): T {
  const dir = domNode.getAttribute('dir');
  return dir === 'ltr' || dir === 'rtl' ? node.setDirection(dir) : node;
}

/**
 * Reads the `style` and CSS `textAlign` property from a DOM element
 * and set format to the given ElementNode via {@link ElementNode.setFormat}
 * when it is a valid alignment value {@link ElementFormatType}
 * Other values, including missing or empty, leave the node unchanged.
 * Useful inside `importDOM` converters to preserve explicit alignment from imported HTML.
 *
 * @param node - The ElementNode to update.
 * @param domNode - The source HTMLElement whose `style` property is read.
 * @returns The node, with its align format set when the source `style.textAlign` was valid.
 */
export function $setFormatFromDOM<T extends ElementNode>(
  node: T,
  domNode: HTMLElement,
): T {
  const alignment = domNode.style.textAlign;
  return alignment && alignment in ELEMENT_TYPE_TO_FORMAT
    ? node.setFormat(alignment as ElementFormatType)
    : node;
}

/**
 * Options accepted by {@link setDOMUnmanaged}.
 *
 * @experimental
 */
export interface SetDOMUnmanagedOptions {
  /**
   * When true, the marked subtree owns its own window selection — analogous
   * to a DecoratorNode subtree. Selection resolution that would otherwise
   * mark the selection dirty for a caret position inside unmanaged DOM
   * leaves it alone, so the embedded interaction (custom input, focusable
   * widget, etc.) can keep its native caret.
   *
   * Pass `false` to clear a previously-set marker; omit the field to leave
   * `__lexicalCapturedSelection` untouched.
   */
  captureSelection?: boolean;
}

/**
 * Mark this DOM element as unmanaged by lexical's mutation observer (like
 * decorator nodes are). Extensions that inject non-lexical decoration
 * elements into a node's DOM should mark them so the mutation observer
 * doesn't evict them as "unknown DOM children" during cleanup.
 *
 * Pass `{captureSelection: true}` to additionally treat the subtree's
 * window selection as decorator-like, so resolution does not force-sync
 * the caret out of unmanaged DOM (see {@link isDOMCapturingSelection}).
 *
 * @experimental
 */
export function setDOMUnmanaged(
  elementDom: HTMLElement & LexicalPrivateDOM,
  options?: SetDOMUnmanagedOptions,
): void {
  elementDom.__lexicalUnmanaged = true;
  if (options && options.captureSelection !== undefined) {
    elementDom.__lexicalCapturedSelection = options.captureSelection;
  }
}

/**
 * True if this DOM node was marked with {@link setDOMUnmanaged}.
 *
 * @experimental
 */
export function isDOMUnmanaged(elementDom: Node & LexicalPrivateDOM): boolean {
  return elementDom.__lexicalUnmanaged === true;
}

/**
 * Mark a DOM element as a named-slot editable island: set its `contentEditable`
 * to follow the editor's editable state. A slot rendered inside a non-editable
 * host (a decorator, or a `contentEditable=false` element shell) does not track
 * the editor on its own, so its container carries an explicit `contentEditable`;
 * {@link $fullReconcile} re-applies this when {@link LexicalEditor.setEditable}
 * toggles. Call it for any other editable island an app attaches itself (e.g. a
 * `getDOMSlot` children element rendered inside a `contentEditable=false` shell).
 *
 * @experimental
 */
export function $markSlotEditable(
  element: HTMLElement & {__lexicalEditor?: undefined | LexicalEditor},
  editor: LexicalEditor = $getEditor(),
): void {
  const editable = editor.isEditable();
  element.contentEditable = editable ? 'true' : 'false';
  if (editable) {
    element.__lexicalEditor = editor;
  } else {
    delete element.__lexicalEditor;
  }
}

/**
 * True if the DOM node sits inside a subtree marked with
 * `{captureSelection: true}` via {@link setDOMUnmanaged}. Walks ancestors
 * so any descendant of a marked subtree (e.g. an `<input>` inside a marked
 * `<div>`) reports as captured too.
 *
 * The walk aborts at the first DOM node that corresponds to a Lexical
 * node in `editor` — that boundary is the implicit owner of the subtree's
 * selection, so a captureSelection marker above it (in non-Lexical
 * scaffolding around the editor) does not leak in.
 *
 * DecoratorNode DOM is marked with `setDOMUnmanaged({captureSelection:
 * true})` by the reconciler, so decorator subtrees also report as
 * captured here.
 *
 * @experimental
 */
export function isDOMCapturingSelection(
  elementDom: Node & LexicalPrivateDOM,
  editor: LexicalEditor,
): boolean {
  let dom: (Node & LexicalPrivateDOM) | null = elementDom;
  while (dom != null) {
    if (dom.__lexicalCapturedSelection === true) {
      return true;
    }
    // @experimental named-slots. A decorator host's slot container is a
    // key-less scaffolding wrapper made contentEditable so its Lexical-managed
    // content stays editable. Walking up from inside a slot would otherwise
    // reach the decorator host's captured-selection flag and misread the slot
    // as foreign-captured DOM, suppressing Lexical's input / selection
    // handling. The container is a capturing boundary: stop here.
    if (isHTMLElement(dom) && dom.hasAttribute('data-lexical-slot')) {
      return false;
    }
    if (getNodeKeyFromDOMNode(dom, editor) !== undefined) {
      return false;
    }
    dom = getParentElement(dom);
  }
  return false;
}

/**
 * @internal
 *
 * Object.hasOwn ponyfill
 */
function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * @internal
 */
export function hasOwnStaticMethod(
  klass: Klass<LexicalNode>,
  k: keyof Klass<LexicalNode>,
): boolean {
  return hasOwn(klass, k) && klass[k] !== LexicalNode[k];
}

/** @internal */
function isAbstractNodeClass(klass: Klass<LexicalNode>): boolean {
  if (!(klass === LexicalNode || klass.prototype instanceof LexicalNode)) {
    let ownNodeType = '<unknown>';
    let version = '<unknown>';
    try {
      ownNodeType = klass.getType();
    } catch (_err) {
      // ignore
    }
    try {
      if (LexicalEditor.version) {
        version = JSON.parse(LexicalEditor.version);
      }
    } catch (_err) {
      // ignore
    }
    invariant(
      false,
      '%s (type %s) does not subclass LexicalNode from the lexical package used by this editor (version %s). All lexical and @lexical/* packages used by an editor must have identical versions. If you suspect the version does match, then the problem may be caused by multiple copies of the same lexical module (e.g. both esm and cjs, or included directly in multiple entrypoints).',
      klass.name,
      ownNodeType,
      version,
    );
  }
  return (
    klass === DecoratorNode || klass === ElementNode || klass === LexicalNode
  );
}

export interface OwnStaticNodeConfig {
  klass: Klass<LexicalNode>;
  ownNodeType: undefined | string;
  ownNodeConfig:
    | undefined
    | StaticNodeConfigValue<LexicalNode, string | symbol>;
}
const STATIC_NODE_CONFIG_CACHE = new WeakMap<
  Klass<LexicalNode>,
  OwnStaticNodeConfig
>();
// Brands a getType() closure that Lexical synthesized (as opposed to a
// user-defined static getType()). getStaticNodeConfig uses this to avoid
// re-entering a synthesized closure while deriving a node's type, which would
// otherwise recurse infinitely for subclasses under compiled class output.
const SYNTHESIZED_GET_TYPE: unique symbol = Symbol(
  'lexical.synthesizedGetType',
);

// TextNode.length > 0 will only be true if the compiler output
// is not ES6 compliant, in which case we can not provide this
// warning. We also can't reliably provide this warning if the output
// has been optimized because `arg=undefined` parameter defaults can
// be stripped.
const IS_UNOPTIMIZED_DEV_BUILD =
  __DEV__ &&
  // constructor(key=undefined)
  TabNode.length === 0 &&
  // constructor(text='', key?: NodeKey)
  TextNode.length === 0 &&
  // Class name mangling is another signal that this may be unreliable
  TextNode.name === 'TextNode';

/** @internal */
export function getStaticNodeConfig(
  klass: Klass<LexicalNode>,
): OwnStaticNodeConfig {
  const cache = STATIC_NODE_CONFIG_CACHE.get(klass);
  if (cache) {
    return cache;
  }
  const nodeConfigRecord =
    klass.prototype != null && PROTOTYPE_CONFIG_METHOD in klass.prototype
      ? klass.prototype[PROTOTYPE_CONFIG_METHOD]()
      : undefined;
  const isAbstract = isAbstractNodeClass(klass);
  // Only trust a *user-defined* own static getType() to derive the node type.
  // A getType() that we synthesized (branded with SYNTHESIZED_GET_TYPE) must
  // not be called here: the synthesized closure defers to
  // LexicalNode.getType.call(this) for a foreign `this`, which re-enters
  // getStaticNodeConfig and — when the closure is inherited/own-copied onto a
  // subclass by the compiled class output — causes infinite recursion
  // (RangeError: Maximum call stack size exceeded). For such a class the type
  // is derived from the $config record below instead. (#8867 follow-up.)
  const ownGetType =
    !isAbstract && hasOwnStaticMethod(klass, 'getType')
      ? klass.getType
      : undefined;
  const nodeType =
    ownGetType && !(SYNTHESIZED_GET_TYPE in ownGetType)
      ? ownGetType.call(klass)
      : undefined;
  let ownNodeConfig:
    | undefined
    | StaticNodeConfigValue<LexicalNode, string | symbol>;
  let ownNodeType = nodeType;
  if (nodeConfigRecord) {
    if (nodeType) {
      ownNodeConfig = nodeConfigRecord[nodeType];
    } else {
      // No static getType(): derive the type and config from the $config
      // record. The common case is a concrete node keyed by its string `type`.
      for (const [k, v] of Object.entries(nodeConfigRecord)) {
        ownNodeType = k;
        ownNodeConfig = v;
      }
      // Fall back to a well-known symbol key (e.g. Symbol.for('ElementNode'))
      // for an abstract base class that has no concrete node type, using the
      // first symbol whose value is a config record.
      if (!ownNodeConfig) {
        for (const symbolKey of Object.getOwnPropertySymbols(
          nodeConfigRecord,
        )) {
          const symbolConfig = nodeConfigRecord[symbolKey];
          if (symbolConfig) {
            ownNodeConfig = symbolConfig;
            break;
          }
        }
      }
    }
  }
  if (!isAbstract && ownNodeType) {
    if (!hasOwnStaticMethod(klass, 'getType')) {
      // Guard against subclass inheritance: a subclass that does not define its
      // own static getType() (nor its own $config()-derived type yet) would
      // otherwise *inherit* this synthesized closure via the prototype chain and
      // return the superclass's hardcoded `ownNodeType`. When that happens the
      // subclass registers under the superclass's type, colliding with it
      // (e.g. `CodeHighlightNode`/`HashtagNode` resolving to type 'text' and
      // clashing with `TextNode`). Only return the captured type when invoked on
      // the exact class it was synthesized for; otherwise defer to the base
      // LexicalNode.getType(), which resolves the correct type for `this`.
      const synthesizedForKlass = klass;
      const synthesizedGetType = function (this: Klass<LexicalNode>): string {
        if (this !== synthesizedForKlass) {
          return LexicalNode.getType.call(this);
        }
        return ownNodeType;
      };
      // Brand the closure so getStaticNodeConfig can recognize it and avoid
      // calling it to derive the node type (which would recurse). See the note
      // at the `ownGetType` computation above.
      (synthesizedGetType as {[SYNTHESIZED_GET_TYPE]?: true})[
        SYNTHESIZED_GET_TYPE
      ] = true;
      klass.getType = synthesizedGetType;
    }
    if (!hasOwnStaticMethod(klass, 'clone')) {
      // TextNode.length > 0 will only be true if the compiler output
      // is not ES6 compliant, in which case we can not provide this
      // warning. We also can't reliably provide this warning if the output
      // has been optimized.
      if (__DEV__ && IS_UNOPTIMIZED_DEV_BUILD) {
        invariant(
          klass.length === 0,
          '%s (type %s) must implement a static clone method since its constructor has %s required arguments (expecting 0). Use an explicit default in the first argument of your constructor(prop: T=X, nodeKey?: NodeKey).',
          klass.name,
          ownNodeType,
          String(klass.length),
        );
      }
      klass.clone = (
        prevNode: LexicalNode,
        internalSkipAfterCloneFrom?: typeof INTERNAL_SKIP_AFTER_CLONE_FROM,
      ) => {
        setPendingNodeToClone(prevNode);
        const node = new klass();
        // The internal clone wrappers ($cloneWithProperties / $copyNode) pass
        // the module-private INTERNAL_SKIP_AFTER_CLONE_FROM sentinel because
        // they call afterCloneFrom themselves. When this synthesized clone is
        // instead called directly — e.g. `NodeClass.clone(node)`, an idiomatic
        // pre-$config() pattern — the sentinel is absent, so we call
        // afterCloneFrom here to preserve the documented clone() contract and
        // avoid silent property loss. afterCloneFrom is not guaranteed
        // idempotent, so this must run exactly once (see the sentinel
        // definition for the full rationale).
        if (internalSkipAfterCloneFrom !== INTERNAL_SKIP_AFTER_CLONE_FROM) {
          node.afterCloneFrom(prevNode);
        }
        return node;
      };
    }
    if (!hasOwnStaticMethod(klass, 'importJSON')) {
      if (__DEV__ && IS_UNOPTIMIZED_DEV_BUILD) {
        invariant(
          klass.length === 0,
          '%s (type %s) must implement a static importJSON method since its constructor has %s required arguments (expecting 0). Use an explicit default in the first argument of your constructor(prop: T=X, nodeKey?: NodeKey).',
          klass.name,
          ownNodeType,
          String(klass.length),
        );
      }
      // TODO: replace $applyNodeReplacement with $create once `withKlass` is required.
      klass.importJSON =
        (ownNodeConfig && ownNodeConfig.$importJSON) ||
        (serializedNode =>
          $applyNodeReplacement(new klass()).updateFromJSON(serializedNode));
    }
    if (!hasOwnStaticMethod(klass, 'importDOM') && ownNodeConfig) {
      const {importDOM} = ownNodeConfig;
      if (importDOM) {
        klass.importDOM = () => importDOM;
      }
    }
  }
  const result = {klass, ownNodeConfig, ownNodeType};
  STATIC_NODE_CONFIG_CACHE.set(klass, result);
  return result;
}

/**
 * Collect all configuration for this class and its superclasses
 *
 * @internal
 */
export function* iterStaticNodeConfigChain(
  klass: Klass<LexicalNode>,
): Iterable<OwnStaticNodeConfig> {
  for (
    let current: null | Klass<LexicalNode> = klass;
    current && (current === LexicalNode || $isLexicalNode(current.prototype));
  ) {
    const config = getStaticNodeConfig(current);
    yield config;
    current =
      (config.ownNodeConfig && config.ownNodeConfig.extends) ||
      getSuperclassOf(current);
  }
}

/**
 * Build a map from each registered node type to the set of registered node
 * types that are it or extend it (including the type itself). For every node
 * class in `nodes`, its prototype chain is walked and the class's own type is
 * added to the bucket of each registered ancestor type it inherits from.
 *
 * The result lets callers expand a base node type to all of its registered
 * subclass types up front, so a subclass instance can be matched by type
 * without a runtime `instanceof`.
 *
 * @experimental
 */
export function getRegisteredSubtypeMap(
  nodes: Iterable<Klass<LexicalNode>>,
): Map<string, Set<string>> {
  const subtypes = new Map<string, Set<string>>();
  const klassByType = new Map<string, Klass<LexicalNode>>();
  for (const klass of nodes) {
    const {ownNodeType} = getStaticNodeConfig(klass);
    if (ownNodeType) {
      klassByType.set(ownNodeType, klass);
      subtypes.set(ownNodeType, new Set());
    }
  }
  for (const [type, klass] of klassByType) {
    for (const {ownNodeType} of iterStaticNodeConfigChain(klass)) {
      const bucket = ownNodeType && subtypes.get(ownNodeType);
      if (bucket) {
        bucket.add(type);
      }
    }
  }
  return subtypes;
}

/**
 * Create an node from its class.
 *
 * Note that this will directly construct the final `withKlass` node type,
 * and will ignore the deprecated `with` functions. This allows `$create` to
 * skip any intermediate steps where the replaced node would be created and
 * then immediately discarded (once per configured replacement of that node).
 *
 * This does not support any arguments to the constructor.
 * Setters can be used to initialize your node, and they can
 * be chained. You can of course write your own mutliple-argument functions
 * to wrap that.
 *
 * @example
 * ```ts
 * function $createTokenText(text: string): TextNode {
 *   return $create(TextNode).setTextContent(text).setMode('token');
 * }
 * ```
 */
export function $create<T extends LexicalNode>(klass: Klass<T>): T {
  const editor = $getEditor();
  errorOnReadOnly();
  const registeredNode = editor.resolveRegisteredNodeAfterReplacements(
    editor.getRegisteredNode(klass),
  );
  return new registeredNode.klass() as T;
}

/**
 * Starts with a node and moves up the tree (toward the root node) to find a matching node based on
 * the search parameters of the findFn. (Consider JavaScripts' .find() function where a testing function must be
 * passed as an argument. eg. if( (node) => node.__type === 'div') ) return true; otherwise return false
 * @param startingNode - The node where the search starts.
 * @param findFn - A testing function that returns true if the current node satisfies the testing parameters.
 * @returns `startingNode` or one of its ancestors that matches the `findFn` predicate and is not the `RootNode`, or `null` if no match was found.
 */
export const $findMatchingParent: {
  <T extends LexicalNode>(
    startingNode: LexicalNode,
    findFn: (node: LexicalNode) => node is T,
  ): T | null;
  (
    startingNode: LexicalNode,
    findFn: (node: LexicalNode) => boolean,
  ): LexicalNode | null;
} = (
  startingNode: LexicalNode,
  findFn: (node: LexicalNode) => boolean,
): LexicalNode | null => {
  let curr: ElementNode | LexicalNode | null = startingNode;

  while (curr != null && !$isRootNode(curr)) {
    if (findFn(curr)) {
      return curr;
    }

    curr = curr.getParent();
  }

  return null;
};

/** Builds an ordered array of child node keys for the given ElementNode by walking its linked-list pointers. */
export function $createChildrenArray(
  element: ElementNode,
  nodeMap: null | NodeMap,
): NodeKey[] {
  const children = [];
  let nodeKey = element.__first;
  while (nodeKey !== null) {
    const node =
      nodeMap === null ? $getNodeByKey(nodeKey) : nodeMap.get(nodeKey);
    if (node === null || node === undefined) {
      invariant(false, '$createChildrenArray: node does not exist in nodeMap');
    }
    children.push(nodeKey);
    nodeKey = node.__next;
  }
  return children;
}

/**
 * Look up the superclass of this class, prefer
 * {@link iterStaticNodeConfigChain} when implementing loops.
 *
 * @internal
 */
export function getSuperclassOf(
  klass: Klass<LexicalNode>,
): null | Klass<LexicalNode> {
  const viaStatic = Object.getPrototypeOf(klass);
  if (typeof viaStatic === 'function' && viaStatic !== Function.prototype) {
    return viaStatic; // healthy static chain
  }
  // static link severed by the loose transform — use the instance chain
  const parentProto = klass.prototype && Object.getPrototypeOf(klass.prototype);
  return parentProto ? parentProto.constructor : null;
}
