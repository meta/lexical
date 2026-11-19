/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Binding} from '.';
import type {AbstractType, Map as YMap, XmlElement, XmlText} from 'yjs';

import invariant from '@lexical/internal/invariant';
import {
  $createChildrenArray,
  $getNodeByKey,
  $getNodeByKeyOrThrow,
  $isDecoratorNode,
  $isElementNode,
  $isTextNode,
  $removeFromParent,
  type ElementNode,
  type NodeKey,
  type NodeMap,
} from 'lexical';

import {CollabDecoratorNode} from './CollabDecoratorNode';
import {CollabLineBreakNode} from './CollabLineBreakNode';
import {CollabTextNode} from './CollabTextNode';
import {
  $createCollabNodeFromLexicalNode,
  $destroySlotsShared,
  $getOrInitCollabNodeFromSharedType,
  $syncPropertiesFromYjs,
  $syncSlotsFromLexicalShared,
  $syncSlotsFromYjsShared,
  createLexicalNodeFromCollabNode,
  getNodeTypeFromSharedType,
  getPositionFromElementAndOffset,
  spliceString,
  syncPropertiesFromLexical,
} from './Utils';

type IntentionallyMarkedAsDirtyElement = boolean;

// Keep all siblings that were not detached during this update, then maximize
// the number of other keys that retain their relative order. Final child lists
// alone cannot distinguish which child of an adjacent pair actually moved.
// Without movement hints (e.g. setEditorState), this is an ordinary longest
// increasing subsequence. Yjs has no native move, so keys outside this set are
// deleted and/or re-created, while stable keys retain their Yjs identities.
function getStableChildKeys(
  prevChildren: readonly NodeKey[],
  prevStart: number,
  nextChildren: readonly NodeKey[],
  nextStart: number,
  movedKeys: undefined | Set<NodeKey>,
): Set<NodeKey> {
  const prevPositions = new Map<NodeKey, number>();
  for (let i = prevStart; i < prevChildren.length; i++) {
    prevPositions.set(prevChildren[i], i);
  }
  const keys: NodeKey[] = [];
  const positions: number[] = [];
  for (let i = nextStart; i < nextChildren.length; i++) {
    const position = prevPositions.get(nextChildren[i]);
    if (position !== undefined) {
      keys.push(nextChildren[i]);
      positions.push(position);
    }
  }
  // A prefix-maximum Fenwick tree finds a weighted increasing subsequence in
  // O(n log n). One untouched sibling outweighs all moved siblings combined:
  // untouched siblings retain their mutual order, so all of them can be kept.
  // A bulk splice that detaches every child still chooses a maximum-length
  // subsequence, preserving the minimum-recreation behavior for reorders.
  const tree: number[] = new Array(prevChildren.length + 1).fill(-1);
  const scores: number[] = [];
  const predecessors: number[] = new Array(positions.length);
  const untouchedWeight = positions.length + 1;
  let best = -1;
  const isBetter = (candidate: number, current: number) =>
    candidate !== -1 &&
    (current === -1 ||
      scores[candidate] > scores[current] ||
      (scores[candidate] === scores[current] &&
        positions[candidate] < positions[current]));

  for (let i = 0; i < positions.length; i++) {
    const position = positions[i];
    let predecessor = -1;
    for (let index = position; index > 0; index -= index & -index) {
      if (isBetter(tree[index], predecessor)) {
        predecessor = tree[index];
      }
    }
    predecessors[i] = predecessor;
    scores[i] =
      (predecessor === -1 ? 0 : scores[predecessor]) +
      (movedKeys !== undefined && !movedKeys.has(keys[i])
        ? untouchedWeight
        : 1);
    for (
      let index = position + 1;
      index < tree.length;
      index += index & -index
    ) {
      if (isBetter(i, tree[index])) {
        tree[index] = i;
      }
    }
    if (isBetter(i, best)) {
      best = i;
    }
  }
  const stableKeys = new Set<NodeKey>();
  for (let i = best; i >= 0; i = predecessors[i]) {
    stableKeys.add(keys[i]);
  }
  return stableKeys;
}

