/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Hidden} from './Hidden';
import type {TextEditLog} from './TextEdits';

import {
  type BlockIdExtension,
  getPeerDependencyFromEditor,
  registerNodeStructure,
} from '@lexical/extension';
import invariant from '@lexical/internal/invariant';
import {
  applyUpdate,
  ContentFormat,
  ContentString,
  ContentType,
  createID,
  createRelativePositionFromJSON,
  type Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  findIndexSS,
  getItemCleanStart,
  type ID,
  type IdSet,
  Item,
  iterateStructsByIdSet,
  mergeIdSets,
  Node as YNode,
  RelativePosition,
  relativePositionToJSON,
  type Transaction,
  tryGc,
  UndoManager,
} from '@y/y';
import {
  $addUpdateTag,
  $cloneWithProperties,
  $createLineBreakNode,
  $createNodeSelection,
  $createPoint,
  $createRangeSelection,
  $flushSyncAfterUpdate,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotNames,
  $hasUpdateTag,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isRootNode,
  $isTextNode,
  $onUpdate,
  $removeSlot,
  $setCompositionKey,
  $setSelection,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_BEFORE_CRITICAL,
  DEFER_COMPOSITION_MERGE_TAG,
  type EditorState,
  ElementNode,
  getActiveElement,
  getTransformSetFromKlass,
  HISTORY_MERGE_TAG,
  INTERNAL_$normalizeNodeStructure,
  isCurrentlyReadOnlyMode,
  isDispatchingCommitListeners,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  LexicalWarning,
  type LineBreakNode,
  type NodeKey,
  type PointType,
  type RangeSelection,
  SELECTION_CHANGE_COMMAND,
  type SerializedEditorState,
  SKIP_COLLAB_TAG,
  SKIP_DOM_SELECTION_TAG,
  type SlotHostNode,
  TextNode,
  type Transform,
} from 'lexical';

