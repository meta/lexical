/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {NodeStructureExtension} from './NodeStructureExtension';

import invariant from '@lexical/internal/invariant';
import {
  $getEditor,
  $getNodeByKey,
  $getRoot,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $getSlotNameWithinHost,
  $getState,
  $hasUpdateTag,
  $isDecoratorNode,
  $isElementNode,
  $isRootNode,
  $isSlotHost,
  $isTextNode,
  $setState,
  COLLABORATION_TAG,
  createState,
  declarePeerDependency,
  defineExtension,
  type EditorState,
  getDeclaredNodeStructure,
  HISTORIC_TAG,
  HISTORY_MERGE_TAG,
  type InitialEditorConfig,
  INTERNAL_getActiveEditorState,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  LineBreakNode,
  NODE_STATE_DIRECT,
  type NodeKey,
  RootNode,
  safeCast,
  TextNode,
} from 'lexical';

import {$getExtensionOutput} from './getExtensionDependency';
import {
  buildHandleTable,
  HANDLE_KEY_LENGTH,
  handleInTable,
  handleKey,
  type HandleTable,
  idsWithPrefix,
  MIN_BLOCK_HANDLE_LENGTH,
} from './internal/blockHandles';
import {
  $documentKey,
  deriveDuplicateId,
  derivePositionalId,
  ID_ALPHABET,
  ID_LENGTH,
} from './internal/positionalBlockId';
import {namedSignals} from './namedSignals';
import {effect, type Signal} from './signals';

export {MIN_BLOCK_HANDLE_LENGTH} from './internal/blockHandles';

const __DEV__ = process.env.NODE_ENV !== 'production';

/**
 * The most candidates an ambiguous {@link BlockHandleResult} lists, so that
 * a handle matching many blocks (of ids that are not random) stays short.
 */
const MAX_HANDLE_CANDIDATES = 10;

/**
 * Attempts to find a valid, unused id before giving up, which only a broken
 * `generateId` can exhaust.
 */
const MAX_ID_ATTEMPTS = 32;

/**
 * Tag of the follow-up update that repairs ids after a commit applied with
 * `skipTransforms` or tagged `COLLABORATION_TAG` or `HISTORIC_TAG`.
 */
const BLOCK_ID_REPAIR_TAG = 'block-id-repair';

/** The ids accepted from JSON, HTML, another replica, or `generateId`. */
const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function parseBlockId(value: unknown): string | undefined {
  return typeof value === 'string' && BLOCK_ID_PATTERN.test(value)
    ? value
    : undefined;
}

/**
 * The NodeState that stores a block's id, serialized in node JSON as
 * `"$": {"blockId": "..."}`.
 *
 * It is ordinary NodeState, so it survives clones and undo, round-trips
 * through `exportJSON`/`importJSON`, and is carried by anything that copies
 * NodeState. It is reset by `$copyNode`, so a node
 * split off another one (e.g. the new `ListItemNode` that Enter creates) starts
 * without an id instead of with a duplicate.
 *
 * A valid id is 1 to 64 characters of the base64url alphabet (`A`–`Z`,
 * `a`–`z`, `0`–`9`, `-`, `_`). Anything else reads as "no id", so the block
 * gets a new one as if it had none.
 *
 * @experimental
 */
export const blockIdState = createState('blockId', {
  parse: parseBlockId,
  resetOnCopyNode: true,
});

/**
 * Returns the id stored on `node`, or `null` if it has none.
 *
 * This reads the NodeState directly, so it also returns an id left on a node
 * that is not an identified block (a top-level list that indenting nested
 * into a list item, say); such ids are not indexed and
 * {@link $getBlockById} does not find them.
 *
 * @experimental
 */
export function $getBlockId(node: LexicalNode): string | null {
  // A value set directly with $setState is not parsed: an invalid one reads
  // as no id here too, so the block gets a valid one.
  return parseBlockId($getState(node, blockIdState)) ?? null;
}

/**
 * Returns the identified block with the given id in the active editor state,
 * or `null`. Requires {@link BlockIdExtension}.
 *
 * The lookup goes through an index kept up to date from the dirty nodes of
 * each commit and is verified against the active state, so it never returns a
 * stale node. A block created, replaced or re-keyed earlier in the same
 * update is found once that update has committed: after
 * `$getBlockById(id).replace(node)`, look the id up again in a later update.
 * The match is exact: a prefix of an id finds nothing.
 *
 * Showing blocks to a model? Use handles, which cost a few tokens instead of
 * a whole id: {@link $getBlockHandle} / {@link $resolveBlockHandle}, or
 * `handles: true` in `BlockIdHTMLExtension`.
 *
 * ```ts
 * // What the model reads, and the handles it is shown:
 * // [{block: '2bNo', text: 'Q3 plan'}, ...]
 * const [blocks, shown] = editor.read(() => [
 *   $getRoot()
 *     .getChildren()
 *     .map(node => ({block: $getBlockHandle(node), text: node.getTextContent()})),
 *   $getBlockHandles(),
 * ]);
 * // What it answers: {block: '2bNo', text: 'Q4 plan'}
 * editor.update(() => {
 *   const result = $resolveBlockHandle(op.block, {read: shown});
 *   if (result.status === 'found') {
 *     // Change the block in place, only the characters that differ (the
 *     // Block IDs page has a `$setBlockText` that does): replace() would
 *     // re-create it, and what a collaborator types in it meanwhile would
 *     // not stay where they typed it.
 *     $setBlockText(result.node, op.text);
 *   }
 * });
 * ```
 *
 * @experimental
 */
export function $getBlockById(id: string): LexicalNode | null {
  return $getExtensionOutput(BlockIdExtension).$getBlockById(id);
}

/**
 * What {@link $resolveBlockHandle} found for a handle:
 *
 * - `found`: the one identified block that the handle names.
 * - `not-found`: it names no identified block (a mistyped handle, or a block
 *   deleted since the handle was read).
 * - `ambiguous`: it names several (a handle shorter than the one shown, or,
 *   without `read`, a block added since whose handle shares its
 *   characters). `candidates` holds their handles (current ones, or with
 *   `read` the read's), at most 10.
 * - `invalid`: neither a handle nor an id. `reason` is `'too-short'` for
 *   fewer than {@link MIN_BLOCK_HANDLE_LENGTH} characters (a handle is never
 *   that short, so the model dropped a character), and `'malformed'` for
 *   anything that is not 1 to 64 characters of the base64url alphabet (or
 *   not a string).
 *
 * @experimental
 */
export type BlockHandleResult =
  | {readonly status: 'found'; readonly node: LexicalNode}
  | {readonly status: 'not-found'; readonly handle: string}
  | {
      readonly status: 'ambiguous';
      readonly handle: string;
      readonly candidates: readonly string[];
    }
  | {
      readonly status: 'invalid';
      readonly handle: string;
      readonly reason: 'too-short' | 'malformed';
    };

/**
 * Returns the handle of an identified block: a short, opaque name for it in
 * the current document, 4 to 11 characters of the base64url alphabet (`2bNo`
 * for `V1StGXR8_Z5jdHi6B-myT`). It is the shortest prefix, at least
 * {@link MIN_BLOCK_HANDLE_LENGTH} characters long, of a 64-bit hash of the
 * block's id that no other identified block's hash starts with, like a short
 * git hash. Hashing makes handles short (almost always 4 characters) and
 * typo-safe whatever the ids look like: random, a timestamp first (UUIDv7),
 * a counter, or `@lexical/y`'s derived ids. Returns `null` for a node that has no id
 * or that {@link $getBlockById} would not find by its id (one that is not
 * attached or not an identified block, a block named since the last commit,
 * or a copy whose repeated id awaits its repair). Requires
 * {@link BlockIdExtension}.
 *
 * Handles are for showing blocks to a model at a fraction of the tokens of a
 * whole id: {@link $resolveBlockHandle} takes them back. They are derived
 * from the ids of the document, never stored, so a handle can grow longer
 * when a block whose hash shares its characters is added; a handle read
 * earlier then resolves as `ambiguous` rather than to either block.
 *
 * Handles are computed all at once from the blocks of the last committed
 * state: from the index of {@link $getBlockById} while the extension is
 * enabled (cached until the ids change), and from a scan of that state while
 * it is disabled (cached until the next commit).
 *
 * @experimental
 */
