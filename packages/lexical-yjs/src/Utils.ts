/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {BaseBinding, Binding, YjsNode} from '.';

import invariant from '@lexical/internal/invariant';
import {
  $getNodeByKey,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $getWritableNodeState,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isRootNode,
  $isTextNode,
  $removeSlot,
  $setSlot,
  createEditor,
  type DecoratorNode,
  type EditorState,
  type ElementNode,
  getDeclaredSlots,
  isLexicalEditor,
  type LexicalNode,
  type NodeKey,
  type NodeMap,
  type RangeSelection,
  type TextNode,
} from 'lexical';
import {Doc, Map as YMap, XmlElement, XmlText} from 'yjs';

import {isBindingV1} from './Bindings';
import {
  $createCollabDecoratorNode,
  CollabDecoratorNode,
} from './CollabDecoratorNode';
import {$createCollabElementNode, CollabElementNode} from './CollabElementNode';
import {
  $createCollabLineBreakNode,
  type CollabLineBreakNode,
} from './CollabLineBreakNode';
import {$createCollabTextNode, CollabTextNode} from './CollabTextNode';

// Mirrors the file-local alias used in CollabElementNode / CollabDecoratorNode.
type IntentionallyMarkedAsDirtyElement = boolean;

// @experimental named-slots. Slots are a structural channel separate from the
// linked-list children (excluded from the auto property->attribute path via the
// sets below) and live under this reserved attribute key. The key reuses the
// host's `__slots` field name on purpose: '$' can't prefix it ('$' breaks
// XmlElement.toDOM), and node properties sync under their `__`-prefixed name, so
// reusing `__slots` lets the single `__slots` exclusion below stand in for both
// the field (the Map never auto-syncs as a property) and the channel (its Y.Map
// is never restored as a property). A user field literally named `slots` (no
// `__`) keeps syncing — only the framework's `__slots` is reserved.
export const SLOTS_ATTR_KEY = '__slots';

const baseExcludedProperties = new Set<string>([
  '__key',
  '__parent',
  '__next',
  '__prev',
  '__state',
  '__slotHost',
  // `__slots` lives on the base LexicalNode (an ElementNode or DecoratorNode can
  // host slots), so it is excluded for every node type, not just elements —
  // otherwise a decorator host's `__slots` Map leaks into the property->attribute
  // sync. It is also `SLOTS_ATTR_KEY` (the slots channel reuses the field name),
  // so this one entry doubles as the channel reservation: the channel's Y.Map is
  // never restored as a node property in either sync version.
  '__slots',
]);
const elementExcludedProperties = new Set<string>([
  '__first',
  '__last',
  '__size',
]);
const rootExcludedProperties = new Set<string>([
  '__cachedText',
  '__textFormat',
  '__textStyle',
]);
const textExcludedProperties = new Set<string>(['__text']);

// @experimental named-slots. Writes the slots Y.Map onto a host shared type.
// yjs types an XmlElement attribute value as string (its default KV), so a
// nested Y.Map value needs a cast; isolated here — the single, encapsulated
// cast — instead of repeated at each host call. Generic over the Y.Map's value
// type because `Y.Map<T>` is invariant, so the V1 (`YMap<unknown>`) and V2
// (`YMap<XmlElement>`) callers can't share a single non-generic parameter.
export function setSlotsAttr<T>(
  sharedType: XmlText | XmlElement,
  slotsY: YMap<T>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharedType.setAttribute(SLOTS_ATTR_KEY, slotsY as any);
}

// @experimental named-slots. Mirrors the reserved-name invariant in core's
// $setSlot. Slot names arrive peer-controlled through the slots Y.Map, so a
// reserved name must be skipped during reconcile rather than allowed to reach
// $setSlot, whose invariant would throw inside the observer editor.update.
export function isReservedSlotName(name: string): boolean {
  return name === '__proto__' || name === 'constructor' || name === 'prototype';
}

// @experimental named-slots. Mirrors the value invariant in core's $setSlot (a
// slot value is any non-inline ElementNode or DecoratorNode — the slot link
// itself is the shadow boundary), so a peer-controlled value can be validated
// during reconcile rather than allowed to reach $setSlot, whose invariant
// would throw inside the observer editor.update.
export function $isSlotValueNode(
  node: LexicalNode,
): node is ElementNode | DecoratorNode<unknown> {
  return ($isElementNode(node) || $isDecoratorNode(node)) && !node.isInline();
}