import {ARGUMENTS_CHUNK, pushAll, spliceAll} from './Arrays';
import {$unsettledAfterWrite} from './BlockIds';
import {$caretOnMovingBoundary, $foreseesMove, composedMoved} from './Boundary';
import {type ClientIDRange, constrainClientID} from './ClientID';
import {
  BASE_LAYOUT_VERSION,
  DEFAULT_ROOT_NAME,
  EPOCH_KEY,
  IDENTITY_LAYOUT_VERSION,
  LEGACY_ROOTS,
  MIN_LAYOUT,
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
import {$heldDecision} from './HoldGuard';
import {
  attrsOf,
  covered,
  endsOf,
  finishSeedRuns,
  IdentityLayoutOrigin,
  installIdentity,
  isEndValue,
  noteBoundRoot,
  protectRecordAfter,
  pruneEnds,
  recordsIdentityLayout,
  repairPendingCopies,
  takePairingChanges,
  withSeeding,
  writeIdentityRecord,
  writesPairedRuns,
} from './Ident';
import {
  epochRecordIn,
  isGateKey,
  onYMigrationEpoch,
  readRequirements,
  requirementsIn,
  type RootAttrs,
  type YRequirements,
} from './Layouts';
import {type YLayoutUpgradeHandle} from './LayoutUpgrade';
import {collectOwned, isOwned, type OwnedRanges} from './Owned';
import {
  markBindingWrite,
  noteRawWrite,
  registerBindingOrigins,
} from './RawWrites';
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
  isMergeableText,
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
  attrsBeforeIn,
  Folder,
  frontierOf,
  HeldDeletionError,
  isGoneIn,
  isShownEndIn,
  prevLiveEnd,
  shownLengthIn,
  unitLeftEnd,
} from './Seen';
import {
  $checkWrite,
  $deepJSON,
  $followUpDifference,
  checkContainer,
} from './SelfCheck';
import {
  $readSlots,
  $unstorableSlotHosts,
  $wrapSlotShadowRootInline,
  SLOT_PREFIX,
} from './Slots';
import {
  type CS,
  isEndItem,
  nameOf,
  Roles,
  State,
  typeOf,
  type Unit,
} from './State';
import {emptyView, type Unread, type View} from './Unread';
import {
  NESTED_FALLBACK_WARNING,
  notesSince,
  RAW_YJS_WRITE_WARNING,
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
  type YEmittedWarningData,
  type YKnownWarningCode,
  type YRecoveredReadData,
  type YStorageMismatchData,
  type YUnsupportedConfigData,
  type YUnsupportedSchemaData,
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
 * The binding's UndoManager (YBinding#undoManager): a Yjs UndoManager whose
 * undo() and redo() write nothing, and return null, while the binding does
 * not admit writes (`admits`: its status and the root's layout record as it
 * is then, see YBinding#recordAdmits). A subclass rather than a wrapper:
 * the app keeps the same object, with its stacks, events and type, and code
 * that holds a reference to it from before a change of the record is gated
 * too.
 */
class BindingUndoManager extends UndoManager {
  constructor(
    scope: YNode,
    admits: () => boolean,
    options: ConstructorParameters<typeof UndoManager>[1],
  ) {
    super(scope, {
      ...options,
      // A refused undo's transaction (see gatedStep) is no one's step.
      captureTransaction: tr => !refusedHistory.has(tr),
    });
    undoAdmits.set(this, admits);
    undoSteps.set(this, {redo: () => super.redo(), undo: () => super.undo()});
  }
  undo(): ReturnType<UndoManager['undo']> {
    return gatedStep(this, true);
  }
  redo(): ReturnType<UndoManager['redo']> {
    return gatedStep(this, false);
  }
  /**
   * Yjs emits `stack-item-popped` when its undo's transaction returns;
   * inside gatedStep that transaction is joined to the wrapper's, which is
   * still open: the event is held and emitted once the wrapper's
   * transaction has ended (see gatedStep), as Yjs emits it.
   */
  emit(...args: Parameters<UndoManager['emit']>): void {
    const held = heldPops.get(this);
    if (held !== undefined && args[0] === 'stack-item-popped') {
      held.push(args);
      return;
    }
    super.emit(...args);
  }
}

/**
 * An undo or redo of `um` inside a transaction of its own (Yjs's undo joins
 * it), admitted inside it: after every `beforeTransaction` listener of the
 * document ran, any of which may change the layout record before anything
 * is written. Refused, it writes nothing and returns null.
 */
function gatedStep(
  um: BindingUndoManager,
  undo: boolean,
): ReturnType<UndoManager['undo']> {
  const admission = undoAdmits.get(um)!;
  if (!admission()) {
    return null;
  }
  let result: ReturnType<UndoManager['undo']> = null;
  // Restored, not cleared, afterwards: a step started from a listener of an
  // earlier one (whose capture is still running) leaves that one's flags.
  const {undoing, redoing, currStackItem} = um;
  // Where the step pushes its own item (see foldFollowUps).
  const opposite = () => (undo ? um.redoStack : um.undoStack);
  const base = opposite().length;
  const outerHeld = heldPops.get(um);
  const held: Parameters<UndoManager['emit']>[] = [];
  heldPops.set(um, held);
  try {
    um.doc.transact(tr => {
      if (!admission()) {
        refusedHistory.add(tr);
        return;
      }
      const steps = undoSteps.get(um)!;
      let threw = true;
      try {
        result = undo ? steps.undo() : steps.redo();
        threw = false;
      } finally {
        // Development builds: a step that wrote (it popped an item, or threw
        // part way) is the binding's own write, even when it joined an app's
        // transaction (see noteRawWrite). An empty stack writes nothing and
        // leaves the transaction to be judged by its origin.
        if (__DEV__ && (threw || result !== null)) {
          markBindingWrite(tr);
        }
        // Yjs resets these when its own (joined) transaction returns (or a
        // listener of its pop throws), but this one ends later: its capture
        // must still see an undo or a redo, and a step a listener of that
        // capture starts must still find this step under way (Yjs then pops
        // nothing), as with Yjs's own transaction.
        if (undo) {
          um.undoing = true;
        } else {
          um.redoing = true;
        }
        um.currStackItem = result;
      }
    }, um);
    // The transaction has ended (its capture included): the pop event now,
    // with the step's flags set as Yjs has them while it emits.
    if (outerHeld === undefined) {
      heldPops.delete(um);
    } else {
      heldPops.set(um, outerHeld);
    }
    // Before the pop event, whose listeners may throw.
    if (result !== null) {
      foldFollowUps(opposite(), base);
    }
    for (const args of held) {
      um.emit(...args);
    }
  } finally {
    if (result !== null) {
      foldFollowUps(opposite(), base);
    }
    if (outerHeld === undefined) {
      heldPops.delete(um);
    } else {
      heldPops.set(um, outerHeld);
    }
    um.undoing = undoing;
    um.redoing = redoing;
    um.currStackItem = currStackItem;
  }
  return result;
}

/**
 * Fold into `item`, the item an undo or redo pushed onto `stack` (at `base`),
 * the items pushed after it in reply to the step: what the binding wrote
 * reading it (the editor's own update of what it read), which Yjs captures
 * while it undoes or redoes and never merges into the last item then. Read
 * inside the step, that write is folded here (see gatedStep); read in an
 * update that commits after the step returns, in its commit (see stepFold).
 * Why: as items of their own, one redo after an undo redid only that write,
 * and the undone change stayed undone (#9816).
 */
function foldFollowUps(
  stack: UndoManager['undoStack'],
  base: number,
  item: UndoManager['undoStack'][number] | undefined = stack[base],
): void {
  if (item === undefined || stack.length <= base + 1 || stack[base] !== item) {
    return;
  }
  for (const later of stack.splice(base + 1)) {
    item.inserts = mergeIdSets([item.inserts, later.inserts]);
    item.deletes = mergeIdSets([item.deletes, later.deletes]);
  }
}

/** Pop events held while a gated step's transaction is open. */
const heldPops = new WeakMap<
  BindingUndoManager,
  Parameters<UndoManager['emit']>[]
>();

/**
 * D08's permission for one local write (see Binding.admitsIn): the schema
 * records (see Binding.schemaRecords) it was admitted on.
 */
type SchemaGrace = {records: SchemaRecords};

/**
 * The root's schema records as stored: [key, value] pairs in key order,
 * the values themselves (see sameSchemaRecords).
 */
type SchemaRecords = [string, unknown][];

/**
 * Whether two captures of the schema records are the same records: the
 * same keys, each value the same by Object.is. Exact without serializing:
 * NaN, Infinity, -Infinity, -0 and 0 all differ, other primitives compare by
 * value, and an object-valued record compares by reference, so any rewrite
 * of one (a new item, a new value) reads as a change.
 */
function sameSchemaRecords(a: SchemaRecords, b: SchemaRecords): boolean {
  return (
    a.length === b.length &&
    a.every(([k, v], i) => b[i][0] === k && Object.is(b[i][1], v))
  );
}

/**
 * Each BindingUndoManager's check (kept apart from the instance, which is
 * Yjs's: no field of ours on it): whether its binding may write, asked
 * before the step and again inside its transaction, a fresh request checked
 * against the records as they are (see Binding.admitsIn).
 */
const undoAdmits = new WeakMap<BindingUndoManager, () => boolean>();

/** A warning that says why the binding is read only. */
const isReadOnlyCause = (w: LexicalWarning): boolean =>
  w.code === UNSUPPORTED_LAYOUT_WARNING ||
  w.code === UNSUPPORTED_SCHEMA_WARNING;

/**
 * quiesce()'s kept result (see YBinding#quiesce): the state's bytes and the
 * draft as JSON text, never handed out. Every call, the first included,
 * returns fresh copies (see quiescedResult): the bytes copied, the draft
 * parsed again, so no result shares anything with another, with the binding
 * or with a node serializer that reuses its output objects.
 */
type QuiescedKept = {
  readonly state: Uint8Array;
  readonly draftText: string;
  readonly differs: boolean;
};

function quiescedResult(kept: QuiescedKept): YQuiescedState {
  return {
    draft: {
      differs: kept.differs,
      json: JSON.parse(kept.draftText) as SerializedEditorState,
    },
    state: kept.state.slice(),
  };
}

/**
 * An editor state's JSON as text (the draft's domain: what a quarantine
 * record stores). Any failure, of `toJSON()` (a node's exportJSON) or of
 * `JSON.stringify` (a BigInt, a cycle, a throwing getter), throws a
 * TypeError, cause kept, whose message depends on the phase: at the
 * preflight (before quiesce() drains) nothing has changed; at the final
 * serialization (after the drain) local updates may already have been
 * written, and nothing was cached.
 */
function draftText(
  read: () => SerializedEditorState,
  phase: 'preflight' | 'final',
): string {
  try {
    return JSON.stringify(read());
  } catch (e) {
    throw new TypeError(
      phase === 'preflight'
        ? `@lexical/y: quiesce() could not serialize the editor state as JSON: ${e instanceof Error ? e.message : String(e)}. Nothing was changed. Store serializable state (not a BigInt NodeState value or a cycle, and node exportJSON methods that do not throw), then retry quiesce()`
        : '@lexical/y: quiesce() could not serialize the drained editor state. Local updates may already have been written; no handoff result was cached. Store serializable state and retry quiesce().',
      {cause: e},
    );
  }
}

/**
 * A write refused at write time (see YBinding#refusalIn): the family of the
 * record that refused it, captured inside its own transaction.
 */
class Refusal {
  constructor(readonly record: 'layout' | 'schema') {}
}

/**
 * The refusal of a local edit, while read only or at write time: when a
 * read-only cause is reported with it, the cause goes first.
 */
const isReadOnlyRefusal = (w: LexicalWarning): boolean => {
  const data = w.data as {reason?: unknown} | null | undefined;
  return (
    w.code === UNSUPPORTED_EDIT_WARNING &&
    data !== null &&
    data !== undefined &&
    (data.reason === 'read-only' || data.reason === 'refused-at-write')
  );
};

/** Each BindingUndoManager's own undo and redo (Yjs's). */
const undoSteps = new WeakMap<
  BindingUndoManager,
  {
    undo: () => ReturnType<UndoManager['undo']>;
    redo: () => ReturnType<UndoManager['redo']>;
  }
>();

/** Transactions of an undo or redo refused inside them: not captured. */
const refusedHistory = new WeakSet<Transaction>();

/** The floor a test set (see setMinLayoutForTests), null: MIN_LAYOUT. */
let minLayoutForTests: number | null = null;

/**
 * @internal Test-only: the oldest layout bindings read (null: MIN_LAYOUT,
 * 1 on this build, below which nothing is). Not exported by the package.
 */
export function setMinLayoutForTests(min: number | null): void {
  minLayoutForTests = min;
}

/** The oldest layout a binding reads (see MIN_LAYOUT). */
function minLayout(): number {
  return minLayoutForTests ?? MIN_LAYOUT;
}

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
  | 'foresee'
  | 'reread'
  | 'normalize'
  | 'refresh'
  | 'register';
const PENDING_ORDER: readonly PendingWork[] = [
  'replies',
  'restore',
  'hidden',
  'foresee',
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

/**
 * The bindings that keep an item from garbage collection (D88), per item, and
 * whether it was kept already when the first of them did (by an UndoManager's
 * step): the item is released when the last of them releases it, and only
 * if nothing else kept it before.
 */
const keepOwners = new WeakMap<
  Item,
  {external: boolean; owners: Set<object>}
>();

/**
 * The items bindings kept again after their UndoManager let them go (a clear
 * of a stack releases what its steps kept, parents included), with the
 * binding lifetimes (the owners in keepOwners) that hold each such keep: the
 * lifetimes that kept it again, or relied on it when another had, or held
 * it when the last of those stopped. The keep is released when the last of
 * them stops. And per lifetime, the items it holds so.
 */
const rekeepHolders = new WeakMap<Item, Set<object>>();
const rekeptByOwner = new WeakMap<object, Set<Item>>();

/**
 * Fields Lexical derives as it renders a commit (see $writeReadEdits): the
 * root's text, and the text format and style an element takes from the
 * first text in it (LexicalReconciler's reconcileTextFormat), which depend
 * on what the editor rendered before. An element with no text in it keeps
 * the ones set on it. `hasText`: whether there is text in the node.
 */
function isDerivedField(
  node: LexicalNode,
  field: string,
  hasText: boolean,
): boolean {
  return (
    field === '__cachedText' ||
    ((field === '__textFormat' || field === '__textStyle') &&
      $isElementNode(node) &&
      hasText)
  );
}

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
  /**
   * An edit by this client's code that is out of the undo history (an app
   * edit made while a remote change is read, see $writeReadEdits): written
   * with the follow-up origin, but it carries this client's schema version
   * as a local edit does (D08).
   */
  readonly recordOwnSchema?: true;
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

const __DEV__ = process.env.NODE_ENV !== 'production';

/** @experimental Options of {@link YBinding} (and `YCollabExtension`). */
export interface YBindingOptions {
  /**
   * The version of your editor's nodes: registered node classes, their
   * fields and NodeState. Bump it when you add, remove or change one, not on
   * every release. Required: start at 1. The document records the highest
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
   * How documents below MIN_LAYOUT are upgraded (see y.md "Layout
   * upgrades"): a handle from createYServerLayoutUpgrade (the document's
   * server migrates them on load) or null (they stay read only). The
   * binding behaves the same with either: a document below the floor is
   * read only until it is migrated, and the `'older'` warning says which
   * was declared (`upgrade`). Left out (plain JavaScript, or a config
   * written without createYCollabConfig), such a document also brings
   * UNSUPPORTED_CONFIG_WARNING `'missing-layout-upgrade'`.
   */
  layoutUpgrade?: YLayoutUpgradeHandle | null;
  /**
   * The range of the document's client ids: `'uint53'` (default, Yjs 14's
   * ids, left as they are) or `'uint32'` (kept in 32 bits, for servers on
   * yrs before 0.28; see {@link ClientIDRange}).
   */
  clientIDRange?: ClientIDRange;
}

/**
 * @experimental What `YBinding.quiesce()` returns: the document's state
 * (pending updates included), to hand to the server, and a draft, the
 * editor's state as JSON taken before it turned read only, with `differs`
 * when the editor shows something the document does not hold (a local
 * change the binding could not write).
 */
export interface YQuiescedState {
  readonly state: Uint8Array;
  readonly draft: {
    readonly json: SerializedEditorState;
    readonly differs: boolean;
  };
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
 * not a version (an integer from 1, set to true), the epoch or a feature
 * requirement is not well formed, or the root requires a feature this
 * version does not support: each opens the document read only.
 */
function recordedLayout(root: YNode): number | null {
  // The root's attributes read once (getAttrs builds them afresh): this runs
  // on the write path, in every binding-authored transaction.
  const attrs = root.getAttrs() as RootAttrs;
  const requirements = requirementsIn(attrs);
  return malformedIn(attrs, requirements) !== null ||
    requirements.unknown.length > 0
    ? NaN
    : newestIn(attrs);
}

/**
 * The first `lexical-y:<n>` attribute of `root` that is not a version, its
 * epoch (EPOCH_KEY) when it is not well formed (see epochRecordOf; no epoch
 * is fine: a document that never migrated), or its first feature
 * requirement that is not well formed (see readRequirements).
 */
function malformedLayout(root: YNode): {key: string; found: unknown} | null {
  const attrs = root.getAttrs() as RootAttrs;
  return malformedIn(attrs, requirementsIn(attrs));
}

/** malformedLayout, on attributes and requirements already read. */
function malformedIn(
  attrs: RootAttrs,
  requirements: YRequirements,
): {key: string; found: unknown} | null {
  for (const key in attrs) {
    if (key.startsWith(LAYOUT_PREFIX)) {
      const n = key.slice(LAYOUT_PREFIX.length);
      if (!/^[1-9][0-9]*$/.test(n) || attrs[key] !== true) {
        return {found: attrs[key], key};
      }
    }
  }
  const epoch = epochRecordIn(attrs);
  if (epoch.kind === 'malformed') {
    return {found: epoch.found, key: EPOCH_KEY};
  }
  const [requirement] = requirements.malformed;
  return requirement === undefined ? null : requirement;
}

/** The highest version of the layout records in `attrs`, null when none. */
function newestIn(attrs: RootAttrs): number | null {
  let version: number | null = null;
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
 * Whether `fn` is a method that does nothing (plain parameters and an empty
 * body, or a bare `return`), as TextNode's own selectionTransform is (an
 * app may have patched it before this module loaded).
 *
 * @__NO_SIDE_EFFECTS__
 */
export function doesNothing(fn: unknown): boolean {
  // Its own source (not an overridable toString): a name, plain parameter
  // names (no default or destructuring, which run code) and an empty body.
  return (
    typeof fn === 'function' &&
    /^(?:function\s*)?[\w$]*\s*\(\s*(?:[\w$]+\s*(?:,\s*[\w$]+\s*)*)?\)\s*\{\s*(?:return;?)?\s*\}$/.test(
      Function.prototype.toString.call(fn),
    )
  );
}

/**
 * TextNode's own selectionTransform as this module found it, and whether it
 * does nothing (an app may have patched it before this module loaded). A
 * text class's override, or an app's patch of TextNode's own (which every
 * text class then runs), is anything else (see markReadEnd).
 *
 * @__NO_SIDE_EFFECTS__
 */
function baseSelectionTransform(): {
  readonly doesNothing: boolean;
  readonly fn: unknown;
} {
  const fn = TextNode.prototype.selectionTransform;
  return {doesNothing: doesNothing(fn), fn};
}

const BASE_SELECTION_TRANSFORM = baseSelectionTransform();

/**
 * The origin of a binding's initialization transaction, and of its
 * follow-up writes and pin records (one instance each): an instance of a
 * class nothing outside this module holds, so no UndoManager tracks it, an
 * app's that tracks `Object` included (Yjs matches tracked origins by
 * identity and by `origin.constructor`).
 */
class InitOrigin {
  constructor(readonly binding: YBinding) {}
}

/**
 * The roots the bindings of each document write in, with the bindings
 * registered on each (see ownsUnderRoot): a binding is added when it is made
 * and when it starts again, and removed, that instance only and once, when
 * it stops.
 */
const boundRoots = new WeakMap<Doc, Map<YNode, Set<object>>>();

function boundRootsOf(doc: Doc): Map<YNode, Set<object>> {
  let roots = boundRoots.get(doc);
  if (roots === undefined) {
    roots = new Map();
    boundRoots.set(doc, roots);
  }
  return roots;
}

/** Register `binding` as running on `root`; returns its removal (once). */
function registerBoundRoot(doc: Doc, root: YNode, binding: object): () => void {
  const roots = boundRootsOf(doc);
  let on = roots.get(root);
  if (on === undefined) {
    on = new Set();
    roots.set(root, on);
  }
  on.add(binding);
  let removed = false;
  return () => {
    if (removed) {
      return;
    }
    removed = true;
    const now = roots.get(root);
    if (now !== undefined) {
      now.delete(binding);
      if (now.size === 0) {
        roots.delete(root);
      }
    }
  };
}

/**
 * Attempts at the recovery of a write that failed part way, inside its
 * transaction (each from the state before the write, see Binding's
 * $undoAttempt), before the recovery outside it takes over.
 */
export const MAX_RECOVERY_ATTEMPTS = 5;

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
  private readonly initOrigin = new InitOrigin(this);
  /** Origin of follow-up writes and pin records (not tracked by undo). */
  private readonly followUpOrigin = new InitOrigin(this);
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
   * Nodes holding slots the document cannot store that a local update made
   * while read only: the next re-read removes those slots.
   */
  private readonly refusedSlotHosts = new Set<NodeKey>();
  /**
   * Empty text nodes Lexical keeps (not mergeable simple text), not read back yet because the
   * caret or a composition is in them (see readBackUnstored).
   */
  private readonly emptyHeld = new Set<NodeKey>();
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
  /** The ids of the items the running undo/redo deletes (see isKeptByUndo). */
  private undoing: IdSet | null = null;
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
  /** Removes this binding's registration on its root (see registerRoot). */
  private unregisterRoot: (() => void) | null = null;

  /**
   * Register this binding on its root (see boundRootsOf), where it is not
   * registered: when it is made, and when it starts again after it stopped.
   */
  private registerRoot(): void {
    if (this.unregisterRoot === null) {
      this.unregisterRoot = registerBoundRoot(this._doc, this._root, this);
    }
  }

  /**
   * Whether `type` is under this binding's root and not under the root of
   * another registered binding stored inside it (see boundRootsOf).
   */
  private ownsUnderRoot(type: YNode): boolean {
    const roots = boundRootsOf(this._doc);
    for (let t: YNode | null = type; t !== null; t = t.parent) {
      if (t === this._root) {
        return true;
      }
      // Another binding's root, stored inside this one's.
      const on = roots.get(t);
      if (on !== undefined && on.size > (on.has(this) ? 1 : 0)) {
        return false;
      }
    }
    return false;
  }

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
  /**
   * Remote changes Yjs applied while the editor was making a local update,
   * in order: read once that update has committed and been written (see
   * deferChange).
   */
  private readonly deferred: Transaction[] = [];
  /** While an app's edit in a read is written: its update's text edits. */
  private readEditLog: TextEditLog | null = null;
  /** While the deferred changes are read (see readDeferred). */
  private drainingDeferred = false;
  /** Whether an update that reads the deferred changes is queued. */
  private deferredQueued = false;
  /**
   * The deferred changes whose deleted content Yjs does not collect until
   * they are read (see deferChange), and the document's `gcFilter` the
   * binding's own wraps (see holdDeleted).
   */
  private readonly heldUnread = new Set<Transaction>();
  /** Containers read while changes were deferred, checked later (see checkRead). */
  private readonly checkLater = new Set<CS>();
  /** While takeCursor's transaction runs. */
  private takingCursor = false;
  /** The cursor takeCursor took last, and on which editor state. */
  private takenCursor: {cursor: YCursor | null; state: EditorState} | null =
    null;
  private gcFilters: {
    ours: (item: Item) => boolean;
    prev: (item: Item) => boolean;
  } | null = null;
  /** While a read of the binding's runs (see guardedRead). */
  private readsNow = 0;
  /**
   * What a read of the binding's made, as its update callback returned (see
   * markReadEnd): the state it is in, and the nodes it changed, as they were
   * then. Lexical goes on in that update and its commit (the selection's
   * transforms, the selection change command, node transforms), and an
   * app's code there can change nodes too (see $writeReadEdits).
   */
  private readEnd: {
    state: EditorState;
    nodes: Map<NodeKey, LexicalNode | undefined>;
  } | null = null;
  /** The stored formats one update's transforms looked up (see settleTextFields). */
  private storedFormats: {
    state: EditorState | null;
    sequences: StoredFormatsMemo;
    lines: Map<NodeKey, StoredLine>;
  } = {lines: new Map(), sequences: new Map(), state: null};
  /**
   * Whether deleted item `item` is one the editor still shows: a format
   * item a held change deleted in the line being composed (see
   * Hidden#keeps).
   */
  private readonly keepsShown = (item: Item): boolean => {
    const hidden = this.state.hidden;
    return hidden !== null && hidden.keeps(item);
  };
  /** A write deleted a kept item again (see Hidden#drop). */
  private readonly dropKept = (item: Item): void => {
    const hidden = this.state.hidden;
    if (hidden !== null) {
      hidden.drop(item);
    }
  };
  /**
   * The document as the editor shows it while a hold keeps deleted format
   * items and nothing is unread (see Hidden#keeps): Yjs, with those items
   * live. One per hold.
   */
  private held: {hidden: Hidden; view: Unread} | null = null;
  private heldView(): Unread | null {
    const hidden = this.state.hidden;
    if (hidden === null) {
      return null;
    }
    // Once made for a hold, the view stays until the hold ends, also after
    // a write dropped the last item it kept: an operation that took the
    // view keeps seeing the one its work runs on (see View). Keeping
    // nothing, it reads and writes as no view (see Unread#lapsed).
    if (
      !hidden.keepsAny() &&
      (this.held === null || this.held.hidden !== hidden)
    ) {
      return null;
    }
    if (this.held === null || this.held.hidden !== hidden) {
      this.held = {
        hidden,
        view: emptyView(
          this._root,
          this.keepsShown,
          this.dropKept,
          () => !hidden.keepsAny(),
        ),
      };
    }
    return this.held.view;
  }
  /**
   * This binding's view, for its work (see guard). While a change is read,
   * the document as Yjs has it but for the changes still deferred (see
   * deferChange), with the deleted format items a hold keeps (see
   * Hidden#keeps): every reader of the line being composed sees them live,
   * as its writes do, so that a kept opener and its kept end still pair,
   * whatever key they carry.
   */
  private readonly seer = (): Unread | null => {
    const view = this.unread;
    if (!this.reading) {
      return view ?? this.heldView();
    }
    if (view === null || this.deferred.length === 0) {
      return this.heldView();
    }
    // One object while neither changes (an operation compares the view it
    // took with the binding's, see View).
    const memo = this.deferredView;
    if (
      memo !== null &&
      memo.unread === view &&
      memo.changes === view.changes.length &&
      memo.deferred.length === this.deferred.length &&
      memo.deferred.every((c, k) => c === this.deferred[k])
    ) {
      return memo.view;
    }
    const filtered: Unread = {
      ...view,
      changes: view.changes.filter(c => this.deferred.includes(c)),
    };
    this.deferredView = {
      changes: view.changes.length,
      deferred: [...this.deferred],
      unread: view,
      view: filtered,
    };
    return filtered;
  };
  /** The view seer last made while changes were deferred (see seer). */
  private deferredView: {
    unread: Unread;
    changes: number;
    deferred: Transaction[];
    view: Unread;
  } | null = null;
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
  /** Whether quiesce() ran: read only for good. */
  private quiesced = false;
  /**
   * The first quiesce()'s result, never handed out: every call returns
   * copies (a recomputed draft would miss a batched update the first call
   * refused, since the refusal read the document back into the editor).
   */
  private quiescedState: QuiescedKept | null = null;
  /** The D08 permission of the commit being written (see admitsIn). */
  private writeGrace: SchemaGrace | null = null;
  /** Local commits refused so far (see quiesce). */
  private refusals = 0;
  /** A write was refused inside its transaction (see $writeCommit). */
  private layoutChangedInWrite = false;
  /** An evaluation is queued (see evaluateSoon). */
  private evaluateQueued = false;

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

  /**
   * Whether this binding's writes and undo steps treat `key` as paired runs
   * (see Ident.covered and writesPairedRuns): then none of the rules that
   * keep or close plain values for it run.
   */
  private pairsKey(key: string): boolean {
    return covered(key) && writesPairedRuns(this._doc, this._root);
  }

  /**
   * After each transaction: where a local transaction deleted the live
   * layout 3 record, write it again in a transaction of its own with an
   * origin no UndoManager tracks (IdentityLayoutOrigin; a record this
   * client wrote first is protected by Ident.protectRecordAfter). Never on
   * the remote-apply path: the client whose transaction deleted it records
   * it.
   */
  private keepIdentityRecord(tr: Transaction): void {
    if (
      !tr.local ||
      tr.origin instanceof IdentityLayoutOrigin ||
      recordsIdentityLayout(this._root)
    ) {
      return;
    }
    const subs = tr.changed.get(this._root);
    if (
      subs !== undefined &&
      subs.has(LAYOUT_PREFIX + IDENTITY_LAYOUT_VERSION)
    ) {
      // The new transaction runs after this one's cleanup (Yjs queues it).
      const root = this._root;
      this._doc.transact(own => {
        // Development builds: the binding's own write (see noteRawWrite).
        if (__DEV__) {
          markBindingWrite(own);
        }
        writeIdentityRecord(root);
      }, new IdentityLayoutOrigin());
    }
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
    this.registerRoot();
    noteBoundRoot(this._root);
    assertOwnYjsDoc(doc, this._root);
    this.state = new State(editor, doc, this._root);
    if (__DEV__) {
      registerBindingOrigins([
        this,
        this.initOrigin,
        this.followUpOrigin,
        this.scanOrigin,
        this.runEndOrigin,
      ]);
    }
    this.afterTransaction = tr =>
      this.guard(() => withPins(this._pins, () => this.onAfterTransaction(tr)));
    this.beforeTransaction = tr => {
      if (tr.origin === this.scanOrigin) {
        // A scan changes nothing (see getCursor): the cursor stays.
        this.noteChange(tr);
        return;
      }
      this.pendingCursor =
        this._status !== 'pending' &&
        tr.origin !== this &&
        tr.origin !== this.initOrigin &&
        tr.origin !== this.followUpOrigin
          ? this.takeCursor()
          : null;
      this.noteChange(tr);
    };
  }

  /** Start listening; read the document if it is already initialized. */
  start(): () => void {
    return this.guard(() => this.startInner());
  }

  private startInner(): () => void {
    // This binding's root, registered again where it stopped before (see
    // ownsUnderRoot).
    this.registerRoot();
    // The copy fix-up and index of paired runs, while this binding runs
    // (see Ident.installIdentity).
    this.disposers.push(installIdentity(this._doc));
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
    this.frontSelectionChange();
    this.disposers.push(() => this.offSelectionChange());
    this.disposers.push(
      this._editor.registerUpdateListener(payload =>
        this.guard(() => {
          if (!this.task.committed) {
            this.task.committed = true;
            queueMicrotask(endOfTask(this.task));
          }
          withPins(this._pins, () => this.onUpdate(payload));
          if (this.deferred.length > 0) {
            // The update the remote changes were applied in has committed,
            // and is written (see deferChange).
            this.scheduleDeferred();
          }
          const hidden = this.state.hidden;
          if (hidden !== null) {
            this.noteComposed(hidden, payload);
          }
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
    // A layout migration (a change of the root's epoch) replaced items the
    // undo stacks name: clear them once every capture of its transaction has
    // run (D102). Earlier, the migration's own capture would stay.
    this.disposers.push(
      onYMigrationEpoch(
        this._doc,
        () => {
          if (this._undoManager !== null) {
            this._undoManager.clear();
          }
        },
        this._root,
      ),
    );
    if (this.options.captureTimeout !== null) {
      const um = new BindingUndoManager(
        this._root,
        () => this.writesEdits() && this.admitsIn(null),
        {
          captureTimeout: this.options.captureTimeout ?? 500,
          deleteFilter: item => !this.isKeptByUndo(item),
          trackedOrigins: new Set([this]),
        },
      );
      this._undoManager = um;
      // Undo reads the format items of the changes on its stacks, and the
      // end each of them gave a run it deleted (see isKeptByUndo,
      // closeRestoredRuns, changeEnd), after a collaborator deleted them:
      // keep those from garbage collection (Item.keep, as UndoManager keeps
      // the items a change deletes) so a collected item's key and value
      // stay readable (#9623). The flag is local; while an item is kept,
      // this document still holds its content (D88).
      // What this binding keeps is released when both stacks are empty
      // (after a clear, an undo that leaves nothing to redo, or a write the
      // stacks did not capture) and when the binding is disposed. Another
      // binding on the same document, or an UndoManager, may keep the same
      // item: it stays kept until every binding that kept it released it.
      // Releasing collects nothing: an item deleted while kept keeps its
      // content until the document reloads, as Yjs leaves the items an
      // UndoManager step kept (any UndoManager on the document may still
      // restore it).
      const kept = new Set<Item>();
      // This listening lifetime: a binding started again after a dispose
      // owns its keeps anew, apart from a release the old one queued.
      const owner = {};
      const rekept = new Set<Item>();
      rekeptByOwner.set(owner, rekept);
      const hold = (it: Item, by: object) => {
        let holders = rekeepHolders.get(it);
        if (holders === undefined) {
          holders = new Set();
          rekeepHolders.set(it, holders);
        }
        holders.add(by);
        const theirs = rekeptByOwner.get(by);
        if (theirs !== undefined) {
          theirs.add(it);
        }
      };
      // When this lifetime ends: each keep it holds goes to the other
      // lifetimes that hold it, or that keep the item for a step of theirs,
      // or is released by the last of them.
      const releaseRekept = () => {
        for (const it of rekept) {
          const holders = rekeepHolders.get(it);
          if (holders !== undefined) {
            holders.delete(owner);
            if (holders.size > 0) {
              continue;
            }
            rekeepHolders.delete(it);
          }
          const entry = keepOwners.get(it);
          if (entry !== undefined && entry.owners.size > 0) {
            for (const other of entry.owners) {
              hold(it, other);
            }
            continue;
          }
          it.keep = false;
        }
        rekept.clear();
      };
      const keep = (item: Item | null) => {
        for (let it = item; it !== null; it = (it.parent as YNode)._item) {
          let entry = keepOwners.get(it);
          if (entry === undefined) {
            // `external`: kept already (by an UndoManager's step), which
            // this leaves to whoever kept it.
            entry = {external: it.keep, owners: new Set()};
            keepOwners.set(it, entry);
          } else if (entry.owners.has(owner)) {
            // Its parents are this lifetime's already.
            break;
          }
          entry.owners.add(owner);
          it.keep = true;
          kept.add(it);
        }
      };
      // Released only between transactions: inside one (another
      // UndoManager's stack event, a listener) the transaction's own
      // collection, which runs after its listeners, would still collect an
      // item it deleted that another UndoManager has just kept.
      // A queued release keeps the stronger request (dispose releases
      // whatever the stacks hold), and a document destroyed meanwhile
      // releases at once (its listeners, the queued one too, are gone).
      let queued: 'empty' | 'always' | null = null;
      let disposed = false;
      const inTransaction = () =>
        this._doc._transaction !== null ||
        this._doc._transactionCleanups.length > 0;
      const releaseNow = () => {
        for (const it of kept) {
          const entry = keepOwners.get(it);
          if (entry !== undefined) {
            entry.owners.delete(owner);
            if (entry.owners.size > 0) {
              continue;
            }
            keepOwners.delete(it);
            if (entry.external) {
              continue;
            }
          }
          // A keep this lifetime set again after a clear goes with it; one
          // another lifetime holds stays.
          const holders = rekeepHolders.get(it);
          if (holders !== undefined) {
            holders.delete(owner);
            rekept.delete(it);
            if (holders.size > 0) {
              continue;
            }
            rekeepHolders.delete(it);
          }
          it.keep = false;
        }
        kept.clear();
        if (disposed) {
          this._doc.off('destroy', onDestroy);
          releaseRekept();
        }
      };
      const release = (onlyWhenEmpty: boolean) => {
        if (kept.size === 0 && (!disposed || rekept.size === 0)) {
          if (disposed) {
            this._doc.off('destroy', onDestroy);
          }
          return;
        }
        if (
          onlyWhenEmpty &&
          (um.undoStack.length > 0 || um.redoStack.length > 0)
        ) {
          return;
        }
        if (inTransaction() && !this._doc.isDestroyed) {
          if (queued === null) {
            this._doc.once('afterAllTransactions', () => {
              const always = queued === 'always';
              queued = null;
              release(!always);
            });
          }
          if (queued !== 'always') {
            queued = onlyWhenEmpty ? 'empty' : 'always';
          }
          return;
        }
        releaseNow();
      };
      const onDestroy = () => {
        disposed = true;
        queued = null;
        releaseNow();
      };
      this._doc.on('destroy', onDestroy);
      const releaseWhenEmpty = () => release(true);
      um.on('stack-cleared', () => {
        releaseWhenEmpty();
        // A clear of one stack makes the UndoManager release what that
        // stack's steps kept, parents included: keep what this binding
        // still relies on (another UndoManager on the document may rely on
        // it too: Yjs's keep is one flag). Released when this binding stops
        // (see releaseRekept), not before.
        for (const it of kept) {
          if (!it.keep) {
            it.keep = true;
            hold(it, owner);
          } else if (rekeepHolders.has(it)) {
            // Kept again by another binding: held by this one too.
            hold(it, owner);
          }
        }
      });
      this.disposers.push(() => {
        disposed = true;
        release(false);
      });
      const keepFormats = (tr: Transaction) => {
        // A listener call already under way when the binding was disposed
        // keeps nothing.
        if (!tr.local || disposed) {
          return;
        }
        if (tr.origin === um) {
          // An undo or redo that leaves both stacks empty (one that changes
          // nothing pops its step without an event).
          releaseWhenEmpty();
        }
        if (tr.origin !== this && tr.origin !== um) {
          return;
        }
        const ends: Item[] = [];
        iterateStructsByIdSet(tr, tr.deleteSet, s => {
          if (
            s instanceof Item &&
            s.content instanceof ContentFormat &&
            s.content.value !== null
          ) {
            if (!this.pairsKey(s.content.key)) {
              const end = changeEnd(this._doc, s);
              if (end !== null) {
                ends.push(end);
              }
            } else if (!isEndValue(s.content.value)) {
              // A paired run's own ends, by id (no end is guessed).
              ends.push(...endsOf(s));
            }
          }
        });
        ends.forEach(keep);
        iterateStructsByIdSet(tr, tr.insertSet, s => {
          if (s instanceof Item && s.content instanceof ContentFormat) {
            keep(s);
          }
        });
        // A write the stacks did not capture (a capture filter, an origin no
        // longer tracked) leaves nothing an undo could read.
        releaseWhenEmpty();
      };
      this._doc.on('afterTransaction', keepFormats);
      this.disposers.push(() => this._doc.off('afterTransaction', keepFormats));
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
        this.commitsAtOnce() &&
        // Not while the editor notifies the listeners of a commit (an
        // update a mutation listener makes, which Lexical runs at once):
        // committed there, its listeners would run before the rest of that
        // commit's, which would then write an older state over it.
        !isDispatchingCommitListeners(this._editor)
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
    // Its helpers read in this binding's view (see seer): an update app code
    // makes during another binding's work runs its transforms too.
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
                this.seer(),
                state,
                [node.getKey()],
                fieldsOf,
                null,
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

  /**
   * EXPERIMENTAL. Hand this replica off (D102, the recovery handoff before a
   * client replaces a document its server migrated). Ends an IME
   * composition and commits what the editor holds (an update not committed
   * yet, the binding's own pending work) into the document as ordinary
   * local writes, so it gets Yjs identities; then turns the binding read
   * only for good, local and programmatic edits included (they are not
   * written, and the editor shows the document again). Returns a
   * YQuiescedState.
   *
   * - Stop the app's providers and persistence first: what they deliver
   *   after the handoff is not in the returned state.
   * - Call it outside an editor update (inside one it throws, and changes
   *   nothing).
   * - A binding already read only (for any reason) ends the composition and
   *   drains the editor's pending work too, but writes nothing: what the
   *   editor held uncommitted is the draft, with `differs`.
   * - Calling it again, before or after `dispose()`, writes nothing and
   *   returns a copy of the first call's result: the same state and the
   *   same draft, `differs` included (a batched update the first call could
   *   not write stays in the draft, though the editor no longer shows it).
   *   It recomputes nothing: what was written to the document since is not
   *   in it.
   * - Called first after `dispose()`, it writes nothing either: it returns
   *   the document's state and the editor's state as the draft.
   * - The draft is the editor state's JSON (what a quarantine record
   *   stores), parsed from `JSON.stringify`'s text, so it holds only plain
   *   JSON values, in every result: a Date NodeState value is its ISO
   *   string, a number JSON cannot hold (NaN, Infinity) is null, a Map or
   *   a Set is `{}`, and an undefined array entry is null. Before draining,
   *   it checks that the state that will become the draft serializes as
   *   JSON (the pending update's, or with none pending, the shown one): a
   *   failure there (a BigInt NodeState value, a cycle) throws a TypeError
   *   without draining or quiescing. If app code makes the state
   *   unserializable during the drain (an update listener's update), the
   *   final serialization throws a TypeError after local work may have
   *   been written and the composition ended, and nothing is cached: fix
   *   the state and call it again, and don't assume earlier edit
   *   callbacks did not run.
   * - Every result, the first included, is its own copy (the state's bytes,
   *   the draft parsed again): changing one changes no other. A warning
   *   handler or status listener that calls it during the first call gets
   *   that call's result.
   */
  quiesce(): YQuiescedState {
    if (this._editor._updating) {
      throw new Error(
        '@lexical/y: quiesce() cannot run inside an editor update; call it after the update',
      );
    }
    // The first call runs in one guard until its result is kept: the
    // warnings it queues (a refusal's) and the status notification go out
    // after that, so a handler that calls quiesce() again gets this result.
    const kept = this.quiescedState ?? this.guard(() => this.quiesceFirst());
    return quiescedResult(kept);
  }

  /** quiesce()'s first call: drain, take the result, keep it. */
  private quiesceFirst(): QuiescedKept {
    const editor = this._editor;
    // What the editor holds and has not committed yet (a batched update),
    // taken first, whatever the status: the commit below may be refused (a
    // read-only binding, or a record that stopped admitting writes before
    // the status shows it, see recordAdmits), and a refusal reads the
    // document back, which would erase it from the editor. Taken as text,
    // so a serializer that reuses its output objects cannot change it.
    const held = editor._pendingEditorState;
    const heldText =
      held !== null ? draftText(() => held.toJSON(), 'preflight') : null;
    // With nothing pending, the draft is what the editor shows (or the
    // state the drain builds from it): before anything changes, it must be
    // JSON too (a state that is not throws here, having changed nothing).
    // With an update pending, the shown state never becomes the draft (the
    // draft is the held state, or the state the drain builds on it), so it
    // is not checked: a value the pending update replaces is no reason to
    // refuse.
    if (held === null) {
      draftText(() => editor.getEditorState().toJSON(), 'preflight');
    }
    const refusalsBefore = this.refusals;
    if (this.started) {
      // A composition ends (its text is written like any typing), and a
      // batched update, which commits in a microtask, commits now: an
      // active binding writes them; a read-only one refuses them (no Yjs
      // write) and they stay in the draft.
      if (
        editor._compositionKey !== null ||
        editor._pendingEditorState !== null ||
        editor._updates.length > 0
      ) {
        editor.update(
          () => {
            $setCompositionKey(null);
          },
          {discrete: true},
        );
      }
      if (this._status === 'active' && this.pending.size > 0 && this.isIdle()) {
        this.runPending();
      }
    }
    // Refused: the draft is what the editor held, not what it shows now.
    const refused = this.refusals !== refusalsBefore;
    const text =
      heldText !== null && refused
        ? heldText
        : // App code may have made the state unserializable during the
          // drain (an update listener's update): this throws after local
          // work was written, before anything is kept (see draftText).
          draftText(() => editor.getEditorState().toJSON(), 'final');
    // What the editor shows and the document does not hold: local changes
    // the binding refused and has not read back yet, or keeps, or held
    // uncommitted when quiesce() began and could not write.
    const differs =
      (heldText !== null && refused) ||
      (this._status !== 'active' &&
        (this.keepsUnstored ||
          this.refused.size > 0 ||
          this.refusedComposing.size > 0 ||
          this.pending.has('reread') ||
          this.pending.has('restore')));
    // Kept before the status changes (its listeners may call quiesce()
    // again). Never handed out: every call returns copies of it.
    const kept: QuiescedKept = {
      differs,
      draftText: text,
      state: encodeStateAsUpdate(this._doc),
    };
    this.quiescedState = kept;
    this.quiesced = true;
    // After dispose() the editor is no longer the binding's: dispose gave
    // its editability back, and a status change would take it away again
    // (a binding started later on the same editor would keep it).
    if (this.started) {
      this.setStatus('readonly');
    }
    return kept;
  }

  /** Disconnect from the document and the editor (`start` returns this). */
  dispose(): void {
    this.started = false;
    // This binding's own registration only, once (see registerRoot).
    if (this.unregisterRoot !== null) {
      this.unregisterRoot();
      this.unregisterRoot = null;
    }
    this.initializeOnStart = false;
    // A composition held when the binding stops: its hold ends here, so the
    // deleted format items it kept showing lose the Item.keep it set (see
    // Hidden#keep), as when a hold ends (see $release). Only the flags
    // change; nothing is written.
    const hidden = this.state.hidden;
    if (hidden !== null) {
      this.state.hidden = null;
      hidden.releaseKeeps();
    }
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
    for (const tr of [...this.heldUnread]) {
      this.releaseUnread(tr);
    }
    // Never read: out of the unread view too, which a binding started
    // again starts from (see scheduleDeferred).
    for (const tr of this.deferred) {
      this.dropChange(tr);
    }
    this.deferred.length = 0;
    this.checkLater.clear();
    this.localRefresh.clear();
    this.refused.clear();
    this.refusedComposing.clear();
    this.refusedSlotHosts.clear();
    this.emptyHeld.clear();
    this.keepsUnstored = false;
    this.warnedEdit = false;
    this.restoreTo = null;
    this.stepFold = null;
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
      // The root is checked again inside the seed's own transaction, after
      // every beforeTransaction listener of the document ran (one may
      // record a layout or an epoch, or write content): only a root still
      // pristine, whose record the seed creates, is seeded. Otherwise
      // nothing is written and the root is read.
      let seeded = false;
      const seedSchema = this.schemaRecords();
      if (seed !== null) {
        // The seed's exact bytes, under the id derived from them, the
        // binding's only items under another client id than the document's;
        // read back like any document's content, so the editor shows what
        // is stored (and the state maps it), with its selection kept.
        // Inside an app's outer transaction (which an app UndoManager may
        // track), its layout 3 record is protected after that transaction,
        // the seed's bytes unchanged (see Ident.protectRecordAfter). Outside
        // one, the initialization's own origin is never tracked.
        const outer = this._doc._transaction;
        this._doc.transact(tr => {
          if (
            this.rootPristine() &&
            sameSchemaRecords(this.schemaRecords(), seedSchema)
          ) {
            // Development builds: the binding's own write, even when it
            // joined an app's transaction (see noteRawWrite).
            if (__DEV__) {
              markBindingWrite(tr);
            }
            seeded = true;
            applyUpdate(this._doc, seed.bytes, this.initOrigin);
          }
        }, this.initOrigin);
        if (!seeded) {
          this.evaluate();
          return;
        }
        if (outer !== null) {
          protectRecordAfter(outer, this._root);
        }
        if (kept !== null && kept.kind === 'node') {
          kept.items = seed.items;
        }
        this.evaluate(seed.cursor, kept);
        return;
      }
      this._doc.transact(tr => {
        if (
          this.rootPristine() &&
          sameSchemaRecords(this.schemaRecords(), seedSchema)
        ) {
          // Development builds: the binding's own write, even when it joined
          // an app's transaction (see noteRawWrite).
          if (__DEV__) {
            markBindingWrite(tr);
          }
          seeded = true;
          // The canonical layout 3 seed (see Ident.withSeeding).
          withSeeding(this._doc, () =>
            this.$writeInitial(this.state, this._root, tr, editorState),
          );
          // (As for the seed above.)
          if (tr.origin !== this.initOrigin) {
            protectRecordAfter(tr, this._root);
          }
        }
      }, this.initOrigin);
      if (!seeded) {
        this.evaluate();
        return;
      }
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
    // Layout 3 only: a new document records it from the start, and its
    // content's covered formats are written as canonical paired runs,
    // interleaved with the content (see Ident.withSeeding).
    writeIdentityRecord(root);
    root.setAttr(SCHEMA_PREFIX + this.options.schemaVersion, true);
    try {
      // Every element type of the initial content (into `root`, which may
      // be a scratch document's: this._pins is filled when the real one is
      // read).
      this.recordPins(root, editorState, null, new Map());
      editorState.read(() => {
        const roles = new Roles(state);
        const cs = state.newCS(root, 'root', 'b');
        const writer = new Writer(
          state,
          roles,
          tr,
          editorState,
          {
            attrs: new Set(),
            inline: new Set(),
            lines: new Set(),
            removedText: new Map(),
            structural: new Set(['root']),
          },
          this.seer,
        );
        writer.$writeContainer(cs, $getRoot());
      });
      // The seed's runs still open at their container's end (see
      // Ident.finishSeedRuns).
      finishSeedRuns(tr);
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
        withSeeding(scratch, () =>
          this.$writeInitial(sstate, sroot, tr, editorState),
        ),
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
      // An empty root holding a gate record but no layout record (an epoch
      // alone): not pristine, so initialize() seeds nothing, and no layout
      // is known. Missing, as the runner and describeYRoom see it.
      const recordsOnly = this._root.length === 0 && !this.rootPristine();
      if (this._root.length > 0 || recordsOnly || this._status === 'active') {
        // Content without a layout record, or a record removed from a
        // document this binding was writing (an outside writer deleted it;
        // no client of this layout deletes one): no layout is known, so
        // nothing is written.
        const reason =
          this._root.length > 0 || recordsOnly ? 'missing' : 'removed';
        this.warn(
          UNSUPPORTED_LAYOUT_WARNING,
          this._root.length > 0
            ? 'the root has content and no layout record, so this editor is read only: the record was deleted, or something other than this binding wrote the root. Bind a root only this binding writes (the root option), and reseed the content into a new room with seedYState'
            : recordsOnly
              ? "the root holds records (such as an epoch) but no layout record, so this editor is read only and seeds nothing: something other than this binding wrote the root's records; reseed the content into a new room with seedYState"
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
        `the layout record ${malformed.key} is malformed, so this editor is read only: something other than this binding (or a migration) wrote the root's records; reseed the content into a new room with seedYState`,
        {...malformed, reason: 'malformed', supported: LAYOUT_VERSION},
      );
      this.setStatus('readonly');
    } else if (readRequirements(this._root).unknown.length > 0) {
      const features = readRequirements(this._root).unknown;
      this.warn(
        UNSUPPORTED_LAYOUT_WARNING,
        `the document requires ${features.join(', ')}, which this version does not support, so this editor is read only: upgrade the binding on every client of the document`,
        {features, reason: 'requires', supported: LAYOUT_VERSION},
      );
      this.setStatus('readonly');
    } else if (version > LAYOUT_VERSION) {
      this.warn(
        UNSUPPORTED_LAYOUT_WARNING,
        `layout ${version} is newer than ${LAYOUT_VERSION}. A newer version of the binding wrote this document, so this editor is read only: upgrade the binding on every client of the document`,
        {found: version, reason: 'newer', supported: LAYOUT_VERSION},
      );
      this.setStatus('readonly');
    } else if (version < minLayout()) {
      const upgrade = this.options.layoutUpgrade;
      this.warn(
        UNSUPPORTED_LAYOUT_WARNING,
        upgrade
          ? `layout ${version} is older than ${minLayout()}, the oldest this version reads, so this editor is read only: the app declared that its server upgrades such documents, and this one was not migrated (its server migrates it on load with prepareYRoom)`
          : `layout ${version} is older than ${minLayout()}, the oldest this version reads, so this editor is read only (the app declared no layout upgrade): migrate the document on its server with prepareYRoom`,
        {
          found: version,
          min: minLayout(),
          reason: 'older',
          supported: LAYOUT_VERSION,
          upgrade: upgrade ? upgrade.kind : 'read-only',
        },
      );
      if (upgrade === undefined) {
        this.warn(
          UNSUPPORTED_CONFIG_WARNING,
          'no layoutUpgrade was declared, so a document below the floor is read only: create the config with createYCollabConfig and pass layoutUpgrade (a handle from createYServerLayoutUpgrade, or null)',
          {reason: 'missing-layout-upgrade'},
        );
      }
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
      version !== null &&
      !Number.isNaN(version) &&
      version >= minLayout() &&
      version <= LAYOUT_VERSION
    );
  }

  /** Whether `tr` changed the root's layout records or epoch. */
  private changedRecord(tr: Transaction): boolean {
    const keys = tr.changed.get(this._root);
    if (keys === undefined) {
      return false;
    }
    for (const k of keys) {
      // A gate key that still admits is no reason to stop looking: a schema
      // key later in the same change may refuse.
      if (k !== null && isGateKey(k) && !this.readsRecordedLayout()) {
        return true;
      }
      if (k !== null && k.startsWith(SCHEMA_PREFIX) && this.schemaRefuses()) {
        return true;
      }
    }
    return false;
  }

  /** Evaluate the root in a microtask (once), while started. */
  private evaluateSoon(): void {
    if (this.evaluateQueued) {
      return;
    }
    this.evaluateQueued = true;
    queueMicrotask(() => {
      this.evaluateQueued = false;
      if (
        this.started &&
        this._status === 'active' &&
        (!this.readsRecordedLayout() || this.schemaRefuses())
      ) {
        this.guard(() => this.evaluate());
      }
    });
  }

  /** Self-check of containers a remote change rebuilt (see checkContainer). */
  private checkRead(read: ReadonlySet<CS>): void {
    const check = this.options.selfCheck === true;
    if (!check) {
      return;
    }
    if (this.deferred.length > 0 || this.unread !== null) {
      // Changes are still deferred (see deferChange) or unread: the
      // document holds them, the editor does not yet. Checked with the last
      // one's read.
      for (const cs of read) {
        this.checkLater.add(cs);
      }
      return;
    }
    let rebuilt = read;
    if (this.checkLater.size > 0) {
      const all = new Set(read);
      for (const cs of this.checkLater) {
        if (this.state.containers.get(cs.y) === cs) {
          all.add(cs);
        }
      }
      this.checkLater.clear();
      rebuilt = all;
    }
    // Skipped while a re-read is pending (see refused): the editor then
    // shows a follow-up's change that is read again right after.
    if (
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
        const reader = new Reader(this.state, this.seer);
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
    return this._status === 'active' && this.recordAdmits();
  }

  /**
   * Whether the root is as initialization found it: no content, no layout
   * record (well formed or not) and no epoch.
   */
  private rootPristine(): boolean {
    if (this._root.length > 0) {
      return false;
    }
    for (const key of Object.keys(this._root.getAttrs())) {
      if (isGateKey(key)) {
        return false;
      }
    }
    return true;
  }

  /**
   * A local change refused because the root's layout record, as it was when
   * the change was written, or its schema record, was missing, malformed or
   * one this version does not write, while the binding was active. The
   * record changed in the transaction the change was written in: an app's
   * (inside its `doc.transact`, or in one of its beforeTransaction
   * listeners), or a remote update a provider applied while the editor was
   * updating. Not retried: a retry would write outside that transaction.
   */
  private warnRefusedAtWrite(record: 'layout' | 'schema'): void {
    this.warn(
      UNSUPPORTED_EDIT_WARNING,
      `a local change was not written: when it was written, the document's ${record} record (changed in the same transaction, by the app or by an update a provider applied) was missing, malformed or one this version does not write. It is not retried, since a retry would write outside that transaction: edit again (see binding.status)`,
      {reason: 'refused-at-write', record},
    );
  }

  /**
   * Whether the root's layout record, as it is now, is one this binding
   * writes: from the floor (MIN_LAYOUT) to LAYOUT_VERSION, well formed.
   *
   * Invariant: checked at every write (an editor update, an undo or redo,
   * through the binding or its UndoManager), not only read from the status.
   * Why: inside an app's transaction that changes the record, the binding
   * has not read the change yet (it reads once the transaction ends), and
   * a write made then would be written to a document it does not admit.
   */
  private recordAdmits(): boolean {
    const version = recordedLayout(this._root);
    return (
      version !== null &&
      !Number.isNaN(version) &&
      version >= minLayout() &&
      version <= LAYOUT_VERSION
    );
  }

  /** The root's schema records as they are now (see admitsIn). */
  private schemaRecords(): SchemaRecords {
    const attrs = this._root.getAttrs() as Record<string, unknown>;
    return Object.keys(attrs)
      .filter(k => k.startsWith(SCHEMA_PREFIX))
      .sort()
      .map(k => [k, attrs[k]]);
  }

  /**
   * The admission check inside a binding-authored write transaction
   * (editor writes, initialization, the recovery rewrite, pins, undo and
   * redo): the layout record and the epoch as they are now (recordAdmits),
   * and the schema records as they are now (schemaRefuses), even while the
   * status the binding last read is still active. One exception, D08's: a
   * local update made before a schema record it did not see (see
   * schemaGatesWrite and gateSchema) is written, and its whole write (the
   * recovery rewrite and pins included) carries that permission as `grace`,
   * for exactly the schema records it was admitted on.
   */
  private admitsIn(grace: SchemaGrace | null): boolean {
    return this.refusalIn(grace) === null;
  }

  /**
   * admitsIn's verdict as the family of the record that refused (`'layout'`
   * is checked first), or null when the write is admitted. A refused write
   * keeps it in a local of its own transaction and returns it with its
   * result: a later admission (an app's afterTransaction listener's) cannot
   * change what the refusal reports.
   */
  private refusalIn(grace: SchemaGrace | null): 'layout' | 'schema' | null {
    if (!this.recordAdmits()) {
      return 'layout';
    }
    return !this.schemaRefuses() ||
      (grace !== null && sameSchemaRecords(this.schemaRecords(), grace.records))
      ? null
      : 'schema';
  }

  /**
   * D08's permission for what follows a permitted write (its pins and its
   * recovery): the records it was admitted on plus this client's own schema
   * record as recordSchema writes it, when the records are exactly that;
   * null when anything else changed since the admission.
   */
  private ownSchemaGrace(grace: SchemaGrace): SchemaGrace | null {
    const own = SCHEMA_PREFIX + this.options.schemaVersion;
    const now = this.schemaRecords();
    const expected: SchemaRecords = grace.records.filter(([k]) => k !== own);
    const admittedOwn = grace.records.find(([k]) => k === own);
    const nowOwn = now.find(([k]) => k === own);
    if (nowOwn !== undefined) {
      if (
        nowOwn[1] !== true &&
        !(admittedOwn !== undefined && Object.is(admittedOwn[1], nowOwn[1]))
      ) {
        return null;
      }
      expected.push(nowOwn);
    }
    expected.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return sameSchemaRecords(now, expected) ? {records: now} : null;
  }

  /**
   * Whether the root's schema records, as they are now, keep this version
   * from writing (a newer or malformed one, see checkSchema).
   */
  private schemaRefuses(): boolean {
    const newest = newestSchema(this._root);
    return (
      malformedSchema(this._root) !== null ||
      (newest !== null && newest > this.options.schemaVersion)
    );
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
      this.unreadable ||
      this.quiesced
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
  private warn<C extends YKnownWarningCode>(
    code: C,
    message: string,
    data: YEmittedWarningData<C>,
  ): void {
    this.pendingWarnings.push(new LexicalWarning(code, message, data));
  }

  /** Run the binding's own work; queued warnings are passed on after it. */
  private guard<T>(fn: () => T): T {
    this.busy++;
    try {
      return fn();
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
    // The refusal of an edit names an earlier warning as its cause: a write
    // checks the layout record itself, so inside an app's transaction that
    // changed it the refusal is queued before the binding reads the record
    // and queues why. The cause goes first.
    const causes = this.pendingWarnings.filter(isReadOnlyCause);
    if (causes.length > 0) {
      const refusals = this.pendingWarnings.filter(isReadOnlyRefusal);
      if (refusals.length > 0) {
        const rest = this.pendingWarnings.filter(w => !isReadOnlyRefusal(w));
        this.pendingWarnings.splice(0, Infinity, ...rest, ...refusals);
      }
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
    const reader = new Reader(this.state, this.seer);
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
        this.$resolvePosition(json, this.seer()),
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
      this.unread = emptyView(this._root, this.keepsShown, this.dropKept);
    }
    this.unread.changes.push(tr);
  }

  /**
   * In write transaction `tr`, split the items at the bounds of what the
   * changes not read yet inserted and deleted (see Unread), which tells
   * them apart by item. Yjs merges the items a change leaves next to items
   * of the same client once the change's transaction ends: a change read
   * later (see deferChange) would otherwise share an item with text the
   * editor shows, and the write would take that text for unread.
   */
  private splitAtUnread(tr: Transaction): void {
    const view = this.unread;
    if (view === null) {
      return;
    }
    for (const change of view.changes) {
      iterateStructsByIdSet(tr, change.insertSet, () => {});
      iterateStructsByIdSet(tr, change.deleteSet, () => {});
    }
    // And at the bounds of what the writes since deleted again (Yjs merges a
    // write's deleted items with those next to them, a change's included):
    // an item counts as deleted again by its first id (see isGoneIn).
    iterateStructsByIdSet(tr, view.removed, () => {});
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
    if (__DEV__) {
      // Development builds only (the whole check is left out of
      // production ones): RAW_YJS_WRITE_WARNING.
      noteRawWrite(
        tr,
        this,
        this._doc,
        this._root,
        this._status === 'pending',
        (message, data) => this.warn(RAW_YJS_WRITE_WARNING, message, data),
      );
    }
    if (__DEV__ && (tr.origin === this || tr.origin === this.followUpOrigin)) {
      this.noteRemoteInWrite(tr);
    }
    if (tr.origin === this.scanOrigin) {
      // Changes nothing (see scanStackItem, getCursor), unless an app's
      // beforeTransaction listener changed the layout record in it: as for
      // the binding's other transactions (see readChange), the record is
      // read once this transaction's caller is done.
      if (this._status === 'active' && this.changedRecord(tr)) {
        this.evaluateSoon();
      }
      return;
    }
    if (this.defersChange(tr)) {
      this.deferChange(tr);
      return;
    }
    if (this.deferred.length > 0 && !this._editor._updating) {
      // Read after those, in the order Yjs applied them, and like them
      // (unread while they are read, its caret taken once they are). (While
      // the editor updates, a remote change is deferred behind them, and the
      // binding's own writes read nothing: see scheduleDeferred.)
      this.deferred.push(tr);
      if (this._doc.gc) {
        this.holdDeleted(tr);
      }
      this.readDeferred();
      return;
    }
    this.readNow(tr);
  }

  /**
   * Development builds: another client's insertions inside a transaction
   * whose origin is this binding's write (or its follow-up), which only a
   * remote update applied from inside it makes (a `beforeTransaction`
   * handler, for example): unsupported (see y.md), reported once per
   * binding, as RAW_YJS_WRITE_WARNING `'remote-in-write'`. Such an update
   * joins the write's transaction instead of being a change of its own,
   * which the binding does not read as remote, and a write that does not
   * show it can delete it. Not a complete detector: a remote deletion
   * there inserts nothing, and a write that joins an app's outer `transact`
   * runs under the app's origin, so neither is reported.
   */
  private noteRemoteInWrite(tr: Transaction): void {
    if (this.reportedRemoteInWrite) {
      return;
    }
    const own = this._doc.clientID;
    let client: number | null = null;
    tr.insertSet.clients.forEach((_ranges, c) => {
      if (c !== own && client === null) {
        client = c;
      }
    });
    if (client === null) {
      return;
    }
    this.reportedRemoteInWrite = true;
    let root = '(a nested type)';
    for (const [name, type] of this._doc.share) {
      if ((type as unknown) === this._root) {
        root = name;
      }
    }
    this.warn(
      RAW_YJS_WRITE_WARNING,
      `client ${client}'s insertions were applied inside the binding's own write transaction (from a beforeTransaction handler, for example): unsupported, the binding does not read them as a remote change, and they can be lost or written again; apply remote updates outside the binding's transactions`,
      {
        key: null,
        kind: 'content',
        origin: String(client),
        reason: 'remote-in-write',
        root,
      },
    );
  }

  /** Whether noteRemoteInWrite reported (once per binding). */
  private reportedRemoteInWrite = false;

  /** Read remote change `tr` now (see onAfterTransaction). */
  private readNow(tr: Transaction): void {
    try {
      this.keepIdentityRecord(tr);
      this.readChange(tr);
    } finally {
      this.reading = false;
      this.dropChange(tr);
      if (this.schemaSeenIn === tr) {
        this.schemaSeenIn = null;
      }
      if (this.unread === null && this.state.hidden === null) {
        pruneEnds(this._doc, tr);
      }
      if (!this._editor._updating) {
        this.releaseUnread(tr);
      } else if (this.heldUnread.has(tr)) {
        // Nested in an update, the read is only queued (see guardedRead),
        // and releases what it holds once it ran; this covers a read that
        // never runs.
        queueMicrotask(() => this.releaseUnread(tr));
      }
    }
    // Deferred while it was read (see scheduleDeferred).
    this.scheduleDeferred();
    this.flushCheckLater();
  }

  /**
   * Self-check what earlier reads rebuilt while changes were deferred or
   * unread (see checkRead), once none is and the editor is idle: where the
   * last change had nothing to read, no read checks them.
   */
  private flushCheckLater(committed = false): void {
    if (
      this.checkLater.size > 0 &&
      this.deferred.length === 0 &&
      this.unread === null &&
      (committed || !this._editor._updating)
    ) {
      this.guard(() => this.checkRead(new Set()));
    }
  }

  /**
   * Whether remote change `tr` is read after the local update the editor is
   * making (a provider applying it from inside `editor.update`, a command or
   * a transform of that update): see deferChange. Not a change of the
   * binding's own, nor one Yjs applies inside a read or an undo the binding
   * runs, which read it there.
   */
  private defersChange(tr: Transaction): boolean {
    const editor = this._editor;
    if (
      this.readsNow > 0 ||
      !editor._updating ||
      tr.origin === this ||
      tr.origin === this.initOrigin ||
      tr.origin === this.followUpOrigin ||
      tr.origin === this.scanOrigin ||
      tr.origin === this.runEndOrigin ||
      (this._undoManager !== null && tr.origin === this._undoManager)
    ) {
      return false;
    }
    return (
      this.deferred.length > 0 ||
      (this._status !== 'pending' && this.readsChanges())
    );
  }

  /**
   * Read remote change `tr` once the local update the editor is making has
   * committed, and been written, instead of in it. Invariant: a local update
   * is written before a remote change is read (see readChange). Why: read
   * in it, the change would replace what the update changed in the lines it
   * touches, and give its commit a collaborator's tags, so that nothing of
   * it is written: the update's text would be lost, in the editor and in
   * the document. Until it is read, the change stays unread (see Unread):
   * the update is written on the document as it was before it, as one
   * committed before a read is. It is read right after the update's commit
   * (see the update listener), or, where the update did not commit (it
   * threw), once the editor is idle.
   */
  private deferChange(tr: Transaction): void {
    this.deferred.push(tr);
    if (this._doc.gc) {
      this.holdDeleted(tr);
    }
    if (this._editor._pendingEditorState === null) {
      // From a commit's listeners or callbacks: in an update of its own,
      // ahead of the updates the app queued there, which commit, and are
      // written, after it.
      this.scheduleDeferred();
    }
    if (this.deferred.length === 1) {
      queueMicrotask(() =>
        this.guard(() => withPins(this._pins, () => this.scheduleDeferred())),
      );
    }
  }

  /**
   * Read the deferred remote changes (see deferChange) where nothing keeps
   * them waiting: now where the editor is idle, else in an update of their
   * own ahead of those the app queued (from a commit's listeners). Not while
   * another change is being read further up (an update the app makes from
   * its listeners, on that read's commit): that read reads them when it
   * ends (see readNow). Why: read in it, the change being read would still
   * count as unread, and the read would not show it.
   */
  private scheduleDeferred(): void {
    const view = this.unread;
    if (
      this.deferred.length === 0 ||
      this.drainingDeferred ||
      (view !== null && view.changes.some(c => !this.deferred.includes(c)))
    ) {
      return;
    }
    if (this.isIdle()) {
      this.readDeferred();
    } else if (
      this._editor._updating &&
      !this.deferredQueued &&
      // An update made while Lexical notifies a commit's listeners (a
      // mutation listener's) waits to commit after them (see the root
      // transform): read into its pending state, the change would carry it
      // under the read's tags, never written. That update's own commit
      // schedules the read (see the update listener).
      !(
        this._editor._pendingEditorState !== null &&
        isDispatchingCommitListeners(this._editor)
      )
    ) {
      this.deferredQueued = true;
      this.queueFirst(
        () => {
          this.deferredQueued = false;
          this.readDeferred();
        },
        {discrete: true, skipTransforms: true, tag: REMOTE_TAGS},
      );
    }
  }

  /**
   * Let Yjs collect what deferred change `tr` deleted, now that it is read
   * (see deferChange), as it would have when the change was applied.
   */
  private releaseUnread(tr: Transaction): void {
    if (!this.heldUnread.delete(tr)) {
      return;
    }
    const doc = this._doc;
    // What no one else keeps (an UndoManager, the binding's own format
    // items) and the app's filter lets go.
    doc.transact(t => tryGc(t, tr.deleteSet, doc.gcFilter), this.scanOrigin);
    const filters = this.gcFilters;
    if (this.heldUnread.size === 0 && filters !== null) {
      // Unless something replaced or wrapped it since: the binding's holds
      // nothing now, and the next hold wraps whatever the document has.
      if (doc.gcFilter === filters.ours) {
        doc.gcFilter = filters.prev;
      }
      this.gcFilters = null;
    }
  }

  /**
   * Keep Yjs from collecting the content deferred change `tr` deleted, which
   * it does right after this (in the change's transaction cleanup), until
   * the change is read: the text the editor still shows stays there for the
   * writes in between (see Unread), which would otherwise write it again.
   * Through the document's `gcFilter`, which the binding wraps while it
   * holds any: an item's `keep` is others' (an UndoManager's), which a
   * release could not tell from its own.
   */
  private holdDeleted(tr: Transaction): void {
    this.heldUnread.add(tr);
    const doc = this._doc;
    if (this.gcFilters !== null && doc.gcFilter === this.gcFilters.ours) {
      return;
    }
    // (Again if the app replaced the filter while the binding held some.)
    const prev = doc.gcFilter;
    const ours = (item: Item) => {
      for (const held of this.heldUnread) {
        if (held.deleteSet.hasId(item.id)) {
          return false;
        }
      }
      return prev(item);
    };
    this.gcFilters = {ours, prev};
    doc.gcFilter = ours;
  }

  /** Read the remote changes deferred so far, in order (see deferChange). */
  private readDeferred(): void {
    // One at a time: those still deferred stay unread while each is read.
    this.drainingDeferred = true;
    try {
      for (
        let tr = this.deferred.shift();
        tr !== undefined;
        tr = this.deferred.shift()
      ) {
        // The selection to keep is the editor's now, on the document as it
        // was before the change (see Unread), not the one before the update
        // the change was applied in.
        this.pendingCursor =
          this._status === 'pending' ? null : this.takeCursor();
        this.readNow(tr);
        if (this._editor._updating && this.deferred.length > 0) {
          // Nested, that read is only queued (see guardedRead), and the
          // next caret (see getCursor) would be the committed state's,
          // without it: read the rest once this update has committed (which
          // the callback makes happen), or once the editor is idle where a
          // commit listener throws before the callbacks run.
          const rest = () =>
            this.guard(() =>
              withPins(this._pins, () => this.scheduleDeferred()),
            );
          $onUpdate(rest);
          queueMicrotask(rest);
          break;
        }
      }
    } finally {
      this.drainingDeferred = false;
    }
    if (this.deferred.length === 0 && this.checkLater.size > 0) {
      // Where the last change had nothing to read (no read, no self-check
      // of what the earlier ones read: see checkRead), once it committed.
      if (this._editor._updating) {
        $onUpdate(() => this.flushCheckLater(true));
      } else {
        this.flushCheckLater();
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
      // The binding's own transaction is not read, but an app's
      // beforeTransaction listener may have changed the layout record in it
      // (every write checks the record itself, see writesEdits): the record
      // is read once this transaction's caller is done.
      if (this._status === 'active' && this.changedRecord(tr)) {
        this.evaluateSoon();
      }
      return;
    }
    if (tr.origin instanceof IdentityLayoutOrigin) {
      // The layout 3 record this client wrote again (see
      // keepIdentityRecord): nothing the editor shows changed, and reading
      // does not depend on the record (every document reads as paired
      // runs).
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
    // An opener that arrived after an end naming it (filling a Skip, or a
    // missing struct): the pairing of what lies between them changed, which
    // the change itself need not touch (see Ident.takePairingChanges).
    // Everything is read again.
    if (takePairingChanges(this._doc)) {
      // The selection is put back where it was (a caret, a composition's
      // caret included): the read gives the lines it is in other nodes.
      const cursor = this._editor
        .getEditorState()
        .read(() => this.$cursorBeforeRead());
      this.readAll(cursor, null, true);
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
        if ([...keys].some(k => isGateKey(k)) && !this.readsRecordedLayout()) {
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
        // The editor shows the change from here on: what the app does on
        // this read's commit (an update of its listeners, a remote change it
        // applies) sees it as read, not as still unread.
        this.reading = false;
        this.dropChange(tr);
      },
      after: () => {
        // Read and committed: what it deleted is the editor's no more (see
        // holdDeleted). Not before the commit: the collection is a
        // transaction, whose observers (an app's awareness cursor) would
        // take the cursor on the editor state before the read.
        this.releaseUnread(tr);
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
          this.pendingCursor = this.takeCursor();
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
    // The composition's node, text and caret before the read (see below).
    const composed = this.$composedCaret();
    const composing = this._editor._compositionKey;
    const reader = new Reader(state, this.seer);
    setRebuilt(reader.rebuilt);
    // What a composition held back whose hold has ended (see $holds) shows
    // first, before this change is read with the composition now going on.
    if (state.hidden !== null && !this.$holds(state.hidden)) {
      this.$release(state, reader);
    }
    reader.composingKey = this.$composingOwner();
    reader.composedAt = this.$composedCharacter(cursor);
    reader.change = tr;
    reader.attrsBefore = (y, keys) => {
      // In the binding's view: the reader asks inside the read, where the
      // view is the binding's (see seer).
      const before = attrsBeforeIn(this.seer(), y, tr);
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
    // A composition whose node the read kept as it was, under a hold, keeps
    // its caret where it is: mapped again from the document (whose items
    // the hold shows differently) it can land on the neighbouring node at a
    // format boundary, and the composition moves with it (Lexical moves the
    // composition key with a point set on another node).
    const keepComposed =
      composed !== null &&
      state.hidden !== null &&
      (() => {
        const now = this.$composedCaret();
        return (
          now !== null &&
          now.key === composed.key &&
          now.text === composed.text &&
          now.offset === composed.offset
        );
      })();
    if (cursor !== null && !keepComposed) {
      // A caret whose line the transaction replaced keeps its offset in the
      // line that replaced it (see $replacedLineCaret); any other selection
      // is mapped by identity.
      if (!keepCaret || !this.$putCaretInReplacedLine(cursor, tr)) {
        this.$restoreSelection(cursor, caret);
      }
    }
    // The hold must not leave the composition's caret where Lexical's own
    // selection normalization moves it, and the composition with it, to
    // another node at the next update (the end of a text node in a link,
    // the start of one after another text node): what the hold shows (a
    // link it keeps beside one that replaced it) can put a boundary there
    // that what is stored does not have. The change is read at once then,
    // with everything held (see $release), as main reads every change.
    if (
      state.hidden !== null &&
      this.predicts &&
      $caretOnMovingBoundary(this._editor)
    ) {
      const held = this.$cursorBeforeRead();
      this.$release(state, reader);
      if (held !== null) {
        this.$restoreSelection(held, caret);
      }
    }
    $clampSelection();
    this.$caretOnText();
    this.$quietSelection();
    // A hold this read started holds the node composed in before it (see
    // noteComposed).
    if (state.hidden !== null && state.hidden.composedKey === null) {
      state.hidden.composedKey = composing;
    }
    // What the editor's next update does to the composition, whatever the
    // check above does not see (an element point resolved to text), once
    // this read has committed and the editor shows it (see
    // foreseeNextUpdate).
    if (
      state.hidden !== null &&
      this._editor._compositionKey !== null &&
      this._editor.getRootElement() !== null
    ) {
      this.pending.add('foresee');
    }
  }

  /**
   * After a remote read that a composition's hold held part of, once it has
   * committed (the editor's DOM and its DOM selection show it): foresee what
   * the editor's next update makes of the composition, read-only (see
   * Boundary.$nextUpdateSelection: the DOM selection read, its points
   * resolved by the current nodes, normalization at boundaries, which moves
   * the composition key with a point that leaves its node; no update, no
   * app code but node methods that read). Where it would move the
   * composition off its node, the hold showed a boundary there that what is
   * stored need not have: the hold ends now (Hidden#missed), and what it
   * held is read, in an ordinary read of the binding's (as flushHidden's,
   * the composition kept where it is), as main reads every change, before
   * the next update.
   */
  private foreseeNextUpdate(): void {
    const editor = this._editor;
    const hidden = this.state.hidden;
    const key = editor._compositionKey;
    if (
      !this.predicts ||
      hidden === null ||
      key === null ||
      editor.getRootElement() === null
    ) {
      return;
    }
    if (!editor.read(() => $foreseesMove(editor, key))) {
      return;
    }
    hidden.missed = true;
    const cursor = this.getCursor();
    let rebuilt: ReadonlySet<CS> = new Set();
    // An ordinary read of the binding's (as flushHidden's), which keeps the
    // composition where it was: Lexical makes this update's selection from
    // the DOM selection too, and would move it as foreseen.
    this.guardedRead({
      $read: () => {
        const state = this.state;
        if (state.hidden !== hidden) {
          return;
        }
        if ($isTextNode($getNodeByKey(key))) {
          $setCompositionKey(key);
        }
        const caret = $showsCaret();
        const reader = new Reader(state, this.seer);
        rebuilt = reader.rebuilt;
        reader.composedAt = this.$composedCharacter(cursor);
        this.$release(state, reader);
        if (cursor !== null) {
          this.$restoreSelection(cursor, caret);
        }
        this.$caretOnText();
        this.$quietSelection();
      },
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
   * Whether the binding foresees what the editor's next update does to a
   * composition under a hold: its check in the read (Boundary's
   * $caretOnMovingBoundary)
   * and after it (foreseeNextUpdate). Tests turn it off to
   * show that a move neither saw still ends the hold, and the editor then
   * shows what is stored (see noteComposed).
   */
  private predicts = true;

  /**
   * After every commit while a hold lasts: note the node the composition
   * runs in. A move to another node that the binding did not see coming
   * (see foreseeNextUpdate: an app's selection transform, a case it does
   * not follow) ends the hold at once (Hidden#missed, see
   * $holds), so that the editor shows what is stored: a move in a remote
   * read (which keeps the composed node under a hold, so any move is the
   * selection put back across a boundary the hold shows), or in a local
   * update to another node of the same line or inline container (Lexical's
   * selection normalization at such a boundary; a write of the composer's
   * own moves it to another line, Enter, which ends the hold anyway).
   */
  private noteComposed(
    hidden: Hidden,
    payload: {tags: Set<string>; editorState: EditorState},
  ): void {
    const key = this._editor._compositionKey;
    if (
      composedMoved(
        hidden.composedKey,
        key,
        payload.tags.has(COLLABORATION_TAG),
        () =>
          payload.editorState.read(() => this.$composingOwner()) ===
          hidden.ownerKey,
      )
    ) {
      hidden.missed = true;
    }
    hidden.composedKey = key;
  }

  /**
   * The composition's text node (attached, its text) and the offset of a
   * collapsed caret in it, or null where the caret is not in it.
   */
  private $composedCaret(): {
    key: NodeKey;
    text: string;
    offset: number;
  } | null {
    const key = this._editor._compositionKey;
    const selection = $getSelection();
    if (
      key === null ||
      !$isRangeSelection(selection) ||
      !selection.isCollapsed() ||
      selection.anchor.type !== 'text' ||
      selection.anchor.key !== key
    ) {
      return null;
    }
    const node = $getNodeByKey(key);
    return $isTextNode(node) && node.isAttached()
      ? {key, offset: selection.anchor.offset, text: node.getTextContent()}
      : null;
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
  /**
   * After a write recovered from a failure while a hold is on: the editor
   * reads the whole document again, so that it shows exactly what is stored
   * (the failed write may have left content the editor does not know of,
   * and the binding's maps part way); a read that fails is recovered once
   * more before the binding fails closed (see recoverRead).
   */
  private rereadAfterRecovery(shown: EditorState, retries = 2): void {
    this.guardedRead({
      $read: () => {
        // The hold ends here, once (its kept format items released, see
        // $release): the whole document is read as it is stored.
        this.$release(this.state, new Reader(this.state, this.seer));
        this.$rebuild();
      },
      after: () => {
        this.checkUnknownTypes();
        this.flushRefresh(true);
      },
      before: () => this.startReading(),
      recover: (readError, readShown) =>
        retries > 0
          ? this.rereadAfterRecovery(readShown, retries - 1)
          : this.recoverRead(readError, readShown, 'reread'),
      tag: REMOTE_TAGS,
    });
  }

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
          this.readsNow++;
          try {
            // Nested, Lexical runs this once the work that queued it has
            // returned (see guard). The read's helpers take this binding's
            // view (see seer), which hides the changes still deferred (see
            // deferChange), and in which the deleted format items a
            // composition's hold keeps read as live (or a kept opener reads
            // without its kept end).
            read.$read();
            this.markReadEnd();
          } catch (error) {
            failure = {error};
            // It is recovered from right after (see read.recover): a
            // selection the failed read left on a removed node must not fail
            // this update's commit too, which would drop an undo or redo the
            // read is part of.
            $setSelection(null);
          } finally {
            this.readsNow--;
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
   * Lexical notifies a selection change in the update of a read of the
   * binding's (see readEnd) where an app's selectionTransform moved the
   * selection or set one of its own, and would run every node transform over
   * what the read brought with it (see $quietSelection). The binding's
   * handler, ahead of every other one, holds the notification for an update
   * of its own once the read has committed, and makes its update run no
   * transforms: a skipTransforms update nested in it makes Lexical normalize
   * text only. Registered again ahead of the others for each read that can
   * run an app's selectionTransform (see markReadEnd), where it is not
   * first.
   */
  private frontSelectionChange(): void {
    const editor = this._editor;
    const listeners = editor._commands.get(SELECTION_CHANGE_COMMAND);
    const first =
      listeners === undefined ? undefined : listeners[4].toArray()[0];
    if (first !== undefined && first === this.onSelectionChange) {
      return;
    }
    this.offSelectionChange();
    this.offSelectionChange = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      this.onSelectionChange,
      COMMAND_PRIORITY_BEFORE_CRITICAL,
    );
  }

  private offSelectionChange: () => void = () => {};

  private readonly onSelectionChange = (): boolean => {
    const editor = this._editor;
    const readEnd = this.readEnd;
    if (readEnd === null || readEnd.state !== editor._pendingEditorState) {
      return false;
    }
    editor.update(() => {}, {skipTransforms: true});
    // What Lexical counts as notified now; once another notification
    // replaces it (the one $quietSelection holds where the read itself
    // moved the selection), this one is not needed.
    const notified = editor._lastNotifiedSelection;
    $onUpdate(() => {
      editor.update(() => {
        if (editor._lastNotifiedSelection === notified) {
          editor.dispatchCommand(SELECTION_CHANGE_COMMAND, undefined);
        }
      });
    });
    return true;
  };

  /**
   * Note what a read made, as its callback returns (see readEnd): a copy of
   * each node it changed (Lexical changes a node already copied in the
   * update in place, so a later change in the update would change the node
   * itself), its NodeState included.
   */
  private markReadEnd(): void {
    const editor = this._editor;
    const pending = editor._pendingEditorState;
    this.readEnd = null;
    if (pending === null) {
      return;
    }
    // Nothing of the app's runs in the update after the read unless an
    // update is queued behind it or the selection's text has a
    // selectionTransform of its own (Lexical calls the anchor's and the
    // focus's; the read runs no node transforms, see frontSelectionChange):
    // no copies then.
    const selection = pending._selection;
    const transforms = (point: PointType) => {
      const node = pending._nodeMap.get(point.key);
      return (
        point.type === 'text' &&
        $isTextNode(node) &&
        (node.selectionTransform !== BASE_SELECTION_TRANSFORM.fn ||
          !BASE_SELECTION_TRANSFORM.doesNothing)
      );
    };
    if (
      editor._updates.length === 0 &&
      !(
        $isRangeSelection(selection) &&
        (transforms(selection.anchor) || transforms(selection.focus))
      )
    ) {
      return;
    }
    const nodes = new Map<NodeKey, LexicalNode | undefined>();
    const note = (key: NodeKey) => {
      const node = pending._nodeMap.get(key);
      if (node === undefined) {
        nodes.set(key, undefined);
        return;
      }
      const copy = $cloneWithProperties(node);
      if (copy.__state !== undefined) {
        copy.__state = copy.__state.getWritable(copy);
      }
      // $setSlot changes the slot map of a node already copied in the update
      // in place.
      const slotted = copy as {__slots?: null | Map<string, NodeKey>};
      if (slotted.__slots !== undefined && slotted.__slots !== null) {
        slotted.__slots = new Map(slotted.__slots);
      }
      nodes.set(key, copy);
    };
    for (const key of editor._dirtyLeaves) {
      note(key);
    }
    for (const key of editor._dirtyElements.keys()) {
      note(key);
    }
    this.readEnd = {nodes, state: pending};
    this.frontSelectionChange();
  }

  /**
   * Write what an app's code changed in the update of a read of the
   * binding's, after the read (see readEnd): the selection's transforms
   * (TextNode#selectionTransform), updates queued behind the read. Its
   * commit is tagged as a remote change, which is not written: where the
   * content of a top-level block or the order of the blocks differs from
   * what the read left (see $readEditsShow), the nodes that changed after
   * the read, and their parents, are written as a change of this client's
   * (not in the undo history), over the state the read made; while read
   * only, read again, as a local change is (see onUpdate). Lexical's merge
   * of adjacent text nodes is no change, nor are the fields it derives as it
   * renders (see isDerivedField). The update runs no node transforms (see
   * frontSelectionChange).
   *
   * Invariant: the editor never shows a change that is neither stored nor
   * read again. Why: no other client has it, and the editor's next edit
   * would be written on content the document does not have.
   */
  private $writeReadEdits(
    readEnd: NonNullable<YBinding['readEnd']>,
    payload: UpdatePayload,
    transformed: ReadonlySet<NodeKey>,
  ): void {
    const {editorState, prevEditorState} = payload;
    const now = editorState._nodeMap;
    const before = prevEditorState._nodeMap;
    const read = (key: NodeKey) =>
      readEnd.nodes.has(key) ? readEnd.nodes.get(key) : before.get(key);
    // A node's parent, or the host of the named slot it fills.
    const parentOf = (node: LexicalNode): NodeKey | null =>
      node.__parent ??
      (node as {__slotHost?: null | NodeKey}).__slotHost ??
      null;
    // Attached as the read left it (a node it removed is collected by
    // Lexical as it commits: no change).
    const attached = (node: LexicalNode | undefined): boolean => {
      for (let at = node; at !== undefined; ) {
        if (at.__key === 'root') {
          return true;
        }
        const parent = parentOf(at);
        at = parent === null ? undefined : read(parent);
      }
      return false;
    };
    // Whether there is text in a node, by its children in `get`.
    const textIn = (
      node: LexicalNode,
      get: (k: NodeKey) => LexicalNode | undefined,
    ): boolean => {
      if ($isTextNode(node)) {
        return true;
      }
      if (!$isElementNode(node)) {
        return false;
      }
      for (let key = node.__first; key !== null; ) {
        const child = get(key);
        if (child === undefined) {
          return false;
        }
        if (textIn(child, get)) {
          return true;
        }
        key = child.__next;
      }
      return false;
    };
    // A node the read changed is compared with its copy (see markReadEnd),
    // NodeState included (a field JSON does not enumerate).
    const sameAll = (x: LexicalNode, y: LexicalNode): boolean => {
      try {
        const all = (
          n: LexicalNode,
          get: (k: NodeKey) => LexicalNode | undefined,
        ) => {
          const hasText = textIn(n, get);
          const slots = (n as {__slots?: null | Map<string, NodeKey>}).__slots;
          return JSON.stringify([
            JSON.stringify(n, (k, v) =>
              isDerivedField(n, k, hasText) ? undefined : v,
            ),
            n.__state === undefined ? null : n.__state.toJSON(),
            slots === undefined || slots === null ? null : [...slots],
          ]);
        };
        return all(x, k => now.get(k)) === all(y, read);
      } catch (_e) {
        return false;
      }
    };
    const dirtyElements = new Map<NodeKey, boolean>();
    const dirtyLeaves = new Set<NodeKey>();
    const merged = payload.normalizedNodes ?? new Set<NodeKey>();
    for (const key of new Set([
      ...payload.dirtyLeaves,
      ...payload.dirtyElements.keys(),
    ])) {
      const after = now.get(key);
      const then = read(key);
      if (
        after === then ||
        (after === undefined && !attached(then)) ||
        (after !== undefined &&
          then !== undefined &&
          readEnd.nodes.has(key) &&
          sameAll(after, then))
      ) {
        continue;
      }
      if ($isElementNode(after ?? then)) {
        dirtyElements.set(key, true);
      } else {
        dirtyLeaves.add(key);
      }
    }
    if (dirtyElements.size === 0 && dirtyLeaves.size === 0) {
      return;
    }
    // Their parents, as they are and as the read left them: a node moved
    // within its parent changes the order of the parent's children, and not
    // the parent's own fields.
    for (const key of [...dirtyElements.keys(), ...dirtyLeaves]) {
      for (const node of [now.get(key), read(key)]) {
        const parent = node === undefined ? null : parentOf(node);
        if (parent !== null && now.has(parent)) {
          dirtyElements.set(parent, true);
        }
      }
    }
    const map = new Map(before);
    for (const [key, node] of readEnd.nodes) {
      if (node === undefined) {
        map.delete(key);
      } else {
        map.set(key, node);
      }
    }
    const ReadState = prevEditorState.constructor as new (
      nodeMap: Map<NodeKey, LexicalNode>,
      selection: null,
      slotsUsed: boolean,
    ) => EditorState;
    const readState = new ReadState(map, null, prevEditorState._slotsUsed);
    readState._readOnly = true;
    // While a composition's hold holds a collaborator's change, an edit
    // that would delete or write anew a shared node around it is refused, as
    // a local one is (see Writer#$endangersHeld), whether it shows or not: a
    // node replaced by one with another key, say, which shows the same, is
    // not where the hold's changes are read to when it ends.
    const hidden = this.state.hidden;
    // The text edits Lexical recorded in the read's update (the read's own
    // and the app's): what they say was merged where is evidence for the
    // hold's decision (see $insertsCharacters).
    const heldLog =
      editorState._textEdits === null
        ? null
        : (editorState._textEdits.get(prevEditorState._nodeMap) ?? null);
    if (
      hidden !== null &&
      editorState.read(
        () =>
          $heldDecision(
            this.state,
            hidden,
            readState,
            this.remoteUnread(),
            heldLog,
          ).refuse,
      )
    ) {
      this.$refuseHeld(dirtyElements, dirtyLeaves, editorState, readState);
      return;
    }
    // Whether the app's code changed what the editor shows: the content of
    // each top-level block a node it changed is in (its JSON with its
    // children, NodeState included, adjacent text that differs only in its
    // text as one, see $deepJSON: Lexical's merge of text nodes is no
    // change), or the order of the blocks.
    if (
      !this.$readEditsShow(dirtyElements, dirtyLeaves, editorState, readState)
    ) {
      return;
    }
    if (!this.writesEdits()) {
      this.$refuseChanged(dirtyElements, dirtyLeaves, editorState, readState);
      this.$refuseUnstorableSlotHosts(
        dirtyElements,
        editorState,
        this._editor._compositionKey !== null,
      );
      return;
    }
    // As for a local commit (see onUpdate): fail closed on slots the
    // document cannot store.
    if (this.refuseUnstorableSlots(editorState, dirtyElements.keys())) {
      return;
    }
    const commit: Commit = {
      followUp: false,
      naming: false,
      normalize: false,
      // This client's code made the edit (not every client, as a follow-up
      // is): it carries this client's schema version (D08), though out of
      // the undo history (D111).
      recordOwnSchema: true,
      refresh: false,
      registration: false,
      remote: false,
      scansGroups: false,
      skip: false,
      userEdit: false,
    };
    const state = this.state;
    // The groups whose derived fields the edit changes (list item values),
    // refreshed as after a local commit (see $groupsToRefresh): the read's
    // update ran no transforms.
    const localKeys = this.$groupsToRefresh(
      editorState,
      readState,
      dirtyElements,
      transformed,
    );
    this.readEditLog = heldLog;
    try {
      editorState.read(() =>
        this.$writeCommit(
          state,
          commit,
          editorState,
          readState,
          dirtyElements,
          dirtyLeaves,
          transformed,
          localKeys,
          merged,
          // The update's moves, keyed by the editor's state before the read
          // (see $writeCommit). Not while a composition holds changes back:
          // there the edit is written as before, rewriting what the cheaper
          // rewrite picks, which is how the hold's decision about it (see
          // $heldDecision) was made.
          state.hidden === null ? prevEditorState : readState,
        ),
      );
    } finally {
      this.readEditLog = null;
    }
    this.queueCommitFollowUps(state, commit, localKeys, false);
    this.readBackUnstored(editorState, dirtyLeaves);
  }

  /**
   * Refuse a change made while a composition's hold holds a collaborator's
   * change, which would delete or write anew a shared node around it (see
   * $changesHeldStructure): the editor reads the document again, the change
   * undone, and the hold ends, so the editor shows the collaborator's text.
   * The binding stays active.
   */
  private $refuseHeld(
    dirtyElements: Map<NodeKey, boolean>,
    dirtyLeaves: Set<NodeKey>,
    editorState: EditorState,
    prevEditorState: EditorState,
  ): void {
    this.warn(
      UNSUPPORTED_EDIT_WARNING,
      'a local change was not written: it would delete or leave behind text a collaborator wrote in the line being composed, which the composition holds back; the editor reads the document again',
      {reason: 'held-composition'},
    );
    this.$refuseChanged(
      dirtyElements,
      dirtyLeaves,
      editorState,
      prevEditorState,
    );
    this.pending.add('reread');
    if (this.state.hidden !== null) {
      this.state.hidden.missed = true;
    }
  }

  /**
   * The shared nodes in which a remote change not read yet (unread, or
   * deferred to after the running update, D108) deletes text: there what
   * the editor showed is not what is stored (see $heldDecision).
   */
  private remoteUnread(): Set<YNode> {
    const out = new Set<YNode>();
    const changes = [
      ...(this.unread === null ? [] : this.unread.changes),
      ...this.deferred,
    ];
    for (const tr of changes) {
      tr.deleteSet.clients.forEach((ranges, client) => {
        const structs = this._doc.store.clients.get(client);
        if (structs === undefined) {
          return;
        }
        for (const {clock, len} of ranges.getIds()) {
          for (
            let i = findIndexSS(structs, clock);
            i < structs.length && structs[i].id.clock < clock + len;
            i++
          ) {
            const s = structs[i];
            if (s instanceof Item && s.content instanceof ContentString) {
              out.add(s.parent as YNode);
            }
          }
        }
      });
    }
    return out;
  }

  /** See $writeReadEdits. */
  private $readEditsShow(
    dirtyElements: ReadonlyMap<NodeKey, boolean>,
    dirtyLeaves: ReadonlySet<NodeKey>,
    editorState: EditorState,
    readState: EditorState,
  ): boolean {
    const editor = this._editor;
    const tops = (state: EditorState, keys: Iterable<NodeKey>) =>
      state.read(
        () => {
          const out = new Set<NodeKey>();
          for (const key of keys) {
            const node = $getNodeByKey(key);
            if (node === null) {
              continue;
            }
            if ($isRootNode(node)) {
              out.add('root');
              continue;
            }
            // The root's child it is in, by its parents (or slot hosts): the
            // read's update runs no transforms, so it can leave a shape
            // getTopLevelElement throws on (inline content right under a
            // shadow root).
            let at: LexicalNode | null = node;
            while (at !== null) {
              const parent: NodeKey | null =
                at.__parent ??
                (at as {__slotHost?: null | NodeKey}).__slotHost ??
                null;
              if (parent === 'root') {
                out.add(at.getKey());
                break;
              }
              at = parent === null ? null : $getNodeByKey(parent);
            }
          }
          return out;
        },
        {editor},
      );
    const keys = [...dirtyElements.keys(), ...dirtyLeaves];
    const blocks = new Set([
      ...tops(editorState, keys),
      ...tops(readState, keys),
    ]);
    const shown = (state: EditorState, key: NodeKey) =>
      state.read(
        () => {
          const node = $getNodeByKey(key);
          if (node === null || !node.isAttached()) {
            return null;
          }
          if ($isRootNode(node)) {
            return JSON.stringify(node.getChildrenKeys());
          }
          return JSON.stringify($deepJSON(node, null, null, true));
        },
        {editor},
      );
    for (const key of blocks) {
      if (shown(editorState, key) !== shown(readState, key)) {
        return true;
      }
    }
    return false;
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
    const reader = new Reader(this.state, this.seer);
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
    const cursor = this.takeCursor();
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
        const reader = new Reader(state, this.seer);
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
    if (hidden.missed) {
      return false;
    }
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
    // The binding's view, once: this check changes nothing it depends on.
    const view = this.seer();
    for (const [parent, items] of this.hiddenItems(hidden)) {
      for (const it of items) {
        if (isGoneIn(view, it)) {
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
        while (
          end !== null &&
          !inLine.has(end) &&
          !isShownEndIn(view, end, hidden)
        ) {
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
        [...hidden.marker.ends].every(
          end => end === unit.end || isGoneIn(view, end),
        ))
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
    hidden.releaseKeeps();
    const items = this.hiddenItems(hidden);
    // The format items held changes deleted, which the line showed until
    // now (see Hidden#keeps): read where they were, as a deletion that just
    // arrived (what follows them may start differently).
    for (const it of hidden.keptItems()) {
      if (it.parent instanceof YNode && this.state.containers.has(it.parent)) {
        const list = items.get(it.parent);
        if (list === undefined) {
          items.set(it.parent, [it]);
        } else {
          list.push(it);
        }
      }
    }
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
    // Where the node composed in, or the text node the composition ran in,
    // is gone, however that came about, where the held changes were read to
    // is not certain: every container that holds one is read again, whole
    // (the root, where a container's node is gone too).
    const gone = (key: NodeKey | null) => {
      const node = key === null ? null : $getNodeByKey(key);
      return key !== null && (node === null || !node.isAttached());
    };
    if (gone(hidden.ownerKey) || gone(hidden.composedKey)) {
      const rootCs = state.containers.get(this._root);
      reader.$reading(() => {
        for (const y of items.keys()) {
          const cs = state.containers.get(y);
          const el =
            cs === undefined
              ? null
              : y === this._root
                ? $getRoot()
                : $getNodeByKey(cs.key);
          if (cs !== undefined && $isElementNode(el) && el.isAttached()) {
            reader.$readFull(cs, el);
          } else if (rootCs !== undefined) {
            reader.$readFull(rootCs, $getRoot());
            return;
          }
        }
      });
    }
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
    const fold = this.stepFold;
    this.stepFold = null;
    const um = this._undoManager;
    if (fold === null || um === null || fold.state !== payload.editorState) {
      this.onUpdateInner(payload);
      if (
        fold !== null &&
        fold.state === null &&
        this.stepFold === null &&
        payload.tags.has(COLLABORATION_TAG)
      ) {
        // A collaborator's change read before the step's normalization ran
        // writes no step of this client's: it waits on.
        this.stepFold = fold;
      }
      return;
    }
    const {undoing, redoing} = um;
    if (fold.undo) {
      um.undoing = true;
    } else {
      um.redoing = true;
    }
    try {
      this.onUpdateInner(payload);
    } finally {
      um.undoing = undoing;
      um.redoing = redoing;
      foldFollowUps(
        fold.undo ? um.redoStack : um.undoStack,
        fold.base,
        fold.item,
      );
    }
    if (fold.state !== null && this.stepFold === null) {
      // The author's normalization of what the step's read brought, once
      // the editor is idle (see normalizeUntransformed), is part of it too.
      this.stepFold = {...fold, state: null};
    }
  }

  private onUpdateInner(payload: UpdatePayload): void {
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
    const readEnd = this.readEnd;
    this.readEnd = null;
    if (
      readEnd !== null &&
      readEnd.state === editorState &&
      !commit.skip &&
      (this.writesEdits() || this.readsChanges())
    ) {
      // A read of the binding's, after which an app's code changed nodes in
      // its update (see $writeReadEdits).
      this.$writeReadEdits(readEnd, payload, transformed);
    }
    if (commit.refresh && !commit.registration) {
      // See $refreshGroups: only users' own edits write.
      this.state.refresh.clear();
      return;
    }
    let grace: SchemaGrace | null = null;
    if (this.writesEdits() && !commit.remote && !commit.skip) {
      if (this.schemaGatesWrite(editorState)) {
        // Made on a schema record a newer version wrote: read only first, so
        // that it is refused below.
        this.gateSchema();
      } else if (this.schemaRefuses()) {
        // Made before a schema record it did not see (D08): written, on
        // exactly these records (see admitsIn).
        grace = {records: this.schemaRecords()};
      }
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
        refused =
          this.$refuseUnstorableSlotHosts(
            dirtyElements,
            editorState,
            composing,
          ) || refused;
      }
      if (refused) {
        this.refusals++;
        if (commit.naming) {
          this.refusedNaming = true;
        }
        if (commit.userEdit) {
          this.rereads = 0;
          if (this._status === 'active') {
            // Refused only by the record as it was when it wrote (see
            // recordAdmits): no earlier warning names a cause.
            this.warnRefusedAtWrite('layout');
          } else if (!this.warnedEdit) {
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
      if (
        this.emptyHeld.size > 0 &&
        this.writesEdits() &&
        !commit.remote &&
        !commit.skip
      ) {
        // A commit that moves only the selection can take the caret out of
        // an emptied node held for it (see readBackUnstored).
        this.readBackUnstored(editorState, new Set());
      }
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
    this.writeGrace = grace;
    try {
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
    } finally {
      this.writeGrace = null;
    }
    if (this.layoutChangedInWrite) {
      // Refused inside its transaction (see $writeCommit): the binding's own
      // transaction is not read as a change, so the record is read here.
      this.layoutChangedInWrite = false;
      this.evaluate();
      return;
    }
    this.queueCommitFollowUps(state, commit, localKeys, untransformed);
    this.readBackUnstored(editorState, dirtyLeaves);
  }

  /**
   * Read back what a written local commit left in the editor that the
   * document does not store: an empty text node Lexical keeps (not mergeable simple text) (a
   * token, segmented or code highlight node, a subclass; text is stored as
   * characters, and Lexical removes only empty mergeable simple text). The containers
   * holding such text nodes are read again, so that no client shows what the
   * others and a fresh reader do not; reported (UNSUPPORTED_EDIT_WARNING,
   * `'unstorable'`). A node the collapsed caret or the composition is in is
   * held (emptyHeld) and checked again on each later local commit, a commit
   * that only moves the selection included. NodeState on
   * the root is not stored either, but is left as it is: apps keep document
   * metadata there and share it themselves.
   */
  private readBackUnstored(
    editorState: EditorState,
    dirtyLeaves: Set<NodeKey>,
  ): void {
    const capped = this.rereads > MAX_REREADS;
    const empty: NodeKey[] = [];
    const composing = this._editor._compositionKey;
    editorState.read(() => {
      const selection = $getSelection();
      const caret =
        $isRangeSelection(selection) && selection.isCollapsed()
          ? selection.anchor.key
          : null;
      for (const key of [...dirtyLeaves, ...this.emptyHeld]) {
        const node = $getNodeByKey(key);
        if (
          !$isTextNode(node) ||
          node.__text !== '' ||
          isMergeableText(node) ||
          !node.isAttached()
        ) {
          this.emptyHeld.delete(key);
        } else if (key === composing || key === caret || capped) {
          // Lexical keeps an emptied node the caret or a composition is in
          // while native input goes on (and removes it itself, on some
          // platforms a moment later): checked again on a later commit. So
          // is one found once the last re-read in a row was made (see
          // MAX_REREADS): an app's code that empties such a node again in
          // each read's update is not read back again until a user's edit
          // resets the count, so that it cannot loop.
          this.emptyHeld.add(key);
        } else {
          this.emptyHeld.delete(key);
          empty.push(key);
        }
      }
    });
    if (empty.length === 0) {
      return;
    }
    const into = composing === null ? this.refused : this.refusedComposing;
    for (const key of empty) {
      this.addContainerOf(key, editorState._nodeMap, into);
    }
    if (into === this.refused) {
      this.pending.add('reread');
    }
    this.warn(
      UNSUPPORTED_EDIT_WARNING,
      'a local update left an empty text node Lexical keeps (not mergeable simple text), which the document does not store: the editor reads it back',
      {reason: 'unstorable'},
    );
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
    movedBefore: EditorState = prevEditorState,
  ): void {
    const roles = new Roles(state);
    const plan = Writer.$plan(
      roles,
      dirtyElements,
      dirtyLeaves,
      prevEditorState,
    );
    plan.merged = merged;
    // Lexical's record of the nodes the update moved, keyed by the state it
    // started from: for an app's edit in a read, the editor's state before
    // the read, not the read's own state the edit is written on (see
    // $writeReadEdits).
    const movedNodes = editorState._movedNodes;
    plan.moved =
      movedNodes === null ? null : movedNodes.get(movedBefore._nodeMap);
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
        ? this.splitWhileUnread(() =>
            prevEditorState.read(() => {
              try {
                return this.$captureCursor();
              } catch (_e) {
                return null;
              }
            }),
          )
        : null;
    const written = this.$runWriter(
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
    if (written === 'held') {
      // Refused before it changed anything (see Writer#$endangersHeld).
      this.writeCursor = null;
      this.$refuseHeld(
        dirtyElements,
        dirtyLeaves,
        editorState,
        prevEditorState,
      );
      return;
    }
    if (written instanceof Refusal) {
      // The layout record changed inside the write's own transaction: the
      // change is refused as on a read-only binding (read again once it can
      // be), and the record is read once the commit is done (see onUpdate).
      this.writeCursor = null;
      this.refusals++;
      if (commit.userEdit) {
        this.warnRefusedAtWrite(written.record);
      }
      this.$refuseChanged(
        dirtyElements,
        dirtyLeaves,
        editorState,
        prevEditorState,
        this._editor._compositionKey !== null
          ? this.refusedComposing
          : this.refused,
      );
      this.layoutChangedInWrite = true;
      return;
    }
    const writer = written;
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
        this.seer(),
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
  ): Writer | null | Refusal | 'held' {
    let writer: Writer | null = null;
    // Inside an app's outer transaction that restored ends (an undo in it):
    // repair the copies before anything reads pairing (see Ident).
    repairPendingCopies(this._doc);
    let refused: 'layout' | 'schema' | null = null;
    let heldRefused = false;
    let stoppedPartWay = false;
    // Admitted once, for the whole write: its pins and its recovery too,
    // which see the records as this write left them (`after`).
    const grace = this.writeGrace;
    let after = grace;
    // While a hold is on: each node's shared node before the write, and the
    // first clock it would write at (see the recovery of a stopped write).
    const heldSnapshot = state.hidden === null ? null : new Map(state.yByKey);
    const heldContainers =
      state.hidden === null ? null : new Map(state.csByKey);
    // The first clock the write itself writes at: taken again inside its
    // transaction, after every beforeTransaction listener ran (what they
    // wrote, here or on another root, is not the write's).
    let clockBefore = this._doc.store.getClock(this._doc.clientID);
    // While a hold is on: the binding's maps before the write, so that a
    // write that fails part way can be undone inside its transaction (see
    // $undoAttempt).
    const restoreMaps = state.hidden === null ? null : state.snapshotMaps();
    // Undo, inside the running transaction, what a failed attempt did: what
    // it inserted is deleted again (no peer ever sees it: a peer gets the
    // transaction's net result), the maps are put back as they were before
    // the write, and what the attempt deleted of what was stored before
    // (a shared node, a line's marker) is forgotten by them, so that the
    // next attempt writes it anew.
    const $undoAttempt = (tr: Transaction): void => {
      const client = this._doc.clientID;
      const structs = this._doc.store.clients.get(client);
      if (structs !== undefined) {
        for (let i = structs.length - 1; i >= 0; i--) {
          const struct = structs[i];
          if (struct.id.clock < clockBefore) {
            break;
          }
          // Exactly what the write inserted (its own mutations, bracketed
          // where it makes them, see Owned.ts), and under this binding's root
          // only: never what another binding, or an app joined to the
          // transaction, wrote in it, nested in the write or before it.
          if (
            struct instanceof Item &&
            !struct.deleted &&
            isOwned(ownedRanges, struct.id.clock) &&
            struct.parent instanceof YNode &&
            this.ownsUnderRoot(struct.parent)
          ) {
            struct.delete(tr);
          }
        }
      }
      if (restoreMaps !== null) {
        restoreMaps();
      }
      const deletedHere = (it: Item | null): boolean =>
        it !== null && it.deleted && tr.deleteSet.hasId(it.id);
      for (const y of [...state.yByKey.values()]) {
        if (deletedHere(y._item)) {
          state.unmapTree(y);
        }
      }
      for (const cs of state.csByKey.values()) {
        if (cs.units.some(u => deletedHere(u.end))) {
          for (const u of cs.units) {
            if (deletedHere(u.end)) {
              state.dropUnit(u);
            }
          }
          cs.units = cs.units.filter(u => !deletedHere(u.end));
        }
      }
    };
    // Whether `y` holds an item another client wrote (anywhere under it).
    const holdsForeign = (y: YNode): boolean => {
      const client = this._doc.clientID;
      const visit = (it: Item | null): boolean => {
        if (it === null) {
          return false;
        }
        if (it.id.client !== client && !it.deleted) {
          return true;
        }
        return (
          it.content instanceof ContentType &&
          holdsForeign(it.content.type as YNode)
        );
      };
      for (let it = y._start; it !== null; it = it.right) {
        if (visit(it)) {
          return true;
        }
      }
      let found = false;
      y._map.forEach(it => {
        found = found || visit(it);
      });
      return found;
    };
    const $dropStoppedCopies = (tr: Transaction): number => {
      if (heldSnapshot === null) {
        return 0;
      }
      // The write stopped part way may already have written a node anew
      // elsewhere (a copy of a shared node holding held content), or
      // unmapped one it had not deleted yet. First every such copy is
      // deleted from storage (Yjs only, so that a fault in what follows
      // leaves no copy for a peer to type into), then each node maps to its
      // shared node again, which the recovery writes in place. Run again
      // (a recovery of a recovery), it finishes what a fault left.
      const restore: [NodeKey, YNode][] = [];
      for (const [key, was] of heldSnapshot) {
        const now = state.yByKey.get(key);
        if (now === was || was._item === null || was._item.deleted) {
          continue;
        }
        if (
          now !== undefined &&
          (now._item === null ||
            now._item.id.client !== this._doc.clientID ||
            now._item.id.clock < clockBefore)
        ) {
          continue;
        }
        if (now !== undefined && !now._item!.deleted) {
          // A copy a peer already wrote into (published by an earlier
          // transaction): kept, so that what the peer wrote is never lost.
          if (holdsForeign(now)) {
            continue;
          }
          now._item!.delete(tr);
        }
        restore.push([key, was]);
      }
      for (const [key, was] of restore) {
        const now = state.yByKey.get(key);
        if (now !== undefined && now !== was) {
          state.unmapTree(now);
        }
        // Its container as it was, with its units (the stopped write may
        // have dropped them when it wrote the copy).
        const cs =
          heldContainers === null ? undefined : heldContainers.get(key);
        if (cs !== undefined && cs.y === was && !state.containers.has(was)) {
          state.containers.set(was, cs);
          for (const u of cs.units) {
            state.setUnit(u);
          }
        }
        if (state.yByKey.get(key) !== was) {
          state.mapNode(key, was);
        }
      }
      return restore.length;
    };
    // A write the guard stopped after it had changed something: finished in
    // the same transaction, so that no peer ever sees what it left (a copy
    // a peer could type into). Its copies of what the hold keeps are deleted,
    // the rest of the change is written, what the hold keeps stays where it
    // is stored, and the editor reads the document again.
    let recovered: {error: unknown; reread: boolean} | null = null;
    // The clock ranges this write's own mutations made (see Owned.ts).
    const ownedRanges: OwnedRanges = [];
    try {
      this._doc.transact(
        tr =>
          collectOwned(state, ownedRanges, () => {
            clockBefore = this._doc.store.getClock(this._doc.clientID);
            // Admitted inside the transaction, after every beforeTransaction
            // listener of the document ran (any may change the layout record or
            // the schema record before anything is written): refused, nothing
            // is written.
            refused = this.refusalIn(grace);
            if (refused !== null) {
              return;
            }
            // Development builds: the binding's own write, even when it joined
            // an app's transaction (see noteRawWrite).
            if (__DEV__) {
              markBindingWrite(tr);
            }
            this.splitAtUnread(tr);
            try {
              writer = new Writer(
                state,
                roles,
                tr,
                prevEditorState,
                plan,
                this.seer,
              );
              writer.followUp = commit.followUp;
              writer.remoteUnread = this.remoteUnread();
              writer.heldLog = this.readEditLog ?? plan.textEdits ?? null;
              // What a composition holds back is never deleted by a write in a
              // shape the writer cannot carry it through (see
              // Writer#$endangersHeld): such a write is refused before it
              // changes anything.
              if (writer.$endangersHeld()) {
                heldRefused = true;
                return;
              }
              writer.$run();
            } catch (err) {
              // While a hold is on, a write that throws part way (the guard's
              // stop, or any fault) is finished in this transaction, so that no
              // peer ever gets what it left (a copy of a node holding held
              // content, which a peer could type into): its copies of those
              // nodes are deleted, and the rest of A's change is written, a
              // change that inserts no character in skip mode (what the hold
              // keeps is neither copied nor deleted), one that inserts never
              // stopped. Then the editor reads the whole document again.
              const decided = writer === null ? null : writer.heldDecision;
              const wrote =
                tr.insertSet.clients.size > 0 || tr.deleteSet.clients.size > 0;
              const stopped = err instanceof HeldDeletionError;
              const freeOfInsertions = decided !== null && !decided.inserts;
              // A change that inserts characters is recovered as on main (see
              // the recovery outside this transaction): written as made, what the
              // hold keeps included, never stopped.
              if (
                state.hidden === null ||
                !freeOfInsertions ||
                (stopped && !wrote) ||
                commit.followUp
              ) {
                throw err;
              }
              stoppedPartWay = true;
              // Attempts, all in this transaction, each from the state before
              // the write (see $undoAttempt): a recovery that fails too is
              // undone and tried again, up to MAX_RECOVERY_ATTEMPTS.
              for (let attempt = 1; ; attempt++) {
                try {
                  $undoAttempt(tr);
                  const all: WritePlan = {
                    attrs: new Set(state.yByKey.keys()),
                    inline: new Set(),
                    lines: new Set(state.unitByKey.keys()),
                    merged: plan.merged,
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
                    this.seer,
                  );
                  rewriter.rewriteAll = true;
                  if (freeOfInsertions) {
                    rewriter.decideAs(decided);
                    rewriter.skipProtected = true;
                  } else {
                    rewriter.remoteUnread = true;
                    rewriter.neverStop = true;
                  }
                  rewriter.followUp = commit.followUp;
                  try {
                    rewriter.$run();
                  } catch (again) {
                    // Stopped again (nothing the guard protects is deleted).
                    if (!(again instanceof HeldDeletionError)) {
                      throw again;
                    }
                  }
                  this.noteRefused(rewriter, commit.naming);
                  break;
                } catch (again) {
                  if (attempt >= MAX_RECOVERY_ATTEMPTS) {
                    // Given up on here: the last attempt undone too (no attempt
                    // is ever published), and the recovery outside this
                    // transaction takes over.
                    $undoAttempt(tr);
                    throw again;
                  }
                }
              }
              // A change that inserts no character left what the hold keeps
              // where storage keeps it: the editor reads the whole document
              // again. One that inserts is written as the editor shows it.
              recovered = {error: err, reread: true};
              return;
            } finally {
              // A local edit (not a follow-up, which is no one's edit) carries
              // this client's schema version, and so does an app edit written
              // out of the undo history (recordOwnSchema); a write refused for
              // what a composition holds back writes nothing.
              if (!heldRefused && (origin === this || commit.recordOwnSchema)) {
                recordSchema(this._root, this.options.schemaVersion, tr, t =>
                  this.isUnderRoot(t),
                );
              }
              // In the same transaction as the first member entry of a set, even
              // when the write throws part way: clients that only read layout 1
              // never get one without the version that tells them they cannot
              // read it.
              recordSetMembersLayout(this._root, tr);
              // A write D08 permits may record this client's own schema version
              // (its first write at it): its pins and its recovery are admitted
              // on the records it was admitted on plus exactly that record, and
              // on nothing else (a peer's change during the write revokes it).
              if (grace !== null) {
                after = this.ownSchemaGrace(grace);
              }
            }
          }),
        origin,
      );
      // Set inside the callback (TypeScript does not see that assignment).
      const refusedBy = refused as 'layout' | 'schema' | null;
      if (refusedBy !== null) {
        return new Refusal(refusedBy);
      }
      if (heldRefused) {
        return 'held';
      }
      const inline = recovered as {error: unknown; reread: boolean} | null;
      if (inline !== null) {
        this.warn(
          RECOVERED_WRITE_WARNING,
          'a local change could not be written: ' +
            String(
              inline.error instanceof Error
                ? inline.error.message
                : inline.error,
            ),
          {error: inline.error, reason: 'local-change'},
        );
        if (inline.reread) {
          this.rereadAfterRecovery(prevEditorState);
        }
        return null;
      }
      if (!commit.followUp) {
        this._doc.transact(tr => {
          // Admitted inside its own transaction too (see the write's): a
          // record that stopped admitting writes gets no pin, and is read
          // (see readChange).
          if (!this.admitsIn(after)) {
            return;
          }
          // Development builds: the binding's own write, even when it joined
          // an app's transaction (see noteRawWrite).
          if (__DEV__) {
            markBindingWrite(tr);
          }
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
      if (
        state.hidden !== null &&
        e instanceof HeldDeletionError &&
        !stoppedPartWay
      ) {
        // A write the hold's guard stopped (it inserts no character, see
        // withProtected) before it changed anything: refused, and read
        // again, not rewritten from what the editor shows. Stopped after it
        // changed something, it is rewritten whole below: a re-read of what
        // it left would undo part of the change.
        return 'held';
      }
      let recoveryRefused: 'layout' | 'schema' | null = null;
      const failed = writer as Writer | null;
      try {
        this._doc.transact(tr => {
          // Admitted inside its own transaction, as the write it recovers.
          recoveryRefused = this.refusalIn(after);
          if (recoveryRefused !== null) {
            return;
          }
          // Development builds: the binding's own write, even when it joined
          // an app's transaction (see noteRawWrite).
          if (__DEV__) {
            markBindingWrite(tr);
          }
          this.splitAtUnread(tr);
          // A change that inserts no character, while a hold is on: copies
          // a failed write made of what the hold keeps, deleted first (see
          // the recovery inside the write's transaction). One that inserts
          // is recovered as on main.
          const decidedFree =
            failed !== null &&
            failed.heldDecision !== null &&
            !failed.heldDecision.inserts;
          if (decidedFree) {
            $dropStoppedCopies(tr);
          }
          try {
            const all: WritePlan = {
              attrs: new Set(state.yByKey.keys()),
              inline: new Set(),
              lines: new Set(state.unitByKey.keys()),
              merged: plan.merged,
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
              this.seer,
            );
            rewriter.rewriteAll = true;
            // After a write that failed part way, what the editor showed is
            // not what is stored: the rewrite is decided as one that inserts
            // a character (see $heldDecision), and never stopped; but an
            // update decided as inserting none stays so: what the hold keeps
            // is neither copied nor deleted (skip mode, as in the recovery
            // inside the write's transaction), and the rest is written.
            const decided = failed === null ? null : failed.heldDecision;
            if (decided !== null && !decided.inserts) {
              rewriter.decideAs(decided);
              if (state.hidden !== null) {
                rewriter.skipProtected = true;
              }
            } else {
              rewriter.remoteUnread = true;
              rewriter.neverStop = true;
            }
            rewriter.followUp = commit.followUp;
            rewriter.$run();
            this.noteRefused(rewriter, commit.naming);
          } finally {
            if (origin === this || commit.recordOwnSchema) {
              recordSchema(this._root, this.options.schemaVersion, tr, t =>
                this.isUnderRoot(t),
              );
            }
            recordSetMembersLayout(this._root, tr);
          }
        }, origin);
      } catch (e2) {
        if (state.hidden !== null && e2 instanceof HeldDeletionError) {
          // The rewrite of an update that inserts no character would delete
          // what the hold keeps: refused, and read again.
          return 'held';
        }
        const decidedFree =
          failed !== null &&
          failed.heldDecision !== null &&
          !failed.heldDecision.inserts;
        if (state.hidden !== null && decidedFree) {
          // The recovery of a change that inserts no character failed too,
          // while a hold is on: the editor reads the whole document again
          // (its maps may be part way through the failed writes), so that it
          // shows exactly what is stored. Nothing typed is read over.
          this.rereadAfterRecovery(prevEditorState);
          return null;
        }
        // A change that inserts characters (or with no hold): as on main, the
        // editor keeps what was typed, never read over with what is stored
        // (which lacks it).
        this._editor._onError(e2 instanceof Error ? e2 : new Error(String(e2)));
      }
      const recoveryRefusedBy = recoveryRefused as 'layout' | 'schema' | null;
      if (
        recoveryRefusedBy === null &&
        state.hidden !== null &&
        failed !== null &&
        failed.heldDecision !== null &&
        !failed.heldDecision.inserts
      ) {
        // A change that inserts no character, while a hold is on (what the
        // hold keeps stayed where storage keeps it): the whole document read
        // again.
        this.rereadAfterRecovery(prevEditorState);
        return null;
      }
      return recoveryRefusedBy === null ? null : new Refusal(recoveryRefusedBy);
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
   * While read only, note the nodes among `dirtyElements` that hold slots
   * the document cannot store them on (see $unstorableSlotHosts): a re-read
   * of their container does not remove them, the next re-read does (see
   * $rereadRefused), queued unless a composition goes on. Not before the
   * document is opened: its initial content is checked for such slots then
   * (see refuseUnstorableSlots). Returns whether there is any.
   */
  private $refuseUnstorableSlotHosts(
    dirtyElements: Map<NodeKey, boolean>,
    editorState: EditorState,
    composing: boolean,
  ): boolean {
    // A binding that went read only to keep showing what it cannot store
    // leaves later updates as they are too (see keepsUnstored).
    if (this._status !== 'readonly' || this.keepsUnstored) {
      return false;
    }
    let found = false;
    editorState.read(() => {
      const roles = new Roles(this.state);
      for (const key of dirtyElements.keys()) {
        if (
          $unstorableSlotHosts(roles, [key], editorState._nodeMap).length > 0
        ) {
          this.refusedSlotHosts.add(key);
          found = true;
        }
      }
    });
    if (this.refusedSlotHosts.size > 0 && !composing) {
      this.pending.add('reread');
    }
    return found;
  }

  /**
   * Add to `into` the container that holds node `key` of `map` (the nearest
   * ancestor with a container; a slot's value is held by its host). Returns
   * whether there is one.
   */
  private addContainerOf(
    key: NodeKey,
    map: ReadonlyMap<NodeKey, LexicalNode>,
    into: Set<CS>,
  ): boolean {
    const state = this.state;
    for (let n = map.get(key); n !== undefined; ) {
      const parent: NodeKey | null =
        n.__parent ?? (n as {__slotHost?: null | NodeKey}).__slotHost ?? null;
      if (parent === null) {
        return false;
      }
      const cs =
        parent === 'root'
          ? state.containers.get(this._root)
          : state.csByKey.get(parent);
      if (cs !== undefined) {
        into.add(cs);
        return true;
      }
      n = map.get(parent);
    }
    return false;
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
    for (const key of changed) {
      const own = state.csByKey.get(key);
      if (own !== undefined) {
        into.add(own);
        found = true;
      }
      found = this.addContainerOf(key, nowMap, into) || found;
      found = this.addContainerOf(key, prevMap, into) || found;
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
   * content item's atom range and the formats in effect at it. (Only while
   * no composition holds anything back: its caller, settleTextFields, does
   * not run during a hold, so the stored formats are what every line
   * shows.)
   */
  private storedAtoms(owner: ElementNode): [number, number, Attrs][] {
    const state = this.state;
    const unit = state.unitByKey.get(owner.getKey());
    let start: Item | null;
    let formats: Map<string, unknown>;
    // Where unit.start was folded up to, when past the walk's start (see
    // seedFrontier).
    let folded: Item | null = null;
    // The binding's view, once: this read changes nothing it depends on.
    const view = this.seer();
    if (unit !== undefined && unit.end !== null) {
      const left = unitLeftEnd(view, unit.cs.units, unit, state.hidden);
      start = left === null ? unit.cs.y._start : left.right;
      // (Before the copy: a stale start is folded again, see frontierOf.)
      folded = frontierOf(view, unit.start, left, unit.cs.y, null);
      formats = new Map(unit.start || []);
    } else if (unit !== undefined && unit.kind === 'implicit') {
      const units = unit.cs.units;
      const idx = units.indexOf(unit);
      const prevEnd = idx > 0 ? units[idx - 1].end : null;
      let left = prevEnd;
      while (left !== null && !isShownEndIn(view, left, state.hidden)) {
        left = prevLiveEnd(view, left, state.hidden);
      }
      start = left === null ? unit.cs.y._start : left.right;
      // (Before the copy: a stale start is folded again, see frontierOf.)
      folded = frontierOf(view, unit.start, left, unit.cs.y, null);
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
    const folder = new Folder(formats, view, 'raw', null, null, folded);
    for (let it = start; it !== null; it = it.right) {
      folder.step(it);
      if (!it.deleted && it.content instanceof ContentFormat) {
        continue;
      }
      const len = shownLengthIn(view, it, state.hidden);
      if (len === 0) {
        if (isShownEndIn(view, it, state.hidden)) {
          break;
        }
        continue;
      }
      out.push([offset, offset + len, attrsOf(formats) as Attrs]);
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
   * it. Except an update made while Lexical notifies a commit's listeners (a
   * mutation listener's): committed at once, it would commit inside that
   * notification, before the rest of the outer commit's listeners, which
   * the binding is one of. It commits after them; a remote change applied
   * in the same task meanwhile finds it waiting, and is read after it is
   * committed and written (see D108).
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
      this.refusedSlotHosts.clear();
      this.emptyHeld.clear();
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
        } else if (work === 'foresee') {
          this.foreseeNextUpdate();
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
      editor._updates.some(([fn]) => fn === this.rereadUpdate) ||
      // An update made while Lexical notifies a commit's listeners (a
      // mutation listener's) waits to commit after them (see the root
      // transform): the re-read, run inside its pending state, would carry
      // its edits under the read's tags, never written. Its own commit
      // queues the re-read (as before this wait, that update applies to the
      // editor before the re-read).
      (editor._pendingEditorState !== null &&
        isDispatchingCommitListeners(editor))
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
    const slotHosts = [...this.refusedSlotHosts];
    this.refusedSlotHosts.clear();
    this.refused.clear();
    this.toSettle.clear();
    this.refusedNaming = false;
    this.pending.delete('reread');
    if (list.length === 0 && settle.length === 0 && slotHosts.length === 0) {
      return null;
    }
    // Slots the document cannot store (see the read-only path of onUpdate).
    for (const key of slotHosts) {
      const host = $getNodeByKey(key);
      if (host !== null && host.isAttached()) {
        for (const name of $getSlotNames(host)) {
          $removeSlot(host as LexicalNode & SlotHostNode, name);
        }
      }
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
    const reader = new Reader(this.state, this.seer);
    reader.$reading(() => {
      // A node the refused change made (not stored) gives back what it took
      // into its named slots, so that the read can place it again.
      const unslot = (node: LexicalNode) => {
        const names = $getSlotNames(node);
        for (const name of names) {
          const value = $getSlot(node as ElementNode, name);
          if (value !== null) {
            unslot(value);
          }
          if (!this.state.yByKey.has(node.getKey())) {
            $removeSlot(node as ElementNode, name);
          }
        }
        if ($isElementNode(node)) {
          for (const child of node.getChildren()) {
            unslot(child);
          }
        }
      };
      if (list.length > 0) {
        unslot($getRoot());
      }
      // A host's named slots, and those of every stored slot host in them,
      // a decorator's included (it has no container of its own, so it is in
      // no refused list): a refused change can have removed a slot's value,
      // moved it to another of its slots, or a child into a slot (taken out
      // of the slot first, so that the child can be read back).
      const $rereadSlots = (host: LexicalNode, y: YNode) => {
        const attrs = y.getAttrs() as Record<string, unknown>;
        for (const name of $getSlotNames(host)) {
          if (!(SLOT_PREFIX + name in attrs)) {
            $removeSlot(host as ElementNode, name);
          }
        }
        $readSlots(reader, host, y);
        for (const name of $getSlotNames(host)) {
          const value = $getSlot(host as ElementNode, name);
          const valueY =
            value === null ? undefined : this.state.yByKey.get(value.getKey());
          if (value !== null && valueY !== undefined) {
            $rereadSlots(value, valueY);
          }
        }
      };
      for (const cs of list) {
        const el = cs.y === this._root ? $getRoot() : $getNodeByKey(cs.key);
        if ($isElementNode(el) && el.isAttached()) {
          reader.$readFull(cs, el);
          if (cs.y !== this._root) {
            $rereadSlots(el, cs.y);
          }
        }
      }
      // An inline container a later read placed again (a slot's value read
      // with it, say) holds what its own read gave it: read once more.
      for (const cs of list) {
        const el = $getNodeByKey(cs.key);
        if (
          cs.kind === 'i' &&
          cs.y !== this._root &&
          $isElementNode(el) &&
          el.isAttached() &&
          el.getChildrenSize() === 0 &&
          cs.y._start !== null
        ) {
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
    const fold = this.stepFold;
    if (fold !== null && fold.state === null) {
      // The normalization of what an undo or redo read: part of the step
      // (see stepFold).
      fold.state = this._editor._pendingEditorState;
    }
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
    // The selection itself, not a copy: Lexical's normalization at the end
    // of the read's update (text nodes the read left side by side merge)
    // moves its points in place, and the commit compares what it ends as
    // with what was notified. A copy would differ there, and Lexical would
    // extend the read's commit with the selection change command, running
    // every node transform over what the read brought. Lexical gives each
    // later update a selection of its own, so this one changes no more once
    // the read has committed.
    editor._lastNotifiedSelection = selection;
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
        if (this.undoing.hasId(it.id)) {
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

  /**
   * An undo or redo read in an update that commits after the step returned
   * (one run as the next update, see undoOrRedo): that update's state, and
   * where the step pushed its item. Once that update committed (or the step
   * was read inside it), the state is null until the author's normalization
   * of what the step read runs (see $normalize), which sets it to its own
   * update's. What the binding writes in that commit and in that
   * normalization (the editor's own update of what it read) is captured as
   * part of the step, as when the step is read inside it: with the
   * UndoManager's undoing (or redoing) flag set, so that it neither clears
   * the redo stack nor becomes a step of its own, and folded into the
   * step's item (see foldFollowUps). A commit of this client's first ends
   * it; a collaborator's change read meanwhile does not.
   */
  private stepFold: {
    base: number;
    item: UndoManager['undoStack'][number];
    state: EditorState | null;
    undo: boolean;
  } | null = null;

  private applyUndo(um: UndoManager, undo: boolean): boolean {
    const stack = undo ? um.undoStack : um.redoStack;
    this.undoCache = new WeakMap();
    this.scanStackItem(stack);
    const top = stack[stack.length - 1];
    this.stepCursor =
      top === undefined ? null : ((top.meta.get(this) as YCursor) ?? null);
    try {
      // Queued undos run later: admitted then, as any write (see
      // recordAdmits); the UndoManager checks the same (BindingUndoManager).
      if (!this.writesEdits()) {
        return false;
      }
      const opposite = () => (undo ? um.redoStack : um.undoStack);
      const base = opposite().length;
      const popped = undo ? um.undo() : um.redo();
      if (popped !== null) {
        this.carryCloserMarks(popped);
        this.closeRestoredRuns(popped);
        // Read inside the running update (see undoOrRedo): what the
        // binding writes of it, in that update's commit, is part of the
        // step (see stepFold).
        // Read inside the step, the author's normalization of it may still
        // be to come, once the editor is idle (state null, see stepFold).
        const item = opposite()[base];
        if (item !== undefined) {
          this.stepFold = {
            base,
            item,
            state: this._editor._pendingEditorState,
            undo,
          };
        }
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
            // After the commit (which the callback itself makes happen,
            // even when `fn` changed nothing); where a commit listener
            // throws before Lexical runs the callbacks (see notifyApart),
            // once the editor is idle.
            let handed = false;
            const handBack = () => {
              if (!handed) {
                handed = true;
                for (const [f, o] of later) {
                  editor.update(f, o);
                }
              }
            };
            $onUpdate(handBack);
            queueMicrotask(handBack);
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
    // Where to write each null: after the item that ends at `leftEnd`,
    // before the item that starts at `right` (null: at that end of the
    // list). Ids, not items: the scan's
    // transaction splits items and its cleanup merges them back, so an item
    // object it saw can be a piece no longer in the store by the time the
    // null is written (an item linked to such a piece breaks the list's
    // links).
    const ends: [leftEnd: ID | null, right: ID | null, key: string][] = [];
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
            copy.content.value !== null &&
            !this.pairsKey(copy.content.key)
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
              ends.push([it.lastId, it.right && it.right.id, key]);
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
                ends.push([it.left && it.left.lastId, it.id, key]);
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
        // Development builds: the binding's own write, even when it joined
        // an app's transaction (see noteRawWrite).
        if (__DEV__) {
          markBindingWrite(tr);
        }
        // The nulls this loop writes: two keys can need an end in the same
        // gap, and the second must not take the first's null for a change
        // of the gap.
        const written = new Set<Item>();
        for (const [leftEnd, rightStart, key] of ends) {
          // The items as the store holds them now, split at those ids.
          const right =
            rightStart === null ? null : getItemCleanStart(tr, rightStart);
          let left: Item | null = null;
          if (leftEnd !== null) {
            const at = store.getItem(leftEnd);
            if (
              at instanceof Item &&
              at.id.clock + at.length - 1 > leftEnd.clock
            ) {
              getItemCleanStart(
                tr,
                createID(leftEnd.client, leftEnd.clock + 1),
              );
            }
            const found = store.getItem(leftEnd);
            left = found instanceof Item ? found : null;
          }
          if (
            (rightStart !== null && !(right instanceof Item)) ||
            (leftEnd !== null && left === null) ||
            (left === null && right === null) ||
            (left !== null && right !== null && left.parent !== right.parent)
          ) {
            continue;
          }
          // Still next to each other but for the nulls written here, in one
          // type (never next to an item of another type: see checkLinkable
          // in Cursor). The null goes right before `right`, after those.
          let before: Item | null;
          if (right !== null) {
            let l = right.left;
            while (l !== null && written.has(l)) {
              l = l.left;
            }
            if (l !== left) {
              continue;
            }
            before = right.left;
          } else {
            let last = left as Item;
            let r = last.right;
            while (r !== null && written.has(r)) {
              last = r;
              r = r.right;
            }
            if (r !== null) {
              continue;
            }
            before = last;
          }
          const item = new Item(
            createID(client, store.getClock(client)),
            before,
            before && before.lastId,
            right,
            right && right.id,
            (left ?? right)!.parent,
            null,
            new ContentFormat(key, null as unknown as object),
          );
          item.integrate(tr, 0);
          written.add(item);
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
        if (isStored(s)) {
          removing.add(s);
        }
      });
    }, this.scanOrigin);
    this.restoring = names;
    this.removing = removing;
    // By id: this scan's transaction splits items and merges them back, so
    // the item objects it saw need not be those the undo meets.
    this.undoing = top.inserts;
  }

  // -------------------------------------------------------------------------
  // Cursors

  /**
   * The local selection as relative positions (JSON), or null. While a
   * remote change is not read yet, the positions are taken in a Yjs
   * transaction that changes nothing (the document's transaction observers
   * see it), or in the one running; called again from that transaction's
   * observers, it returns the positions it just took.
   */
  getCursor(): YCursor | null {
    return this.takeCursor();
  }

  /**
   * See getCursor. With changes not read yet, the items are split at their
   * bounds first (see splitAtUnread), as for a write, since Yjs merges a
   * change's items with neighbouring items of the same client and the view
   * tells them apart by item: in the transaction running, if any (its
   * cleanup merges them back), else in a transaction of its own. The
   * positions are ids, which stay valid once Yjs merges the items again.
   * Taken again from that transaction's observers (an app's awareness
   * cursor refreshed on every transaction), it is the one just taken, for
   * the same editor state: no transaction opens from there, which would
   * call those observers again.
   */
  private takeCursor(): YCursor | null {
    if (this.unread === null) {
      // On the document as this binding's editor shows it (see seer).
      return this.readCursor();
    }
    const doc = this._doc;
    const state = this._editor.getEditorState();
    const take = (tr: Transaction) => {
      this.splitAtUnread(tr);
      const cursor = this.readCursor();
      this.takenCursor = {cursor, state};
      return cursor;
    };
    const running = doc._transaction;
    if (running !== null) {
      return take(running);
    }
    if (
      this.takingCursor ||
      doc._transactionCleanups.some(t => t.origin === this.scanOrigin)
    ) {
      const taken = this.takenCursor;
      return taken !== null && taken.state === state
        ? taken.cursor
        : this.readCursor();
    }
    let cursor: YCursor | null = null;
    this.takingCursor = true;
    try {
      doc.transact(tr => {
        cursor = take(tr);
      }, this.scanOrigin);
    } finally {
      this.takingCursor = false;
    }
    return cursor;
  }

  /**
   * Run `fn`, which reads positions (see takeCursor), with the items split
   * at the bounds of the changes not read yet: in the transaction running,
   * if any, else in one of its own that changes nothing.
   */
  private splitWhileUnread<T>(fn: () => T): T {
    if (this.unread === null) {
      return fn();
    }
    const running = this._doc._transaction;
    if (running !== null) {
      this.splitAtUnread(running);
      return fn();
    }
    let result: T | undefined;
    this._doc.transact(tr => {
      this.splitAtUnread(tr);
      result = fn();
    }, this.scanOrigin);
    return result as T;
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
    const anchor = this.$resolvePosition(cursor.anchor, this.seer());
    const focus = this.$resolvePosition(cursor.focus, this.seer());
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
    let anchor = this.$resolvePosition(cursor.anchor, this.seer());
    let focus = this.$resolvePosition(cursor.focus, this.seer());
    if (
      this.unread !== null &&
      !($isShownPoint(anchor) && $isShownPoint(focus))
    ) {
      // The binding's view (see Unread) places the selection in a node the
      // editor no longer has: a read rebuilt its container from the
      // document, where a change still deferred removed it. The selection
      // the editor keeps, where it has one; else where the document as it
      // is places it, as a read of all the changes at once would.
      $clampSelection();
      if ($getSelection() !== null) {
        return;
      }
      anchor = this.$resolvePosition(cursor.anchor, null);
      focus = this.$resolvePosition(cursor.focus, null);
      selection = null;
    }
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
    // The binding's view, once: this read changes nothing it depends on.
    const view = this.seer();
    let start: Item | null;
    if (unit !== undefined && unit.end !== null) {
      const left = unitLeftEnd(view, unit.cs.units, unit, state.hidden);
      start = left === null ? unit.cs.y._start : left.right;
    } else if (unit !== undefined && implicit) {
      // Its content starts right after the unit before it, the end of the
      // nearest line before it that is still shown.
      const units = unit.cs.units;
      const idx = units.indexOf(unit);
      let left = idx > 0 ? units[idx - 1].end : null;
      while (left !== null && !isShownEndIn(view, left, state.hidden)) {
        left = prevLiveEnd(view, left, state.hidden);
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
      const len = shownLengthIn(view, it, hidden);
      if (len === 0) {
        if (isShownEndIn(view, it, hidden)) {
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
      if (isShownEndIn(view, it, hidden)) {
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
    // The binding's view, once: this read changes nothing it depends on.
    const view = this.seer();
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
      if (!isShownEndIn(view, it, state.hidden)) {
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
    // The binding's view, once: this read changes nothing it depends on.
    const view = this.seer();
    const liveEnd = (x: Item) => isShownEndIn(view, x, hidden);
    let offset = 0;
    let it = start;
    for (; it !== null && it !== item && !liveEnd(it); it = it.right) {
      offset += shownLengthIn(view, it, hidden);
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
    view: View | null,
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
    const marked = isShownEndIn(view, found, hidden)
      ? this.state.unitByEnd.get(found)
      : undefined;
    if (
      marked !== undefined &&
      marked.kind === 'line' &&
      emptyLinePositions.has(json as object)
    ) {
      // Captured in an empty line (see emptyLinePositions): the start of
      // that line, before what was typed into it since.
      const left = prevLiveEnd(view, found, hidden);
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
    while (item !== null && shownLengthIn(view, item, hidden) === 0) {
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
        const left = prevLiveEnd(view, found, hidden);
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
    while (end !== null && !isShownEndIn(view, end, hidden)) {
      end = end.right;
    }
    const parentY = item.parent as YNode;
    const unit = end === null ? undefined : this.state.unitByEnd.get(end);
    let ownerKey: NodeKey | undefined;
    let start: Item | null;
    if (unit !== undefined && unit.key !== null && unit.kind === 'line') {
      ownerKey = unit.key;
      const left =
        unit.end === end
          ? unitLeftEnd(view, unit.cs.units, unit, hidden)
          : prevLiveEnd(view, end, hidden);
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
          end === null
            ? prevLiveEnd(view, item, hidden)
            : prevLiveEnd(view, end, hidden);
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
      offset += shownLengthIn(view, it, hidden);
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

/** Whether `point` is in a node the editor shows. */
function $isShownPoint(point: {key: NodeKey} | null): boolean {
  if (point === null) {
    return false;
  }
  const node = $getNodeByKey(point.key);
  return node !== null && node.isAttached();
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
