/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from './LexicalEditor';
import type {EditorState} from './LexicalEditorState';
import type {LexicalNode, NodeKey, NodeMap} from './LexicalNode';

import {$isElementNode} from '.';
import {$isSlotChild, $isSlotHost} from './LexicalSlot';
import {getActiveEditor} from './LexicalUpdates';
import {cloneDecorators} from './LexicalUtils';

export function $garbageCollectDetachedDecorators(
  editor: LexicalEditor,
  pendingEditorState: EditorState,
): void {
  const currentDecorators = editor._decorators;
  const pendingDecorators = editor._pendingDecorators;
  let decorators = pendingDecorators || currentDecorators;
  const nodeMap = pendingEditorState._nodeMap;
  let key;

  for (key in decorators) {
    if (!nodeMap.has(key)) {
      if (decorators === currentDecorators) {
        decorators = cloneDecorators(editor);
      }

      delete decorators[key];
    }
  }
}

type IntentionallyMarkedAsDirtyElement = boolean;

function $garbageCollectDetachedDeepChildNodes(
  node: LexicalNode,
  parentKey: NodeKey,
  prevNodeMap: NodeMap,
  nodeMap: NodeMap,
  nodeMapDelete: NodeKey[],
  dirtyNodes: Map<NodeKey, IntentionallyMarkedAsDirtyElement> | Set<NodeKey>,
): void {
  if ($isElementNode(node)) {
    let childKey = node.__first;
    while (childKey !== null) {
      const child = nodeMap.get(childKey);
      if (child === undefined) {
        break;
      }
      const isElement = $isElementNode(child);
      // With dirtyElements, leave dirty child subtrees to the outer Map
      // iteration, which visits every entry not deleted before its turn.
      // Keep skipped entries in that map and defer node-map deletion so the
      // outer visit can also clean up newly created nodes. With dirtyLeaves
      // (decorator slot hosts), no element keys are present, so no skip occurs.
      if (
        child.__parent === parentKey &&
        !(isElement && dirtyNodes.has(childKey))
      ) {
        if (isElement || ($isSlotHost(child) && child.__slots !== null)) {
          $garbageCollectDetachedDeepChildNodes(
            child,
            childKey,
            prevNodeMap,
            nodeMap,
            nodeMapDelete,
            dirtyNodes,
          );
        }

        // If we have created a node and it was dereferenced, then also
        // remove it from out dirty nodes Set.
        if (!prevNodeMap.has(childKey)) {
          dirtyNodes.delete(childKey);
        }
        nodeMapDelete.push(childKey);
      }
      childKey = child.__next;
    }
  }

  // Slot nodes are not in the linked-list child channel; reach them through
  // the slot map, gating on the slot host the mirror of the __parent check.
  // Slots hang off any host (element or decorator), so this runs regardless
  // of the host node type.
  for (const slotKey of $isSlotHost(node) && node.__slots !== null
    ? node.__slots.values()
    : []) {
    const slotNode = nodeMap.get(slotKey);
    if (
      slotNode !== undefined &&
      $isSlotChild(slotNode) &&
      slotNode.__slotHost === parentKey
    ) {
      if (
        $isElementNode(slotNode) ||
        ($isSlotHost(slotNode) && slotNode.__slots !== null)
      ) {
        $garbageCollectDetachedDeepChildNodes(
          slotNode,
          slotKey,
          prevNodeMap,
          nodeMap,
          nodeMapDelete,
          dirtyNodes,
        );
      }
      if (!prevNodeMap.has(slotKey)) {
        dirtyNodes.delete(slotKey);
      }
      nodeMapDelete.push(slotKey);
    }
  }
}

export function $garbageCollectDetachedNodes(
  prevEditorState: EditorState,
  editorState: EditorState,
  dirtyLeaves: Set<NodeKey>,
  dirtyElements: Map<NodeKey, IntentionallyMarkedAsDirtyElement>,
): void {
  const prevNodeMap = prevEditorState._nodeMap;
  const nodeMap = editorState._nodeMap;
  // Store dirtyElements in a queue for later deletion; deleting dirty subtrees too early will
  // hinder accessing .__next on child nodes
  const nodeMapDelete: NodeKey[] = [];

  for (const [nodeKey] of dirtyElements) {
    const node = nodeMap.get(nodeKey);
    if (node !== undefined) {
      // Garbage collect node and its children if they exist
      if (!node.isAttached()) {
        if ($isElementNode(node)) {
          $garbageCollectDetachedDeepChildNodes(
            node,
            nodeKey,
            prevNodeMap,
            nodeMap,
            nodeMapDelete,
            dirtyElements,
          );
        }
        // If we have created a node and it was dereferenced, then also
        // remove it from out dirty nodes Set.
        if (!prevNodeMap.has(nodeKey)) {
          dirtyElements.delete(nodeKey);
        }
        nodeMapDelete.push(nodeKey);
      }
    }
  }
  for (const nodeKey of dirtyLeaves) {
    const node = nodeMap.get(nodeKey);
    if (node !== undefined && !node.isAttached()) {
      // A decorator host is a leaf, so the element deep-walk above never
      // reaches its slots; collect them here to avoid orphaning the slot
      // subtree. Deletion is deferred to the shared queue so the walk can
      // still read the slot nodes. When a host is in dirtyElements and one of
      // its slot values is also dirty, the two loops can both push the same
      // slot subtree key into nodeMapDelete — that redundancy is harmless
      // because nodeMap.delete is idempotent and the dirtyNodes.delete calls
      // are too.
      if ($isSlotHost(node) && node.__slots !== null) {
        $garbageCollectDetachedDeepChildNodes(
          node,
          nodeKey,
          prevNodeMap,
          nodeMap,
          nodeMapDelete,
          dirtyLeaves,
        );
      }
      if (!prevNodeMap.has(nodeKey)) {
        dirtyLeaves.delete(nodeKey);
      }
      nodeMapDelete.push(nodeKey);
    }
  }

  const editor = getActiveEditor();
  const cloneNotNeeded = editor._cloneNotNeeded;
  for (const nodeKey of nodeMapDelete) {
    nodeMap.delete(nodeKey);
    cloneNotNeeded.delete(nodeKey);
  }

  // Clear the composition key if it points at a node that just got collected.
  // Without this, isComposing() keeps reporting true after a remote yjs
  // update (or any host removal) drops the composing TextNode — most often
  // observable when the composing node sits inside a slot subtree that gets
  // collected wholesale via the dual-channel slot GC above.
  const compositionKey = editor._compositionKey;
  if (compositionKey !== null && !nodeMap.has(compositionKey)) {
    editor._compositionKey = null;
  }
}