function isExcludedProperty(
  name: string,
  node: LexicalNode,
  binding: BaseBinding,
): boolean {
  if (
    baseExcludedProperties.has(name) ||
    typeof (node as unknown as Record<string, unknown>)[name] === 'function'
  ) {
    return true;
  }

  if ($isTextNode(node)) {
    if (textExcludedProperties.has(name)) {
      return true;
    }
  } else if ($isElementNode(node)) {
    if (
      elementExcludedProperties.has(name) ||
      ($isRootNode(node) && rootExcludedProperties.has(name))
    ) {
      return true;
    }
  }

  const nodeKlass = node.constructor;
  const excludedProperties = binding.excludedProperties.get(nodeKlass);
  return excludedProperties != null && excludedProperties.has(name);
}

export function initializeNodeProperties(binding: BaseBinding): void {
  const {editor, nodeProperties} = binding;
  editor.update(() => {
    editor._nodes.forEach(nodeInfo => {
      const node = new nodeInfo.klass();
      const defaultProperties: {[property: string]: unknown} = {};
      for (const [property, value] of Object.entries(node)) {
        if (!isExcludedProperty(property, node, binding)) {
          defaultProperties[property] = value;
        }
      }
      nodeProperties.set(node.__type, Object.freeze(defaultProperties));
    });
  });
}

export function getDefaultNodeProperties(
  node: LexicalNode,
  binding: BaseBinding,
): {[property: string]: unknown} {
  const type = node.__type;
  const {nodeProperties} = binding;
  const properties = nodeProperties.get(type);
  invariant(
    properties !== undefined,
    'Node properties for %s not initialized for sync',
    type,
  );
  return properties;
}

export function getIndexOfYjsNode(
  yjsParentNode: YjsNode,
  yjsNode: YjsNode,
): number {
  let node = yjsParentNode.firstChild;
  let i = -1;

  if (node === null) {
    return -1;
  }

  do {
    i++;

    if (node === yjsNode) {
      return i;
    }

    // @ts-expect-error Sibling exists but type is not available from YJS.
    node = node.nextSibling;

    if (node === null) {
      return -1;
    }
  } while (node !== null);

  return i;
}

// @experimental named-slots. Syncs one slot value's content (lexical -> yjs),
// dispatching on the collab/lexical node pair. Shared by element and decorator
// hosts; the CollabTextNode branch is inert for a decorator host, where a slot
// value is always a shadow-root element or non-inline decorator, never text.
export function $syncSlotContentFromLexical(
  binding: Binding,
  slotCollab:
    | CollabElementNode
    | CollabTextNode
    | CollabDecoratorNode
    | CollabLineBreakNode,
  slotNode: LexicalNode,
  prevNodeMap: null | NodeMap,
  dirtyElements: null | Map<NodeKey, boolean>,
  dirtyLeaves: null | Set<NodeKey>,
): void {
  if (slotCollab instanceof CollabElementNode && $isElementNode(slotNode)) {
    slotCollab.syncPropertiesFromLexical(binding, slotNode, prevNodeMap);
    slotCollab.syncChildrenFromLexical(
      binding,
      slotNode,
      prevNodeMap,
      dirtyElements,
      dirtyLeaves,
    );
    slotCollab.syncSlotsFromLexical(
      binding,
      slotNode,
      prevNodeMap,
      dirtyElements,
      dirtyLeaves,
    );
  } else if (slotCollab instanceof CollabTextNode && $isTextNode(slotNode)) {
    slotCollab.syncPropertiesAndTextFromLexical(binding, slotNode, prevNodeMap);
  } else if (
    slotCollab instanceof CollabDecoratorNode &&
    $isDecoratorNode(slotNode)
  ) {
    slotCollab.syncPropertiesFromLexical(binding, slotNode, prevNodeMap);
    slotCollab.syncSlotsFromLexical(
      binding,
      slotNode,
      prevNodeMap,
      dirtyElements,
      dirtyLeaves,
    );
  }
}