export function $getBlockHandle(node: LexicalNode): string | null {
  return $getExtensionOutput(BlockIdExtension).$getBlockHandle(node);
}

/**
 * Returns the handle of every identified block, by id (see
 * {@link $getBlockHandle}). The map is a new one on each call.
 * Requires {@link BlockIdExtension}.
 *
 * @experimental
 */
export function $getBlockHandles(): Map<string, string> {
  return $getExtensionOutput(BlockIdExtension).$getBlockHandles();
}

/**
 * Finds the identified block that a handle from {@link $getBlockHandle}
 * names, for input that cannot be trusted (a language model's answer): it
 * reports a mistyped, outdated or invalid handle in a
 * {@link BlockHandleResult} instead of throwing. It returns a block only when
 * the handle names exactly one. Requires {@link BlockIdExtension}.
 *
 * A handle has 4 to 11 characters (fewer is `invalid`, reason
 * `'too-short'`), and names the blocks whose hash it starts. A handle that
 * was longer when it was read still finds its block. A string longer than 11
 * characters is taken as a whole id instead, so a whole id of 12 characters
 * or more is accepted too; only handles are typo-safe.
 *
 * Without options, a handle names whichever block it names now, not the
 * block it was read from: if that block was deleted and a block added since
 * has a hash that starts the same way, it names that block. Whenever the
 * document can change between the read and the edit, pass the handles the
 * model was shown as {@link BlockHandleOptions.read}: the handle then names
 * the block it named in the read, `found` while that block still exists and
 * `not-found` once it is deleted.
 *
 * Resolve against the latest state, so that deletions since the read count:
 * in the update that applies the edit in a live editor; with `@lexical/y` on
 * a server, in a `readYState` of the stored state, before the edit is applied
 * by id to the state the model read and merged (see "Showing blocks to a
 * model" in the Block IDs documentation). Like {@link $getBlockById}, a block
 * created earlier in the same update is found once that update has
 * committed.
 *
 * @experimental
 */
export function $resolveBlockHandle(
  handle: string,
  options?: BlockHandleOptions,
): BlockHandleResult {
  return $getExtensionOutput(BlockIdExtension).$resolveBlockHandle(
    handle,
    options,
  );
}

/**
 * Options of {@link $resolveBlockHandle}.
 *
 * @experimental
 */
export interface BlockHandleOptions {
  /**
   * The handles the model was shown, as {@link $getBlockHandles} returned
   * them at the read (id → handle). With it, a handle names the block it
   * named in that read, and is `found` only while that block still exists:
   * `not-found` once it is deleted, even if another block's id now starts
   * with the handle, and never `ambiguous` because of a block added since.
   * Mistyped handles fail against the read's ids. Pass it whenever the
   * document can change between the read and the edit.
   */
  read?: ReadonlyMap<string, string>;
}

/**
 * A {@link BlockIdConfig.$isIdentifiedBlock} that identifies every element
 * and decorator child of the root, and nothing nested. Use it when only
 * top-level blocks are addressed:
 *
 * ```ts
 * configExtension(BlockIdExtension, {$isIdentifiedBlock: $isRootChildBlock});
 * ```
 *
 * @experimental
 */
export function $isRootChildBlock(node: LexicalNode): boolean {
  return (
    ($isElementNode(node) || $isDecoratorNode(node)) &&
    $isRootNode(node.getParent())
  );
}

/** Whether a class declares that it holds text (`children` allows inline). */
function declaresInlineChildren(node: LexicalNode): boolean {
  const {children} = getDeclaredNodeStructure(
    node.constructor as Klass<LexicalNode>,
  );
  return (
    children === 'inline' ||
    (Array.isArray(children) && children.includes('inline'))
  );
}

/**
 * The default {@link BlockIdConfig.$isIdentifiedBlock}:
 *
 * - every element and decorator child of the root ({@link $isRootChildBlock}),
 *   so a top-level list or table has an id too;
 * - every nested block that holds text: a non-inline element whose class
 *   declares `children: 'inline'` in `$config()` (or a list that includes
 *   `'inline'`), such as a paragraph, heading, quote or code block in a
 *   table cell, or a list item;
 * - every nested non-inline decorator.
 *
 * Nested wrappers get no id: nested lists, table rows and cells, shadow roots
 * (a shadow root quote holds blocks, whatever its class declares), and
 * nested elements whose class declares no `children`. A slot is nested like
 * a shadow root, so blocks in slots follow the same rules. Compose it to
 * identify more:
 *
 * ```ts
 * configExtension(BlockIdExtension, {
 *   $isIdentifiedBlock: (node) =>
 *     $defaultIsIdentifiedBlock(node) || $isTableCellNode(node),
 * });
 * ```
 *
 * @experimental
 */
export function $defaultIsIdentifiedBlock(node: LexicalNode): boolean {
  if (!$isElementNode(node) && !$isDecoratorNode(node)) {
    return false;
  }
  const parent = node.getParent();
  if ($isRootNode(parent)) {
    return true;
  }
  if ((parent === null && $getSlotHost(node) === null) || node.isInline()) {
    return false;
  }
  if (!$isElementNode(node)) {
    // A block decorator.
    return true;
  }
  return !node.isShadowRoot() && declaresInlineChildren(node);
}

/**
 * The default {@link BlockIdConfig.generateId}: 21 characters of the
 * base64url alphabet (126 random bits, more than the 122 of a version 4
 * UUID), from `crypto.getRandomValues`. Ids need no coordination between
 * independent writers (replicas, servers, agents): ids made independently practically never
 * collide, and a mistyped id (from a language model, say) almost never names
 * another block.
 *
 * There is no weaker fallback: where `crypto.getRandomValues` is missing
 * (React Native without a polyfill, for instance), it throws, and the editor
 * must be given a `generateId` of its own.
 *
 * @experimental
 */
export function generateBlockId(): string {
  const cryptoImpl = typeof crypto === 'undefined' ? undefined : crypto;
  invariant(
    cryptoImpl !== undefined &&
      typeof cryptoImpl.getRandomValues === 'function',
    'generateBlockId: crypto.getRandomValues is not available; configure BlockIdExtension with a generateId of your own',
  );
  const bytes = new Uint8Array(ID_LENGTH);
  cryptoImpl.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < bytes.length; i++) {
    id += ID_ALPHABET[bytes[i] & 63];
  }
  return id;
}

/** @experimental */
export interface BlockIdConfig {
  /**
   * Set to `true` to stop assigning, repairing, and indexing ids. Ids already
   * stored on nodes are kept. While disabled, {@link $getBlockById} falls back
   * to a scan of the document.
   */
  disabled: boolean;
  /**
   * Which nodes get an id. Evaluated when a node is marked dirty, so it should
   * depend only on the node and its ancestors. Default:
   * {@link $defaultIsIdentifiedBlock} (the root's children, nested blocks
   * that hold text, and nested block decorators). Every reader of a document
   * stored without ids must use the same predicate, since positional ids
   * follow from it.
   */
  $isIdentifiedBlock: (node: LexicalNode) => boolean;
  /**
   * Makes a new id. It must return 1 to 64 characters of the base64url
   * alphabet (`A`–`Z`, `a`–`z`, `0`–`9`, `-`, `_`). A value that is invalid
   * or already used in this editor is discarded and `generateId` is called
   * again; 32 such values in a row throw. Ids made concurrently by
   * independent writers cannot see each other, so a replacement must stay
   * unique across writers (random ids of 120 bits or more, or a per-writer
   * prefix).
   *
   * Handles ({@link $getBlockHandle}) hash the ids, so they stay short and
   * typo-safe whatever the ids look like: a timestamp first (UUIDv7) or a
   * counter works as well as random ids.
   *
   * Tests can inject a deterministic counter. Default:
   * {@link generateBlockId}.
   */
  generateId: () => string;
  /**
   * Whether the follow-up update that names the blocks an update applied
   * with `skipTransforms`, or tagged `COLLABORATION_TAG` or `HISTORIC_TAG`,
   * left without a valid id or with a repeated one runs the editor's
   * transforms. With `true` (the default) it marks those blocks dirty, so
   * every transform runs on them, and `NodeStructureExtension`, for example,
   * repairs their structure in it. With `false` it sets their ids without
   * running transforms, so it changes nothing else: for code that applies
   * such updates and repairs or otherwise processes what they bring in an
   * update of its own.
   */
  repairTransforms: boolean;
}

