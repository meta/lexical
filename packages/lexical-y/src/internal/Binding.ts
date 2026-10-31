/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Hidden} from './Hidden';

import {
  type BlockIdExtension,
  getPeerDependencyFromEditor,
  registerNodeStructure,
} from '@lexical/extension';
import invariant from '@lexical/internal/invariant';
import {
  applyUpdate,
  ContentFormat,
  ContentType,
  createID,
  createRelativePositionFromJSON,
  type Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  findIndexSS,
  Item,
  iterateStructsByIdSet,
  Node as YNode,
  RelativePosition,
  relativePositionToJSON,
  type Transaction,
  UndoManager,
} from '@y/y';
import {
  $addUpdateTag,
  $createLineBreakNode,
  $createNodeSelection,
  $createPoint,
  $createRangeSelection,
  $flushSyncAfterUpdate,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $hasUpdateTag,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isRootNode,
  $isTextNode,
  $onUpdate,
  $setSelection,
  COLLABORATION_TAG,
  DEFER_COMPOSITION_MERGE_TAG,
  type EditorState,
  ElementNode,
  getActiveElement,
  getTransformSetFromKlass,
  HISTORY_MERGE_TAG,
  INTERNAL_$normalizeNodeStructure,
  isCurrentlyReadOnlyMode,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  LexicalWarning,
  type LineBreakNode,
  type NodeKey,
  type PointType,
  type RangeSelection,
  SELECTION_CHANGE_COMMAND,
  SKIP_COLLAB_TAG,
  SKIP_DOM_SELECTION_TAG,
  TextNode,
  type Transform,
} from 'lexical';

import {ARGUMENTS_CHUNK, pushAll, spliceAll} from './Arrays';
import {$unsettledAfterWrite} from './BlockIds';
import {type ClientIDRange, constrainClientID} from './ClientID';
import {
  BASE_LAYOUT_VERSION,
  DEFAULT_ROOT_NAME,
  LEGACY_ROOTS,
  SCHEMA_PREFIX,
  SET_MEMBERS_LAYOUT_VERSION,
} from './constants';
import {
  changeEnd,
  equalFormatValue,
  isFormatCloser,
  markFormatCloser,
} from './Cursor';
import {$canonicalizeGroup, $switchesWrapper} from './Groups';
import {
  $applyStoredAttrs,
  $unstoredWrapperTextFields,
  Reader,
  type StoredFormatsMemo,
} from './Read';
import {
  $isGroupNode,
  $isWrapper,
  $nodeAttrs,
  $setTextFields,
  type Attrs,
  canStoreAs,
  deriveStorageKind,
  getGroupSpec,
  identityOf,
  isSetMemberEntryName,
  LAYOUT_PREFIX,
  LAYOUT_VERSION,
  MARKER,
  type Pin,
  PIN_PREFIX,
  RUN_END,
  type StorageKind,
  storageKindOf,
  withPins,
  wrapperFieldsOf,
  wrappersFromAttrs,
} from './Schema';
import {
  attrsBefore,
  isGone,
  isShownEnd,
  prevLiveEnd,
  shownLength,
} from './Seen';
import {$checkWrite, $followUpDifference, checkContainer} from './SelfCheck';
import {$unstorableSlotHosts, $wrapSlotShadowRootInline} from './Slots';
import {
  type CS,
  isEndItem,
  nameOf,
  Roles,
  State,
  typeOf,
  type Unit,
} from './State';
import {emptyView, seenBy, type Unread} from './Unread';
import {
  NESTED_FALLBACK_WARNING,
  notesSince,
  RECOVERED_READ_WARNING,
  RECOVERED_WRITE_WARNING,
  SELF_CHECK_WARNING,
  STORAGE_MISMATCH_WARNING,
  UNKNOWN_NODE_TYPES_WARNING,
  UNSUPPORTED_CONFIG_WARNING,
  UNSUPPORTED_EDIT_WARNING,
  UNSUPPORTED_LAYOUT_WARNING,
  UNSUPPORTED_SCHEMA_WARNING,
  UNSUPPORTED_SLOTS_WARNING,
  type YRecoveredReadData,
  type YStorageMismatchData,
  type YUnsupportedConfigData,
  type YUnsupportedSchemaData,
  type YWarningCode,
  type YWarningData,
} from './Warnings';
import {$holdsLines, type WritePlan, Writer} from './Write';
import {createYDoc, type YDoc} from './YDoc';
import {assertOwnYjsDoc, assertSupportedYjs} from './YjsContract';

// YBinding: one editor bound to one shared root. It owns the lifecycle (the
// layout gate, pins, initialization, dispose), the local pipeline (onUpdate:
// a commit classified, written, then its block ids settled and the write
// checked; see Commit), the remote pipeline (onAfterTransaction: a
// transaction read into the editor), the binding's own updates (see
// runPending), undo, and the selection kept through reads. Reading and
// writing are Reader's and Writer's; block ids are BlockIds.ts's.
//
// Invariant: only users' own edits write content. Why: the follow-ups of a
// commit (a refresh, a registration pass, BlockIdExtension's naming) happen
// on every client; written by each, an insert would be duplicated. They may
// set attributes or delete (see Writer#followUp), and what else they change
// is read again (see refused).
//
// Invariant: the editor shows what is stored (but for remote text held back
// while the user composes, see Hidden). Why: every client and every fresh
// reader then show the same content. Every read is an update of the
// binding's own, tagged as a collaborator's change, that runs no transforms.
//
// Invariant: every update the binding makes commits alone (see runPending).
// Why: Lexical merges the updates queued in one listener phase into one
// commit, with their tags, which would hide whose change is whose.

// A collaborator's change: DEFER_COMPOSITION_MERGE_TAG keeps Lexical from
// merging text into an active IME composition (the composed DOM text node
// would take in the merged text).
const REMOTE_TAGS = [
  COLLABORATION_TAG,
  HISTORY_MERGE_TAG,
  DEFER_COMPOSITION_MERGE_TAG,
];
/** A failure caught where any value may be thrown, `null` and `undefined` too. */
type Failure = {readonly error: unknown} | null;

/** A read of the shared document into the editor (see YBinding#guardedRead). */
type GuardedRead = {
  /**
   * Runs right before the read's update, once the local updates still
   * pending have committed (see commitPending): what the read takes from
   * the editor as those updates left it. Not where the read does not run.
   */
  readonly before?: () => void;
  /** The read, inside the update. */
  readonly $read: () => void;
  /**
   * Whether the read's update takes over the local updates still pending
   * instead of committing them first (see commitPending): a read of the
   * whole document, which replaces what they show (the initial state an
   * app sets before the binding opens a document that has content).
   */
  readonly replacesPending?: true;
  /**
   * Where a throw goes, of the read or of committing it, with what the
   * editor showed before the read: recoverRead, which reads the whole
   * document again, or failClosed for a read of the whole document.
   */
  readonly recover: (error: unknown, shown: EditorState) => void;
  /** Runs once the read has committed and nothing threw. */
  readonly after?: () => void;
  /** The update's tags. */
  readonly tag?: string | string[];
};

/**
 * Rethrow an app's error (an update or a listener of its own that threw on a
 * commit the binding made) in a microtask: an uncaught error, never thrown
 * into Yjs or a provider.
 */
function rethrowLater(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

/** `error`'s text for a warning; never throws, whatever value was thrown. */
function errorText(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return 'a value that cannot be shown as text';
  }
}

/** The binding's refresh of derived group fields (see flushRefresh). */
const REFRESH_TAG = 'lexical-y-refresh';
/** The author's normalization of its own update (see normalizeUntransformed). */
const NORMALIZE_TAG = 'lexical-y-normalize';
/**
 * The update Lexical makes to run a newly registered transform over the
 * document, run by the binding on its own (see noteRegistrations).
 */
const REGISTRATION_TAG = 'lexical-y-registration';
/** BlockIdExtension's update that names blocks a commit left without an id. */
const BLOCK_ID_REPAIR_TAG = 'block-id-repair';

/**
 * The binding's own updates that wait for the editor to be idle (see
 * runPending), in the order they run.
 */
type PendingWork =
  | 'replies'
  | 'restore'
  | 'hidden'
  | 'reread'
  | 'normalize'
  | 'refresh'
  | 'register';
const PENDING_ORDER: readonly PendingWork[] = [
  'replies',
  'restore',
  'hidden',
  'reread',
  'normalize',
  'refresh',
  'register',
];

/**
 * Re-reads in a row (see $rereadRefused) before a last one, which refreshes
 * nothing. Invariant: a follow-up that keeps changing what it may not write
 * is read again at most this many times in a row (until a user's edit).
 * Why: a transform that rewrites the same content on every run would loop.
 */
const MAX_REREADS = 3;

/**
 * The commits of local updates a read makes before it runs (see
 * commitPending). Invariant: a read never runs with local updates still
 * pending, which it would commit unwritten under its own tags; where
 * listeners keep making them past this many commits, the read does not run
 * and is recovered from instead (see guardedRead).
 */
const MAX_PENDING_COMMITS = 16;

/**
 * How many updates for registered transforms the binding runs before the
 * event loop turns (see YBinding#runRegistrationPasses), as Lexical caps
 * the updates its listeners queue in a row. Transforms registered in a row
 * share one (see noteRegistrations): only a listener that registers one
 * after every commit reaches it.
 */
const MAX_REGISTRATION_RUNS = 100;

/** What an update listener gets for a commit (see YBinding#onUpdate). */
type UpdatePayload = {
  dirtyElements: Map<NodeKey, boolean>;
  dirtyLeaves: Set<NodeKey>;
  editorState: EditorState;
  /** The text nodes Lexical's normalization merged (see WritePlan#merged). */
  normalizedNodes?: ReadonlySet<NodeKey>;
  prevEditorState: EditorState;
  tags: Set<string>;
};

/**
 * What made a commit, which decides what the binding writes for it (see
 * YBinding#classifyCommit).
 *
 * Invariant: only users' own edits write content. A follow-up (an update
 * every client that has the commit makes, no one's edit: the binding's
 * refresh of derived group fields, the update Lexical makes to run a newly
 * registered transform over the document, BlockIdExtension's naming of the
 * blocks a commit left without an id) may set attributes or delete, never
 * insert (see Writer#followUp). Why: every client makes the follow-up, so an
 * insert would be written once per client. The binding's own updates commit
 * alone (see runPending), so their tags are theirs; an update another
 * listener queues in the same listener phase as the naming update is
 * committed with it, and counts as part of it.
 */
type Commit = {
  /** REFRESH_TAG: the binding's refresh of derived group fields. */
  readonly refresh: boolean;
  /** COLLABORATION_TAG without REFRESH_TAG: a read of a remote change. */
  readonly remote: boolean;
  /** SKIP_COLLAB_TAG: not written. */
  readonly skip: boolean;
  /** Lexical's update for a registered transform (see isRegistrationPass). */
  readonly registration: boolean;
  /** BLOCK_ID_REPAIR_TAG: BlockIdExtension's naming update. */
  readonly naming: boolean;
  /** NORMALIZE_TAG: the author's normalization of its own update. */
  readonly normalize: boolean;
  /** No one's edit: it may set attributes or delete, never insert. */
  readonly followUp: boolean;
  /** A user's own edit: in the undo history, normalized by its author. */
  readonly userEdit: boolean;
  /** Whether the groups it changed are refreshed (see $groupsToRefresh). */
  readonly scansGroups: boolean;
};

/** @experimental The state of a {@link YBinding}. */
export type YBindingStatus =
  /** Waiting for the first sync: nothing is written. */
  | 'pending'
  /** Reading and writing. */
  | 'active'
  /**
   * Read only: the binding writes nothing, and the editor is not editable.
   * A warning says why: a layout or schema version this version does not
   * read, a node type the editor does not register, content a node class
   * throws on, an unsupported configuration (a document not made with
   * `createYDoc`, or options the binding does not support), a local change
   * it cannot store, or a document it cannot read at all, after which it
   * reads nothing more either.
   */
  | 'readonly';

/** @experimental Options of {@link YBinding} (and `YCollabExtension`). */
export interface YBindingOptions {
  /**
   * The version of the app's document schema: its node types and the fields
   * they store. Required: start at 1 and increase it whenever a node's
   * stored fields or node types change. The document records the highest
   * version that wrote to it; a binding whose version is lower opens it read
   * only (UNSUPPORTED_SCHEMA_WARNING). An integer from 1.
   */
  schemaVersion: number;
  /** The shared root to bind; defaults to `doc.get('lexical-y')`. */
  root?: YNode;
  /** Undo capture timeout in ms (default 500); null disables undo. */
  captureTimeout?: number | null;
  /**
   * Called when `status` changes, once the binding's work is done and Yjs is
   * idle (like warnings, never inside a Yjs observer or transaction). Several
   * changes in one such step report the last.
   */
  onStatus?: (status: YBindingStatus) => void;
  /**
   * Read every line a local write touched back from Yjs and compare it with
   * the editor; mismatches are reported to the editor's `onWarn` (see
   * SELF_CHECK_WARNING).
   * Structural changes (and remote changes) also compare a fresh read of
   * the whole container: every time for containers of up to 256 lines and
   * nodes, and with probability 256 / size for bigger ones, so the expected
   * cost of an edit stays bounded. Default: off. A debugging aid: turn it
   * on in tests and development builds to catch binding bugs.
   */
  selfCheck?: boolean;
  /**
   * The fraction of changes the self-check samples (default 1): of local
   * writes, and of remote changes, where a sampled check that finds the
   * editor differing from the shared content also reads those containers
   * again (see `selfCheck`).
   */
  selfCheckSample?: number;
  /**
   * Initialize even when an older layout's root has content: for a
   * converter writing the layout root of an existing document.
   */
  convert?: boolean;
  /**
   * The range of the document's client ids: `'uint53'` (default, Yjs 14's
   * ids, left as they are) or `'uint32'` (kept in 32 bits, for servers on
   * yrs before 0.28; see {@link ClientIDRange}).
   */
  clientIDRange?: ClientIDRange;
}

/**
 * @experimental A selection as Yjs relative positions, from
 * `YBinding#getCursor` (for an awareness-based cursor UI).
 */
export interface YCursor {
  anchor: unknown;
  focus: unknown;
}

/**
 * @internal Whether `value` is a schema version: an integer from 1 (see
 * YBindingOptions.schemaVersion).
 */
export function isSchemaVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/** The first `lexical-y-schema:<n>` attribute of `root` that is not a version. */
function malformedSchema(root: YNode): {key: string; found: unknown} | null {
  const attrs = root.getAttrs() as Record<string, unknown>;
  for (const key in attrs) {
    if (key.startsWith(SCHEMA_PREFIX)) {
      const n = key.slice(SCHEMA_PREFIX.length);
      if (!/^[1-9][0-9]*$/.test(n) || attrs[key] !== true) {
        return {found: attrs[key], key};
      }
    }
  }
  return null;
}

/**
 * The highest schema version `root` records (see SCHEMA_PREFIX), null when
 * it records none.
 */
function newestSchema(root: YNode): number | null {
  let version: number | null = null;
  const attrs = root.getAttrs() as Record<string, unknown>;
  for (const k in attrs) {
    if (k.startsWith(SCHEMA_PREFIX)) {
      version = Math.max(version ?? 0, Number(k.slice(SCHEMA_PREFIX.length)));
    }
  }
  return version;
}

/**
 * The schema records of `root` that keep a binding of `supported` read only
 * (see SCHEMA_PREFIX): those of a higher version, and malformed ones.
 */
function gatingSchemaKeys(root: YNode, supported: number): string[] {
  const out: string[] = [];
  const attrs = root.getAttrs() as Record<string, unknown>;
  for (const key in attrs) {
    if (key.startsWith(SCHEMA_PREFIX)) {
      const n = key.slice(SCHEMA_PREFIX.length);
      if (
        !/^[1-9][0-9]*$/.test(n) ||
        attrs[key] !== true ||
        Number(n) > supported
      ) {
        out.push(key);
      }
    }
  }
  return out;
}

/**
 * Record schema `version` on `root` (see SCHEMA_PREFIX) when `tr` changed
 * something under it (`under`: whether a type is `root` or inside it),
 * unless it is recorded already: a client's first write to a document
 * carries its version, so no client receives that write without it. Writes
 * an app's own transaction makes to other shared types do not count (the
 * binding's write can be part of such a transaction). The record only
 * grows: undo never deletes it (see YBinding#isKeptByUndo).
 *
 * Invariant: called in a `finally` inside every transaction that writes a
 * local edit (as recordSetMembersLayout). Why: Yjs commits and sends what a
 * transaction wrote even when its callback throws.
 */
function recordSchema(
  root: YNode,
  version: number,
  tr: Transaction,
  under: (type: YNode) => boolean,
): void {
  const key = SCHEMA_PREFIX + version;
  if (root.getAttr(key) === true) {
    return;
  }
  let wrote = false;
  tr.changed.forEach((_subs: Set<string | null>, type: YNode) => {
    wrote = wrote || under(type);
  });
  if (wrote) {
    root.setAttr(key, true);
  }
}

/**
 * Whether live format item `item` changes its key's value: the nearest live
 * item of its key before it gives another value (none gives null).
 */
function opensRun(item: Item): boolean {
  const {key, value} = item.content as ContentFormat;
  for (let it = item.left; it !== null; it = it.left) {
    if (
      !it.deleted &&
      it.content instanceof ContentFormat &&
      it.content.key === key
    ) {
      return !equalFormatValue(it.content.value, value);
    }
  }
  return value !== null;
}

/**
 * The layout version `root` records: the highest of its `lexical-y:<n>`
 * attributes (see LAYOUT_PREFIX), null when it has none, and NaN when one is
 * not a version (an integer from 1, set to true), which opens the document
 * read only.
 */
function recordedLayout(root: YNode): number | null {
  return malformedLayout(root) !== null ? NaN : newestLayout(root);
}

/** The first `lexical-y:<n>` attribute of `root` that is not a version. */
function malformedLayout(root: YNode): {key: string; found: unknown} | null {
  const attrs = root.getAttrs() as Record<string, unknown>;
  for (const key in attrs) {
    if (key.startsWith(LAYOUT_PREFIX)) {
      const n = key.slice(LAYOUT_PREFIX.length);
      if (!/^[1-9][0-9]*$/.test(n) || attrs[key] !== true) {
        return {found: attrs[key], key};
      }
    }
  }
  return null;
}

/** The highest version of `root`'s layout records, null when it has none. */
function newestLayout(root: YNode): number | null {
  let version: number | null = null;
  const attrs = root.getAttrs() as Record<string, unknown>;
  for (const k in attrs) {
    if (k.startsWith(LAYOUT_PREFIX)) {
      version = Math.max(version ?? 0, Number(k.slice(LAYOUT_PREFIX.length)));
    }
  }
  return version;
}

/**
 * Whether `tr` wrote a member entry of a set-valued NodeState: a text format
 * or a node attribute named `s:<key>\u001f…` set to true (see
 * SET_MEMBERS_LAYOUT_VERSION).
 */
function wroteSetMember(tr: Transaction): boolean {
  let found = false;
  iterateStructsByIdSet(tr, tr.insertSet, s => {
    if (found || !(s instanceof Item) || s.deleted) {
      return;
    }
    const content = s.content;
    if (content instanceof ContentFormat) {
      found = content.value === true && isSetMemberEntryName(content.key);
    } else if (
      typeof s.parentSub === 'string' &&
      isSetMemberEntryName(s.parentSub)
    ) {
      found = content.getContent()[0] === true;
    }
  });
  return found;
}

/**
 * Record layout `version` on `root` (see LAYOUT_PREFIX), unless it is
 * recorded already: in the transaction that wrote the first content that
 * needs it, so that no client receives one without the other. The record
 * only grows: undo never deletes it (see YBinding#isKeptByUndo).
 */
function recordLayout(root: YNode, version: number): void {
  const key = LAYOUT_PREFIX + version;
  if (root.getAttr(key) !== true) {
    root.setAttr(key, true);
  }
}

/**
 * Record layout SET_MEMBERS_LAYOUT_VERSION on `root` when `tr` wrote a member
 * entry of a set-valued NodeState (see wroteSetMember), unless the document
 * records it already (then `tr` is not scanned).
 *
 * Invariant: called in a `finally` inside every transaction that writes
 * content. Why: Yjs commits and sends what a transaction wrote even when its
 * callback throws, so a write that fails part way must carry the version
 * too; the recovery's rewrite is a later transaction, which may never come.
 */
function recordSetMembersLayout(root: YNode, tr: Transaction): void {
  if (
    root.getAttr(LAYOUT_PREFIX + SET_MEMBERS_LAYOUT_VERSION) !== true &&
    wroteSetMember(tr)
  ) {
    recordLayout(root, SET_MEMBERS_LAYOUT_VERSION);
  }
}

/**
 * @experimental A Yjs 14 binding for one editor and one shared root.
 *
 * Every container (the root, and every node stored as its own Y.Node) holds
 * one sequence of text, child nodes and line markers; see the package README
 * for the layout.
 *
 * Warnings (read only states, recoveries, the opt-in self-check) go to the
 * editor's `onWarn`, typed by their code (see YWarning and isYWarning), once a
 * remote change has been applied in full: never from inside a Yjs observer
 * or transaction. A handler that throws does not affect syncing.
 */
export class YBinding {
  private readonly _editor: LexicalEditor;
  private readonly _doc: YDoc;
  private readonly _root: YNode;
  private _status: YBindingStatus = 'pending';
  private readonly _pins = new Map<string, Pin>();
  private _undoManager: UndoManager | null = null;
  private state: State;
  private readonly options: YBindingOptions;
  private disposers: (() => void)[] = [];
  /** Origin of the initialization transaction (not tracked by undo). */
  private readonly initOrigin = {binding: this};
  /** Origin of follow-up writes and pin records (not tracked by undo). */
  private readonly followUpOrigin = {binding: this, followUp: true};
  /**
   * Elements Lexical's transforms ran on since the last commit (see
   * onUpdate).
   */
  private readonly transformed = new Set<NodeKey>();
  /**
   * Elements a local update changed without Lexical's transforms, for the
   * author's normalization (see normalizeUntransformed), with what stores
   * each once it is written (its shared node, or its line's marker): a
   * remote change read before the normalization runs can give the element a
   * new node.
   */
  private readonly untransformed = new Map<NodeKey, YNode | Item | null>();
  /**
   * Text nodes a local update changed without Lexical's transforms, for the
   * author's normalization too (its text transforms: a line feed split into
   * a line break node, as every reader shows it).
   */
  private readonly untransformedText = new Set<NodeKey>();
  /**
   * Stored nodes a user's edit wrote with a value holding an array hole (see
   * Writer#holed), for the author's normalization too: they take what every
   * reader parses from the stored null (colWidths: 0), which is written.
   */
  private readonly storedHoles = new Set<NodeKey>();
  /** The binding's own updates waiting for the editor (see runPending). */
  private readonly pending = new Set<PendingWork>();
  /** Whether the author's normalization is queued (see queueNormalize). */
  private normalizeQueued = false;
  /**
   * Groups a local change touched, for the refresh that follows it (see
   * flushRefresh), kept apart from the groups a remote read refreshes at
   * once.
   */
  private readonly localRefresh = new Set<NodeKey>();
  /**
   * Groups a remote read touched while another update was running, for the
   * refresh that follows it once the editor is idle (see flushRefresh).
   */
  private readonly remoteRefresh = new Set<NodeKey>();
  private pendingScheduled = false;
  /**
   * Whether the editor committed in the current task (see commitsAtOnce).
   * An object of its own, cleared by a microtask that keeps only it (see
   * endOfTask).
   */
  private readonly task = {committed: false};
  /**
   * Containers a follow-up changed in ways that are not written (see
   * Writer#followUp): read again, so the editor shows what is stored.
   */
  private readonly refused = new Set<CS>();
  /**
   * Containers a local update changed while read only during a composition:
   * read again once it ends (see onUpdate).
   */
  private readonly refusedComposing = new Set<CS>();
  /**
   * Whether the binding went read only to keep a local change it cannot
   * store (see refuseUnstorableSlots): the editor shows that change, and
   * later local updates too, as reading their containers again could drop it.
   */
  private keepsUnstored = false;
  /**
   * Whether UNSUPPORTED_EDIT_WARNING was reported since the binding last
   * went read only: once per read-only period.
   */
  private warnedEdit = false;
  /**
   * What the editor showed before a local update made once the binding
   * failed closed: shown again (see onUpdate).
   */
  private restoreTo: EditorState | null = null;
  /**
   * Updates the app's listeners queued while notified of a status change,
   * held until they commit on their own (see notifyApart).
   */
  private replies: LexicalEditor['_updates'] = [];
  /**
   * The updates that were queued already when `replies` were made: the
   * replies go back after them (see handBackReplies).
   */
  private queuedBeforeReplies = new Set<LexicalEditor['_updates'][number]>();
  /** Re-reads in a row (see MAX_REREADS). */
  private rereads = 0;
  /**
   * Whether a container in `refused` holds a change of BlockIdExtension's
   * naming update (see rereadRefused).
   */
  private refusedNaming = false;
  /**
   * Block ids whose holders a local write changed and that the editor does
   * not show as a read settles them (see onUpdate): settled in the next
   * re-read, which is not written.
   */
  private readonly toSettle = new Set<string>();
  /** Types a transform was registered for since the last commit. */
  private readonly registeredTypes = new Set<string>();
  /**
   * The updates Lexical made for transforms registered while the binding
   * writes, taken off Lexical's queue: run once the editor is idle, as an
   * update of their own (see noteRegistrations).
   */
  private readonly registrationPasses: (() => void)[] = [];
  /**
   * Registration passes run since the event loop last turned (see
   * runRegistrationPasses). Invariant: at most MAX_REGISTRATION_RUNS per
   * turn. Why: a listener that registers a transform after every commit
   * would make passes forever (Lexical stops the updates listeners keep
   * queuing for the same reason).
   */
  private registrationRuns = 0;
  /**
   * The node transforms each type had at the last commit: a new one (or one
   * registered again) marks every node of its type dirty (see
   * isRegistrationPass).
   */
  private readonly transformSets = new Map<
    string,
    ReadonlySet<Transform<LexicalNode>>
  >();
  /**
   * The configuration the binding cannot write safely with, one entry per
   * reason (see UNSUPPORTED_CONFIG_WARNING): while there is any, the binding
   * is read only.
   */
  private unsupportedConfig: YUnsupportedConfigData[] = [];
  /**
   * Why the document's schema record keeps the binding read only (see
   * checkSchema): a newer version wrote to it, or a record is malformed.
   * Sticky, like the record, which only grows.
   */
  private schemaGate: YUnsupportedSchemaData | null = null;
  /**
   * The pending state of the update that was running when a remote change
   * brought a schema record that gates the binding: the gate waits until it
   * has committed, and been written (see gateSchema).
   */
  private schemaGateAfter: EditorState | null = null;
  /**
   * A remote transaction whose schema record the app's Yjs observers could
   * see while no local update was pending: an update they make is made on
   * that record, and refused (see schemaGatesWrite).
   */
  private schemaSeenIn: Transaction | null = null;
  /** A status change not reported to `onStatus` yet (see flushWarnings). */
  private pendingStatus: YBindingStatus | null = null;
  /** How many of the class and value notes this binding has reported. */
  private notesSeen = 0;
  /** Counts remote transactions (a local write's self-check is skipped when one landed during it). */
  private remoteSeq = 0;
  /** Origin of read-only scans (no changes). */
  private readonly scanOrigin = {binding: this, scan: true};
  /**
   * The origin of the nulls an undo or redo writes to end the runs it
   * brings back (see closeRestoredRuns): read into the editor as a
   * collaborator's change is, and not part of the undo stack.
   */
  private readonly runEndOrigin = {binding: this, runEnd: true};
  /** Stored nodes the running undo/redo restores (see isKeptByUndo). */
  private restoring: Set<string> | null = null;
  /** Stored nodes the running undo/redo deletes (it inserted them). */
  private removing: Set<Item> | null = null;
  /** The items the running undo/redo deletes (see isKeptByUndo). */
  private undoing: Set<Item> | null = null;
  private wasEditable = true;
  private undoCache = new WeakMap<YNode, Set<number>>();
  private readonly afterTransaction: (tr: Transaction) => void;
  private readonly beforeTransaction: (tr: Transaction) => void;
  private readonly beforeObserverCalls = (tr: Transaction): void => {
    // Typed: @y/y declares `changed` with a YNode it does not import, so
    // the parameters would be `any` (and the contract test blind to them).
    tr.changed.forEach((subs: Set<string | null>, type: YNode) => {
      if (this.state.containers.has(type) || this.isUnderRoot(type)) {
        type._hasFormatting = false;
      }
      // The app's observers run next, before the binding reads `tr`: a
      // schema record that gates the binding is visible to them. The local
      // updates pending before it are committed (written) first, as a read
      // commits them (see guardedRead), so that an update an observer makes
      // is not merged into them; then what is made is made on the record.
      if (
        type === this._root &&
        this._status === 'active' &&
        [...subs].some(k => k !== null && k.startsWith(SCHEMA_PREFIX)) &&
        gatingSchemaKeys(this._root, this.options.schemaVersion).length > 0
      ) {
        if (!this._editor._updating && this.localPending()) {
          this.guard(() => withPins(this._pins, () => this.commitPending()));
        }
        if (!this.localPending()) {
          this.schemaSeenIn = tr;
        }
      }
    });
  };
  /**
   * Whether a shared type is the binding's root or inside it: a container
   * this client no longer shows (a table it deleted) is still the binding's,
   * and Yjs must not clean up its formats either (see beforeObserverCalls).
   */
  private isUnderRoot(type: YNode): boolean {
    for (let t: YNode | null = type; t !== null; t = t.parent) {
      if (t === this._root) {
        return true;
      }
    }
    return false;
  }
  /** The local selection before the remote transaction being applied. */
  private pendingCursor: YCursor | null = null;
  /**
   * While changes Yjs applies are not read yet: the document as it was
   * before them, which the editor still shows, and which the binding writes
   * on and takes selections on meanwhile (see Unread).
   */
  private unread: Unread | null = null;
  /** While a change is read: the document as it is (see readChange). */
  private reading = false;
  /** The stored formats one update's transforms looked up (see settleTextFields). */
  private storedFormats: {
    state: EditorState | null;
    sequences: StoredFormatsMemo;
    lines: Map<NodeKey, StoredLine>;
  } = {lines: new Map(), sequences: new Map(), state: null};
  /** This binding's view, for its work (see guard). */
  private readonly seer = () => (this.reading ? null : this.unread);
  /**
   * The selection before the local change being written (see onUpdate), for
   * the undo step it starts (see stack-item-added in startInner).
   */
  private writeCursor: YCursor | null = null;
  /** The selection before the last undo or redo (see stack-item-added). */
  private undoneCursor: YCursor | null = null;
  /**
   * While an undo or redo runs: the selection from before the step it
   * reverts, which the read restores (null: map the current one).
   */
  private stepCursor: YCursor | null = null;
  /** The node classes' own transforms (see $refreshGroups), per class. */
  private readonly classTransforms = new Map<
    Klass<LexicalNode>,
    Set<Transform<LexicalNode>>
  >();
  /** Warnings not passed to the editor's onWarn yet (see flushWarnings). */
  private readonly pendingWarnings: LexicalWarning[] = [];
  /** Depth of the binding's own work in progress (see guard). */
  private busy = 0;
  /**
   * Whether the editor's classes cannot read the document (see failClosed):
   * the binding is read only, and reads nothing more.
   */
  private unreadable = false;
  private flushingWarnings = false;
  /** Whether start() has completed, and dispose() not run since. */
  private started = false;
  /** Whether initialize() was called before start(), which then runs it. */
  private initializeOnStart = false;
  private readonly afterAllTransactions = (): void => this.flushWarnings();

