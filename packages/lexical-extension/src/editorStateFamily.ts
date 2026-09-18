/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createNodeSelection,
  $createRangeSelection,
  $getRoot,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $parseSerializedNode,
  type BaseSelection,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedEditorState,
  type SerializedLexicalNode,
  type SerializedRootNode,
} from 'lexical';

/**
 * The two slot links, which live on {@link SlotHostNode} and its children
 * rather than on every node. Both are NodeKeys, like the tree links, so they
 * are carried and remapped the same way.
 */
interface SlotLinks {
  __slots?: null | Map<string, NodeKey>;
  __slotHost?: null | NodeKey;
}

/**
 * A family of EditorStates is a set of versions of one document — the current
 * state of an editor and the entries of its undo and redo stacks, say.
 *
 * Serializing each of those states on its own (with `toJSON()`) and parsing
 * each one back (with `parseEditorState`) is lossy in two ways that matter:
 *
 * - **Structural sharing is lost.** Lexical clones only the nodes an update
 *   touches, so consecutive versions of a document share nearly all of their
 *   node objects. Independently parsed states share none, so the restored
 *   history costs memory proportional to its depth times the size of the
 *   document, where the original cost the size of the document plus its edits.
 * - **Key stability is lost.** `parseEditorState` mints a fresh NodeKey for
 *   every node, so independently parsed versions have disjoint key spaces.
 *   Reconciliation is a diff over NodeKeys, so undoing to such a state rebuilds
 *   the whole DOM and remounts every decorator instead of touching what
 *   actually changed.
 *
 * This module serializes a family as one payload instead: a table of the
 * distinct node *versions* across all of the states (a node that several
 * states share appears once), plus, per state, the list of versions its node
 * map is built from. Restoring rebuilds each version once and assembles the
 * node maps from those shared objects, so both properties survive: a node that
 * two states shared before is one object in both again, and every version of a
 * node answers to the same key.
 *
 * The payload is plain data — no `LexicalNode`s, no class references — so it
 * can be handed to another instance of the same module, which is what makes it
 * usable across a hot reload that replaced the node classes.
 *
 * @internal
 */
export interface SerializedEditorStateFamily {
  /** Every distinct node version across the family, in no particular order. */
  nodes: SerializedNodeVersion[];
  /** One entry per state, in the order the states were given. */
  states: SerializedFamilyState[];
}

/**
 * One version of one node: its own serialized form, with the tree links kept
 * beside it rather than nested. `exportJSON()` describes a node's own data and
 * leaves `children` empty — the recursive walk lives in `EditorState.toJSON`,
 * not in the node — and every link Lexical stores is a NodeKey, so a version
 * can be described, and restored, without touching any other node.
 */
interface SerializedNodeVersion {
  json: SerializedLexicalNode;
  key: NodeKey;
  parent: null | NodeKey;
  prev: null | NodeKey;
  next: null | NodeKey;
  /** Elements only. */
  first?: null | NodeKey;
  last?: null | NodeKey;
  size?: number;
  /** Slot hosts only. */
  slots?: [string, NodeKey][];
  /** Slot children only: the up-link that takes the place of `parent`. */
  slotHost?: null | NodeKey;
}

interface SerializedFamilyPoint {
  key: NodeKey;
  offset: number;
  type: 'element' | 'text';
}

type SerializedFamilySelection =
  | {
      anchor: SerializedFamilyPoint;
      focus: SerializedFamilyPoint;
      format: number;
      style: string;
      type: 'range';
    }
  | {keys: NodeKey[]; type: 'node'};

interface SerializedFamilyState {
  /** Indices into {@link SerializedEditorStateFamily.nodes}. */
  nodes: number[];
  selection: SerializedFamilySelection | null;
}

/**
 * The state the scratch parse starts from. Its content is thrown away — the
 * parse is only there to give the node versions an editor state to be
 * constructed in.
 */
