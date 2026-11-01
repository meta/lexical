/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {EditorState} from './LexicalEditorState';
import type {GeneratedJSON, GeneratedJSONFactory} from './LexicalGeneratedJSON';
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
  CONTROL_OR_META,
  DecoratorNode,
  DEFAULT_EDITOR_DOM_CONFIG,
  type ElementFormatType,
  ElementNode,
  HISTORY_MERGE_TAG,
  type LineBreakNode,
  normalizeClassNames,
  type UpdateTag,
} from '.';
import {$detachNode} from './caret/LexicalCaretTree';
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
  CONTROL_OR_OTHER_KEY,
  DOM_DOCUMENT_FRAGMENT_TYPE,
  DOM_DOCUMENT_TYPE,
  DOM_ELEMENT_TYPE,
  DOM_TEXT_TYPE,
  ELEMENT_TYPE_TO_FORMAT,
  HAS_DIRTY_NODES,
  LTR_REGEX,
  NO_DIRTY_NODES,
  NODE_STATE_KEY,
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
  type LexicalParseJSON,
  type LexicalPrivateDOM,
  type NodeKey,
  type NodeMap,
  type SerializedLexicalNode,
  type SerializedPartial,
  type StaticNodeConfigValue,
} from './LexicalNode';
import {
  $setState,
  $updateStateFromJSON,
  type AnyStateConfig,
} from './LexicalNodeState';
import {$normalizeSelection} from './LexicalNormalization';
import {
  type AnySerializationSchema,
  type ComposedSchemaFields,
  hasOwnKey,
  isSchemaField,
  type SchemaFieldBase,
  type SchemaGetterField,
  type SchemaSetterField,
} from './LexicalSchema';
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
import {
  $createParagraphNode,
  type ParagraphNode,
} from './nodes/LexicalParagraphNode';
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
// auto-synthesized clone (see injectSynthesizedStatics) by the internal clone
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
/**
 * Returns true if an event comes from an input embedded in a node's DOM, read
 * from its composed target: an `<input>`, a `<textarea>` or a foreign
 * contentEditable (see {@link $isSelectionCapturedInDecoratorInput}). That is
 * a decorator's own input, or one in unmanaged DOM that any node renders
 * beside its children or text, through `createDOM`, a DOM slot or a render
 * override. The editor's selection is then still the one it had before the
 * input took the focus, so a copy, cut or paste there belongs to the input: a
 * `COPY_COMMAND`, `CUT_COMMAND` or `PASTE_COMMAND` handler that acts on the
 * editor's selection should return false for it.
 */