  /** The bound editor. */
  get editor(): LexicalEditor {
    return this._editor;
  }

  /** The shared document. */
  get doc(): YDoc {
    return this._doc;
  }

  /** The shared root this binding reads and writes. */
  get root(): YNode {
    return this._root;
  }

  /** See {@link YBindingStatus}; `onStatus` reports changes. */
  get status(): YBindingStatus {
    return this._status;
  }

  /** Storage kinds the document records per node type (see the README). */
  get pins(): ReadonlyMap<
    string,
    {readonly kind: StorageKind; readonly by?: readonly string[]}
  > {
    return this._pins;
  }

  /** The collaborative undo manager; null when undo is disabled. */
  get undoManager(): UndoManager | null {
    return this._undoManager;
  }

  constructor(editor: LexicalEditor, doc: YDoc, options: YBindingOptions) {
    // Before anything else: the @y/y the app loaded is the one this package
    // supports (once per module), and the document and root come from it.
    assertSupportedYjs();
    assertOwnYjsDoc(doc);
    invariant(
      options != null && isSchemaVersion(options.schemaVersion),
      "@lexical/y: YBinding needs options.schemaVersion (got %s): start at 1 and increase it whenever a node's stored fields or node types change",
      String(options == null ? undefined : options.schemaVersion),
    );
    this._editor = editor;
    this._doc = doc;
    this.options = options;
    this._root = options.root || doc.get(DEFAULT_ROOT_NAME);
    assertOwnYjsDoc(doc, this._root);
    this.state = new State(editor, doc, this._root);
    this.afterTransaction = tr =>
      this.guard(() => withPins(this._pins, () => this.onAfterTransaction(tr)));
    this.beforeTransaction = tr => {
      this.pendingCursor =
        this._status !== 'pending' &&
        tr.origin !== this &&
        tr.origin !== this.initOrigin &&
        tr.origin !== this.followUpOrigin
          ? this.getCursor()
          : null;
      this.noteChange(tr);
    };
  }

  /** Start listening; read the document if it is already initialized. */
  start(): () => void {
    return this.guard(() => this.startInner());
  }

  private startInner(): () => void {
    if (this.options.clientIDRange === 'uint32') {
      this.disposers.push(constrainClientID(this._doc));
    }
    // With block ids, a line without a marker gets an id derived from the
    // document (see Reader#$materialize).
    const blockIds = getPeerDependencyFromEditor<typeof BlockIdExtension>(
      this._editor,
      '@lexical/extension/BlockId',
    );
    this.state.blockIdHolder =
      blockIds === undefined ? null : id => blockIds.output.$getBlockById(id);
    this.state.blockIds =
      blockIds === undefined
        ? null
        : node =>
            !blockIds.output.disabled.peek() &&
            blockIds.output.$isIdentifiedBlock(node);
    // With transforms, BlockIdExtension's naming update changes what remote
    // changes bring, in ways the binding does not write; what they derive
    // (the start of a list they split) can differ between clients, which
    // then show different content. A document that runs Yjs's format
    // cleanup (one createYDoc did not make) deletes format items the binding
    // keeps, and may have deleted some already, before the binding attached
    // (see createYDoc). Fail closed rather than diverge.
    this.unsupportedConfig = [];
    if (blockIds !== undefined && blockIds.config.repairTransforms) {
      this.unsupportedConfig.push({
        options: ['BlockIdExtension.repairTransforms'],
        reason: 'repair-transforms',
      });
    }
    if (this._doc.cleanupFormatting !== false) {
      this.unsupportedConfig.push({reason: 'cleanup-formatting'});
    }
    this.schemaGate = null;
    this.schemaGateAfter = null;
    this.schemaSeenIn = null;
    // Lexical records explicit node moves (read by the writer, which then
    // rewrites what moved rather than what it passed) and text edits (see
    // TextReplay), each restored to what it was when the binding goes.
    const recordedMoves = this._editor._recordNodeMoves;
    const recordedTextEdits = this._editor._recordTextEdits;
    this._editor._recordNodeMoves = true;
    this._editor._recordTextEdits = true;
    this.disposers.push(() => {
      this._editor._recordNodeMoves = recordedMoves;
      this._editor._recordTextEdits = recordedTextEdits;
    });
    // Fail closed: not editable until the layout record has been read.
    this.wasEditable = this._editor.isEditable();
    this._editor.setEditable(false);
    // Yjs cleans up formats after a remote transaction by rescanning every
    // type that has formats (whole containers here, so O(document) per remote
    // bold). The binding keeps format items a write leaves redundant that
    // a concurrent write may rely on (see Cursor#delete), so its
    // containers opt out: they are marked as having no formats before Yjs
    // decides whether to clean up. A document createYDoc made never cleans
    // up; this keeps one that does (read only, see unsupportedConfig) from
    // cleaning up the binding's containers while it is bound. The document's
    // flag and the app's other types are left alone.
    this._doc.on('beforeObserverCalls', this.beforeObserverCalls);
    this.disposers.push(() =>
      this._doc.off('beforeObserverCalls', this.beforeObserverCalls),
    );
    this._doc.on('beforeTransaction', this.beforeTransaction);
    this.disposers.push(() =>
      this._doc.off('beforeTransaction', this.beforeTransaction),
    );
    this._doc.on('afterTransaction', this.afterTransaction);
    this.disposers.push(() =>
      this._doc.off('afterTransaction', this.afterTransaction),
    );
    // Warnings found while Yjs applies a change are passed on once it has
    // been applied in full (see flushWarnings).
    this._doc.on('afterAllTransactions', this.afterAllTransactions);
    this.disposers.push(() =>
      this._doc.off('afterAllTransactions', this.afterAllTransactions),
    );
    this.disposers.push(
      this._editor.registerUpdateListener(payload =>
        this.guard(() => {
          if (!this.task.committed) {
            this.task.committed = true;
            queueMicrotask(endOfTask(this.task));
          }
          withPins(this._pins, () => this.onUpdate(payload));
          const hidden = this.state.hidden;
          if (
            hidden !== null &&
            !payload.editorState.read(() => this.$holds(hidden))
          ) {
            this.pending.add('hidden');
          }
          if (
            this.refusedComposing.size > 0 &&
            this._editor._compositionKey === null
          ) {
            for (const cs of this.refusedComposing) {
              this.refused.add(cs);
            }
            this.refusedComposing.clear();
            this.pending.add('reread');
          }
          // The binding's own updates wait until the listeners are done
          // (see runPending), also work held back while composing or behind
          // a pending update; a re-read is queued as the next update (see
          // queueReread), the author's normalization right away (see
          // queueNormalize).
          if (this.pending.size > 0) {
            this.queueReread();
            this.queueNormalize();
            this.schedulePending();
          }
        }),
      ),
    );
    this.registerTransforms();
    if (this.options.captureTimeout !== null) {
      const um = new UndoManager(this._root, {
        captureTimeout: this.options.captureTimeout ?? 500,
        deleteFilter: item => !this.isKeptByUndo(item),
        trackedOrigins: new Set([this]),
      });
      this._undoManager = um;
      // Each step keeps the selection from before it, which undoing it
      // restores (as @lexical/history does): a local edit's from before the
      // edit, and the step an undo or redo pushes to the other stack the
      // selection from when it was undone or redone.
      um.on('stack-item-added', ({stackItem, origin}) => {
        stackItem.meta.set(
          this,
          origin === um ? this.undoneCursor : this.writeCursor,
        );
      });
      this.disposers.push(() => um.destroy());
    }
    this.noteTransforms();
    this.evaluate();
    // Started once all of the above has run: an initialize() call made
    // while it ran (from an editable or update listener) runs here, where
    // the editor's pending updates can commit.
    this.started = true;
    if (this.initializeOnStart) {
      this.initializeOnStart = false;
      withPins(this._pins, () => this.initializeInner());
    }
    return () => this.dispose();
  }

  /**
   * The binding's node transforms (see startInner), in order: the node
   * structure normalization, the wrapper that notes transforms registered
   * later (see noteRegistrations), then, for every class, the note of
   * which elements transforms ran on, the wrap of a named slot's shadow
   * root's inline children (see $wrapSlotShadowRootInline), a group's
   * canonical form and its items' wrapper switches, and the split of a text
   * node's line feeds.
   */
  private registerTransforms(): void {
    // Every edit is written in the normalized form its declarations describe
    // (children, mergeAdjacent), as NodeStructureExtension enforces it.
    this.disposers.push(registerNodeStructure(this._editor));
    this.disposers.push(this.noteRegistrations());
    const canonicalize = (node: LexicalNode) =>
      withPins(this._pins, () =>
        $canonicalizeGroup(node as ElementNode, this.state.blockIds),
      );
    // An item that starts or stops holding a nested group changes the
    // numbering of its group, which Lexical does not mark dirty: marked
    // here, its group's own transforms renumber it in the same update.
    const markGroupOfItem = (node: LexicalNode) =>
      withPins(this._pins, () => {
        const parent = node.getParent();
        if (
          $isElementNode(node) &&
          $isGroupNode(parent) &&
          $switchesWrapper(node, this._editor.getEditorState()._nodeMap)
        ) {
          parent.markDirty();
        }
      });
    // Which elements Lexical's transforms ran on: an update applied with
    // skipTransforms, or a state set whole, runs none on what it changes
    // (see normalizeUntransformed).
    const noteTransformed = (node: LexicalNode) => {
      this.transformed.add(node.getKey());
      if (
        $isRootNode(node) &&
        this._status === 'active' &&
        this.commitsAtOnce()
      ) {
        $flushSyncAfterUpdate();
      }
    };
    // A local change that leaves a wrapper holding no text (a delete of the
    // text in a link, or in a mark inside a link) makes Lexical serialize the
    // text fields this client set while the wrapper held text, which are
    // stored nowhere: in the same update, the wrapper shows the stored ones,
    // as every other client and a fresh reader do, and nothing follows the
    // update for an app to answer. Otherwise the write would write the
    // wrapper's whole value again over the content it keeps (a line break,
    // an inline decorator), over a collaborator's concurrent removal or
    // change of it. Runs on the element the change marks dirty: a stored
    // element inside wrappers (see $unstoredWrapperTextFields), or the
    // wrapper itself (its value is the one stored at its first atom).
    const settleTextFields = (node: LexicalNode) =>
      withPins(this._pins, () => {
        const state = this.state;
        const stored = state.yByKey.has(node.getKey());
        if (
          this._status !== 'active' ||
          this.unread !== null ||
          state.hidden !== null ||
          !(
            stored ||
            ($isElementNode(node) && node.isInline() && $isWrapper(node))
          ) ||
          $hasUpdateTag(COLLABORATION_TAG)
        ) {
          return;
        }
        const editor = this._editor;
        // The stored formats are looked up once per update (the document
        // does not change during its transforms).
        const memo = this.storedFormats;
        if (memo.state !== editor._pendingEditorState) {
          memo.state = editor._pendingEditorState;
          memo.sequences = new Map();
          memo.lines = new Map();
        }
        const fieldsOf = (type: string) => wrapperFieldsOf(editor, type);
        // The wrappers around the stored element (see
        // $unstoredWrapperTextFields), or the wrapper itself when its own
        // text changed (a delete of the text directly in a link); its value
        // is the one stored at its first atom before the update.
        const found: (readonly [ElementNode, Attrs | null, number, string])[] =
          stored
            ? $unstoredWrapperTextFields(
                state,
                [node.getKey()],
                fieldsOf,
                memo.sequences,
              ).map(
                ([wrapper, json]) =>
                  [
                    wrapper,
                    json,
                    wrapper.getTextFormat(),
                    wrapper.getTextStyle(),
                  ] as const,
              )
            : (node as ElementNode).shouldSerializeTextStyles() &&
                ((node as ElementNode).getTextFormat() !== 0 ||
                  (node as ElementNode).getTextStyle() !== '')
              ? [
                  [
                    node as ElementNode,
                    null,
                    (node as ElementNode).getTextFormat(),
                    (node as ElementNode).getTextStyle(),
                  ] as const,
                ]
              : [];
        if (found.length === 0) {
          return;
        }
        // Only a wrapper this update left without text, with the text fields
        // it had before the update: ones this update set (on a wrapper
        // without text, or in a transform) are stored by the write.
        const stale = editor.read('latest', () =>
          found.flatMap(([wrapper, json, format, style]) => {
            const was = $getNodeByKey(wrapper.getKey());
            if (
              !$isElementNode(was) ||
              was.shouldSerializeTextStyles() ||
              was.getTextFormat() !== format ||
              was.getTextStyle() !== style
            ) {
              return [];
            }
            if (json !== null) {
              return [[wrapper, json] as const];
            }
            const value = this.$storedWrapperValue(was, memo.lines);
            return value === null ? [] : [[wrapper, value] as const];
          }),
        );
        for (const [wrapper, json] of stale) {
          const {textFormat, textStyle} = json;
          if (
            wrapper.getTextFormat() !==
              (typeof textFormat === 'number' ? textFormat : 0) ||
            wrapper.getTextStyle() !==
              (typeof textStyle === 'string' ? textStyle : '')
          ) {
            $setTextFields(wrapper, json);
          }
        }
      });
    for (const {klass} of this._editor._nodes.values()) {
      if (klass.prototype instanceof ElementNode) {
        this.disposers.push(
          this._editor.registerNodeTransform(klass, noteTransformed),
          this._editor.registerNodeTransform(klass, settleTextFields),
          // The node structure normalization never reaches a named slot.
          this._editor.registerNodeTransform(klass, $wrapSlotShadowRootInline),
        );
      }
      const spec = getGroupSpec(klass);
      if (spec !== null && spec.klass === klass) {
        this.disposers.push(
          this._editor.registerNodeTransform(klass, canonicalize),
        );
        for (const item of spec.items) {
          this.disposers.push(
            this._editor.registerNodeTransform(item, markGroupOfItem),
          );
        }
      }
    }
    // A line break inside a text node ("a\nb", from code) is stored, and
    // read by every client, as a line break node: the author's text node is
    // split the same way in its own edit, so its editor shows the document.
    // Every text node class (token and segmented text, a code highlight).
    for (const {klass} of this._editor._nodes.values()) {
      if (klass === TextNode || klass.prototype instanceof TextNode) {
        this.disposers.push(
          this._editor.registerNodeTransform(
            klass as Klass<TextNode>,
            $splitLineBreaks,
          ),
        );
      }
    }
  }

  /** Disconnect from the document and the editor (`start` returns this). */
  dispose(): void {
    this.started = false;
    this.initializeOnStart = false;
    this.schemaGateAfter = null;
    this.schemaSeenIn = null;
    for (const d of this.disposers.splice(0)) {
      d();
    }
    // A pending or read-only binding made the editor non-editable: give it
    // back as it was before the binding.
    if (this._status !== 'active') {
      this._editor.setEditable(this.wasEditable);
    }
    this.state.clear();
    this.pending.clear();
    this.localRefresh.clear();
    this.refused.clear();
    this.refusedComposing.clear();
    this.keepsUnstored = false;
    this.warnedEdit = false;
    this.restoreTo = null;
    // The app's updates still held (see notifyApart) are the editor's, which
    // outlives the binding: handed back, they commit as any update of an
    // editor no binding listens to any more.
    this.handBackReplies();
    if (!this._editor._updating && this._editor._updates.length > 0) {
      try {
        this._editor.update(() => {}, {discrete: true});
      } catch (error) {
        rethrowLater(error);
      }
    }
    this.toSettle.clear();
    this.untransformed.clear();
    this.untransformedText.clear();
    this.storedHoles.clear();
    this.registrationPasses.length = 0;
    this._undoManager = null;
    this.flushWarnings();
  }

  /**
   * Call after the provider's first sync. An empty root is marked with this
   * layout and gets the editor's current content, unless an older layout's
   * root (`root`, `root-v2`) has content: such a document is read only, and
   * must be converted instead (a binding with `convert: true` writes the
   * layout root next to the old one). Anything else is read.
   *
   * The initial content (including an update still pending, such as
   * `editor.update(seed)` right before this call) is not part of the undo
   * history. It is written once, under a client id derived from those exact
   * bytes (see seedUpdate), applied to the document as they are and read
   * back like any document, so that two clients initializing the same
   * document with the same content at once write the same items (one copy),
   * and one id never holds two payloads. That holds for a root inside
   * another shared type and for a root that held content, deleted since,
   * as for a new document.
   *
   * Called before `start()` (from an extension's `register`, before
   * YCollabExtension starts the binding), it runs when the binding starts,
   * once the editor has its initial state.
   */
  initialize(): void {
    if (!this.started) {
      this.initializeOnStart = true;
      return;
    }
    this.guard(() => withPins(this._pins, () => this.initializeInner()));
  }

  private initializeInner(): void {
    if (this._status !== 'pending') {
      return;
    }
    if (this._root.length === 0 && recordedLayout(this._root) === null) {
      // An update still pending (`editor.update(seed)` right before this
      // call) is part of the initial content: committed now, while the
      // binding is pending and writes nothing, then written with it. A
      // listener of that commit can apply a remote change (a provider's
      // first sync), so the document is looked at after it.
      this.commitPending();
      if (this._status !== 'pending') {
        return;
      }
      if (this._root.length > 0 || recordedLayout(this._root) !== null) {
        this.evaluate();
        return;
      }
      const legacy = this.options.convert ? [] : this.legacyRootsWithContent();
      if (legacy.length > 0) {
        this.warn(
          UNSUPPORTED_LAYOUT_WARNING,
          `older layout roots have content: ${legacy.join(', ')}. They are the Yjs 13 binding's roots, so this editor is read only: keep the document on that binding, reseed its content into a new room with seedYState, or pass convert: true to initialize next to them`,
          {reason: 'legacy-roots', roots: legacy, supported: LAYOUT_VERSION},
        );
        this.setStatus('readonly');
        return;
      }
      if (this.unsupportedConfig.length > 0 || this.checkSchema()) {
        // Read only (see setStatus): the initial content is not written.
        this.setStatus('active');
        return;
      }
      const editorState = this._editor.getEditorState();
      if (this.refuseUnstorableSlots(editorState, null)) {
        return;
      }
      // What the cursor leaves out of the selection (a range's typing format
      // and style, a node selection), kept too: a node selection by the
      // items written for its nodes (see $restoreSelectionState).
      const kept = editorState.read($selectionState);
      const selected = kept !== null && kept.kind === 'node' ? kept.keys : [];
      const seed = this.seedUpdate(editorState, selected);
      if (seed !== null) {
        // The seed's exact bytes, under the id derived from them, the
        // binding's only items under another client id than the document's;
        // read back like any document's content, so the editor shows what
        // is stored (and the state maps it), with its selection kept.
        applyUpdate(this._doc, seed.bytes, this.initOrigin);
        if (kept !== null && kept.kind === 'node') {
          kept.items = seed.items;
        }
        this.evaluate(seed.cursor, kept);
        return;
      }
      this._doc.transact(tr => {
        this.$writeInitial(this.state, this._root, tr, editorState);
      }, this.initOrigin);
      if (kept !== null && kept.kind === 'node') {
        kept.items = editorState.read(() =>
          this.$selectedAnchors(this.state, selected),
        );
      }
      // Read back as the seed is, so that the editor shows what is stored on
      // every route (text written with a line break in it shows as a line
      // break node, as on every reader), with its selection kept: every
      // container, as the nodes the write stored keep their content otherwise
      // (a table cell's text).
      this.evaluate(
        editorState.read(() => this.$cursorBeforeRead()),
        kept,
        true,
      );
      return;
    }
    this.evaluate();
  }

  /**
   * Write the layout record, the schema record (see SCHEMA_PREFIX) and the
   * editor's content into an empty root, the records first (see
   * LAYOUT_PREFIX), and layout 2 when the content holds a
   * member entry of a set (see recordSetMembersLayout).
   */
  private $writeInitial(
    state: State,
    root: YNode,
    tr: Transaction,
    editorState: EditorState,
  ): void {
    root.setAttr(LAYOUT_PREFIX + BASE_LAYOUT_VERSION, true);
    root.setAttr(SCHEMA_PREFIX + this.options.schemaVersion, true);
    try {
      // Every element type of the initial content (into `root`, which may
      // be a scratch document's: this._pins is filled when the real one is
      // read).
      this.recordPins(root, editorState, null, new Map());
      editorState.read(() => {
        const roles = new Roles(state);
        const cs = state.newCS(root, 'root', 'b');
        const writer = new Writer(state, roles, tr, editorState, {
          attrs: new Set(),
          inline: new Set(),
          lines: new Set(),
          removedText: new Map(),
          structural: new Set(['root']),
        });
        writer.$writeContainer(cs, $getRoot());
      });
    } finally {
      recordSetMembersLayout(root, tr);
    }
  }

  private clientIDRange(): ClientIDRange {
    return this.options.clientIDRange === 'uint32' ? 'uint32' : 'uint53';
  }

  /**
   * The initial content of the root as a Yjs update, written once: into a
   * scratch document under a fixed client id, with this binding's
   * configuration (with or without block ids, and which blocks are
   * identified, change the items), hashed into a client id, and written
   * again under that id the same way (the writer gives the same items for
   * the same input). It is the scratch state's first write, so its segment
   * keys are that id and a counter from the id's clock on every client.
   *
   * - A pristine top-level root (one that has never held an item or an
   *   attribute) is written into an empty scratch document; the hash covers
   *   the layout version, the root's name and the bytes. So two clients
   *   share an id only when they write the same bytes into the same root.
   * - Any other root (inside another shared type, or one that held content,
   *   deleted since) is written into a copy of the document, and the update
   *   is what that write added. Its items name what they were written next
   *   to (the deleted items, the parent type's item), which a copy holds and
   *   an empty document does not. The hash covers the copy's state vector
   *   too: two clients share an id only when they wrote the same bytes on
   *   the same document, where the second write under that id gives the
   *   same items as well. A client that has seen other changes gets another
   *   id, and the content shows twice, as before.
   *
   * That copy costs the whole document (other editors' roots included),
   * encoded once and read twice, at the initialization of such a root.
   *
   * Null where a top-level root is not found among the document's shared
   * types, or a nested root was deleted.
   */
  private seedUpdate(
    editorState: EditorState,
    selected: readonly NodeKey[],
  ): {
    bytes: Uint8Array;
    cursor: YCursor | null;
    items: SelectedAnchor[];
  } | null {
    const rootItem = this._root._item;
    for (let t: YNode | null = this._root; t !== null; t = t.parent) {
      if (t._item !== null && t._item.deleted) {
        // A root inside a shared type entry deleted since (the app holds
        // the Y.Node still): nothing written there is stored, as before.
        return null;
      }
    }
    let name: string | null = null;
    if (rootItem === null) {
      this._doc.share.forEach((type, key) => {
        if (type === this._root) {
          name = key;
        }
      });
      if (name === null) {
        return null;
      }
    }
    const rootName: string | null = name;
    const pristine =
      rootItem === null &&
      this._root._start === null &&
      this._root._map.size === 0;
    // The document as it is, which the write of any other root goes on.
    const base = pristine ? null : encodeStateAsUpdate(this._doc);
    const baseVector = pristine ? null : encodeStateVector(this._doc);
    const write = (clientID: number) => {
      const scratch = createYDoc(base, {gc: false});
      const before = base === null ? null : encodeStateVector(scratch);
      scratch.clientID = clientID;
      const sroot =
        rootItem === null
          ? scratch.get(rootName!)
          : storedTypeOf(scratch, rootItem.id.client, rootItem.id.clock);
      const sstate = this.state.configuredLike(scratch, sroot);
      scratch.transact(tr =>
        this.$writeInitial(sstate, sroot, tr, editorState),
      );
      // The editor's selection, as positions on the items written (and a
      // node selection's nodes, as those items): the same ids in the
      // document once the bytes are applied.
      const cursor = editorState.read(() => this.$cursorBeforeRead(sstate));
      const items = editorState.read(() =>
        this.$selectedAnchors(sstate, selected),
      );
      const bytes =
        before === null
          ? encodeStateAsUpdate(scratch)
          : encodeStateAsUpdate(scratch, before);
      scratch.destroy();
      return {bytes, cursor, items};
    };
    const {bytes} = write(1);
    const content = byteString(bytes);
    return write(
      initClientID(
        baseVector === null
          ? BASE_LAYOUT_VERSION +
              '\u0000' +
              'r:' +
              rootName +
              '\u0000' +
              content
          : BASE_LAYOUT_VERSION +
              '\u0000' +
              'd:' +
              byteString(baseVector) +
              '\u0000' +
              content,
        this.clientIDRange(),
      ),
    );
  }

  /** Older layouts' roots that hold content. */
  private legacyRootsWithContent(): string[] {
    const out: string[] = [];
    for (const name of LEGACY_ROOTS) {
      const type = this._doc.share.get(name);
      if (type === undefined) {
        continue;
      }
      let content = type._map.size > 0;
      for (let it = type._start; it !== null && !content; it = it.right) {
        if (!it.deleted) {
          content = true;
        }
      }
      if (content) {
        out.push(name);
      }
    }
    return out;
  }

