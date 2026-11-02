/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from './LexicalEditor';
import type {
  LexicalNode,
  NodeKey,
  NodeMap,
  ParsableSerializedNode,
  SerializedLexicalNode,
  SerializedPartial,
} from './LexicalNode';
import type {BaseSelection} from './LexicalSelection';

import invariant from '@lexical/internal/invariant';

import {cloneMap} from './LexicalGenMap';
import {$exportNodeJSON, $withCompactExport} from './LexicalSerializedExport';
import {$getSlot, $getSlotNames} from './LexicalSlot';
import {readEditorState} from './LexicalUpdates';
import {$getRoot, INTERNAL_$withExportMemo} from './LexicalUtils';
import {
  $isElementNode,
  type SerializedElementNode,
} from './nodes/LexicalElementNode';
import {
  $createRootNode,
  type SerializedRootNode,
} from './nodes/LexicalRootNode';

export interface SerializedEditorState {
  root: SerializedRootNode;
}

/**
 * A document written in the compact form, which omits from every node the
 * properties parsing restores on its own. The two forms describe the same
 * document, and both parse; this one is smaller and can only be read by a
 * Lexical new enough to restore what it left out.
 *
 * Distinct from {@link SerializedEditorState} because the shapes differ:
 * a property the form omitted is absent, so promising the full type would
 * promise values that are not there.
 */
export interface CompactSerializedEditorState {
  root: SerializedPartial<SerializedRootNode>;
}

/**
 * A document as a structural subtree — what {@link $parseSerializedNode}
 * accepts at every level — for a caller holding serialized nodes rather than
 * a `SerializedEditorState`: `@lexical/clipboard`'s `BaseSerializedNode[]`
 * from `$generateJSONFromSelectedNodes`, whose `version` is optional and whose
 * interface carries no index signature, matched neither of the two forms
 * above and could not be handed back to `parseEditorState` without a cast.
 */
export interface ParsableSerializedEditorState {
  root: ParsableSerializedNode;
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
  const nodeClass = node.constructor;

  // The active export decides the form: the compact form drops properties that
  // parsing would restore from their schema default anyway.
  const serializedNode = $exportNodeJSON(node);