export class CollabElementNode {
  _key: NodeKey;
  _children: (
    | CollabElementNode
    | CollabTextNode
    | CollabDecoratorNode
    | CollabLineBreakNode
  )[];
  _xmlText: XmlText;
  _type: string;
  // Normally an element's parent is another element, but a slot-value element
  // hosted by a decorator has that decorator as its parent.
  _parent: null | CollabElementNode | CollabDecoratorNode;

  constructor(
    xmlText: XmlText,
    parent: null | CollabElementNode | CollabDecoratorNode,
    type: string,
  ) {
    this._key = '';
    this._children = [];
    this._xmlText = xmlText;
    this._type = type;
    this._parent = parent;
  }

  getPrevNode(nodeMap: null | NodeMap): null | ElementNode {
    if (nodeMap === null) {
      return null;
    }

    const node = nodeMap.get(this._key);
    return $isElementNode(node) ? node : null;
  }

  getNode(): null | ElementNode {
    const node = $getNodeByKey(this._key);
    return $isElementNode(node) ? node : null;
  }

  getSharedType(): XmlText {
    return this._xmlText;
  }

  getType(): string {
    return this._type;
  }

  getKey(): NodeKey {
    return this._key;
  }

  isEmpty(): boolean {
    return this._children.length === 0;
  }

  getSize(): number {
    return 1;
  }

  getOffset(): number {
    const collabElementNode = this._parent;
    // A slot-value element has a decorator parent, but slots live outside the
    // linked-list children channel so getOffset is never called on one — only
    // real children (whose parent is an element) reach here.
    invariant(
      collabElementNode instanceof CollabElementNode,
      'getOffset: could not find collab element node',
    );

    return collabElementNode.getChildOffset(this);
  }

  syncPropertiesFromYjs(
    binding: Binding,
    keysChanged: null | Set<string>,
  ): void {
    const lexicalNode = this.getNode();
    if (lexicalNode === null) {
      // Concurrently removed from Lexical; nothing to sync.
      return;
    }
    $syncPropertiesFromYjs(binding, this._xmlText, lexicalNode, keysChanged);
  }