  /**
   * Read the kinds the document records per type. A registered class whose
   * own derivation differs uses the recorded kind when it can be stored that
   * way; otherwise the document is read only (returns false).
   */
  private loadPins(): boolean {
    this._pins.clear();
    const attrs = this._root.getAttrs() as Record<string, unknown>;
    const mismatches: YStorageMismatchData[] = [];
    for (const key of Object.keys(attrs)) {
      const v = attrs[key];
      if (key.startsWith(PIN_PREFIX) && typeof v !== 'string') {
        // Not a record this editor can read: writing would overwrite it.
        mismatches.push({
          found: v,
          key,
          reason: 'malformed',
          type: key.slice(PIN_PREFIX.length),
        });
      } else if (key.startsWith(PIN_PREFIX) && typeof v === 'string') {
        // `kind` or `kind|field,field` (a group's or format's identity).
        const [kind, by] = v.split('|');
        this._pins.set(key.slice(PIN_PREFIX.length), {
          by: by === undefined ? undefined : by.split(','),
          kind: kind as Pin['kind'],
        });
      }
    }
    for (const [type, pin] of this._pins) {
      const info = this._editor._nodes.get(type);
      if (info === undefined) {
        continue;
      }
      const derived = deriveStorageKind(info.klass);
      const by = identityOf(info.klass);
      if (pin.kind !== derived && !canStoreAs(info.klass, pin.kind)) {
        mismatches.push({
          declared: {kind: derived},
          reason: 'declaration-changed',
          stored: {kind: pin.kind},
          type,
        });
      } else if (
        (pin.kind === 'group' || pin.kind === 'format') &&
        pin.by !== undefined &&
        pin.kind === derived &&
        JSON.stringify(pin.by) !== JSON.stringify(by)
      ) {
        mismatches.push({
          declared: {by, kind: derived},
          reason: 'declaration-changed',
          stored: {by: pin.by, kind: pin.kind},
          type,
        });
      }
    }
    if (mismatches.length > 0) {
      for (const m of mismatches) {
        this.warn(
          STORAGE_MISMATCH_WARNING,
          m.reason === 'malformed'
            ? `the storage record of ${m.type} is malformed, so this editor is read only: something other than this binding wrote the root's records; reseed the content into a new room with seedYState`
            : `${m.type} is stored as ${m.stored.kind}, its class as ${m.declared.kind}. A document keeps the kind its first write of a type recorded, so this editor is read only: restore the class's previous node structure declaration, or reseed the content into a new room with seedYState to adopt the new one`,
          m,
        );
      }
      this.setStatus('readonly');
      return false;
    }
    return true;
  }

  /** Record the kind of every element type written for the first time. */
  private recordPins(
    root: YNode,
    editorState: EditorState,
    keys: readonly NodeKey[] | null,
    pins: Map<string, Pin> = this._pins,
  ): void {
    const nodeMap = editorState._nodeMap;
    const seen = new Set<string>();
    const visit = (node: LexicalNode | undefined) => {
      if (node === undefined || !$isElementNode(node) || $isRootNode(node)) {
        return;
      }
      const type = node.getType();
      if (seen.has(type) || pins.has(type)) {
        return;
      }
      seen.add(type);
      const klass = node.constructor as Klass<LexicalNode>;
      const kind = storageKindOf(klass);
      const pin: Pin =
        kind === 'group' || kind === 'format'
          ? {by: identityOf(klass), kind}
          : {kind};
      pins.set(type, pin);
      root.setAttr(
        PIN_PREFIX + type,
        pin.by === undefined ? kind : kind + '|' + pin.by.join(','),
      );
    };
    withPins(this._pins, () => {
      if (keys === null) {
        for (const node of nodeMap.values()) {
          visit(node);
        }
      } else {
        for (const key of keys) {
          visit(nodeMap.get(key));
        }
      }
    });
  }

  /**
   * Read the document's layout and content (`cursor` and `kept`: the
   * selection to put back on it, see initializeInner; otherwise there is
   * none).
   */
  private evaluate(
    cursor: YCursor | null = null,
    kept: SelectionState | null = null,
    deep = false,
  ): void {
    // First, so that its warning comes before those a newer version's
    // content explains (node types this one lacks, storage it declares
    // otherwise).
    const newerSchema = this.checkSchema();
    if (!this.loadPins()) {
      this.readAll(cursor, kept, deep);
      return;
    }
    const version = recordedLayout(this._root);
    if (version === null) {
      if (this._root.length > 0 || this._status === 'active') {
        // Content without a layout record, or a record removed from a
        // document this binding was writing (an outside writer deleted it;
        // no client of this layout deletes one): no layout is known, so
        // nothing is written.
        const reason = this._root.length > 0 ? 'missing' : 'removed';
        this.warn(
          UNSUPPORTED_LAYOUT_WARNING,
          reason === 'missing'
            ? 'the root has content and no layout record, so this editor is read only: the record was deleted, or something other than this binding wrote the root. Bind a root only this binding writes (the root option), and reseed the content into a new room with seedYState'
            : 'the layout record was removed, so this editor is read only: something other than this binding wrote the root; reseed the content into a new room with seedYState',
          {reason, supported: LAYOUT_VERSION},
        );
        this.setStatus('readonly');
        this.readAll(cursor, kept, deep);
      }
      return;
    }
    const malformed = malformedLayout(this._root);
    if (malformed !== null) {
      this.warn(
        UNSUPPORTED_LAYOUT_WARNING,
        `the layout record ${malformed.key} is malformed, so this editor is read only: something other than this binding wrote the root's records; reseed the content into a new room with seedYState`,
        {...malformed, reason: 'malformed', supported: LAYOUT_VERSION},
      );
      this.setStatus('readonly');
    } else if (version > LAYOUT_VERSION) {
      this.warn(
        UNSUPPORTED_LAYOUT_WARNING,
        `layout ${version} is newer than ${LAYOUT_VERSION}. A newer version of the binding wrote this document, so this editor is read only: upgrade the binding on every client of the document`,
        {found: version, reason: 'newer', supported: LAYOUT_VERSION},
      );
      this.setStatus('readonly');
    } else if (newerSchema) {
      this.setStatus('readonly');
    } else if (this._status === 'active' || this.staysReadOnly()) {
      // Still active, or read only for good (see setStatus).
      this.setStatus('active');
    } else {
      // Active once the read found nothing that keeps it read only (see
      // readAll).
      this.readAll(cursor, kept, deep, true);
      return;
    }
    this.readAll(cursor, kept, deep);
  }

  /**
   * Whether the document's schema record keeps the binding read only: a
   * client whose `schemaVersion` is higher wrote to it, or a record is
   * malformed (see SCHEMA_PREFIX). Warns (UNSUPPORTED_SCHEMA_WARNING) when
   * that is new, or a higher version than the one warned about. Sticky: once
   * found, it keeps the binding read only (see staysReadOnly) until it is
   * disposed.
   */
  private checkSchema(): boolean {
    const supported = this.options.schemaVersion;
    const malformed = malformedSchema(this._root);
    let data: YUnsupportedSchemaData | null = null;
    if (malformed !== null) {
      data = {...malformed, reason: 'malformed', supported};
    } else {
      const found = newestSchema(this._root);
      if (found !== null && found > supported) {
        data = {found, reason: 'newer', supported};
      }
    }
    const gate = this.schemaGate;
    if (
      data !== null &&
      (gate === null ||
        gate.reason !== data.reason ||
        (gate.reason === 'newer' &&
          data.reason === 'newer' &&
          data.found > gate.found))
    ) {
      this.schemaGate = data;
      this.warn(
        UNSUPPORTED_SCHEMA_WARNING,
        data.reason === 'newer'
          ? `schema ${data.found} is newer than ${supported}. A newer version of your app (a higher schemaVersion) wrote this document, so this editor is read only: load the newer app version to edit it`
          : `the schema record ${data.key} is malformed, so this editor is read only: something other than this binding wrote the root's records; reseed the content into a new room with seedYState`,
        data,
      );
    }
    return this.schemaGate !== null;
  }

  /**
   * Read only once a remote change brought a schema record that keeps the
   * binding so (see checkSchema). Invariant: run once the local updates
   * pending before the change are committed (see guardedRead), and, where
   * the change was applied while an update was running, once that update
   * has committed (deferred). Why: they were made while the binding could
   * write, and are written; committed read only, they would be refused and
   * lost.
   */
  private gateSchema(): void {
    const editor = this._editor;
    if (editor._updating && editor._pendingEditorState !== null) {
      if (this.schemaGateAfter === null) {
        const after = editor._pendingEditorState;
        this.schemaGateAfter = after;
        editor._deferred.push(() =>
          this.guard(() => {
            // Not after dispose() (which clears it), nor for a later update.
            if (this.started && this.schemaGateAfter === after) {
              this.schemaGateAfter = null;
              this.gateSchema();
            }
          }),
        );
      }
      return;
    }
    this.schemaGateAfter = null;
    if (this.checkSchema() && this._status !== 'readonly') {
      this.setStatus('readonly');
    }
  }

  /** Whether a local update is running, pending or queued. */
  private localPending(): boolean {
    const editor = this._editor;
    return (
      editor._updating ||
      editor._pendingEditorState !== null ||
      editor._updates.length > 0 ||
      this.replies.length > 0
    );
  }

  /**
   * Whether the local update that committed `editorState` was made on a
   * schema record that keeps the binding read only, so that it is refused
   * rather than written (see onUpdate). A record a remote change brought is
   * one the update was made on unless the change is still unread (applied
   * by Yjs, not yet read: the update was made before it, see Unread), and
   * its transaction's observers did not see it with nothing pending (see
   * beforeObserverCalls). The update that was running when the change
   * arrived is written (see gateSchema).
   */
  private schemaGatesWrite(editorState: EditorState): boolean {
    if (this.schemaGateAfter !== null) {
      if (this.schemaGateAfter === editorState) {
        return false;
      }
      // The update the gate waited for never committed (it threw).
      this.schemaGateAfter = null;
    }
    const keys = gatingSchemaKeys(this._root, this.options.schemaVersion);
    if (keys.length === 0) {
      return false;
    }
    if (this.schemaSeenIn !== null) {
      return true;
    }
    const view = this.unread;
    return keys.some(key => {
      const item = this._root._map.get(key);
      return (
        view === null ||
        item === undefined ||
        !view.changes.some(change => change.insertSet.hasId(item.id))
      );
    });
  }

  /**
   * Whether the binding is active and reads the layout the document records
   * now: a peer that recorded a version this binding reads (the first
   * member entry of a set records 2) changes nothing it reads or writes, so
   * the document is not read again.
   */
  private readsRecordedLayout(): boolean {
    if (this._status !== 'active') {
      return false;
    }
    const version = recordedLayout(this._root);
    return (
      version !== null && !Number.isNaN(version) && version <= LAYOUT_VERSION
    );
  }

  /** Self-check of containers a remote change rebuilt (see checkContainer). */
  private checkRead(rebuilt: ReadonlySet<CS>): void {
    const check = this.options.selfCheck === true;
    // Skipped while a re-read is pending (see refused): the editor then
    // shows a follow-up's change that is read again right after.
    if (
      !check ||
      rebuilt.size === 0 ||
      this.refused.size > 0 ||
      Math.random() >= (this.options.selfCheckSample ?? 1)
    ) {
      return;
    }
    const editorState = this._editor.getEditorState();
    const problems: string[] = [];
    const wrong: CS[] = [];
    for (const cs of rebuilt) {
      if (sampleWholeContainer(cs)) {
        const found = checkContainer(this.state, cs, editorState);
        if (found.length > 0) {
          wrong.push(cs);
          // A line holding lines (written without the normalization, which
          // has not run yet) is stored as the lines the normalization leaves
          // (see Writer#$pushLine): the editor differs from the shared
          // content there until it runs. The read below brings it in line,
          // which is no reader bug.
          if (!editorState.read(() => this.$holdsWrittenLines(cs))) {
            pushAll(problems, found);
          }
        }
      }
    }
    if (problems.length > 0) {
      this.warn(
        SELF_CHECK_WARNING,
        'self-check (remote): ' + problems.slice(0, 5).join('; '),
        {problems, reason: 'remote'},
      );
    }
    if (wrong.length > 0) {
      // After a remote change the shared content is right and the editor is
      // wrong (a reader bug): read those containers again in full, which
      // moves this client to what every fresh reader shows.
      this.rereadContainers(wrong);
    }
  }

  /**
   * Whether the editor's element of container `cs` holds, at any depth (the
   * comparison covers the containers inside it), a line that holds lines
   * (see Writer#$pushLine).
   */
  private $holdsWrittenLines(cs: CS): boolean {
    const el = cs.y === this._root ? $getRoot() : $getNodeByKey(cs.key);
    if (!$isElementNode(el) || !el.isAttached()) {
      return false;
    }
    const roles = new Roles(this.state);
    const visit = (n: ElementNode): boolean => {
      for (const c of n.getChildren()) {
        if (!$isElementNode(c)) {
          continue;
        }
        if (roles.$role(c) === 'line') {
          if ($holdsLines(roles, c)) {
            return true;
          }
        } else if (visit(c)) {
          return true;
        }
      }
      return false;
    };
    return visit(el);
  }

  private rereadContainers(list: CS[], extraTags: string[] = []): void {
    this.guardedRead({
      $read: () => {
        const cursor = this.$cursorBeforeRead();
        const caret = $showsCaret();
        const reader = new Reader(this.state);
        reader.$reading(() => {
          for (const cs of list) {
            const el = cs.y === this._root ? $getRoot() : $getNodeByKey(cs.key);
            if ($isElementNode(el) && el.isAttached()) {
              reader.$readFull(cs, el);
            }
          }
        });
        this.$selectionAfterRead(cursor, caret);
        this.$quietSelection();
      },
      recover: (error, shown) => this.recoverRead(error, shown),
      tag: [...REMOTE_TAGS, ...extraTags],
    });
  }

  /**
   * Fail closed on named slots the document cannot store (see
   * $unstorableSlotHosts), among the nodes `keys` of `editorState` (all of
   * them when null): warn and open read only, without writing. Returns
   * whether it did.
   */
  private refuseUnstorableSlots(
    editorState: EditorState,
    keys: Iterable<NodeKey> | null,
  ): boolean {
    const types = editorState.read(() =>
      $unstorableSlotHosts(new Roles(this.state), keys, editorState._nodeMap),
    );
    if (types.length === 0) {
      return false;
    }
    const hosts = types.filter(t => t !== 'root');
    if (hosts.length > 0) {
      this.warn(
        UNSUPPORTED_SLOTS_WARNING,
        `slots on nodes stored as a line, a format or a group: ${hosts.join(', ')}. They cannot be stored, so this editor is read only: declare slots in the class's $config, which stores it as a node of its own`,
        {reason: 'stored-host', types: hosts},
      );
    }
    if (hosts.length < types.length) {
      this.warn(
        UNSUPPORTED_SLOTS_WARNING,
        'slots on the root cannot be stored, so this editor is read only: set them on a node of its own',
        {reason: 'root', types: ['root']},
      );
    }
    this.keepsUnstored = true;
    this.setStatus('readonly');
    return true;
  }

  /**
   * Fail closed when a read found node types this editor lacks, or stored
   * content its classes throw on (see Reader#$readStored): warn, and go
   * read only. Only a binding that is active, or becomes active with this
   * read (`activating`, see activateAfterRead), does: a read-only one warned
   * already, or stays read only for a reason it warned about.
   */
  private checkUnknownTypes(activating = false): void {
    if (!activating && this._status !== 'active') {
      return;
    }
    const unreadable = this.state.unreadable;
    if (unreadable.size > 0) {
      const types = [...unreadable.keys()].sort();
      this.warn(
        UNKNOWN_NODE_TYPES_WARNING,
        `stored content the editor's classes cannot read: ${types.join(', ')}. Their classes threw on the stored values (data.error), so this editor is read only: make them accept what another version of your app wrote, and bump schemaVersion when a class changes what it stores`,
        {
          error: unreadable.get(types[0]),
          reason: 'unreadable',
          types,
        },
      );
      this.setStatus('readonly');
      return;
    }
    const unknown = this.state.unknownTypes;
    if (unknown.size > 0) {
      const slots = this.state.malformedSlots;
      const types = [...unknown].filter(t => !slots.has(t)).sort();
      if (types.length > 0) {
        this.warn(
          UNKNOWN_NODE_TYPES_WARNING,
          `unregistered node types: ${types.join(', ')}. This editor is read only: register the same node classes (or extensions) as the clients that wrote them`,
          {reason: 'unregistered', types},
        );
      }
      if (slots.size > 0) {
        const malformed = [...slots].sort();
        this.warn(
          UNKNOWN_NODE_TYPES_WARNING,
          `malformed slots: ${malformed.join(', ')}, so this editor is read only: something other than this binding wrote them; reseed the content into a new room with seedYState`,
          {reason: 'malformed-slot', types: malformed},
        );
      }
      this.setStatus('readonly');
    }
  }

  /*
   * Read only answers three questions, kept apart because their callers
   * differ: whether a remote change is read into the editor (readsChanges),
   * whether a local update is written (writesEdits), and whether the editor
   * and the document are compared (State#differsOnPurpose).
   */

  /**
   * Whether a remote change is read into the editor: not once the binding
   * failed closed (see failClosed), whatever its status.
   */
  private readsChanges(): boolean {
    return !this.unreadable;
  }

  /**
   * Whether a local update is written (and an undo or redo applied, and the
   * author's normalization run): only while the binding is active (see
   * YBindingStatus, and staysReadOnly for what keeps it read only).
   */
  private writesEdits(): boolean {
    return this._status === 'active';
  }

  /**
   * Whether something keeps the binding read only for good: a configuration
   * it does not support, a newer schema version (see checkSchema), node types it cannot build (or slots it cannot
   * read), stored content its classes throw on, a local change it cannot
   * store and keeps showing, or a document it cannot read (see failClosed).
   */
  private staysReadOnly(): boolean {
    return (
      this.unsupportedConfig.length > 0 ||
      this.schemaGate !== null ||
      this.state.unknownTypes.size > 0 ||
      this.state.unreadable.size > 0 ||
      this.keepsUnstored ||
      this.unreadable
    );
  }

  /**
   * Invariant: while staysReadOnly, the status is `'readonly'`, even for
   * the moment a change to the layout record has the document read again.
   * Why: an editor made editable for that moment takes edits that are not
   * written.
   */
  private setStatus(status: YBindingStatus): void {
    if (status === 'active' && this.staysReadOnly()) {
      if (this._status !== 'readonly') {
        for (const data of this.unsupportedConfig) {
          this.warn(
            UNSUPPORTED_CONFIG_WARNING,
            data.reason === 'repair-transforms'
              ? `unsupported options: ${data.options.join(', ')}. Nothing is written: configure BlockIdExtension with repairTransforms: false, as YCollabExtension does`
              : 'the document cleans up formats: create it with createYDoc() instead of new Y.Doc(). Nothing is written until then',
            data,
          );
        }
      }
      status = 'readonly';
    }
    if (status === 'active') {
      this.warnedEdit = false;
    }
    if (this._status !== status && this.options.onStatus) {
      // Reported with the warnings, once Yjs is idle (see flushWarnings).
      this.pendingStatus = status;
    }
    this._status = status;
    this.notifyApart(() =>
      this._editor.setEditable(status === 'active' && this.wasEditable),
    );
    // Nothing is written while read only, an undo or redo included: the
    // undo history goes, which a direct UndoManager call could still apply.
    if (status === 'readonly' && this._undoManager !== null) {
      this._undoManager.clear();
    }
  }

  /**
   * Notify the app's listeners (`notify`, such as `editor.setEditable`)
   * apart from the binding's own updates.
   *
   * - An update a listener makes in reply (Lexical queues it while it
   *   notifies) is held (`replies`), never run inside an update of the
   *   binding's, tagged as a remote change, where it would be neither
   *   written nor refused (see onUpdate). It is handed back to the front of
   *   Lexical's queue (see handBackReplies) right after the update that runs
   *   now commits, ahead of any later update of the app's; where a listener
   *   of that commit threw (Lexical then skips its callbacks), once the
   *   editor is idle (see runPending) or before the binding's next update
   *   (see commitPending).
   * - What a listener throws is rethrown in a microtask (an uncaught error,
   *   as for the app's updates, see commitPending): it never fails the
   *   binding's work.
   */
  private notifyApart(notify: () => void): void {
    const editor = this._editor;
    const queued = editor._updates.length;
    try {
      notify();
    } catch (error) {
      rethrowLater(error);
    }
    const replies = editor._updates.splice(queued);
    if (replies.length === 0) {
      return;
    }
    this.replies.push(...replies);
    for (const update of editor._updates.slice(0, queued)) {
      this.queuedBeforeReplies.add(update);
    }
    if (editor._updating && editor._pendingEditorState === null) {
      // In a commit's listeners or callbacks: Lexical runs its queue right
      // after them.
      this.handBackReplies();
    } else if (editor._updating) {
      // In an update: with its callbacks, once it committed.
      editor._deferred.push(() => this.handBackReplies());
    }
    this.pending.add('replies');
    this.schedulePending();
  }

  /**
   * Put the held replies (see notifyApart) back in Lexical's queue, in their
   * order and with their options: after the updates queued before them that
   * are still queued, ahead of any queued after them.
   */
  private handBackReplies(): void {
    const updates = this._editor._updates;
    let at = updates.length;
    while (at > 0 && !this.queuedBeforeReplies.has(updates[at - 1])) {
      at--;
    }
    this.queuedBeforeReplies.clear();
    updates.splice(at, 0, ...this.replies.splice(0));
  }

  /**
   * Report a warning to the editor's `onWarn`, as a `LexicalWarning`. It is
   * queued and passed on once the binding's work is done and Yjs is idle:
   * never inside a Yjs observer or transaction, and never half way through
   * a read or a write (see flushWarnings).
   */
  private warn<C extends YWarningCode>(
    code: C,
    message: string,
    data: YWarningData<C>,
  ): void {
    this.pendingWarnings.push(new LexicalWarning(code, message, data));
  }

  /** Run the binding's own work; queued warnings are passed on after it. */
  private guard<T>(fn: () => T): T {
    this.busy++;
    try {
      // On the document as this binding's editor shows it (see unread),
      // whatever another binding of the document shows.
      return seenBy(this.seer, fn);
    } finally {
      this.busy--;
      this.flushWarnings();
    }
  }

