/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from './LexicalEditor';
import type {LexicalNode, NodeMap, SerializedLexicalNode} from './LexicalNode';
import type {BaseSelection} from './LexicalSelection';

import invariant from '@lexical/internal/invariant';

import {cloneMap} from './LexicalGenMap';
import {$getSlot, $getSlotNames} from './LexicalSlot';
import {readEditorState} from './LexicalUpdates';
import {$getRoot} from './LexicalUtils';
import {
  $isElementNode,
  type SerializedElementNode,
} from './nodes/LexicalElementNode';
import {
  $createRootNode,
  type SerializedRootNode,
} from './nodes/LexicalRootNode';

export interface SerializedEditorState<
  T extends SerializedLexicalNode = SerializedLexicalNode,
> {
  root: SerializedRootNode<T>;
}

export function editorStateHasDirtySelection(
  editorState: EditorState,
  editor: LexicalEditor,
): boolean {
  const currentSelection = editor.getEditorState()._selection;

  const pendingSelection = editorState._selection;

  // Check if we need to update because of changes in selection
  if (pendingSelection !== null) {
    if (pendingSelection.dirty || !pendingSelection.is(currentSelection)) {
      return true;
    }
  } else if (currentSelection !== null) {
    return true;
  }

  return false;
}

export function cloneEditorState(current: EditorState): EditorState {
  return new EditorState(cloneMap(current._nodeMap), null, current._slotsUsed);
}

export function createEmptyEditorState(): EditorState {
  return new EditorState(new Map([['root', $createRootNode()]]), null, false);
}

function $exportNodeToJSON<SerializedNode extends SerializedLexicalNode>(
  node: LexicalNode,
): SerializedNode {
  const serializedNode = node.exportJSON();
  const nodeClass = node.constructor;

  if (serializedNode.type !== nodeClass.getType()) {
    invariant(
      false,
      'LexicalNode: Node %s does not match the serialized type. Check if .exportJSON() is implemented and it is returning the correct type.',
      nodeClass.name,
    );
  }

  if ($isElementNode(node)) {
    const serializedChildren = (serializedNode as SerializedElementNode)
      .children;
    if (!Array.isArray(serializedChildren)) {
      invariant(
        false,
        'LexicalNode: Node %s is an element but .exportJSON() does not have a children array.',
        nodeClass.name,
      );
    }

    const children = node.getChildren();

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const serializedChildNode = $exportNodeToJSON(child);
      serializedChildren.push(serializedChildNode);
    }
  }

  // Slots ride in a separate Map on every LexicalNode (an ElementNode or a
  // DecoratorNode host), so serialize them outside the element branch.
  const slotNames = $getSlotNames(node);
  if (slotNames.length > 0) {
    const serializedSlots: Record<string, SerializedLexicalNode> = {};
    for (const name of slotNames) {
      const slotNode = $getSlot(node, name);
      invariant(
        slotNode !== null,
        'LexicalNode: Node %s has slot "%s" but it resolved to no node during export.',
        nodeClass.name,
        name,
      );
      serializedSlots[name] = $exportNodeToJSON(slotNode);
    }
    (
      serializedNode as SerializedLexicalNode & {
        $slots?: Record<string, SerializedLexicalNode>;
      }
    ).$slots = serializedSlots;
  }

  // @ts-expect-error
  return serializedNode;
}

export interface EditorStateReadOptions {
  editor?: LexicalEditor | null;
}

/**
 * Type guard that returns true if the argument is an EditorState
 */
export function $isEditorState(x: unknown): x is EditorState {
  return x instanceof EditorState;
}

export class EditorState {
  _nodeMap: NodeMap;
  _selection: null | BaseSelection;
  _flushSync: boolean;
  _readOnly: boolean;
  /**
   * True if this EditorState was parsed without running transforms
   */
  _parsed: boolean;
  /**
   * True if this EditorState or the LexicalEditor that created it has
   * ever used slots
   */
  _slotsUsed: boolean;

  constructor(
    nodeMap: NodeMap,
    selection: null | BaseSelection = null,
    slotsUsed: boolean = false,
  ) {
    this._nodeMap = nodeMap;
    this._selection = selection || null;
    this._flushSync = false;
    this._readOnly = false;
    this._parsed = false;
    this._slotsUsed = slotsUsed;
  }

  isEmpty(): boolean {
    // `<= 1` rather than `=== 1`: a state whose node map is empty has not even
    // got a root, which is emptier still, and every caller treats an empty
    // state as one not to use — `setEditorState` refuses it with an invariant
    // rather than committing an editor with no root for `$getRoot` to find.
    return this._nodeMap.size <= 1 && this._selection === null;
  }

  read<V>(callbackFn: () => V, options?: EditorStateReadOptions): V {
    return readEditorState(
      (options && options.editor) || null,
      this,
      callbackFn,
    );
  }

  clone(selection?: null | BaseSelection): EditorState {
    const editorState = new EditorState(
      this._nodeMap,
      selection === undefined ? this._selection : selection,
      this._slotsUsed,
    );
    editorState._readOnly = true;
    // A clone describes the same content as this state, so it is still
    // "parsed without running transforms" if this one was. Dropping the flag
    // made `setEditorState(parsedState.clone(null))` — the documented way to
    // apply a state without focusing the editor — skip the dirty-marking that
    // lets transforms and hydrate-time normalization run.
    editorState._parsed = this._parsed;

    return editorState;
  }
  toJSON(): SerializedEditorState {
    return readEditorState(null, this, () => ({
      root: $exportNodeToJSON($getRoot()),
    }));
  }
}