/**
 * The output of {@link BlockIdExtension}.
 *
 * @experimental
 */
export interface BlockIdOutput {
  /** See {@link BlockIdConfig.disabled}. */
  disabled: Signal<boolean>;
  /** The same as {@link $getBlockById} for this editor. */
  $getBlockById: (id: string) => LexicalNode | null;
  /** The same as {@link $getBlockHandle} for this editor. */
  $getBlockHandle: (node: LexicalNode) => string | null;
  /** The same as {@link $getBlockHandles} for this editor. */
  $getBlockHandles: () => Map<string, string>;
  /** The same as {@link $resolveBlockHandle} for this editor. */
  $resolveBlockHandle: (
    handle: string,
    options?: BlockHandleOptions,
  ) => BlockHandleResult;
  /** The configured {@link BlockIdConfig.$isIdentifiedBlock}. */
  $isIdentifiedBlock: (node: LexicalNode) => boolean;
}

/**
 * An index of the identified blocks of the committed editor state: id → the
 * key of the block that carries it (a set of keys only while a duplicate
 * awaits repair), and key → id.
 */
class BlockIdIndex {
  readonly keysOfId = new Map<string, NodeKey | Set<NodeKey>>();
  readonly idOfKey = new Map<NodeKey, string>();
  /** Changes whenever the set of indexed ids may have changed. */
  version = 0;

  clear(): void {
    this.keysOfId.clear();
    this.idOfKey.clear();
    this.version++;
  }

  holders(id: string): Iterable<NodeKey> {
    const keys = this.keysOfId.get(id);
    return keys === undefined ? [] : typeof keys === 'string' ? [keys] : keys;
  }

  isRepeated(id: string): boolean {
    return typeof this.keysOfId.get(id) === 'object';
  }

  set(key: NodeKey, id: string): void {
    if (this.idOfKey.get(key) !== id) {
      this.remove(key);
      this.version++;
      this.idOfKey.set(key, id);
      const keys = this.keysOfId.get(id);
      if (keys === undefined) {
        this.keysOfId.set(id, key);
      } else if (typeof keys === 'string') {
        this.keysOfId.set(id, new Set([keys, key]));
      } else {
        keys.add(key);
      }
    }
  }

  remove(key: NodeKey): void {
    const id = this.idOfKey.get(key);
    if (id !== undefined) {
      this.version++;
      this.idOfKey.delete(key);
      const keys = this.keysOfId.get(id)!;
      if (typeof keys === 'string') {
        this.keysOfId.delete(id);
      } else {
        keys.delete(key);
        if (keys.size === 1) {
          this.keysOfId.set(id, keys.values().next().value!);
        }
      }
    }
  }
}

/** Per-editor state, the init result of {@link BlockIdExtension}. */
interface BlockIdRuntime {
  readonly config: BlockIdConfig;
  readonly index: BlockIdIndex;
  /** Whether `index` is being maintained (the extension is enabled). */
  active: boolean;
  /**
   * Whether a committed state with content has been seen since the extension
   * was registered. Until then, updates load content, and get positional ids.
   */
  hasContent: boolean;
  /** The ids of the blocks that `placedState` leaves unnamed. */
  placed: Map<NodeKey, string>;
  placedState: EditorState | null;
  /**
   * What earlier transform passes of the update that is building
   * `provisionalState` decided. Another root transform of the same pass (one
   * that merges, splits or lifts blocks) may change the structure after this
   * extension's, so a later pass decides again for the blocks it changes, as
   * if the update had made the final structure directly.
   */
  provisional: Map<NodeKey, ProvisionalId>;
  /** The blocks named by any pass of that update. */
  provisionalSeen: Set<NodeKey>;
  provisionalState: EditorState | null;
  /** The handles of the indexed ids, for the index version they were built at. */
  handles: (HandleView & {readonly version: number}) | null;
  /** The scan of the last committed state for handles while disabled. */
  scan: HandleScan | null;
  $getBlockById: (id: string) => LexicalNode | null;
}

const NO_PLACES: Map<NodeKey, string> = new Map();

/**
 * A generated id given to a block created in the same update, and the id it
 * gave up for it, if it was a copy that yielded to the block it was copied
 * from.
 */
interface ProvisionalId {
  readonly id: string;
  readonly yielded: string | null;
}

/**
 * Visits every node below the root except text, in document order (a host's
 * slot values, in canonical slot order, before its children). Each visit
 * returns the context passed to the visits of the node's contents.
 */
function $walk<T>(context: T, visit: (node: LexicalNode, outer: T) => T): void {
  const stack: [LexicalNode, T][] = [];
  const pushContents = (node: LexicalNode, inner: T) => {
    // Pushed in reverse, so that they pop in document order.
    if ($isElementNode(node)) {
      for (
        let child = node.getLastChild();
        child !== null;
        child = child.getPreviousSibling()
      ) {
        if (!$isTextNode(child)) {
          stack.push([child, inner]);
        }
      }
    }
    if ($isSlotHost(node)) {
      const names = $getSlotNames(node);
      for (let i = names.length - 1; i >= 0; i--) {
        const slot = $getSlot(node, names[i]);
        if (slot !== null) {
          stack.push([slot, inner]);
        }
      }
    }
  };
  pushContents($getRoot(), context);
  while (stack.length > 0) {
    const [node, outer] = stack.pop()!;
    pushContents(node, visit(node, outer));
  }
}

/**
 * Positional ids for the blocks without an id that `$isTarget` selects, the
 * same on every read and every replica (see "Id format" in the documentation):
 * SHA-256 of the document key and the block's place, its path among
 * identified blocks. A taken id is retried with `#n` appended to the place.
 * This walks and hashes the whole document.
 */
function $placeBlocks(
  runtime: BlockIdRuntime,
  $isTarget: (node: LexicalNode) => boolean,
): Map<NodeKey, string> {
  const {$isIdentifiedBlock} = runtime.config;
  const taken = new Set<string>();
  // An identified block's place among its parent frame's blocks, and a
  // counter for the blocks inside it. The root's frame has no parent.
  interface Frame {
    readonly parent: Frame | null;
    readonly index: number;
    next: number;
  }
  const targets: [NodeKey, Frame][] = [];
  const placeOf = (frame: Frame): string =>
    frame.parent === null || frame.parent.parent === null
      ? String(frame.index)
      : `${placeOf(frame.parent)}.${frame.index}`;
  $walk<Frame>({index: 0, next: 0, parent: null}, (node, frame) => {
    if (!$isIdentifiedBlock(node)) {
      return frame;
    }
    const inner = {index: frame.next++, next: 0, parent: frame};
    const id = $getBlockId(node);
    if (id !== null) {
      taken.add(id);
    } else if ($isTarget(node)) {
      targets.push([node.getKey(), inner]);
    }
    return inner;
  });
  const placed = new Map<NodeKey, string>();
  if (targets.length === 0) {
    return placed;
  }
  const documentKey = $documentKey();
  for (const [key, frame] of targets) {
    const path = placeOf(frame);
    let id = derivePositionalId(documentKey, path);
    for (let attempt = 1; taken.has(id); attempt++) {
      id = derivePositionalId(documentKey, `${path}#${attempt}`);
    }
    taken.add(id);
    placed.set(key, id);
  }
  return placed;
}

/**
 * Names the holders of a repeated id that every replica must name alike: the
 * earliest in document order keeps `id`, and the k-th later one gets
 * {@link deriveDuplicateId}(`id`, `k`), retried with `#n` appended to `k`
 * while taken. Costs O(holders), whatever the document's size.
 */
