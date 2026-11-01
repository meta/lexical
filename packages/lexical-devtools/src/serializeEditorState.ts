/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {SerializedRawEditorState} from './types';
import type {EditorState} from 'lexical';

// Because we want to restore state to it's original form as it comes back from the store we need to keep original references
// this is a temporary solution that shall be replaced with a deserialization from serialized form
const deserealizationMap = new Map<number, EditorState>();
let nextId = 0;

const OBFUSCATION_CHAR = '*';

export interface SerializeEditorStateOptions {
  /**
   * Replace the text carried by each node with a same-length mask.
   *
   * Serialized editor state is relayed through the extension store and
   * mirrored into every surface of the extension. Keeping text out of that
   * relay unless somebody is actually looking at it keeps the relayed data
   * to what the UI needs.
   *
   * Note that this affects the *serialized copy* only. `setEditorState` round
   * trips through `deserealizationMap`, which holds the untouched original, so
   * masking here never writes masked text back into an editor.
   */
  obfuscateText?: boolean;
}

const serializePoint = (point: object) => {
  const newPoint: {
    [key: string]: unknown;
  } = {};

  for (const [key, value] of Object.entries(point)) {
    if (key !== '_selection') {
      newPoint[key] = value;
    }
  }

  return newPoint;
};

/**
 * Shallow-copy a node with its text masked.
 *
 * The node map holds live references to the editor's own nodes, so the copy is
 * essential -- masking in place would corrupt the editor itself.
 */
const obfuscateNode = (node: unknown): unknown => {
  if (typeof node !== 'object' || node === null || !('__text' in node)) {
    return node;
  }

  const text = (node as {__text: unknown}).__text;
  if (typeof text !== 'string' || text.length === 0) {
    return node;
  }

  return Object.assign(Object.create(Object.getPrototypeOf(node)), node, {
    __text: OBFUSCATION_CHAR.repeat(text.length),
  });
};

export function deserializeEditorState(
  editorState: SerializedRawEditorState,
): EditorState {
  if (
    'deserealizationID' in editorState &&
    typeof editorState.deserealizationID === 'number'
  ) {
    const state = deserealizationMap.get(editorState.deserealizationID);
    if (state == null) {
      throw new Error(
        `Can't find deserealization ref for state with id ${editorState.deserealizationID}`,
      );
    }

    return state;
  }

  throw new Error(`State doesn't have a deserealizationID`);
}

// The existing editorState.toJSON() does not contain lexicalKeys, and selection info
// therefore, we have a custom serializeEditorState helper
export function serializeEditorState(
  editorState: EditorState,
  {obfuscateText = false}: SerializeEditorStateOptions = {},
): SerializedRawEditorState {
  const entries = Array.from(editorState._nodeMap, ([key, node]) => [
    key,
    obfuscateText ? obfuscateNode(node) : node,
  ]);
  const nodeMap = Object.fromEntries(entries); // convert from Map structure to JSON-friendly object

  const selection = editorState._selection
    ? Object.assign({}, editorState._selection)
    : null;

  if (
    selection &&
    'anchor' in selection &&
    typeof selection.anchor === 'object' &&
    selection.anchor != null
  ) {
    // remove _selection.anchor._selection property if present in RangeSelection or TableSelection
    // otherwise, the recursive structure makes the selection object unserializable
    selection.anchor = serializePoint(selection.anchor);
  }
  if (
    selection &&
    'focus' in selection &&
    typeof selection.focus === 'object' &&
    selection.focus != null
  ) {
    // remove _selection.anchor._selection property if present in RangeSelection or TableSelection
    // otherwise, the recursive structure makes the selection object unserializable
    selection.focus = serializePoint(selection.focus);
  }

  const myID = nextId++;
  deserealizationMap.set(myID, editorState);

  return Object.assign({}, editorState, {
    _nodeMap: nodeMap,
    _selection: selection,
    deserealizationID: myID,
    toJSON: undefined,
  });
}