  /**
   * Pass the queued warnings to the editor's `onWarn`, when nothing is in
   * progress: no work of the binding's (see guard) and no Yjs transaction
   * (the change has been applied, observers included; afterAllTransactions
   * calls this again). A handler that throws does not stop the others or
   * the binding, which is consistent by then: its error is rethrown in a
   * microtask (an uncaught error, as Lexical's default `onWarn` throws in
   * development), never into Yjs or a provider.
   */
  private flushWarnings(): void {
    // Warnings about classes and values (see noteOnce), found by any
    // binding: each binding reports each once, a class's only where its
    // editor has the class.
    const [notes, seen] = notesSince(this.notesSeen);
    this.notesSeen = seen;
    for (const note of notes) {
      if (
        note.code !== NESTED_FALLBACK_WARNING ||
        this._editor._nodes.has(note.data.type)
      ) {
        this.pendingWarnings.push(
          new LexicalWarning(note.code, note.message, note.data),
        );
      }
    }
    const doc = this._doc;
    if (
      this.flushingWarnings ||
      this.busy > 0 ||
      (this.pendingWarnings.length === 0 && this.pendingStatus === null) ||
      doc._transaction !== null ||
      doc._transactionCleanups.length > 0
    ) {
      return;
    }
    this.flushingWarnings = true;
    try {
      const status = this.pendingStatus;
      this.pendingStatus = null;
      if (status !== null && this.options.onStatus) {
        try {
          this.options.onStatus(status);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
      for (
        let warning = this.pendingWarnings.shift();
        warning !== undefined;
        warning = this.pendingWarnings.shift()
      ) {
        try {
          this._editor._onWarn(warning);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    } finally {
      this.flushingWarnings = false;
    }
  }

  /**
   * Read the whole document. With `activate`, the binding becomes active
   * once the read is done, where it found nothing that keeps it read only
   * (see activateAfterRead): never before, so the editor is never editable
   * for a document the binding cannot write.
   */
  private readAll(
    cursor: YCursor | null = null,
    kept: SelectionState | null = null,
    deep = false,
    activate = false,
  ): void {
    // Whether activation is still owed (see activateAfterRead).
    let toActivate = activate;
    const activateOnce = () => {
      if (toActivate) {
        toActivate = false;
        this.activateAfterRead();
      }
    };
    this.guardedRead({
      $read: () => {
        this.$readAllInner(cursor, kept, deep);
        if (activate) {
          // Right after the read's commit, and only after one: nothing the
          // app does when the editor becomes editable runs inside the read
          // (an editable listener's update or command), and an update made
          // in reply to the read (an update listener's), which Lexical runs
          // after this, is written.
          $onUpdate(() => this.guard(() => withPins(this._pins, activateOnce)));
        }
      },
      after: () => {
        // Where an app listener threw on the read's commit, Lexical skipped
        // its $onUpdate callbacks, and the read stands (see guardedRead):
        // the binding becomes active here, after the commit all the same.
        activateOnce();
        this.checkUnknownTypes();
        this.flushRefresh(true);
      },
      // The whole document as it is, the change being read included (see
      // startReading): read inside a transaction (a layout record a change
      // brought, see readChange), it would otherwise show that change's
      // content as not there yet.
      before: () => this.startReading(),
      // The whole document: read again, it would throw again.
      recover: (error, shown) => this.failClosed(error, shown),
      replacesPending: true,
      tag: REMOTE_TAGS,
    });
  }

  /**
   * Become active after a read of the whole document, unless it found
   * something that keeps the binding read only: node types the editor
   * lacks or stored content its classes throw on (warned here, see
   * checkUnknownTypes), or another lasting cause (see setStatus).
   */
  private activateAfterRead(): void {
    this.checkUnknownTypes(true);
    this.setStatus('active');
    // The read committed while the editor was not editable, so Lexical left
    // its selection off the DOM: an update sets it again, which puts it
    // there (Lexical sets the DOM selection only of a focused editor). It
    // runs ahead of the updates the app queued in reply to the read, whose
    // selection then stands, and not where the app set an editor state of
    // its own in reply (pending now).
    const editor = this._editor;
    const selection = editor.getEditorState()._selection;
    if (
      selection !== null &&
      this._status === 'active' &&
      editor.isEditable() &&
      editor.getRootElement() !== null &&
      editor._pendingEditorState === null &&
      editor._updating
    ) {
      editor._updates.unshift([
        () => $setSelection(selection.clone()),
        {discrete: true},
      ]);
    }
  }

  private $readAllInner(
    cursor: YCursor | null,
    kept: SelectionState | null,
    deep: boolean,
  ): void {
    const reader = new Reader(this.state);
    let cs = this.state.containers.get(this._root);
    if (cs === undefined) {
      cs = this.state.newCS(this._root, 'root', 'b');
    }
    const rootCS = cs;
    reader.$reading(() => {
      reader.$readFull(rootCS, $getRoot());
      if (deep) {
        // The containers of the stored nodes the read kept (see
        // initializeInner).
        for (const inner of [...this.state.csByKey.values()]) {
          const el = $getNodeByKey(inner.key);
          if (
            inner !== rootCS &&
            this.state.csByKey.get(inner.key) === inner &&
            $isElementNode(el) &&
            el.isAttached()
          ) {
            reader.$readFull(inner, el);
          }
        }
      }
    });
    $setSelection(null);
    if (cursor !== null) {
      this.$restoreSelection(cursor);
    }
    if (kept !== null) {
      $restoreSelectionState(this.state, kept, json =>
        this.$resolvePosition(json),
      );
    }
    this.$quietSelection();
  }

  // -------------------------------------------------------------------------
  // Remote -> Lexical

  /**
   * A change Yjs starts applying, before it changes anything: until this
   * binding reads it (see onAfterTransaction), its editor shows the document
   * as it was before it, whatever another binding of the document does
   * meanwhile (another binding's writes, in the observers of an earlier
   * change, included). Its own writes are its editor's already.
   */
  private noteChange(tr: Transaction): void {
    if (
      this._status === 'pending' ||
      tr.origin === this ||
      tr.origin === this.initOrigin ||
      tr.origin === this.followUpOrigin ||
      tr.origin === this.scanOrigin
    ) {
      return;
    }
    if (this.unread === null) {
      this.unread = emptyView(this._root);
    }
    this.unread.changes.push(tr);
  }

  /** The change `tr` is read, or has nothing to read (see noteChange). */
  private dropChange(tr: Transaction): void {
    const view = this.unread;
    if (view === null) {
      return;
    }
    const at = view.changes.indexOf(tr);
    if (at >= 0) {
      view.changes.splice(at, 1);
    }
    if (view.changes.length === 0) {
      this.unread = null;
    }
  }

  private onAfterTransaction(tr: Transaction): void {
    try {
      this.readChange(tr);
    } finally {
      this.reading = false;
      this.dropChange(tr);
      if (this.schemaSeenIn === tr) {
        this.schemaSeenIn = null;
      }
    }
  }

  /**
   * An import starts (see guardedRead, once the local updates pending before
   * it were committed): the binding sees the document as it is, the changes
   * Yjs applied and it has not read included, until the transaction being
   * read ends (see onAfterTransaction). Invariant: never before those
   * updates are written. Why: they were made on the document the editor
   * shows, without those changes (see Unread). Outside a transaction being
   * read, nothing is unread and nothing changes.
   */
  private startReading(): void {
    if (this.unread !== null) {
      this.reading = true;
    }
  }

  private readChange(tr: Transaction): void {
    if (
      tr.origin === this ||
      tr.origin === this.initOrigin ||
      tr.origin === this.followUpOrigin ||
      tr.origin === this.scanOrigin
    ) {
      return;
    }
    this.remoteSeq++;
    if (!this.readsChanges()) {
      return;
    }
    if (this._status === 'pending') {
      if (recordedLayout(this._root) !== null) {
        this.evaluate();
      }
      return;
    }
    const state = this.state;
    const childItems = new Map<YNode, Item[]>();
    const add = (s: unknown) => {
      if (
        s instanceof Item &&
        s.parentSub === null &&
        s.parent instanceof YNode
      ) {
        if (!state.containers.has(s.parent)) {
          return;
        }
        let list = childItems.get(s.parent);
        if (list === undefined) {
          list = [];
          childItems.set(s.parent, list);
        }
        list.push(s);
      }
    };
    iterateStructsByIdSet(tr, tr.insertSet, add);
    iterateStructsByIdSet(tr, tr.deleteSet, add);
    const attrKeys = new Map<YNode, Set<string>>();
    // Whether the change brought a schema record (see gateSchema).
    let schemaChanged = false;
    tr.changed.forEach((subs: Set<string | null>, type: YNode) => {
      const keys = new Set<string>();
      subs.forEach(k => {
        if (k !== null) {
          keys.add(k);
        }
      });
      if (keys.size === 0) {
        return;
      }
      if (type === this._root) {
        if (
          [...keys].some(k => k.startsWith(LAYOUT_PREFIX)) &&
          !this.readsRecordedLayout()
        ) {
          this.evaluate();
          return;
        }
        // Read only once the pending local updates are written (see
        // gateSchema), before the change is read: its content is shown.
        schemaChanged = [...keys].some(k => k.startsWith(SCHEMA_PREFIX));
        if ([...keys].some(k => k.startsWith(PIN_PREFIX))) {
          this.loadPins();
        }
        return;
      }
      const isOurs =
        state.keyByY.has(type) ||
        (type.name === MARKER &&
          type._item !== null &&
          state.unitByEnd.has(type._item));
      if (isOurs) {
        attrKeys.set(type, keys);
      }
    });
    if (childItems.size === 0 && attrKeys.size === 0) {
      if (schemaChanged) {
        this.commitPending();
        this.gateSchema();
      }
      // Nothing to read: the binding's own updates waiting for the editor
      // can run now (see runPending).
      this.runPending();
      return;
    }
    // Invariant: a local update still pending (an editor.update() made in
    // the same task) is committed, and written, before a remote read (see
    // guardedRead). Why: committed with the read, it would carry the read's
    // tags and never be written. It is written on the document as it was
    // before this change, which it was made on (see Unread).
    if (this.unread === null || !this.unread.changes.includes(tr)) {
      this.noteChange(tr);
    }
    const committed = this._editor.getEditorState();
    let cursor: YCursor | null = null;
    // An undo puts back the selection of its step (a range, after typing
    // over one); any other read keeps the user's caret a caret. The nulls an
    // undo writes after itself (see closeRestoredRuns) are read as part of
    // it: their read puts back the same selection, which the editor may not
    // have committed yet (an undo run inside an update).
    const undoing =
      (tr.origin === this._undoManager && this._undoManager !== null) ||
      tr.origin === this.runEndOrigin;
    let rebuilt: ReadonlySet<CS> = new Set();
    let naming = false;
    this.guardedRead({
      $read: () => {
        if (naming) {
          $addUpdateTag(BLOCK_ID_REPAIR_TAG);
        }
        this.$readRemote(
          state,
          childItems,
          attrKeys,
          cursor,
          !undoing,
          r => {
            rebuilt = r;
          },
          tr,
        );
      },
      after: () => {
        // Also where `before` gated already (a no-op then).
        if (schemaChanged) {
          this.gateSchema();
        }
        this.checkUnknownTypes();
        this.checkRead(rebuilt);
        this.flushRefresh(true);
        // Invariant: the binding's own pending updates run once the editor
        // shows the remote change, never before. Why: a write before that
        // would take what the editor does not show yet for deleted.
        this.runPending();
      },
      before: () => {
        if (schemaChanged) {
          this.gateSchema();
        }
        // The selection the read keeps is the one those updates left, on the
        // document they were made on.
        if (this._editor.getEditorState() !== committed) {
          this.pendingCursor = this.getCursor();
        }
        // The read sees the document as it is: this change, and those
        // applied since, which are read after it (see Reader).
        this.startReading();
        cursor = this.pendingCursor;
        this.pendingCursor = null;
        if (undoing) {
          if (tr.origin !== this.runEndOrigin) {
            this.undoneCursor = cursor;
          }
          cursor = this.stepCursor ?? cursor;
        }
        // A re-read of a naming update's change is tagged as that update
        // (see rereadRefused).
        naming = this.refused.size > 0 && this.refusedNaming;
      },
      recover: (error, shown) => {
        // The local updates still pending are written by the recovery
        // first; `before` did not run where they kept the read from running.
        this.recoverRead(error, shown);
        if (schemaChanged) {
          this.gateSchema();
        }
      },
      tag: REMOTE_TAGS,
    });
  }

  private $readRemote(
    state: State,
    childItems: Map<YNode, Item[]>,
    attrKeys: Map<YNode, Set<string>>,
    cursor: YCursor | null,
    keepCaret: boolean,
    setRebuilt: (rebuilt: ReadonlySet<CS>) => void,
    tr: Transaction,
  ): void {
    // Whether the editor shows a caret, before the read changes the nodes
    // the selection is in (see $restoreSelection).
    const caret = keepCaret && $showsCaret();
    const reader = new Reader(state);
    setRebuilt(reader.rebuilt);
    // What a composition held back whose hold has ended (see $holds) shows
    // first, before this change is read with the composition now going on.
    if (state.hidden !== null && !this.$holds(state.hidden)) {
      this.$release(state, reader);
    }
    reader.composingKey = this.$composingOwner();
    reader.composedAt = this.$composedCharacter(cursor);
    reader.attrsBefore = (y, keys) => {
      const before = attrsBefore(y, tr);
      return new Map([...keys].map(key => [key, before[key]]));
    };
    // A container that still shows a follow-up's change the binding did not
    // write is read in full first: the reader changes only what the
    // transaction touched, on an editor it takes to show the document.
    // One logical read with the change itself (see Reader#$reading).
    const refused = [...this.refused];
    this.refused.clear();
    this.refusedNaming = false;
    for (const id of this.toSettle) {
      state.ids.touchedIds.add(id);
    }
    this.toSettle.clear();
    reader.$reading(() => {
      for (const cs of refused) {
        const el = cs.y === this._root ? $getRoot() : $getNodeByKey(cs.key);
        if (
          state.containers.get(cs.y) === cs &&
          $isElementNode(el) &&
          el.isAttached()
        ) {
          reader.$readFull(cs, el);
        }
      }
      // What this change does to the line being composed is held back where
      // Yjs keeps it (see Hidden); it shows when the hold ends.
      reader.$apply(childItems, attrKeys);
    });
    if (state.hidden !== null && !this.$holds(state.hidden)) {
      // This change ended the hold (it removed the line being composed).
      this.$release(state, reader);
    }
    if (cursor !== null) {
      // A caret whose line the transaction replaced keeps its offset in the
      // line that replaced it (see $replacedLineCaret); any other selection
      // is mapped by identity.
      if (!keepCaret || !this.$putCaretInReplacedLine(cursor, tr)) {
        this.$restoreSelection(cursor, caret);
      }
    }
    $clampSelection();
    this.$caretOnText();
    this.$quietSelection();
  }

  /**
   * A remote read that throws (a reader bug) must not leave this client
   * showing something else than the document for good: the editor is
   * rebuilt from the shared content (a fresh reader's result, which every
   * client converges on) in a fresh update, and the failure is reported.
   * Where the rebuild throws too, the editor's classes cannot read the
   * document: the binding fails closed, back to `shown` (see failClosed).
   * Either settles once the rebuild has run, which is after the update the
   * failed read is part of where it is nested in one (see guardedRead): the
   * warning follows a rebuild that committed, never one only queued.
   */
  private recoverRead(
    error: unknown,
    shown: EditorState,
    reason: YRecoveredReadData['reason'] = 'remote-change',
  ): void {
    this.guardedRead({
      $read: () => this.$rebuild(),
      after: () => {
        this.checkUnknownTypes();
        this.flushRefresh(true);
        this.warn(
          RECOVERED_READ_WARNING,
          `${
            reason === 'reread'
              ? 'a change could not be read again'
              : 'a remote change could not be read'
          }: ${errorText(error)}`,
          {error, reason},
        );
      },
      // The rebuild reads the document as it is, once the local updates still
      // pending were written on it as the editor showed it.
      before: () => this.startReading(),
      recover: rebuildError => this.failClosed(rebuildError, shown),
      tag: REMOTE_TAGS,
    });
  }

  /**
   * Read the shared document into the editor: `read.$read`, in an update.
   * The one entry point for every read of the binding: a read that does not
   * go through it can neither recover nor fail closed.
   *
   * - Nothing is read, recovered or followed up once the binding failed
   *   closed (see failClosed), whenever the read was asked for: where it
   *   runs, not only where it is admitted.
   * - The local updates still pending commit first, on their own (see
   *   commitPending), where the read is not nested in an update and does
   *   not replace them (`read.replacesPending`). Where listeners keep making
   *   them past MAX_PENDING_COMMITS, the read does not run: that goes to
   *   `read.recover` too.
   * - A throw, of the read or of committing it, never reaches Yjs, a
   *   provider or `initialize()`: it goes to `read.recover`, with what the
   *   editor showed before the read. A throw committing the pending
   *   updates is the app's (an update or a listener of its own): it is
   *   rethrown in a microtask, and the read goes on. So is a throw once the
   *   read is committed and rendered (a listener of the app's threw): the
   *   read stands.
   * - `read.after` runs once the read has committed and nothing threw: after
   *   the update the read is part of, where it is nested in one (an undo the
   *   binding runs in an update of its own, see undo).
   *
   * What the read shows is its caller's to set up: a release of a hold
   * clears the hold first (see flushHidden), so that the read shows what it
   * held, and a recovery reads the whole document again.
   */
  private guardedRead(read: GuardedRead): void {
    if (!this.readsChanges()) {
      return;
    }
    const editor = this._editor;
    const nested = editor._updating;
    let failure = null as Failure;
    if (read.replacesPending !== true && !this.commitPending()) {
      // The app's listeners keep making local updates: the read, which would
      // commit them unwritten under its tags, does not run.
      failure = {
        error: new Error(
          `local updates were still pending after ${MAX_PENDING_COMMITS} commits`,
        ),
      };
    }
    if (failure === null && read.before !== undefined) {
      read.before();
    }
    const shown = editor.getEditorState();
    const settle = () => {
      if (!this.readsChanges()) {
        return;
      }
      if (failure !== null) {
        read.recover(failure.error, shown);
      } else if (read.after !== undefined) {
        read.after();
      }
    };
    if (failure !== null) {
      // Not nested (in an update, commitPending leaves the updates to it).
      settle();
      return;
    }
    if (
      read.replacesPending === true &&
      !nested &&
      editor._updates.length > 0
    ) {
      // A read of the whole document takes over what the pending state
      // shows, but not the updates still queued (an editable listener's
      // reply to the binding's opening, say): Lexical would run those after
      // the read, in its update, tagged as a remote change, where they would
      // be neither written nor refused. They are held as the replies of
      // notifyApart are, and commit on their own as local updates before
      // the read where the editor is idle, else right after it: refused and
      // warned about while read only, and, while still opening, part of what
      // the read replaces.
      this.replies.unshift(...editor._updates.splice(0));
      this.pending.add('replies');
      this.schedulePending();
    }
    // The state the read makes, which its commit gives the editor.
    let readState: EditorState | null = null;
    try {
      editor.update(
        () => {
          // Admitted before the binding failed closed and run after it (an
          // update queued behind the one that failed, or drained by the
          // restore of what the editor showed): nothing is read.
          if (!this.readsChanges()) {
            return;
          }
          readState = editor._pendingEditorState;
          try {
            read.$read();
          } catch (error) {
            failure = {error};
            // It is recovered from right after (see read.recover): a
            // selection the failed read left on a removed node must not fail
            // this update's commit too, which would drop an undo or redo the
            // read is part of.
            $setSelection(null);
          }
          if (nested) {
            $onUpdate(() => this.guard(() => withPins(this._pins, settle)));
          }
        },
        {discrete: true, skipTransforms: true, tag: read.tag},
      );
    } catch (error) {
      if (nested) {
        // The update the read is part of threw: not the read's to recover.
        throw error;
      }
      if (
        readState !== null &&
        (readState as EditorState)._readOnly &&
        editor.getEditorState() === readState
      ) {
        // Thrown by a listener of the app's on the read's own commit, once
        // Lexical had committed and rendered the read (it marks the state
        // read only after reconciling it, before its listeners run): the
        // read stands. Thrown before (rendering what was read), or on the
        // commit of an update queued behind the read (where the throw can
        // have skipped writing that update), it is recovered from.
        rethrowLater(error);
      } else {
        // Thrown committing what was read.
        failure = {error};
      }
    }
    if (!nested) {
      settle();
    }
  }

  /**
   * Fail closed where the document cannot be read (a read threw and so did
   * a fresh read of the document after it, or a read of the whole document
   * did; a class that throws on stored content does not, see
   * Reader#$readStored): warn (UNKNOWN_NODE_TYPES_WARNING, reason
   * `'unreadable'`), open read only, and show `shown` again, what the editor
   * showed before. The binding reads nothing more from then on, so the
   * editor keeps showing it, and no error reaches Yjs or a provider.
   */
  private failClosed(error: unknown, shown: EditorState): void {
    if (this.unreadable) {
      return;
    }
    this.unreadable = true;
    this.warn(
      UNKNOWN_NODE_TYPES_WARNING,
      `the document cannot be read: ${errorText(error)}. This editor is read only until it is built again: data.error holds what the read threw; fix that, then reload the editor`,
      {error, reason: 'unreadable', types: []},
    );
    // Shown again first: an update an app makes when the editor stops being
    // editable commits after it, and is refused (see setStatus).
    try {
      this.showAgain(shown);
    } catch (restoreError) {
      // An update listener of the app's threw on the restore: its error is
      // rethrown in a microtask, and the binding opens read only all the
      // same, so that nothing is written from what it no longer reads.
      rethrowLater(restoreError);
    }
    this.setStatus('readonly');
  }

  /**
   * Have the editor show `shown` again, a state it showed before, without
   * reading the document: the state is set whole, or, where it is empty (an
   * editor that showed nothing yet, before the first read; Lexical does not
   * set an empty state), the root is cleared. Either way the update is
   * tagged as a remote change, so nothing of it is written or refused (see
   * onUpdate).
   */
  private showAgain(shown: EditorState): void {
    const editor = this._editor;
    if (editor.getEditorState() === shown) {
      return;
    }
    if (shown.isEmpty()) {
      editor.update(() => $getRoot().clear(), {
        discrete: true,
        skipTransforms: true,
        tag: REMOTE_TAGS,
      });
    } else {
      editor.setEditorState(shown, {tag: COLLABORATION_TAG});
    }
    if (editor._updating) {
      // Set from a commit's $onUpdate callbacks (the recovery of a read
      // nested in an update, see guardedRead), where nothing commits it:
      // the update queued here, which runs right after them, does.
      editor.update(() => {}, {discrete: true});
    }
  }

  /**
   * Inside an update: replace the editor's content with a fresh read of the
   * shared root, on a new state.
   */
  private $rebuild(): void {
    // With what startInner configured on the state it replaces.
    this.state = this.state.configuredLike(this._doc, this._root);
    const root = $getRoot();
    root.clear();
    const reader = new Reader(this.state);
    const cs = this.state.newCS(this._root, 'root', 'b');
    reader.$readFull(cs, root);
    $setSelection(null);
    this.$quietSelection();
  }

  /**
   * The line or inline container holding the node being composed (IME), if
   * the binding stores it as one.
   */
  private $composingOwner(): NodeKey | null {
    const key = this._editor._compositionKey;
    const node = key === null ? null : $getNodeByKey(key);
    if (node === null || !node.isAttached()) {
      return null;
    }
    const owner = $isTextNode(node) ? $ownerOf(node) : null;
    if (owner === null) {
      return null;
    }
    const ownerKey = owner.getKey();
    const unit = this.state.unitByKey.get(ownerKey);
    if (unit !== undefined && unit.kind === 'line') {
      return ownerKey;
    }
    const cs = this.state.csByKey.get(ownerKey);
    return cs !== undefined && cs.kind === 'i' ? ownerKey : null;
  }

  /**
   * Show what a composition held back once its hold has ended (see $holds),
   * in an update of the binding's own: after a local update that ended it
   * (the composition ended, or moved, or a local edit took held content out
   * of its line).
   */
  private flushHidden(): void {
    if (this.state.hidden === null) {
      return;
    }
    const cursor = this.getCursor();
    let rebuilt: ReadonlySet<CS> = new Set();
    // The release clears the hold before its read, which shows what it held
    // (see $release); a read that throws reads the whole document again
    // (see recoverRead).
    this.guardedRead({
      $read: () => {
        const state = this.state;
        if (state.hidden === null || this.$holds(state.hidden)) {
          return;
        }
        const caret = $showsCaret();
        const reader = new Reader(state);
        rebuilt = reader.rebuilt;
        reader.composedAt = this.$composedCharacter(cursor);
        this.$release(state, reader);
        if (cursor !== null) {
          this.$restoreSelection(cursor, caret);
        }
        this.$caretOnText();
        this.$quietSelection();
      },
      // As after any remote read (see onAfterTransaction).
      after: () => {
        this.checkUnknownTypes();
        this.checkRead(rebuilt);
        this.flushRefresh(true);
      },
      recover: (error, shown) => this.recoverRead(error, shown),
      tag: REMOTE_TAGS,
    });
  }

  /**
   * The id of the character before the caret in the node being composed,
   * from `cursor`, the selection captured before the change (see
   * Reader#composedAt).
   */
  private $composedCharacter(
    cursor: YCursor | null,
  ): {client: number; clock: number; offset: number} | null {
    const key = this._editor._compositionKey;
    const selection = $getSelection();
    if (
      key === null ||
      cursor === null ||
      !$isRangeSelection(selection) ||
      !selection.isCollapsed() ||
      selection.anchor.key !== key ||
      selection.anchor.type !== 'text' ||
      selection.anchor.offset === 0
    ) {
      return null;
    }
    const rel = createRelativePositionFromJSON(cursor.anchor);
    return rel.assoc < 0 && rel.item !== null
      ? {
          client: rel.item.client,
          clock: rel.item.clock,
          offset: selection.anchor.offset,
        }
      : null;
  }

  /**
   * Whether `hidden`'s hold goes on (see Hidden): the editor is composing in
   * the line or inline container it holds for, and every held item is still
   * in it (a local edit, as Enter or Backspace across lines, can take held
   * content out of it).
   */
  private $holds(hidden: Hidden): boolean {
    const owner = this.$composingOwner();
    if (owner === null || owner !== hidden.ownerKey) {
      return false;
    }
    const state = this.state;
    const unit = state.unitByKey.get(owner);
    const cs = unit !== undefined ? unit.cs : state.csByKey.get(owner);
    const y = cs === undefined ? null : cs.y;
    // Items known to be in the line: each item is walked once.
    const inLine = new Set<Item>();
    for (const [parent, items] of this.hiddenItems(hidden)) {
      for (const it of items) {
        if (isGone(it)) {
          continue;
        }
        if (parent !== y) {
          return false;
        }
        if (unit === undefined) {
          continue;
        }
        const path: Item[] = [];
        let end: Item | null = it;
        while (end !== null && !inLine.has(end) && !isShownEnd(end, hidden)) {
          path.push(end);
          end = end.right;
        }
        if (
          end === null
            ? unit.end !== null
            : !inLine.has(end) && end !== unit.end
        ) {
          return false;
        }
        for (const p of path) {
          inLine.add(p);
        }
      }
    }
    return (
      hidden.marker === null ||
      (unit !== undefined &&
        [...hidden.marker.ends].every(end => end === unit.end || isGone(end)))
    );
  }

  /**
   * End the hold of what a composition held back (see Hidden): every held
   * change is read by `reader` where its content now is, the line it was
   * held in or wherever local edits took it, as a remote change that just
   * arrived; nothing is held any more.
   */
  private $release(state: State, reader: Reader): void {
    const hidden = state.hidden;
    if (hidden === null) {
      return;
    }
    state.hidden = null;
    const items = this.hiddenItems(hidden);
    // A local split can inherit a held format at its new boundary. Its
    // shown start was kept separate from storage (see Writer#$writeSegment):
    // render that successor too, even where the stored start already agrees.
    for (const [unit, {stored}] of hidden.starts) {
      if (
        unit.end !== null &&
        state.unitByEnd.get(unit.end) === unit &&
        !unit.end.deleted
      ) {
        unit.start = stored;
        const list = items.get(unit.cs.y);
        if (list === undefined) {
          items.set(unit.cs.y, [unit.end]);
        } else {
          list.push(unit.end);
        }
      }
    }
    const markers = new Map<YNode, Set<string>>();
    if (hidden.marker !== null) {
      for (const end of hidden.marker.ends) {
        if (!end.deleted) {
          markers.set(typeOf(end), new Set(hidden.marker.was.keys()));
        }
      }
    }
    const composing = reader.composingKey;
    reader.composingKey = null;
    reader.$apply(items, markers);
    reader.composingKey = composing;
  }

  /** The items of the binding's containers that `hidden` holds. */
  private hiddenItems(hidden: Hidden): Map<YNode, Item[]> {
    const out = new Map<YNode, Item[]>();
    hidden.forEachRange((client, start, end) => {
      const structs = this._doc.store.clients.get(client);
      if (structs === undefined) {
        return;
      }
      for (
        let i = findIndexSS(structs, start);
        i < structs.length && structs[i].id.clock < end;
        i++
      ) {
        const s = structs[i];
        if (
          s instanceof Item &&
          s.parent instanceof YNode &&
          this.state.containers.has(s.parent)
        ) {
          let list = out.get(s.parent);
          if (list === undefined) {
            list = [];
            out.set(s.parent, list);
          }
          list.push(s);
        }
      }
    });
    return out;
  }

  /**
   * Recompute the derived fields (list numbering) of the groups a read or a
   * change touched, in an update of the binding's own (see $refreshGroups).
   *
   * Invariant: the group class's own transforms run with the group's
   * siblings hidden. Why: a transform that also restructures (merges an
   * adjacent equal list) would make every peer write that merge, duplicating
   * its items, and a fresh reader would build another tree.
   *
   * Invariant: after a remote change (`remote`), a refresh in an editor that
   * is not focused does not set the DOM selection (SKIP_DOM_SELECTION_TAG).
   * Why: the read already restored it, and setting it would move the focus
   * into that editor. A focused editor sets it, so a refresh that reshapes
   * the DOM under the caret keeps the caret in place.
   */
  private flushRefresh(
    remote: boolean,
    from: Set<NodeKey> = this.state.refresh,
  ): void {
    if (from.size === 0) {
      return;
    }
    if (this._editor._updating && this._editor._pendingEditorState === null) {
      // In a listener phase, or right after a commit (the binding's own
      // read, an undo's): the refresh is queued as the next update, alone
      // (see queueFirst).
      const keys = [...from];
      from.clear();
      this.queueFirst(
        () => {
          for (const tag of this.refreshTags(remote)) {
            $addUpdateTag(tag);
          }
          this.$refreshGroups(keys);
        },
        {discrete: true, skipTransforms: true},
      );
      return;
    }
    if (!this._editor._updating && !this.isIdle()) {
      // Outside any update, with a local update still pending or queued:
      // committed first (see commitPending), so that the refresh commits
      // now, on its own, rather than once the editor is idle. Such an update
      // is one made in reply to the read the refresh follows, also by
      // Lexical itself: an editor with named slots re-renders in an update
      // of its own whenever its editable state changes, which the binding's
      // status change after a read does (activation after the first read,
      // read only after a remote change it cannot write past).
      //
      // Invariant: once a read's work is done, the editor shows the derived
      // fields the read left (list numbering), as a fresh reader of the
      // document does (see readYState). Why: deferred to a microtask, the
      // refresh left a freshly bound editor numbering every list item 1
      // until then, and code that reads the editor right after
      // `initialize()` or a remote change saw that.
      this.commitPending();
    }
    if (!this.isIdle()) {
      // Inside another update (a change applied from one of its listeners):
      // the refresh must commit on its own (see runPending).
      const to = remote ? this.remoteRefresh : this.localRefresh;
      if (to !== from) {
        for (const key of from) {
          to.add(key);
        }
        from.clear();
      }
      this.pending.add('refresh');
      this.schedulePending();
      return;
    }
    const keys = [...from];
    from.clear();
    this._editor.update(() => this.$refreshGroups(keys), {
      discrete: true,
      skipTransforms: true,
      tag: this.refreshTags(remote),
    });
  }

  /**
   * The refresh is no one's edit (only users' own edits write): tagged
   * COLLABORATION_TAG too, as every other update the binding makes (its
   * reads), so that an app's listener that skips that tag skips it.
   */
  private refreshTags(remote: boolean): string[] {
    return remote && !this.hasFocus()
      ? [
          COLLABORATION_TAG,
          HISTORY_MERGE_TAG,
          REFRESH_TAG,
          SKIP_DOM_SELECTION_TAG,
        ]
      : [COLLABORATION_TAG, HISTORY_MERGE_TAG, REFRESH_TAG];
  }

  /**
   * The refresh itself, inside an update (see flushRefresh): each group runs
   * its class's own transforms (list numbering) and those registered for
   * every node type, not those an app registers for lists (an app's list
   * policy applies to its users' own edits).
   *
   * Invariant: nothing a refresh changes is written. Why: the class's
   * transforms derive the same fields from the same document on every
   * client and in every fresh reader, and a later local edit of those lines
   * writes them as the editor shows them (a structural write rewrites every
   * marker whose group fields differ from the editor's). A class transform
   * that changes a group's structure is read again (see rereadRefused).
   */
  private $refreshGroups(keys: NodeKey[]): void {
    const roles = new Roles(this.state);
    // Transforms registered for every node type (the node structure
    // normalization's collection of what to check next, BlockIdExtension's):
    // those on paragraphs.
    const paragraph = this._editor._nodes.get('paragraph');
    const everyType =
      paragraph === undefined ? undefined : paragraph.transforms;
    for (const key of keys) {
      const node = $getNodeByKey(key);
      if (!$isElementNode(node) || !node.isAttached()) {
        continue;
      }
      const info = this._editor._nodes.get(node.getType());
      if (info === undefined) {
        continue;
      }
      let own = this.classTransforms.get(info.klass);
      if (own === undefined) {
        own = getTransformSetFromKlass(info.klass);
        this.classTransforms.set(info.klass, own);
      }
      const transforms = [...info.transforms].filter(
        t => own.has(t) || (everyType !== undefined && everyType.has(t)),
      );
      const writable = node.getWritable();
      const {__prev, __next} = writable;
      const shape = $shapeOf(writable);
      writable.__prev = null;
      writable.__next = null;
      try {
        for (const transform of transforms) {
          if (writable.isAttached()) {
            transform(writable);
          }
        }
      } finally {
        writable.__prev = __prev;
        writable.__next = __next;
      }
      if (!writable.isAttached() || $shapeOf(writable) !== shape) {
        const container = writable.isAttached()
          ? roles.$containerOf(writable)
          : null;
        const cs =
          container === null || $isRootNode(container)
            ? this.state.containers.get(this._root)
            : this.state.csByKey.get(container.getKey());
        if (cs !== undefined) {
          this.refused.add(cs);
          this.pending.add('reread');
        }
      }
    }
  }

  /** Whether the focus is inside this editor's root element. */
  private hasFocus(): boolean {
    const root = this._editor.getRootElement();
    return root !== null && root.contains(getActiveElement(root));
  }

  // -------------------------------------------------------------------------
  // Lexical -> Yjs

  private onUpdate(payload: UpdatePayload): void {
    const {editorState, prevEditorState, tags} = payload;
    let {dirtyElements, dirtyLeaves} = payload;
    // The leaves Lexical marked dirty (see noteUntransformed).
    const markedLeaves = payload.dirtyLeaves;
    // What Lexical's transforms ran on in this commit (see
    // normalizeUntransformed).
    const transformed = new Set(this.transformed);
    this.transformed.clear();
    const commit = this.classifyCommit(
      tags,
      dirtyElements,
      dirtyLeaves,
      prevEditorState,
    );
    if (commit.refresh && !commit.registration) {
      // See $refreshGroups: only users' own edits write.
      this.state.refresh.clear();
      return;
    }
    if (
      this.writesEdits() &&
      !commit.remote &&
      !commit.skip &&
      this.schemaGatesWrite(editorState)
    ) {
      // Made on a schema record a newer version wrote: read only first, so
      // that it is refused below.
      this.gateSchema();
    }
    if (
      !this.writesEdits() &&
      !this.keepsUnstored &&
      !commit.remote &&
      !commit.skip
    ) {
      // Read only, nothing is written, and what a local update changed
      // (code that edits the editor, which is not editable) is read again,
      // once a composition ends; once the binding failed closed, which reads
      // nothing more (see failClosed), the editor shows what it showed
      // before the update again. Invariant: while read only, a local update
      // leaves the editor showing what the binding read. Why: a remote
      // change is read into the editor as the binding's units describe it,
      // and read into an editor that shows something else it can misplace
      // content.
      const composing = this._editor._compositionKey !== null;
      let refused = false;
      if (!this.readsChanges()) {
        refused =
          this.$changedNodes(
            dirtyElements,
            dirtyLeaves,
            editorState,
            prevEditorState,
          ).length > 0;
        if (refused) {
          if (this.restoreTo === null) {
            this.restoreTo = prevEditorState;
          }
          this.pending.add('restore');
        }
      } else {
        refused = this.$refuseChanged(
          dirtyElements,
          dirtyLeaves,
          editorState,
          prevEditorState,
          composing ? this.refusedComposing : this.refused,
        );
      }
      if (refused) {
        if (commit.naming) {
          this.refusedNaming = true;
        }
        if (commit.userEdit) {
          this.rereads = 0;
          if (!this.warnedEdit) {
            this.warnedEdit = true;
            this.warn(
              UNSUPPORTED_EDIT_WARNING,
              "a local change is not written while read only: an earlier warning says why the binding is read only. Edit only while binding.status is 'active'",
              {reason: 'read-only'},
            );
          }
        }
      }
      return;
    }
    if (
      !this.writesEdits() ||
      commit.remote ||
      commit.skip ||
      (dirtyElements.size === 0 && dirtyLeaves.size === 0)
    ) {
      return;
    }
    // The groups this commit's refresh recomputes (see flushRefresh): not
    // those whose own transforms ran in it.
    const localKeys = commit.scansGroups
      ? this.$groupsToRefresh(
          editorState,
          prevEditorState,
          dirtyElements,
          transformed,
        )
      : new Set<NodeKey>();
    if (commit.userEdit) {
      const replaced = $replacedNodes(
        dirtyElements,
        dirtyLeaves,
        prevEditorState,
        editorState,
      );
      if (replaced !== null) {
        [dirtyElements, dirtyLeaves] = replaced;
      }
    }
    if (commit.registration && !commit.naming) {
      // The update Lexical makes when a transform is registered (a plugin
      // that mounts, or mounts again, once the document is open) writes
      // nothing: opening a document is no one's edit. What its transforms
      // changed is read again, so the editor shows the document; the
      // author's next edit of that content makes the change, and writes it.
      this.$refuseChanged(
        dirtyElements,
        dirtyLeaves,
        editorState,
        prevEditorState,
      );
      return;
    }
    if (this.refuseUnstorableSlots(editorState, dirtyElements.keys())) {
      return;
    }
    const untransformed =
      commit.userEdit &&
      this.noteUntransformed(
        editorState,
        dirtyElements,
        dirtyLeaves,
        transformed,
        markedLeaves,
      );
    const state = this.state;
    // On the document as it was before a remote change not read yet, while
    // there is one (see Unread and guard).
    editorState.read(() =>
      this.$writeCommit(
        state,
        commit,
        editorState,
        prevEditorState,
        dirtyElements,
        dirtyLeaves,
        transformed,
        localKeys,
        payload.normalizedNodes ?? null,
      ),
    );
    this.queueCommitFollowUps(state, commit, localKeys, untransformed);
  }

  /**
   * What made a commit (see Commit). Called for every commit, in order:
   * isRegistrationPass notes the transforms each type has.
   */
  private classifyCommit(
    tags: Set<string>,
    dirtyElements: Map<NodeKey, boolean>,
    dirtyLeaves: Set<NodeKey>,
    prevEditorState: EditorState,
  ): Commit {
    const refresh = tags.has(REFRESH_TAG);
    // A remote change read (the refresh is tagged so too, see refreshTags).
    const remote = tags.has(COLLABORATION_TAG) && !refresh;
    const skip = tags.has(SKIP_COLLAB_TAG);
    const naming = tags.has(BLOCK_ID_REPAIR_TAG);
    const normalize = tags.has(NORMALIZE_TAG);
    // The binding's run of the update Lexical made for a registered
    // transform (see runRegistrationPasses), or one Lexical committed itself
    // (registered while the binding did not write).
    const registration =
      this.isRegistrationPass(dirtyElements, dirtyLeaves, prevEditorState) ||
      tags.has(REGISTRATION_TAG);
    return {
      followUp: refresh || registration || naming,
      naming,
      normalize,
      refresh,
      registration,
      remote,
      // BlockIdExtension's naming only sets block ids; remote reads refresh
      // the groups they rebuild themselves.
      scansGroups: !refresh && !skip && !remote && !naming,
      skip,
      userEdit: !refresh && !registration && !naming && !normalize,
    };
  }

  /**
   * Every group whose children (or whose items' children) a local commit
   * changed recomputes its derived fields (list item values) in a refresh,
   * unless its own transforms ran in the commit (see markGroupOfItem): an
   * update applied without transforms runs none.
   */
  private $groupsToRefresh(
    editorState: EditorState,
    prevEditorState: EditorState,
    dirtyElements: Map<NodeKey, boolean>,
    transformed: ReadonlySet<NodeKey>,
  ): Set<NodeKey> {
    const localKeys = new Set<NodeKey>();
    const prevMap = prevEditorState._nodeMap;
    editorState.read(() => {
      for (const [key, intentional] of dirtyElements) {
        if (!intentional) {
          continue;
        }
        const node = $getNodeByKey(key);
        if ($isGroupNode(node)) {
          if (!transformed.has(key)) {
            localKeys.add(key);
          }
          continue;
        }
        if (!$isElementNode(node)) {
          continue;
        }
        const parent = node.getParent();
        if (
          $isGroupNode(parent) &&
          $switchesWrapper(node, prevMap) &&
          !transformed.has(parent.getKey())
        ) {
          localKeys.add(parent.getKey());
        }
      }
    });
    return localKeys;
  }

  /**
   * Note what a user's update changed without Lexical's transforms (applied
   * with skipTransforms, or a state set whole), which the author normalizes
   * in an update of its own (see normalizeUntransformed). `marked`: the
   * leaves Lexical marked dirty. Returns whether there is any.
   */
  private noteUntransformed(
    editorState: EditorState,
    dirtyElements: Map<NodeKey, boolean>,
    dirtyLeaves: Set<NodeKey>,
    transformed: ReadonlySet<NodeKey>,
    marked: ReadonlySet<NodeKey>,
  ): boolean {
    let untransformed = false;
    editorState.read(() => {
      for (const [key, intentional] of dirtyElements) {
        if (!intentional || transformed.has(key)) {
          continue;
        }
        const node = $getNodeByKey(key);
        if ($isElementNode(node) && node.isAttached()) {
          this.untransformed.set(key, null);
          untransformed = true;
        }
      }
      // The root's transforms run in every update that runs any: an
      // update in which they did not ran none on its text either. Text that
      // Lexical did not mark dirty ran none either way: a state set whole
      // that this editor did not parse marks only its root (see
      // $replacedNodes), and its root's transforms run.
      const rootRan = transformed.has('root');
      for (const key of dirtyLeaves) {
        if (rootRan && marked.has(key)) {
          continue;
        }
        const node = $getNodeByKey(key);
        if ($isTextNode(node) && node.isAttached()) {
          this.untransformedText.add(key);
          untransformed = true;
        }
      }
    });
    return untransformed;
  }

  /**
   * Write a commit (inside a read of its state): plan, write, note what was
   * not written, settle the block ids the write changed, self-check.
   */
  private $writeCommit(
    state: State,
    commit: Commit,
    editorState: EditorState,
    prevEditorState: EditorState,
    dirtyElements: Map<NodeKey, boolean>,
    dirtyLeaves: Set<NodeKey>,
    transformed: ReadonlySet<NodeKey>,
    localKeys: Set<NodeKey>,
    merged: ReadonlySet<NodeKey> | null,
  ): void {
    const roles = new Roles(state);
    const plan = Writer.$plan(
      roles,
      dirtyElements,
      dirtyLeaves,
      prevEditorState,
    );
    plan.merged = merged;
    const movedNodes = editorState._movedNodes;
    plan.moved =
      movedNodes === null ? null : movedNodes.get(prevEditorState._nodeMap);
    const splitNodes = editorState._splitNodes;
    plan.splits =
      splitNodes === null ? null : splitNodes.get(prevEditorState._nodeMap);
    const textEdits = editorState._textEdits;
    plan.textEdits =
      textEdits === null ? null : textEdits.get(prevEditorState._nodeMap);
    if (
      plan.structural.size === 0 &&
      plan.inline.size === 0 &&
      plan.lines.size === 0 &&
      plan.attrs.size === 0
    ) {
      if (commit.followUp) {
        this.$checkFollowUp(
          state,
          commit,
          editorState,
          prevEditorState,
          dirtyElements,
          dirtyLeaves,
          new Set(),
        );
      }
      return;
    }
    // A follow-up and BlockIdExtension's naming are no one's edit: out of
    // the undo history.
    const origin =
      commit.userEdit || commit.normalize ? this : this.followUpOrigin;
    const seq = this.remoteSeq;
    // The selection before this change, for the undo step it may start
    // (as relative positions on the content before it is written).
    this.writeCursor =
      origin === this && this._undoManager !== null
        ? prevEditorState.read(() => {
            try {
              return this.$captureCursor();
            } catch (_e) {
              return null;
            }
          })
        : null;
    const writer = this.$runWriter(
      state,
      commit,
      roles,
      plan,
      origin,
      editorState,
      prevEditorState,
      dirtyElements,
      dirtyLeaves,
    );
    if (writer !== null) {
      this.noteWriteRefusals(
        state,
        commit,
        writer,
        dirtyElements,
        transformed,
        localKeys,
      );
      if (commit.userEdit && writer.holed.size > 0) {
        for (const key of writer.holed) {
          this.storedHoles.add(key);
        }
        this.pending.add('normalize');
      }
    }
    if (commit.userEdit) {
      this.rereads = 0;
    }
    // Containers holding blocks whose ids are settled after this write
    // (see toSettle): not compared until then.
    const settling =
      writer !== null && state.blockIds !== null
        ? this.$settleAfterWrite(
            state,
            dirtyElements,
            dirtyLeaves,
            prevEditorState,
          )
        : new Set<CS>();
    if (commit.followUp && writer !== null && this.unread === null) {
      this.$checkFollowUp(
        state,
        commit,
        editorState,
        prevEditorState,
        dirtyElements,
        dirtyLeaves,
        settling,
      );
    }
    this.selfCheckWrite(state, writer, plan, settling, seq, editorState);
  }

  /**
   * The follow-up check: after a follow-up is written, every container it
   * touched (that holds a node it changed: fields, NodeState, named slots,
   * text or children) shows in the editor what a fresh reader shows for the
   * resulting document there, or that container is read again, as for a
   * change the writer refuses (see Writer#followUp). Only the part of a block
   * container holding the top-level children the follow-up changed and
   * their neighbours is read (see $followUpDifference), so that a follow-up
   * after each keystroke in a long document costs that part, not the
   * container.
   *
   * Invariant: a follow-up leaves no container showing what is not stored.
   * Why: every rule of what a follow-up may write is one more shape where a
   * change could be neither written nor refused (a line without a marker,
   * a field stored nowhere, a paragraph a read made), and the author would
   * keep it while every peer and fresh reader shows the stored content: the
   * comparison is with what readers show, whatever the writer did. It cannot
   * loop: what it reads again is read by the reader itself (and tagged as a
   * collaborator's change, which is not written or checked), and follow-ups
   * that keep changing what is read again stop at MAX_REREADS.
   */
  private $checkFollowUp(
    state: State,
    commit: Commit,
    editorState: EditorState,
    prevEditorState: EditorState,
    dirtyElements: Map<NodeKey, boolean>,
    dirtyLeaves: Set<NodeKey>,
    settling: ReadonlySet<CS>,
  ): void {
    // Not while remote text is held back for a composition (the editor
    // differs from the document there on purpose, see Hidden), nor while a
    // change made without Lexical's transforms waits for the author's
    // normalization (stored as the normalization leaves it, a line holding
    // lines, say: the editor differs there until it runs, as for the
    // self-check, see selfCheckWrite), nor with types the editor cannot
    // show (read only).
    if (
      !this.writesEdits() ||
      state.differsOnPurpose() ||
      this.untransformed.size > 0 ||
      this.untransformedText.size > 0 ||
      this.storedHoles.size > 0
    ) {
      return;
    }
    const changed = this.$changedNodes(
      dirtyElements,
      dirtyLeaves,
      editorState,
      prevEditorState,
    );
    if (changed.length === 0) {
      return;
    }
    const prevMap = prevEditorState._nodeMap;
    const nowMap = editorState._nodeMap;
    const rootCS = state.containers.get(this._root);
    // Per container: its top-level children holding a changed node, before
    // or after the follow-up, with their neighbours (a change that reaches
    // past them, a removed or merged block, shows there).
    const near = new Map<CS, Set<NodeKey>>();
    const whole = new Set<CS>();
    const note = (key: NodeKey, map: Map<NodeKey, LexicalNode>): void => {
      for (let child = map.get(key); child !== undefined; ) {
        const parent = child.__parent;
        if (parent === null) {
          // A named slot's node is shown by its host: compared where the
          // host is.
          const host =
            (child as {__slotHost?: null | NodeKey}).__slotHost ?? null;
          child = host === null ? undefined : map.get(host);
          continue;
        }
        const cs = parent === 'root' ? rootCS : state.csByKey.get(parent);
        if (cs !== undefined) {
          if (cs.kind === 'i') {
            whole.add(cs);
            return;
          }
          let set = near.get(cs);
          if (set === undefined) {
            set = new Set();
            near.set(cs, set);
          }
          set.add(child.__key);
          if (child.__prev !== null) {
            set.add(child.__prev);
          }
          if (child.__next !== null) {
            set.add(child.__next);
          }
          return;
        }
        child = map.get(parent);
      }
    };
    for (const key of changed) {
      note(key, nowMap);
      note(key, prevMap);
    }
    const checks: [CS, [number, number][] | null][] = [];
    for (const cs of whole) {
      checks.push([cs, null]);
    }
    for (const [cs, keys] of near) {
      checks.push([cs, followUpRanges(state, cs, keys)]);
    }
    const changedSet = new Set(changed);
    for (const [cs, ranges] of checks) {
      if (this.refused.has(cs) || state.containers.get(cs.y) !== cs) {
        continue;
      }
      // A container whose block ids are settled after this write (see
      // $settleAfterWrite) is compared without them: settling reads them
      // again, and nothing else does. Why: it was skipped, so a follow-up
      // that set NodeState on a paragraph without a marker and gave a block
      // a repeated id in the same update kept the state, which no peer or
      // fresh reader showed.
      const difference = $followUpDifference(
        state,
        cs,
        ranges,
        changedSet,
        settling.has(cs),
      );
      if (difference !== null) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            `@lexical/y: a follow-up update left the editor showing what is not stored (${difference}); follow-ups (BlockIdExtension's naming, the update that runs a newly registered transform over the document) may only set attributes or delete, so the editor reads that content again.`,
          );
        }
        this.refused.add(cs);
        this.pending.add('reread');
        if (commit.naming) {
          this.refusedNaming = true;
        }
      }
    }
  }

  /**
   * The nodes a commit changed (its fields, NodeState, named slots, text, a
   * parent or children), of those Lexical marked dirty: a node it only
   * marked (an ancestor of a changed node) or cloned unchanged is not.
   */
  private $changedNodes(
    dirtyElements: Map<NodeKey, boolean>,
    dirtyLeaves: Set<NodeKey>,
    editorState: EditorState,
    prevEditorState: EditorState,
  ): NodeKey[] {
    const prevMap = prevEditorState._nodeMap;
    const nowMap = editorState._nodeMap;
    const shallow = (n: LexicalNode): string => {
      const json = n.exportJSON() as unknown as Record<string, unknown>;
      delete json.children;
      const slots = (n as {__slots?: null | Map<string, NodeKey>}).__slots;
      return JSON.stringify([
        json,
        slots === null || slots === undefined ? null : [...slots],
      ]);
    };
    const kids = (
      n: LexicalNode | undefined,
      get: (key: NodeKey) => LexicalNode | undefined,
    ): string => {
      const out: NodeKey[] = [];
      if ($isElementNode(n)) {
        for (let c = n.__first; c !== null; ) {
          out.push(c);
          const cn = get(c);
          c = cn === undefined ? null : cn.__next;
        }
      }
      return out.join(',');
    };
    const changed: NodeKey[] = [];
    for (const key of [...dirtyElements.keys(), ...dirtyLeaves]) {
      const prev = prevMap.get(key);
      const now = nowMap.get(key);
      if (prev === now) {
        continue;
      }
      if (
        prev === undefined ||
        now === undefined ||
        prev.__parent !== now.__parent ||
        prevEditorState.read(() => shallow(prev)) !==
          editorState.read(() => shallow(now)) ||
        kids(prev, c => prevMap.get(c)) !==
          kids(now, c => nowMap.get(c) ?? prevMap.get(c))
      ) {
        changed.push(key);
      }
    }
    return changed;
  }

  /**
   * Run the writer in one transaction, and record the kinds of types written
   * for the first time in another, outside the undo history (undoing the
   * content must not forget how a type is stored). Returns the writer, or
   * null when the write failed and every container was rewritten instead.
   *
   * Invariant: a follow-up records no kinds. Why: it inserts nothing (see
   * Writer#followUp), so it writes no type for the first time, and what it
   * was refused is read again; on a client that only applied a change, a
   * type the change's author has not recorded yet (its record comes in a
   * transaction of its own) was written again (`k:quote`), a write on apply.
   */
  private $runWriter(
    state: State,
    commit: Commit,
    roles: Roles,
    plan: WritePlan,
    origin: unknown,
    editorState: EditorState,
    prevEditorState: EditorState,
    dirtyElements: Map<NodeKey, boolean>,
    dirtyLeaves: Set<NodeKey>,
  ): Writer | null {
    let writer: Writer | null = null;
    try {
      this._doc.transact(tr => {
        try {
          writer = new Writer(state, roles, tr, prevEditorState, plan);
          writer.followUp = commit.followUp;
          writer.$run();
        } finally {
          // A local edit (not a follow-up, which is no one's edit) carries
          // this client's schema version.
          if (origin === this) {
            recordSchema(this._root, this.options.schemaVersion, tr, t =>
              this.isUnderRoot(t),
            );
          }
          // In the same transaction as the first member entry of a set, even
          // when the write throws part way: clients that only read layout 1
          // never get one without the version that tells them they cannot
          // read it.
          recordSetMembersLayout(this._root, tr);
        }
      }, origin);
      if (!commit.followUp) {
        this._doc.transact(() => {
          this.recordPins(this._root, editorState, [
            ...dirtyElements.keys(),
            ...dirtyLeaves,
          ]);
        }, this.followUpOrigin);
      }
      return writer;
    } catch (e) {
      // A write that fails part way must not leave the document silently
      // behind the editor: rewrite every container (a diff against the
      // shared content, so nothing a peer wrote is lost) in a fresh
      // transaction, and report it.
      this.warn(
        RECOVERED_WRITE_WARNING,
        'a local change could not be written: ' +
          String(e instanceof Error ? e.message : e),
        {error: e, reason: 'local-change'},
      );
      try {
        this._doc.transact(tr => {
          try {
            const all: WritePlan = {
              attrs: new Set(state.yByKey.keys()),
              inline: new Set(),
              lines: new Set(state.unitByKey.keys()),
              removedText: plan.removedText,
              structural: new Set(),
            };
            for (const [key, cs] of state.csByKey) {
              (cs.kind === 'b' ? all.structural : all.inline).add(key);
            }
            const rewriter = new Writer(
              state,
              new Roles(state),
              tr,
              prevEditorState,
              all,
            );
            rewriter.rewriteAll = true;
            rewriter.followUp = commit.followUp;
            rewriter.$run();
            this.noteRefused(rewriter, commit.naming);
          } finally {
            if (origin === this) {
              recordSchema(this._root, this.options.schemaVersion, tr, t =>
                this.isUnderRoot(t),
              );
            }
            recordSetMembersLayout(this._root, tr);
          }
        }, origin);
      } catch (e2) {
        this._editor._onError(e2 instanceof Error ? e2 : new Error(String(e2)));
      }
      return null;
    }
  }

  /**
   * After a write: the containers where it did not write a change are read
   * again (every container the commit touched, not only those it was refused
   * in: a change that moves content between containers, adjacent lists in a
   * line merged, leaves the other one unlike the document too), and the
   * groups whose items it rewrote are refreshed.
   */
  private noteWriteRefusals(
    state: State,
    commit: Commit,
    writer: Writer,
    dirtyElements: Map<NodeKey, boolean>,
    transformed: ReadonlySet<NodeKey>,
    localKeys: Set<NodeKey>,
  ): void {
    this.noteRefused(writer, commit.naming);
    if (writer.refused.size > 0) {
      for (const key of dirtyElements.keys()) {
        const cs = state.csByKey.get(key);
        if (cs !== undefined) {
          this.refused.add(cs);
        }
      }
    }
    if (!commit.naming) {
      for (const key of writer.refreshGroups) {
        if (!transformed.has(key)) {
          localKeys.add(key);
        }
      }
    }
  }

  /**
   * Settle the block ids whose holders a local write changed (see
   * $unsettledAfterWrite): an id that the editor shows otherwise than readers
   * do is settled in an update of the binding's own that is not written (see
   * $rereadRefused). Returns the containers of the blocks that store or
   * derive those ids.
   */
  private $settleAfterWrite(
    state: State,
    dirtyElements: Map<NodeKey, boolean>,
    dirtyLeaves: Set<NodeKey>,
    prevEditorState: EditorState,
  ): Set<CS> {
    const settling = new Set<CS>();
    const unsettled = $unsettledAfterWrite(
      state,
      dirtyElements,
      dirtyLeaves,
      prevEditorState._nodeMap,
    );
    if (unsettled === null) {
      return settling;
    }
    for (const id of unsettled.ids) {
      this.toSettle.add(id);
    }
    for (const node of unsettled.claimants) {
      for (let n: LexicalNode | null = node; n !== null; ) {
        const cs = state.csByKey.get(n.getKey());
        if (cs !== undefined) {
          settling.add(cs);
          break;
        }
        n = n.getParent();
      }
    }
    if (this.toSettle.size > 0) {
      this.pending.add('reread');
    }
    return settling;
  }

  /**
   * The self-check of a local write (see YBindingOptions.selfCheck): the
   * lines it touched, and whole containers where it wrote structure or a
   * group item's marker (group fields are shared by its items).
   */
  private selfCheckWrite(
    state: State,
    writer: Writer | null,
    plan: WritePlan,
    settling: ReadonlySet<CS>,
    seq: number,
    editorState: EditorState,
  ): void {
    // While a change made without Lexical's transforms waits for the
    // author's normalization, the editor is compared once that is written
    // (readers already build some of that normalization: adjacent equal
    // lists are one list).
    const check =
      this.options.selfCheck === true &&
      this.untransformed.size === 0 &&
      this.untransformedText.size === 0 &&
      this.storedHoles.size === 0;
    // Skipped when a remote change was applied during the write (remoteSeq
    // moved), or before it and not read yet (see Unread): the shared content
    // is not what was written.
    if (
      !(
        check &&
        writer !== null &&
        this.remoteSeq === seq &&
        this.unread === null &&
        Math.random() < (this.options.selfCheckSample ?? 1)
      )
    ) {
      return;
    }
    const problems = $checkWrite(writer);
    // A container a follow-up changed in ways that are not written is read
    // again instead, and one whose block ids are being settled is compared
    // once they are.
    const containers = new Set<CS>();
    for (const key of plan.structural) {
      const cs = state.csByKey.get(key);
      if (cs !== undefined) {
        containers.add(cs);
      }
    }
    // A container whose node this write gave new storage after writing it
    // (a block moved after its content changed) is compared as stored now.
    for (const cs of writer.groupWrites) {
      if (state.csByKey.get(cs.key) === cs) {
        containers.add(cs);
      }
    }
    for (const cs of containers) {
      if (
        !this.refused.has(cs) &&
        !settling.has(cs) &&
        sampleWholeContainer(cs)
      ) {
        pushAll(problems, checkContainer(state, cs, editorState));
      }
    }
    if (problems.length > 0) {
      this.warn(
        SELF_CHECK_WARNING,
        'self-check: ' + problems.slice(0, 5).join('; '),
        {problems, reason: 'local'},
      );
    }
  }

  /**
   * What a written commit leaves for the binding's own updates (see
   * runPending): the refresh of the groups it changed, and the author's
   * normalization of what it changed without transforms (each element
   * anchored to what stores it now, as a remote change read before the
   * normalization runs can give it a new node).
   */
  private queueCommitFollowUps(
    state: State,
    commit: Commit,
    localKeys: ReadonlySet<NodeKey>,
    untransformed: boolean,
  ): void {
    if (!commit.refresh) {
      if (localKeys.size > 0) {
        for (const key of localKeys) {
          this.localRefresh.add(key);
        }
        this.pending.add('refresh');
      }
    } else {
      state.refresh.clear();
    }
    if (untransformed) {
      for (const [key, anchor] of this.untransformed) {
        if (anchor === null) {
          const unit = state.unitByKey.get(key);
          this.untransformed.set(
            key,
            state.yByKey.get(key) ??
              (unit === undefined ? null : unit.end) ??
              null,
          );
        }
      }
      this.pending.add('normalize');
    }
  }

  /**
   * Queue the re-read of every container holding a node a commit changed
   * (its fields, NodeState, text or children), for a commit that is not
   * written (see onUpdate); in `into` (refusedComposing: not queued until
   * the composition ends). Returns whether there is any such container.
   */
  private $refuseChanged(
    dirtyElements: Map<NodeKey, boolean>,
    dirtyLeaves: Set<NodeKey>,
    editorState: EditorState,
    prevEditorState: EditorState,
    into: Set<CS> = this.refused,
  ): boolean {
    const state = this.state;
    const changed = this.$changedNodes(
      dirtyElements,
      dirtyLeaves,
      editorState,
      prevEditorState,
    );
    if (changed.length === 0) {
      return false;
    }
    if (state.containers.get(this._root) === undefined) {
      // Before the read that opens the document: that read, of the whole
      // document, replaces what the update changed. Refused (and warned
      // about) where the document turned out read only; still opening, it
      // is part of the content the read replaces (see replacesPending).
      return this._status === 'readonly';
    }
    const prevMap = prevEditorState._nodeMap;
    const nowMap = editorState._nodeMap;
    let found = false;
    const containerOf = (key: NodeKey, map: Map<NodeKey, LexicalNode>) => {
      for (let n = map.get(key); n !== undefined; ) {
        // A slot's value is held by its host (its up-link), not a parent.
        const parent: NodeKey | null =
          n.__parent ?? (n as {__slotHost?: null | NodeKey}).__slotHost ?? null;
        if (parent === null) {
          return;
        }
        const cs =
          parent === 'root'
            ? state.containers.get(this._root)
            : state.csByKey.get(parent);
        if (cs !== undefined) {
          into.add(cs);
          found = true;
          return;
        }
        n = map.get(parent);
      }
    };
    for (const key of changed) {
      const own = state.csByKey.get(key);
      if (own !== undefined) {
        into.add(own);
        found = true;
      }
      containerOf(key, nowMap);
      containerOf(key, prevMap);
    }
    if (into === this.refused && this.refused.size > 0) {
      this.pending.add('reread');
    }
    return found;
  }

  /**
   * The value stored for `wrapper` (in the state being read, which the
   * document stores) at its first atom: its JSON as wrappersFromAttrs reads
   * it, or null. Each line's atoms, and the offsets of the wrappers in it,
   * are found once (`lines`, kept for one update).
   */
  private $storedWrapperValue(
    wrapper: ElementNode,
    lines: Map<NodeKey, StoredLine>,
  ): Attrs | null {
    const owner = $ownerOf(wrapper);
    if (owner === null) {
      return null;
    }
    let line = lines.get(owner.getKey());
    if (line === undefined) {
      line = {atoms: this.storedAtoms(owner), offsets: $wrapperOffsets(owner)};
      lines.set(owner.getKey(), line);
    }
    const offset = line.offsets.get(wrapper.getKey());
    if (offset === undefined) {
      return null;
    }
    // The atom range holding `offset` (ranges are in order).
    const {atoms} = line;
    let lo = 0;
    let hi = atoms.length - 1;
    let at: [number, number, Attrs] | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [from, to] = atoms[mid];
      if (offset < from) {
        hi = mid - 1;
      } else if (offset >= to) {
        lo = mid + 1;
      } else {
        at = atoms[mid];
        break;
      }
    }
    if (at === undefined) {
      return null;
    }
    const editor = this._editor;
    const value = wrappersFromAttrs(at[2], type =>
      wrapperFieldsOf(editor, type),
    ).find(v => v.type === wrapper.getType());
    return value === undefined ? null : value.json;
  }