function $renameLaterHolders(
  runtime: BlockIdRuntime,
  id: string,
  holders: LexicalNode[],
  used: Set<string>,
): Map<NodeKey, string> {
  const renamed = new Map<NodeKey, string>();
  holders.sort($compareDocumentOrder);
  for (let k = 1; k < holders.length; k++) {
    let next = deriveDuplicateId(id, String(k));
    for (let n = 1; $isIdTaken(runtime, next, used); n++) {
      next = deriveDuplicateId(id, `${k}#${n}`);
    }
    used.add(next);
    renamed.set(holders[k].getKey(), next);
  }
  return renamed;
}

/**
 * The ids that the blocks `keys` of the active state should have, for those
 * it leaves unnamed: positional ids for blocks without an id, derived ids for
 * the later holders of a repeated id. Everyone who sees the same state
 * computes the same ids.
 */
function $nameUnnamed(
  runtime: BlockIdRuntime,
  keys: readonly NodeKey[],
): Map<NodeKey, string> {
  const unnamed = new Set<NodeKey>();
  const repeated = new Set<string>();
  for (const key of keys) {
    const node = $getNodeByKey(key);
    if ($isLiveIdentified(runtime, node)) {
      const id = $getBlockId(node);
      if (id === null) {
        unnamed.add(key);
      } else {
        repeated.add(id);
      }
    }
  }
  const named =
    unnamed.size > 0
      ? $placeBlocks(runtime, node => unnamed.has(node.getKey()))
      : new Map<NodeKey, string>();
  const used = new Set(named.values());
  // In code unit order, so that a retry after a collision is decided alike
  // everywhere.
  for (const id of Array.from(repeated).sort()) {
    const holders = $liveHolders(runtime, id);
    if (holders.length > 1) {
      for (const [key, next] of $renameLaterHolders(
        runtime,
        id,
        holders,
        used,
      )) {
        named.set(key, next);
      }
    }
  }
  return named;
}

declare const LiveIdentifiedBlockBrand: unique symbol;
/**
 * An attached node that the predicate identifies. Branded, so that a `false`
 * from {@link $isLiveIdentified} does not narrow its argument to `null`.
 */
type LiveIdentifiedBlock = LexicalNode & {
  readonly [LiveIdentifiedBlockBrand]: never;
};

/** The id of a frozen node of a previous state, without an active state. */
function $prevIdOf(node: undefined | LexicalNode): string | null {
  if (node === undefined) {
    return null;
  }
  return parseBlockId($getState(node, blockIdState, NODE_STATE_DIRECT)) ?? null;
}

function $isLiveIdentified(
  runtime: BlockIdRuntime,
  node: null | LexicalNode,
): node is LiveIdentifiedBlock {
  return (
    node !== null &&
    node.isAttached() &&
    runtime.config.$isIdentifiedBlock(node)
  );
}

/** Attached identified blocks of the active state that carry `id`. */
function $liveHolders(
  runtime: BlockIdRuntime,
  id: string,
  extraKeys: Iterable<NodeKey> = [],
): LexicalNode[] {
  const seen = new Set<NodeKey>();
  const result: LexicalNode[] = [];
  const visit = (key: NodeKey) => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const node = $getNodeByKey(key);
    if ($isLiveIdentified(runtime, node) && $getBlockId(node) === id) {
      result.push(node);
    }
  };
  for (const key of runtime.index.holders(id)) {
    visit(key);
  }
  for (const key of extraKeys) {
    visit(key);
  }
  return result;
}

/**
 * Whether `id` is in `used` or carried by an identified block of the active
 * state other than the block `except`.
 */
function $isIdTaken(
  runtime: BlockIdRuntime,
  id: string,
  used: Set<string>,
  except: NodeKey | null = null,
): boolean {
  return (
    used.has(id) ||
    $liveHolders(runtime, id).some(node => node.getKey() !== except)
  );
}

/** The parent of `node`, or the host of the slot that it occupies. */
function $getContainer(node: LexicalNode): LexicalNode | null {
  const parent = node.getParent();
  return parent !== null ? parent : $getSlotHost(node);
}

/**
 * Document order of two nodes of the active state (see {@link $walk}), the
 * tie-break that every replica must resolve alike: node keys cannot be
 * used for it, because each editor numbers the nodes that it receives in its
 * own order. Costs O(depth) plus a walk over the siblings between the two
 * branches.
 */
function $compareDocumentOrder(a: LexicalNode, b: LexicalNode): number {
  if (a.is(b)) {
    return 0;
  }
  // Container key → the node below it on the way up from `a`.
  const below = new Map<NodeKey, LexicalNode>();
  for (
    let child = a, container = $getContainer(a);
    container !== null;
    child = container, container = $getContainer(container)
  ) {
    below.set(container.getKey(), child);
  }
  if (below.has(b.getKey())) {
    // `b` is an ancestor of `a`.
    return 1;
  }
  for (
    let bChild = b, container = $getContainer(b);
    container !== null;
    bChild = container, container = $getContainer(container)
  ) {
    if (container.is(a)) {
      // `a` is an ancestor of `b`.
      return -1;
    }
    const aChild = below.get(container.getKey());
    if (aChild === undefined) {
      continue;
    }
    // `container` is the closest common one; compare the two branches.
    const aSlot = $getSlotNameWithinHost(aChild);
    const bSlot = $getSlotNameWithinHost(bChild);
    if (aSlot !== null || bSlot !== null) {
      if (aSlot === null || bSlot === null) {
        // Slots come before children.
        return aSlot === null ? 1 : -1;
      }
      const names = $getSlotNames(container);
      return names.indexOf(aSlot) - names.indexOf(bSlot);
    }
    const aKey = aChild.getKey();
    const bKey = bChild.getKey();
    let na: LexicalNode | null = aChild;
    let nb: LexicalNode | null = bChild;
    for (
      ;
      na !== null && nb !== null;
      na = na.getNextSibling(), nb = nb.getNextSibling()
    ) {
      if (na.getKey() === bKey) {
        return -1;
      } else if (nb.getKey() === aKey) {
        return 1;
      }
    }
    // The walk from `a` reached the end first: `b` comes before it.
    return na === null ? 1 : -1;
  }
  // Not in the same tree (cannot happen for attached nodes).
  return compareKeys(a, b);
}

/**
 * Creation order. Node keys come from a counter that only increases within
 * one JavaScript realm, so this orders nodes that one local update created;
 * it is used only for decisions that one editor makes and other replicas
 * then receive.
 */
function compareKeys(a: LexicalNode, b: LexicalNode): number {
  return Number(a.getKey()) - Number(b.getKey());
}

function $makeFreshId(runtime: BlockIdRuntime, used: Set<string>): string {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = runtime.config.generateId();
    if (
      typeof id === 'string' &&
      parseBlockId(id) === id &&
      !$isIdTaken(runtime, id, used)
    ) {
      used.add(id);
      return id;
    }
  }
  invariant(
    false,
    'BlockIdExtension: generateId returned %s ids in a row that were invalid or already in use',
    String(MAX_ID_ATTEMPTS),
  );
}

/**
 * Whether the pending update is a load: the first content since the extension
 * was registered, or a state that replaced the previous one wholesale
 * (setEditorState).
 */
function $isLoad(editor: LexicalEditor, runtime: BlockIdRuntime): boolean {
  const prevRoot = editor.getEditorState()._nodeMap.get('root');
  const prevFirst = $isElementNode(prevRoot) ? prevRoot.__first : null;
  return (
    !runtime.hasContent ||
    (prevFirst !== null && $getNodeByKey(prevFirst) === null)
  );
}