// @experimental named-slots. Seeds a freshly created host's slots Y.Map. Both
// element (xmlText) and decorator (xmlElem) hosts reach this through the create
// path, where no matched key exists for syncSlotsFromLexical to recurse through,
// so each slot value's collab node is built and registered here.
function $seedHostSlots(
  binding: Binding,
  lexicalNode: LexicalNode,
  hostCollab: CollabElementNode | CollabDecoratorNode,
  sharedType: XmlText | XmlElement,
): void {
  const slotNames = $getSlotNames(lexicalNode);
  // A class that declares its slots opts into eager map creation: attaching
  // the (possibly empty) Y.Map while the host itself is being created makes
  // every later set — including each name's first — an entry-level Y.Map
  // operation that merges per-key, instead of racing on attribute-level LWW
  // when two clients create the map concurrently.
  const declaresSlots = getDeclaredSlots(lexicalNode.constructor).length > 0;
  if (slotNames.length === 0 && !declaresSlots) {
    return;
  }
  const slotsY = new YMap();
  let hasSlot = false;
  for (const name of slotNames) {
    const slotNode = $getSlot(lexicalNode, name);
    if (slotNode === null) {
      continue;
    }
    const slotCollab = $createCollabNodeFromLexicalNode(
      binding,
      slotNode,
      hostCollab,
    );
    binding.collabNodeMap.set(slotNode.__key, slotCollab);
    slotsY.set(name, slotCollab.getSharedType());
    hasSlot = true;
  }
  if (hasSlot || declaresSlots) {
    setSlotsAttr(sharedType, slotsY);
  }
}

export function $createCollabNodeFromLexicalNode(
  binding: Binding,
  lexicalNode: LexicalNode,
  // A slot value (element or decorator) can be parented to a decorator host, so
  // the parent is not necessarily an element.
  parent: CollabElementNode | CollabDecoratorNode,
):
  | CollabElementNode
  | CollabTextNode
  | CollabLineBreakNode
  | CollabDecoratorNode {
  const nodeType = lexicalNode.__type;
  let collabNode;

  if ($isElementNode(lexicalNode)) {
    const xmlText = new XmlText();
    collabNode = $createCollabElementNode(xmlText, parent, nodeType);
    collabNode.syncPropertiesFromLexical(binding, lexicalNode, null);
    collabNode.syncChildrenFromLexical(binding, lexicalNode, null, null, null);
    $seedHostSlots(binding, lexicalNode, collabNode, xmlText);
  } else if ($isTextNode(lexicalNode)) {
    // Text and linebreak nodes can never be named-slot values, so their parent
    // is always a collab element node.
    invariant(
      parent instanceof CollabElementNode,
      'Expected parent of a text node to be a collab element node',
    );
    // TODO create a token text node for token, segmented nodes.
    const map = new YMap();
    collabNode = $createCollabTextNode(
      map,
      lexicalNode.__text,
      parent,
      nodeType,
    );
    collabNode.syncPropertiesAndTextFromLexical(binding, lexicalNode, null);
  } else if ($isLineBreakNode(lexicalNode)) {
    invariant(
      parent instanceof CollabElementNode,
      'Expected parent of a linebreak node to be a collab element node',
    );
    const map = new YMap();
    map.set('__type', 'linebreak');
    collabNode = $createCollabLineBreakNode(map, parent);
  } else if ($isDecoratorNode(lexicalNode)) {
    const xmlElem = new XmlElement();
    collabNode = $createCollabDecoratorNode(xmlElem, parent, nodeType);
    collabNode.syncPropertiesFromLexical(binding, lexicalNode, null);
    $seedHostSlots(binding, lexicalNode, collabNode, xmlElem);
  } else {
    invariant(false, 'Expected text, element, decorator, or linebreak node');
  }

  collabNode._key = lexicalNode.__key;
  return collabNode;
}

export function getNodeTypeFromSharedType(
  sharedType: XmlText | YMap<unknown> | XmlElement,
): string | undefined {
  const type = sharedTypeGet(sharedType, '__type');
  invariant(
    typeof type === 'string' || typeof type === 'undefined',
    'Expected shared type to include type attribute',
  );
  return type;
}

// A decorator host stores its named slots as a `__slots` Y.Map attribute on its
// `_xmlElem`. A decorator may only parent a node that is genuinely one of its
// slot values; this confirms that relationship so the parent invariant below
// stays tight (a non-slot node mis-parented to a decorator is still rejected,
// and decorators have no children channel, so this is the only legitimate way a
// decorator becomes a parent).
function decoratorHostsSlotSharedType(
  parent: CollabDecoratorNode,
  sharedType: XmlText | YMap<unknown> | XmlElement,
): boolean {
  const slotsY = parent._xmlElem.getAttribute(SLOTS_ATTR_KEY) as unknown;
  if (!(slotsY instanceof YMap)) {
    return false;
  }
  for (const value of slotsY.values()) {
    if (value === sharedType) {
      return true;
    }
  }
  return false;
}