  applyChildrenYjsDelta(
    binding: Binding,
    deltas: {
      insert?: string | object | AbstractType<unknown>;
      delete?: number;
      retain?: number;
      attributes?: {
        [x: string]: unknown;
      };
    }[],
  ): void {
    const children = this._children;
    let currIndex = 0;
    let pendingSplitText = null;

    for (let i = 0; i < deltas.length; i++) {
      const delta = deltas[i];
      const insertDelta = delta.insert;
      const deleteDelta = delta.delete;

      if (delta.retain != null) {
        currIndex += delta.retain;
      } else if (typeof deleteDelta === 'number') {
        let deletionSize = deleteDelta;

        while (deletionSize > 0) {
          const {node, nodeIndex, offset, length} =
            getPositionFromElementAndOffset(this, currIndex, false);

          if (
            node instanceof CollabElementNode ||
            node instanceof CollabLineBreakNode ||
            node instanceof CollabDecoratorNode
          ) {
            children.splice(nodeIndex, 1);
            deletionSize -= 1;
          } else if (node instanceof CollabTextNode) {
            const delCount = Math.min(deletionSize, length);
            const prevCollabNode =
              nodeIndex !== 0 ? children[nodeIndex - 1] : null;
            const nodeSize = node.getSize();

            if (offset === 0 && length === nodeSize) {
              // Text node has been deleted.
              children.splice(nodeIndex, 1);
              // If this was caused by an undo from YJS, there could be dangling text.
              const danglingText = spliceString(
                node._text,
                offset,
                delCount - 1,
                '',
              );
              if (danglingText.length > 0) {
                if (prevCollabNode instanceof CollabTextNode) {
                  // Merge the text node with previous.
                  prevCollabNode._text += danglingText;
                } else {
                  // No previous text node to merge into, just delete the text.
                  this._xmlText.delete(offset, danglingText.length);
                }
              }
            } else {
              node._text = spliceString(node._text, offset, delCount, '');
            }

            deletionSize -= delCount;
          } else {
            // Can occur due to the deletion from the dangling text heuristic below.
            break;
          }
        }
      } else if (insertDelta != null) {
        if (typeof insertDelta === 'string') {
          const {node, offset} = getPositionFromElementAndOffset(
            this,
            currIndex,
            true,
          );

          if (node instanceof CollabTextNode) {
            node._text = spliceString(node._text, offset, 0, insertDelta);
          } else {
            // TODO: maybe we can improve this by keeping around a redundant
            // text node map, rather than removing all the text nodes, so there
            // never can be dangling text.

            // We have a conflict where there was likely a CollabTextNode and
            // an Lexical TextNode too, but they were removed in a merge. So
            // let's just ignore the text and trigger a removal for it from our
            // shared type.
            this._xmlText.delete(offset, insertDelta.length);
          }

          currIndex += insertDelta.length;
        } else {
          const sharedType = insertDelta as
            | XmlText
            | YMap<unknown>
            | XmlElement;
          // A delta can reference a shared type that has already been deleted
          // (e.g. while reconciling an undo against concurrent remote edits). A
          // deleted type has no `__type` and must not be materialized into the
          // collab tree; it carries no live content, so skip it entirely.
          if (getNodeTypeFromSharedType(sharedType) === undefined) {
            continue;
          }
          const {node, nodeIndex, length} = getPositionFromElementAndOffset(
            this,
            currIndex,
            false,
          );
          const collabNode = $getOrInitCollabNodeFromSharedType(
            binding,
            sharedType,
            this,
          );
          if (
            node instanceof CollabTextNode &&
            length > 0 &&
            length < node._text.length
          ) {
            // Trying to insert in the middle of a text node; split the text.
            const text = node._text;
            const splitIdx = text.length - length;
            node._text = spliceString(text, splitIdx, length, '');
            children.splice(nodeIndex + 1, 0, collabNode);
            // The insert that triggers the text split might not be a text node. Need to keep a
            // reference to the remaining text so that it can be added when we do create one.
            pendingSplitText = spliceString(text, 0, splitIdx, '');
          } else {
            children.splice(nodeIndex, 0, collabNode);
          }
          if (
            pendingSplitText !== null &&
            collabNode instanceof CollabTextNode
          ) {
            // Found a text node to insert the pending text into.
            collabNode._text = pendingSplitText + collabNode._text;
            pendingSplitText = null;
          }
          currIndex += 1;
        }
      } else {
        throw new Error('Unexpected delta format');
      }
    }
  }