/**
 * The RootNode transform, which Lexical applies after every other transform
 * of the same pass. `candidates` holds the identified blocks marked dirty in
 * this update. The rules are those of the documentation ("How ids follow
 * edits", "Uniqueness", "Documents stored without ids"):
 *
 * 0. A block that the previous state left unnamed takes the id every reader
 *    of that state derived for it.
 * 1. A new block continues a block of the previous state (and takes its id):
 *    one that took the children of a removed block, or all the children of a
 *    block now empty (Enter at the start, which re-keys the emptied block),
 *    or one that sits where a removed block sat (or in its slot). For the
 *    children, a copy that yields its id counts as a block without one.
 * 2. Blocks without an id get one: positional in a load, generated otherwise.
 * 3. Of the blocks that share an id, the one that was identified with it in
 *    the previous state keeps it. Several such blocks (a duplicate committed
 *    by a merge, or every holder in a load) are named by document order and
 *    derived ids, alike on every replica. Otherwise a block that continues a
 *    removed holder of the id keeps it, else the first one created; the
 *    others get generated ids, in creation order.
 */
function $assignBlockIds(
  editor: LexicalEditor,
  runtime: BlockIdRuntime,
  candidates: Set<NodeKey>,
): void {
  if (candidates.size === 0) {
    return;
  }
  const keys = Array.from(candidates);
  candidates.clear();
  if ($hasUpdateTag(COLLABORATION_TAG) || $hasUpdateTag(HISTORIC_TAG)) {
    // Changes made during updates tagged COLLABORATION_TAG or HISTORIC_TAG
    // are treated as replayed and are not propagated by whoever applied
    // them: the follow-up repair update names these blocks.
    return;
  }
  const blocks: LexicalNode[] = [];
  for (const key of keys) {
    const node = $getNodeByKey(key);
    if ($isLiveIdentified(runtime, node)) {
      blocks.push(node);
    }
  }
  if (blocks.length === 0) {
    return;
  }
  const blockKeys = new Set(blocks.map(node => node.getKey()));
  const pendingState = editor._pendingEditorState;
  if (runtime.provisionalState !== pendingState) {
    runtime.provisional.clear();
    runtime.provisionalSeen.clear();
    runtime.provisionalState = pendingState;
  }
  const {provisional, provisionalSeen} = runtime;
  for (const key of blockKeys) {
    provisionalSeen.add(key);
  }
  // Whether an earlier pass of this update generated the block's id because
  // it had none, so lineage found now may still replace it. (A copy that
  // yielded its id is not: it is decided as a holder of that id, below.)
  const isProvisional = (node: LexicalNode): boolean => {
    const entry = provisional.get(node.getKey());
    return (
      entry !== undefined &&
      entry.yielded === null &&
      entry.id === $getBlockId(node)
    );
  };
  // A copy that yielded its id in an earlier pass takes it back when no
  // block holds it any more (the original was merged into it since); the
  // rules below then decide between several such copies.
  for (const node of blocks) {
    const entry = provisional.get(node.getKey());
    if (
      entry !== undefined &&
      entry.yielded !== null &&
      entry.id === $getBlockId(node) &&
      $liveHolders(runtime, entry.yielded, provisionalSeen).length === 0
    ) {
      provisional.delete(node.getKey());
      $setState(node, blockIdState, entry.yielded);
    }
  }
  const prevState = editor.getEditorState();
  const prevNodeMap = prevState._nodeMap;
  const {index} = runtime;
  const used = new Set<string>();
  const placedBefore =
    runtime.placedState === prevState ? runtime.placed : NO_PLACES;
  // The id a block had in the previous state, counting the one its readers
  // derived when that state left it unnamed.
  const prevIdOfKey = (key: NodeKey): string | null => {
    const placed = placedBefore.get(key);
    return placed !== undefined ? placed : $prevIdOf(prevNodeMap.get(key));
  };
  // Whether the block was identified with `id` in the previous state. An id
  // left on a block that was not identified is not reserved.
  const heldBefore = (key: NodeKey, id: string): boolean =>
    placedBefore.get(key) === id || index.idOfKey.get(key) === id;
  // New key → key of the previous-state block it continues.
  const lineage = new Map<NodeKey, NodeKey>();
  // Removed in this update: still in the pending node map, detached. A key
  // missing altogether belongs to a state replaced wholesale.
  const $isRemoved = (key: null | NodeKey): key is NodeKey => {
    if (key === null) {
      return false;
    }
    const node = $getNodeByKey(key);
    return node !== null && !node.isAttached();
  };
  const isLoad = $isLoad(editor, runtime);
  const $inherit = (node: LexicalNode, id: string, fromKey: NodeKey) => {
    lineage.set(node.getKey(), fromKey);
    provisional.delete(node.getKey());
    used.add(id);
    if ($getBlockId(node) !== id) {
      $setState(node, blockIdState, id);
    }
  };

  // 0. Blocks the previous state left unnamed.
  if (placedBefore.size > 0) {
    for (const node of blocks) {
      const key = node.getKey();
      const placed = placedBefore.get(key);
      const id = $getBlockId(node);
      if (
        placed !== undefined &&
        (id === null || id === $prevIdOf(prevNodeMap.get(key))) &&
        !$isIdTaken(runtime, placed, used, key)
      ) {
        $inherit(node, placed, key);
      }
    }
  }

  // Whether a new block takes lineage by children as if it had no id: its id
  // `id` was generated by an earlier pass of this update, or it is a copy
  // that yields `id` in step 3 to a block that was identified with it before
  // the update and still holds it.
  const $isIdLess = (node: LexicalNode, id: string): boolean => {
    const entry = provisional.get(node.getKey());
    return (
      (entry !== undefined && entry.id === id) ||
      $liveHolders(runtime, id).some(
        holder => !holder.is(node) && heldBefore(holder.getKey(), id),
      )
    );
  };

  // 1a. Lineage by children. The first child decides, unless it is new: then
  // the first child that comes from a removed block does.
  const newBlocks = blocks.filter(node => !prevNodeMap.has(node.getKey()));
  for (const node of newBlocks) {
    if (!$isElementNode(node)) {
      continue;
    }
    const firstChild = node.getFirstChild();
    let sourceKey: NodeKey | null = null;
    for (
      let child = firstChild;
      child !== null && sourceKey === null;
      child = child.getNextSibling()
    ) {
      const prevChild = prevNodeMap.get(child.getKey());
      if (prevChild !== undefined && prevChild.__parent !== null) {
        if (child === firstChild || $isRemoved(prevChild.__parent)) {
          sourceKey = prevChild.__parent;
        }
      }
    }
    if (sourceKey === null) {
      continue;
    }
    const ownId = $getBlockId(node);
    const id = prevIdOfKey(sourceKey);
    if (
      id === null ||
      (ownId !== null && ownId !== id && !$isIdLess(node, ownId))
    ) {
      continue;
    }
    if ($isRemoved(sourceKey)) {
      // Replaced, e.g. by $setBlocksType, or merged into this block.
      if (!$isIdTaken(runtime, id, used, sourceKey)) {
        $inherit(node, id, sourceKey);
      }
      continue;
    }
    const source = $getNodeByKey(sourceKey);
    const prevSource = prevNodeMap.get(sourceKey);
    if (
      firstChild !== null &&
      $isElementNode(source) &&
      source.isAttached() &&
      source.getChildrenSize() === 0 &&
      $isElementNode(prevSource) &&
      prevSource.__first === firstChild.getKey() &&
      $getBlockId(source) === id &&
      !used.has(id)
    ) {
      // All of the content moved on (Enter at the start): the id follows it.
      $setState(source, blockIdState, $makeFreshId(runtime, used));
      $inherit(node, id, sourceKey);
    }
  }

  // 1b. Lineage by position, for the remaining new blocks without an id.
  const resolved = new Set<NodeKey>();
  const $resolvePosition = (start: LexicalNode) => {
    const stack: LexicalNode[] = [start];
    while (stack.length > 0) {
      const node = stack[stack.length - 1];
      const key = node.getKey();
      if (resolved.has(key)) {
        stack.pop();
        continue;
      }
      const prevSibling = node.getPreviousSibling();
      if (
        prevSibling !== null &&
        !prevNodeMap.has(prevSibling.getKey()) &&
        blockKeys.has(prevSibling.getKey()) &&
        !resolved.has(prevSibling.getKey())
      ) {
        // A run of replaced blocks is matched against the removed run in
        // order: resolve the new block before this one first.
        stack.push(prevSibling);
        continue;
      }
      stack.pop();
      resolved.add(key);
      if (
        lineage.has(key) ||
        ($getBlockId(node) !== null && !isProvisional(node))
      ) {
        continue;
      }
      let removedKey: null | NodeKey = null;
      const host = $getSlotHost(node);
      if (host !== null) {
        const prevHost = prevNodeMap.get(host.getKey());
        const name = $getSlotNameWithinHost(node);
        removedKey =
          prevHost !== undefined &&
          $isSlotHost(prevHost) &&
          prevHost.__slots !== null &&
          name !== null
            ? (prevHost.__slots.get(name) ?? null)
            : null;
      } else if (prevSibling === null) {
        const parent = node.getParent();
        const prevParent = parent && prevNodeMap.get(parent.getKey());
        removedKey = $isElementNode(prevParent) ? prevParent.__first : null;
      } else {
        const anchorKey = prevNodeMap.has(prevSibling.getKey())
          ? prevSibling.getKey()
          : lineage.get(prevSibling.getKey());
        const prevAnchor =
          anchorKey === undefined ? undefined : prevNodeMap.get(anchorKey);
        removedKey = prevAnchor === undefined ? null : prevAnchor.__next;
      }
      if ($isRemoved(removedKey)) {
        const id = prevIdOfKey(removedKey);
        if (id !== null && !$isIdTaken(runtime, id, used, removedKey)) {
          $inherit(node, id, removedKey);
        }
      }
    }
  };
  for (const node of newBlocks) {
    $resolvePosition(node);
  }

  // 2 and 3.
  const candidatesById = new Map<string, NodeKey[]>();
  const needFresh: LexicalNode[] = [];
  for (const node of blocks) {
    const id = $getBlockId(node);
    if (id === null) {
      needFresh.push(node);
    } else {
      const keysWithId = candidatesById.get(id);
      if (keysWithId === undefined) {
        candidatesById.set(id, [node.getKey()]);
      } else {
        keysWithId.push(node.getKey());
      }
    }
  }
  const repeated = new Map<string, LexicalNode[]>();
  const yieldedOf = new Map<NodeKey, string>();
  for (const [id, keysWithId] of candidatesById) {
    const holders = $liveHolders(runtime, id, keysWithId);
    if (holders.length > 1) {
      repeated.set(id, holders);
    }
  }
  // In code unit order, like $nameUnnamed.
  for (const id of Array.from(repeated.keys()).sort()) {
    const holders = repeated.get(id)!;
    used.add(id);
    const existing = holders.filter(node => heldBefore(node.getKey(), id));
    const shared = existing.length > 1 ? existing : isLoad ? holders : null;
    let keepers: LexicalNode[];
    if (shared !== null) {
      for (const [key, next] of $renameLaterHolders(
        runtime,
        id,
        shared,
        used,
      )) {
        $setState($getNodeByKey(key)!, blockIdState, next);
      }
      keepers = shared;
    } else if (existing.length === 1) {
      keepers = existing;
    } else {
      // Every holder got the id in this local update.
      const continuing = holders.filter(node => {
        const from = lineage.get(node.getKey());
        return (
          from !== undefined && $isRemoved(from) && prevIdOfKey(from) === id
        );
      });
      const pool = continuing.length > 0 ? continuing : holders;
      keepers = [pool.reduce((a, b) => (compareKeys(b, a) < 0 ? b : a))];
    }
    for (const node of holders) {
      if (!keepers.includes(node)) {
        needFresh.push(node);
        yieldedOf.set(node.getKey(), id);
      }
    }
  }
  let random = needFresh;
  if (isLoad && needFresh.length > 0) {
    // Every reader that loads the same content names its blocks alike.
    const fresh = new Set(needFresh.map(node => node.getKey()));
    const placed = $placeBlocks(runtime, node => fresh.has(node.getKey()));
    random = [];
    for (const node of needFresh) {
      const key = node.getKey();
      const id = placed.get(key);
      if (id !== undefined && !$isIdTaken(runtime, id, used, key)) {
        used.add(id);
        $setState(node, blockIdState, id);
      } else {
        random.push(node);
      }
    }
  }
  for (const node of random.sort(compareKeys)) {
    const id = $makeFreshId(runtime, used);
    $setState(node, blockIdState, id);
    if (!prevNodeMap.has(node.getKey())) {
      provisional.set(node.getKey(), {
        id,
        yielded: yieldedOf.get(node.getKey()) ?? null,
      });
    }
  }
}