export function $getOrInitCollabNodeFromSharedType(
  binding: Binding,
  sharedType: XmlText | YMap<unknown> | XmlElement,
  parent?: CollabElementNode | CollabDecoratorNode,
):
  | CollabElementNode
  | CollabTextNode
  | CollabLineBreakNode
  | CollabDecoratorNode {
  const collabNode = sharedType._collabNode;

  if (collabNode === undefined) {
    const registeredNodes = binding.editor._nodes;
    const type = getNodeTypeFromSharedType(sharedType);
    invariant(
      typeof type === 'string',
      'Expected shared type to include type attribute',
    );
    const nodeInfo = registeredNodes.get(type);
    invariant(nodeInfo !== undefined, 'Node %s is not registered', type);

    const sharedParent = sharedType.parent;
    const targetParent =
      parent === undefined && sharedParent !== null
        ? $getOrInitCollabNodeFromSharedType(
            binding,
            sharedParent as XmlText | YMap<unknown> | XmlElement,
          )
        : parent || null;

    invariant(
      targetParent instanceof CollabElementNode ||
        (targetParent instanceof CollabDecoratorNode &&
          decoratorHostsSlotSharedType(targetParent, sharedType)),
      'Expected parent to be a collab element node, or a collab decorator node hosting this shared type as a named slot',
    );

    if (sharedType instanceof XmlText) {
      return $createCollabElementNode(sharedType, targetParent, type);
    } else if (sharedType instanceof YMap) {
      // Text and linebreak nodes can never be named-slot values (setSlot only
      // accepts non-inline elements/decorators), so their parent is always a
      // collab element node — a decorator parent here would be a bug.
      invariant(
        targetParent instanceof CollabElementNode,
        'Expected parent of a text or linebreak node to be a collab element node',
      );
      if (type === 'linebreak') {
        return $createCollabLineBreakNode(sharedType, targetParent);
      }
      return $createCollabTextNode(sharedType, '', targetParent, type);
    } else if (sharedType instanceof XmlElement) {
      return $createCollabDecoratorNode(sharedType, targetParent, type);
    }
  }

  return collabNode;
}

export function createLexicalNodeFromCollabNode(
  binding: Binding,
  collabNode:
    | CollabElementNode
    | CollabTextNode
    | CollabDecoratorNode
    | CollabLineBreakNode,
  parentKey: NodeKey | null,
): LexicalNode {
  const type = collabNode.getType();
  const registeredNodes = binding.editor._nodes;
  const nodeInfo = registeredNodes.get(type);
  invariant(nodeInfo !== undefined, 'Node %s is not registered', type);
  const lexicalNode:
    | DecoratorNode<unknown>
    | TextNode
    | ElementNode
    | LexicalNode = new nodeInfo.klass();
  lexicalNode.__parent = parentKey;
  collabNode._key = lexicalNode.__key;

  if (collabNode instanceof CollabElementNode) {
    const xmlText = collabNode._xmlText;
    collabNode.syncPropertiesFromYjs(binding, null);
    collabNode.applyChildrenYjsDelta(binding, xmlText.toDelta());
    collabNode.syncChildrenFromYjs(binding);
  } else if (collabNode instanceof CollabTextNode) {
    collabNode.syncPropertiesAndTextFromYjs(binding, null);
  } else if (collabNode instanceof CollabDecoratorNode) {
    collabNode.syncPropertiesFromYjs(binding, null);
    invariant(
      $isDecoratorNode(lexicalNode),
      'Expected a decorator node for a collab decorator node',
    );
    collabNode.syncSlotsFromYjs(binding, lexicalNode);
  }

  binding.collabNodeMap.set(lexicalNode.__key, collabNode);
  return lexicalNode;
}