  /**
   * The content of the line (or inline container) `owner` as stored: each
   * content item's atom range and the formats in effect at it.
   */
  private storedAtoms(owner: ElementNode): [number, number, Attrs][] {
    const state = this.state;
    const unit = state.unitByKey.get(owner.getKey());
    let start: Item | null;
    let formats: Map<string, unknown>;
    if (unit !== undefined && unit.end !== null) {
      const left = prevLiveEnd(unit.end, state.hidden);
      start = left === null ? unit.cs.y._start : left.right;
      formats = new Map(unit.start || []);
    } else if (unit !== undefined && unit.kind === 'implicit') {
      const units = unit.cs.units;
      const idx = units.indexOf(unit);
      let left = idx > 0 ? units[idx - 1].end : null;
      while (left !== null && !isShownEnd(left, state.hidden)) {
        left = prevLiveEnd(left, state.hidden);
      }
      start = left === null ? unit.cs.y._start : left.right;
      formats = new Map(unit.start || []);
    } else {
      const cs = state.csByKey.get(owner.getKey());
      if (cs === undefined || cs.kind !== 'i') {
        return [];
      }
      start = cs.y._start;
      formats = new Map();
    }
    const out: [number, number, Attrs][] = [];
    let offset = 0;
    for (let it = start; it !== null; it = it.right) {
      if (!it.deleted && it.content instanceof ContentFormat) {
        if (it.content.value === null) {
          formats.delete(it.content.key);
        } else {
          formats.set(it.content.key, it.content.value);
        }
        continue;
      }
      const len = shownLength(it, state.hidden);
      if (len === 0) {
        if (isShownEnd(it, state.hidden)) {
          break;
        }
        continue;
      }
      out.push([offset, offset + len, Object.fromEntries(formats) as Attrs]);
      offset += len;
    }
    return out;
  }