export function $isEventFromEmbeddedInput(event: Event | null): boolean {
  const target = event === null ? null : getComposedEventTarget(event);
  return isDOMNode(target) && $isSelectionCapturedInDecoratorInput(target);
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
  editor._cloneNotNeeded.set(key, node);
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
 * @internal
 *
 * Latch the "this document uses slots" flag. The editor keeps it for its
 * lifetime, and the EditorState currently being built carries it so that a
 * state handed to another editor via `setEditorState` brings the flag with it.
 *
 * The state marked here is the *active* one. Inside `editor.update()` that is
 * `editor._pendingEditorState`, but `parseEditorState` builds a detached
 * EditorState and leaves `_pendingEditorState` untouched, so keying off
 * pending would miss the parsed state entirely (and could stamp the flag onto
 * an unrelated pending state).
 */
export function $markSlotsUsed(): void {
  getActiveEditor()._slotsUsed = true;
  getActiveEditorState()._slotsUsed = true;
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
  $detachNode(node.getParent() === null ? node : node.getWritable());
}
/** @deprecated renamed to {@link $removeFromParent} by @lexical/eslint-plugin rules-of-lexical */
export const removeFromParent = $removeFromParent;

// Never use this function directly! It will break
// the cloning heuristic. Instead use node.getWritable().
// The caller must pass the latest node from the active editor state.
export function internalMarkNodeAsDirty(node: LexicalNode): void {
  errorOnInfiniteTransforms();
  invariant(
    !$isEphemeral(node),
    'internalMarkNodeAsDirty: Ephemeral nodes must not be marked as dirty (key %s type %s)',
    node.__key,
    node.__type,
  );
  // @experimental named-slots. A slotted node's up-pointer is __slotHost,
  // not __parent; start the dirty walk from whichever is set so a slot
  // content edit propagates into the host. Non-slot trees keep
  // __slotHost === null, so this is the plain __parent start there.
  const parent =
    node.__parent !== null
      ? node.__parent
      : $isSlotChild(node)
        ? node.__slotHost
        : null;
  const editorState = getActiveEditorState();
  const editor = getActiveEditor();
  const nodeMap = editorState._nodeMap;
  const dirtyElements = editor._dirtyElements;
  if (parent !== null) {
    internalMarkParentElementsAsDirty(parent, nodeMap, dirtyElements);
  }
  const key = node.__key;
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
    editor._compositionMergeHeld = null;
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

/** Desktop WebKit renders a suffix so an empty composing node can host the IME. */
export function $isEmptyCompositionTarget(node: TextNode): boolean {
  return (
    !IS_IOS &&
    (IS_SAFARI || IS_APPLE_WEBKIT) &&
    node.__text === '' &&
    // DOM selection reconciliation runs after the state becomes read-only.
    node.__key === getActiveEditor()._compositionKey
  );
}

/**
 * Returns the node with the given key from the active EditorState
 * (or the given EditorState), or null if it does not exist.
 */
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

/**
 * Restores the empty paragraph a root or shadow root needs to stay editable,
 * when a removal has left `container` with no children at all. Removing the
 * last node it held (a lone table or block decorator sitting beside a block
 * cursor, or a select-all over a document that is a single shadow root)
 * otherwise leaves nowhere to put a caret, and the next keystroke acts on the
 * container itself rather than on a block inside it.
 *
 * A ParagraphNode is only a valid child of a container that holds blocks. The
 * RootNode always does, but a shadow root may be structural instead — a
 * TableNode holds rows, a TableRowNode holds cells — so for anything but the
 * root, `removedChild` (a child the caller is removing, or has just removed,
 * from `container`) decides: a paragraph belongs where a block did.
 *
 * Call this only where a removal could have emptied `container`. It is a no-op
 * on a container that is already populated, but on one that was *already*
 * empty beforehand it would seed a paragraph nobody asked for.
 *
 * @returns the paragraph that was appended, or null when nothing was restored.
 * @internal
 */
export function $restoreEmptyContainerParagraph(
  container: null | LexicalNode,
  removedChild: null | LexicalNode,
): null | ParagraphNode {
  if (
    !$isRootOrShadowRoot(container) ||
    !container.isAttached() ||
    // Root slots (such as footnotes) do not replace the editable body.
    ($isRootNode(container)
      ? container.getChildrenSize() !== 0
      : !container.isEmpty()) ||
    !(
      $isRootNode(container) ||
      (removedChild !== null && INTERNAL_$isBlock(removedChild))
    )
  ) {
    return null;
  }
  const paragraph = $createParagraphNode();
  container.append(paragraph);
  return paragraph;
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

/**
 * @param rerenderText Render the text that the browser changed from the
 * editor state, as the editor applied the input that changed it itself.
 */
export function $flushMutations(rerenderText?: boolean): void {
  errorOnReadOnly();
  const editor = getActiveEditor();
  flushRootMutations(editor, rerenderText);
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

let serverUIDCounter = 0;

/**
 * Generates the identifiers `createEditor` uses for an editor's key and its
 * default namespace.
 *
 * In a browser they are random, because both are compared across windows: a
 * drag marker carries the source editor's key, and a clipboard payload carries
 * its namespace. Without a DOM (server rendering) a counter is used instead,
 * which is unique within the process: neither value is serialized into
 * rendered markup, and frameworks such as Next.js fail a prerender that reads
 * `Math.random()` (#9318).
 */
export function createUID(): string {
  if (!CAN_USE_DOM) {
    return `s${(++serverUIDCounter).toString(36)}`;
  }
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
    const isSafariComposition = !IS_IOS && (IS_SAFARI || IS_APPLE_WEBKIT);

    if (node.isToken() && isComposing) {
      return;
    }

    let normalizedTextContent = textContent;

    if (isComposing || compositionEnd) {
      if (
        textContent.endsWith(COMPOSITION_SUFFIX) &&
        (!isSafariComposition || textContent !== node.getTextContent())
      ) {
        normalizedTextContent = textContent.slice(
          0,
          -COMPOSITION_SUFFIX.length,
        );
      }
      if (compositionEnd && !isSafariComposition) {
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
        if (isComposing && !compositionEnd && isSafariComposition) {
          // The composition key owns this target until composition ends.
          $setTextContentWithSelection(node, '', selection);
          return;
        }
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
  [K in Exclude<keyof KeyboardEventModifiers, 'key' | 'code'>]?:
    | boolean
    | undefined
    | 'any';
};

export {CONTROL_OR_OTHER_KEY};

/** @internal */
export interface KeyboardEventControlOrOther {
  [CONTROL_OR_OTHER_KEY]?: 'metaKey' | 'altKey';
}

/** @internal */
export function keyboardEventMaskForPlatform(
  mask: KeyboardEventModifierMask & KeyboardEventControlOrOther,
  isApple: boolean,
): KeyboardEventModifierMask {
  const otherKey = mask[CONTROL_OR_OTHER_KEY];
  return otherKey && isApple !== IS_APPLE
    ? {...mask, ctrlKey: mask[otherKey], [otherKey]: mask.ctrlKey}
    : mask;
}

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

export function isModifier(event: KeyboardEventModifiers): boolean {
  return event.ctrlKey || event.shiftKey || event.altKey || event.metaKey;
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

/**
 * `$selectAll` places its points at the element level and then normalizes them
 * down towards text points. When every point descends into the *same* shadow
 * root — a document whose only top-level node is a columns layout, say — the
 * result stops describing "select everything" and starts describing "select the
 * text inside the widget". A delete then empties the widget in place instead of
 * removing it (#6938), because the range never covers the widget itself.
 *
 * Keeping the element-level points in that case leaves the shadow root inside
 * the selection. A selection that merely *starts* in a shadow root, such as a
 * select-all anchored in a leading table, still normalizes as before: it already
 * extends past the shadow root, so the widget is covered either way.
 */
function $getRootChildAncestor(node: LexicalNode): LexicalNode | null {
  let current: LexicalNode | null = node;
  while (current !== null) {
    const parent: ElementNode | null = current.getParent();
    if (parent === null) {
      // A detached node, or a slot value whose up-link is its slot host.
      return null;
    }
    if ($isRootNode(parent)) {
      return current;
    }
    current = parent;
  }
  return null;
}

function $normalizeSelectionForSelectAll(
  selection: RangeSelection,
  container: ElementNode,
): RangeSelection {
  const {anchor, focus} = selection;
  const anchorKey = anchor.key;
  const anchorOffset = anchor.offset;
  const anchorType = anchor.type;
  const focusKey = focus.key;
  const focusOffset = focus.offset;
  const focusType = focus.type;
  $normalizeSelection(selection);
  // Only a select-all that spans the whole document keeps its element-level
  // points. A select-all scoped to a container *inside* a shadow root (a
  // table cell, a layout column) already describes "everything in here", and
  // element points there would leave the container's own children — a row's
  // cells, a table's rows — inside the range, so the next select-all widens
  // to the container's parent and a delete removes structural nodes rather
  // than their text.
  if (!$isRootNode(container)) {
    return selection;
  }
  // `getTopLevelElement` stops at the nearest shadow root, which for a nested
  // widget is one of its inner scopes (a layout item rather than the layout
  // container), so walk all the way out to the child of the RootNode instead.
  const anchorTop = $getRootChildAncestor(anchor.getNode());
  if (
    $isElementNode(anchorTop) &&
    anchorTop.isShadowRoot() &&
    anchorTop.is($getRootChildAncestor(focus.getNode()))
  ) {
    anchor.set(anchorKey, anchorOffset, anchorType);
    focus.set(focusKey, focusOffset, focusType);
  }
  return selection;
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
      $normalizeSelectionForSelectAll(selection, anchorNode);
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
        $normalizeSelectionForSelectAll(selection, topParent);
      }
      return selection;
    }
    // `parent` is the RootNode for a top-level `topParent`, and the enclosing
    // shadow root (a table cell, a layout column) when the caret is inside
    // one — which is why $normalizeSelectionForSelectAll is told which.
    anchor.set(parent.getKey(), 0, 'element');
    focus.set(parent.getKey(), parent.getChildrenSize(), 'element');
    $normalizeSelectionForSelectAll(selection, parent);
    return selection;
  } else {
    // Create a new RangeSelection
    const newSelection = root.select(0, root.getChildrenSize());
    $setSelection($normalizeSelectionForSelectAll(newSelection, root));
    return newSelection;
  }
}

/**
 * Removes `class` or `style` from the element when the attribute is present
 * but has an empty value.
 *
 * `classList.remove(...)` and `style.setProperty(prop, '')` do not remove the
 * attribute once every token/declaration is gone, so clearing the last theme
 * class or the last inline declaration leaves `class=""` / `style=""` behind
 * in the editor DOM.
 */
export function removeEmptyDOMAttribute(
  dom: HTMLElement,
  attributeName: 'class' | 'style',
): void {
  if (dom.getAttribute(attributeName) === '') {
    dom.removeAttribute(attributeName);
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

/**
 * Computed scroll-padding keeps percentages, which resolve against the
 * scrollport width. 'auto' parses as NaN and counts as 0.
 */
function parseScrollPadding(value: string, clientWidth: number): number {
  const length = parseFloat(value);
  if (!isFinite(length)) {
    return 0;
  }
  return value.endsWith('%') ? (length * clientWidth) / 100 : length;
}

/**
 * When `element` is a horizontal scroll container (overflow-x auto or
 * scroll) with something to scroll, scrolls it sideways so the caret rect
 * [left, right] is inside its scrollport, less its scroll-padding. Returns
 * how far it actually scrolled, in viewport px.
 *
 * The caret may also be above or below the element, like a caret below the
 * visible part of a root with overflow: auto. It is still revealed sideways
 * here. Scrolling sideways doesn't move it up or down, and scrolling up or
 * down doesn't move it sideways, so the vertical pass that runs after this
 * one reveals it vertically and leaves this reveal alone.
 */
function scrollIntoViewHorizontally(
  view: Window,
  element: HTMLElement,
  left: number,
  right: number,
): number {
  // Cheap check first. Layout is already clean because the caret rect was
  // just measured.
  const clientWidth = element.clientWidth;
  const maxScroll = element.scrollWidth - clientWidth;
  if (maxScroll <= 0) {
    return 0;
  }
  // Only overflow-x auto or scroll counts, the same test as the table's sticky
  // scrollbar. Hidden and clip are left alone, like a table wrapper with a
  // frozen row.
  const style = view.getComputedStyle(element);
  if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') {
    return 0;
  }
  const rect = element.getBoundingClientRect();
  // The rects are in viewport px, but clientLeft, clientWidth, scroll-padding
  // and scrollLeft are in the element's own px. They differ under CSS zoom or
  // a transform: scale. offsetWidth is rounded, so a difference of 1px or less
  // is not a scale.
  const offsetWidth = element.offsetWidth;
  const scale =
    offsetWidth > 0 && Math.abs(rect.width - offsetWidth) > 1
      ? rect.width / offsetWidth
      : 1;
  const isRTL = style.direction === 'rtl';
  // Scrollport, not border box: clientLeft covers the border and a left
  // scrollbar.
  const scrollportLeft = rect.left + element.clientLeft * scale;
  const viewLeft =
    scrollportLeft +
    parseScrollPadding(style.scrollPaddingLeft, clientWidth) * scale;
  const viewRight =
    scrollportLeft +
    (clientWidth - parseScrollPadding(style.scrollPaddingRight, clientWidth)) *
      scale;
  // A collapsed caret rect has no width, but the caret is painted about 1px
  // wide. Without this, End can stop with the caret clipped at the edge.
  let caretLeft = left;
  let caretRight = Math.max(right, left + 1);
  if (caretRight - caretLeft > viewRight - viewLeft) {
    // Wider than the view: an element point measured on the whole node
    // after it, like a long token. The caret is at its inline start.
    if (isRTL) {
      caretLeft = caretRight - 1;
    } else {
      caretRight = caretLeft + 1;
    }
  }
  let diff = 0;
  if (caretLeft < viewLeft) {
    diff = caretLeft - viewLeft;
  } else if (caretRight > viewRight) {
    diff = caretRight - viewRight;
  }
  if (diff === 0) {
    return 0;
  }
  const scrollLeft = element.scrollLeft;
  // Browsers round the scroll position they are given, which can leave the
  // caret a fraction of a pixel outside the view. So round it the way the
  // element scrolls, which takes the caret a little further in instead.
  const unrounded = scrollLeft + diff / scale;
  const targetScrollLeft =
    diff > 0 ? Math.ceil(unrounded) : Math.floor(unrounded);
  // Standard scrollLeft is 0 at the inline start and negative in RTL.
  let nextScrollLeft = isRTL
    ? Math.min(0, Math.max(-maxScroll, targetScrollLeft))
    : Math.max(0, Math.min(maxScroll, targetScrollLeft));
  // When scrolling back toward the start, and the caret would also fit with
  // the element scrolled all the way back, go all the way back. The caret's
  // position at scrollLeft 0 is its position now plus scrollLeft, in viewport
  // px, in both directions. This shows the whole start of the line,
  // including the indentation that smart Home and Enter leave the caret
  // after, whatever the width of the theme's gutter.
  const startOffset = scrollLeft * scale;
  if (
    Math.abs(nextScrollLeft) < Math.abs(scrollLeft) &&
    caretLeft + startOffset >= viewLeft &&
    caretRight + startOffset <= viewRight
  ) {
    nextScrollLeft = 0;
  }
  if (nextScrollLeft === scrollLeft) {
    return 0;
  }
  element.scrollLeft = nextScrollLeft;
  // Read back, like scrollTop below. An element that doesn't really scroll
  // (a <table>) reports 0, so outer scrollers stay correct.
  return (element.scrollLeft - scrollLeft) * scale;
}

/**
 * The rect to scroll into view for a caret, which is a collapsed range.
 * WebKit gives a collapsed range at the logical end of right to left text no
 * rect at all. Then this measures the character next to the caret instead,
 * and the caret is at one of its edges.
 */
export function getCaretRect(range: Range): DOMRect {
  const rect = range.getBoundingClientRect();
  const {startContainer, startOffset} = range;
  if (
    !range.collapsed ||
    rect.width !== 0 ||
    rect.height !== 0 ||
    !isDOMTextNode(startContainer) ||
    startContainer.length === 0
  ) {
    return rect;
  }
  const characterRange = range.cloneRange();
  if (startOffset > 0) {
    characterRange.setStart(startContainer, startOffset - 1);
  } else {
    characterRange.setEnd(startContainer, 1);
  }
  return characterRange.getBoundingClientRect();
}

/**
 * Scrolls the caret into view. First it scrolls sideways, in the horizontal
 * scroll containers from the caret up to and including the editor root (for
 * example a code block with a long line, or a table's scroll wrapper). Then
 * it scrolls vertically, in the root and its ancestors up to the window.
 *
 * @param selectionNode The caret's DOM node: the anchor's Text node, or its
 * $getDOMSlot element for an element point. The horizontal pass starts
 * there. Without it only the vertical pass runs.
 */
export function scrollIntoViewIfNeeded(
  editor: LexicalEditor,
  selectionRect: DOMRect,
  rootElement: HTMLElement,
  selectionNode: Node | null = null,
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
  // Horizontal scroll containers inside the editor, like a code block with a
  // long line, and the root itself are scrolled sideways to reveal the caret.
  // The page and the editor's ancestors are never scrolled horizontally. The
  // vertical walk below still starts at the root, because scrolling every
  // element on the way up would also move overflow: hidden elements inside
  // the editor.
  if (selectionNode !== null && selectionRect.height > 0) {
    let {left: currentLeft, right: currentRight} = selectionRect;
    let scroller: HTMLElement | null = isHTMLElement(selectionNode)
      ? selectionNode
      : getParentElement(selectionNode);
    // contains() also stops a walk that getParentElement took out of the
    // editor through a slot assignment.
    while (scroller !== null && rootElement.contains(scroller)) {
      const xOffset = scrollIntoViewHorizontally(
        defaultView,
        scroller,
        currentLeft,
        currentRight,
      );
      currentLeft -= xOffset;
      currentRight -= xOffset;
      scroller = scroller === rootElement ? null : getParentElement(scroller);
    }
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
        // Only the Y axis: horizontal scrolling stays inside the editor (above)
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

const cachedSelectedKeys = new WeakMap<LexicalNode[], Set<NodeKey> | null>();
/**
 * @internal
 * Whether the node with `key` is among the nodes of `selection`. When the
 * selection caches its nodes and is asked more than once, a Set of their keys
 * is cached with them, so asking this for every node of a large selection
 * stays linear.
 */
export function $isKeyInSelectionNodes(
  selection: BaseSelection,
  key: NodeKey,
): boolean {
  const nodes = selection.getNodes();
  if (nodes === selection.getCachedNodes()) {
    let keys = cachedSelectedKeys.get(nodes);
    if (keys === null) {
      keys = new Set(nodes.map(node => node.__key));
      cachedSelectedKeys.set(nodes, keys);
    } else if (keys === undefined) {
      // The first lookup scans, so a node list replaced after a single
      // lookup (as an update that writes in between does) builds no Set.
      cachedSelectedKeys.set(nodes, null);
    }
    if (keys) {
      return keys.has(key);
    }
  }
  return nodes.some(node => node.__key === key);
}

/**
 * For each element of a committed (frozen) EditorState, whether it holds a
 * TextNode at any depth, as ElementNode#shouldSerializeTextStyles asks for an
 * inline element. Without it, serializing inline elements nested inside each
 * other, each with a textFormat or textStyle, walks the same subtree once per
 * level. A frozen state never changes, so its entries never go stale.
 */
const textInsideCache = new WeakMap<EditorState, Map<NodeKey, boolean>>();

/**
 * @internal
 * The cache of $getTextInsideCache's frozen state for the active state, or
 * null where none is known to hold: a pending state uses the cache of the
 * committed state it was made from only while no node in it has been marked
 * dirty (written, created or removed), when it holds exactly that state's
 * nodes. A copy serializes in such an update.
 */
export function $getTextInsideCache(): Map<NodeKey, boolean> | null {
  let editorState = getActiveEditorState();
  if (!editorState._readOnly) {
    const editor = internalGetActiveEditor();
    if (
      editor === null ||
      editor._pendingEditorState !== editorState ||
      editor._dirtyType !== NO_DIRTY_NODES ||
      !editor._editorState._readOnly
    ) {
      return exportMemo !== null && exportMemo.editorState === editorState
        ? exportMemo.holds
        : null;
    }
    editorState = editor._editorState;
  }
  let cache = textInsideCache.get(editorState);
  if (cache === undefined) {
    cache = new Map();
    textInsideCache.set(editorState, cache);
  }
  return cache;
}

/**
 * The memo of one export walk in a pending state that has changed (see
 * INTERNAL_$withExportMemo), or null.
 */
let exportMemo: null | {
  editorState: EditorState;
  holds: Map<NodeKey, boolean>;
} = null;
/** Whether an export walk is running (with or without its memo). */
let exportWalk = false;

/**
 * @internal
 * Run an export walk (EditorState#toJSON, the clipboard's selection export)
 * with a memo of what $getTextInsideCache would hold, for an update whose
 * pending state has changed and so has no cache of its own. The memo lives
 * for the walk alone, which changes no node: a node made writable during the
 * walk (see internalStopExportMemo) drops it for the rest of the walk, so it
 * cannot answer for content that has changed.
 */
export function INTERNAL_$withExportMemo<T>(f: () => T): T {
  if (exportWalk) {
    return f();
  }
  const editorState = internalGetActiveEditorState();
  exportWalk = true;
  exportMemo =
    editorState !== null && !editorState._readOnly
      ? {editorState, holds: new Map()}
      : null;
  try {
    return f();
  } finally {
    exportWalk = false;
    exportMemo = null;
  }
}

/** @internal Drop the export walk's memo (see INTERNAL_$withExportMemo). */
export function internalStopExportMemo(): void {
  exportMemo = null;
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
/**
 * @internal
 */
export function hasOwnStaticMethod(
  klass: Klass<LexicalNode>,
  k: keyof Klass<LexicalNode>,
): boolean {
  return hasOwnKey(klass, k) && klass[k] !== LexicalNode[k];
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
  /**
   * Whether `klass` declared `$config()` itself.
   *
   * `ownNodeConfig` is the config the class *resolves* to, which for a class
   * that declared none is its ancestor's — reached through the inherited
   * method, and a fresh object each time, since `$config()` builds its result
   * per call. Anything walking the chain has to tell the two apart or it
   * attributes an ancestor's declarations to the subclass and counts them
   * twice; see {@link iterStaticNodeConfigChain}.
   */
  declaresOwnConfig: boolean;
}
/**
 * Everything derived once per node class: the `$config()` result and what is
 * compiled from it. One record in one map, so a serialization path that needs
 * a compiled table does not chase a second and third WeakMap keyed by the same
 * class, and there is a single place to populate.
 *
 * `compiled` is filled in *after* the record is cached, because compiling walks
 * the class chain and re-enters this cache for `klass` itself. It is
 * `undefined` only inside that window — a record whose compilation threw is
 * dropped rather than left behind — and nothing that runs during compilation
 * reads it, so {@link getCompiled} treats finding it missing as the error it
 * is: a `$config()` body serializing a node of the class being built.
 */
interface NodeClassRecord {
  readonly config: OwnStaticNodeConfig;
  composed: undefined | ComposedSchema;
  compiled: undefined | CompiledNodeClass;
  /** DEV only: whether validateOwnFields has run for this class. */
  ownFieldsValidated: boolean;
}

/** What a class's serialization runs on, compiled once at registration. */
interface CompiledNodeClass {
  /** The export-direction table (see {@link compileGetters}). */
  readonly getters: readonly CompiledGetter[];
  /** The import-direction table (see {@link compileSetters}). */
  readonly setters: readonly CompiledSetter[];
  /**
   * The flat NodeStates the class carries, applied by {@link $applyJSONSetters}
   * before the setters — and before a generated parser, which knows nothing of
   * them: what a node carries in state is not known when code is generated,
   * the same reason the export side appends it around the generated literal.
   */
  readonly flatStates: readonly AnyStateConfig[];
  /**
   * The generated JSON functions this class runs — its own, or an ancestor's
   * where they still apply — or `null` for a class that walks (see
   * {@link resolveGenerated}).
   */
  readonly generated: null | GeneratedJSON;
  /**
   * The compact form's omission test for one property, by key — the same three
   * comparisons {@link $writeJSONGetters} makes, from the same table.
   *
   * Generated code states each property's comparison as source, which it can
   * do for a default that has a literal a value could be `===`. For one that
   * does not — a reference-typed default, or a literal the schema compares
   * with an `isEqual` of its own — the comparison is this call instead, so the
   * generated form omits exactly what the walk omits rather than having to
   * choose between writing the property regardless and giving up the form.
   *
   * Handed to the exporter by {@link $generatedExportJSON} rather than reached
   * for: the generated module holds no value import at all, since importing
   * the node classes it was generated from would be a cycle.
   */
  readonly isCompactDefault: CompactDefaultTest;
}

/**
 * Whether the compact form omits `value` for the property named `key` — see
 * {@link CompiledNodeClass.isCompactDefault}.
 *
 * @internal
 */
export type CompactDefaultTest = (key: string, value: unknown) => boolean;
// A WeakMap so dynamically created node classes (tests, HMR reloads) stay
// collectable — more so now that one record pins a class's composed schema,
// both compiled tables, and every prototype method they resolved.
const NODE_CLASS_CACHE = new WeakMap<Klass<LexicalNode>, NodeClassRecord>();

/**
 * The cache record for a node class, building it (and injecting the class's
 * synthesized statics) on first use.
 */
function getNodeClassRecord(klass: Klass<LexicalNode>): NodeClassRecord {
  const cached = NODE_CLASS_CACHE.get(klass);
  return cached !== undefined ? cached : buildNodeClassRecord(klass);
}

/**
 * A class's compiled tables. {@link buildNodeClassRecord} fills them before it
 * returns, so the one way to find them missing is to serialize a node of the
 * class from inside its own `$config()`.
 */
function getCompiled(record: NodeClassRecord): CompiledNodeClass {
  const {compiled} = record;
  invariant(
    compiled !== undefined,
    '%s is still being registered: a $config() must not serialize a node of its own class',
    record.config.klass.name,
  );
  return compiled;
}

// Brands a getType() closure that Lexical synthesized (as opposed to a
// user-defined static getType()). buildNodeClassRecord uses this to avoid
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
//
// A function declared side-effect free (so the build annotates the call
// below) rather than an inline expression: the property reads on the node
// classes are a side effect to bundlers, which would pin the classes into
// every development bundle that imports the module.
/** @__NO_SIDE_EFFECTS__ */
function isUnoptimizedDevBuild(): boolean {
  return (
    __DEV__ &&
    // constructor(key=undefined)
    TabNode.length === 0 &&
    // constructor(text='', key?: NodeKey)
    TextNode.length === 0 &&
    // Class name mangling is another signal that this may be unreliable
    TextNode.name === 'TextNode'
  );
}

const IS_UNOPTIMIZED_DEV_BUILD = isUnoptimizedDevBuild();

/**
 * A precompiled step for applying one of a node's serialized schema properties
 * in {@link LexicalNode.updateFromJSON}: a field applied through a named setter
 * (`set<Prop>` by default, or the name recorded with `withAccessors`), or
 * assigned directly. Compiled once per class and cached so the base
 * updateFromJSON iterates an array and applies each directly, without walking
 * the class chain or materializing an intermediate parsed object on every call.
 *
 * A flat NodeState is serialized at the top level alongside these, but is not
 * one of them: it is applied through the single {@link $setState} entry point,
 * from the class's own list of them (see {@link CompiledNodeClass}), before
 * any of these run.
 */
type CompiledSetter =
  | {
      readonly kind: 'field';
      readonly key: string;
      readonly schema: AnySerializationSchema;
      // Resolved once at compile time so applying a field is a direct call
      // rather than a per-node string-keyed method lookup.
      readonly setter: (this: LexicalNode, value: unknown) => LexicalNode;
    }
  | {
      // The fast path: the property *is* a node field, declared with
      // withField, so applying it is an assignment with no method call and no
      // getWritable() — $applyJSONSetters already holds the writable node.
      readonly kind: 'ownField';
      readonly key: string;
      readonly schema: AnySerializationSchema;
      readonly field: string;
      /** Maps the parsed value to the stored one; see {@link SchemaField}. */
      readonly setterTable?: {readonly [key: string]: unknown};
    };

const EMPTY_SETTERS: readonly CompiledSetter[] = [];

/**
 * How `klass` reaches one direction of a serialized property: the
 * {@link SchemaField} unchanged when the direct field access holds, and the
 * name of the accessor it stands in for when it does not.
 *
 * A `SchemaField` that names a `method` is saying the two are equivalent *for
 * the class that declared it*. A subclass that overrides that method has said
 * otherwise, and it wins: before the property had a schema both JSON methods
 * went through the accessor, so overriding one changed the node's
 * serialization, and compiling the accessor away would silently take that back.
 *
 * The comparison resolves through each prototype chain, so it catches an
 * override anywhere between the declaring class and this one.
 *
 * `conventional` is the `get<Prop>`/`set<Prop>` name for this direction, used
 * when the field names no `method` of its own — which is the common case, and
 * why nearly every declaration can leave it out. A class that has no such
 * method defers to nothing, because both prototypes then resolve `undefined`
 * and compare equal; there is no separate way to say "bypass the accessor",
 * and deliberately so: a subclass that overrode one always meant to be asked.
 *
 * Shared with the codegen in `scripts/generate-node-json.mjs`, which has to
 * make the identical choice or its literal would describe a different node.
 *
 * @internal
 */
export function resolveSchemaField<T extends SchemaFieldBase>(
  klass: Klass<LexicalNode>,
  key: string,
  accessor: T,
  conventional: string,
): T | string {
  const method = accessor.method === undefined ? conventional : accessor.method;
  if (__DEV__ && accessor.method !== undefined) {
    // Only a name the declaration spelled out: a derived one that resolves to
    // nothing is the ordinary "this property has no accessor" case, while a
    // spelled one that resolves to nothing is a typo, and a typo here is
    // silent — both prototypes read `undefined`, compare equal, and the field
    // access is kept, quietly retiring the override guard this option exists
    // to provide. DEV-only: what it catches is a mistaken intent, and the
    // behavior either way is well defined.
    invariant(
      typeof (klass.prototype as unknown as Record<string, unknown>)[method] ===
        'function',
      '%s: serialization schema field "%s" names a method %s() that the node does not have',
      klass.name,
      key,
      method,
    );
  }
  const declaringKlass = getComposedSchema(klass).declaredBy.get(key);
  if (declaringKlass === undefined) {
    return accessor;
  }
  const prototype = klass.prototype as unknown as Record<string, unknown>;
  const declared = declaringKlass.prototype as unknown as Record<
    string,
    unknown
  >;
  // The conventional name is guarded alongside the spelled one, because a
  // spelled accessor is typically a wrapper *over* the conventional one rather
  // than a replacement for it: ElementNode's `textFormat` names
  // `getSerializedTextFormat`, which computes its result from `getTextFormat`.
  // Guarding only the wrapper would keep the direct field read for a subclass
  // that overrides `getTextFormat` — the accessor that has been public since
  // long before this schema existed, and the one such a subclass would
  // naturally reach for — silently exporting the stored field instead of what
  // the node says the property is.
  //
  // Only the guard widens: the property is still read through the spelled
  // accessor when it is reclaimed, since that is the one whose return type is
  // the serialized form. A conventional name the class does not have costs
  // nothing, as both prototypes then resolve `undefined` — which is the usual
  // case for a spelled accessor (`getText` alongside TextNode's
  // `getTextContent`, `getUrl` alongside LinkNode's `getURL`).
  return isUnchangedFrom(prototype, declared, method) &&
    isUnchangedFrom(prototype, declared, conventional)
    ? accessor
    : method;
}

/** Whether `klass` inherits `name` from the class that declared the property. */
function isUnchangedFrom(
  prototype: Record<string, unknown>,
  declared: Record<string, unknown>,
  name: string,
): boolean {
  return prototype[name] === declared[name];
}

/**
 * The default setter name for a serialized property, e.g. `foo` → `setFoo`.
 *
 * Exported for the same reason {@link resolveSchemaField} is: the codegen in
 * `scripts/generate-node-json.mjs` has to derive the identical name, and a
 * second copy of the rule is a second thing that can drift.
 *
 * @internal
 */
export function defaultSetterName(key: string): string {
  return `set${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

/**
 * The default getter name for a serialized property, e.g. `foo` → `getFoo`.
 *
 * @see {@link defaultSetterName}
 * @internal
 */
export function defaultGetterName(key: string): string {
  return `get${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

/**
 * The serialization schema fields and flat NodeStates a node class serializes,
 * composed across its config chain. Every consumer of "what does this class
 * serialize" derives from this one walk so they cannot disagree about
 * precedence: a subclass field overrides an ancestor's, while a re-declared
 * flat state keeps the ancestor's config (matching createSharedNodeState).
 *
 * @internal
 */
export interface ComposedSchema {
  /**
   * Fields ordered most-derived first — the order properties are written in,
   * which the hand-written exportJSON methods this replaces also produced for
   * the core classes, and which some tests compare as strings.
   */
  readonly fieldsDerivedFirst: readonly (readonly [
    string,
    AnySerializationSchema,
  ])[];
  /**
   * The same fields ordered ancestors first — the order setters are applied
   * in, so a base property is set before the subclass properties that may
   * depend on it.
   */
  readonly fieldsBaseFirst: readonly (readonly [
    string,
    AnySerializationSchema,
  ])[];
  /** Flat NodeStates, ancestors first. */
  readonly flatStates: readonly AnyStateConfig[];
  /**
   * The class whose `$config` declared each field's winning schema, which is
   * where {@link SchemaFieldBase.method} is measured from: a method the declaring
   * class and the node's class resolve differently is one somebody overrode in
   * between.
   */
  readonly declaredBy: ReadonlyMap<string, Klass<LexicalNode>>;
  /**
   * The same winning schemas by key, which is what a class's generated code
   * is built from at registration: the lookup tables it reads are these
   * schemas' own objects, so the generated module holds no copy of any.
   */
  readonly fields: ComposedSchemaFields;
}

const EMPTY_COMPOSED_SCHEMA: ComposedSchema = {
  declaredBy: new Map(),
  fields: new Map(),
  fieldsBaseFirst: [],
  fieldsDerivedFirst: [],
  flatStates: [],
};

function composeSchema(klass: Klass<LexicalNode>): ComposedSchema {
  // One walk of the config chain (iterStaticNodeConfigChain honors an explicit
  // `extends` and severed static prototype chains, e.g. Babel's loose class
  // transform), collected per class so both orderings fall out of it.
  const fieldGroups: (readonly (readonly [
    string,
    AnySerializationSchema,
  ])[])[] = [];
  const groupKlasses: Klass<LexicalNode>[] = [];
  const stateGroups: (readonly AnyStateConfig[])[] = [];
  for (const {klass: currentKlass, ownNodeConfig} of iterStaticNodeConfigChain(
    klass,
  )) {
    const json = ownNodeConfig && ownNodeConfig.json;
    groupKlasses.push(currentKlass);
    if (__DEV__ && json) {
      // Only a `nodeSchema` names fields. Anything else contributes nothing,
      // which would silently turn off the node's whole serialization, the one
      // thing declaring `json` is for.
      invariant(
        json.meta.kind === 'node',
        '%s: $config json must be built with nodeSchema<MyNode>()({...}); got a %s schema',
        // The class whose `$config` declared it, not the one being composed:
        // naming the subclass sent a reader to a class that declared nothing
        // wrong and never named the one they have to edit.
        currentKlass.name,
        json.meta.kind,
      );
    }
    fieldGroups.push(
      json && json.meta.kind === 'node'
        ? (Object.entries(json.meta.fields) as (readonly [
            string,
            AnySerializationSchema,
          ])[])
        : [],
    );
    const flat: AnyStateConfig[] = [];
    if (ownNodeConfig && ownNodeConfig.stateConfigs) {
      for (const required of ownNodeConfig.stateConfigs) {
        if ('stateConfig' in required && required.flat) {
          flat.push(required.stateConfig);
        }
      }
    }
    stateGroups.push(flat);
  }
  // Most-derived first, first write wins, so a subclass field overrides an
  // ancestor's and keeps the subclass's position.
  const derivedFirst = new Map<string, AnySerializationSchema>();
  for (let i = 0; i < fieldGroups.length; i++) {
    for (const [key, schema] of fieldGroups[i]) {
      if (!derivedFirst.has(key)) {
        derivedFirst.set(key, schema);
      }
    }
  }
  // The same winning schemas in ancestors-first order.
  const baseFirst = new Map<string, AnySerializationSchema>();
  const declaredBy = new Map<string, Klass<LexicalNode>>();
  const flatStates = new Map<string, AnyStateConfig>();
  for (let i = fieldGroups.length - 1; i >= 0; i--) {
    for (const [key, schema] of fieldGroups[i]) {
      const winner = derivedFirst.get(key);
      if (winner !== undefined && !baseFirst.has(key)) {
        baseFirst.set(key, winner);
      }
      // The most basal class declaring the *winning* schema, which is not the
      // same as the most basal one declaring the key: a subclass that
      // re-declares an inherited field is where that field now comes from.
      // Compared by identity because a subclass with no `$config` of its own
      // inherits the method and so reports its ancestor's fields as its own —
      // recording it here would measure SchemaField.method against a class
      // that never declared the property, and every override would look like
      // no override at all.
      if (winner !== undefined && schema === winner && !declaredBy.has(key)) {
        declaredBy.set(key, groupKlasses[i]);
      }
    }
    for (const stateConfig of stateGroups[i]) {
      if (!flatStates.has(stateConfig.key)) {
        flatStates.set(stateConfig.key, stateConfig);
      }
    }
  }
  if (__DEV__) {
    for (const key of flatStates.keys()) {
      // Export writes the flat state over the field, import applies the field
      // over the state, so such a property would flip on every round trip.
      invariant(
        !derivedFirst.has(key),
        '%s: "%s" is declared both as a serialization schema field and as a flat NodeState; it must be one or the other',
        klass.name,
        key,
      );
    }
  }
  return derivedFirst.size === 0 && flatStates.size === 0
    ? EMPTY_COMPOSED_SCHEMA
    : {
        declaredBy,
        fields: baseFirst,
        fieldsBaseFirst: [...baseFirst],
        fieldsDerivedFirst: [...derivedFirst],
        flatStates: [...flatStates.values()],
      };
}

/**
 * The composed serialization schema of a node class, compiled once per class.
 *
 * @internal
 */
export function getComposedSchema(klass: Klass<LexicalNode>): ComposedSchema {
  const record = getNodeClassRecord(klass);
  if (record.composed === undefined) {
    record.composed = composeSchema(klass);
  }
  return record.composed;
}

/**
 * Every node-specific property of a class's serialized JSON — its composed
 * serialization schema fields plus any flat NodeState whose value schema is
 * introspectable — keyed by serialized property name.
 *
 * @internal
 */
export function getComposedSchemaFields(
  klass: Klass<LexicalNode>,
): Record<string, AnySerializationSchema> {
  const {fieldsDerivedFirst, flatStates} = getComposedSchema(klass);
  const fields: Record<string, AnySerializationSchema> = {};
  for (const stateConfig of flatStates) {
    if (stateConfig.schema) {
      fields[stateConfig.key] = stateConfig.schema;
    }
  }
  for (const [key, schema] of fieldsDerivedFirst) {
    fields[key] = schema;
  }
  return fields;
}

/**
 * What the compact form may drop for one property, resolved with the accessor
 * so writing the compact form needs no second pass over the schema: a derived
 * property (`{setter: null}`) is bytes nothing will ever read, and a value
 * equal to the default parsing would restore says nothing either.
 */
interface CompactRule {
  /**
   * The schema this entry was compiled from, carried for the same reason the
   * setter side carries it: {@link sameCompiledTables} compares it by identity
   * to decide whether one class's generated code describes another's node.
   * Everything the emitted code says about a property beyond its kind and
   * field — which accessor it calls, which predicate gates it, what its domain
   * admits — comes from here, and a class that re-declares a property declares
   * a new schema, so identity is what separates "inherited unchanged" from
   * "restated, possibly differently".
   */
  readonly schema: AnySerializationSchema;
  readonly derived: boolean;
  /**
   * What parsing restores for an absent property, and so what the compact form
   * omits. Resolved with the accessor so the write path needs no second look at
   * the schema.
   */
  readonly defaultValue: unknown;
  /**
   * The schema's own equality, hoisted, or `undefined` where identity is the
   * whole answer.
   *
   * Kept apart from the value so the common case is a comparison rather than a
   * call. Only {@link arrayValue} and {@link objectValue} declare one — every
   * primitive domain, which is nearly every serialized property, compares by
   * identity — and the write path checks that first either way, so a declared
   * equality costs a call only for a value that is not already identical.
   */
  readonly isEqual: undefined | ((a: unknown, b: unknown) => boolean);
}

/**
 * The mirror of {@link CompiledSetter} for the export direction: one of a
 * node's serialized properties read back through a named getter (`get<Prop>`
 * by default, or the name recorded with `withAccessors`). Compiled once per
 * class so {@link LexicalNode.exportJSON} writes an object without walking the
 * class chain on every call.
 */
type CompiledGetter = CompactRule &
  (
    | {
        readonly kind: 'method';
        readonly key: string;
        // Resolved once at compile time, like the setter counterpart.
        readonly getter: (this: LexicalNode) => unknown;
      }
    | {
        // The fast path, mirroring the setter side: the property *is* a node
        // field, so reading it is a property access — no method call and no
        // version resolution (see $writeJSONGetters).
        readonly kind: 'ownField';
        readonly key: string;
        readonly field: string;
        /** Maps the stored value to the serialized one; see {@link SchemaField}. */
        readonly getterTable?: {readonly [key: string]: unknown};
        /**
         * Resolved once at compile time, like the method getter: the predicate
         * named by {@link SchemaGetterField.when}, which gates writing this
         * property at all.
         */
        readonly when?: (this: LexicalNode) => boolean;
      }
  );

const EMPTY_GETTERS: readonly CompiledGetter[] = [];

/**
 * The accessor `klass` reads a serialized property through: `null` for a
 * property declared import-only, the {@link SchemaGetterField} when the direct
 * field access holds, and otherwise the name of the getter method.
 *
 * This is the whole of the export direction's resolution rule, in one place:
 * {@link compileGetters} builds the walk's table from it, and the codegen in
 * `scripts/generate-node-json.mjs` emits its literal from it, so the two
 * cannot describe different nodes.
 *
 * @internal
 */
export function resolveGetterAccessor(
  klass: Klass<LexicalNode>,
  key: string,
  schema: AnySerializationSchema,
): null | string | SchemaGetterField {
  const declared = schema.getter;
  if (declared === null) {
    return null;
  }
  // `=== undefined`, not `||`: an empty recorded name is a mistake, not a
  // request for the conventional one, and resolving it silently would apply
  // some other accessor that happens to exist.
  const named = declared === undefined ? defaultGetterName(key) : declared;
  // A subclass override of the accessor a field stands in for reclaims the
  // property; otherwise this is the field unchanged.
  return isSchemaField(named)
    ? resolveSchemaField(klass, key, named, defaultGetterName(key))
    : named;
}

/**
 * The setter mirror of {@link resolveGetterAccessor}.
 *
 * @internal
 */
export function resolveSetterAccessor(
  klass: Klass<LexicalNode>,
  key: string,
  schema: AnySerializationSchema,
): null | string | SchemaSetterField {
  const declared = schema.setter;
  if (declared === null) {
    return null;
  }
  const named = declared === undefined ? defaultSetterName(key) : declared;
  return isSchemaField(named)
    ? resolveSchemaField(klass, key, named, defaultSetterName(key))
    : named;
}

function compileGetters(klass: Klass<LexicalNode>): readonly CompiledGetter[] {
  const prototype = klass.prototype as unknown as Record<string, unknown>;
  const fields = new Map<string, CompiledGetter>();
  // Most-derived first, which reproduces the order TextNode and ElementNode's
  // hand-written exportJSON produced for their own fields. It does *not*
  // reproduce it for a subclass: `{...super.exportJSON(), ownProps}` put the
  // subclass's properties last, and they now come first, with `type`/`version`
  // appended afterwards. The JSON is equivalent — key order carries no
  // meaning — but `JSON.stringify(editorState.toJSON())` is byte-different for
  // an existing document, so anything comparing serialized strings sees a
  // change. Composition already resolved each key to exactly one schema, so a
  // subclass that re-declares an inherited field replaces it outright,
  // accessor names included — TabNode repeats `getter: 'getTextContent'` for
  // that reason.
  for (const [key, schema] of getComposedSchema(klass).fieldsDerivedFirst) {
    const getter = resolveGetterAccessor(klass, key, schema);
    if (getter === null) {
      // Declared import-only; the property is written by an exportJSON
      // override, or not written at all.
      continue;
    }
    if (isSchemaField(getter)) {
      const getterName = getter.field;
      // withField: the property *is* this node field, so reading it is a
      // property access — no method call, and no getLatest() (see
      // $writeJSONGetters). The field only exists on a constructed node, so
      // unlike the method below it is checked on first read.
      //
      // `__proto__` names the prototype rather than a field, so reading it
      // would write the node's whole prototype chain into the JSON (and throw
      // on stringify); the setter mirror rejects it for the same reason.
      invariant(
        getterName !== '__proto__',
        '%s: serialization schema field "%s" cannot be read from __proto__',
        klass.name,
        key,
      );
      const whenName = getter.when;
      let when: undefined | ((this: LexicalNode) => boolean);
      if (whenName !== undefined) {
        const predicate = prototype[whenName];
        // Same reasoning as the accessor check below: a predicate that does
        // not resolve would silently drop the property from every export.
        invariant(
          typeof predicate === 'function',
          '%s: serialization schema field "%s" names a predicate %s() that the node does not have',
          klass.name,
          key,
          whenName,
        );
        when = predicate as (this: LexicalNode) => boolean;
      }
      fields.set(key, {
        defaultValue: schema.defaultValue,
        derived: schema.setter === null,
        field: getterName,
        getterTable: getter.getterTable,
        isEqual: schema.isEqual,
        key,
        kind: 'ownField',
        schema,
        when,
      });
      continue;
    }
    const method = prototype[getter];
    // A field the class cannot read would be silently missing from every
    // export — data loss, not a degraded experience — so this fails in every
    // build, not only in DEV. It runs once per class at registration.
    invariant(
      typeof method === 'function',
      '%s: serialization schema field "%s" has no getter %s(); name one with withAccessors({getter}) or declare {getter: null} if it is deliberately not exported',
      klass.name,
      key,
      getter,
    );
    fields.set(key, {
      defaultValue: schema.defaultValue,
      derived: schema.setter === null,
      getter: method as (this: LexicalNode) => unknown,
      isEqual: schema.isEqual,
      key,
      kind: 'method',
      schema,
    });
  }
  return fields.size === 0 ? EMPTY_GETTERS : [...fields.values()];
}

/**
 * Read a node field by name. A node type has no index signature, so a dynamic
 * property access needs the widening cast; keeping it in one named place
 * leaves the call sites cast-free.
 */
function ownFieldRecord(node: LexicalNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
}

/**
 * Check every field name a class's schema declares (`withField`, or an
 * accessor named `__something`) against a real instance of it. A misspelled
 * one is silent, total loss of that property — nothing is ever exported, and
 * importing writes a field the node does not read.
 *
 * Both compiled tables are checked, not just the caller's. A getter name and a
 * setter name are declared independently — `withAccessors` takes them
 * separately, and either direction may be `null` — so a class can carry an
 * `ownField` entry on one side and not the other. Checking only the direction
 * that happened to serialize first would leave the other side's name unchecked
 * for the life of the process.
 *
 * Unlike the method-name checks in {@link compileGetters} / {@link compileSetters},
 * this one is DEV-only. A field exists on a constructed node, not on the
 * prototype, so it cannot be resolved when the class is registered: the check
 * needs an instance, which means it can only run on a serialization path.
 * Registration-time checks have no such cost — they run once, on the class
 * alone — which is why those fail in every build and this does not. Running it
 * once per class keeps it off the per-node path in DEV too.
 */
function validateOwnFields(record: NodeClassRecord, node: LexicalNode): void {
  if (record.ownFieldsValidated) {
    return;
  }
  const {klass} = record.config;
  const fields = ownFieldRecord(node);
  const {getters, setters} = getCompiled(record);
  for (const entries of [getters, setters]) {
    for (const entry of entries) {
      if (entry.kind === 'ownField') {
        // A field declared without an initializer (`__caption?: string`) is
        // not an own property until something assigns it, and this cannot
        // tell that from a misspelling — so the message says which fix
        // applies to which.
        invariant(
          hasOwnKey(fields, entry.field),
          '%s: serialization schema field "%s" names a node field %s that the node does not have. Check the spelling; a field declared without an initializer is not an own property until the constructor assigns it',
          klass.name,
          entry.key,
          entry.field,
        );
      }
    }
  }
  // Recorded only once the whole pass has run. The editor catches what a
  // serialization path throws — parseEditorState routes it to `_onError`
  // rather than rethrowing — so marking the class first would let one caught
  // failure retire the check with every field after it still unexamined.
  record.ownFieldsValidated = true;
}

/**
 * Write the serialized properties a node's schema declares, reading each
 * through its getter. A getter that returns `undefined` omits the property:
 * absent and explicitly-undefined are indistinguishable once the JSON is
 * stringified, so this is how an optional (or conditionally persisted)
 * property is expressed.
 *
 * Compaction is applied here rather than as a pass over the finished object:
 * with `compact`, a property the parser derives is skipped without calling its
 * getter at all, and one whose value equals the schema default parsing would
 * restore is simply not written. That leaves nothing for a later pass to
 * inspect, so a node that generates its own `exportJSON` can inline the same
 * decisions and never consult the schema at runtime.
 *
 * A field is read off `node` as given, with no `getLatest()`. Serializing a
 * graph only needs to resolve its root: every node the walk reaches after that
 * comes from the EditorState's node map — `$getRoot()`, `getChildren()`,
 * `$getSlot()` — so it is already the current version. (An ephemeral node, such
 * as the sliced clone the clipboard walk exports, is deliberately not in the
 * map, and reading it as given is the only correct thing to do.)
 *
 * @internal
 */
export function $writeJSONGetters(
  node: LexicalNode,
  json: {[key: string]: unknown},
  compact: boolean,
): void {
  const record = getNodeClassRecord(node.constructor as Klass<LexicalNode>);
  if (__DEV__) {
    validateOwnFields(record, node);
  }
  $writeCompiledGetters(node, getCompiled(record).getters, json, compact);
}

/**
 * The body of {@link $writeJSONGetters}, over a table the caller has already
 * resolved — which {@link $exportNodeJSONOnce} has, having just asked the same
 * record whether the class carries generated code.
 */
function $writeCompiledGetters(
  node: LexicalNode,
  getters: readonly CompiledGetter[],
  json: {[key: string]: unknown},
  compact: boolean,
): void {
  for (let i = 0; i < getters.length; i++) {
    const entry = getters[i];
    if (compact && entry.derived) {
      // Nothing will read it back, so the compact form does not even call the
      // getter to find out what it would have written.
      continue;
    }
    let value: unknown;
    if (entry.kind === 'ownField') {
      const stored = ownFieldRecord(node)[entry.field];
      // hasOwnKey for the same reason the import mirror uses it: the field
      // holds whatever was stored, which for a schema whose domain is wider
      // than the table's keys can be a name Object.prototype also carries —
      // writing that method into the JSON as a value. A genuine miss still
      // yields `undefined`, exactly as the bare lookup did, which is also what
      // the generated exporters emit for one.
      value =
        entry.getterTable === undefined
          ? stored
          : hasOwnKey(entry.getterTable, stored as string)
            ? entry.getterTable[stored as string]
            : undefined;
    } else {
      value = entry.getter.call(node);
    }
    if (entry.kind === 'ownField' && entry.when !== undefined) {
      // A conditionally-persisted property: written only when it differs from
      // the schema default *and* the node's predicate agrees. The default is
      // tested first, so the predicate stays off the common path — a property
      // holding what parsing would restore is omitted without asking. Written
      // out rather than routed through isSchemaDefault for the same reason the
      // compact comparison below is: this runs per property per node.
      //
      // Generated code hoists a predicate shared by several properties and so
      // calls it once where this calls it per property, which is why it is
      // required to be pure.
      if ($isCompactDefaultFor(entry, value) || !entry.when.call(node)) {
        value = undefined;
      }
    }
    if (compact && $isCompactDefaultFor(entry, value)) {
      // The compact form omits, because its output is for storage and an
      // object-level consumer (a structured clone into IndexedDB) counts keys
      // the way stringify counts bytes.
      continue;
    }
    // The legacy form writes unconditionally, `undefined` included:
    // JSON.stringify omits an undefined-valued property, so the serialized
    // bytes are identical either way, and present-with-undefined is the shape
    // the hand-written exporters always had — main's ListItemNode writes
    // `checked: this.getChecked()` on every non-checklist item, TableNode
    // writes `colWidths: undefined` by explicit ternary. Writing the key also
    // keeps every export of a class on one object shape, and is one branch
    // less per property.
    json[entry.key] = value;
  }
}

/**
 * The compact form's rule for one property: omit it when the value is what
 * parsing would restore.
 *
 * Inline rather than `isSchemaDefault(rule.schema, value)`: this runs per
 * property per node, and for a primitive domain — nearly every serialized
 * property — the whole answer is the identity comparison, with the declared
 * equality reached only for a value that is not already identical.
 *
 * The one rule, in one place, because two implementations write this form: the
 * walk calls it per property, and a generated exporter calls it through
 * {@link CompiledNodeClass.isCompactDefault} for the properties whose defaults
 * it could not state as source. A second copy of these three comparisons is
 * exactly the drift that would make the two forms disagree.
 */
function $isCompactDefaultFor(rule: CompactRule, value: unknown): boolean {
  const {defaultValue, isEqual} = rule;
  return (
    value === undefined ||
    value === defaultValue ||
    (isEqual !== undefined && isEqual(value, defaultValue))
  );
}

/**
 * {@link CompiledNodeClass.isCompactDefault} for one class's getter table.
 *
 * The key index is built on first use rather than with the table: only a
 * property whose default has no literal the generated code could compare
 * against ever reaches this, which no built-in node has.
 */
function compactDefaultTest(
  getters: readonly CompiledGetter[],
): CompactDefaultTest {
  let byKey: undefined | Map<string, CompiledGetter>;
  return (key, value) => {
    if (byKey === undefined) {
      byKey = new Map(getters.map(entry => [entry.key, entry]));
    }
    const entry = byKey.get(key);
    // A key with no entry is one the generated code and the table disagree
    // about, which `sameCompiledTables` is what prevents; omitting it would
    // silently drop a property, so the value is written.
    return entry !== undefined && $isCompactDefaultFor(entry, value);
  };
}

/**
 * The stored form of a compiled property's schema default — what an `setterTable`
 * table maps the default to, or the default itself where there is no table.
 * A table always has the entry: {@link compileSetters} refuses one without
 * it when the class is registered, as {@link verifyTableCoversDomain} refuses
 * it for a generated class, because a default with no stored form left the
 * raw default — a string, for a numeric field — as what a miss wrote.
 */
function setterDefault(entry: {
  readonly setterTable?: {readonly [key: string]: unknown};
  readonly schema: AnySerializationSchema;
}): unknown {
  const {setterTable, schema} = entry;
  const {defaultValue} = schema;
  return setterTable === undefined
    ? defaultValue
    : setterTable[String(defaultValue)];
}

function compileSetters(klass: Klass<LexicalNode>): readonly CompiledSetter[] {
  // A class instance type has no index signature, so reading a setter by
  // name needs the widening cast.
  const prototype = klass.prototype as unknown as Record<string, unknown>;
  const fields = new Map<string, CompiledSetter>();
  const {fieldsBaseFirst} = getComposedSchema(klass);
  // Applied ancestors-first: a base property is set before the subclass
  // properties that may depend on it.
  for (const [key, schema] of fieldsBaseFirst) {
    const setter = resolveSetterAccessor(klass, key, schema);
    if (setter === null) {
      // Declared export-only: the value is derived from other properties on
      // the way in (ListNode's `tag` follows from `listType`).
      continue;
    }
    if (isSchemaField(setter)) {
      const setterName = setter.field;
      // withField: the property *is* this node field, so applying it is an
      // assignment — no method call, and no getWritable(), since the node
      // $applyJSONSetters walks is writable by construction.
      //
      // `__proto__` would reparent the node rather than write a property, so
      // it is never a field name; the rest is checked on the prototype, where
      // a class field declared with an initializer is not visible, so the
      // getter mirror does the per-instance check.
      invariant(
        setterName !== '__proto__',
        '%s: serialization schema field "%s" cannot be applied to __proto__',
        klass.name,
        key,
      );
      // A parsed value the table does not map is stored as the encoded
      // default, so the table has to map every value the schema can produce
      // — the default first of all, since a default it does not map has no
      // stored form and the walk would write the raw default into the field.
      // An enum's members are every value it produces; any other schema is
      // checked for its default, the one value known here. Every build, like
      // the setter check below: what it prevents is a value of the wrong type
      // written into a field on import, silently, in production.
      if (setter.setterTable !== undefined) {
        const {setterTable} = setter;
        const {meta} = schema;
        for (const value of meta.kind === 'enum'
          ? meta.values
          : [schema.defaultValue]) {
          invariant(
            hasOwnKey(setterTable, String(value)),
            '%s: serialization schema field "%s" has no setterTable entry for %s, which its schema can produce; a parsed value the table does not map is stored as the encoded default, so the table must map every value the schema produces',
            klass.name,
            key,
            JSON.stringify(value),
          );
        }
      }
      fields.set(key, {
        field: setterName,
        key,
        kind: 'ownField',
        schema,
        setterTable: setter.setterTable,
      });
      continue;
    }
    const method = prototype[setter];
    // A field the class cannot apply would be silently dropped from every
    // import — it exports but never comes back — so, like the getter mirror,
    // this fails in every build rather than only in DEV.
    invariant(
      typeof method === 'function',
      '%s: serialization schema field "%s" has no setter %s(); name one with withAccessors or declare {setter: null} if it is derived on import',
      klass.name,
      key,
      setter,
    );
    fields.set(key, {
      key,
      kind: 'field',
      schema,
      setter: method as (this: LexicalNode, value: unknown) => LexicalNode,
    });
  }
  return fields.size === 0 ? EMPTY_SETTERS : [...fields.values()];
}

/**
 * The generated JSON functions a node class runs, or `null` for a class the
 * generated code does not describe.
 *
 * A class declares its own through `$config`, so the association is the same
 * one its schema has. A subclass inherits them along with the schema, on one
 * condition: that its compiled tables are the ones the code was generated from.
 * Generated code reads the fields the declaring class resolved its properties
 * to and calls the methods it resolved them to; a subclass that overrides an
 * accessor a field stands in for, or declares a property of its own, resolves
 * differently, and for it the code would be wrong. Comparing the two classes'
 * tables entry for entry is what decides ({@link sameCompiledTables}) — they
 * are the tables the walk would use, so what runs is always what the walk
 * would have done. The declaring class is the most basal one in the chain that
 * names the same functions, for the same reason `declaredBy` is.
 *
 * A `$config` of its own that names an ancestor's generated code is refused in
 * DEV: inheriting is automatic where it applies, and where it does not, a
 * declaration that silently ran the walk would leave the class believing it
 * ships the code it named.
 */
function resolveGenerated(
  klass: Klass<LexicalNode>,
  ownNodeConfig:
    | undefined
    | StaticNodeConfigValue<LexicalNode, string | symbol>,
  tables: Pick<CompiledNodeClass, 'getters' | 'setters'>,
): null | GeneratedJSONFactory {
  // The nearest declaration up the chain. A class with no `$config` of its own
  // reads its ancestor's, declaration included, as its own; one whose `$config`
  // names none inherits from the first ancestor that does.
  // One walk for both questions: the nearest declaration, and the most basal
  // class naming that same object. The second cannot precede the first, so
  // the loop records the first it sees and then keeps overwriting the class
  // for as long as later ancestors name it.
  let declared: undefined | GeneratedJSONFactory;
  let declaringKlass = klass;
  for (const {
    klass: currentKlass,
    ownNodeConfig: config,
  } of iterStaticNodeConfigChain(klass)) {
    if (config && config.generated !== undefined) {
      if (declared === undefined) {
        declared = config.generated;
        declaringKlass = currentKlass;
      } else if (config.generated === declared) {
        declaringKlass = currentKlass;
      }
    }
  }
  if (declared === undefined) {
    return null;
  }
  if (declaringKlass === klass) {
    return declared;
  }
  if (__DEV__) {
    invariant(
      !(
        ownNodeConfig !== undefined &&
        ownNodeConfig.generated === declared &&
        hasOwnKey(klass.prototype as unknown as object, PROTOTYPE_CONFIG_METHOD)
      ),
      '%s: $config names the generated JSON code that %s declared; generated code is inherited wherever it still applies, so omit it',
      klass.name,
      declaringKlass.name,
    );
  }
  return sameCompiledTables(
    tables,
    getCompiled(getNodeClassRecord(declaringKlass)),
  )
    ? declared
    : null;
}

/**
 * Whether two classes' compiled tables would run the same generated code:
 * every entry the same kind for the same key, reading or writing the same
 * field through the same tables, against the same schema.
 *
 * The schema is compared by identity in both directions, and it is what makes
 * this sound rather than a list of the details anyone remembered to compare.
 * Generated code says more about a property than its kind and field: which
 * accessor method it calls, which `when` predicate gates writing it, what its
 * domain admits. All of that comes from the schema, none of it is on the
 * compiled entry, and a class that re-declares a property declares a new
 * schema — so identity separates a property inherited unchanged from one
 * restated, possibly differently, and a class that restates anything takes the
 * walk instead.
 *
 * Identity is not too strict for an *override*, which is the case inheritance
 * exists for: a subclass that overrides an accessor or a predicate without
 * re-declaring the property shares the schema object, and the emitted code
 * calls both by name, so the override is honored the way the walk honors it.
 */
function sameCompiledTables(
  a: Pick<CompiledNodeClass, 'getters' | 'setters'>,
  b: Pick<CompiledNodeClass, 'getters' | 'setters'>,
): boolean {
  if (
    a.getters.length !== b.getters.length ||
    a.setters.length !== b.setters.length
  ) {
    return false;
  }
  for (let i = 0; i < a.getters.length; i++) {
    const x = a.getters[i];
    const y = b.getters[i];
    if (
      x.kind !== y.kind ||
      x.key !== y.key ||
      x.schema !== y.schema ||
      x.derived !== y.derived ||
      x.isEqual !== y.isEqual ||
      !Object.is(x.defaultValue, y.defaultValue) ||
      // Whether a table is read, not which: the code reads its tables off the
      // running class's schema when it is attached, and the schema comparison
      // above has already settled which schema that is.
      (x.kind === 'ownField' &&
        y.kind === 'ownField' &&
        (x.field !== y.field ||
          (x.getterTable === undefined) !== (y.getterTable === undefined)))
    ) {
      return false;
    }
  }
  for (let i = 0; i < a.setters.length; i++) {
    const x = a.setters[i];
    const y = b.setters[i];
    if (
      x.kind !== y.kind ||
      x.key !== y.key ||
      x.schema !== y.schema ||
      (x.kind === 'ownField' &&
        y.kind === 'ownField' &&
        (x.field !== y.field ||
          (x.setterTable === undefined) !== (y.setterTable === undefined)))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The generated JSON functions `klass` runs (see {@link resolveGenerated}), or
 * `null`. For tests, which need to know whether a comparison against the walk
 * is comparing anything.
 *
 * @internal
 */
export function getGeneratedJSON(
  klass: Klass<LexicalNode>,
): null | GeneratedJSON {
  return getCompiled(getNodeClassRecord(klass)).generated;
}

/**
 * The schema-driven walk's export of `node` in the form asked for, without
 * NodeState, in the key order the generated exporters reproduce. The legacy
 * form is `children` first for an element, then every property the schema
 * declares through {@link $writeJSONGetters}, then `type` and `version` — the
 * order it has always had. The compact form is new and leads with `type`, so
 * a node reads type-first and generated code can allocate the object on its
 * fixed keys; key order is part of neither format, since parsing reads
 * properties by name. What {@link LexicalNode.exportJSON} runs for a class
 * without generated code, and what generated code is checked against.
 *
 * @internal
 */
export function $walkExportJSON(
  node: LexicalNode,
  compact: boolean,
): {[key: string]: unknown} {
  const record = getNodeClassRecord(node.constructor as Klass<LexicalNode>);
  if (__DEV__) {
    validateOwnFields(record, node);
  }
  return $walkFromCompiled(node, getCompiled(record).getters, compact);
}

/** {@link $walkExportJSON} over an already-resolved getter table. */
function $walkFromCompiled(
  node: LexicalNode,
  getters: readonly CompiledGetter[],
  compact: boolean,
): {[key: string]: unknown} {
  const json: {[key: string]: unknown} = compact ? {type: node.__type} : {};
  if ($isElementNode(node)) {
    // Before the schema's properties, so that an element's JSON reads
    // structure-first.
    json.children = [];
  }
  $writeCompiledGetters(node, getters, json, compact);
  if (!compact) {
    json.type = node.__type;
    // Deprecated and ignored on the way in; written only so the legacy form
    // stays readable by older versions.
    json.version = 1;
  }
  return json;
}

/**
 * What the generated exporter writes for `node` in the form asked for, or
 * `undefined` when its class has no generated code for that form and the
 * schema-driven walk has to run instead.
 *
 * A generated exporter is only ever right for the exact accessors its class
 * resolves, which is what {@link resolveGenerated} settled at registration.
 * Both forms are generated — which properties the compact one drops depends on
 * a node's values, but the rule does not, so each form is its own
 * straight-line function. NodeState is not part of either: what a node carries
 * is not known when the code is generated, so {@link LexicalNode.exportJSON}
 * appends it to this result and to the walk's alike.
 *
 * @internal
 */
/**
 * What a node exports in the form asked for: the generated exporter where its
 * class has one for that form, and the schema-driven walk otherwise.
 *
 * One function because both halves start by resolving the class record, and
 * asking twice — once to find there is no generated code, once to walk —
 * repeated a WeakMap read and, in DEV, the own-field validation, per node per
 * export. That is the path every node whose class the generator could not
 * compile takes, which is most nodes outside the core.
 *
 * @internal
 */
export function $exportNodeJSONOnce(
  node: LexicalNode,
  compact: boolean,
): {[key: string]: unknown} {
  const record = getNodeClassRecord(node.constructor as Klass<LexicalNode>);
  const compiled = getCompiled(record);
  const {generated, isCompactDefault} = compiled;
  const exporter =
    generated === null
      ? undefined
      : compact
        ? generated.exportCompactJSON
        : generated.exportJSON;
  if (__DEV__) {
    validateOwnFields(record, node);
  }
  return exporter === undefined
    ? $walkFromCompiled(node, compiled.getters, compact)
    : compact
      ? (exporter as NonNullable<GeneratedJSON['exportCompactJSON']>)(
          node,
          isCompactDefault,
        )
      : (exporter as GeneratedJSON['exportJSON'])(node);
}

export function $generatedExportJSON(
  node: LexicalNode,
  compact: boolean,
): undefined | {[key: string]: unknown} {
  const record = getNodeClassRecord(node.constructor as Klass<LexicalNode>);
  const {generated, isCompactDefault} = getCompiled(record);
  if (generated === null) {
    return undefined;
  }
  // Each form is generated separately, so this picks a function rather than
  // passing the flag on. The generator emits both forms for every class it can
  // export at all — a property whose default it cannot state as source
  // compares through `isCompactDefault` instead — but the field stays
  // optional, so a value written by hand still falls back to the walk here.
  const exporter = compact ? generated.exportCompactJSON : generated.exportJSON;
  if (exporter === undefined) {
    return undefined;
  }
  if (__DEV__) {
    // The check the walk would have run. Generated code reads the field names
    // the schema declared, so a misspelled one is the same silent, total loss
    // of a property here as it is there.
    validateOwnFields(record, node);
  }
  // Branched rather than one call on the union: the two forms take different
  // arities, and the compact one is handed the *running* class's table — not
  // the declaring class's, which is what a subclass running inherited code
  // needs. Most generated exporters ignore it.
  return compact
    ? (exporter as NonNullable<GeneratedJSON['exportCompactJSON']>)(
        node,
        isCompactDefault,
      )
    : (exporter as GeneratedJSON['exportJSON'])(node);
}

/**
 * Apply a serialized node to one this update has just constructed, which is
 * what {@link LexicalNode.importJSON} does after building the node.
 *
 * The difference from {@link LexicalNode.updateFromJSON} is the `getWritable()`
 * that one opens with. It has to: it is public API and may be handed any node,
 * from any version, at any point in an update. A node `importJSON` just built
 * is none of those things — {@link $setNodeKey} put it in the node map, in the
 * dirty set and in `_cloneNotNeeded` a moment earlier, so it already *is* the
 * writable latest version and `getWritable()` can only re-derive what the
 * constructor established: resolve the latest by key, re-mark a node that is
 * already dirty, and walk parents it does not yet have.
 *
 * That cost is per node and the parse path pays it for every node in the
 * document, which is why this exists rather than the caller simply chaining
 * `updateFromJSON`. The node a replacement returns is fresh in the same sense —
 * {@link $applyNodeReplacement} requires it to carry a key of its own — so it
 * qualifies too.
 *
 * @internal
 */
export function $applyImportJSON<T extends LexicalNode>(
  node: T,
  serializedNode: LexicalParseJSON<SerializedLexicalNode>,
): T {
  if (__DEV__) {
    // The whole point is skipping getWritable(), so assert what it would have
    // returned rather than calling it: a key in _cloneNotNeeded is one whose
    // node this update created (or already cloned), which is exactly the
    // branch of getWritable() that returns the node unchanged.
    invariant(
      $isEphemeral(node) || getActiveEditor()._cloneNotNeeded.has(node.__key),
      '$applyImportJSON: node %s with key %s was not constructed by this update; use updateFromJSON instead',
      node.constructor.name,
      node.__key,
    );
  }
  // Skipped entirely for the common node, which carries no state and is
  // imported from JSON that has none; $updateStateFromJSON is the one other
  // place the getWritable would have come from.
  const self =
    node.__state || serializedNode[NODE_STATE_KEY] !== undefined
      ? $updateStateFromJSON(node, serializedNode)
      : node;
  return $applyJSONSetters(self, serializedNode);
}

/**
 * Apply a node's compiled serialization schema (see {@link compileSetters}),
 * returning the (writable) node: flat NodeState first, then the schema's
 * properties — through the class's generated parser when it has one, and
 * otherwise by calling each property's setter with its parsed value. Used by
 * the base {@link LexicalNode.updateFromJSON} so a node that declares a
 * serialization schema needs no `updateFromJSON` boilerplate.
 *
 * @internal
 */
export function $applyJSONSetters<T extends LexicalNode>(
  node: T,
  serializedNode: {readonly [key: string]: unknown},
): T {
  const record = getNodeClassRecord(node.constructor as Klass<LexicalNode>);
  if (__DEV__) {
    validateOwnFields(record, node);
  }
  const {flatStates, generated, setters} = getCompiled(record);
  const self = $applyFlatStates(node, serializedNode, flatStates);
  if (generated !== null && generated.updateFromJSON !== undefined) {
    // The generated parser applies the same properties in the same order and
    // ignores a setter's return the same way, so what it hands back is what
    // the walk would have: the node passed in.
    return generated.updateFromJSON(self, serializedNode) as T;
  }
  return $walkSetters(self, serializedNode, setters);
}

/**
 * {@link $applyJSONSetters} with the generated parser left out — the
 * schema-driven walk alone — which is what generated code is checked against.
 *
 * @internal
 */
export function $walkJSONSetters<T extends LexicalNode>(
  node: T,
  serializedNode: {readonly [key: string]: unknown},
): T {
  const record = getNodeClassRecord(node.constructor as Klass<LexicalNode>);
  if (__DEV__) {
    validateOwnFields(record, node);
  }
  const {flatStates, setters} = getCompiled(record);
  return $walkSetters(
    $applyFlatStates(node, serializedNode, flatStates),
    serializedNode,
    setters,
  );
}

/**
 * Flat state first, matching the order in which $updateStateFromJSON ran
 * before a node's own setters — and by the walk whether or not the class has a
 * generated parser, which is handed the node with its state already applied.
 * What a node carries in state is not known when code is generated; this is
 * the mirror of exportJSON appending `__state.toJSON()` around the generated
 * literal.
 */
function $applyFlatStates<T extends LexicalNode>(
  node: T,
  serializedNode: {readonly [key: string]: unknown},
  flatStates: readonly AnyStateConfig[],
): T {
  let self = node;
  for (let i = 0; i < flatStates.length; i++) {
    const stateConfig = flatStates[i];
    // A bare read, as a schema property gets — but a *presence* test rather
    // than a guard on the read, and the one place in this walk where absent
    // and default are different answers. A flat state may arrive at the top
    // level or inside the nested `$` blob, which `$updateStateFromJSON`
    // applied before this ran: parsing an absent key to its default here
    // would overwrite the value the blob just supplied, so a document
    // spelling a state the nested way would lose it. Present at the top
    // level wins, absent leaves the blob's value alone.
    //
    // JSON carries no `undefined`, so `!== undefined` is that question for
    // anything `JSON.parse` produced. The names it cannot tell apart from an
    // absent key are `Object.prototype`'s, which `createSharedNodeState`
    // refuses as flat state keys.
    const raw = serializedNode[stateConfig.key];
    if (raw !== undefined) {
      const parsed = stateConfig.parse(raw);
      // Wrapped in an updater thunk so a parse that returns a function value
      // is stored verbatim instead of being invoked as an updater.
      self = $setState(self, stateConfig, () => parsed);
    }
  }
  return self;
}

/** The walk over a class's compiled setters: one property at a time. */
function $walkSetters<T extends LexicalNode>(
  node: T,
  serializedNode: {readonly [key: string]: unknown},
  setters: readonly CompiledSetter[],
): T {
  for (let i = 0; i < setters.length; i++) {
    const entry = setters[i];
    // A bare read. An absent property is `undefined`, which is exactly what
    // the schema maps to the property's default, so an own-key test would
    // only change the answer for a key the object *inherits* — and the one
    // prototype a serialized node has is `Object.prototype`, whose members
    // `nodeSchema` refuses as property names. `Object.prototype.hasOwnProperty
    // .call` is not inlined by V8 in this shape and measured ~13 ns per
    // property against a whole-node parse of ~17 ns, so it was most of the
    // cost of the walk it guarded.
    const parsed = entry.schema(serializedNode[entry.key]);
    if (entry.kind === 'ownField') {
      // `node` is writable already — the walk is only ever reached from
      // getWritable() or from a node this update constructed — so this is the
      // whole of applying the property.
      //
      // The table is reached with hasOwnKey, as the codegen's emitted lookup
      // is (`v in TABLE ? TABLE[v] : <default>` over a null-prototype table).
      // The schema has already reduced the value to its own domain, but that
      // domain can be wider than the table's keys — `withField(stringValue(),
      // {setterTable})` admits any string — and a bare lookup would then resolve
      // `'toString'` to Object.prototype's method and store *that* in the
      // field. A genuine miss still yields `undefined`, exactly as the bare
      // lookup did.
      ownFieldRecord(node)[entry.field] =
        entry.setterTable === undefined
          ? parsed
          : hasOwnKey(entry.setterTable, parsed as string)
            ? entry.setterTable[parsed as string]
            : // The stored form of the schema's *default*, not `undefined`: a
              // miss means the parse landed on a domain member the table has
              // no stored form for, and writing `undefined` put a value into a
              // typed field that the field's type does not admit — and then
              // dropped the property on the next export. The generated parser
              // falls back to exactly this (`... : 0` for TextNode's `mode`),
              // so writing anything else made the two disagree.
              setterDefault(entry);
    } else {
      // The return is not read. A setter's own `getWritable()` hands back the
      // node it was called on, since that node is already writable, so
      // following the return only ever reassigned the node to itself — and a
      // `void` setter had to be given a meaning ("unchanged") it never
      // needed. The `ownField` branch above has always assumed exactly this,
      // writing the field with no getWritable() of its own.
      entry.setter.call(node, parsed);
    }
  }
  return node;
}

/** @internal */
export function getStaticNodeConfig(
  klass: Klass<LexicalNode>,
): OwnStaticNodeConfig {
  return getNodeClassRecord(klass).config;
}

/**
 * Derive everything this class needs once: read its `$config()`, inject the
 * statics it did not declare, then compile its accessor tables.
 */
function buildNodeClassRecord(klass: Klass<LexicalNode>): NodeClassRecord {
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
  const record: NodeClassRecord = {
    compiled: undefined,
    composed: undefined,
    config: {
      declaresOwnConfig: hasOwnKey(
        klass.prototype as unknown as object,
        PROTOTYPE_CONFIG_METHOD,
      ),
      klass,
      ownNodeConfig,
      ownNodeType,
    },
    ownFieldsValidated: false,
  };
  // Cached before compiling, because compileSetters walks this class chain
  // (which includes klass) and re-enters this cache, which must hit rather
  // than recurse.
  NODE_CLASS_CACHE.set(klass, record);
  // Compiled eagerly rather than on first export/import so that a schema
  // naming an accessor the class does not have — or a `$config` naming
  // generated code that is not its own — fails while the class is being
  // registered, where the error names the class that is misconfigured, and
  // not later, out of an autosave or a copy handler.
  //
  // Everything that can throw is inside the try, injection included: that is
  // where the DEV clone-arity invariant lives. Dropping the record on the way
  // out is what keeps the error attributable — without it a second
  // createEditor() finds the cached record, never reaches this block again,
  // and registers the broken class in silence, leaving the throw to whichever
  // serialization call happens to come first.
  //
  // Injection goes last within the try because a class cannot be un-mutated:
  // nothing compiled above reads a synthesized static (compileSetters and
  // compileGetters resolve names off `klass.prototype` and walk the config
  // chain, never `klass.getType` or `klass.clone`), so ordering it here leaves
  // the class untouched on every failure path rather than half-registered.
  try {
    const setters = compileSetters(klass);
    const getters = compileGetters(klass);
    const composed = getComposedSchema(klass);
    // Built here, once per class, from the class's own composed schema: the
    // generated module reads its lookup tables from these schemas rather
    // than carrying copies, so a subclass that inherits the code runs it
    // over its own tables.
    const generated = resolveGenerated(klass, ownNodeConfig, {
      getters,
      setters,
    });
    record.compiled = {
      // Non-flat states live under NODE_STATE_KEY and are applied by
      // $updateStateFromJSON; these are the ones serialized as top-level
      // properties alongside the schema's.
      flatStates: composed.flatStates,
      generated: generated === null ? null : generated(composed.fields),
      getters,
      isCompactDefault: compactDefaultTest(getters),
      setters,
    };
    injectSynthesizedStatics(klass, isAbstract, ownNodeType, ownNodeConfig);
    // Not gated on `isAbstract`: an abstract base that declares schema fields
    // stores them on every subclass instance, so its clone has to carry them
    // too.
    injectSynthesizedAfterCloneFrom(klass);
    injectDeclaredIsInline(klass, ownNodeConfig);
  } catch (error) {
    NODE_CLASS_CACHE.delete(klass);
    throw error;
  }
  return record;
}

function synthesizedIsInlineTrue(): boolean {
  return true;
}
function synthesizedIsInlineFalse(): boolean {
  return false;
}

/**
 * Whether `isInline` (an `isInline` method found on a prototype) was
 * synthesized from a `$config({inline})` declaration.
 *
 * @internal
 */
export function isSynthesizedIsInline(isInline: unknown): boolean {
  return (
    isInline === synthesizedIsInlineTrue ||
    isInline === synthesizedIsInlineFalse
  );
}

/**
 * A class that declares `$config({inline})` and does not write its own
 * `isInline()` gets one returning the declaration, so classes that declare
 * nothing run exactly the code they ran before (ElementNode.isInline is
 * unchanged).
 */
function injectDeclaredIsInline(
  klass: Klass<LexicalNode>,
  ownNodeConfig:
    | undefined
    | StaticNodeConfigValue<LexicalNode, string | symbol>,
): void {
  if (
    !ownNodeConfig ||
    ownNodeConfig.inline === undefined ||
    !hasOwnKey(klass.prototype as unknown as object, PROTOTYPE_CONFIG_METHOD) ||
    Object.prototype.hasOwnProperty.call(klass.prototype, 'isInline')
  ) {
    return;
  }
  Object.defineProperty(klass.prototype, 'isInline', {
    configurable: true,
    value: ownNodeConfig.inline
      ? synthesizedIsInlineTrue
      : synthesizedIsInlineFalse,
    writable: true,
  });
}

/**
 * Give a concrete node class the statics it did not define for itself:
 * `getType`, `clone`, `importJSON` and `importDOM`, each derived from what its
 * `$config()` declared. A class that defines its own keeps it.
 */
function injectSynthesizedStatics(
  klass: Klass<LexicalNode>,
  isAbstract: boolean,
  ownNodeType: undefined | string,
  ownNodeConfig:
    | undefined
    | StaticNodeConfigValue<LexicalNode, string | symbol>,
): void {
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
      // Brand the closure so buildNodeClassRecord can recognize it and avoid
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
      klass.importJSON =
        (ownNodeConfig && ownNodeConfig.$importJSON) ||
        synthesizeImportJSON(klass);
    }
    if (!hasOwnStaticMethod(klass, 'importDOM') && ownNodeConfig) {
      const {importDOM} = ownNodeConfig;
      if (importDOM) {
        klass.importDOM = () => importDOM;
      }
    }
    // Inject a delegated getTextContentSize if only getTextContent is overridden
    const proto = klass.prototype;
    if (
      hasOwnKey(proto, 'getTextContent') &&
      !hasOwnKey(proto, 'getTextContentSize')
    ) {
      klass.prototype.getTextContentSize =
        LexicalNode.prototype.getTextContentSize;
    }
  }
}

/**
 * The node fields a schema names, in either direction.
 *
 * Both directions, and the *declared* field rather than the one
 * {@link resolveGetterAccessor} resolves to: which accessor serialization uses
 * is a question about this class's methods, and a subclass that overrides
 * `getStyle()` still stores its value in `__style`. A clone carries storage, so
 * it wants every field name the schema knows, whichever direction named it and
 * whether or not an override sends the serialization through a method instead.
 *
 * A property with no `field` at all — declared through accessor methods on both
 * sides — names no storage here, and is left to the class (see
 * {@link injectSynthesizedAfterCloneFrom}).
 */
function schemaFieldNames(schema: AnySerializationSchema): readonly string[] {
  const names: string[] = [];
  for (const accessor of [schema.getter, schema.setter]) {
    if (
      isSchemaField(accessor) &&
      // Rejected on both accessor paths for the same reason: it names the
      // prototype rather than a field, so copying it would re-parent the clone.
      accessor.field !== '__proto__' &&
      !names.includes(accessor.field)
    ) {
      names.push(accessor.field);
    }
  }
  return names;
}

/**
 * Give each class in this one's chain the `afterCloneFrom` its schema implies,
 * unless it wrote one for itself.
 *
 * A schema field is persisted state, so it has to survive
 * {@link $cloneWithProperties} — the clone `getWritable()` makes on the first
 * write of every update — or the node loses it on the next edit rather than
 * failing anywhere. Declaring the field is already saying so, so the copy is
 * derived from the same declaration `exportJSON` and `updateFromJSON` come
 * from rather than written a third time.
 *
 * Per declaring class, not per registered class: each class copies the fields
 * its own `$config` declared and delegates the rest to its superclass, which is
 * what a hand-written `afterCloneFrom` does with its `super` call, and it means
 * a base class shared by several subclasses is fixed up once. A field an
 * ancestor declares too is left to that ancestor — see
 * {@link ownSchemaFields} — so a class that only re-declares inherited
 * properties gets no method of its own at all.
 *
 * A class that defines its own `afterCloneFrom` keeps it and is trusted with
 * its own fields, the same rule the synthesized statics follow. That is what
 * lets `ElementNode` — whose clone also has to carry `__first`/`__last`/`__size`
 * and the slot bookkeeping, none of which any schema describes — keep a
 * hand-written method, and it is why {@link $cloneWithProperties} still checks
 * that an override called `super`.
 */
function injectSynthesizedAfterCloneFrom(klass: Klass<LexicalNode>): void {
  for (const {klass: currentKlass, ownNodeConfig} of iterStaticNodeConfigChain(
    klass,
  )) {
    const prototype = currentKlass.prototype as unknown as object;
    if (hasOwnKey(prototype, 'afterCloneFrom')) {
      // Hand-written, or synthesized by an earlier registration.
      continue;
    }
    // Registration is not idempotent for the question a code generator asks —
    // "does this class own an `afterCloneFrom`, or would it take a synthesized
    // one" — because after the first registration every class in the chain
    // owns one either way. Marking what this installs is what keeps the two
    // apart; see `declaresOwnAfterCloneFrom`.
    // From this class's own composition rather than the registered subclass's,
    // so what it copies does not depend on which class was registered first: a
    // subclass that re-declares an inherited field owns that field in its own
    // composition and in every subclass's, but the ancestor still owns it in
    // the composition that has no such subclass in it.
    const fields = ownSchemaFields(currentKlass);
    if (fields.length === 0) {
      // Nothing of its own to carry — including every class with no `$config`
      // of its own, which reports its ancestor's fields but declares none.
      continue;
    }
    // Resolved when the clone runs, not now: a base class in this chain may
    // still be waiting for its own synthesized method, and registration order
    // is whatever order the classes were passed to `createEditor`.
    const superPrototype = Object.getPrototypeOf(prototype) as LexicalNode;
    // The straight-line function the build generated for this class when it
    // has one, and otherwise a walk of the field names — the same pairing as
    // the export and import directions, for the same reason: the fields are
    // fixed once the schema is written, and a keyed store whose key changes
    // every iteration is what generating the code removes.
    // The class's own generated code, bound to its own schema by its record
    // — the record this registration is building when `currentKlass` is the
    // class being registered, and otherwise the ancestor's, built here if it
    // has not been.
    const generated =
      ownNodeConfig && ownNodeConfig.generated !== undefined
        ? getCompiled(getNodeClassRecord(currentKlass)).generated
        : null;
    const copyFields =
      (generated !== null && generated.afterCloneFrom) ||
      ((node: LexicalNode, prevNode: LexicalNode): void => {
        const self = node as unknown as Record<string, unknown>;
        const prev = prevNode as unknown as Record<string, unknown>;
        for (let i = 0; i < fields.length; i++) {
          const field = fields[i];
          self[field] = prev[field];
        }
      });
    (
      prototype as {afterCloneFrom: LexicalNode['afterCloneFrom']}
    ).afterCloneFrom = function (
      this: LexicalNode,
      prevNode: LexicalNode,
    ): void {
      superPrototype.afterCloneFrom.call(this, prevNode);
      copyFields(this, prevNode);
    };
    (
      prototype as {afterCloneFrom: {[SYNTHESIZED_AFTER_CLONE_FROM]?: true}}
    ).afterCloneFrom[SYNTHESIZED_AFTER_CLONE_FROM] = true;
  }
}

/**
 * The key marking an `afterCloneFrom` this module synthesized, as opposed to
 * one the class wrote.
 *
 * A string rather than a symbol: a `Symbol()` call at module scope is a side
 * effect no bundler will drop, and this module is one every editor imports.
 */
const SYNTHESIZED_AFTER_CLONE_FROM = '__lexicalSynthesizedAfterCloneFrom';

/**
 * Whether `klass` wrote its own `afterCloneFrom`, rather than taking the one
 * its schema implies.
 *
 * For a code generator deciding whether to *attach* the copy half: a class that
 * wrote its own keeps it, so a generated function handed to it through
 * `$config` would be shipped and never called. The function is still worth
 * generating — `ElementNode` and `CodeNode` import and call it, so what they
 * write by hand is only the fields no schema describes — it is the attachment
 * that is pointless. Asked of the class itself rather than of the prototype,
 * because after one registration every class in a chain has an own
 * `afterCloneFrom` and only the marker says which kind.
 *
 * @internal
 */
export function declaresOwnAfterCloneFrom(klass: Klass<LexicalNode>): boolean {
  const prototype = klass.prototype as unknown as {
    afterCloneFrom?: {[SYNTHESIZED_AFTER_CLONE_FROM]?: true};
  };
  if (!hasOwnKey(prototype, 'afterCloneFrom')) {
    return false;
  }
  const own = prototype.afterCloneFrom;
  return own === undefined || own[SYNTHESIZED_AFTER_CLONE_FROM] !== true;
}

/**
 * The node fields a class's own `$config` declares, deduplicated.
 *
 * Raw, in the sense that it says nothing about which class ends up carrying
 * each one: {@link ownSchemaFields} is what answers that.
 */
function declaredSchemaFields(klass: Klass<LexicalNode>): readonly string[] {
  const {declaredBy, fieldsBaseFirst} = getComposedSchema(klass);
  const fields: string[] = [];
  for (const [key, schema] of fieldsBaseFirst) {
    if (declaredBy.get(key) !== klass) {
      continue;
    }
    for (const field of schemaFieldNames(schema)) {
      if (!fields.includes(field)) {
        // Two properties may name one field (a field exported under a second
        // key), and it is copied once.
        fields.push(field);
      }
    }
  }
  return fields;
}

/**
 * The node fields a class carries across a clone: the ones its own `$config`
 * declares, less any an ancestor declares too.
 *
 * A class re-declares an inherited property to change how it is *serialized* —
 * `TabNode` restates `text`, `detail` and `mode` for their accessors and
 * narrower domains — which makes it the owner of that key in its own
 * composition and in every subclass's. Where it is *stored* does not change,
 * though, and the ancestor's `afterCloneFrom` already ran by then and is
 * responsible for the fields it declares, so assigning them a second time
 * writes the same values again for nothing.
 *
 * The ancestor's declarations are what is subtracted, not the fields it
 * actually assigns, and the two are the same set transitively: an ancestor
 * that skipped a field skipped it because *its* own ancestor declares it, and
 * that class is in this chain too.
 *
 * Shared with the codegen in `scripts/shared/generateNodeJSON.mjs`, which emits
 * the straight-line form of exactly this list, so the two cannot disagree about
 * which class carries which field.
 *
 * @internal
 */
export function ownSchemaFields(klass: Klass<LexicalNode>): readonly string[] {
  const declared = declaredSchemaFields(klass);
  if (declared.length === 0) {
    return declared;
  }
  const inherited = new Set<string>();
  for (const {klass: currentKlass} of iterStaticNodeConfigChain(klass)) {
    if (currentKlass !== klass) {
      for (const field of declaredSchemaFields(currentKlass)) {
        inherited.add(field);
      }
    }
  }
  return inherited.size === 0
    ? declared
    : declared.filter(field => !inherited.has(field));
}

/**
 * The `importJSON` a class gets when it declares none: build the node, then
 * apply the serialized properties to it. A generated parser, when the class
 * has one, is reached through {@link $applyJSONSetters} the way every other
 * path reaches it.
 *
 * {@link $applyImportJSON} is the base `updateFromJSON` minus a `getWritable()`
 * the fresh node does not need, so it may only stand in for that method when
 * the node has not overridden it. A class is free to declare a schema *and* an
 * `updateFromJSON` — to migrate an older payload, or to apply something the
 * schema cannot describe — and calling the schema directly would drop that work
 * on the import path while leaving it in place everywhere else.
 *
 * The node `$create` returns is what is asked, not `klass`: a replacement
 * registered for this type is a different class, with its own override or lack
 * of one.
 */
function synthesizeImportJSON(
  klass: Klass<LexicalNode>,
): (
  serializedNode: SerializedPartial<SerializedLexicalNode> &
    Record<string, unknown>,
) => LexicalNode {
  return serializedNode => {
    const node = $create(klass);
    return node.updateFromJSON === LexicalNode.prototype.updateFromJSON
      ? $applyImportJSON(node, serializedNode)
      : node.updateFromJSON(serializedNode);
  };
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
    // A class that declared no `$config()` of its own contributes nothing to
    // the chain: what `getStaticNodeConfig` resolved for it is its ancestor's
    // config, and the ancestor is the next link, which yields that config
    // itself. Yielding it here too would attribute the ancestor's `json`,
    // `$transform`, `stateConfigs` and `slots` to the subclass and present
    // them twice — and a `$transform` written inline is a fresh closure per
    // `$config()` call, so the `Set` that collects them cannot tell the two
    // copies apart and the transform runs twice per node.
    //
    // `extends` goes with it, which is also what keeps the walk from jumping
    // to the ancestor's parent and skipping the ancestor.
    const declared = config.declaresOwnConfig;
    yield declared ? config : {...config, ownNodeConfig: undefined};
    current =
      (declared && config.ownNodeConfig && config.ownNodeConfig.extends) ||
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
 * This directly constructs the final `withKlass` node type, skipping the
 * intermediate steps where each replaced node would be created and then
 * immediately discarded — once per configured replacement of that node.
 *
 * A deprecated `replace` given without a `withKlass` is the one case that
 * cannot be resolved ahead of construction, since only its `with` function
 * knows what to build. Such a replacement is still applied, the old way, to
 * the node this constructs.
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
  const node = new registeredNode.klass() as T;
  // The resolve above follows `withKlass` as far as it goes, so a `replace`
  // still set on the node it stopped at has no `withKlass` to follow: it is a
  // deprecated one, and its `with` can only be given a constructed node.
  return registeredNode.replace === null
    ? node
    : ($applyNodeReplacement(node) as T);
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
