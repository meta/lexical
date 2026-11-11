/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Binding, BindingV2, Provider} from '.';
import type {AnyBinding} from './Bindings';

import invariant from '@lexical/internal/invariant';
import {
  $addUpdateTag,
  $createParagraphNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getWritableNodeState,
  $isRangeSelection,
  $isTextNode,
  COLLABORATION_TAG,
  type EditorState,
  HISTORIC_TAG,
  type NodeKey,
  SKIP_SCROLL_INTO_VIEW_TAG,
} from 'lexical';
import {
  type ContentType,
  Item,
  iterateDeletedStructs,
  Map as YMap,
  type Text as YText,
  type Transaction as YTransaction,
  XmlElement,
  XmlText,
  type YEvent,
  YMapEvent,
  YTextEvent,
  YXmlEvent,
} from 'yjs';

import {CollabDecoratorNode} from './CollabDecoratorNode';
import {CollabElementNode} from './CollabElementNode';
import {CollabTextNode} from './CollabTextNode';
import {
  $syncLocalCursorPosition,
  syncCursorPositions,
  type SyncCursorPositionsFn,
  syncLexicalSelectionToYjs,
} from './SyncCursors';
import {$createOrUpdateNodeFromYElement, $updateYFragment} from './SyncV2';
import {
  $getOrInitCollabNodeFromSharedType,
  $moveSelectionToPreviousNode,
  doesSelectionNeedRecovering,
  getNodeTypeFromSharedType,
  SLOTS_ATTR_KEY,
  syncWithTransaction,
} from './Utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function $syncStateEvent(binding: Binding, event: YMapEvent<any>): boolean {
  const {target} = event;
  if (
    !(
      target._item &&
      target._item.parentSub === '__state' &&
      getNodeTypeFromSharedType(target) === undefined &&
      (target.parent instanceof XmlText ||
        target.parent instanceof XmlElement ||
        target.parent instanceof YMap)
    )
  ) {
    // TODO there might be a case to handle in here when a YMap
    // is used as a value  of __state? It would probably be desirable
    // to mark the node as dirty when that happens.
    return false;
  }
  const collabNode = $getOrInitCollabNodeFromSharedType(binding, target.parent);
  const node = collabNode.getNode();
  if (node) {
    const state = $getWritableNodeState(node.getWritable());
    for (const k of event.keysChanged) {
      state.updateFromUnknown(k, target.get(k));
    }
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function $syncEvent(binding: Binding, event: any): void {
  if (event instanceof YMapEvent && $syncStateEvent(binding, event)) {
    return;
  }
  const {target} = event;
  // Slots channel: a slot add / delete lands on the host's `__slots` attribute
  // Y.Map (parentSub === SLOTS_ATTR_KEY). An element host stores it on its `_xmlText`,
  // a decorator host on its `_xmlElem` (XmlElement). The Y.Map carries no
  // `__type`, so the default dispatch below would trip the shared-type
  // invariant. Re-route it to a host slot reconcile instead.
  if (
    event instanceof YMapEvent &&
    target instanceof YMap &&
    target._item != null &&
    target._item.parentSub === SLOTS_ATTR_KEY &&
    (target.parent instanceof XmlText || target.parent instanceof XmlElement)
  ) {
    const hostCollab = $getOrInitCollabNodeFromSharedType(
      binding,
      target.parent,
    );
    // The two branches are textually identical but stay separate because
    // CollabElementNode and CollabDecoratorNode each typed `syncSlotsFromYjs`
    // against its own lexical-node side (ElementNode vs DecoratorNode); a
    // union narrow at the call site intersects to `never`. A null host node
    // means it was concurrently removed from Lexical; nothing to sync.
    if (hostCollab instanceof CollabElementNode) {
      const hostNode = hostCollab.getNode();
      if (hostNode !== null) {
        hostCollab.syncSlotsFromYjs(binding, hostNode);
      }
    } else if (hostCollab instanceof CollabDecoratorNode) {
      const hostNode = hostCollab.getNode();
      if (hostNode !== null) {
        hostCollab.syncSlotsFromYjs(binding, hostNode);
      }
    }
    return;
  }
  const collabNode = $getOrInitCollabNodeFromSharedType(binding, target);

  if (collabNode instanceof CollabElementNode && event instanceof YTextEvent) {
    // @ts-expect-error We need to access the private childListChanged property of the class
    const {keysChanged, childListChanged, delta} = event;

    // Update. SLOTS_ATTR_KEY is a reserved key excluded from property sync; a change
    // to it is handled by the slot reconcile below.
    if (keysChanged.size > 0) {
      collabNode.syncPropertiesFromYjs(binding, keysChanged);
    }

    // A host's first slot set integrates the slots Y.Map in the same
    // transaction that assigns the attribute, so no YMapEvent fires for the
    // (brand-new) map — the change surfaces only as a changed `__slots` key
    // here. The undo of a first set (attribute removed) has the same shape. A
    // null host node means it was concurrently removed; nothing to sync.
    if (keysChanged.has(SLOTS_ATTR_KEY)) {
      const node = collabNode.getNode();
      if (node !== null) {
        collabNode.syncSlotsFromYjs(binding, node);
      }
    }

    if (childListChanged) {
      collabNode.applyChildrenYjsDelta(binding, delta);
      collabNode.syncChildrenFromYjs(binding);
    }
  } else if (
    collabNode instanceof CollabTextNode &&
    event instanceof YMapEvent
  ) {
    const {keysChanged} = event;

    // Update
    if (keysChanged.size > 0) {
      collabNode.syncPropertiesAndTextFromYjs(binding, keysChanged);
    }
  } else if (
    collabNode instanceof CollabDecoratorNode &&
    event instanceof YXmlEvent
  ) {
    const {attributesChanged} = event;

    // Update. SLOTS_ATTR_KEY is a reserved key excluded from property sync; a change
    // to it is handled by the slot reconcile below.
    if (attributesChanged.size > 0) {
      collabNode.syncPropertiesFromYjs(binding, attributesChanged);
    }

    // Same shape as the element-host case above: a first slot set (or its
    // undo) surfaces only as a changed `__slots` attribute on the host's
    // XmlElement, never as a YMapEvent.
    if (attributesChanged.has(SLOTS_ATTR_KEY)) {
      const node = collabNode.getNode();
      if (node !== null) {
        collabNode.syncSlotsFromYjs(binding, node);
      }
    }
  } else {
    invariant(false, 'Expected text, element, or decorator event');
  }
}

export function syncYjsChangesToLexical(
  binding: Binding,
  provider: Provider,
  events: YEvent<YText>[],
  isFromUndoManger: boolean,
  syncCursorPositionsFn: SyncCursorPositionsFn = syncCursorPositions,
): void {
  const editor = binding.editor;
  const currentEditorState = editor._editorState;

  // This line precompute the delta before editor update. The reason is
  // delta is computed when it is accessed. Note that this can only be
  // safely computed during the event call. If it is accessed after event
  // call it might result in unexpected behavior.
  // https://github.com/yjs/yjs/blob/00ef472d68545cb260abd35c2de4b3b78719c9e4/src/utils/YEvent.js#L132
  events.forEach(event => event.delta);

  editor.update(
    () => {
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        $syncEvent(binding, event);
      }

      $syncCursorFromYjs(currentEditorState, binding, provider);

      if (!isFromUndoManger) {
        // If it is an external change, we don't want the current scroll position to get changed
        // since the user might've intentionally scrolled somewhere else in the document.
        $addUpdateTag(SKIP_SCROLL_INTO_VIEW_TAG);
      }
    },
    {
      onUpdate: () => {
        syncCursorPositionsFn(binding, provider);
        if (binding.root.isEmpty()) {
          editor.update(() => $ensureEditorNotEmpty());
        }
      },
      skipTransforms: true,
      tag: isFromUndoManger ? HISTORIC_TAG : COLLABORATION_TAG,
    },
  );

  // Remove deleted nodes from the collab node map (mirrors the
  // binding.mapping sweep in syncYjsChangesToLexicalV2__EXPERIMENTAL). The
  // destroy paths above can't reach a deleted host's slot values: the host's
  // `__slots` attribute reads back undefined once its shared type is deleted, so
  // without this sweep their entries leak. Double deletes are idempotent.
  if (events.length > 0) {
    const transaction = events[0].transaction;
    iterateDeletedStructs(transaction, transaction.deleteSet, struct => {
      if (struct.constructor === Item) {
        const content = struct.content as ContentType;
        const type = content.type;
        if (type) {
          const collabNode = (type as XmlText | XmlElement | YMap<unknown>)
            ._collabNode;
          if (
            collabNode !== undefined &&
            binding.collabNodeMap.get(collabNode._key) === collabNode
          ) {
            binding.collabNodeMap.delete(collabNode._key);
          }
        }
      }
    });
  }
}