  /** Containers a write did not write a follow-up's change to (see refused). */
  private noteRefused(writer: Writer, naming: boolean): void {
    for (const cs of writer.refused) {
      this.refused.add(cs);
    }
    if (writer.refused.size > 0) {
      this.pending.add('reread');
      if (naming) {
        this.refusedNaming = true;
      }
    }
  }

  /**
   * Whether a commit holds the update Lexical makes when a node transform is
   * registered, which marks every node of the transform's type dirty so that
   * the transform runs over the whole document (a plugin mounted once the
   * document is open). Invariant: such a commit is a follow-up: what it
   * changes in content a collaborator wrote is not written, and those
   * containers are read again. Why: every client that registers the
   * transform makes that update; it is no one's edit.
   */
  private isRegistrationPass(
    dirtyElements: Map<NodeKey, boolean>,
    dirtyLeaves: Set<NodeKey>,
    prevEditorState: EditorState,
  ): boolean {
    const added = this.noteTransforms();
    if (added.length === 0) {
      return false;
    }
    // Whether every node of each type that gained a transform is dirty. A
    // type whose nodes are not all dirty yet waits for its own update (a
    // plugin that registers transforms for several types makes one update
    // for each, and they commit one by one).
    const allDirty = new Map<string, boolean>();
    for (const [key, node] of prevEditorState._nodeMap) {
      const type = node.__type;
      if (added.includes(type)) {
        allDirty.set(
          type,
          allDirty.get(type) !== false &&
            (dirtyElements.has(key) || dirtyLeaves.has(key)),
        );
      }
    }
    let found = false;
    for (const [type, all] of allDirty) {
      if (all) {
        found = true;
      } else {
        this.registeredTypes.add(type);
      }
    }
    return found;
  }

  /**
   * Note the transforms each node type has; returns the types that gained
   * one since the last call (a transform registered again, as a plugin that
   * mounts again registers a new one, counts as gained).
   */
  private noteTransforms(): string[] {
    const added: string[] = [];
    for (const [type, info] of this._editor._nodes) {
      if (
        this.registeredTypes.has(type) ||
        this.gainedTransform(type, info.transforms)
      ) {
        added.push(type);
        this.transformSets.set(type, new Set(info.transforms));
      } else if (
        info.transforms.size !==
        (this.transformSets.get(type) ?? NO_TRANSFORMS).size
      ) {
        this.transformSets.set(type, new Set(info.transforms));
      }
    }
    this.registeredTypes.clear();
    return added;
  }

  /**
   * Note every node transform registered through the editor while the
   * binding runs, a transform registered again included: Lexical runs it
   * over every node of its type again, which is a registration pass like
   * the first.
   *
   * Invariant: while the binding writes, a registration pass (the update
   * Lexical makes to mark every node of the type dirty) commits alone. Why:
   * Lexical would run it inside the running update, or commit it with
   * whatever else is queued with it (an app's edit), and that commit would
   * be taken for the pass, the edit never written. So the pass is queued,
   * not run, from any context (an update, a listener, a read, outside any),
   * taken off Lexical's queue, and run once the editor is idle, as an update
   * of its own (see runPending); an edit still pending outside an update
   * commits first. The transform itself is registered at once: an update
   * running then, or made before the pass, runs it on what it changes, and
   * is written as the edit it is.
   */
  private noteRegistrations(): () => void {
    const editor = this._editor;
    const register = editor.registerNodeTransform;
    const registeredTypes = this.registeredTypes;
    const transformSets = this.transformSets;
    const binding = this;
    editor.registerNodeTransform = function (
      this: LexicalEditor,
      klass: Klass<LexicalNode>,
      listener: Transform<LexicalNode>,
    ) {
      if (!binding.writesEdits()) {
        // Nothing is written yet (or at all): the pass commits as Lexical
        // makes it, and is noted for isRegistrationPass.
        registeredTypes.add(klass.getType());
        return register.call(this, klass, listener);
      }
      if (!editor._updating && !isCurrentlyReadOnlyMode()) {
        binding.commitPending();
      }
      const updating = editor._updating;
      const from = editor._updates.length;
      // Lexical queues an update made while one runs instead of running it.
      editor._updating = true;
      let dispose: () => void;
      try {
        dispose = register.call(this, klass, listener);
      } finally {
        editor._updating = updating;
      }
      const queued = editor._updates.splice(from);
      // The types that gained the transform are noted now, so that a commit
      // before the pass is not taken for it.
      for (const [type, info] of editor._nodes) {
        if (info.transforms.has(listener)) {
          transformSets.set(type, new Set(info.transforms));
        }
      }
      if (queued.length > 0) {
        for (const [fn] of queued) {
          binding.registrationPasses.push(fn);
        }
        binding.pending.add('register');
        // Not inside a read (an update must not run there). Once a pass ran
        // in this task, the next ones wait for a microtask and run as one:
        // transforms registered in a row (a plugin host enabling plugins in
        // a loop) all run over the document, in one update, as Lexical
        // commits their updates together.
        binding.schedulePending(
          isCurrentlyReadOnlyMode() || binding.registrationRuns > 0,
        );
      }
      return dispose;
    } as typeof register;
    return () => {
      editor.registerNodeTransform = register;
    };
  }