  if ($isElementNode(node)) {
    const serializedChildren = (serializedNode as SerializedElementNode)
      .children;
    const children = node.getChildren();

    for (let i = 0; i < children.length; i++) {
      serializedChildren.push($exportNodeToJSON(children[i]));
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
    serializedNode.$slots = serializedSlots;
  }

  // @ts-expect-error
  return serializedNode;
}

export interface EditorStateReadOptions {
  editor?: LexicalEditor | null;
}

/**
 * An entry of EditorState#_textEdits, one change of a text node's text:
 * - `splice`: the node, the offset, the number of characters deleted there,
 *   the text inserted there, and the node's text before;
 * - `split`: the node split, its parts in order (the first is the node
 *   itself unless it was segmented), where each starts in its text, and its
 *   text before;
 * - `merge`: the node kept, the node merged into it, whether that node was
 *   before it, and the texts of both before;
 * - `set`: any other change (the text set whole, offsets unknown): the
 *   node, and its text before and after;
 * - `move`: characters moved from the start of a node to the end of its
 *   previous sibling (an entity grown over the text after it, see
 *   INTERNAL_$recordTextMove): the node they left, the node they joined, how
 *   many, and the texts of both before (where they were all of the node they
 *   left, its `detach` follows);
 * - `retype`: a node remade as a node of another type with the same text
 *   (an entity made plain text, or plain text made an entity, see
 *   INTERNAL_$recordTextRetype), after the replaced node's `detach` and the
 *   new node's `attach`: the node replaced, the new node, and the text;
 * - `attach`: a node inserted into an element's children: the node, the
 *   element, its previous and next siblings there (null at an end), and its
 *   text when it is a text node;
 * - `detach`: a node removed from an element's children: the node and the
 *   element;
 * - `delete`: a node the selection removes with what it holds (before its
 *   `detach`): the node.
 * @internal
 */
export type TextEditRecord =
  | readonly ['splice', NodeKey, number, number, string, string]
  | readonly ['split', NodeKey, readonly NodeKey[], readonly number[], string]
  | readonly ['merge', NodeKey, NodeKey, boolean, string, string]
  | readonly ['set', NodeKey, string, string]
  | readonly ['move', NodeKey, NodeKey, number, string, string]
  | readonly ['retype', NodeKey, NodeKey, string]
  | readonly [
      'attach',
      NodeKey,
      NodeKey,
      NodeKey | null,
      NodeKey | null,
      string | null,
    ]
  | readonly ['detach', NodeKey, NodeKey]
  | readonly ['delete', NodeKey];

/**
 * Type guard that returns true if the argument is an EditorState
 */
export function $isEditorState(x: unknown): x is EditorState {
  return x instanceof EditorState;
}

export class EditorState {
  _nodeMap: NodeMap;
  /**
   * Nodes detached during the update, keyed by the previous node map. Yjs
   * uses these hints to distinguish moved nodes from shifted siblings. A
   * restored state must not replay hints from a different transition, and
   * weak keys avoid retaining previous editor states through this metadata.
   * @internal
   */
  _movedNodes: null | WeakMap<NodeMap, Set<NodeKey>>;
  /**
   * Text nodes a split made during the update (see TextNode#splitText),
   * keyed by the previous node map like `_movedNodes`: for each, the node it
   * was split from and the offset in that node's text where it starts (a
   * part of such a part counts from the node the first split cut). Recorded
   * only while the editor records text edits (`_recordTextEdits`): the Yjs 14
   * binding uses it to keep the characters of the part that Lexical's
   * normalization merged into another node.
   * @internal
   */
  _splitNodes: null | WeakMap<NodeMap, Map<NodeKey, [NodeKey, number]>>;
  /**
   * The changes of text nodes' text during the update, in order (see
   * TextEditRecord), keyed by the previous node map like `_movedNodes`:
   * - TextNode#spliceText, with its exact offsets, as the selection's text
   *   insertion and removal make it, and the nodes the selection removes
   *   whole;
   * - the splits and merges of text nodes;
   * - text moved between two nodes and text remade in a node of another
   *   type, where the code that does it says so (text entities);
   * - any other setTextContent, with the text before and after;
   * - every node inserted into or removed from an element's children, with
   *   where, so that a node swapped for another (as transforms do) is seen
   *   where it was.
   * Recorded only while the editor records text edits (`_recordTextEdits`):
   * the Yjs 14 binding writes these edits rather than a diff of the old and
   * new text, which cannot tell where an insert or delete next to equal text
   * was made.
   * @internal
   */
  _textEdits: null | WeakMap<NodeMap, TextEditRecord[]>;
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
    this._movedNodes = null;
    this._splitNodes = null;
    this._textEdits = null;
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
  /**
   * This document's JSON, in the legacy form that writes every property.
   *
   * The form is this call's to state, never inherited: called with no argument
   * — including by `JSON.stringify`, for which this is the `toJSON` hook — it
   * writes the legacy form whatever {@link $withCompactExport} encloses it.
   * That is what makes this signature true, and it is the behavior that
   * predates the compact form.
   *
   * A nested editor still follows the document containing it, because
   * {@link LexicalEditor.toJSON} passes the enclosing form on explicitly
   * rather than leaving it to be picked up here.
   */
  toJSON(compact?: false): SerializedEditorState;
  /**
   * @param compact Write the compact form, which omits from every node the
   *   properties parsing restores on its own. Passing the form here rather
   *   than through an enclosing {@link $withCompactExport} is what lets the
   *   return type say which shape it is.
   */
  toJSON(compact: boolean): CompactSerializedEditorState;
  toJSON(compact?: unknown): CompactSerializedEditorState {
    // `typeof compact === 'boolean'`, not a truthy test, because
    // `JSON.stringify` invokes this hook with the *property name* the value is
    // under: `''` at the top level, but `'state'` for
    // `JSON.stringify({state: editorState})`. A truthy check would silently
    // write the compact form for the latter. Anything that is not a stated
    // form is the legacy one, which is what both overloads promise.
    return $withCompactExport(typeof compact === 'boolean' && compact, () =>
      readEditorState(null, this, () =>
        INTERNAL_$withExportMemo(() => ({
          root: $exportNodeToJSON($getRoot()) as SerializedRootNode,
        })),
      ),
    );
  }
}