/** The changes of one commit, as an update listener receives them. */
interface CommitChanges {
  readonly prevEditorState: EditorState;
  readonly dirtyElements: Map<NodeKey, boolean>;
  readonly dirtyLeaves: Set<NodeKey>;
}

/**
 * Brings the index up to date with a committed state: incrementally from a
 * commit's dirty nodes, or rebuilt when `changes` is `null` or does not say
 * which nodes changed. Returns the keys of identified blocks that lack an id
 * or share one, which need a repair update.
 */
function $syncIndex(
  runtime: BlockIdRuntime,
  editorState: EditorState,
  changes: CommitChanges | null,
): NodeKey[] {
  const {index, config} = runtime;
  const needsRepair: NodeKey[] = [];
  const touchedIds = new Set<string>();

  const visit = (node: LexicalNode) => {
    const key = node.getKey();
    if (node.isAttached() && config.$isIdentifiedBlock(node)) {
      const id = $getBlockId(node);
      if (id === null) {
        index.remove(key);
        needsRepair.push(key);
      } else {
        index.set(key, id);
        touchedIds.add(id);
      }
    } else {
      index.remove(key);
    }
  };

  if (
    changes === null ||
    // Only the root is dirty: the state was replaced with setEditorState (an
    // undo or redo, for instance), which Lexical reconciles in full too.
    (changes.dirtyLeaves.size === 0 &&
      changes.dirtyElements.size === 1 &&
      changes.dirtyElements.has('root'))
  ) {
    index.clear();
    $walk(null, node => {
      visit(node);
      return null;
    });
  } else {
    const nodeMap = editorState._nodeMap;
    const prevNodeMap = changes.prevEditorState._nodeMap;
    const removeSubtree = (key: NodeKey) => {
      const stack: NodeKey[] = [key];
      while (stack.length > 0) {
        const k = stack.pop()!;
        if (nodeMap.has(k)) {
          // Moved elsewhere; it is dirty itself if it matters.
          continue;
        }
        index.remove(k);
        const prevNode = prevNodeMap.get(k);
        if ($isElementNode(prevNode)) {
          let child = prevNode.__first;
          while (child !== null) {
            stack.push(child);
            const prevChild = prevNodeMap.get(child);
            child = prevChild === undefined ? null : prevChild.__next;
          }
        }
        if (
          prevNode !== undefined &&
          $isSlotHost(prevNode) &&
          prevNode.__slots !== null
        ) {
          for (const slotKey of prevNode.__slots.values()) {
            stack.push(slotKey);
          }
        }
      }
    };
    const visitKey = (key: NodeKey) => {
      const node = nodeMap.get(key);
      if (node === undefined) {
        removeSubtree(key);
      } else if (!$isTextNode(node)) {
        visit(node);
      }
    };
    for (const [key, intentional] of changes.dirtyElements) {
      // An element marked dirty only because a descendant changed keeps its
      // id, position and identity, unless it was also created or written in
      // this update: Lexical downgrades the flag when a later transform pass
      // touches only a descendant, but never clones for such a mark.
      if (intentional || nodeMap.get(key) !== prevNodeMap.get(key)) {
        visitKey(key);
      }
    }
    for (const key of changes.dirtyLeaves) {
      visitKey(key);
    }
  }

  for (const id of touchedIds) {
    if (index.isRepeated(id)) {
      const holders = $liveHolders(runtime, id);
      if (holders.length > 1) {
        for (const node of holders) {
          needsRepair.push(node.getKey());
        }
      }
    }
  }
  return needsRepair;
}