  syncChildrenFromYjs(binding: Binding): void {
    // Now diff the children of the collab node with that of our existing Lexical node.
    const lexicalNode = this.getNode();
    if (lexicalNode === null) {
      // The Lexical node was concurrently removed (e.g. by a remote edit or undo)
      // while we still have a pending change for it. There is nothing to reconcile
      // into Lexical; this collab node will be cleaned up when its parent syncs.
      return;
    }

    const key = lexicalNode.__key;
    const prevLexicalChildrenKeys = $createChildrenArray(lexicalNode, null);
    const nextLexicalChildrenKeys: NodeKey[] = [];
    const lexicalChildrenKeysLength = prevLexicalChildrenKeys.length;
    const collabChildren = this._children;
    const collabChildrenLength = collabChildren.length;
    const collabNodeMap = binding.collabNodeMap;
    const visitedKeys = new Set();
    let collabKeys;
    let writableLexicalNode;
    let prevIndex = 0;
    let prevChildNode = null;

    if (collabChildrenLength !== lexicalChildrenKeysLength) {
      writableLexicalNode = lexicalNode.getWritable();
    }

    for (let i = 0; i < collabChildrenLength; i++) {
      const lexicalChildKey = prevLexicalChildrenKeys[prevIndex];
      const childCollabNode = collabChildren[i];
      const collabLexicalChildNode = childCollabNode.getNode();
      const collabKey = childCollabNode._key;

      if (collabLexicalChildNode !== null && lexicalChildKey === collabKey) {
        const childNeedsUpdating = $isTextNode(collabLexicalChildNode);
        // Update
        visitedKeys.add(lexicalChildKey);

        if (childNeedsUpdating) {
          childCollabNode._key = lexicalChildKey;

          if (childCollabNode instanceof CollabElementNode) {
            const xmlText = childCollabNode._xmlText;
            childCollabNode.syncPropertiesFromYjs(binding, null);
            childCollabNode.applyChildrenYjsDelta(binding, xmlText.toDelta());
            childCollabNode.syncChildrenFromYjs(binding);
          } else if (childCollabNode instanceof CollabTextNode) {
            childCollabNode.syncPropertiesAndTextFromYjs(binding, null);
          } else if (childCollabNode instanceof CollabDecoratorNode) {
            childCollabNode.syncPropertiesFromYjs(binding, null);
          } else if (!(childCollabNode instanceof CollabLineBreakNode)) {
            invariant(
              false,
              'syncChildrenFromYjs: expected text, element, decorator, or linebreak collab node',
            );
          }
        }

        nextLexicalChildrenKeys[i] = lexicalChildKey;
        prevChildNode = collabLexicalChildNode;
        prevIndex++;
      } else {
        if (collabKeys === undefined) {
          collabKeys = new Set();

          for (let s = 0; s < collabChildrenLength; s++) {
            const child = collabChildren[s];
            const childKey = child._key;

            if (childKey !== '') {
              collabKeys.add(childKey);
            }
          }
        }

        if (
          collabLexicalChildNode !== null &&
          lexicalChildKey !== undefined &&
          !collabKeys.has(lexicalChildKey)
        ) {
          const nodeToRemove = $getNodeByKeyOrThrow(lexicalChildKey);
          $removeFromParent(nodeToRemove);
          i--;
          prevIndex++;
          continue;
        }

        writableLexicalNode = lexicalNode.getWritable();
        // Create/Replace
        const lexicalChildNode = createLexicalNodeFromCollabNode(
          binding,
          childCollabNode,
          key,
        );
        const childKey = lexicalChildNode.__key;
        collabNodeMap.set(childKey, childCollabNode);
        nextLexicalChildrenKeys[i] = childKey;
        if (prevChildNode === null) {
          const nextSibling = writableLexicalNode.getFirstChild();
          writableLexicalNode.__first = childKey;
          if (nextSibling !== null) {
            const writableNextSibling = nextSibling.getWritable();
            writableNextSibling.__prev = childKey;
            lexicalChildNode.__next = writableNextSibling.__key;
          }
        } else {
          const writablePrevChildNode = prevChildNode.getWritable();
          const nextSibling = prevChildNode.getNextSibling();
          writablePrevChildNode.__next = childKey;
          lexicalChildNode.__prev = prevChildNode.__key;
          if (nextSibling !== null) {
            const writableNextSibling = nextSibling.getWritable();
            writableNextSibling.__prev = childKey;
            lexicalChildNode.__next = writableNextSibling.__key;
          }
        }
        if (i === collabChildrenLength - 1) {
          writableLexicalNode.__last = childKey;
        }
        writableLexicalNode.__size++;
        prevChildNode = lexicalChildNode;
      }
    }

    for (let i = 0; i < lexicalChildrenKeysLength; i++) {
      const lexicalChildKey = prevLexicalChildrenKeys[i];

      if (!visitedKeys.has(lexicalChildKey)) {
        // Remove
        const lexicalChildNode = $getNodeByKeyOrThrow(lexicalChildKey);
        const collabNode = binding.collabNodeMap.get(lexicalChildKey);

        if (collabNode !== undefined) {
          collabNode.destroy(binding);
        }
        $removeFromParent(lexicalChildNode);
      }
    }

    this.syncSlotsFromYjs(binding, lexicalNode);
  }