const SCRATCH_STATE_JSON: SerializedEditorState = {
  root: {
    children: [],
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
};

function serializeSelection(
  selection: null | BaseSelection,
): SerializedFamilySelection | null {
  if ($isRangeSelection(selection)) {
    return {
      anchor: {
        key: selection.anchor.key,
        offset: selection.anchor.offset,
        type: selection.anchor.type,
      },
      focus: {
        key: selection.focus.key,
        offset: selection.focus.offset,
        type: selection.focus.type,
      },
      format: selection.format,
      style: selection.style,
      type: 'range',
    };
  }
  if ($isNodeSelection(selection)) {
    return {keys: [...selection._nodes], type: 'node'};
  }
  // A TableSelection (or any other implementation) is left behind rather than
  // half-restored.
  return null;
}

function $serializeNodeVersion(node: LexicalNode): SerializedNodeVersion {
  // exportJSON hands its caller a fresh object to own — $exportNodeToJSON
  // fills in the children of the one it gets the same way — so the nested
  // containers are dropped in place. They are rebuilt from the links below;
  // leaving them in would restore a node's children a second time, once per
  // version, which is the duplication this format exists to avoid.
  const json = node.exportJSON();
  delete (json as {children?: unknown}).children;
  delete (json as {$slots?: unknown}).$slots;
  const version: SerializedNodeVersion = {
    json,
    key: node.__key,
    next: node.__next,
    parent: node.__parent,
    prev: node.__prev,
  };
  if ($isElementNode(node)) {
    version.first = node.__first;
    version.last = node.__last;
    version.size = node.__size;
  }
  const {__slotHost, __slots} = node as LexicalNode & SlotLinks;
  if (__slots != null) {
    version.slots = [...__slots];
  }
  if (__slotHost != null) {
    version.slotHost = __slotHost;
  }
  return version;
}

/**
 * Serializes `states` into a single payload of plain data, sharing one node
 * table across all of them.
 *
 * @internal
 */
export function serializeEditorStateFamily(
  states: readonly EditorState[],
): SerializedEditorStateFamily {
  const ids = new Map<LexicalNode, number>();
  const nodes: SerializedNodeVersion[] = [];
  const serializedStates = states.map(
    (state): SerializedFamilyState =>
      // exportJSON reads through getLatest(), so each state's nodes are
      // serialized with that state active.
      state.read(() => {
        const stateNodes: number[] = [];
        for (const node of state._nodeMap.values()) {
          let id = ids.get(node);
          if (id === undefined) {
            id = nodes.length;
            ids.set(node, id);
            nodes.push($serializeNodeVersion(node));
          }
          stateNodes.push(id);
        }
        return {
          nodes: stateNodes,
          selection: serializeSelection(state._selection),
        };
      }),
  );
  return {nodes, states: serializedStates};
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return raw != null && typeof raw === 'object';
}

/** A NodeKey link, which is a key or nothing. */
function isLink(raw: unknown): boolean {
  return raw === null || raw === undefined || typeof raw === 'string';
}

function isSerializedNodeVersion(raw: unknown): boolean {
  if (!isObject(raw)) {
    return false;
  }
  const {first, json, key, last, next, parent, prev, size, slotHost, slots} =
    raw;
  return (
    isObject(json) &&
    typeof json.type === 'string' &&
    typeof key === 'string' &&
    isLink(parent) &&
    isLink(prev) &&
    isLink(next) &&
    isLink(first) &&
    isLink(last) &&
    (size === undefined || typeof size === 'number') &&
    isLink(slotHost) &&
    (slots === undefined ||
      (Array.isArray(slots) &&
        slots.every(
          slot =>
            Array.isArray(slot) &&
            slot.length === 2 &&
            typeof slot[0] === 'string' &&
            typeof slot[1] === 'string',
        )))
  );
}

function isSerializedFamilyPoint(raw: unknown): boolean {
  return (
    isObject(raw) &&
    typeof raw.key === 'string' &&
    typeof raw.offset === 'number' &&
    (raw.type === 'text' || raw.type === 'element')
  );
}

function isSerializedFamilySelection(raw: unknown): boolean {
  if (raw === null || raw === undefined) {
    return true;
  }
  if (!isObject(raw)) {
    return false;
  }
  if (raw.type === 'node') {
    return (
      Array.isArray(raw.keys) && raw.keys.every(key => typeof key === 'string')
    );
  }
  return (
    raw.type === 'range' &&
    isSerializedFamilyPoint(raw.anchor) &&
    isSerializedFamilyPoint(raw.focus) &&
    typeof raw.format === 'number' &&
    typeof raw.style === 'string'
  );
}

/**
 * Whether `raw` is a payload this build can rebuild.
 *
 * Checked field by field rather than at the surface: the payload comes from
 * whichever build of this module wrote it, and one that describes a node
 * version or a selection differently would otherwise be found out partway
 * through rebuilding, where a throw costs the caller the whole document
 * instead of being reported as a payload it cannot read.
 *
 * @internal
 */
export function isSerializedEditorStateFamily(
  raw: unknown,
): raw is SerializedEditorStateFamily {
  if (!isObject(raw)) {
    return false;
  }
  const {nodes, states} = raw;
  return (
    Array.isArray(nodes) &&
    Array.isArray(states) &&
    nodes.every(isSerializedNodeVersion) &&
    states.every(
      state =>
        isObject(state) &&
        Array.isArray(state.nodes) &&
        state.nodes.every(
          id => typeof id === 'number' && id >= 0 && id < nodes.length,
        ) &&
        isSerializedFamilySelection(state.selection),
    )
  );
}

function $buildNodeVersion(
  json: SerializedLexicalNode,
  editor: LexicalEditor,
): LexicalNode {
  if (json.type !== 'root') {
    return $parseSerializedNode(json);
  }
  // RootNode.importJSON returns the active editor state's root rather than a
  // new node, and updateFromJSON writes through getWritable(), so root
  // versions built in one parse would all be the same object — sharing one
  // NodeState, which the last of them to be parsed would clear. Giving each
  // one its own parse gives each one its own root. parseEditorState saves and
  // restores the active state, so nesting a parse inside one is safe.
  let root: LexicalNode | undefined;
  editor.parseEditorState({root: json as SerializedRootNode}, () => {
    root = $getRoot();
  });
  if (root === undefined) {
    throw new Error('editorStateFamily: the root version did not parse');
  }
  return root;
}

function $restoreSelection(
  serialized: SerializedFamilySelection | null | undefined,
  keys: ReadonlyMap<NodeKey, NodeKey>,
): null | BaseSelection {
  // `== null`: a payload from another build may have no selection at all
  // rather than a null one, and reading `.type` off that would cost the
  // caller the whole document over a caret.
  if (serialized == null) {
    return null;
  }
  if (serialized.type === 'node') {
    const selection = $createNodeSelection();
    for (const key of serialized.keys) {
      const restored = keys.get(key);
      if (restored === undefined) {
        return null;
      }
      selection._nodes.add(restored);
    }
    return selection;
  }
  const anchorKey = keys.get(serialized.anchor.key);
  const focusKey = keys.get(serialized.focus.key);
  if (anchorKey === undefined || focusKey === undefined) {
    return null;
  }
  const selection = $createRangeSelection();
  selection.anchor.key = anchorKey;
  selection.anchor.offset = serialized.anchor.offset;
  selection.anchor.type = serialized.anchor.type;
  selection.focus.key = focusKey;
  selection.focus.offset = serialized.focus.offset;
  selection.focus.type = serialized.focus.type;
  selection.format = serialized.format;
  selection.style = serialized.style;
  return selection;
}

/**
 * Rebuilds the states of a family for `editor`, preserving the sharing and the
 * key relationships they had when they were serialized.
 *
 * The keys are new ones minted by this editor rather than the keys the
 * previous editor used — what matters is that every version of a node, in
 * every state, answers to the *same* key, and freshly minted keys cannot
 * collide with the keys this editor goes on to mint.
 *
 * Returns one entry per state, in the order they were serialized. A state
 * whose nodes cannot all be rebuilt — a node class the new editor no longer
 * registers, say — comes back as `null` rather than failing the whole family.
 *
 * The states come back with `_parsed` false, like the live states they
 * reproduce. A caller that hydrates one of them into an editor — where the
 * node classes are seeing this JSON for the first time — should set the flag
 * on that one state, so that `setEditorState` normalizes it. Leaving it set on
 * the others would make every `setEditorState` of them (each undo into a
 * history entry, over and over) dirty-mark the whole document and re-run every
 * transform on it.
 *
 * @internal
 */
export function deserializeEditorStateFamily(
  family: SerializedEditorStateFamily,
  editor: LexicalEditor,
): (EditorState | null)[] {
  const versions: (LexicalNode | null)[] = [];
  const keys = new Map<NodeKey, NodeKey>();
  let slotsUsed = false;
  let linked = false;
  const template = editor.parseEditorState(SCRATCH_STATE_JSON, () => {
    for (const version of family.nodes) {
      let node: LexicalNode | null = null;
      try {
        node = $buildNodeVersion(version.json, editor);
      } catch {
        // A version that no longer rebuilds costs the states that reference
        // it, which the caller reports; the rest of the family is still good.
        versions.push(null);
        continue;
      }
      const key = keys.get(version.key);
      if (key === undefined) {
        keys.set(version.key, node.__key);
      } else {
        node.__key = key;
      }
      versions.push(node);
    }
    const mapKey = (key: null | NodeKey): null | NodeKey =>
      key === null ? null : (keys.get(key) ?? null);
    for (const [index, version] of family.nodes.entries()) {
      const node = versions[index];
      if (node === null) {
        continue;
      }
      node.__parent = mapKey(version.parent);
      node.__prev = mapKey(version.prev);
      node.__next = mapKey(version.next);
      if ($isElementNode(node)) {
        node.__first = mapKey(version.first ?? null);
        node.__last = mapKey(version.last ?? null);
        node.__size = version.size ?? 0;
      }
      const slotted = node as LexicalNode & SlotLinks;
      if (version.slots !== undefined) {
        slotsUsed = true;
        slotted.__slots = new Map(
          version.slots.flatMap(([name, key]): [string, NodeKey][] => {
            const restored = mapKey(key);
            return restored === null ? [] : [[name, restored]];
          }),
        );
      }
      if (version.slotHost !== undefined) {
        slotted.__slotHost = mapKey(version.slotHost);
      }
    }
    linked = true;
  });

  if (!linked) {
    // parseEditorState routes a throw to `editor._onError`, which an
    // application is free to log rather than rethrow. The nodes would then be
    // built but never linked, and every state would come back describing a
    // root with no children — a blank document, where the caller expects a
    // family it could not rebuild.
    return family.states.map(() => null);
  }

  return family.states.map(serializedState => {
    const nodeMap = new Map<NodeKey, LexicalNode>();
    for (const id of serializedState.nodes) {
      const node = versions[id];
      if (node === undefined || node === null) {
        return null;
      }
      nodeMap.set(node.__key, node);
    }
    if (!nodeMap.has('root')) {
      // A state has to describe a document, which starts at a root — one
      // without it would be handed to an editor `$getRoot()` cannot read
      // from. Like a version that would not rebuild, it costs this state
      // rather than the family.
      return null;
    }
    const state = template.clone(
      $restoreSelection(serializedState.selection, keys),
    );
    state._nodeMap = nodeMap;
    state._slotsUsed = slotsUsed;
    // Inherited from the scratch parse; see the note above.
    state._parsed = false;
    return state;
  });
}