function registerBlockIds(
  editor: LexicalEditor,
  runtime: BlockIdRuntime,
): () => void {
  const candidates = new Set<NodeKey>();
  const {$isIdentifiedBlock} = runtime.config;
  const $collect = (node: LexicalNode) => {
    if ($isIdentifiedBlock(node)) {
      candidates.add(node.getKey());
    } else if (
      $getBlockId(node) !== null &&
      !editor.getEditorState()._nodeMap.has(node.getKey()) &&
      !$hasUpdateTag(COLLABORATION_TAG) &&
      !$hasUpdateTag(HISTORIC_TAG)
    ) {
      // A block that is not identified has no id: a copy created where it
      // is not one (a list pasted into a list item, which nests it) does not
      // keep the id of the block it was copied from.
      $setState(node, blockIdState, undefined);
    }
  };
  const scheduleRepair = (keys: NodeKey[]) => {
    const withTransforms = runtime.config.repairTransforms;
    editor.update(
      () => {
        const attached = new Set<NodeKey>();
        for (const key of keys) {
          const node = $getNodeByKey(key);
          if (node !== null && node.isAttached()) {
            if (withTransforms) {
              node.markDirty();
            } else {
              attached.add(key);
            }
          }
        }
        if (!withTransforms) {
          // What the root transform would do with these blocks marked dirty.
          $assignBlockIds(editor, runtime, attached);
        }
      },
      // Discrete, so it commits on its own right after the commit that needed
      // it: batched into a later update tagged COLLABORATION_TAG, its changes
      // would be treated as replayed and not propagated.
      withTransforms
        ? {discrete: true, tag: [HISTORY_MERGE_TAG, BLOCK_ID_REPAIR_TAG]}
        : {
            discrete: true,
            skipTransforms: true,
            tag: [HISTORY_MERGE_TAG, BLOCK_ID_REPAIR_TAG],
          },
    );
  };
  // Notes the ids every reader gives the blocks a committed state leaves
  // unnamed, for the update that repairs it (or any other based on it).
  const $sync = (
    editorState: EditorState,
    changes: CommitChanges | null,
  ): NodeKey[] => {
    const repairs = $syncIndex(runtime, editorState, changes);
    if (!runtime.hasContent && !$getRoot().isEmpty()) {
      runtime.hasContent = true;
    }
    runtime.placed =
      repairs.length > 0 ? $nameUnnamed(runtime, repairs) : NO_PLACES;
    runtime.placedState = editorState;
    return repairs;
  };

  runtime.index.clear();
  runtime.active = true;
  runtime.hasContent = false;
  const currentState = editor.getEditorState();
  const initialRepairs = currentState.read(() => $sync(currentState, null), {
    editor,
  });

  const cleanups: (() => void)[] = [
    editor.registerUpdateListener(
      ({editorState, prevEditorState, dirtyElements, dirtyLeaves, tags}) => {
        const repairs = editorState.read(
          () =>
            $sync(editorState, {dirtyElements, dirtyLeaves, prevEditorState}),
          {editor},
        );
        if (repairs.length > 0) {
          if (!tags.has(BLOCK_ID_REPAIR_TAG)) {
            scheduleRepair(repairs);
          } else if (__DEV__) {
            console.warn(
              'BlockIdExtension: a repair update left blocks without a unique id; is $isIdentifiedBlock stable?',
            );
          }
        }
      },
    ),
  ];
  // Registering a transform marks every node of that type dirty, so the first
  // update assigns ids to a document that was opened without them.
  for (const {klass} of editor._nodes.values()) {
    if (
      klass === RootNode ||
      klass === TextNode ||
      klass === LineBreakNode ||
      klass.prototype instanceof TextNode
    ) {
      continue;
    }
    cleanups.push(editor.registerNodeTransform(klass, $collect));
  }
  cleanups.push(
    editor.registerNodeTransform(RootNode, () => {
      // A load is named once a transform pass changes nothing in the
      // document before this transform (the root is not dirty again), so
      // that positional ids are derived from the document the load ends with
      // (equal adjacent lists merged, NodeStructureExtension's repairs made),
      // not from a state in between. A dirty node outside the document does
      // not run the root transform again, so it must not defer naming.
      if (
        editor._dirtyElements.has('root') &&
        candidates.size > 0 &&
        $isLoad(editor, runtime)
      ) {
        return;
      }
      $assignBlockIds(editor, runtime, candidates);
    }),
  );
  if (initialRepairs.length > 0) {
    scheduleRepair(initialRepairs);
  }
  return () => {
    for (const cleanup of cleanups.reverse()) {
      cleanup();
    }
    runtime.active = false;
    runtime.index.clear();
    runtime.placed = NO_PLACES;
    runtime.placedState = null;
    runtime.provisional.clear();
    runtime.provisionalSeen.clear();
    runtime.provisionalState = null;
    runtime.handles = null;
    runtime.scan = null;
    candidates.clear();
  };
}

/**
 * The handles of the blocks {@link $getBlockById} sees, and how to find the
 * live block of an id among them.
 */
interface HandleView {
  readonly table: HandleTable;
  readonly $lookup: (id: string) => LexicalNode | null;
}

function $getHandleView(
  editor: LexicalEditor,
  runtime: BlockIdRuntime,
): HandleView {
  if (runtime.active) {
    // The ids of the committed state. Ids of blocks that the active update
    // removed are still in it: they can only make a handle longer, and
    // $getBlockById, which verifies against the active state, skips them.
    const {index} = runtime;
    let {handles} = runtime;
    if (handles === null || handles.version !== index.version) {
      handles = {
        $lookup: frozenLookup(runtime.$getBlockById),
        table: buildHandleTable(index.keysOfId.keys()),
        version: index.version,
      };
      runtime.handles = handles;
    }
    return handles;
  }
  // Not indexed while disabled: a scan of the last committed state, as the
  // index would be, cached until the next commit. Lookups are verified
  // against the active state, as the index's are: the first holder of the id
  // there, in document order, as $getBlockById finds it.
  const committed = editor.getEditorState();
  let {scan} = runtime;
  if (scan === null || scan.state !== committed) {
    const {$isIdentifiedBlock} = runtime.config;
    const keysOfId = committed.read(
      () => {
        const keys = new Map<string, NodeKey[]>();
        $walk(null, node => {
          if ($isIdentifiedBlock(node)) {
            const id = $getBlockId(node);
            if (id !== null) {
              const holders = keys.get(id);
              if (holders === undefined) {
                keys.set(id, [node.getKey()]);
              } else {
                holders.push(node.getKey());
              }
            }
          }
          return null;
        });
        return keys;
      },
      {editor},
    );
    scan = {
      $lookup: frozenLookup(id => {
        let found: LexicalNode | null = null;
        for (const key of keysOfId.get(id) || []) {
          const node = $getNodeByKey(key);
          if (
            node !== null &&
            node.isAttached() &&
            $isIdentifiedBlock(node) &&
            $getBlockId(node) === id &&
            (found === null || $compareDocumentOrder(node, found) < 0)
          ) {
            found = node;
          }
        }
        return found;
      }),
      state: committed,
      table: buildHandleTable(keysOfId.keys()),
    };
    runtime.scan = scan;
  }
  return scan;
}

/**
 * `$lookup`, remembered per id for each frozen state it is asked about (a
 * read of a committed state), so that reading the handle of every holder of
 * a repeated id costs the holders once, not once per holder. While the
 * active state is not frozen (an update), it asks `$lookup` every time.
 */
function frozenLookup(
  $lookup: (id: string) => LexicalNode | null,
): (id: string) => LexicalNode | null {
  const byState = new WeakMap<EditorState, Map<string, LexicalNode | null>>();
  return id => {
    const state = INTERNAL_getActiveEditorState();
    if (state === null || !state._readOnly) {
      return $lookup(id);
    }
    let found = byState.get(state);
    if (found === undefined) {
      found = new Map();
      byState.set(state, found);
    }
    let node = found.get(id);
    if (node === undefined) {
      node = $lookup(id);
      found.set(id, node);
    }
    return node;
  };
}

/** A {@link HandleView} of a scan of a committed state. */
interface HandleScan extends HandleView {
  readonly state: EditorState;
}