function $syncCursorFromYjs(
  editorState: EditorState,
  binding: AnyBinding,
  provider: Provider,
) {
  const selection = $getSelection();

  if ($isRangeSelection(selection)) {
    if (doesSelectionNeedRecovering(selection)) {
      const prevSelection = editorState._selection;

      if ($isRangeSelection(prevSelection)) {
        $syncLocalCursorPosition(binding, provider);
        if (doesSelectionNeedRecovering(selection)) {
          // If the selected node is deleted, move the selection to the previous or parent node.
          const anchorNodeKey = selection.anchor.key;
          $moveSelectionToPreviousNode(anchorNodeKey, editorState);
        }
      }

      syncLexicalSelectionToYjs(
        binding,
        provider,
        prevSelection,
        $getSelection(),
      );
    } else {
      $syncLocalCursorPosition(binding, provider);
    }
  }
}

function $handleNormalizationMergeConflicts(
  binding: Binding,
  normalizedNodes: Set<NodeKey>,
): void {
  // We handle the merge operations here
  const normalizedNodesKeys = Array.from(normalizedNodes);
  const collabNodeMap = binding.collabNodeMap;
  const mergedNodes: [CollabTextNode, string][] = [];
  const removedNodes: CollabTextNode[] = [];

  for (let i = 0; i < normalizedNodesKeys.length; i++) {
    const nodeKey = normalizedNodesKeys[i];
    const lexicalNode = $getNodeByKey(nodeKey);
    const collabNode = collabNodeMap.get(nodeKey);

    if (collabNode instanceof CollabTextNode) {
      if ($isTextNode(lexicalNode)) {
        // We mutate the text collab nodes after removing
        // all the dead nodes first, otherwise offsets break.
        mergedNodes.push([collabNode, lexicalNode.__text]);
      } else {
        const offset = collabNode.getOffset();

        if (offset === -1) {
          continue;
        }

        const parent = collabNode._parent;
        collabNode._normalized = true;
        parent._xmlText.delete(offset, 1);

        removedNodes.push(collabNode);
      }
    }
  }

  for (let i = 0; i < removedNodes.length; i++) {
    const collabNode = removedNodes[i];
    const nodeKey = collabNode.getKey();
    collabNodeMap.delete(nodeKey);
    const parentChildren = collabNode._parent._children;
    const index = parentChildren.indexOf(collabNode);
    parentChildren.splice(index, 1);
  }

  for (let i = 0; i < mergedNodes.length; i++) {
    const [collabNode, text] = mergedNodes[i];
    collabNode._text = text;
  }
}