  /**
   * Run the updates Lexical made for registered transforms (see
   * noteRegistrations) as one update of their own, from runPending (the
   * editor is idle, so it commits alone). It is no one's edit: tagged so
   * (see onUpdate, where what its transforms changed is read again). It
   * stays Lexical's update, tagged as Lexical tags it, not
   * COLLABORATION_TAG: BlockIdExtension names the blocks it changes in it,
   * rather than in a naming update of its own, which an app listener's edit
   * queued in the same listener phase would be committed with (and taken
   * for).
   */
  private runRegistrationPasses(): void {
    const passes = this.registrationPasses.splice(0);
    if (passes.length === 0) {
      return;
    }
    if (this.registrationRuns++ === 0) {
      setTimeout(() => {
        this.registrationRuns = 0;
      }, 0);
    }
    if (this.registrationRuns > MAX_REGISTRATION_RUNS) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `@lexical/y: more than ${MAX_REGISTRATION_RUNS} updates for registered transforms ran before the event loop turned (transforms registered in more than ${MAX_REGISTRATION_RUNS} microtasks of one task, or a listener that registers a transform after every commit); the update of a transform registered since is dropped, so it does not run over the existing document.`,
        );
      }
      return;
    }
    this._editor.update(
      () => {
        for (const pass of passes) {
          pass();
        }
      },
      {discrete: true, tag: [HISTORY_MERGE_TAG, REGISTRATION_TAG]},
    );
  }

  /** Whether `transforms` holds one type `type` did not have when noted. */
  private gainedTransform(
    type: string,
    transforms: ReadonlySet<Transform<LexicalNode>>,
  ): boolean {
    const noted = this.transformSets.get(type) ?? NO_TRANSFORMS;
    for (const t of transforms) {
      if (!noted.has(t)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Commit the local updates still pending (an editor.update() made in the
   * same task, or one a listener of the last commit queued, also where that
   * listener threw before Lexical ran it). Invariant: the update the binding
   * makes next (a read) commits alone. Why: an update still pending would be
   * committed with it, and take its tags. Committing one can leave another
   * pending (its listeners queue one): up to MAX_PENDING_COMMITS are
   * committed. Returns whether none is left (where the editor is not in an
   * update; in one, the updates are its own). A pending state that holds
   * nothing to commit is committed as it is: an update reuses such a state
   * without committing it, so a read that changes nothing would leave its
   * tags on it, and the next update that changes something would commit
   * with them and not be written.
   */
  private commitPending(): boolean {
    const editor = this._editor;
    if (!editor._updating) {
      // Held app updates (see notifyApart) commit like the others.
      this.handBackReplies();
    }
    const left = () =>
      !editor._updating &&
      (editor._pendingEditorState !== null || editor._updates.length > 0);
    for (let i = 0; i < MAX_PENDING_COMMITS && left(); i++) {
      const pending = editor._pendingEditorState;
      try {
        editor.update(() => {}, {discrete: true});
        if (pending !== null && editor._pendingEditorState === pending) {
          editor.read(() => {});
        }
      } catch (error) {
        // An update or a listener of the app's threw: its error is rethrown
        // in a microtask, and the updates still pending commit.
        rethrowLater(error);
      }
    }
    return !left();
  }

  /**
   * Whether a local update that changes content commits now, as one with
   * `discrete: true` does, instead of in a microtask (where the updates made
   * in one task commit, and are written, together).
   *
   * Invariant: a local update commits at once whenever deferring it could
   * merge it into a commit that is not a user's edit, or let a remote change
   * land between computing and writing it: once a commit was made in the
   * task (an update an app's listener queues; a provider can apply a remote
   * change in the same task), while the binding has updates of its own
   * waiting (see runPending), and while a transform registered since the
   * last commit waits for its registration pass (see isRegistrationPass).
   * Why: a merged commit cannot tell whose its changes are, and an update
   * written after a remote change is written at positions computed without
   * it.
   */
  private commitsAtOnce(): boolean {
    if (this.task.committed || this.pending.size > 0 || this.pendingScheduled) {
      return true;
    }
    if (this.registeredTypes.size > 0) {
      return true;
    }
    for (const [type, info] of this._editor._nodes) {
      if (this.gainedTransform(type, info.transforms)) {
        return true;
      }
    }
    return false;
  }

  /**
   * @internal Run the binding's own updates that wait for the editor to be
   * idle (see runPending) now, instead of in a microtask: for the headless
   * helpers, which commit the editor's pending updates themselves and
   * encode the document right after an edit. Returns whether any of them
   * still waits (the editor is not idle: a listener queued an update).
   * `private` to the type only, so that the published declarations do not
   * offer it; the headless helpers reach it through `BindingInternals`.
   */
  private flushPending(): boolean {
    return this.guard(() => {
      this.runPending();
      return this.pending.size > 0;
    });
  }

  /** Whether no update is running, queued or pending. */
  private isIdle(): boolean {
    const editor = this._editor;
    return (
      !editor._updating &&
      editor._updates.length === 0 &&
      editor._pendingEditorState === null
    );
  }

  /**
   * Run the binding's pending updates (see runPending) now if the editor is
   * idle (and not `later`), else in a microtask; if the editor is still busy
   * then, the update listener schedules them again after the next commit.
   */
  private schedulePending(later = false): void {
    if (this.pending.size === 0) {
      return;
    }
    if (!later && this.isIdle()) {
      this.runPending();
    } else if (!this.pendingScheduled) {
      this.pendingScheduled = true;
      queueMicrotask(() => {
        this.pendingScheduled = false;
        this.guard(() => this.runPending());
      });
    }
  }

  /**
   * Run the binding's own updates, in PENDING_ORDER: committing the updates
   * the app's listeners made when notified of a status change (see
   * notifyApart), showing what was held back during a composition, reading
   * containers again after a follow-up's change was not written, the
   * author's normalization of an update that ran no transforms, the refresh
   * after a local change, and Lexical's update for a registered transform
   * (see noteRegistrations).
   *
   * Invariant: each commits alone, once the editor is idle, and never before
   * the editor shows the latest remote change. Why: Lexical runs the updates
   * queued in one listener phase as one commit, with their tags and options
   * merged, and an app's edit merged into a read or a refresh would never be
   * written; a write made before a remote change is read would delete what
   * the editor does not show yet. So they run in a microtask after the
   * listener phase, or when a remote transaction arrives, once it is read.
   * The author's normalization also waits for a composition to end, and is
   * first tried right away (see queueNormalize).
   */
  private runPending(): void {
    if (this.disposers.length === 0) {
      this.pending.clear();
      this.localRefresh.clear();
      this.remoteRefresh.clear();
      this.refused.clear();
      this.refusedComposing.clear();
      this.restoreTo = null;
      this.replies.length = 0;
      this.toSettle.clear();
      this.untransformed.clear();
      this.untransformedText.clear();
      this.storedHoles.clear();
      this.registrationPasses.length = 0;
      return;
    }
    for (;;) {
      if (!this.isIdle()) {
        return;
      }
      const work = PENDING_ORDER.find(
        w =>
          this.pending.has(w) &&
          (w !== 'normalize' || this._editor._compositionKey === null),
      );
      if (work === undefined) {
        return;
      }
      this.pending.delete(work);
      withPins(this._pins, () => {
        if (work === 'replies') {
          this.commitPending();
        } else if (work === 'restore') {
          this.restoreShown();
        } else if (work === 'hidden') {
          this.flushHidden();
        } else if (work === 'reread') {
          this.rereadRefused();
        } else if (work === 'normalize') {
          this.normalizeUntransformed();
        } else if (work === 'register') {
          this.runRegistrationPasses();
        } else {
          this.flushRefresh(true, this.remoteRefresh);
          this.flushRefresh(false, this.localRefresh);
        }
      });
    }
  }

  /**
   * Show again what the editor showed before the local updates made once
   * the binding failed closed (see onUpdate): the binding reads nothing
   * more, so it cannot read what they changed again.
   */
  private restoreShown(): void {
    const shown = this.restoreTo;
    this.restoreTo = null;
    if (shown !== null) {
      this.showAgain(shown);
    }
  }

  /**
   * Read again the containers where a follow-up changed what it may not
   * write (see Writer#followUp): the editor goes back to what is stored,
   * so that it never differs from the document (and from every other
   * client). Normally this runs as the next update (see queueReread); here
   * when the editor is idle (see runPending).
   */
  private rereadRefused(): void {
    let after: (() => void) | null = null;
    this.guardedRead({
      $read: () => {
        after = this.$rereadRefused();
      },
      after: () => {
        if (after !== null) {
          (after as () => void)();
        }
      },
      recover: (error, shown) => this.recoverRead(error, shown, 'reread'),
    });
  }

  /**
   * Queue the re-read of the containers a follow-up changed in ways that are
   * not written (see rereadRefused) as the next update, at the front of
   * Lexical's queue, from the update listener that found them. Invariant: no
   * other update (one another listener queued in the same listener phase, or
   * one the app makes later in the same task) is applied to an editor that
   * still shows such a change. Why: it would be written against content that
   * is not stored. The updates queued behind it, which Lexical would run in
   * the same update, run right after its commit, in their own.
   */
  private queueReread(): void {
    const editor = this._editor;
    if (
      !this.pending.has('reread') ||
      !editor._updating ||
      editor._updates.some(([fn]) => fn === this.rereadUpdate)
    ) {
      return;
    }
    editor._updates.unshift([
      this.rereadUpdate,
      {discrete: true, skipTransforms: true},
    ]);
  }

  /** The update queueReread queues. */
  private readonly rereadUpdate = (): void => {
    const editor = this._editor;
    const later = editor._updates.splice(0);
    let done = false;
    try {
      this.guard(() =>
        withPins(this._pins, () => {
          if (later.length > 0) {
            $onUpdate(() => {
              for (const [fn, options] of later) {
                editor.update(fn, options);
              }
            });
          }
          // Nested in this update (see guardedRead): what follows the read
          // runs after its commit, after the updates queued behind it.
          this.rereadRefused();
        }),
      );
      done = true;
    } finally {
      if (!done) {
        // The update fails: what was queued behind it runs as Lexical runs
        // queued updates.
        spliceAll(editor._updates, 0, 0, later);
      }
    }
  };

  /**
   * The re-read itself (see rereadRefused), inside an update (see
   * guardedRead); returns what runs once it has committed, if anything.
   */
  private $rereadRefused(): (() => void) | null {
    const list = [...this.refused].filter(
      cs => this.state.containers.get(cs.y) === cs,
    );
    const naming = this.refusedNaming;
    const settle = [...this.toSettle];
    this.refused.clear();
    this.toSettle.clear();
    this.refusedNaming = false;
    this.pending.delete('reread');
    if (list.length === 0 && settle.length === 0) {
      return null;
    }
    const last = ++this.rereads > MAX_REREADS;
    for (const tag of REMOTE_TAGS) {
      $addUpdateTag(tag);
    }
    // The re-read of a naming update's change is tagged as that update, so
    // that BlockIdExtension does not make it again on the content read.
    // So is a last read (below).
    if (naming || last) {
      $addUpdateTag(BLOCK_ID_REPAIR_TAG);
    }
    const cursor = this.$cursorBeforeRead();
    const caret = $showsCaret();
    const reader = new Reader(this.state);
    reader.$reading(() => {
      for (const cs of list) {
        const el = cs.y === this._root ? $getRoot() : $getNodeByKey(cs.key);
        if ($isElementNode(el) && el.isAttached()) {
          reader.$readFull(cs, el);
        }
      }
    });
    reader.$settle(settle);
    this.$selectionAfterRead(cursor, caret);
    this.$quietSelection();
    if (last) {
      // A transform that changes the same content each time it runs (a
      // list's own transforms in every refresh, say): a last read, with no
      // refresh after it, so that the editor still shows the document.
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          '@lexical/y: follow-ups keep changing content the binding does not write; the editor reads it again without refreshing it.',
        );
      }
      // Nor the refresh that would make the change again.
      this.state.refresh.clear();
      this.localRefresh.clear();
      this.remoteRefresh.clear();
      this.pending.delete('refresh');
      return () => this.checkUnknownTypes();
    }
    return () => {
      this.checkUnknownTypes();
      this.flushRefresh(true);
    };
  }

  /**
   * Queue the author's normalization of its own update that ran no
   * transforms (`editor.update(fn, {skipTransforms: true})`, or
   * `setEditorState` with a state the editor did not parse): an update that
   * marks what it changed dirty, so that Lexical's transforms run on it, and
   * calls NodeStructureExtension's normalization on it, as code that applies
   * an update with skipTransforms does.
   *
   * Invariant: only the author normalizes, under its own client id, as part
   * of its edit (in the same undo step where the undo manager groups it with
   * the edit: within captureTimeout, so not at 0), and its commit holds only
   * the normalization. Why: readers show the update as written until then, and
   * the normalization is the author's edit, written once. It is queued from
   * the update listener, so that it runs right after the update, before a
   * remote change can be read (which could give the nodes it normalizes new
   * ones); not while composing. Lexical commits an update queued there with
   * any other update queued in the same listener phase: then it does nothing
   * (it is queued with no tags, so that it adds nothing to that commit) and
   * waits for the next phase, or for the editor to be idle (see runPending).
   */
  private queueNormalize(): void {
    if (
      this.normalizeQueued ||
      !this.pending.has('normalize') ||
      this._editor._compositionKey !== null
    ) {
      return;
    }
    this.normalizeQueued = true;
    this._editor.update(
      () => {
        this.normalizeQueued = false;
        const editor = this._editor;
        // Not while the editor still shows a change the binding did not
        // write (see rereadRefused): the normalization would find it done.
        if (
          this.pending.has('normalize') &&
          !this.pending.has('reread') &&
          editor._updates.length === 0 &&
          editor._dirtyElements.size === 0 &&
          editor._dirtyLeaves.size === 0 &&
          editor._updateTags.size === 0
        ) {
          this.pending.delete('normalize');
          this.$normalize();
        }
      },
      {discrete: true},
    );
  }

  /** The author's normalization, once the editor is idle (see runPending). */
  private normalizeUntransformed(): void {
    this._editor.update(() => this.$normalize(), {discrete: true});
  }

  /** The author's normalization itself, inside an update. */
  private $normalize(): void {
    if (
      !this.writesEdits() ||
      (this.untransformed.size === 0 &&
        this.untransformedText.size === 0 &&
        this.storedHoles.size === 0)
    ) {
      this.untransformed.clear();
      this.untransformedText.clear();
      this.storedHoles.clear();
      return;
    }
    const entries = [...this.untransformed];
    const texts = [...this.untransformedText];
    const holed = [...this.storedHoles];
    this.untransformed.clear();
    this.untransformedText.clear();
    this.storedHoles.clear();
    $addUpdateTag(HISTORY_MERGE_TAG);
    $addUpdateTag(NORMALIZE_TAG);
    for (const key of holed) {
      // What every reader parses from what was stored (see storedHoles).
      const node = $getNodeByKey(key);
      if (node !== null && node.isAttached() && this.state.yByKey.has(key)) {
        $applyStoredAttrs(node, $nodeAttrs(node));
      }
    }
    for (const key of texts) {
      const node = $getNodeByKey(key);
      if ($isTextNode(node) && node.isAttached()) {
        node.markDirty();
      }
    }
    // Each element, found by what stores it if a remote change read since
    // gave it a new node, and the element that holds it now.
    const nodes = new Set<ElementNode>();
    for (const [key, anchor] of entries) {
      let node = $getNodeByKey(key);
      if (!$isElementNode(node) || !node.isAttached()) {
        node = this.$nodeStoredBy(anchor);
      }
      if ($isElementNode(node) && node.isAttached()) {
        nodes.add(node);
        const parent = node.getParent();
        if (parent !== null) {
          nodes.add(parent);
        }
      }
    }
    for (const node of nodes) {
      node.markDirty();
      // The root's own normalization runs in every update (it wraps inline
      // content); the whole document is not.
      if (!$isRootNode(node)) {
        INTERNAL_$normalizeNodeStructure(node);
      }
    }
  }

  /**
   * At the end of a read: the read's selection counts as notified, and
   * SELECTION_CHANGE_COMMAND is dispatched once the read has committed, in an
   * update of its own (Lexical skips the notification itself where it would
   * not run: headless, no root element).
   *
   * Invariant: a read runs no node transforms. Why: when a read's selection
   * changes, Lexical extends the commit with the selection change command
   * and runs every node transform over the update's changes in it, whatever
   * the update's options; over the content the read brought (a table
   * transform padding a ragged table), the editor would then show what the
   * binding does not write.
   */
  private $quietSelection(): void {
    const editor = this._editor;
    $clampSelection();
    const selection = $getSelection();
    const previous = editor._lastNotifiedSelection;
    if (selection === null ? previous === null : selection.is(previous)) {
      return;
    }
    const root = editor._rootElement;
    if (
      (selection === null || $isRangeSelection(selection)) &&
      (editor._headless || root === null || !root.isConnected)
    ) {
      return;
    }
    editor._lastNotifiedSelection =
      selection === null ? null : selection.clone();
    $onUpdate(() => {
      editor.update(() => {
        editor.dispatchCommand(SELECTION_CHANGE_COMMAND, undefined);
      });
    });
  }

  /** The node a shared node or a line's marker stores now, if any. */
  private $nodeStoredBy(anchor: YNode | Item | null): LexicalNode | null {
    if (anchor === null) {
      return null;
    }
    if (anchor instanceof YNode) {
      const key = this.state.keyByY.get(anchor);
      return key === undefined ? null : $getNodeByKey(key);
    }
    const unit = this.state.unitByEnd.get(anchor);
    return unit === undefined || unit.key === null
      ? null
      : $getNodeByKey(unit.key);
  }

  // -------------------------------------------------------------------------
  // Undo

  /**
   * Undo keeps a container a peer has put content in, whole: with its
   * fields and the undoing client's own content in it (deleting those would
   * leave a malformed container).
   */
  private isKeptByUndo(item: Item): boolean {
    // A null a format change wrote after its range to end its value there:
    // kept where without it the content after it would take a value (that
    // of a collaborator's change that ended inside the range, closed with
    // the value this change gave), and where a collaborator removed this
    // change's own opener (an undo of that removal brings it back).
    if (isFormatCloser(item) && this.undoing !== null) {
      const {key} = item.content as ContentFormat;
      for (let it = item.left; it !== null; it = it.left) {
        if (!(it.content instanceof ContentFormat) || it.content.key !== key) {
          continue;
        }
        if (this.undoing.has(it)) {
          if (it.deleted) {
            return true;
          }
        } else if (!it.deleted) {
          return it.content.value !== null;
        }
      }
      return false;
    }
    // The layout and schema records only grow.
    if (
      item.parent === this._root &&
      typeof item.parentSub === 'string' &&
      (item.parentSub.startsWith(LAYOUT_PREFIX) ||
        item.parentSub.startsWith(SCHEMA_PREFIX))
    ) {
      return true;
    }
    // A container this undo also restores elsewhere was moved (deleted and
    // written again): keeping the new copy would duplicate it.
    const moved = (it: Item): boolean =>
      this.restoring !== null && this.restoring.has(nameOf(it));
    if (isNonEmptyContainer(item, this.undoCache)) {
      return !moved(item);
    }
    for (
      let t: unknown = item.parent;
      t instanceof YNode && t !== this._root;
      t = t._item === null ? null : t._item.parent
    ) {
      // Only a container this undo deletes (one it inserted): the content
      // of other containers is undone as usual.
      if (
        t._item !== null &&
        this.removing !== null &&
        this.removing.has(t._item) &&
        isNonEmptyContainer(t._item, this.undoCache)
      ) {
        return !moved(t._item);
      }
    }
    return false;
  }

  /**
   * Undo this client's last change in the document (collaborative undo).
   * Returns whether there was one; false while the binding is not active.
   */
  undo(): boolean {
    return this.undoOrRedo(true);
  }

  /** Redo what `undo` undid; see `undo`. */
  redo(): boolean {
    return this.undoOrRedo(false);
  }

  /**
   * Undo or redo. Called while the editor is updating (from a command
   * handler such as UNDO_COMMAND's, inside an update or its `$onUpdate`, from
   * a listener), it runs as the next update, right after the running one,
   * which then commits at once (see queueFirst). Returns whether there was a
   * step to undo or redo.
   *
   * Invariant: an undo or redo is read in an update of its own, with the
   * binding's read options (no transforms, tagged as a collaborator's
   * change). Why: inside the running update it would take that update's
   * options and tags, and Lexical's transforms (list numbering) would run
   * over the part it had read.
   */
  private undoOrRedo(undo: boolean): boolean {
    const um = this._undoManager;
    // Nothing is written while the binding is not active (see
    // YBindingStatus): an undo or redo would write.
    if (um === null || !this.writesEdits()) {
      return false;
    }
    const editor = this._editor;
    if (!editor._updating) {
      return this.applyUndo(um, undo);
    }
    if (!(undo ? um.canUndo() : um.canRedo())) {
      return false;
    }
    const run = () =>
      this.queueFirst(
        () => {
          this.applyUndo(um, undo);
        },
        {discrete: true, skipTransforms: true, tag: REMOTE_TAGS},
      );
    if (editor._pendingEditorState !== null) {
      // Inside an update: after it commits.
      $flushSyncAfterUpdate();
      $onUpdate(() => this.guard(run));
    } else {
      run();
    }
    return true;
  }

  private applyUndo(um: UndoManager, undo: boolean): boolean {
    const stack = undo ? um.undoStack : um.redoStack;
    this.undoCache = new WeakMap();
    this.scanStackItem(stack);
    const top = stack[stack.length - 1];
    this.stepCursor =
      top === undefined ? null : ((top.meta.get(this) as YCursor) ?? null);
    try {
      const popped = undo ? um.undo() : um.redo();
      if (popped !== null) {
        this.carryCloserMarks(popped);
        this.closeRestoredRuns(popped);
      }
      return popped !== null;
    } finally {
      this.restoring = null;
      this.removing = null;
      this.undoing = null;
      this.stepCursor = null;
    }
  }

  /**
   * Queue `fn` as the next update, at the front of Lexical's queue (call
   * while the editor is updating). The updates queued behind it, which
   * Lexical would run as part of the same update, run right after its
   * commit, in their own.
   */
  private queueFirst(
    fn: () => void,
    options: {discrete: true; skipTransforms: true; tag?: string[]},
  ): void {
    const editor = this._editor;
    editor._updates.unshift([
      () => {
        const later = editor._updates.splice(0);
        let done = false;
        try {
          this.guard(() => withPins(this._pins, fn));
          if (later.length > 0) {
            $onUpdate(() => {
              for (const [f, o] of later) {
                editor.update(f, o);
              }
            });
          }
          done = true;
        } finally {
          if (!done) {
            spliceAll(editor._updates, 0, 0, later);
          }
        }
      },
      options,
    ]);
  }

  /**
   * Give the copies the undo or redo of `step` made of format closers (see
   * isKeptByUndo) the closers' mark: a redo makes a new item of each item
   * its undo deleted, and without the mark the next undo of that change
   * deleted a closer it would have kept, so the value it ended ran on (a
   * bold made, undone and redone, then a collaborator's removal of it undone
   * after its undo, left the rest of the document bold).
   */
  private carryCloserMarks(step: UndoManager['undoStack'][number]): void {
    const store = this._doc.store;
    this._doc.transact(tr => {
      iterateStructsByIdSet(tr, step.deletes, s => {
        if (s instanceof Item && s.redone !== null && isFormatCloser(s)) {
          const copy = store.getItem(s.redone);
          if (copy instanceof Item) {
            markFormatCloser(copy);
          }
        }
      });
    }, this.scanOrigin);
  }

  /**
   * End each run that a format item the undo or redo of `step` brought back
   * opens with an item of this client's own, where the item that ended it is
   * another client's: right before a live null of another client's that ends
   * it, or right after the end the original's own change gave its run (see
   * changeEnd), where that is gone and nothing ends the run before it. An
   * undo brings back the items its change deleted, and the closer that ended
   * such a run was not among them: a collaborator's concurrent undo of the
   * change that wrote it removed it, and the value ran on to the end of the
   * document (a comment added, undone while a collaborator resolved it and
   * undid the resolve, put the comment on everything after it; bold removed
   * from a collaborator's bold text while the collaborator undid it, and that
   * removal undone, made everything after it bold). Invariant: a run an undo
   * or redo brings back ends where a closer ended it for this client,
   * whatever another client removes at the same time. A run that another
   * value ends is left as it is: where that value's change is undone, the run
   * going on over its text is what it had before (a copy of that value kept
   * it there after its own undo). A copy inside a run of its own value (see
   * opensRun) opens no run: the run it is in ends where it ends.
   */
  private closeRestoredRuns(step: UndoManager['undoStack'][number]): void {
    const doc = this._doc;
    const store = doc.store;
    const client = doc.clientID;
    // Where to write each null: after `left`, before `right`.
    const ends: [left: Item | null, right: Item | null, key: string][] = [];
    doc.transact(tr => {
      const copies: [original: Item, copy: Item][] = [];
      iterateStructsByIdSet(tr, step.deletes, s => {
        if (
          s instanceof Item &&
          s.redone !== null &&
          s.content instanceof ContentFormat
        ) {
          const copy = store.getItem(s.redone);
          if (
            copy instanceof Item &&
            !copy.deleted &&
            copy.content instanceof ContentFormat &&
            copy.content.value !== null
          ) {
            copies.push([s, copy]);
          }
        }
      });
      for (const [original, copy] of copies) {
        const {key} = copy.content as ContentFormat;
        // The end of the run the original opened in its own write (see
        // changeEnd): where that is gone (the undo of that write), the
        // copy's run ends there.
        const gone = opensRun(copy) ? changeEnd(doc, original) : null;
        let shown = false;
        for (let it = copy.right; it !== null; it = it.right) {
          if (it === gone && it.deleted) {
            if (shown) {
              ends.push([it, it.right, key]);
            }
            break;
          }
          if (it.deleted) {
            continue;
          }
          if (it.content instanceof ContentFormat) {
            if (it.content.key === key) {
              if (
                shown &&
                it.id.client !== client &&
                it.content.value === null
              ) {
                ends.push([it.left, it, key]);
              }
              break;
            }
          } else if (it.countable) {
            shown = true;
          }
        }
      }
    }, this.scanOrigin);
    if (ends.length > 0) {
      doc.transact(tr => {
        for (const [left, right, key] of ends) {
          const item = new Item(
            createID(client, store.getClock(client)),
            left,
            left && left.lastId,
            right,
            right && right.id,
            (left ?? right)!.parent,
            null,
            new ContentFormat(key, null as unknown as object),
          );
          item.integrate(tr, 0);
          markFormatCloser(item);
        }
      }, this.runEndOrigin);
    }
  }

  /**
   * The stored nodes the next stack item restores (by name) and deletes
   * (items), for the undo delete filter.
   */
  private scanStackItem(stack: UndoManager['undoStack']): void {
    const top = stack[stack.length - 1];
    this.restoring = null;
    this.removing = null;
    this.undoing = null;
    if (top === undefined) {
      return;
    }
    const names = new Set<string>();
    const removing = new Set<Item>();
    const undoing = new Set<Item>();
    const isStored = (s: unknown): s is Item => {
      if (!(s instanceof Item) || !(s.content instanceof ContentType)) {
        return false;
      }
      const name = nameOf(s);
      return name !== MARKER && name !== RUN_END;
    };
    this._doc.transact(tr => {
      iterateStructsByIdSet(tr, top.deletes, s => {
        if (isStored(s)) {
          names.add(nameOf(s));
        }
      });
      iterateStructsByIdSet(tr, top.inserts, s => {
        if (s instanceof Item) {
          undoing.add(s);
        }
        if (isStored(s)) {
          removing.add(s);
        }
      });
    }, this.scanOrigin);
    this.restoring = names;
    this.removing = removing;
    this.undoing = undoing;
  }

  // -------------------------------------------------------------------------
  // Cursors

  /** The local selection as relative positions (JSON), or null. */
  getCursor(): YCursor | null {
    // On the document as this binding's editor shows it (see guard).
    return seenBy(this.seer, () => this.readCursor());
  }

  private readCursor(): YCursor | null {
    return this._editor.getEditorState().read(() => {
      try {
        return this.$captureCursor();
      } catch (_e) {
        // A selection the editor itself left invalid: no cursor.
        return null;
      }
    });
  }

  /**
   * The Yjs identities a node selection's nodes `keys` are stored or shown
   * by, as `state` maps them once written (see SelectedAnchor): a node
   * stored as its own Y.Node by that node's item, a line by its marker, a
   * text node by the position of its first character (in its line), and
   * any other node by the first of those inside it (a list by its first
   * line, a link by its first text node) and how many levels above that one
   * it is. A node with none (an empty text node) is left out.
   */
  private $selectedAnchors(
    state: State,
    keys: readonly NodeKey[],
  ): SelectedAnchor[] {
    const out: SelectedAnchor[] = [];
    for (const key of keys) {
      const node = $getNodeByKey(key);
      if (node === null) {
        continue;
      }
      const type = node.getType();
      let n: LexicalNode | null = node;
      for (let up = 0; n !== null; up++) {
        const k = n.getKey();
        if ($isTextNode(n)) {
          const position =
            n.getTextContentSize() > 0
              ? this.$relativePosition($createPoint(k, 0, 'text'), false, state)
              : null;
          if (position !== null) {
            out.push({position, type, up});
          }
          break;
        }
        const y = state.yByKey.get(k);
        const unit = state.unitByKey.get(k);
        const item =
          y !== undefined && y._item !== null
            ? y._item
            : unit !== undefined && unit.key === k
              ? unit.end
              : null;
        if (item !== null) {
          out.push({
            client: item.id.client,
            clock: item.id.clock,
            type,
            up,
          });
          break;
        }
        n = $isElementNode(n) ? n.getFirstChild() : null;
      }
    }
    return out;
  }

  /**
   * The current selection as relative positions. A collapsed caret is
   * anchored to the character on its left, so that it stays after what the
   * user just typed when a peer inserts at the same place; a range is
   * anchored to its first and last characters, so it does not grow over
   * concurrent inserts at its edges.
   */
  private $captureCursor(state = this.state): YCursor | null {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return null;
    }
    const collapsed = selection.isCollapsed();
    const backward = selection.isBackward();
    const anchor = this.$relativePosition(
      selection.anchor,
      collapsed || backward,
      state,
    );
    const focus = this.$relativePosition(
      selection.focus,
      collapsed || !backward,
      state,
    );
    return anchor === null || focus === null ? null : {anchor, focus};
  }

  /**
   * Inside an update, before a full read of containers (see
   * Reader#$readFull), which can give the lines and wrappers the selection
   * is in other nodes: the selection as relative positions, or null.
   */
  private $cursorBeforeRead(state = this.state): YCursor | null {
    try {
      return this.$captureCursor(state);
    } catch (_e) {
      return null;
    }
  }

  /**
   * After a full read: put back the selection captured before it (see
   * $cursorBeforeRead), a caret staying a caret, and drop what still names
   * a removed node.
   */
  private $selectionAfterRead(cursor: YCursor | null, caret: boolean): void {
    if (cursor !== null) {
      this.$restoreSelection(cursor, caret);
    }
    $clampSelection();
    this.$caretOnText();
  }

  /**
   * A caret a read leaves on a block element that is not a line (a list, a
   * list item holding a nested list, a table, a box), or on a line that
   * holds blocks (a quote that holds paragraphs), goes to the nearest text
   * position inside it: the end of what is before it there, else the start
   * of what is after. Invariant: a read leaves no caret on such an element.
   * Why: typing there is dropped (or lands inside its structure, or starts a
   * new paragraph), and Backspace deletes structure (a nested list of other
   * users' text).
   */
  private $caretOnText(): void {
    const selection = $getSelection();
    if (
      !$isRangeSelection(selection) ||
      !selection.isCollapsed() ||
      selection.anchor.type !== 'element'
    ) {
      return;
    }
    const node = selection.anchor.getNode();
    if (
      !$isElementNode(node) ||
      node.isInline() ||
      (this.state.unitByKey.has(node.getKey()) && !node.isShadowRoot())
    ) {
      return;
    }
    const cs = this.state.csByKey.get(node.getKey());
    if (cs !== undefined && cs.kind === 'i') {
      return;
    }
    const offset = selection.anchor.offset;
    const before = offset > 0 ? node.getChildAtIndex(offset - 1) : null;
    const after = node.getChildAtIndex(offset);
    if ($isElementNode(before)) {
      before.selectEnd();
    } else if ($isElementNode(after)) {
      after.selectStart();
    }
  }

  /** Resolve a cursor to Lexical points (call inside a read or update). */
  $resolveCursor(
    cursor: YCursor,
  ): {anchor: PointType; focus: PointType} | null {
    const anchor = this.$resolvePosition(cursor.anchor);
    const focus = this.$resolvePosition(cursor.focus);
    if (anchor === null || focus === null) {
      return null;
    }
    const selection = $createRangeSelection();
    selection.anchor.set(anchor.key, anchor.offset, anchor.type);
    selection.focus.set(focus.key, focus.offset, focus.type);
    return {anchor: selection.anchor, focus: selection.focus};
  }

  /**
   * Map the local selection through a remote change: resolve the cursor
   * captured before the transaction; points that cannot be resolved are
   * clamped to their node. Invariant: with `caret` (the editor showed a
   * caret when the read began, see $showsCaret), a caret is never widened
   * into a range: when the editor shows a caret but the cursor was a range
   * (captured before a local update collapsed it), the caret stays where it
   * is, clamped. Why: a Backspace would delete a range the user no longer
   * selects.
   *
   * Invariant: whether the selection is a caret is decided on what the
   * editor showed before the read, never after it. Why: the read changes
   * the nodes a range is in (it shortens a text node, splits it where a
   * format or a link starts, replaces it), and Lexical moves points that
   * fall outside a changed node to its end: both points of a range can end
   * on one offset, and a range read as a caret there is collapsed for good.
   *
   * Invariant: putting the selection back never fails the read it ends: a
   * cursor that cannot be put back leaves the selection the read left,
   * clamped to its nodes. Why: the read's content is right, and a read that
   * throws makes the binding rebuild the editor (see recoverRead).
   */
  private $restoreSelection(cursor: YCursor, caret = false): void {
    try {
      this.$putBackSelection(cursor, caret);
    } catch (_e) {
      $clampSelection();
    }
  }

  /** See $restoreSelection. */
  private $putBackSelection(cursor: YCursor, caret: boolean): void {
    const current = $getSelection();
    if (current !== null && !$isRangeSelection(current)) {
      return;
    }
    let selection: RangeSelection | null = current;
    const anchor = this.$resolvePosition(cursor.anchor);
    const focus = this.$resolvePosition(cursor.focus);
    const widens =
      caret &&
      selection !== null &&
      anchor !== null &&
      focus !== null &&
      (anchor.key !== focus.key ||
        anchor.offset !== focus.offset ||
        anchor.type !== focus.type);
    if (anchor !== null && focus !== null && !widens) {
      if (selection === null) {
        selection = $createRangeSelection();
        $setSelection(selection);
      }
      const same = (
        p: PointType,
        q: {key: NodeKey; offset: number; type: 'text' | 'element'},
      ) => p.key === q.key && p.offset === q.offset && p.type === q.type;
      if (!same(selection.anchor, anchor) || !same(selection.focus, focus)) {
        selection.anchor.set(anchor.key, anchor.offset, anchor.type);
        selection.focus.set(focus.key, focus.offset, focus.type);
      }
      return;
    }
    $clampSelection();
  }

  /**
   * After a remote read: put a caret whose line the transaction replaced at
   * its offset in the line that replaced it (see $replacedLineCaret).
   * Returns whether it did; otherwise the selection is left to
   * $restoreSelection. Never fails the read (as $restoreSelection).
   */
  private $putCaretInReplacedLine(cursor: YCursor, tr: Transaction): boolean {
    try {
      const current = $getSelection();
      if (
        current !== null &&
        !($isRangeSelection(current) && current.isCollapsed())
      ) {
        return false;
      }
      const point = this.$replacedLineCaret(cursor, tr);
      if (point === null) {
        return false;
      }
      let selection: RangeSelection | null = current;
      if (selection === null) {
        selection = $createRangeSelection();
        $setSelection(selection);
      }
      selection.anchor.set(point.key, point.offset, point.type);
      selection.focus.set(point.key, point.offset, point.type);
      return true;
    } catch (_e) {
      return false;
    }
  }

  /**
   * Where a caret goes when a remote transaction replaced its line: deleted
   * every character the line showed and inserted the line's new content at
   * the same place (an agent's block write, a paste over the line), whether
   * the line keeps its marker (the same type of line at that place) or a new
   * line takes its place. The caret keeps its offset in the line, counted in
   * what the editor showed (as `@lexical/yjs` keeps it), in the line now
   * there (the first, where several are), clamped to that line's end. Null
   * for any other caret: one with a character of its line kept is mapped by
   * identity, and one whose line was emptied, or removed with no line put
   * at its place, as before (see $resolvePosition and $nearestLinePoint).
   *
   * Invariant: the caret maps by offset only when the transaction left none
   * of what its line showed and put content there. Why: where a character
   * is kept, identity puts the caret after the same text; where none is,
   * identity can only fall back to the start of the new content, and the
   * person's next keys landed there, splitting the word they were typing.
   */
  private $replacedLineCaret(
    cursor: YCursor,
    tr: Transaction,
  ): {key: NodeKey; offset: number; type: 'text' | 'element'} | null {
    const rel = createRelativePositionFromJSON(cursor.anchor);
    const focus = createRelativePositionFromJSON(cursor.focus);
    if (
      rel.item === null ||
      focus.item === null ||
      rel.item.client !== focus.item.client ||
      rel.item.clock !== focus.item.clock ||
      rel.assoc !== focus.assoc ||
      this.state.hidden !== null
    ) {
      return null;
    }
    const store = this._doc.store;
    if (store.getClock(rel.item.client) <= rel.item.clock) {
      return null;
    }
    const found = store.getItem(rel.item);
    if (
      !(found instanceof Item) ||
      !found.deleted ||
      !tr.deleteSet.hasId(found.id)
    ) {
      return null;
    }
    const cs = this.state.containers.get(found.parent as YNode);
    if (cs === undefined || cs.kind !== 'b') {
      return null;
    }
    // What the editor showed before the transaction: content the
    // transaction did not insert, live or deleted by it (format items it
    // left, which bounded the line's old runs, show nothing).
    const inserted = (it: Item) => tr.insertSet.hasId(it.id);
    const wasShown = (it: Item) =>
      !inserted(it) && (!it.deleted || tr.deleteSet.hasId(it.id));
    // What the transaction put there: the first line end it inserted, in
    // document order, and whether it inserted content.
    const putEnd = (it: Item) => inserted(it) && !it.deleted && isEndItem(it);
    const putContent = (it: Item) =>
      inserted(it) && !it.deleted && it.countable && !isEndItem(it);
    let first: Item | null = null;
    let put = false;
    let offset = 0;
    let end: Item | null = null;
    if (isEndItem(found)) {
      // The marker of an empty line.
      end = found;
    } else {
      offset =
        rel.item.clock -
        found.id.clock +
        (rel.assoc < 0 && found.countable ? 1 : 0);
    }
    // Back to the end of the line before, as the editor showed it, which
    // the transaction kept (else it changed more than this line's place):
    // no character of the caret's line there is left, and each counts in
    // the caret's offset.
    for (let p = found.left; p !== null; p = p.left) {
      if (putEnd(p)) {
        first = p;
      }
      put = put || putContent(p);
      if (!wasShown(p) || !p.countable) {
        continue;
      }
      if (isEndItem(p)) {
        if (p.deleted) {
          return null;
        }
        break;
      }
      if (!p.deleted) {
        return null;
      }
      if (end === null && p.countable) {
        offset += p.length;
      }
    }
    // On to the line's end, and, where the transaction deleted it, past it
    // to what the editor showed next.
    for (let p = found.right; p !== null; p = p.right) {
      if (end !== null && !end.deleted) {
        break;
      }
      if (first === null && putEnd(p)) {
        first = p;
      }
      put = put || putContent(p);
      if (!wasShown(p) || !p.countable) {
        continue;
      }
      if (end !== null) {
        break;
      }
      if (isEndItem(p)) {
        end = p;
      } else if (!p.deleted) {
        return null;
      }
    }
    if (end === null || nameOf(end) !== MARKER) {
      return null;
    }
    // The line now there: the first one the transaction inserted, else the
    // caret's own line where it kept its marker and got new content.
    const target: Item | null =
      first !== null ? first : !end.deleted && put ? end : null;
    if (target === null || nameOf(target) !== MARKER) {
      return null;
    }
    const unit = this.state.unitByEnd.get(target);
    const line =
      unit === undefined || unit.key === null || unit.kind !== 'line'
        ? null
        : $getNodeByKey(unit.key);
    return $isElementNode(line) && line.isAttached()
      ? $pointAtAtom(line, offset, this.isShownRun)
      : null;
  }

  private $relativePosition(
    point: PointType,
    preferLeft: boolean,
    state = this.state,
  ): unknown {
    const node = point.getNode();
    // Find the line (or inline container) and the atom offset within it.
    let offset = 0;
    let owner: ElementNode | null = null;
    let target: LexicalNode = node;
    if ($isTextNode(node)) {
      offset = point.offset;
    } else if ($isElementNode(node)) {
      const child = node.getChildAtIndex(point.offset);
      if (child === null) {
        // At the end of an element: the end of a line, or of the content of
        // a container or wrapper whose last child is the target.
        const last = node.getLastChild();
        if (last === null) {
          // An empty line: at its marker, which is also where a point at the
          // end of a line with text can be stored, so a caret or a range's
          // end edge (preferLeft) is recorded as one in an empty line (see
          // emptyLinePositions). A range's start edge is not: moved before
          // what a collaborator types into the line, it would grow the range
          // over their text.
          const unit = state.unitByKey.get(node.getKey());
          if (unit === undefined || unit.end === null) {
            return null;
          }
          const json = relativePositionToJSON(
            new RelativePosition(null, null, unit.end.id, 0),
          );
          if (preferLeft) {
            emptyLinePositions.add(json);
          }
          return json;
        }
        target = last;
        offset = $atomSize(last);
      } else {
        target = child;
      }
      preferLeft = false;
    }
    const parent = $ownerOf(target);
    if (parent === null) {
      return null;
    }
    owner = parent;
    offset += $atomsBefore(parent, target);
    const unit = state.unitByKey.get(owner.getKey());
    // A line without a marker (see Unit) ends where its container does, or
    // at the block node after it.
    const implicit = unit !== undefined && unit.kind === 'implicit';
    let start: Item | null;
    if (unit !== undefined && unit.end !== null) {
      const left = prevLiveEnd(unit.end, state.hidden);
      start = left === null ? unit.cs.y._start : left.right;
    } else if (unit !== undefined && implicit) {
      // Its content starts right after the unit before it, the end of the
      // nearest line before it that is still shown.
      const units = unit.cs.units;
      const idx = units.indexOf(unit);
      let left = idx > 0 ? units[idx - 1].end : null;
      while (left !== null && !isShownEnd(left, state.hidden)) {
        left = prevLiveEnd(left, state.hidden);
      }
      start = left === null ? unit.cs.y._start : left.right;
    } else {
      const cs = state.csByKey.get(owner.getKey());
      if (cs === undefined || cs.kind !== 'i') {
        return null;
      }
      start = cs.y._start;
    }
    const at = (it: Item, d: number, assoc: number) =>
      relativePositionToJSON(
        new RelativePosition(
          null,
          null,
          {client: it.id.client, clock: it.id.clock + d} as Item['id'],
          assoc,
        ),
      );
    // Offsets count what the editor shows (not hidden remote content).
    const hidden = state.hidden;
    const unitAt = (it: Item, shown: number) =>
      hidden === null ? shown : hidden.unitAt(it, shown);
    let lastLive: Item | null = null;
    let lastLen = 0;
    for (let it = start; it !== null; it = it.right) {
      const len = shownLength(it, hidden);
      if (len === 0) {
        if (isShownEnd(it, hidden)) {
          break;
        }
        continue;
      }
      if (offset < len) {
        if (preferLeft && offset > 0) {
          return at(it, unitAt(it, offset - 1), -1);
        }
        if (preferLeft && offset === 0 && lastLive !== null) {
          return at(lastLive, unitAt(lastLive, lastLen - 1), -1);
        }
        return at(it, unitAt(it, offset), 0);
      }
      offset -= len;
      lastLive = it;
      lastLen = len;
      if (isShownEnd(it, hidden)) {
        return null;
      }
    }
    // At the end of a line without a marker that ends its container: after
    // its last character.
    return implicit && offset === 0 && lastLive !== null
      ? at(lastLive, unitAt(lastLive, lastLen - 1), -1)
      : null;
  }

  /**
   * See $resolvePosition: the nearest text position to a position in a
   * block container whose line is gone. The end of the nearest line before
   * it in the container, else the start of the nearest one after; where the
   * container has no other line, the nearest line inside a block node next
   * to it (the end of a table's last cell). Never a point on a block node
   * itself (a table, a list, a box), where typing is dropped and Backspace
   * deletes structure. No line is created: with none, there is no point.
   */
  private $nearestLinePoint(
    item: Item,
  ): {key: NodeKey; offset: number; type: 'text' | 'element'} | null {
    const state = this.state;
    const shown = (key: NodeKey): LexicalNode | null => {
      const node = $getNodeByKey(key);
      return node !== null && node.isAttached() ? node : null;
    };
    // The last (or first) line in a stored block node, depth first.
    const lineIn = (
      y: YNode,
      last: boolean,
      depth: number,
    ): LexicalNode | null => {
      const cs = state.containers.get(y);
      if (cs === undefined || depth > 64) {
        return null;
      }
      if (cs.kind === 'i') {
        return shown(cs.key);
      }
      const units = last ? [...cs.units].reverse() : cs.units;
      for (const u of units) {
        const found =
          u.key === null
            ? null
            : u.kind === 'line' || u.kind === 'implicit'
              ? shown(u.key)
              : u.kind === 'node' && u.end !== null && !u.end.deleted
                ? lineIn(typeOf(u.end), last, depth + 1)
                : null;
        if (found !== null) {
          return found;
        }
      }
      return null;
    };
    const lineAt = (
      it: Item,
      last: boolean,
      inside: boolean,
    ): LexicalNode | null => {
      if (!isShownEnd(it, state.hidden)) {
        return null;
      }
      const unit = state.unitByEnd.get(it);
      if (unit === undefined || unit.key === null) {
        return null;
      }
      return unit.kind === 'line'
        ? shown(unit.key)
        : unit.kind === 'node' && inside
          ? lineIn(typeOf(it), last, 0)
          : null;
    };
    for (const inside of [false, true]) {
      for (let it = item.left; it !== null; it = it.left) {
        const line = lineAt(it, true, inside);
        if (line !== null) {
          return $lineEndPoint(line, true);
        }
      }
      for (let it: Item | null = item; it !== null; it = it.right) {
        const line = lineAt(it, false, inside);
        if (line !== null) {
          return $lineEndPoint(line, false);
        }
      }
    }
    return null;
  }

  /**
   * The point `diff` units into `item` (null: the end), in the line whose
   * content starts at `start` and whose node is `key` (see $resolvePosition).
   */
  private $pointInLine(
    key: NodeKey,
    start: Item | null,
    item: Item | null,
    diff: number,
  ): {key: NodeKey; offset: number; type: 'text' | 'element'} | null {
    const hidden = this.state.hidden;
    const liveEnd = (x: Item) => isShownEnd(x, hidden);
    let offset = 0;
    let it = start;
    for (; it !== null && it !== item && !liveEnd(it); it = it.right) {
      offset += shownLength(it, hidden);
    }
    if (it === item && item !== null && !liveEnd(item)) {
      offset += hidden === null ? diff : hidden.shownBefore(item, diff);
    }
    const owner = $getNodeByKey(key);
    return $isElementNode(owner)
      ? $pointAtAtom(owner, offset, this.isShownRun)
      : null;
  }

  /**
   * Whether a node is a paragraph a read made around a run of inline content
   * in a shadow root (see Reader's $inShadowRoot): it is stored nowhere, and
   * the run's characters are the line's own, so a point in them resolves
   * into it (see $pointAtAtom).
   */
  private readonly isShownRun = (node: LexicalNode): boolean => {
    if (
      !$isElementNode(node) ||
      node.isInline() ||
      this.state.yByKey.has(node.getKey())
    ) {
      return false;
    }
    const parent = node.getParent();
    return parent !== null && parent.isShadowRoot();
  };

  private $resolvePosition(
    json: unknown,
  ): {key: NodeKey; offset: number; type: 'text' | 'element'} | null {
    const rel = createRelativePositionFromJSON(json);
    if (rel.item === null) {
      return null;
    }
    const store = this._doc.store;
    if (store.getClock(rel.item.client) <= rel.item.clock) {
      return null;
    }
    let found = store.getItem(rel.item);
    if (!(found instanceof Item)) {
      return null;
    }
    let diff = rel.item.clock - found.id.clock;
    // A character an undo or redo restored: the copy that restored it (the
    // deleted original points to it).
    while (found.deleted && found.redone !== null) {
      const next = createID(found.redone.client, found.redone.clock + diff);
      if (store.getClock(next.client) <= next.clock) {
        break;
      }
      const copy = store.getItem(next);
      if (!(copy instanceof Item)) {
        break;
      }
      diff = next.clock - copy.id.clock;
      found = copy;
    }
    let item: Item | null = found;
    const hidden = this.state.hidden;
    const marked = isShownEnd(found, hidden)
      ? this.state.unitByEnd.get(found)
      : undefined;
    if (
      marked !== undefined &&
      marked.kind === 'line' &&
      emptyLinePositions.has(json as object)
    ) {
      // Captured in an empty line (see emptyLinePositions): the start of
      // that line, before what was typed into it since.
      const left = prevLiveEnd(found, hidden);
      item = left === null ? (found.parent as YNode)._start : left.right;
      diff = 0;
    } else if (rel.assoc < 0) {
      // After a character: before the next live one.
      if (!found.deleted && found.countable && diff + 1 < found.length) {
        diff += 1;
      } else {
        let p: Item | null = found;
        if (found.deleted || !found.countable) {
          // The character is gone: after the nearest live one on its left.
          p = found.left;
          while (p !== null && (p.deleted || !p.countable)) {
            p = p.left;
          }
        }
        item = p === null ? (found.parent as YNode)._start : p.right;
        diff = 0;
      }
    }
    while (item !== null && shownLength(item, hidden) === 0) {
      item = item.right;
      diff = 0;
    }
    if (item === null) {
      const cs = this.state.containers.get(found.parent as YNode);
      // After the last character of a line without a marker that ends its
      // block container: the end of that line.
      const implicit =
        found.deleted || cs === undefined || cs.kind !== 'b'
          ? null
          : implicitUnitAt(cs, undefined);
      if (implicit !== null) {
        const left = prevLiveEnd(found, hidden);
        return this.$pointInLine(
          implicit.key!,
          left === null ? (found.parent as YNode)._start : left.right,
          null,
          0,
        );
      }
      // The line it was in is gone and was the last of its block container
      // (after a list or a table): the nearest line before it.
      return found.deleted && cs !== undefined && cs.kind === 'b'
        ? this.$nearestLinePoint(found)
        : null;
    }
    // Walk to the unit end; count atoms from the unit start.
    let end: Item | null = item;
    while (end !== null && !isShownEnd(end, hidden)) {
      end = end.right;
    }
    const parentY = item.parent as YNode;
    const unit = end === null ? undefined : this.state.unitByEnd.get(end);
    let ownerKey: NodeKey | undefined;
    let start: Item | null;
    if (unit !== undefined && unit.key !== null && unit.kind === 'line') {
      ownerKey = unit.key;
      const left = prevLiveEnd(end, hidden);
      start = left === null ? parentY._start : left.right;
    } else {
      const cs = this.state.containers.get(parentY);
      // In a line without a marker (text concurrent edits left before a
      // block node, or at the end of its container): that line, as every
      // reader shows it.
      const implicit =
        cs !== undefined && cs.kind === 'b' ? implicitUnitAt(cs, unit) : null;
      if (implicit !== null) {
        const left =
          end === null ? prevLiveEnd(item, hidden) : prevLiveEnd(end, hidden);
        return this.$pointInLine(
          implicit.key!,
          left === null ? parentY._start : left.right,
          item,
          diff,
        );
      }
      if (cs === undefined || cs.kind !== 'i') {
        // The line it was in is gone, and a block node follows: the end of
        // the nearest line before it in its container, else the start of
        // the nearest one after, never a point in another block's
        // structure. (A live position next to a block node keeps the
        // selection as it is.)
        return found.deleted ? this.$nearestLinePoint(item) : null;
      }
      ownerKey = cs.key;
      start = parentY._start;
    }
    let offset = 0;
    for (let it = start; it !== null && it !== item; it = it.right) {
      offset += shownLength(it, hidden);
    }
    offset +=
      item === end
        ? 0
        : hidden === null
          ? diff
          : hidden.shownBefore(item, diff);
    const owner = $getNodeByKey(ownerKey);
    if (!$isElementNode(owner)) {
      return null;
    }
    return $pointAtAtom(owner, offset, this.isShownRun);
  }
}