  // Reconcile named slots from the `__slots` Y.Map attribute on this element's
  // `_xmlText` into the lexical node. Slots live outside the linked-list
  // children channel, so they are not reached by the delta-driven children
  // reconcile above. This diff serves both initial fresh-restore and the
  // observer path: a name present in the Y.Map but missing on the lexical node
  // is added, a name present on the lexical node but gone from the Y.Map is
  // removed, and a name present on both is left untouched (its own
  // text/children edits flow through the slot's CollabElementNode YTextEvent).
  syncSlotsFromYjs(binding: Binding, lexicalNode: ElementNode): void {
    $syncSlotsFromYjsShared(binding, this._xmlText, lexicalNode, this);
  }

  syncPropertiesFromLexical(
    binding: Binding,
    nextLexicalNode: ElementNode,
    prevNodeMap: null | NodeMap,
  ): void {
    syncPropertiesFromLexical(
      binding,
      this._xmlText,
      this.getPrevNode(prevNodeMap),
      nextLexicalNode,
    );
  }

  _syncChildFromLexical(
    binding: Binding,
    index: number,
    key: NodeKey,
    prevNodeMap: null | NodeMap,
    dirtyElements: null | Map<NodeKey, IntentionallyMarkedAsDirtyElement>,
    dirtyLeaves: null | Set<NodeKey>,
  ): void {
    const childCollabNode = this._children[index];
    // Update
    const nextChildNode = $getNodeByKeyOrThrow(key);

    if (
      childCollabNode instanceof CollabElementNode &&
      $isElementNode(nextChildNode)
    ) {
      childCollabNode.syncPropertiesFromLexical(
        binding,
        nextChildNode,
        prevNodeMap,
      );
      childCollabNode.syncChildrenFromLexical(
        binding,
        nextChildNode,
        prevNodeMap,
        dirtyElements,
        dirtyLeaves,
      );
      childCollabNode.syncSlotsFromLexical(
        binding,
        nextChildNode,
        prevNodeMap,
        dirtyElements,
        dirtyLeaves,
      );
    } else if (
      childCollabNode instanceof CollabTextNode &&
      $isTextNode(nextChildNode)
    ) {
      childCollabNode.syncPropertiesAndTextFromLexical(
        binding,
        nextChildNode,
        prevNodeMap,
      );
    } else if (
      childCollabNode instanceof CollabDecoratorNode &&
      $isDecoratorNode(nextChildNode)
    ) {
      childCollabNode.syncPropertiesFromLexical(
        binding,
        nextChildNode,
        prevNodeMap,
      );
      childCollabNode.syncSlotsFromLexical(
        binding,
        nextChildNode,
        prevNodeMap,
        dirtyElements,
        dirtyLeaves,
      );
    }
  }

  // Mirror of the lexical slot map into the `__slots` Y.Map attribute on this
  // element's `_xmlText`. Slots live outside the linked-list children channel,
  // so syncChildrenFromLexical never reaches them; this diff is the local
  // (lexical -> yjs) counterpart of syncSlotsFromYjs. A name gone from lexical
  // is deleted from the Y.Map; a name whose slot node is already serialized at
  // that name is recursed in place (so in-slot content edits propagate); a new
  // or replaced (different node key) name is (re)created and set. The
  // creation-time block in $createCollabNodeFromLexicalNode still seeds slots
  // for a brand-new host (appended via the children diff, which has no matched
  // key to recurse through here).
  syncSlotsFromLexical(
    binding: Binding,
    nextLexicalNode: ElementNode,
    prevNodeMap: null | NodeMap,
    dirtyElements: null | Map<NodeKey, IntentionallyMarkedAsDirtyElement>,
    dirtyLeaves: null | Set<NodeKey>,
  ): void {
    $syncSlotsFromLexicalShared(
      binding,
      this._xmlText,
      nextLexicalNode,
      prevNodeMap,
      dirtyElements,
      dirtyLeaves,
      this,
    );
  }