// If there was a collision on the top level paragraph
// we need to re-add a paragraph. To ensure this insertion properly syncs with other clients,
// it must be placed outside of the update block above that has tags 'collaboration' or 'historic'.
function $ensureEditorNotEmpty() {
  if ($getRoot().getChildrenSize() === 0) {
    $getRoot().append($createParagraphNode());
  }
}

type IntentionallyMarkedAsDirtyElement = boolean;

export function syncLexicalUpdateToYjs(
  binding: Binding,
  provider: Provider,
  prevEditorState: EditorState,
  currEditorState: EditorState,
  dirtyElements: Map<NodeKey, IntentionallyMarkedAsDirtyElement>,
  dirtyLeaves: Set<NodeKey>,
  normalizedNodes: Set<NodeKey>,
  tags: Set<string>,
): void {
  syncWithTransaction(binding, () => {
    currEditorState.read(() => {
      // We check if the update has come from a origin where the origin
      // was the collaboration binding previously. This can help us
      // prevent unnecessarily re-diffing and possible re-applying
      // the same change editor state again. For example, if a user
      // types a character and we get it, we don't want to then insert
      // the same character again. The exception to this heuristic is
      // when we need to handle normalization merge conflicts.
      if (tags.has(COLLABORATION_TAG) || tags.has(HISTORIC_TAG)) {
        if (normalizedNodes.size > 0) {
          $handleNormalizationMergeConflicts(binding, normalizedNodes);
        }

        return;
      }

      if (dirtyElements.has('root')) {
        const prevNodeMap = prevEditorState._nodeMap;
        const nextLexicalRoot = $getRoot();
        const collabRoot = binding.root;
        collabRoot.syncPropertiesFromLexical(
          binding,
          nextLexicalRoot,
          prevNodeMap,
        );
        const prevMovedNodeKeys = binding._movedNodeKeys;
        const movedNodes = currEditorState._movedNodes;
        binding._movedNodeKeys =
          movedNodes === null ? undefined : movedNodes.get(prevNodeMap);
        try {
          collabRoot.syncChildrenFromLexical(
            binding,
            nextLexicalRoot,
            prevNodeMap,
            dirtyElements,
            dirtyLeaves,
          );
          // Slots live outside the linked-list children channel, so the root's
          // own slot map needs its dedicated diff too (child hosts get theirs
          // via _syncChildFromLexical).
          collabRoot.syncSlotsFromLexical(
            binding,
            nextLexicalRoot,
            prevNodeMap,
            dirtyElements,
            dirtyLeaves,
          );
        } finally {
          binding._movedNodeKeys = prevMovedNodeKeys;
        }
        // If a local edit emptied the root, schedule recovery outside the
        // collaboration/historic tag so the paragraph syncs back to Yjs.
        // Mirrors the $ensureEditorNotEmpty call in syncYjsChangesToLexical's onUpdate.
        // Only trigger when the previous state had content (prevNodeMap.size > 1 means
        // there were nodes beyond root), so we don't fire on initial empty-editor updates
        // (e.g. a focus update before the editor has been bootstrapped).
        if (
          nextLexicalRoot.getChildrenSize() === 0 &&
          prevEditorState._nodeMap.size > 1
        ) {
          binding.editor.update(() => $ensureEditorNotEmpty());
        }
      }

      const selection = $getSelection();
      const prevSelection = prevEditorState._selection;
      syncLexicalSelectionToYjs(binding, provider, prevSelection, selection);
    });
  });
}