/**
 * The carets and range end edges this binding captured in an empty line
 * (see $relativePosition): at the line's marker, with the right association.
 * Such a position resolves to the start of that line, not to the marker,
 * so a caret that was after no text in its line stays after none when a
 * collaborator types there (as a caret after text stays after that text).
 * Why recorded, not encoded: a point at the end of a line with text (an
 * element point, or the start of a range) is stored at the marker too and
 * must stay at the line's end; the stored form of both is the same, and
 * cursor JSON from elsewhere keeps its meaning.
 */
const emptyLinePositions = new WeakSet<object>();

/**
 * The line without a marker that ends at the node unit `unit` (undefined: at
 * the end of the container), if one does and it is shown.
 */
function implicitUnitAt(cs: CS, unit: Unit | undefined): Unit | null {
  if (unit !== undefined && unit.kind !== 'node') {
    return null;
  }
  const units = cs.units;
  const i = unit === undefined ? units.length : units.indexOf(unit);
  const prev = i > 0 ? units[i - 1] : undefined;
  return prev !== undefined && prev.kind === 'implicit' && prev.key !== null
    ? prev
    : null;
}

function $lineEndPoint(
  line: LexicalNode,
  atEnd: boolean,
): {key: NodeKey; offset: number; type: 'text' | 'element'} | null {
  if (!$isElementNode(line)) {
    return null;
  }
  const text = atEnd ? line.getLastDescendant() : line.getFirstDescendant();
  if ($isTextNode(text)) {
    return {
      key: text.getKey(),
      offset: atEnd ? text.getTextContentSize() : 0,
      type: 'text',
    };
  }
  return {
    key: line.getKey(),
    offset: atEnd ? line.getChildrenSize() : 0,
    type: 'element',
  };
}

function $atomSize(node: LexicalNode): number {
  if ($isTextNode(node)) {
    return node.getTextContentSize();
  }
  if ($isWrapper(node)) {
    return (node as ElementNode)
      .getChildren()
      .reduce((n, c) => n + $atomSize(c), 0);
  }
  return 1;
}

/** No transforms (see YBinding#gainedTransform). */
const NO_TRANSFORMS: ReadonlySet<Transform<LexicalNode>> = new Set();

/** The keys of an element's subtree, in order (see $refreshGroups). */
function $shapeOf(node: ElementNode): string {
  let out = '';
  const walk = (n: ElementNode) => {
    for (let c = n.getFirstChild(); c !== null; c = c.getNextSibling()) {
      out += c.getKey() + ',';
      if ($isElementNode(c)) {
        out += '(';
        walk(c);
        out += ')';
      }
    }
  };
  walk(node);
  return out;
}

/**
 * Whether the editor shows a caret (a collapsed range selection). Called
 * before a read changes the nodes the selection is in (see
 * $restoreSelection).
 */
function $showsCaret(): boolean {
  const selection = $getSelection();
  return $isRangeSelection(selection) && selection.isCollapsed();
}

/**
 * Keep the selection's points inside their nodes after a remote read.
 * Invariant: no selection names a node a read removed: a selection of
 * another kind (a table's cells, a node selection) that does is dropped.
 * Why: Lexical keeps such a selection as it is, and every reader of it (a
 * table's own selection handler) would throw.
 */
function $clampSelection(): void {
  const selection = $getSelection();
  if (selection === null) {
    return;
  }
  if (!$isRangeSelection(selection)) {
    const {anchor, focus} = selection as {
      anchor?: PointType;
      focus?: PointType;
    };
    let lost = false;
    try {
      for (const point of [anchor, focus]) {
        if (point !== undefined) {
          const node = $getNodeByKey(point.key);
          lost = lost || node === null || !node.isAttached();
        }
      }
      lost = lost || selection.getNodes().some(node => !node.isAttached());
    } catch (_error) {
      // A selection whose nodes cannot be found.
      lost = true;
    }
    if (lost) {
      $setSelection(null);
    }
    return;
  }
  for (const point of [selection.anchor, selection.focus]) {
    const node = $getNodeByKey(point.key);
    if (node === null || !node.isAttached()) {
      $setSelection(null);
      return;
    }
    const size = $isTextNode(node)
      ? node.getTextContentSize()
      : $isElementNode(node)
        ? node.getChildrenSize()
        : 0;
    if (point.offset > size) {
      point.set(point.key, size, point.type);
    }
  }
}

/** The line or inline container whose content holds `node`. */
function $ownerOf(node: LexicalNode): ElementNode | null {
  let parent = node.getParent();
  while (parent !== null && $isWrapper(parent)) {
    parent = parent.getParent();
  }
  return parent;
}

/** A line's stored atoms and the offsets of its wrappers (see YBinding). */
type StoredLine = {
  atoms: [number, number, Attrs][];
  offsets: Map<NodeKey, number>;
};

/** The atom offset of every wrapper in the content of `owner`, in one pass. */
function $wrapperOffsets(owner: ElementNode): Map<NodeKey, number> {
  const out = new Map<NodeKey, number>();
  let n = 0;
  const visit = (el: ElementNode) => {
    for (const c of el.getChildren()) {
      if ($isWrapper(c)) {
        out.set(c.getKey(), n);
        visit(c as ElementNode);
      } else {
        n += $atomSize(c);
      }
    }
  };
  visit(owner);
  return out;
}

function $atomsBefore(owner: ElementNode, target: LexicalNode): number {
  let n = 0;
  const visit = (el: ElementNode): boolean => {
    for (const c of el.getChildren()) {
      if (c.is(target)) {
        return true;
      }
      if ($isWrapper(c)) {
        if (visit(c as ElementNode)) {
          return true;
        }
      } else {
        n += $atomSize(c);
      }
    }
    return false;
  };
  visit(owner);
  return n;
}

/**
 * The point `offset` atoms into the content of `owner` (a line or an inline
 * container). A wrapper (a link) holds atoms of its owner, and so does a
 * paragraph a read made around a run of inline content in a shadow root
 * (`isShownRun`): a point in that run goes into the paragraph, never onto
 * the quote after its blocks, where the next keystroke would start a new
 * paragraph.
 */
function $pointAtAtom(
  owner: ElementNode,
  offset: number,
  isShownRun: (node: LexicalNode) => boolean,
): {key: NodeKey; offset: number; type: 'text' | 'element'} {
  let remaining = offset;
  let lastText = null as LexicalNode | null;
  const visit = (
    el: ElementNode,
  ): {key: NodeKey; offset: number; type: 'text' | 'element'} | null => {
    const children = el.getChildren();
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if ($isWrapper(c) || isShownRun(c)) {
        const r = visit(c as ElementNode);
        if (r !== null) {
          return r;
        }
        continue;
      }
      const size = $atomSize(c);
      if ($isTextNode(c)) {
        lastText = c;
        if (remaining <= size) {
          return {key: c.getKey(), offset: remaining, type: 'text'};
        }
      } else if (remaining === 0) {
        return {key: el.getKey(), offset: i, type: 'element'};
      }
      remaining -= size;
    }
    return null;
  };
  const found = visit(owner);
  if (found !== null) {
    return found;
  }
  if (lastText !== null) {
    const t = lastText as LexicalNode;
    return {key: t.getKey(), offset: $atomSize(t), type: 'text'};
  }
  return {
    key: owner.getKey(),
    offset: owner.getChildrenSize(),
    type: 'element',
  };
}

/**
 * The nodes of a state set whole: `setEditorState` with a state the editor
 * did not parse marks only the root dirty, while its nodes replace the
 * previous ones. Every node that differs from the previous state is then
 * part of the change (an ordinary update marks every node it writes
 * dirty), however deep: a descendant differs while its ancestors stay the
 * same objects when a state saved earlier is set again. Returns the dirty
 * elements and leaves with those nodes added, or null when the commit
 * changed nothing it did not mark dirty.
 *
 * Invariant: a commit that replaced nothing costs what Lexical itself
 * copies of its node map in that commit, not the length of the document:
 * only the keys at which the two node maps can differ are looked at (see
 * changedKeys), and the whole map is walked only when a node there differs
 * unmarked (a state set whole), or when the two maps share no snapshot (a
 * small document's map, which Lexical copies whole in every commit, and the
 * commit that makes a large one copy-on-write or compacts it). The nodes
 * found are those a walk of the whole map finds, in its order. Why: an
 * editor with a root element replaces its root in every commit that changes
 * text (the reconciler caches the root's text on it), so no test of the
 * root can tell a keystroke from a state set whole, and every keystroke
 * walked the whole map twice.
 */
export function $replacedNodes(
  dirtyElements: Map<NodeKey, boolean>,
  dirtyLeaves: Set<NodeKey>,
  prevEditorState: EditorState,
  editorState: EditorState,
): [Map<NodeKey, boolean>, Set<NodeKey>] | null {
  const prevMap = prevEditorState._nodeMap;
  const nodeMap = editorState._nodeMap;
  if (nodeMap.get('root') === undefined) {
    return null;
  }
  const candidates = changedKeys(prevMap, nodeMap);
  if (candidates !== null) {
    let replaced = false;
    for (const keys of candidates) {
      for (const key of keys) {
        const node = nodeMap.get(key);
        if (
          node !== undefined &&
          prevMap.get(key) !== node &&
          !dirtyElements.has(key) &&
          !dirtyLeaves.has(key)
        ) {
          replaced = true;
          break;
        }
      }
      if (replaced) {
        break;
      }
    }
    if (!replaced) {
      return null;
    }
  }
  let elements: Map<NodeKey, boolean> | null = null;
  let leaves: Set<NodeKey> | null = null;
  for (const [key, node] of nodeMap) {
    if (
      prevMap.get(key) !== node &&
      !dirtyElements.has(key) &&
      !dirtyLeaves.has(key)
    ) {
      if (elements === null || leaves === null) {
        elements = new Map(dirtyElements);
        leaves = new Set(dirtyLeaves);
      }
      if ($isElementNode(node)) {
        elements.set(key, true);
      } else {
        leaves.add(key);
      }
    }
  }
  return elements === null || leaves === null ? null : [elements, leaves];
}

/**
 * The keys at which two node maps can hold different nodes, or null when
 * only a comparison of the whole maps tells. Lexical's node map of a large
 * document is copy-on-write (its GenMap): a map made from another shares
 * that map's snapshot of entries (`_old`, which is never written once
 * made), and keeps each entry written since the snapshot, a deletion
 * included, in a map of its own (`_nursery`). Two maps with one snapshot
 * hold the same node at every key that neither has written since.
 */
function changedKeys(
  prev: ReadonlyMap<NodeKey, LexicalNode>,
  next: ReadonlyMap<NodeKey, LexicalNode>,
): Iterable<NodeKey>[] | null {
  type CopyOnWrite = {_old?: unknown; _nursery?: Map<NodeKey, unknown>};
  const a = prev as CopyOnWrite;
  const b = next as CopyOnWrite;
  if (a._old === undefined || a._old !== b._old) {
    return null;
  }
  const keys: Iterable<NodeKey>[] = [];
  if (a._nursery !== undefined) {
    keys.push(a._nursery.keys());
  }
  if (b._nursery !== undefined) {
    keys.push(b._nursery.keys());
  }
  return keys;
}

/**
 * A client id derived from content (the initial content's, see
 * YBinding#seedUpdate): a hash of `seed` in the document's client id range
 * (see {@link ClientIDRange}), 53 bits under `'uint53'` (Yjs 14's own range)
 * and 32 bits under `'uint32'`. Invariant: equal seeds give equal ids. Why:
 * clients writing the same items from the same inputs write them once.
 * Different seeds share an id only with the probability of a collision in
 * that range (a shared id with different items would diverge), the same odds
 * as two random client ids; so every client of a document must use the same
 * range.
 */
/** `bytes` as a string of one char per byte (see initClientID). */
function byteString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + 4096)),
    );
  }
  return out;
}

/**
 * The shared type item `client`:`clock` of `doc` holds (the copy of a root
 * inside another shared type, see YBinding#seedUpdate).
 */
function storedTypeOf(doc: Doc, client: number, clock: number): YNode {
  const structs = doc.store.clients.get(client);
  const item =
    structs === undefined ? undefined : structs[findIndexSS(structs, clock)];
  invariant(
    item instanceof Item && item.content instanceof ContentType,
    '@lexical/y: the copy of the document does not hold the root',
  );
  return item.content.type as YNode;
}

function initClientID(seed: string, range: ClientIDRange = 'uint53'): number {
  // cyrb53 (public domain).
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const id =
    range === 'uint53'
      ? 0x100000000 * (h2 & 0x1fffff) + (h1 >>> 0)
      : (h1 ^ h2) >>> 0;
  return id === 0 ? 1 : id;
}

/**
 * The ranges of units of block container `cs` (first and last index, in
 * order) that the follow-up check reads (see YBinding#$checkFollowUp): the
 * units whose top-level children are in `keys`, widened as a region read
 * is (see Reader#$readRegion): over every unit of the same top-level child
 * (a list), over a line without a marker or a deleted end to the units
 * around it. Null when no unit holds one of `keys`: the whole container is
 * read.
 */
function followUpRanges(
  state: State,
  cs: CS,
  keys: ReadonlySet<NodeKey>,
): [number, number][] | null {
  const units = cs.units;
  const len = units.length;
  const sameTop = (a: number, b: number) =>
    units[a].first !== null && units[a].first === units[b].first;
  const open = (k: number) => units[k].end === null || units[k].end!.deleted;
  // A line's unit is found by its key (a pointer scan of the units); the
  // units of another top-level child (a list, a block node) by a scan of
  // their keys, only when there is one.
  const at: number[] = [];
  let scan = false;
  for (const key of keys) {
    const unit = state.unitByKey.get(key);
    if (unit !== undefined && unit.cs === cs && unit.first === key) {
      const k = units.indexOf(unit);
      if (k >= 0) {
        at.push(k);
        continue;
      }
    }
    scan = true;
  }
  if (scan) {
    for (let k = 0; k < len; k++) {
      const u = units[k];
      if (
        (u.first !== null && keys.has(u.first)) ||
        (u.last !== null && keys.has(u.last))
      ) {
        at.push(k);
      }
    }
  }
  const found: [number, number][] = [];
  for (const k of at) {
    let i = k;
    let j = k;
    for (;;) {
      let moved = false;
      while (j < len - 1 && (open(j) || sameTop(j, j + 1))) {
        j++;
        moved = true;
      }
      while (i > 0 && (open(i - 1) || sameTop(i - 1, i))) {
        i--;
        moved = true;
      }
      if (!moved) {
        break;
      }
    }
    found.push([i, j]);
  }
  if (found.length === 0) {
    return null;
  }
  found.sort((a, b) => a[0] - b[0]);
  const ranges: [number, number][] = [];
  for (const [i, j] of found) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && i <= last[1] + 1) {
      last[1] = Math.max(last[1], j);
    } else {
      ranges.push([i, j]);
    }
  }
  return ranges;
}

/**
 * Containers of up to this many units (lines and nodes) get the
 * whole-container self-check after every structural change; bigger ones are
 * sampled (see YBindingOptions.selfCheck).
 */
const SELF_CHECK_FULL_UNITS = 256;

function sampleWholeContainer(cs: CS): boolean {
  const n = cs.units.length;
  return (
    n <= SELF_CHECK_FULL_UNITS || Math.random() < SELF_CHECK_FULL_UNITS / n
  );
}

/**
 * Undo must not delete a container a peer has put content in (its content
 * would go with it): a container holding live content of a client other
 * than the one that created it. The clients of each subtree are computed
 * once per undo (`cache`).
 */
function isNonEmptyContainer(
  item: Item,
  cache: WeakMap<YNode, Set<number>>,
): boolean {
  if (!(item.content instanceof ContentType)) {
    return false;
  }
  const name = nameOf(item);
  if (name === MARKER || name === RUN_END) {
    return false;
  }
  const clientsOf = (type: YNode): Set<number> => {
    let clients = cache.get(type);
    if (clients === undefined) {
      clients = new Set();
      for (let it = type._start; it !== null; it = it.right) {
        if (it.deleted) {
          continue;
        }
        if (it.countable) {
          clients.add(it.id.client);
        }
        if (it.content instanceof ContentType) {
          for (const c of clientsOf(it.content.type)) {
            clients.add(c);
          }
        }
      }
      // Its named slots (see Slots.ts) are its content too.
      for (const it of type._map.values()) {
        if (!it.deleted && it.content instanceof ContentType) {
          clients.add(it.id.client);
          for (const c of clientsOf(it.content.type)) {
            clients.add(c);
          }
        }
      }
      cache.set(type, clients);
    }
    return clients;
  };
  for (const c of clientsOf(item.content.type)) {
    if (c !== item.id.client) {
      return true;
    }
  }
  return false;
}

/**
 * What the cursor leaves out of a selection (see initializeInner): a range's
 * typing format and style, or the nodes a node selection holds, by key
 * before the initial write (`keys`) and by the Yjs items that store them
 * once written (`items`, see YBinding#$selectedAnchors).
 */
type SelectionState =
  | {kind: 'range'; format: number; style: string}
  | {
      kind: 'node';
      keys: NodeKey[];
      items: SelectedAnchor[];
    };

/**
 * A selected node, by the Yjs identity it is stored or shown by (see
 * YBinding#$selectedAnchors): an item, or the relative position of a text
 * node's first character, and how many levels above the node that names
 * the selected node is; and the selected node's type.
 */
type SelectedAnchor =
  | {client: number; clock: number; type: string; up: number}
  | {position: unknown; type: string; up: number};

function $selectionState(): SelectionState | null {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    return {format: selection.format, kind: 'range', style: selection.style};
  }
  if ($isNodeSelection(selection)) {
    return {
      items: [],
      keys: selection.getNodes().map(node => node.getKey()),
      kind: 'node',
    };
  }
  return null;
}

/** The first leaf in `node` (`node` itself if it is a leaf). */
function $firstLeaf(node: LexicalNode | null): LexicalNode | null {
  let n = node;
  while ($isElementNode(n)) {
    n = n.getFirstChild();
  }
  return n;
}

/**
 * Put back on the editor what `kept` holds (see SelectionState), after the
 * read that follows the initial write: a node selection holds the nodes the
 * read shows for the Yjs identities of the selected ones (see
 * SelectedAnchor), `resolve` giving the point a relative position names.
 *
 * Invariant: a node selection is put back by the Yjs identity of its nodes,
 * never by position; a node with no identity, or that the read does not
 * show with its type, is left out (a text node whose first character the
 * read shows inside another text node too). Why: the read shows the content
 * as stored (a line feed becomes a line break node, which moves later nodes
 * along), so a position can name another node, which a Delete would then
 * remove; and a selected list or text node, which no item stores, was
 * dropped.
 */
function $restoreSelectionState(
  state: State,
  kept: SelectionState,
  resolve: (
    json: unknown,
  ) => {key: NodeKey; offset: number; type: 'text' | 'element'} | null,
): void {
  if (kept.kind === 'range') {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      selection.format = kept.format;
      selection.style = kept.style;
    }
    return;
  }
  const store = state.doc.store;
  const selection = $createNodeSelection();
  for (const anchor of kept.items) {
    if ('position' in anchor) {
      // The text node that starts at its first character: the point before
      // that character can be the end of the text before it (the same
      // place), or name its position in its parent.
      const point = resolve(anchor.position);
      let node: LexicalNode | null =
        point === null ? null : $getNodeByKey(point.key);
      if (point !== null && node !== null) {
        if (point.type === 'element') {
          node = $isElementNode(node)
            ? $firstLeaf(node.getChildAtIndex(point.offset))
            : null;
        } else if (point.offset > 0) {
          let at: LexicalNode | null =
            point.offset === node.getTextContentSize() ? node : null;
          while (at !== null && at.getNextSibling() === null) {
            const parent: ElementNode | null = at.getParent();
            at = parent !== null && parent.isInline() ? parent : null;
          }
          node = at === null ? null : $firstLeaf(at.getNextSibling());
        }
      }
      if (!$isTextNode(node)) {
        continue;
      }
      for (let i = 0; i < anchor.up && node !== null; i++) {
        node = node.getParent();
      }
      if (
        node !== null &&
        node.isAttached() &&
        node.getType() === anchor.type
      ) {
        selection.add(node.getKey());
      }
      continue;
    }
    const {client, clock, type, up} = anchor;
    if (store.getClock(client) <= clock) {
      continue;
    }
    const item = store.getItem(createID(client, clock));
    if (!(item instanceof Item) || item.deleted || item.id.clock !== clock) {
      continue;
    }
    const unit = state.unitByEnd.get(item);
    const key =
      unit !== undefined && unit.key !== null
        ? unit.key
        : item.content instanceof ContentType
          ? state.keyByY.get(item.content.type as YNode)
          : undefined;
    let node: LexicalNode | null =
      key === undefined ? null : $getNodeByKey(key);
    for (let i = 0; i < up && node !== null; i++) {
      node = node.getParent();
    }
    if (node !== null && node.isAttached() && node.getType() === type) {
      selection.add(node.getKey());
    }
  }
  if (selection.getNodes().length > 0) {
    $setSelection(selection);
  }
}

/**
 * The microtask that ends a task for commitsAtOnce. Invariant: it keeps only
 * `task`. Why: a closure made in the update listener would keep the binding
 * and the payload, so a binding disposed in the same task (a headless call)
 * would be kept, with its document, until the caller yields.
 */
function endOfTask(task: {committed: boolean}): () => void {
  return () => {
    task.committed = false;
  };
}

/**
 * A node's NodeState as one record, as `$` holds it: its nested keys and
 * the keys its state configuration serializes flat (see $splitLineBreaks).
 */
function $stateRecordOf(
  node: LexicalNode,
): Record<string, unknown> | undefined {
  const state = node.__state;
  if (state === undefined) {
    return undefined;
  }
  const {$: nested, ...flat} = state.toJSON() as Record<string, unknown> & {
    $?: Record<string, unknown>;
  };
  const record = {...flat, ...(nested ?? {})};
  return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Split a text node holding line feeds into text and line break nodes, as
 * the document stores and every reader shows it (see YBinding#startInner),
 * whatever its mode or class. The parts are Lexical's splitText's: each
 * keeps the node's format, style and NodeState; the first is the node
 * itself (its class and mode, but a segmented node's is a new normal text
 * node), the others are normal text nodes. The author writes them so, and
 * every reader shows them so. Each line break gets the NodeState its line
 * feed had (a comment on just the line feed stays on it).
 */
function $splitLineBreaks(node: TextNode): void {
  const text = node.getTextContent();
  if (!text.includes('\n')) {
    return;
  }
  const offsets: number[] = [];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    offsets.push(i, i + 1);
  }
  // splitText takes its offsets as arguments, which are bounded in number
  // (see Arrays.ts): split in pieces, from the end, so that each piece's
  // offsets fall in the first part the previous piece left (the node
  // itself, or the normal text node that replaces a segmented one).
  let head = node;
  for (let end = offsets.length; end > 0; end -= ARGUMENTS_CHUNK) {
    const parts = head.splitText(
      ...offsets.slice(Math.max(0, end - ARGUMENTS_CHUNK), end),
    );
    head = parts[0];
    // The first part is split again by the next piece, if any.
    for (let i = end > ARGUMENTS_CHUNK ? 1 : 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.getTextContent() === '\n') {
        const br = $createLineBreakNode();
        // All of its NodeState, flat keys included (a custom text class's
        // flat StateConfig serializes at the top level, not under `$`).
        const st = $stateRecordOf(part);
        if (st !== undefined) {
          br.updateFromJSON({$: st} as Parameters<
            LineBreakNode['updateFromJSON']
          >[0]);
        }
        part.replace(br);
      }
    }
  }
}