  syncChildrenFromLexical(
    binding: Binding,
    nextLexicalNode: ElementNode,
    prevNodeMap: null | NodeMap,
    dirtyElements: null | Map<NodeKey, IntentionallyMarkedAsDirtyElement>,
    dirtyLeaves: null | Set<NodeKey>,
  ): void {
    const prevLexicalNode = this.getPrevNode(prevNodeMap);
    const prevChildren =
      prevLexicalNode === null
        ? []
        : $createChildrenArray(prevLexicalNode, prevNodeMap);
    const nextChildren = $createChildrenArray(nextLexicalNode, null);
    const prevEndIndex = prevChildren.length - 1;
    const nextEndIndex = nextChildren.length - 1;
    const collabNodeMap = binding.collabNodeMap;
    let stableKeys: Set<NodeKey> | undefined;
    let prevIndex = 0;
    let nextIndex = 0;

    while (prevIndex <= prevEndIndex && nextIndex <= nextEndIndex) {
      const prevKey = prevChildren[prevIndex];
      const nextKey = nextChildren[nextIndex];

      if (stableKeys === undefined) {
        if (prevKey === nextKey) {
          this._syncChildFromLexical(
            binding,
            nextIndex,
            nextKey,
            prevNodeMap,
            dirtyElements,
            dirtyLeaves,
          );

          prevIndex++;
          nextIndex++;
          continue;
        }
        stableKeys = getStableChildKeys(
          prevChildren,
          prevIndex,
          nextChildren,
          nextIndex,
          binding._movedNodeKeys,
        );
      }

      if (!stableKeys.has(prevKey)) {
        // Removed, or moved elsewhere (re-created at its new position)
        this.splice(binding, nextIndex, 1);
        prevIndex++;
      } else if (!stableKeys.has(nextKey)) {
        // Created, or moved here (its old collab node is deleted when
        // prevIndex reaches it)
        const nextChildNode = $getNodeByKeyOrThrow(nextKey);
        const collabNode = $createCollabNodeFromLexicalNode(
          binding,
          nextChildNode,
          this,
        );
        collabNodeMap.set(nextKey, collabNode);
        this.splice(binding, nextIndex, 0, collabNode);
        nextIndex++;
      } else {
        // Both stable, so prevKey === nextKey
        this._syncChildFromLexical(
          binding,
          nextIndex,
          nextKey,
          prevNodeMap,
          dirtyElements,
          dirtyLeaves,
        );

        prevIndex++;
        nextIndex++;
      }
    }

    const appendNewChildren = prevIndex > prevEndIndex;
    const removeOldChildren = nextIndex > nextEndIndex;

    if (appendNewChildren && !removeOldChildren) {
      for (; nextIndex <= nextEndIndex; ++nextIndex) {
        const key = nextChildren[nextIndex];
        const nextChildNode = $getNodeByKeyOrThrow(key);
        const collabNode = $createCollabNodeFromLexicalNode(
          binding,
          nextChildNode,
          this,
        );
        this.append(collabNode);
        collabNodeMap.set(key, collabNode);
      }
    } else if (removeOldChildren && !appendNewChildren) {
      for (let i = this._children.length - 1; i >= nextIndex; i--) {
        this.splice(binding, i, 1);
      }
    }
  }