function $syncEventV2(
  binding: BindingV2,
  event: YEvent<XmlElement | XmlText | YMap<unknown>>,
): void {
  const {target} = event;
  if (target instanceof XmlElement && event instanceof YXmlEvent) {
    $createOrUpdateNodeFromYElement(
      target,
      binding,
      event.attributesChanged,
      // @ts-expect-error childListChanged is private
      event.childListChanged,
    );
  } else if (target instanceof XmlText && event instanceof YTextEvent) {
    const parent = target.parent;
    if (parent instanceof XmlElement) {
      // Need to sync via parent element in order to attach new next nodes.
      $createOrUpdateNodeFromYElement(parent, binding, new Set(), true);
    } else {
      invariant(false, 'Expected XmlElement parent for XmlText');
    }
  } else if (
    target instanceof YMap &&
    event instanceof YMapEvent &&
    target._item != null &&
    target._item.parentSub === SLOTS_ATTR_KEY
  ) {
    // A slot add/remove arrives as a YMapEvent on the host's `__slots` Y.Map.
    // Re-route to the host element so its slots channel gets reconciled. The
    // parentSub guard narrows this branch to the slot Y.Map specifically —
    // other YMap attributes (e.g. `__state` nested maps) reach this dispatch
    // too and must fall through to the default handler.
    const parent = target.parent;
    if (parent instanceof XmlElement) {
      $createOrUpdateNodeFromYElement(
        parent,
        binding,
        new Set([SLOTS_ATTR_KEY]),
        false,
      );
    } else {
      invariant(false, 'Expected XmlElement parent for slots Y.Map');
    }
  } else {
    invariant(false, 'Expected xml or text event');
  }
}