function $getHandleOf(
  runtime: BlockIdRuntime,
  node: LexicalNode,
): string | null {
  if (!node.isAttached() || !runtime.config.$isIdentifiedBlock(node)) {
    return null;
  }
  const id = $getBlockId(node);
  if (id === null) {
    return null;
  }
  const {table, $lookup} = $getHandleView($getEditor(), runtime);
  const handle = table.handles.get(id);
  // Only a block that its id finds has a handle that finds it: not one named
  // after the last commit (its handle is not in the table), nor a later
  // holder of a repeated id, nor a node of another state.
  if (handle === undefined) {
    return null;
  }
  const found = $lookup(id);
  return found !== null && found.is(node) ? handle : null;
}

function $getAllHandles(runtime: BlockIdRuntime): Map<string, string> {
  const {table, $lookup} = $getHandleView($getEditor(), runtime);
  const result = new Map<string, string>();
  for (const [id, handle] of table.handles) {
    if ($lookup(id) !== null) {
      result.set(id, handle);
    }
  }
  return result;
}

/** A string for untrusted input that is not one, without throwing. */
function describeInvalid(value: unknown): string {
  try {
    return String(value);
  } catch (_error) {
    return '';
  }
}

/**
 * The block id that `handle` names among the ids of a read (see
 * {@link BlockHandleOptions.read}), or why it names none. It reads the map
 * as it is on each call (a scan of its ids, no cached index), so a map
 * changed between calls is never half stale.
 */
function resolveInRead(
  read: ReadonlyMap<string, string>,
  handle: string,
): {readonly id: string} | BlockHandleResult {
  if (handle.length > HANDLE_KEY_LENGTH) {
    return read.has(handle) ? {id: handle} : {handle, status: 'not-found'};
  }
  if (handle.length < MIN_BLOCK_HANDLE_LENGTH) {
    return {handle, reason: 'too-short', status: 'invalid'};
  }
  const matches: [string, string][] = [];
  for (const id of read.keys()) {
    const key = handleKey(id);
    if (key.startsWith(handle)) {
      matches.push([key, id]);
    }
  }
  if (matches.length === 0) {
    return {handle, status: 'not-found'};
  }
  if (matches.length > 1) {
    return {
      candidates: matches
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, MAX_HANDLE_CANDIDATES)
        .map(([key, id]) => read.get(id) ?? key),
      handle,
      status: 'ambiguous',
    };
  }
  return {id: matches[0][1]};
}

function $resolveHandle(
  runtime: BlockIdRuntime,
  handle: string,
  options?: BlockHandleOptions,
): BlockHandleResult {
  if (typeof handle !== 'string') {
    return {
      handle: describeInvalid(handle),
      reason: 'malformed',
      status: 'invalid',
    };
  }
  if (!BLOCK_ID_PATTERN.test(handle)) {
    return {handle, reason: 'malformed', status: 'invalid'};
  }
  const read = options && options.read;
  if (read) {
    // What the handle named in the read, if that block still exists: a
    // block added since cannot take the handle, nor make it ambiguous.
    const inRead = resolveInRead(read, handle);
    if (!('id' in inRead)) {
      return inRead;
    }
    const node = runtime.$getBlockById(inRead.id);
    return node === null
      ? {handle, status: 'not-found'}
      : {node, status: 'found'};
  }
  if (handle.length > HANDLE_KEY_LENGTH) {
    // Longer than any handle: a whole id.
    const node = runtime.$getBlockById(handle);
    return node === null
      ? {handle, status: 'not-found'}
      : {node, status: 'found'};
  }
  if (handle.length < MIN_BLOCK_HANDLE_LENGTH) {
    // Never a handle: say so, rather than "not found".
    return {handle, reason: 'too-short', status: 'invalid'};
  }
  const {table, $lookup} = $getHandleView($getEditor(), runtime);
  let found: LexicalNode | null = null;
  const candidates: string[] = [];
  for (const id of idsWithPrefix(table, handle)) {
    const node = $lookup(id);
    if (node !== null) {
      found = node;
      if (candidates.length < MAX_HANDLE_CANDIDATES) {
        candidates.push(handleInTable(table, id));
      }
    }
  }
  if (candidates.length > 1) {
    return {candidates, handle, status: 'ambiguous'};
  }
  return found === null
    ? {handle, status: 'not-found'}
    : {node: found, status: 'found'};
}

function createRuntime(config: BlockIdConfig): BlockIdRuntime {
  const runtime: BlockIdRuntime = {
    $getBlockById(id: string): LexicalNode | null {
      let found: LexicalNode | null = null;
      if (!runtime.active) {
        // Not indexed while disabled: the first holder in document order.
        $walk(null, node => {
          if (
            found === null &&
            config.$isIdentifiedBlock(node) &&
            $getBlockId(node) === id
          ) {
            found = node;
          }
          return null;
        });
        return found;
      }
      // Several holders only until the repair update: the one it keeps.
      for (const node of $liveHolders(runtime, id)) {
        if (found === null || $compareDocumentOrder(node, found) < 0) {
          found = node;
        }
      }
      return found;
    },
    active: false,
    config,
    handles: null,
    hasContent: false,
    index: new BlockIdIndex(),
    placed: NO_PLACES,
    placedState: null,
    provisional: new Map(),
    provisionalSeen: new Set(),
    provisionalState: null,
    scan: null,
  };
  return runtime;
}

/**
 * Gives blocks stable ids, stored as NodeState ({@link blockIdState}), so that
 * code outside the editor (an AI agent, a server pipeline, a comment system)
 * can address a block by id across sessions, replicas, and serializations.
 *
 * Every identified block gets an id in the update that creates it. A
 * document stored without ids gets positional ids, which every reader and
 * replica derives alike; blocks created by edits get random ids
 * ({@link generateBlockId}). Ids are unique: a copy yields to the block it
 * was copied from. By default the root's children, nested blocks that hold
 * text, and nested block decorators are identified
 * ({@link $defaultIsIdentifiedBlock}). While enabled, {@link $getBlockById}
 * looks blocks up in an index maintained from the dirty nodes of each
 * update. See the Block IDs documentation page for the exact rules.
 *
 * Showing blocks to a model? Use handles, short opaque names derived from a
 * hash of each id (almost always 4 characters), instead of whole ids:
 * {@link $getBlockHandle} / {@link $resolveBlockHandle}, or
 * `handles: true` in `BlockIdHTMLExtension`. A mistyped or outdated
 * handle almost always resolves as not found or ambiguous rather than as
 * another block.
 *
 * @experimental
 */
export const BlockIdExtension = defineExtension({
  build(editor, config, state): BlockIdOutput {
    const runtime = state.getInitResult() as BlockIdRuntime;
    const signals = namedSignals({disabled: config.disabled});
    return {
      $getBlockById: runtime.$getBlockById,
      $getBlockHandle: node => $getHandleOf(runtime, node),
      $getBlockHandles: () => $getAllHandles(runtime),
      $isIdentifiedBlock: config.$isIdentifiedBlock,
      $resolveBlockHandle: (handle, options) =>
        $resolveHandle(runtime, handle, options),
      disabled: signals.disabled,
    };
  },
  config: safeCast<BlockIdConfig>({
    $isIdentifiedBlock: $defaultIsIdentifiedBlock,
    disabled: false,
    generateId: generateBlockId,
    repairTransforms: true,
  }),
  // The per-editor state is the init result, opaque outside this module
  // (`unknown`, as in the Flow types). The parameters are annotated so that
  // TypeScript infers the init type before it checks build and register.
  init: (editorConfig: InitialEditorConfig, config: BlockIdConfig): unknown =>
    createRuntime(config),
  name: '@lexical/extension/BlockId',
  // Where the editor also enforces declared node structure, register after
  // it, so that blocks are named on the structure its normalization leaves.
  peerDependencies: [
    declarePeerDependency<typeof NodeStructureExtension>(
      '@lexical/NodeStructure',
    ),
  ],
  register(editor, config, state) {
    const output = state.getOutput();
    const runtime = state.getInitResult() as BlockIdRuntime;
    return effect(() => {
      if (!output.disabled.value) {
        return registerBlockIds(editor, runtime);
      }
    });
  },
});