export function $syncPropertiesFromYjs(
  binding: BaseBinding,
  sharedType:
    | XmlText
    | YMap<unknown>
    | XmlElement
    // v2
    | Record<string, unknown>,
  lexicalNode: LexicalNode,
  keysChanged: null | Set<string>,
): void {
  const properties =
    keysChanged === null
      ? sharedType instanceof YMap
        ? Array.from(sharedType.keys())
        : sharedType instanceof XmlText || sharedType instanceof XmlElement
          ? Object.keys(sharedType.getAttributes())
          : Object.keys(sharedType)
      : Array.from(keysChanged);
  let writableNode: LexicalNode | undefined;

  for (let i = 0; i < properties.length; i++) {
    const property = properties[i];
    if (isExcludedProperty(property, lexicalNode, binding)) {
      if (property === '__state' && isBindingV1(binding)) {
        if (!writableNode) {
          writableNode = lexicalNode.getWritable();
        }
        $syncNodeStateToLexical(sharedType, writableNode);
      }
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prevValue = (lexicalNode as any)[property];
    let nextValue = sharedTypeGet(sharedType, property);

    if (prevValue !== nextValue) {
      if (nextValue instanceof Doc) {
        const yjsDocMap = binding.docMap;

        if (prevValue instanceof Doc) {
          yjsDocMap.delete(prevValue.guid);
        }

        const key = nextValue.guid;
        yjsDocMap.set(key, nextValue);

        // If the node already constructed a nested editor (e.g. via
        // buildEditorFromExtensions in its constructor), reuse it so its
        // extensions and LexicalBuilder registration survive the sync.
        // Otherwise, fall back to a bare editor.
        if (isLexicalEditor(prevValue)) {
          prevValue._key = key;
          nextValue = prevValue;
        } else {
          const nestedEditor = createEditor();
          nestedEditor._key = key;
          nextValue = nestedEditor;
        }
      }

      if (writableNode === undefined) {
        writableNode = lexicalNode.getWritable();
      }

      // Generic property writer. `property` is never a read-only node field
      // here (e.g. `__type` is intrinsic and, being equal on both sides, is
      // filtered out by the `prevValue !== nextValue` guard above), so cast
      // through a mutable record to write it.
      (writableNode as unknown as Record<string, unknown>)[property] =
        nextValue;
    }
  }
}

function sharedTypeGet(
  sharedType: XmlText | YMap<unknown> | XmlElement | Record<string, unknown>,
  property: string,
): unknown {
  if (sharedType instanceof YMap) {
    return sharedType.get(property);
  } else if (
    sharedType instanceof XmlText ||
    sharedType instanceof XmlElement
  ) {
    return sharedType.getAttribute(property);
  } else {
    return sharedType[property];
  }
}

function sharedTypeSet(
  sharedType: XmlText | YMap<unknown> | XmlElement,
  property: string,
  nextValue: unknown,
): void {
  if (sharedType instanceof YMap) {
    sharedType.set(property, nextValue);
  } else {
    sharedType.setAttribute(property, nextValue as string);
  }
}

function $syncNodeStateToLexical(
  sharedType: XmlText | YMap<unknown> | XmlElement | Record<string, unknown>,
  lexicalNode: LexicalNode,
): void {
  const existingState = sharedTypeGet(sharedType, '__state');
  if (!(existingState instanceof YMap)) {
    return;
  }
  // This should only called when creating the node initially,
  // incremental updates to state come in through YMapEvent
  // with the __state as the target.
  $getWritableNodeState(lexicalNode).updateFromJSON(existingState.toJSON());
}

function syncNodeStateFromLexical(
  binding: Binding,
  sharedType: XmlText | YMap<unknown> | XmlElement,
  prevLexicalNode: null | LexicalNode,
  nextLexicalNode: LexicalNode,
): void {
  const nextState = nextLexicalNode.__state;
  // Reading from a shared type that hasn't been integrated into a doc yet
  // logs a "premature access" warning in yjs >= 13.6.10. When the shared
  // type is detached we know there cannot be any existing state.
  const existingState =
    sharedType.doc === null ? undefined : sharedTypeGet(sharedType, '__state');
  if (!nextState) {
    return;
  }
  const [unknown, known] = nextState.getInternalState();
  const prevState = prevLexicalNode && prevLexicalNode.__state;
  const stateMap: YMap<unknown> =
    existingState instanceof YMap ? existingState : new YMap();
  if (prevState === nextState) {
    return;
  }
  const [prevUnknown, prevKnown] =
    prevState && stateMap.doc
      ? prevState.getInternalState()
      : [undefined, new Map()];
  if (unknown) {
    for (const [k, v] of Object.entries(unknown)) {
      if (prevUnknown && v !== prevUnknown[k]) {
        stateMap.set(k, v);
      }
    }
  }
  for (const [stateConfig, v] of known) {
    if (prevKnown.get(stateConfig) !== v) {
      stateMap.set(stateConfig.key, stateConfig.unparse(v));
    }
  }
  if (!existingState) {
    sharedTypeSet(sharedType, '__state', stateMap);
  }
}

export function syncPropertiesFromLexical(
  binding: Binding,
  sharedType: XmlText | YMap<unknown> | XmlElement,
  prevLexicalNode: null | LexicalNode,
  nextLexicalNode: LexicalNode,
): void {
  const properties = Object.keys(
    getDefaultNodeProperties(nextLexicalNode, binding),
  );

  const EditorClass = binding.editor.constructor;

  syncNodeStateFromLexical(
    binding,
    sharedType,
    prevLexicalNode,
    nextLexicalNode,
  );
  for (let i = 0; i < properties.length; i++) {
    const property = properties[i];
    const prevValue =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prevLexicalNode === null ? undefined : (prevLexicalNode as any)[property];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let nextValue = (nextLexicalNode as any)[property];

    if (prevValue !== nextValue) {
      if (nextValue instanceof EditorClass) {
        const yjsDocMap = binding.docMap;
        let prevDoc;

        if (prevValue instanceof EditorClass) {
          const prevKey = prevValue._key;
          prevDoc = yjsDocMap.get(prevKey);
          yjsDocMap.delete(prevKey);
        }

        // If we already have a document, use it.
        const doc = prevDoc || new Doc();
        const key = doc.guid;
        nextValue._key = key;
        yjsDocMap.set(key, doc);
        nextValue = doc;
        // Mark the node dirty as we've assigned a new key to it
        binding.editor.update(() => {
          nextLexicalNode.markDirty();
        });
      }

      sharedTypeSet(sharedType, property, nextValue);
    }
  }
}

export function spliceString(
  str: string,
  index: number,
  delCount: number,
  newText: string,
): string {
  return str.slice(0, index) + newText + str.slice(index + delCount);
}

export function getPositionFromElementAndOffset(
  node: CollabElementNode,
  offset: number,
  boundaryIsEdge: boolean,
): {
  length: number;
  node:
    | CollabElementNode
    | CollabTextNode
    | CollabDecoratorNode
    | CollabLineBreakNode
    | null;
  nodeIndex: number;
  offset: number;
} {
  let index = 0;
  let i = 0;
  const children = node._children;
  const childrenLength = children.length;

  for (; i < childrenLength; i++) {
    const child = children[i];
    const childOffset = index;
    const size = child.getSize();
    index += size;
    const exceedsBoundary = boundaryIsEdge ? index >= offset : index > offset;

    if (exceedsBoundary && child instanceof CollabTextNode) {
      let textOffset = offset - childOffset - 1;

      if (textOffset < 0) {
        textOffset = 0;
      }

      const diffLength = index - offset;
      return {
        length: diffLength,
        node: child,
        nodeIndex: i,
        offset: textOffset,
      };
    }

    if (index > offset) {
      return {
        length: 0,
        node: child,
        nodeIndex: i,
        offset: childOffset,
      };
    } else if (i === childrenLength - 1) {
      return {
        length: 0,
        node: null,
        nodeIndex: i + 1,
        offset: childOffset + 1,
      };
    }
  }

  return {
    length: 0,
    node: null,
    nodeIndex: 0,
    offset: 0,
  };
}

export function doesSelectionNeedRecovering(
  selection: RangeSelection,
): boolean {
  const anchor = selection.anchor;
  const focus = selection.focus;
  let recoveryNeeded = false;

  try {
    const anchorNode = anchor.getNode();
    const focusNode = focus.getNode();

    if (
      // We might have removed a node that no longer exists
      !anchorNode.isAttached() ||
      !focusNode.isAttached() ||
      // If we've split a node, then the offset might not be right
      ($isTextNode(anchorNode) &&
        anchor.offset > anchorNode.getTextContentSize()) ||
      ($isTextNode(focusNode) && focus.offset > focusNode.getTextContentSize())
    ) {
      recoveryNeeded = true;
    }
  } catch (_e) {
    // Sometimes checking nor a node via getNode might trigger
    // an error, so we need recovery then too.
    recoveryNeeded = true;
  }

  return recoveryNeeded;
}

export function syncWithTransaction(
  binding: BaseBinding,
  fn: () => void,
): void {
  binding.doc.transact(fn, binding);
}

export function $moveSelectionToPreviousNode(
  anchorNodeKey: string,
  currentEditorState: EditorState,
) {
  const anchorNode = currentEditorState._nodeMap.get(anchorNodeKey);
  if (!anchorNode) {
    $getRoot().selectStart();
    return;
  }
  // Get previous node
  const prevNodeKey = anchorNode.__prev;
  let prevNode: LexicalNode | null = null;
  if (prevNodeKey) {
    prevNode = $getNodeByKey(prevNodeKey);
  }

  // If previous node not found, get parent node
  if (prevNode === null && anchorNode.__parent !== null) {
    prevNode = $getNodeByKey(anchorNode.__parent);
  }
  if (prevNode === null) {
    $getRoot().selectStart();
    return;
  }

  if (prevNode !== null && prevNode.isAttached()) {
    prevNode.selectEnd();
    return;
  } else {
    // If the found node is also deleted, select the next one
    $moveSelectionToPreviousNode(prevNode.__key, currentEditorState);
  }
}

// Slot reconcile shared by CollabElementNode + CollabDecoratorNode. The two
// paths differ only in where the slot map rides — the element host keeps it
// on `_xmlText`, the decorator host on `_xmlElem` — and in the lexical
// host's type. The reconcile logic itself (drop slots missing from yjs, set
// slots present in yjs) is identical, so keeping it in one place avoids the
// risk of one path drifting from the other.
//
// `slotsParent` is the yjs node carrying the `__slots` Y.Map attribute (the
// host's `_xmlText` for element hosts, `_xmlElem` for decorator hosts).
// `ownerCollab` is the collab host that owns the slot map; it's passed to
// `$getOrInitCollabNodeFromSharedType` so a newly materialized slot collab
// node is parented correctly.
export function $syncSlotsFromYjsShared(
  binding: Binding,
  slotsParent: XmlText | XmlElement,
  lexicalNode: ElementNode | DecoratorNode<unknown>,
  ownerCollab: CollabElementNode | CollabDecoratorNode,
): void {
  const slotsY = slotsParent.getAttribute(SLOTS_ATTR_KEY) as unknown;
  const yNames =
    slotsY instanceof YMap ? new Set(slotsY.keys()) : new Set<string>();

  for (const name of $getSlotNames(lexicalNode)) {
    if (!yNames.has(name)) {
      // Mirror children removal (splice -> destroy): drop the departing slot's
      // collab node so its entry doesn't dangle in binding.collabNodeMap. The
      // slot's shared type is already gone from the Y.Map here, so reach the
      // collab node through the lexical key instead of the shared type.
      const slotNode = $getSlot(lexicalNode, name);
      if (slotNode !== null) {
        const slotCollab = binding.collabNodeMap.get(slotNode.__key);
        if (slotCollab !== undefined) {
          slotCollab.destroy(binding);
        }
      }
      $removeSlot(lexicalNode, name);
    }
  }

  if (!(slotsY instanceof YMap)) {
    return;
  }
  for (const [name, slotSharedType] of slotsY.entries()) {
    // Names and values are peer-controlled. An entry that would trip the
    // invariants of $setSlot or $getOrInitCollabNodeFromSharedType is skipped
    // as a silent no-op (the local doc simply doesn't reflect it) instead of
    // crashing the observer editor.update.
    if (isReservedSlotName(name)) {
      continue;
    }
    if (
      !(
        slotSharedType instanceof XmlText ||
        slotSharedType instanceof XmlElement ||
        slotSharedType instanceof YMap
      )
    ) {
      continue;
    }
    const existingSlot = $getSlot(lexicalNode, name);
    const existingCollab =
      existingSlot === null
        ? undefined
        : binding.collabNodeMap.get(existingSlot.__key);
    if (
      existingCollab !== undefined &&
      existingCollab.getSharedType() === slotSharedType
    ) {
      // Same shared type still occupies this name; its own observer syncs
      // the slot's content, so leave the slot in place.
      continue;
    }
    // An uninitialized shared type can only be materialized with a string
    // `__type` ($getOrInitCollabNodeFromSharedType's invariant).
    if (
      slotSharedType._collabNode === undefined &&
      typeof sharedTypeGet(slotSharedType, '__type') !== 'string'
    ) {
      continue;
    }
    // A YMap value can only materialize a text/linebreak node — never a valid
    // slot value — and under a decorator host it would trip the element-parent
    // invariant before the value check below can reject it.
    if (
      slotSharedType instanceof YMap &&
      ownerCollab instanceof CollabDecoratorNode
    ) {
      continue;
    }
    // A cached collab node whose lexical node is live means the shared type
    // already backs a slot (set under an earlier name in this very Y.Map) or
    // an attached node elsewhere; re-materializing it would repoint the collab
    // node away from that node. First name wins; later aliases are skipped.
    const cachedCollab = slotSharedType._collabNode;
    if (cachedCollab !== undefined) {
      const cachedNode = $getNodeByKey(cachedCollab._key);
      if (
        cachedNode !== null &&
        (cachedNode.isAttached() ||
          (($isElementNode(cachedNode) || $isDecoratorNode(cachedNode)) &&
            cachedNode.getLatest().__slotHost !== null))
      ) {
        continue;
      }
    }
    const slotCollab = $getOrInitCollabNodeFromSharedType(
      binding,
      slotSharedType,
      ownerCollab,
    );
    const slotLexicalNode = createLexicalNodeFromCollabNode(
      binding,
      slotCollab,
      null,
    );
    if (!$isSlotValueNode(slotLexicalNode)) {
      // The materialized node can't legally occupy a slot; undo the
      // collabNodeMap registration so the rejected node doesn't dangle (the
      // node itself stays unattached and lexical GCs it).
      if (binding.collabNodeMap.get(slotLexicalNode.__key) === slotCollab) {
        binding.collabNodeMap.delete(slotLexicalNode.__key);
      }
      continue;
    }
    // A different shared type means the slot was replaced remotely. Destroy
    // the departing collab node so it doesn't dangle in binding.collabNodeMap
    // ($setSlot below detaches the stale lexical occupant).
    if (existingCollab !== undefined) {
      existingCollab.destroy(binding);
    }
    $setSlot(lexicalNode, name, slotLexicalNode);
  }
}

// Lexical -> Yjs slot diff shared by CollabElementNode + CollabDecoratorNode.
// Same factoring as `$syncSlotsFromYjsShared`: identical logic, parent only
// differs.
export function $syncSlotsFromLexicalShared(
  binding: Binding,
  slotsParent: XmlText | XmlElement,
  nextLexicalNode: ElementNode | DecoratorNode<unknown>,
  prevNodeMap: null | NodeMap,
  dirtyElements: null | Map<NodeKey, IntentionallyMarkedAsDirtyElement>,
  dirtyLeaves: null | Set<NodeKey>,
  ownerCollab: CollabElementNode | CollabDecoratorNode,
): void {
  const slotNames = $getSlotNames(nextLexicalNode);
  const existing = slotsParent.getAttribute(SLOTS_ATTR_KEY) as unknown;

  if (slotNames.length === 0 && !(existing instanceof YMap)) {
    return;
  }

  let slotsY: YMap<unknown>;
  if (existing instanceof YMap) {
    slotsY = existing;
  } else {
    slotsY = new YMap();
    setSlotsAttr(slotsParent, slotsY);
  }

  const nextNames = new Set(slotNames);
  for (const name of Array.from(slotsY.keys())) {
    if (!nextNames.has(name)) {
      // Mirror children removal (splice -> destroy): destroy the slot's collab
      // node before dropping it so its binding.collabNodeMap entry is cleared.
      // A value that was never materialized locally (e.g. skipped as invalid
      // remote data) has no `_collabNode` and nothing to destroy.
      const removed = slotsY.get(name) as XmlText | XmlElement | undefined;
      const removedCollab = removed == null ? undefined : removed._collabNode;
      if (removedCollab !== undefined) {
        removedCollab.destroy(binding);
      }
      slotsY.delete(name);
    }
  }

  const collabNodeMap = binding.collabNodeMap;
  for (const name of slotNames) {
    const slotNode = $getSlot(nextLexicalNode, name);
    if (slotNode === null) {
      continue;
    }
    const slotCollab = collabNodeMap.get(slotNode.__key);
    if (
      slotCollab !== undefined &&
      slotsY.get(name) === slotCollab.getSharedType()
    ) {
      $syncSlotContentFromLexical(
        binding,
        slotCollab,
        slotNode,
        prevNodeMap,
        dirtyElements,
        dirtyLeaves,
      );
    } else {
      // A same-name replace keeps the name in nextNames, so the removal loop
      // above never destroys the departing value. Mirror children removal
      // here too: destroy the previous slot's collab node before overwriting
      // its Y.Map entry so its binding.collabNodeMap entry doesn't dangle. A
      // value never materialized locally has no `_collabNode` to destroy.
      const prev = slotsY.get(name) as XmlText | XmlElement | undefined;
      const prevCollab = prev == null ? undefined : prev._collabNode;
      if (prevCollab !== undefined) {
        prevCollab.destroy(binding);
      }
      const created = $createCollabNodeFromLexicalNode(
        binding,
        slotNode,
        ownerCollab,
      );
      collabNodeMap.set(slotNode.__key, created);
      slotsY.set(name, created.getSharedType());
    }
  }
}

// Slot cleanup shared by host destroy paths.
export function $destroySlotsShared(
  binding: Binding,
  slotsParent: XmlText | XmlElement,
): void {
  const slotsY = slotsParent.getAttribute(SLOTS_ATTR_KEY) as unknown;
  if (slotsY instanceof YMap) {
    for (const name of slotsY.keys()) {
      // A value never materialized locally (e.g. skipped as invalid remote
      // data) has no `_collabNode` and nothing to destroy.
      const slot = slotsY.get(name) as XmlText | XmlElement | undefined;
      const slotCollab = slot == null ? undefined : slot._collabNode;
      if (slotCollab !== undefined) {
        slotCollab.destroy(binding);
      }
    }
  }
}