export function syncYjsChangesToLexicalV2__EXPERIMENTAL(
  binding: BindingV2,
  provider: Provider,
  events: YEvent<XmlElement | XmlText>[],
  transaction: YTransaction,
  isFromUndoManger: boolean,
): void {
  const editor = binding.editor;
  const editorState = editor._editorState;

  // Remove deleted nodes from the mapping
  iterateDeletedStructs(transaction, transaction.deleteSet, struct => {
    if (struct.constructor === Item) {
      const content = struct.content as ContentType;
      const type = content.type;
      if (type) {
        binding.mapping.delete(type as XmlElement | XmlText);
      }
    }
  });

  // This line precompute the delta before editor update. The reason is
  // delta is computed when it is accessed. Note that this can only be
  // safely computed during the event call. If it is accessed after event
  // call it might result in unexpected behavior.
  // https://github.com/yjs/yjs/blob/00ef472d68545cb260abd35c2de4b3b78719c9e4/src/utils/YEvent.js#L132
  events.forEach(event => event.delta);

  editor.update(
    () => {
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        $syncEventV2(binding, event);
      }

      $syncCursorFromYjs(editorState, binding, provider);

      if (!isFromUndoManger) {
        // If it is an external change, we don't want the current scroll position to get changed
        // since the user might've intentionally scrolled somewhere else in the document.
        $addUpdateTag(SKIP_SCROLL_INTO_VIEW_TAG);
      }
    },
    {
      // Need any text node normalization to be synchronously updated back to Yjs, otherwise the
      // binding.mapping will get out of sync.
      discrete: true,
      onUpdate: () => {
        syncCursorPositions(binding, provider);
        if (binding.root.length === 0) {
          editor.update(() => $ensureEditorNotEmpty());
        }
      },
      skipTransforms: true,
      tag: isFromUndoManger ? HISTORIC_TAG : COLLABORATION_TAG,
    },
  );
}

export function syncYjsStateToLexicalV2__EXPERIMENTAL(
  binding: BindingV2,
  provider: Provider,
) {
  binding.mapping.clear();
  const editor = binding.editor;
  editor.update(
    () => {
      $getRoot().clear();
      $createOrUpdateNodeFromYElement(binding.root, binding, null, true);
      $addUpdateTag(COLLABORATION_TAG);
    },
    {
      // Need any text node normalization to be synchronously updated back to Yjs, otherwise the
      // binding.mapping will get out of sync.
      discrete: true,
      onUpdate: () => {
        syncCursorPositions(binding, provider);
        if (binding.root.length === 0) {
          editor.update(() => $ensureEditorNotEmpty());
        }
      },
      skipTransforms: true,
      tag: COLLABORATION_TAG,
    },
  );
}

export function syncLexicalUpdateToYjsV2__EXPERIMENTAL(
  binding: BindingV2,
  provider: Provider,
  prevEditorState: EditorState,
  currEditorState: EditorState,
  dirtyElements: Map<NodeKey, IntentionallyMarkedAsDirtyElement>,
  dirtyLeaves: Set<NodeKey>,
  normalizedNodes: Set<NodeKey>,
  tags: Set<string>,
): void {
  const isFromYjs = tags.has(COLLABORATION_TAG) || tags.has(HISTORIC_TAG);
  if (isFromYjs && normalizedNodes.size === 0) {
    return;
  }

  // Nodes are normalized synchronously (`discrete: true` above), so the mapping may now be
  // incorrect for these nodes, as they point to `getLatest` which is mutable within an update.
  normalizedNodes.forEach(nodeKey => {
    binding.mapping.deleteNode(nodeKey);
  });

  syncWithTransaction(binding, () => {
    currEditorState.read(() => {
      if (dirtyElements.has('root')) {
        const nextLexicalRoot = $getRoot();
        // A DecoratorNode slot value lands in dirtyLeaves (only ElementNodes
        // are routed to dirtyElements), so unioning the two ensures
        // $updateSlotsYType's same-identity recursion gate sees a dirty
        // decorator slot value and propagates its own-attribute changes.
        $updateYFragment(
          binding.doc,
          binding.root,
          nextLexicalRoot,
          binding,
          new Set([...dirtyElements.keys(), ...dirtyLeaves]),
        );
        // If a local edit emptied the root, schedule recovery outside the
        // collaboration/historic tag so the paragraph syncs back to Yjs.
        // Mirrors the $ensureEditorNotEmpty call in syncYjsChangesToLexicalV2's onUpdate.
        // Only trigger when the previous state had content (prevNodeMap.size > 1 means
        // there were nodes beyond root), so we don't fire on initial empty-editor updates.
        if (
          !isFromYjs &&
          nextLexicalRoot.getChildrenSize() === 0 &&
          prevEditorState._nodeMap.size > 1
        ) {
          binding.editor.update(() => $ensureEditorNotEmpty());
        }
      }

      const selection = $getSelection();
      const prevSelection = prevEditorState._selection;
      syncLexicalSelectionToYjs(binding, provider, prevSelection, selection);
    });
  });
}