  append(
    collabNode:
      | CollabElementNode
      | CollabDecoratorNode
      | CollabTextNode
      | CollabLineBreakNode,
  ): void {
    const xmlText = this._xmlText;
    const children = this._children;
    const lastChild = children[children.length - 1];
    const offset =
      lastChild !== undefined ? lastChild.getOffset() + lastChild.getSize() : 0;

    if (collabNode instanceof CollabElementNode) {
      xmlText.insertEmbed(offset, collabNode._xmlText);
    } else if (collabNode instanceof CollabTextNode) {
      const map = collabNode._map;

      if (map.parent === null) {
        xmlText.insertEmbed(offset, map);
      }

      xmlText.insert(offset + 1, collabNode._text);
    } else if (collabNode instanceof CollabLineBreakNode) {
      xmlText.insertEmbed(offset, collabNode._map);
    } else if (collabNode instanceof CollabDecoratorNode) {
      xmlText.insertEmbed(offset, collabNode._xmlElem);
    }

    this._children.push(collabNode);
  }

  splice(
    binding: Binding,
    index: number,
    delCount: number,
    collabNode?:
      | CollabElementNode
      | CollabDecoratorNode
      | CollabTextNode
      | CollabLineBreakNode,
  ): void {
    const children = this._children;
    const child = children[index];

    if (child === undefined) {
      if (collabNode !== undefined) {
        this.append(collabNode);
      }
      return;
    }

    const offset = child.getOffset();
    invariant(offset !== -1, 'splice: expected offset to be greater than zero');

    const xmlText = this._xmlText;

    if (delCount !== 0) {
      // Destroy the departing children before the embed is deleted below: a
      // child's slots live on its (about-to-be-detached) `_xmlText`, which
      // reads back empty once the embed is gone, so destroy() can only reach
      // them while the child is still attached.
      const childrenToDelete = children.slice(index, index + delCount);

      for (let i = 0; i < childrenToDelete.length; i++) {
        childrenToDelete[i].destroy(binding);
      }

      // What if we delete many nodes, don't we need to get all their
      // sizes?
      xmlText.delete(offset, child.getSize());
    }

    if (collabNode instanceof CollabElementNode) {
      xmlText.insertEmbed(offset, collabNode._xmlText);
    } else if (collabNode instanceof CollabTextNode) {
      const map = collabNode._map;

      if (map.parent === null) {
        xmlText.insertEmbed(offset, map);
      }

      xmlText.insert(offset + 1, collabNode._text);
    } else if (collabNode instanceof CollabLineBreakNode) {
      xmlText.insertEmbed(offset, collabNode._map);
    } else if (collabNode instanceof CollabDecoratorNode) {
      xmlText.insertEmbed(offset, collabNode._xmlElem);
    }

    if (collabNode !== undefined) {
      children.splice(index, delCount, collabNode);
    } else {
      children.splice(index, delCount);
    }
  }

  getChildOffset(
    collabNode:
      | CollabElementNode
      | CollabTextNode
      | CollabDecoratorNode
      | CollabLineBreakNode,
  ): number {
    let offset = 0;
    const children = this._children;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];

      if (child === collabNode) {
        return offset;
      }

      offset += child.getSize();
    }

    return -1;
  }

  destroy(binding: Binding): void {
    const collabNodeMap = binding.collabNodeMap;
    const children = this._children;

    for (let i = 0; i < children.length; i++) {
      children[i].destroy(binding);
    }

    // Slots live outside the linked-list children channel, so destroying the
    // children above never reaches them. Destroy each slot's collab node too;
    // otherwise it dangles in binding.collabNodeMap after the host is removed.
    // The host's `_xmlText` must still be attached here for SLOTS_ATTR_KEY to read
    // back (its caller — splice — destroys before detaching the embed).
    $destroySlotsShared(binding, this._xmlText);

    if (collabNodeMap.get(this._key) === this) {
      collabNodeMap.delete(this._key);
    }
  }
}

export function $createCollabElementNode(
  xmlText: XmlText,
  parent: null | CollabElementNode | CollabDecoratorNode,
  type: string,
): CollabElementNode {
  const collabNode = new CollabElementNode(xmlText, parent, type);
  xmlText._collabNode = collabNode;
  return collabNode;
}
