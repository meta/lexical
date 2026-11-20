/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The offline session (`@lexical/y/offline`): one object an app attaches to
// its binding, and three signals it gives it.
//
//   const loaded = await loadYOffline({store, key});         // offline mode
//   const doc = createYDoc(loaded.state);
//   const binding = createYBinding(editor, {doc, ...});
//   const session = attachYOfflineSession({binding, key,
//     epoch: loaded.epoch, loaded,
//     offline: {stage, store, persist: 'document'}, onError,
//     stopSync: () => provider.destroy()});
//
//   // 1. the server said which epoch the room is at: before syncing, on
//   //    every connect, and on a "replaced" event (a reload or a layout
//   //    upgrade of the room is the same signal: a new epoch):
//   const verdict = await session.serverEpoch(epoch);
//   //    'same': sync this document. 'moved': it is frozen and captured,
//   //    and `stopSync` was called; open a fresh document at the new
//   //    epoch, then recoverYOfflineEdits() there.
//   // 2. the server holds everything the document holds (only a 'same'
//   //    verdict, from a confirmed epoch, can say so):
//   verdict.markSynced();
//
// It uses the binding's public API only (`freeze()`, `status`, the editor)
// and `describeUnsyncedEdits`: nothing here depends on a layout.

import {
  type BlockIdExtension,
  blockIdState,
  generateBlockId,
  getPeerDependencyFromEditor,
} from '@lexical/extension';
import {
  encodeStateAsUpdate,
  encodeStateVector,
  mergeUpdates,
  type Transaction,
} from '@y/y';
import {
  $getEditor,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotNames,
  $getState,
  $isElementNode,
  $parseSerializedNode,
  $setState,
  getRegisteredNode,
  type LexicalEditor,
  type LexicalNode,
  type SerializedEditorState,
  type SerializedLexicalNode,
} from 'lexical';

import {type YBinding, type YLocalEdits, type YStatus} from '..';
import {
  describeUnsyncedEdits,
  type HeadlessYConfig,
  readYState,
  YHeadlessError,
  type YUnsyncedBlock,
  type YUnsyncedReport,
} from '../headless';
import {canonical} from './BlockMerge';
import {
  $parseWrapped,
  $rawLeftover,
  $storedBlockId,
  autoReplays,
  refuseWrapped,
  requireAutoReplay,
  requireLeftovers,
  type YAutoReplayRequiredPassReplayableNoneOrMaxBaseAge,
  type YLeftoverBlock,
  type YLeftoversInserted,
  type YLeftoversRequiredPassWrapOrHandle,
  type YLeftoversWrapped,
} from './OfflineLeftovers';
import {
  offlineFail as fail,
  offlineOk as ok,
  Y_OFFLINE_DEFAULTS,
  type YOfflineCapture,
  type YOfflineError,
  type YOfflineResult,
  type YOfflineSlot,
  type YOfflineStore,
} from './OfflineStore';

/**
 * @experimental The rollout stage of the offline layer, an explicit choice
 * of every call that takes it:
 * - `'off'`: nothing is persisted, captured or replayed (the calls return
 *   at once), so an app can ship the code dark;
 * - `'persist'`: edits are stored on the device as `offline.persist`
 *   says (every edit as it is made, with `'document'`), and a document whose
 *   epoch moved (a reconnect to a replaced or upgraded room) is frozen and
 *   stored with its base. Nothing is written into the new document: the
 *   edits stay stored;
 * - `'replay'`: as `'persist'`, and {@link recoverYOfflineEdits} applies the
 *   blocks that are replayable and, with `leftovers: {wrap}`, writes every
 *   other block into the document.
 */
export type YOfflineStage = 'off' | 'persist' | 'replay';

/** @experimental Every {@link YOfflineStage}, in rollout order. */
export const Y_OFFLINE_STAGES: readonly YOfflineStage[] =
  /* @__PURE__ */ Object.freeze(['off', 'persist', 'replay'] as const);

/**
 * @experimental What the offline layer uses of a binding: a
 * `YCollabBinding` (`createYBinding`, or YCollabExtension's `collab`) is
 * one. An app that built a `YBinding` itself passes the binding, its
 * status, and a `freeze()` that stops it and hands over its edits (from
 * `binding.quiesce()`).
 */
export interface YOfflineBinding {
  /** The YBinding: its document, editor and undo manager are read. */
  readonly binding: YBinding;
  /** `'active'` when edits can be replayed into it. */
  readonly status: YStatus;
  /** Stop reading and writing, and hand over the local edits (11.6). */
  freeze(): YLocalEdits;
}

/** @experimental What {@link loadYOffline} read. */
export interface YOfflineLoaded {
  /** The epoch the stored document was made against; null: none, or never synced. */
  readonly epoch: string | null;
  /** The stored document (for `createYDoc(state)`), or null when none is stored. */
  readonly state: Uint8Array | null;
  /** The state the server is known to hold, or null. */
  readonly base: Uint8Array | null;
  /** Whether the stored document holds edits the server may lack. */
  readonly hasUnsyncedEdits: boolean;
  /** When `base` was stored (Unix ms), or null when unknown. */
  readonly baseAt: number | null;
  /**
   * Whether every one of those edits is in rows a tab still open holds
   * (another tab of the document, offline): that tab syncs them, or
   * captures them when it learns its epoch moved, so this page's session
   * does not capture them as its own unless it edits too.
   */
  readonly unsyncedInLiveTabs: boolean;
  /** @internal The handle that read it (it owns the rows read). */
  readonly slot: YOfflineSlot | null;
}

/**
 * @experimental Read the document stored for `key`. Pass the result to
 * {@link attachYOfflineSession} as `loaded`, with `epoch: loaded.epoch`.
 *
 * - Without `epoch` (bind, then sync: the page starts from the store, with
 *   no connection): the newest slot. Create the document from `state`, and
 *   call `session.serverEpoch(epoch)` when the server names its epoch.
 * - With `epoch`, the server's (sync, then bind: the page has the server's
 *   document and epoch before it binds): only the slot at that epoch.
 *   Apply its `state` to the server's document (the same lineage, so it
 *   merges: the edits that did not sync go out on the next sync), and bind.
 *   A slot at another epoch is never loaded: {@link recoverYOfflineEdits}
 *   turns it into a capture. Call `session.serverEpoch(epoch)` once after
 *   attaching (it answers `'same'` at once): its verdict's `markSynced()`
 *   is how the session learns the server holds the document.
 *
 * Rows of a tab still open (with its writer lock) are read too, so a page
 * shows what another tab of the document holds; where they are the only
 * unsynced edits (`unsyncedInLiveTabs`), the session does not capture them
 * as this page's when the epoch moved (that tab does). A key has more than
 * one slot only when a tab was left at an earlier epoch.
 */
export async function loadYOffline(input: {
  readonly store: YOfflineStore;
  readonly key: string;
  /** The epoch the server's room is at, when the page knows it before binding. */
  readonly epoch?: string;
}): Promise<YOfflineResult<YOfflineLoaded>> {
  const wanted = input.epoch;
  requireOption(
    wanted === undefined || (typeof wanted === 'string' && wanted !== ''),
    `loadYOffline's epoch is the epoch your server's room is at, as a non-empty string (String(epoch) for a number), or left out to load the newest slot; got ${
      wanted === '' ? "''" : typeof wanted
    }.`,
  );
  const slots = await input.store.slots(input.key);
  if (!slots.ok) {
    return slots;
  }
  const found =
    wanted === undefined
      ? slots.value[0]
      : slots.value.find(info => info.epoch === wanted);
  if (found === undefined) {
    return ok({
      base: null,
      baseAt: null,
      epoch: wanted === undefined ? null : wanted,
      hasUnsyncedEdits: false,
      slot: null,
      state: null,
      unsyncedInLiveTabs: false,
    });
  }
  const {epoch} = found;
  const slot = input.store.slot(input.key, epoch);
  const stored = await slot.load();
  if (!stored.ok) {
    return stored;
  }
  // Which of the unsynced edits are only in rows a tab still open holds
  // (it syncs or captures them itself): a moved epoch must not capture
  // them again as this page's, on every page load. Then the session's
  // handle is one that read only the rows whose writer is gone: it owns,
  // and may replace, those, never the live tab's.
  let unsyncedInLiveTabs = false;
  let handle = slot;
  if (stored.value !== null && stored.value.hasUnsyncedEdits) {
    const probe = input.store.slot(input.key, epoch);
    const gone = await probe.load({writers: 'gone'});
    unsyncedInLiveTabs =
      gone.ok && (gone.value === null || !gone.value.hasUnsyncedEdits);
    if (unsyncedInLiveTabs) {
      slot.close();
      handle = probe;
    } else {
      probe.close();
    }
  }
  return ok({
    base: stored.value === null ? null : stored.value.base,
    baseAt: stored.value === null ? null : (stored.value.baseAt ?? null),
    epoch,
    hasUnsyncedEdits: stored.value !== null && stored.value.hasUnsyncedEdits,
    slot: handle,
    state: stored.value === null ? null : stored.value.state,
    unsyncedInLiveTabs,
  });
}

/**
 * @experimental What `persist` keeps on the device (see
 * {@link YOfflineMode}):
 * - `'document'`: every update as it is made, the whole document (its base
 *   and what came since), so the page can open it with no connection
 *   (`loadYOffline`) and a later page captures what did not sync;
 * - `'unsynced'`: the same, but only while the document holds edits the
 *   server lacks: nothing is stored while it is synced, the first local
 *   edit stores the base and what came since, and the verdict's
 *   `markSynced()` deletes them;
 * - `'captures-only'`: no edit is stored as it is made, only a capture when
 *   the epoch moves while the tab is open. Unsynced edits live in the tab
 *   alone: a reload, a crash or a closed tab with no connection loses them.
 */
export type YOfflinePersist = 'document' | 'unsynced' | 'captures-only';

/**
 * @experimental The offline layer's mode: one value, so a store is there
 * exactly when the stage uses it. Build it in one expression:
 * `opened.ok ? {persist: 'document', stage, store: opened.value} : {stage: 'off'}`.
 */
export type YOfflineMode =
  /** Nothing is persisted, captured or replayed (see {@link YOfflineStage}). */
  | {readonly stage: 'off'}
  | {
      readonly stage: 'persist' | 'replay';
      /** From `openYOfflineStore`. */
      readonly store: YOfflineStore;
      /** What is kept on the device (see {@link YOfflinePersist}). */
      readonly persist: YOfflinePersist;
    };

/**
 * @experimental Options of {@link attachYOfflineSession}: every choice an
 * app must make is required (`binding`, `key`, `epoch`, `loaded`,
 * `offline`, `onError`, `stopSync`).
 */
export interface YOfflineSessionOptions {
  /**
   * The bound editor: what `createYBinding` returns, YCollabExtension's
   * `collab`, or any {@link YOfflineBinding}.
   */
  readonly binding: YOfflineBinding;
  /** The document's name in your app (its id). */
  readonly key: string;
  /**
   * The epoch (generation) the document was made against, as a string:
   * `loaded.epoch` for a document created from {@link loadYOffline}, the
   * server's for one fetched from it, null for one that never synced.
   */
  readonly epoch: string | null;
  /**
   * What {@link loadYOffline} returned when the document was created from
   * it (its base, its unsynced edits and its stored rows continue here),
   * or null for a document that was not (fetched from the server, or new).
   * Required: a document created from a load but attached without it would
   * start with no base and no unsynced edits, so a moved epoch would
   * capture nothing of what it holds.
   */
  readonly loaded: YOfflineLoaded | null;
  /** The stage, and the store it uses (see {@link YOfflineMode}). */
  readonly offline: YOfflineMode;
  /**
   * Called with every storage failure (a full quota, a closed store): tell
   * the user their edits are not saved on this device. Editing goes on, and
   * the next write retries.
   */
  readonly onError: (error: YOfflineError) => void;
  /**
   * Stop syncing this document for good: disconnect or destroy its
   * provider. The session calls it when the epoch moved (`serverEpoch` or
   * `freeze` answering `'moved'`), right after it froze the binding and
   * before the capture is stored, so the frozen document never syncs into
   * the room that replaced it, whatever the app does with the verdict.
   */
  readonly stopSync: () => void;
  /**
   * Milliseconds to wait for updates to pause before storing them (0:
   * store each at once). While they do not pause, they are stored at least
   * every ten times this. `flush()` stores at once; call it on `pagehide`:
   * what a delay holds back is lost with a closed tab.
   * @defaultValue `0`
   */
  readonly writeDelay?: number;
  /**
   * Stored updates before they are compacted into one.
   * @defaultValue `Y_OFFLINE_DEFAULTS.compactAfter`
   */
  readonly compactAfter?: number;
  /** The clock, for tests. @defaultValue `Date.now` */
  readonly now?: () => number;
}

/** @experimental What {@link YOfflineSession.serverEpoch} decided. */
export type YOfflineVerdict =
  /** Stage `'off'`: nothing was done. Handle the epoch as the app did before. */
  | {readonly kind: 'off'}
  /**
   * The document belongs to this epoch (or just adopted it): sync it, and
   * call `markSynced()` once the server holds everything it holds.
   */
  | {
      readonly kind: 'same';
      /**
       * The authoritative copy holds everything this document holds: the
       * document as it is now becomes the base later edits are judged
       * against, and what is stored since is replaced by it (with
       * `persist: 'unsynced'`, deleted). Only a `'same'` verdict carries
       * it, so it cannot run before the session confirmed the room's
       * epoch: on a document of a replaced room it would make its unsynced
       * edits the base, and the capture would hold none of them.
       *
       * "Holds" means persisted by the copy a reload or replace of the room
       * is seeded from: for a relay in front of a product's store (a
       * connector), the product's save, not the relay's acknowledgement.
       * Call it only when that copy holds every update this document has
       * (nothing newer since): an edit made after what was persisted would
       * fold into the base, and a later capture would not list it. With a
       * relay that acknowledges nothing, call it when the provider has
       * synced; that leaves a window (an edit sent in that sync that never
       * arrived is in the base). A verdict stays callable after a
       * reconnect: call the one from the connection that synced. Once the
       * session has ended (a moved epoch, `dispose()`) it does nothing.
       */
      readonly markSynced: () => void;
    }
  /**
   * The room moved on. The binding is frozen, `stopSync` was called and
   * the session has ended: never sync this document. Open a fresh one at the new epoch and call
   * {@link recoverYOfflineEdits} there. `capture` is what was kept (null
   * when the document held nothing the server lacked); `saved` says whether
   * it reached the store (when not, `capture` is all there is: keep the tab
   * open and offer Copy).
   */
  | {
      readonly kind: 'moved';
      readonly capture: YOfflineCapture | null;
      readonly saved: YOfflineResult<void>;
    };

/** @experimental An attached session (see {@link attachYOfflineSession}). */
export interface YOfflineSession {
  readonly stage: YOfflineStage;
  /** The epoch the document belongs to; null until the server names one. */
  readonly epoch: string | null;
  /** Whether the document may hold edits the server lacks. */
  readonly hasUnsyncedEdits: boolean;
  /** False after a storage failure, until a write succeeds again. */
  readonly persisted: boolean;
  /** True once the epoch moved (the binding is frozen) or after `dispose()`. */
  readonly ended: boolean;
  /**
   * Tell the session the epoch the server's room is at: call it before the
   * provider syncs this document (on every connect, and once right after
   * attaching a document the page fetched from the server), and when the
   * server says the room was replaced. The binding is frozen and
   * `stopSync` called before this returns its promise, so nothing typed
   * after a `'moved'` is lost or written. A `'same'` verdict carries
   * `markSynced()`.
   */
  serverEpoch(
    epoch: string,
    options?: {readonly reason?: YOfflineCapture['reason']},
  ): Promise<YOfflineVerdict>;
  /**
   * The server says the room was replaced, and the new epoch is not known
   * yet: the same as `serverEpoch` with a new epoch. The binding is frozen
   * before this returns its promise, what it holds is captured into the
   * store (for `recoverYOfflineEdits` on the new document), and the
   * session ends. Call it on the live session, before disposing it.
   */
  freeze(options?: {
    readonly reason?: YOfflineCapture['reason'];
  }): Promise<YOfflineVerdict>;
  /** Resolves once everything queued so far is stored (or failed to be). */
  flush(): Promise<YOfflineResult<void>>;
  /** Stop listening. What is stored stays (use `store.clear` to drop it). */
  dispose(): void;
}

const REASONS: ReadonlySet<string> = new Set(['stale', 'legacy', 'expired']);

function requireOption(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new TypeError(`@lexical/y/offline: ${message}`);
  }
}

function requireStage(
  entry: string,
  stage: unknown,
): asserts stage is YOfflineStage {
  requireOption(
    Y_OFFLINE_STAGES.includes(stage as YOfflineStage),
    `${entry} needs stage: 'off' (do nothing), 'persist' (store edits on this device, and keep edits that did not sync stored) or 'replay' (also reapply the replayable ones, and give the rest to leftovers); got ${String(
      stage,
    )}.`,
  );
}

const DONE: YOfflineResult<void> = /* @__PURE__ */ ok(undefined);

let captureCount = 0;
function newCaptureId(now: number): string {
  const random = new Uint32Array(2);
  globalThis.crypto.getRandomValues(random);
  return `${now.toString(36)}-${random[0].toString(36)}${random[1].toString(
    36,
  )}-${captureCount++}`;
}

class Session implements YOfflineSession {
  private epochValue: string | null;
  private base: Uint8Array | null;
  /** When `base` was confirmed (Unix ms), or null when unknown. */
  private baseAt: number | null;
  /** The state vector of the base this session stored, once it has. */
  private storedBaseVector: Uint8Array | null = null;
  private unsynced: boolean;
  /**
   * The unsynced edits loaded are only a live tab's (see
   * `YOfflineLoaded.unsyncedInLiveTabs`), and this page has written none
   * since: a moved epoch captures nothing of them.
   */
  private onlyLiveTabEdits: boolean;
  /**
   * The load's unsynced edits were only a live tab's, so the first row
   * waits for the page's first own edit (or a markSynced(), which stores
   * the base); see the constructor.
   */
  private readonly deferredFirstRow: boolean;
  private firstRowWritten = false;
  private isEnded = false;
  private isPersisted = true;
  private slot: YOfflineSlot | null = null;
  /** Updates not stored yet, oldest first. */
  private pending: Uint8Array[] = [];
  /** A confirmed state not stored yet: it replaces what was pending before it. */
  private confirmed: {
    state: Uint8Array;
    vector: Uint8Array;
    /** When the server was known to hold it (`baseAt`), stored with it. */
    at: number | null;
  } | null = null;
  /** The epoch a never-synced slot is moving to, until it has. */
  private adopting: string | null = null;
  private lastFailure: string | null = null;
  private writing: Promise<YOfflineResult<void>> | null = null;
  private stop: () => void = () => {};
  private readonly now: () => number;
  private readonly compactAfter: number;
  /** The store, at a stage that uses one. */
  private readonly store: YOfflineStore | null;
  private readonly persistEdits: boolean;
  private readonly keepUnsyncedOnly: boolean;
  private readonly writeDelay: number;
  /** With `persist: 'unsynced'`: whether the slot holds the base and since. */
  private started: boolean;
  /** With `persist: 'unsynced'`: the slot's rows are to be deleted (synced). */
  private clearing = false;
  /** With `persist: 'unsynced'`: the state vector of the base in memory. */
  private baseVector: Uint8Array | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstDelayed = 0;

  constructor(private readonly options: YOfflineSessionOptions) {
    const {binding, loaded, offline} = options;
    this.store = offline.stage === 'off' ? null : offline.store;
    this.persistEdits =
      offline.stage !== 'off' && offline.persist !== 'captures-only';
    this.keepUnsyncedOnly =
      offline.stage !== 'off' && offline.persist === 'unsynced';
    this.writeDelay = options.writeDelay ?? 0;
    this.started =
      loaded !== null && loaded.state !== null && loaded.hasUnsyncedEdits;
    this.now = options.now ?? Date.now;
    this.compactAfter = options.compactAfter ?? Y_OFFLINE_DEFAULTS.compactAfter;
    this.epochValue = options.epoch;
    this.base = loaded === null ? null : loaded.base;
    this.baseAt =
      loaded === null || loaded.base === null ? null : (loaded.baseAt ?? null);
    this.unsynced = loaded !== null && loaded.hasUnsyncedEdits;
    this.onlyLiveTabEdits = loaded !== null && loaded.unsyncedInLiveTabs;
    this.deferredFirstRow = this.onlyLiveTabEdits;
    const store = this.store;
    if (store === null) {
      return;
    }
    const doc = binding.binding.doc;
    if (this.persistEdits) {
      // A load whose unsynced edits are only a live tab's hands over a
      // handle that owns only the rows whose writer was already gone (see
      // loadYOffline): the live tab's rows stay that tab's, or, if it
      // closes first, the next recovery's to capture.
      this.slot =
        loaded !== null && loaded.slot !== null
          ? loaded.slot
          : store.slot(options.key, options.epoch);
      // This handle's first row is the whole document, so its later rows
      // build only on rows it wrote: another tab may replace the rows it
      // loaded. With persist 'unsynced', only when it loaded unsynced rows
      // (otherwise its first local edit stores the base and since).
      // Not while the only unsynced edits loaded are a live tab's: that
      // row would be a copy of them, read as a closed tab's edits once this
      // page is gone (it may close without dispose()). The page's first own
      // edit writes it (see onUpdate), or markSynced() stores the base.
      if (
        doc.store.clients.size > 0 &&
        (!this.keepUnsyncedOnly || this.started) &&
        !this.onlyLiveTabEdits
      ) {
        if (
          loaded !== null &&
          loaded.state !== null &&
          !loaded.hasUnsyncedEdits &&
          loaded.base !== null
        ) {
          // Loaded with nothing unsynced: the document is its base, stored
          // as one (a later load reports nothing unsynced).
          this.confirmed = {
            // Stored again, not synced again: it keeps its age.
            at: this.baseAt,
            state: encodeStateAsUpdate(doc),
            vector: encodeStateVector(doc),
          };
        } else {
          this.pending.push(encodeStateAsUpdate(doc));
        }
        void this.write();
      }
    }
    // This client's writes (as the binding's handshake counts them): a
    // local transaction, or the binding's own applied as an update (the
    // seed of an empty document).
    const yBinding = binding.binding;
    const onTransaction = (tr: Transaction) => {
      if (
        (tr.insertSet.clients.size > 0 || tr.deleteSet.clients.size > 0) &&
        (tr.local ||
          tr.origin === yBinding ||
          (typeof tr.origin === 'object' &&
            tr.origin !== null &&
            (tr.origin as {binding?: unknown}).binding === yBinding))
      ) {
        this.unsynced = true;
        this.onlyLiveTabEdits = false;
      }
    };
    doc.on('afterTransaction', onTransaction);
    let offUpdate = () => {};
    if (this.persistEdits) {
      // Every update, a peer's too: the slot is the whole document. With
      // persist 'unsynced', only once a local edit made it unsynced (the
      // transaction's afterTransaction, which marks it, runs first).
      const onUpdate = (update: Uint8Array) => {
        if (this.firstRowDeferred()) {
          if (this.onlyLiveTabEdits) {
            // Still only a live tab's edits: nothing of this page to store.
            return;
          }
          // The page's first own edit: its first row is the whole document
          // (this update included), so its later rows build on it.
          this.firstRowWritten = true;
          this.pending.push(encodeStateAsUpdate(doc));
          this.schedule();
          return;
        }
        if (this.keepUnsyncedOnly && !this.started) {
          if (!this.unsynced) {
            return;
          }
          // The base and what came since, a peer's updates included, are
          // stored from the document when the queue runs.
          this.started = true;
          this.startPending = true;
          this.startGeneration++;
          this.pending = [];
          this.schedule();
          return;
        }
        this.pending.push(update);
        this.schedule();
      };
      doc.on('update', onUpdate);
      offUpdate = () => doc.off('update', onUpdate);
    }
    this.stop = () => {
      doc.off('afterTransaction', onTransaction);
      offUpdate();
    };
  }

  get stage(): YOfflineStage {
    return this.options.offline.stage;
  }
  get epoch(): string | null {
    return this.epochValue;
  }
  get hasUnsyncedEdits(): boolean {
    return this.unsynced;
  }
  get persisted(): boolean {
    return this.isPersisted;
  }
  get ended(): boolean {
    return this.isEnded;
  }

  /** Store what is queued now, or once updates pause (`writeDelay`). */
  private schedule(): void {
    if (this.writeDelay <= 0) {
      void this.write();
      return;
    }
    const now = this.now();
    if (this.timer === null) {
      this.firstDelayed = now;
    } else {
      clearTimeout(this.timer);
    }
    const wait = Math.max(
      0,
      Math.min(this.writeDelay, this.firstDelayed + 10 * this.writeDelay - now),
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.write();
    }, wait);
  }

  /** Store what is queued, one transaction at a time. */
  private write(): Promise<YOfflineResult<void>> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.writing === null) {
      this.writing = this.drain()
        .catch((error: unknown): YOfflineResult<void> => {
          // Nothing here should throw (a merge of updates Yjs itself made):
          // if it does, it is a failure like any other, never a queue that
          // stays rejected.
          const failure: YOfflineError = {
            cause: error,
            code: 'failed',
            message: `@lexical/y/offline: storing an edit failed (${String(
              error,
            )}); the edits are still in the page. Tell the user they are not saved on this device.`,
          };
          this.isPersisted = false;
          this.report(failure);
          return fail(failure);
        })
        .then(result => {
          this.writing = null;
          return result;
        });
    }
    return this.writing;
  }

  private async drain(): Promise<YOfflineResult<void>> {
    const slot = this.slot;
    if (slot === null) {
      return DONE;
    }
    // A write already in flight when a move starts finishes its queue: the
    // move awaits it before it chooses the rows, and nothing new starts
    // during the move (the timer is cleared, a flush() waits for it).
    while (this.hasQueued()) {
      let result: YOfflineResult<void>;
      if (this.adopting !== null) {
        // In the queue, so no write lands under the old key meanwhile.
        result = await slot.adopt(this.adopting);
        if (result.ok) {
          this.adopting = null;
        }
      } else if (this.clearing) {
        // persist 'unsynced', synced: the stored base and since go.
        this.clearing = false;
        result = await slot.discard();
        if (!result.ok && !this.clearing) {
          this.clearing = true;
        }
      } else if (this.needsStart()) {
        // persist 'unsynced', first edit since a sync: the base, then what the
        // document holds beyond it (null base: the whole document).
        const doc = this.options.binding.binding.doc;
        const base = this.base;
        const vector = this.baseVector;
        // A sync and a new local edit while this writes start another
        // generation: its own start stays due.
        const generation = this.startGeneration;
        if (base !== null && vector !== null) {
          // The base of the last markSynced(), with its time: stored now,
          // on the first edit after it, but no younger for that.
          result = await slot.confirm(base, this.baseAt);
          if (result.ok) {
            this.storedBaseVector = vector;
            result = await slot.append(encodeStateAsUpdate(doc, vector));
          }
        } else {
          result = await slot.append(encodeStateAsUpdate(doc));
        }
        if (result.ok && generation === this.startGeneration) {
          this.startPending = false;
        }
      } else if (this.confirmed !== null) {
        const confirming = this.confirmed;
        this.confirmed = null;
        result = await slot.confirm(confirming.state, confirming.at);
        if (result.ok) {
          // Only now: a compaction is a diff against the stored base.
          this.storedBaseVector = confirming.vector;
        } else if (this.confirmed === null) {
          this.confirmed = confirming;
        }
      } else {
        const batch = this.pending;
        const syncs = this.syncs;
        this.pending = [];
        let row: Uint8Array;
        try {
          row =
            batch.length === 1
              ? batch[0]
              : mergeUpdates(batch as Parameters<typeof mergeUpdates>[0]);
        } catch (error) {
          this.pending = [...batch, ...this.pending];
          throw error;
        }
        result = await slot.append(row);
        if (!result.ok) {
          // A sync meanwhile covers the batch: it is not queued again (it
          // would be stored as edits the server lacks, or, with keep
          // 'unsynced', as a row with no base after the clear).
          if (syncs === this.syncs) {
            this.pending = [...batch, ...this.pending];
          }
        } else if (slot.rowsSinceCompaction >= this.compactAfter) {
          result = await slot.compact(this.sinceBase());
        }
      }
      if (!result.ok) {
        // Kept in the queue: the next update, or flush(), retries. Reported
        // once per failure, not once per keystroke while it lasts.
        if (this.isPersisted || this.lastFailure !== result.error.code) {
          this.report(result.error);
        }
        this.isPersisted = false;
        this.lastFailure = result.error.code;
        return result;
      }
      this.isPersisted = true;
      this.lastFailure = null;
    }
    return DONE;
  }

  /** While a moved epoch moves the rows into the capture: no write runs. */
  private moving = false;
  /** Resolves when that move is over (null when none is under way). */
  private moveDone: Promise<void> | null = null;
  /** Counts markSynced() calls: a batch whose append failed across one is covered. */
  private syncs = 0;
  /** persist 'unsynced': the slot's first write since a sync is due. */
  private startPending = false;
  /** persist 'unsynced': counts starts, so an old one's end clears no new one. */
  private startGeneration = 0;
  private needsStart(): boolean {
    return this.keepUnsyncedOnly && this.startPending;
  }

  private hasQueued(): boolean {
    return (
      this.adopting !== null ||
      this.clearing ||
      this.needsStart() ||
      this.confirmed !== null ||
      this.pending.length > 0
    );
  }

  /**
   * What the document holds beyond the base this session confirmed;
   * undefined before it confirmed one (the rows are merged instead).
   */
  private sinceBase(): Uint8Array | undefined {
    return this.storedBaseVector === null
      ? undefined
      : encodeStateAsUpdate(
          this.options.binding.binding.doc,
          this.storedBaseVector,
        );
  }

  private report(error: YOfflineError): void {
    try {
      this.options.onError(error);
    } catch (thrown) {
      queueMicrotask(() => {
        throw thrown;
      });
    }
  }

  flush(): Promise<YOfflineResult<void>> {
    if (this.moveDone !== null) {
      // A moved epoch is moving the rows: what is queued is in its capture,
      // or stored by the move's own failure path. Resolve after it.
      return this.moveDone.then(() => this.flush());
    }
    return this.storeQueued();
  }

  /** Store what is queued now, including what is queued while it runs. */
  private storeQueued(): Promise<YOfflineResult<void>> {
    return this.write().then(result =>
      // Queued while it ran.
      result.ok && !this.moving && this.hasQueued()
        ? this.storeQueued()
        : result,
    );
  }

  /** A `'same'` verdict, whose `markSynced` the session confirmed. */
  private same(): YOfflineVerdict {
    return {kind: 'same', markSynced: () => this.confirmSynced()};
  }

  /**
   * What the `'same'` verdict's `markSynced()` does: only reachable once
   * `serverEpoch` confirmed the epoch (so `epochValue` is set).
   */
  private confirmSynced(): void {
    if (this.store === null || this.isEnded) {
      return;
    }
    const doc = this.options.binding.binding.doc;
    const state = encodeStateAsUpdate(doc);
    this.base = state;
    this.baseAt = this.now();
    this.unsynced = false;
    this.onlyLiveTabEdits = false;
    // The base this stores is the whole document: later rows build on it.
    this.firstRowWritten = true;
    this.syncs++;
    if (this.slot !== null) {
      // The state holds everything queued before it.
      this.pending = [];
      if (this.keepUnsyncedOnly) {
        // Nothing is kept while synced: the base stays in memory until the
        // next local edit stores it.
        this.baseVector = encodeStateVector(doc);
        this.started = false;
        this.startPending = false;
        this.confirmed = null;
        this.clearing = true;
      } else {
        this.confirmed = {
          at: this.baseAt,
          state,
          vector: encodeStateVector(doc),
        };
      }
      void this.write();
    }
  }

  async serverEpoch(
    epoch: string,
    options?: {readonly reason?: YOfflineCapture['reason']},
  ): Promise<YOfflineVerdict> {
    requireOption(
      typeof epoch === 'string' && epoch !== '',
      `serverEpoch(epoch) takes the epoch (generation) your server named, as a non-empty string (String(epoch) for a number); got ${
        epoch === '' ? "''" : typeof epoch
      }.`,
    );
    const reason = options === undefined ? undefined : options.reason;
    requireOption(
      reason === undefined || REASONS.has(reason),
      `serverEpoch's reason is 'stale' (the default: the room moved on), 'legacy' or 'expired'; got ${String(
        reason,
      )}.`,
    );
    if (this.options.offline.stage === 'off') {
      return {kind: 'off'};
    }
    if (this.isEnded) {
      throw new Error(
        '@lexical/y/offline: this session has ended (its epoch moved, or it was disposed). Attach a new session to the new document: attachYOfflineSession({binding, epoch, ...}).',
      );
    }
    if (this.epochValue === epoch) {
      return this.same();
    }
    if (this.epochValue === null) {
      // A document that never synced belongs to the first epoch it meets.
      this.epochValue = epoch;
      if (this.slot !== null) {
        // A failure is reported through onError; the queue retries.
        this.adopting = epoch;
        await this.flush();
      }
      return this.same();
    }
    return this.moveOn(reason);
  }

  async freeze(options?: {
    readonly reason?: YOfflineCapture['reason'];
  }): Promise<YOfflineVerdict> {
    const reason = options === undefined ? undefined : options.reason;
    requireOption(
      reason === undefined || REASONS.has(reason),
      `freeze's reason is 'stale' (the default: the room moved on), 'legacy' or 'expired'; got ${String(
        reason,
      )}.`,
    );
    if (this.options.offline.stage === 'off') {
      return {kind: 'off'};
    }
    if (this.isEnded) {
      throw new Error(
        '@lexical/y/offline: this session has ended (its epoch moved, or it was disposed): freeze() runs on the live session, when the server says the room was replaced.',
      );
    }
    return this.moveOn(reason);
  }

  /** The room moved on: freeze, capture into the store, end the session. */
  private async moveOn(
    reason: YOfflineCapture['reason'] | undefined,
  ): Promise<YOfflineVerdict> {
    // Freeze first, synchronously: from here nothing is written to the
    // document, and what the editor holds is in the capture.
    const from = this.epochValue;
    const {binding, key} = this.options;
    const store = this.store;
    const edits = binding.freeze();
    // Then the provider: the frozen document never syncs into the room
    // that replaced it, whatever the app does with the verdict. A throw is
    // rethrown apart, so the capture is still made.
    try {
      this.options.stopSync();
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
    // Read after the freeze: it commits what the editor still held. Edits
    // only a live tab's rows hold are that tab's to capture.
    const wasUnsynced = this.unsynced && !this.onlyLiveTabEdits;
    this.isEnded = true;
    this.stop();
    // No write may run while the rows are moved into the capture (a
    // delayed one, or a flush() the app calls meanwhile): what is queued is
    // in the capture, or, on failure, stored below once the move is over.
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const capture: YOfflineCapture | null =
      wasUnsynced || edits.differs
        ? {
            base: this.base,
            baseAt: this.base === null ? null : this.baseAt,
            capturedAt: this.now(),
            claimed: false,
            differs: edits.differs,
            epoch: from,
            id: newCaptureId(this.now()),
            json: edits.json,
            key,
            reason: reason ?? 'stale',
            state: edits.state,
            text: edits.text,
          }
        : null;
    if (store === null) {
      return {capture, kind: 'moved', saved: DONE};
    }
    // Held for the whole move, whatever a store of the app's own does
    // (released in finally, so a throw cannot leave it held); a flush()
    // the app calls meanwhile waits for the move.
    this.moving = true;
    let moved = () => {};
    this.moveDone = new Promise<void>(resolve => (moved = resolve));
    try {
      return await this.moveRows(capture, store);
    } finally {
      this.moving = false;
      this.moveDone = null;
      moved();
    }
  }

  /** moveOn's store work, with the write queue held. */
  private async moveRows(
    capture: YOfflineCapture | null,
    store: YOfflineStore,
  ): Promise<YOfflineVerdict> {
    let saved: YOfflineResult<void> = DONE;
    const slot = this.slot;
    if (slot !== null && slot.moveIntoCapture !== undefined) {
      // One transaction: the capture in, this page's rows out (only its
      // own: another tab at the old epoch may hold edits it has not
      // captured yet), the capture's room counted without those rows.
      // What is still queued (what the freeze committed) stays queued
      // until the capture is in.
      await this.writing;
      // Nothing captured because the only unsynced edits loaded are a live
      // tab's: the rows read stay (that tab's recovery may build on a base
      // row of a gone writer), only this page's go.
      saved =
        capture === null &&
        this.unsynced &&
        this.onlyLiveTabEdits &&
        slot.discardWritten !== undefined
          ? await slot.discardWritten()
          : await slot.moveIntoCapture(capture);
      if (saved.ok) {
        this.pending = [];
        this.confirmed = null;
        this.adopting = null;
        this.clearing = false;
        this.startPending = false;
      } else {
        // Nothing changed: the rows keep the edits, and what the freeze
        // committed is stored now, for the next page to capture.
        this.isPersisted = false;
        this.report(saved.error);
        this.moving = false;
        await this.storeQueued();
      }
      slot.close();
      return {capture, kind: 'moved', saved};
    }
    if (capture !== null) {
      saved = await store.putCapture(capture);
      if (!saved.ok) {
        // The slot (when there is one) keeps the edits, with what the
        // freeze just committed: the next page captures them from it.
        this.isPersisted = false;
        this.report(saved.error);
        this.moving = false;
        await this.storeQueued();
        return {capture, kind: 'moved', saved};
      }
    }
    if (this.slot !== null) {
      // What was queued is in the capture; this page's rows are stale.
      // Only its own: another tab at the old epoch may hold edits it has
      // not captured yet.
      this.pending = [];
      this.confirmed = null;
      this.adopting = null;
      this.clearing = false;
      this.startPending = false;
      await this.writing;
      const discarded = await this.slot.discard();
      if (!discarded.ok) {
        this.report(discarded.error);
      }
      this.slot.close();
    }
    return {capture, kind: 'moved', saved};
  }

  /** The first row still waits for the page's first own edit. */
  private firstRowDeferred(): boolean {
    return this.deferredFirstRow && !this.firstRowWritten;
  }

  dispose(): void {
    this.isEnded = true;
    this.stop();
    const slot = this.slot;
    // What a delay held back is stored, then the writer lock goes (the
    // rows become the next handle's to replace).
    void (
      this.timer !== null || this.writing !== null
        ? this.flush()
        : Promise.resolve()
    ).then(() => {
      if (slot !== null) {
        slot.close();
      }
    });
  }
}

/**
 * @experimental Attach the offline layer to a bound editor. Start here:
 *
 * 1. `const opened = await openYOfflineStore({idb: {indexedDB, IDBKeyRange}})`;
 * 2. `const loaded = await loadYOffline({store, key})`, and create the
 *    document from `loaded.state` (null: none stored, fetch it);
 * 3. `const session = attachYOfflineSession({binding, key, epoch:
 *    loaded.epoch, loaded, offline: {stage, store, persist: 'document'},
 *    onError, stopSync})`;
 * 4. `const verdict = await session.serverEpoch(epoch)` whenever the server
 *    names its epoch: before the provider syncs (every connect and
 *    reconnect), and when the room is replaced or upgraded. `'same'` means
 *    sync, `'moved'` means the document was frozen and captured and
 *    `stopSync` was called;
 * 5. `verdict.markSynced()` (a `'same'` verdict's) when the server holds the
 *    document;
 * 6. on the document the page syncs (a fresh one after `'moved'`),
 *    `await recoverYOfflineEdits({..., leftovers})`: at stage `'replay'` it
 *    reapplies what did not sync and writes the rest into the document
 *    (`leftovers: {wrap: wrapLeftoversAsQuote('…')}`).
 */
export function attachYOfflineSession(
  options: YOfflineSessionOptions,
): YOfflineSession {
  const entry = 'attachYOfflineSession';
  requireOption(
    typeof options === 'object' && options !== null,
    `${entry} needs options: {binding, key, epoch, loaded, offline, onError, stopSync}.`,
  );
  const offline: unknown = options.offline;
  requireOption(
    typeof offline === 'object' && offline !== null,
    `${entry} needs offline: {stage: 'off'}, or {stage: 'persist' | 'replay', store, persist: 'document' | 'unsynced' | 'captures-only'} (it replaces the stage, store, persistEdits and keep options).`,
  );
  const mode = offline as YOfflineMode;
  requireStage(entry, mode.stage);
  if (mode.stage !== 'off') {
    requireOption(
      typeof mode.store === 'object' && mode.store !== null,
      `${entry} needs offline.store at stage '${mode.stage}': pass the value of openYOfflineStore({idb}) (when it failed, use offline: {stage: 'off'} and tell the user).`,
    );
    requireOption(
      mode.persist === 'document' ||
        mode.persist === 'unsynced' ||
        mode.persist === 'captures-only',
      `${entry} needs offline.persist: 'document' (store the whole document, to open it with no connection), 'unsynced' (store it only while the server lacks edits) or 'captures-only' (store nothing as it is made: unsynced edits live in the tab alone); got ${String(
        mode.persist,
      )}.`,
    );
  }
  requireOption(
    typeof options.binding === 'object' &&
      options.binding !== null &&
      typeof options.binding.freeze === 'function',
    `${entry} needs binding: what createYBinding(editor, {...}) returns, or the collab output of YCollabExtension configured with yCollab({...}).`,
  );
  requireOption(
    typeof options.key === 'string' && options.key !== '',
    `${entry} needs key: a non-empty string that names the document in your app (its id).`,
  );
  requireOption(
    options.epoch === null ||
      (typeof options.epoch === 'string' && options.epoch !== ''),
    `${entry} needs epoch: the epoch (generation) the document was made against as a string (String(epoch) for a number; loaded.epoch for a document from loadYOffline), or null for a document that never synced.`,
  );
  requireOption(
    options.loaded === null ||
      (typeof options.loaded === 'object' && options.loaded !== undefined),
    `${entry} needs loaded: what loadYOffline returned when the document was created from it, or null for a document that was not (without it, a document from the store would start with no base and no unsynced edits, and a moved epoch would capture nothing).`,
  );
  requireOption(
    typeof options.onError === 'function',
    `${entry} needs onError: a function that tells the user their edits are not saved on this device (a full quota, a closed store), so a storage failure is never silent.`,
  );
  requireOption(
    typeof options.stopSync === 'function',
    `${entry} needs stopSync: a function that disconnects this document's provider for good (provider.destroy()); the session calls it when the room moved on, so the frozen document never syncs into the room that replaced it.`,
  );
  requireOption(
    options.writeDelay === undefined ||
      (typeof options.writeDelay === 'number' && options.writeDelay >= 0),
    `${entry}'s writeDelay is the milliseconds to wait for updates to pause before storing them (0 or more); got ${String(options.writeDelay)}.`,
  );
  requireOption(
    options.loaded === null || options.loaded.epoch === options.epoch,
    `${entry} got a loaded document of another epoch: pass epoch: loaded.epoch (the server's epoch goes to session.serverEpoch(epoch), which captures the document when they differ).`,
  );
  return new Session(options);
}

/**
 * @experimental A capture's report: `describeUnsyncedEdits`' without the
 * blocks the document already holds as the user had them.
 */
export interface YOfflineReport extends YUnsyncedReport {
  readonly captureId: string;
  /**
   * When the copy the edits were made on was last known to be on the server
   * (the capture's `baseAt`), or null when unknown: what `autoReplay`'s
   * `maxBaseAge` reads.
   */
  readonly baseAt: number | null;
  /**
   * The ids of the user's blocks, in their document's order (what places a
   * replayed added block).
   */
  readonly order: readonly string[];
  /** Blocks left out because the document already holds them as the user had them. */
  readonly inDocument: readonly string[];
  /**
   * Whether the blocks both documents hold are in another order in the
   * user's (they, or someone since, moved a block): no entry of `blocks`
   * says so, and a capture with it is kept until the user dismisses it.
   */
  readonly orderDiffers: boolean;
}

/**
 * A Yjs state vector (`encodeStateVector`'s bytes: a count, then a client
 * and its clock per entry, as lib0 varuints) as client to clock. Read here
 * rather than with @y/y's decoder, which the binding's Yjs contract does
 * not list.
 */
export function readStateVector(bytes: Uint8Array): Map<number, number> {
  let at = 0;
  const varuint = (): number => {
    let value = 0;
    let scale = 1;
    while (at < bytes.length) {
      const byte = bytes[at++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        return value;
      }
      scale *= 0x80;
    }
    // Cut short (a store of your own that kept part of it): no more.
    return -1;
  };
  const vector = new Map<number, number>();
  const count = varuint();
  if (count < 0) {
    // Empty or cut short: read as a vector no document holds (below).
    vector.set(0, Number.MAX_SAFE_INTEGER);
  }
  for (let n = count; n > 0; n--) {
    const client = varuint();
    const clock = varuint();
    if (client < 0 || clock < 0) {
      // Unreadable: read as a vector no document holds, so a resolution
      // it records is never taken as held (the capture is kept).
      vector.set(0, Number.MAX_SAFE_INTEGER);
      break;
    }
    vector.set(client, clock);
  }
  return vector;
}

const sameJSON = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function blockIdOf(node: SerializedLexicalNode): string | null {
  const state = (node as {$?: {blockId?: unknown}}).$;
  const id = state === undefined ? undefined : state.blockId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** The ids of `blocks`, by position where any block lacks one (as the report names them). */
function idsOf(blocks: readonly SerializedLexicalNode[]): string[] {
  const ids = blocks.map(blockIdOf);
  return ids.every(id => id !== null) && new Set(ids).size === ids.length
    ? (ids as string[])
    : blocks.map((_, i) => `#${i}`);
}

const isReadOnly = (error: unknown): boolean =>
  error instanceof YHeadlessError && error.code === 'read-only';

/** @experimental What {@link describeYOfflineCapture} reads a capture with. */
export interface YOfflineDescribeOptions {
  /** The document as it is now (`encodeStateAsUpdate(doc)` of the fresh one). */
  readonly current: Uint8Array;
  /** The headless configuration of your editor (its nodes, `schemaVersion`). */
  readonly config: HeadlessYConfig;
  /**
   * Brings a state this release cannot read (a layout below `MIN_LAYOUT`)
   * up to one it can, with your app's migration steps (`migrateYState` on
   * `@lexical/y/migrate`). Without it, such a base is reported as gone
   * (nothing replayable) and such a capture without JSON cannot be read.
   */
  readonly migrate?: (state: Uint8Array) => Uint8Array;
  /**
   * Whether a block both sides changed is merged three ways where their
   * changes do not overlap (see `describeUnsyncedEdits`). `false`: every
   * such block is a conflict, as before the merge existed.
   * @defaultValue true
   */
  readonly blockMerge?: boolean;
}

/**
 * @experimental What a capture changed, block by block
 * (`describeUnsyncedEdits`), against the document as it is now. Blocks the
 * document already holds as the user had them are left out (an edit that
 * did reach the server, or one already reapplied, whole or merged into
 * what someone else made of the block): an empty `blocks` with
 * `orderDiffers` false means the capture can be deleted.
 */
export function describeYOfflineCapture(
  capture: YOfflineCapture,
  options: YOfflineDescribeOptions,
): YOfflineResult<YOfflineReport> {
  const {config, current, migrate} = options;
  const describe = (
    edits: {json: SerializedEditorState} | {state: Uint8Array},
    against: Uint8Array | null,
  ) =>
    describeUnsyncedEdits({
      base: against,
      blockMerge: options.blockMerge,
      capturedAt: capture.capturedAt,
      config,
      current,
      edits,
      reason: capture.reason,
    });
  const json = capture.json as SerializedEditorState | null;
  // The captured state is what is compared, read as the base and the
  // current document are; the editor's JSON only where it holds more than
  // the document (a refused edit) or the state cannot be read. A node can
  // serialize differently in a live editor than in a headless read (a
  // nested editor it normalized locally), which would list it as changed.
  let state = capture.state;
  let useState = json === null || !capture.differs;
  let migratedState = false;
  let base = capture.base;
  let report: YUnsyncedReport | null = null;
  let yours: SerializedLexicalNode[] = [];
  // A state below the floor is refused as read only: at most once for the
  // base and twice for the capture's state (migrated, then left for JSON).
  for (let attempt = 0; attempt < 4 && report === null; attempt++) {
    try {
      report = describe(useState || json === null ? {state} : {json}, base);
      yours =
        useState || json === null
          ? readBlocks(state, config)
          : json.root.children;
    } catch (error) {
      if (!isReadOnly(error)) {
        return fail({
          cause: error,
          code: 'failed',
          message: `@lexical/y/offline: a state of this capture or the current document could not be read with options.config (${String(
            error,
          )}); the capture is kept. Check that config holds the editor's nodes and schemaVersion, and offer capture.text meanwhile.`,
        });
      }
      report = null;
      try {
        if (base !== null && unreadable(base, config)) {
          base = migrate === undefined ? null : migrate(base);
          if (base !== null && unreadable(base, config)) {
            base = null;
          }
          continue;
        }
        if (useState && unreadable(state, config)) {
          if (migrate !== undefined && !migratedState) {
            state = migrate(state);
            migratedState = true;
            continue;
          }
          if (json !== null) {
            useState = false;
            continue;
          }
        }
      } catch (migrationError) {
        return fail({
          cause: migrationError,
          code: 'failed',
          message:
            '@lexical/y/offline: options.migrate threw on a stored state; the capture is kept. Offer its text (capture.text) and fix the migration.',
        });
      }
      return fail({
        cause: error,
        code: 'failed',
        message:
          "@lexical/y/offline: a state of this capture or the current document is read only for this release (a layout below MIN_LAYOUT, or a newer schema), so it cannot be compared. Pass options.migrate (migrateYState from @lexical/y/migrate with your steps) to read older layouts; the capture is kept, and capture.text still holds the user's text when it was frozen.",
      });
    }
  }
  if (report === null) {
    return fail({
      code: 'failed',
      message:
        '@lexical/y/offline: options.migrate returned a state this release still cannot read; migrate to the layout the current document records.',
    });
  }
  // A block the user only moved is in no entry: it is told from the order
  // of the blocks both documents hold (by id; positions say nothing).
  const order = idsOf(yours);
  let orderDiffers = false;
  if (order.length > 0 && !order[0].startsWith('#')) {
    const now = idsOf(readBlocks(current, config));
    const theirs = new Set(now);
    const mine = new Set(order);
    orderDiffers =
      order.filter(id => theirs.has(id)).join('\u0000') !==
      now.filter(id => mine.has(id)).join('\u0000');
  }
  const inDocument: string[] = [];
  const blocks: YUnsyncedBlock[] = [];
  // Without block ids, blocks are paired by position: one block added or
  // removed offline shifts every later one, which the current document
  // still holds (found by content: `shifted`).
  const shifted = new Set(report.shifted ?? []);
  for (const block of report.blocks) {
    // As the user had it, or holding their changes beside someone else's
    // (the merge of the three is the block as it is).
    if (
      block.id.startsWith('#') && report.shifted !== undefined
        ? shifted.has(block.id)
        : sameJSON(block.yours, block.now) ||
          (block.resolution === 'merged' &&
            canonical(block.merged) === canonical(block.now))
    ) {
      inDocument.push(block.id);
    } else {
      blocks.push(block);
    }
  }
  return ok({
    ...report,
    baseAt: capture.base === null ? null : (capture.baseAt ?? null),
    blocks,
    captureId: capture.id,
    fragment: blocks.flatMap(block =>
      block.yours === null ? [] : [block.yours],
    ),
    inDocument,
    order,
    orderDiffers,
  });
}

/** The top-level blocks of a readable state (as describeUnsyncedEdits reads them). */
function readBlocks(
  state: Uint8Array,
  config: HeadlessYConfig,
): SerializedLexicalNode[] {
  return readYState(
    state,
    config,
    () => $getEditor().getEditorState().toJSON().root.children,
  );
}

/** Whether this release refuses to read `state` (a layout below the floor). */
function unreadable(state: Uint8Array, config: HeadlessYConfig): boolean {
  try {
    readBlocks(state, config);
    return false;
  } catch (error) {
    if (isReadOnly(error)) {
      return true;
    }
    throw error;
  }
}

/** @experimental Why a block was not replayed. */
export type YReplaySkipReason =
  /** The report says the current document no longer matches the base there. */
  | 'not-replayable'
  /** The document changed there since the report was made. */
  | 'changed-since'
  /** The editor's blocks have no ids (BlockIdExtension), so none can be found. */
  | 'no-block-ids'
  /** The block's JSON does not parse with the editor's nodes. */
  | 'unreadable'
  /** The document already holds the block as the user had it: nothing to do. */
  | 'in-document'
  /** `only` named it, but the report does not hold it. */
  | 'not-in-report'
  /**
   * Replayable, but `autoReplay` did not replay it (`'none'`, or a copy
   * older than `maxBaseAge`): it went to `leftovers` (a block the user
   * deleted stays as it is).
   */
  | 'not-auto-replayed'
  /**
   * The editor update failed (the editor's onError has the error): nothing
   * was applied or inserted, and every block of the call has this reason.
   */
  | 'not-written';

/** @experimental What {@link replayUnsyncedEdits} did. */
export interface YReplayResult {
  /** The ids of the blocks applied, in the order applied. */
  readonly applied: readonly string[];
  /**
   * The blocks not applied, with why. Each is accounted for: written into
   * the document (`leftovers`), given to the handler (`handled`), or with
   * nothing to write (`'in-document'`, `'not-in-report'`, or a deletion of
   * the user's, which leaves the current block). Only `'not-written'` (the
   * update failed) leaves blocks neither applied nor accounted for.
   */
  readonly notApplied: readonly {
    readonly id: string;
    readonly reason: YReplaySkipReason;
  }[];
  /**
   * The new ids of every top-level block written for the leftovers, in
   * document order (all of `leftovers[].inserted`).
   */
  readonly inserted: readonly string[];
  /** Each place leftover blocks were written at (`leftovers: {wrap}`). */
  readonly leftovers: readonly YLeftoversInserted[];
  /** The report's ids of the blocks given to `leftovers.handle`. */
  readonly handled: readonly string[];
}

/** @experimental What {@link replayUnsyncedEdits} takes. */
export type YReplayInput = {
  readonly binding: YOfflineBinding;
  readonly report: YOfflineReport | YUnsyncedReport;
  /** Only these block ids (a panel's Reapply button). */
  readonly only?: readonly string[];
  /** Whether the report's merged blocks are applied. @defaultValue true */
  readonly blockMerge?: boolean;
  /** The clock `autoReplay`'s `maxBaseAge` reads, for tests. @defaultValue `Date.now` */
  readonly now?: () => number;
} & YLeftoversRequiredPassWrapOrHandle &
  YAutoReplayRequiredPassReplayableNoneOrMaxBaseAge;

const hasContent = (block: YUnsyncedBlock): block is YLeftoverBlock =>
  block.yours !== null;

/** One place leftovers are written at, while the update runs. */
interface Placing {
  readonly anchor: LexicalNode | null;
  readonly after: string | null;
  readonly blocks: YLeftoverBlock[];
  fallback: string | null;
  keys: string[];
}

/**
 * Every block id the document stores, with the top-level block it is in
 * (itself, for a top-level block). A top-level block's own id wins over a
 * nested block's.
 */
function $topLevelById(): Map<string, LexicalNode> {
  const index = new Map<string, LexicalNode>();
  const top = $getRoot().getChildren();
  for (const node of top) {
    const id = $storedBlockId(node);
    if (id !== null && !index.has(id)) {
      index.set(id, node);
    }
  }
  const visit = (node: LexicalNode, within: LexicalNode) => {
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        const id = $storedBlockId(child);
        if (id !== null && !index.has(id)) {
          index.set(id, within);
        }
        visit(child, within);
      }
    }
  };
  for (const node of top) {
    visit(node, node);
  }
  return index;
}

/** Every block id under `nodes` (serialized), at any depth. */
function idsUnder(nodes: readonly unknown[], into: Set<string>): Set<string> {
  for (const node of nodes) {
    if (typeof node === 'object' && node !== null) {
      const id = blockIdOf(node as SerializedLexicalNode);
      if (id !== null) {
        into.add(id);
      }
      const {$slots, children} = node as {$slots?: unknown; children?: unknown};
      if (typeof $slots === 'object' && $slots !== null) {
        idsUnder(Object.values($slots), into);
      }
      if (Array.isArray(children)) {
        idsUnder(children, into);
      }
    }
  }
  return into;
}

/**
 * Gives every identified block under the nodes just written (in an editor
 * update) a new id, with the editor's `generateId`: one no block of the
 * document or of the report has (`taken`). Left to BlockIdExtension, a
 * block written where the same update removed one would continue the
 * removed block's id, which a collaborator's block may still have. Without
 * BlockIdExtension (or with it disabled) nothing has an id.
 */
function $mintBlockIds(
  editor: LexicalEditor,
  nodes: readonly LexicalNode[],
  taken: Set<string>,
  preset: string[],
): void {
  const blockIds = getPeerDependencyFromEditor<typeof BlockIdExtension>(
    editor,
    '@lexical/extension/BlockId',
  );
  if (blockIds === undefined || blockIds.output.disabled.peek()) {
    return;
  }
  const {generateId} = blockIds.config;
  const fresh = (): string => {
    // An id chosen before the update (recoverYOfflineEdits records it with
    // its claim), first.
    const chosen = preset.shift();
    if (chosen !== undefined && !taken.has(chosen)) {
      return chosen;
    }
    // As BlockIdExtension does: an id already used is made again.
    for (let i = 0; i < 32; i++) {
      const id = generateId();
      if (typeof id === 'string' && id !== '' && !taken.has(id)) {
        return id;
      }
    }
    for (;;) {
      const id = generateBlockId();
      if (!taken.has(id)) {
        return id;
      }
    }
  };
  const visit = (node: LexicalNode) => {
    if (blockIds.output.$isIdentifiedBlock(node)) {
      const id = fresh();
      taken.add(id);
      $setState(node, blockIdState, id);
    }
    // A host's slots (a wrapper's collapsible keeps its blocks in one).
    for (const name of $getSlotNames(node)) {
      const slot = $getSlot(node, name);
      if (slot !== null) {
        visit(slot);
      }
    }
    if ($isElementNode(node)) {
      node.getChildren().forEach(visit);
    }
  };
  nodes.forEach(visit);
}

/**
 * Write `blocks` into the document (in an editor update): grouped by the
 * block each goes after, through `wrap`, or as they are where its output
 * cannot be written.
 */
function $insertLeftovers(
  editor: LexicalEditor,
  preset: string[],
  blocks: readonly YLeftoverBlock[],
  leftovers: YLeftoversWrapped,
  report: YOfflineReport | YUnsyncedReport,
  taken: Set<string>,
): Placing[] {
  const placement = leftovers.placement ?? 'after-block';
  // The user's order: what "the nearest block before it" is read from.
  const order =
    report.order ?? report.blocks.filter(hasContent).map(block => block.id);
  const index = placement === 'top' ? null : $topLevelById();
  const places = new Map<string, Placing>();
  for (const block of blocks) {
    let anchor: LexicalNode | null = null;
    if (index !== null) {
      anchor = index.get(block.id) ?? null;
      for (
        let i = order.indexOf(block.id) - 1;
        anchor === null && i >= 0;
        i--
      ) {
        anchor = index.get(order[i]) ?? null;
      }
    }
    const key = anchor === null ? '' : anchor.getKey();
    let place = places.get(key);
    if (place === undefined) {
      place = {
        after: anchor === null ? null : $storedBlockId(anchor),
        anchor,
        blocks: [],
        fallback: null,
        keys: [],
      };
      places.set(key, place);
    }
    place.blocks.push(block);
  }
  const hasNode = (type: string) =>
    getRegisteredNode(editor, type) !== undefined;
  for (const place of places.values()) {
    let nodes: LexicalNode[] | string;
    try {
      const output: unknown = leftovers.wrap(place.blocks, {
        after: place.after,
        capturedAt: report.capturedAt,
        hasNode,
        placement,
        reason: report.reason,
      });
      nodes =
        refuseWrapped(editor, place.blocks, output) ??
        $parseWrapped(output as readonly SerializedLexicalNode[]);
    } catch (error) {
      nodes = `leftovers.wrap threw (${String(
        error,
      )}); it must return serialized blocks for any blocks it is given.`;
    }
    if (typeof nodes === 'string') {
      // Never dropped: the blocks as the user had them.
      place.fallback = `${nodes} The blocks were written as they are instead.`;
      nodes = place.blocks.map(block => $rawLeftover(editor, block));
    }
    let last = place.anchor;
    for (const node of nodes) {
      if (last !== null) {
        last.insertAfter(node);
      } else {
        const first = $getRoot().getFirstChild();
        if (first !== null) {
          first.insertBefore(node);
        } else {
          $getRoot().append(node);
        }
      }
      last = node;
      place.keys.push(node.getKey());
    }
    // Once attached: which blocks are identified depends on where they are.
    $mintBlockIds(editor, nodes, taken, preset);
  }
  return [...places.values()];
}

/**
 * @experimental Apply a report to the bound editor, as one editor update
 * the binding writes and one undo step. Nothing of the report is dropped:
 *
 * - a replayable block is applied: a changed block replaces the current
 *   one, an added block is inserted after the nearest block before it that
 *   the document holds (before the nearest after it when there is none; at
 *   the end for a report built by hand without `order`), a deleted block is
 *   removed. A block the report merged (resolution `'merged'`: both sides
 *   changed it, and their changes do not overlap) is replaced by the
 *   merge. Each is checked again against the
 *   editor as it is now (the block still equals the base, or for a merge
 *   the block the merge was made from; an added block's
 *   id is still absent), so a block someone else changed is never
 *   overwritten;
 * - every other block the user added or changed (both sides changed it and
 *   the merge did not resolve it or `blockMerge: false` turned it off, it
 *   is gone, the report has no base or no ids, it changed since the report)
 *   goes where the required `leftovers` says: with
 *   `{wrap: wrapLeftoversAsQuote('…')}`, into the document in the same
 *   update, through `wrap`, with new block ids (`inserted`); with
 *   `{handle: blocks => …}`, to your handler, which is then the only place
 *   they are.
 *
 * `only` limits it to those block ids (the panel's Reapply button). Call it
 * outside an editor update (not from an update listener or a command
 * handler): the edit must be written before it returns. With `wrap`, call
 * it once per report: a second call (or a Reapply of a block it already
 * wrote) writes the leftovers again, since nothing tells written copies
 * from the user's (`recoverYOfflineEdits` keeps that record on the capture,
 * `resolved`). It throws, with nothing written, when the editor update
 * fails or the binding does not store it (it turns read only).
 *
 * @example
 * ```ts
 * const {applied, inserted} = replayUnsyncedEdits({
 *   autoReplay: 'replayable',
 *   binding,
 *   report,
 *   leftovers: {wrap: wrapLeftoversAsQuote('Offline edits that did not merge')},
 * });
 * ```
 */
export function replayUnsyncedEdits(input: YReplayInput): YReplayResult {
  return replayWithIds(input, []);
}

/**
 * Up to `count` new block ids from the editor's own `generateId` (the ids
 * its leftovers get), or none when it gives no block ids or its generator
 * fails: then nothing is recorded, and a retake writes again.
 */
function chooseBlockIds(
  editor: LexicalEditor,
  count: number,
  report: YUnsyncedReport,
): string[] {
  const blockIds = getPeerDependencyFromEditor<typeof BlockIdExtension>(
    editor,
    '@lexical/extension/BlockId',
  );
  if (blockIds === undefined || blockIds.output.disabled.peek()) {
    return [];
  }
  // No id the document or the report already has, as the write skips
  // those (a counting generator gives the document's own ids again): a
  // retake would find such an id in the document without the write.
  const taken = idsUnder(
    editor.read(() => editor.getEditorState().toJSON().root.children),
    new Set<string>(),
  );
  for (const block of report.blocks) {
    idsUnder([block.yours, block.base, block.now], taken);
  }
  const ids = new Set<string>();
  try {
    for (let i = 0; i < count * 4 && ids.size < count; i++) {
      const id: unknown = blockIds.config.generateId();
      if (typeof id === 'string' && id !== '' && !taken.has(id)) {
        ids.add(id);
      }
    }
  } catch {
    return [];
  }
  return [...ids];
}

/** Whether the bound editor holds a block of id `id`, at any depth. */
function holdsBlockId(editor: LexicalEditor, id: string): boolean {
  return editor.read(() => {
    const $holds = (node: LexicalNode): boolean =>
      $getState(node, blockIdState) === id ||
      $getSlotNames(node).some(name => {
        const slot = $getSlot(node, name);
        return slot !== null && $holds(slot);
      }) ||
      ($isElementNode(node) && node.getChildren().some($holds));
    return $holds($getRoot());
  });
}

/**
 * replayUnsyncedEdits, with the first ids its leftovers are given chosen
 * beforehand (`preset`, consumed): a recovery records the first with its
 * claim, so a later retake can tell whether the write is in its document.
 */
function replayWithIds(input: YReplayInput, preset: string[]): YReplayResult {
  // Before anything is read or written: without it, a JavaScript caller
  // would drop the blocks that cannot be replayed.
  requireLeftovers('replayUnsyncedEdits', input);
  requireAutoReplay('replayUnsyncedEdits', input);
  const {autoReplay, binding, leftovers, only, report} = input;
  const auto = autoReplays(
    autoReplay,
    'baseAt' in report ? report.baseAt : null,
    (input.now ?? Date.now)(),
  );
  if (binding.status.kind !== 'active') {
    throw new Error(
      `@lexical/y/offline: replayUnsyncedEdits needs an active binding (it is ${
        binding.status.kind
      }): replay into the fresh document at the current epoch, after binding.markSynced(), never into the frozen one.`,
    );
  }
  const editor = binding.binding.editor;
  const applied: string[] = [];
  const notApplied: {id: string; reason: YReplaySkipReason}[] = [];
  const wanted = only === undefined ? null : new Set(only);
  if (wanted !== null) {
    for (const id of wanted) {
      if (!report.blocks.some(block => block.id === id)) {
        notApplied.push({id, reason: 'not-in-report'});
      }
    }
  }
  const candidates = report.blocks.filter(
    block => wanted === null || wanted.has(block.id),
  );
  // The editor as it is now (a pending update included).
  const live = editor.read(
    () => editor.getEditorState().toJSON().root.children,
  );
  const liveIds = live.map(blockIdOf);
  const hasIds =
    liveIds.every(id => id !== null) &&
    new Set(liveIds).size === liveIds.length;
  const liveIndex = new Map<string, number>();
  if (hasIds) {
    liveIds.forEach((id, i) => liveIndex.set(id as string, i));
  }
  const order = report.order ?? [];
  // What to write for each block: the user's (null: remove it), or the
  // merge of theirs and the document's.
  const todo: {block: YUnsyncedBlock; write: SerializedLexicalNode | null}[] =
    [];
  /** Not applied, and not in the document: written or handed over. */
  const left: YUnsyncedBlock[] = [];
  // Blocks paired by position (no block ids): the report says which of
  // them the document holds by content (`shifted`: one block added or
  // removed offline shifts every later one); a report built by hand is
  // compared by position.
  const shifted = report.shifted === undefined ? null : new Set(report.shifted);
  for (const block of candidates) {
    const byPosition = block.id.startsWith('#');
    const at = byPosition ? Number(block.id.slice(1)) : liveIndex.get(block.id);
    const now = at === undefined ? null : (live[at] ?? null);
    // A block both sides changed that the report merged: the merge, unless
    // the document already holds it (`held`), and never with
    // `blockMerge: false`.
    const mergedBlock =
      block.resolution === 'merged' && block.merged != null
        ? block.merged
        : null;
    const held =
      mergedBlock !== null && canonical(mergedBlock) === canonical(now);
    const merged = input.blockMerge !== false && !held ? mergedBlock : null;
    if (block.replayable && hasIds && sameJSON(now, block.base) && auto) {
      todo.push({block, write: block.yours});
    } else if (
      !block.replayable &&
      merged !== null &&
      hasIds &&
      !byPosition &&
      sameJSON(now, block.now) &&
      auto
    ) {
      // The merge is written over the block it was made from, checked as
      // a whole block is.
      todo.push({block, write: merged});
    } else if (
      byPosition
        ? shifted !== null
          ? shifted.has(block.id)
          : sameJSON(now, block.yours)
        : hasIds && (sameJSON(now, block.yours) || held)
    ) {
      notApplied.push({id: block.id, reason: 'in-document'});
    } else {
      notApplied.push({
        id: block.id,
        reason:
          !block.replayable && merged === null
            ? 'not-replayable'
            : !hasIds
              ? 'no-block-ids'
              : !sameJSON(now, block.replayable ? block.base : block.now)
                ? 'changed-since'
                : 'not-auto-replayed',
      });
      left.push(block);
    }
  }
  const wrapped = leftovers.wrap !== undefined ? leftovers : null;
  const handOver = (): string[] => {
    if (leftovers.handle === undefined || left.length === 0) {
      return [];
    }
    leftovers.handle(left, {
      captureId: 'captureId' in report ? report.captureId : null,
      report,
    });
    return left.map(block => block.id);
  };
  if (todo.length === 0 && (wrapped === null || !left.some(hasContent))) {
    return {
      applied,
      handled: handOver(),
      inserted: [],
      leftovers: [],
      notApplied,
    };
  }
  const um = binding.binding.undoManager;
  if (um !== null) {
    um.stopCapturing();
  }
  // Pushed to `applied` once the update has committed.
  const done: string[] = [];
  let places: Placing[] = [];
  let committed = false;
  editor.update(
    () => {
      const nodes = $getRoot().getChildren();
      const byId = new Map<string, LexicalNode>();
      liveIds.forEach((id, i) => {
        if (nodes[i] !== undefined) {
          byId.set(id as string, nodes[i]);
        }
      });
      for (const {block, write} of todo) {
        let made: LexicalNode | null = null;
        if (write !== null) {
          try {
            made = $parseSerializedNode(write);
          } catch {
            notApplied.push({id: block.id, reason: 'unreadable'});
            left.push(block);
            continue;
          }
        }
        const existing = byId.get(block.id);
        if (made === null) {
          if (existing !== undefined) {
            existing.remove();
            byId.delete(block.id);
          }
        } else if (existing !== undefined) {
          // A caret inside the block would stay on its old nodes, which
          // the swap removes: it moves to the end of the new block.
          const selection = $getSelection();
          const inside =
            selection !== null &&
            selection
              .getNodes()
              .some(node => node.is(existing) || existing.isParentOf(node));
          existing.replace(made);
          if (inside) {
            made.selectEnd();
          }
          byId.set(block.id, made);
        } else {
          // After the nearest block before it that the document holds.
          let anchor: LexicalNode | undefined;
          for (let i = order.indexOf(block.id) - 1; i >= 0; i--) {
            anchor = byId.get(order[i]);
            if (anchor !== undefined) {
              break;
            }
          }
          if (anchor !== undefined) {
            anchor.insertAfter(made);
          } else {
            // None before it: before the nearest block after it, else (a
            // report without the user's order, or none of their blocks
            // left) at the end.
            const at = order.indexOf(block.id);
            for (let i = at + 1; at >= 0 && i < order.length; i++) {
              anchor = byId.get(order[i]);
              if (anchor !== undefined) {
                break;
              }
            }
            if (anchor !== undefined) {
              anchor.insertBefore(made);
            } else {
              $getRoot().append(made);
            }
          }
          byId.set(block.id, made);
        }
        done.push(block.id);
      }
      // The rest, in the same update: after the replayed blocks are in
      // place, so one of them can be what a leftover goes after.
      if (wrapped !== null) {
        // In the user's order (a block that failed to parse above was
        // pushed last).
        const position = new Map(
          report.blocks.map((block, i) => [block.id, i]),
        );
        const content = left
          .filter(hasContent)
          .sort((a, b) => position.get(a.id)! - position.get(b.id)!);
        if (content.length > 0) {
          // No id of the document (as it was, and as it is now) or of
          // the report is given to what is written.
          const taken = idsUnder(live, new Set<string>());
          const $visit = (node: LexicalNode) => {
            const id = $storedBlockId(node);
            if (id !== null) {
              taken.add(id);
            }
            if ($isElementNode(node)) {
              node.getChildren().forEach($visit);
            }
          };
          $visit($getRoot());
          for (const block of report.blocks) {
            idsUnder([block.yours, block.base, block.now], taken);
          }
          places = $insertLeftovers(
            editor,
            preset,
            content,
            wrapped,
            report,
            taken,
          );
        }
      }
    },
    {
      discrete: true,
      onUpdate: () => {
        committed = true;
      },
    },
  );
  if (um !== null) {
    um.stopCapturing();
  }
  // The editor committed it, but the binding may have refused to store it
  // (it turns read only, e.g. `unstorable-change` for a node the document
  // cannot store): then it is not in the document either.
  // Read again (the update may have changed it; TypeScript keeps the
  // narrowing of the check above).
  const statusNow = (binding.status as {readonly kind: string}).kind;
  const refused = committed && statusNow !== 'active';
  if (!committed || refused) {
    // Nothing was written. With wrap, a result would be the only place
    // these blocks are: it fails instead, with the report unchanged for a
    // later call (recoverYOfflineEdits keeps the capture).
    if (wrapped !== null) {
      throw new Error(
        refused
          ? `@lexical/y/offline: the binding did not store replayUnsyncedEdits' update (it is now ${statusNow}; see its warning), so nothing of the report is in the document: fix what the warning names (a wrapper's output the document cannot store), reload, and call it again, or pass leftovers: {handle} to take the blocks yourself.`
          : `@lexical/y/offline: replayUnsyncedEdits' editor update failed (the editor's onError has the error), so nothing of the report was applied or inserted: call it again with the same report once the editor works, or pass leftovers: {handle} to take the blocks yourself.`,
      );
    }
    // With handle: every block with content goes to the handler, the
    // replayable ones too, since none was applied.
    for (const {block} of todo) {
      if (!left.includes(block)) {
        left.push(block);
      }
    }
    return {
      applied,
      handled: handOver(),
      inserted: [],
      leftovers: [],
      notApplied: [
        ...notApplied
          .filter(skip => skip.reason === 'not-in-report')
          .map(skip => ({id: skip.id, reason: skip.reason})),
        ...candidates.map(block => ({
          id: block.id,
          reason: 'not-written' as const,
        })),
      ],
    };
  }
  for (const id of done) {
    applied.push(id);
  }
  // The ids minted for what was written; positions in an editor without
  // block ids.
  const written = editor.read('latest', () =>
    places.map(
      (place): YLeftoversInserted => ({
        after: place.after,
        blocks: place.blocks.map(block => block.id),
        fallback: place.fallback,
        inserted: place.keys.flatMap(key => {
          const node = $getNodeByKey(key);
          return node === null
            ? []
            : [$storedBlockId(node) ?? `#${node.getIndexWithinParent()}`];
        }),
      }),
    ),
  );
  return {
    applied,
    handled: handOver(),
    inserted: written.flatMap(place => place.inserted),
    leftovers: written,
    notApplied,
  };
}

/** @experimental One capture of {@link recoverYOfflineEdits}' result. */
export interface YOfflineRecovered {
  /** The capture; `resolved` is set once its leftovers are in the document. */
  readonly capture: YOfflineCapture;
  /**
   * What is left to show (nothing, for a capture whose leftovers were
   * written into the document), or why the capture could not be read.
   */
  readonly report: YOfflineResult<YOfflineReport>;
  /**
   * What the replay stage applied and inserted; null when it did not run
   * for this capture in this call.
   */
  readonly replay: YReplayResult | null;
}

/**
 * How long a claim that resolved nothing is left alone, in milliseconds: a
 * replay is synchronous, so a claim this old is not one being written.
 */
const STALE_CLAIM_MS = 60000;
/**
 * How many leftover block ids a claim chooses before its write: a retake
 * finds the write by any of them, so a collaborator deleting the first
 * (the label) does not make it write everything again.
 */
const CLAIMED_IDS = 16;

/** @experimental What {@link recoverYOfflineEdits} takes. */
export type YOfflineRecoverInput = {
  /** The fresh document's binding: active, synced, at `epoch`. */
  readonly binding: YOfflineBinding;
  readonly store: YOfflineStore | null;
  readonly key: string;
  /** The epoch the fresh document is at. */
  readonly epoch: string;
  readonly stage: YOfflineStage;
  readonly config: HeadlessYConfig;
  readonly migrate?: (state: Uint8Array) => Uint8Array;
  /**
   * Whether a block both sides changed is merged three ways and replayed
   * where their changes do not overlap. `false`: it stays in the panel.
   * @defaultValue true
   */
  readonly blockMerge?: boolean;
  /**
   * The fresh document's offline session: with it, a capture the server
   * already holds (its session reports no unsynced edits) is deleted.
   */
  readonly session?: YOfflineSession;
  /** The clock, for tests. @defaultValue `Date.now` */
  readonly now?: () => number;
} & YLeftoversRequiredPassWrapOrHandle &
  YAutoReplayRequiredPassReplayableNoneOrMaxBaseAge;

/**
 * @experimental On a fresh document at the current epoch, after its first
 * sync: gather what did not sync and, at stage `'replay'`, put it back. In
 * order:
 *
 * 1. every slot of `key` left at another epoch (a tab that closed before it
 *    could freeze), or never synced (edits made on this device that never
 *    reached a server: their base is unknown, so nothing of them is
 *    replayable), becomes a capture;
 * 2. each capture is described against the document as it is now;
 * 3. at stage `'replay'`, each capture this call claims (once, across tabs)
 *    is written in one editor update, one undo step: its replayable blocks,
 *    and the blocks merged with someone else's changes, are applied, and
 *    with `leftovers: {wrap}` every other block the user
 *    added or changed is written through `wrap` (see
 *    {@link replayUnsyncedEdits}). The capture is then resolved
 *    (`capture.resolved`): nothing of it is left to show. A capture claimed
 *    more than a minute ago and never resolved (its tab closed, or its
 *    blocks went to a handler) is taken again;
 * 4. with `leftovers: {handle}`, the handler is called with the blocks each
 *    capture has left (at `'persist'`, all of them; at `'replay'`, those
 *    not applied), and the capture stays until your app deletes it;
 * 5. a capture with nothing left to show is deleted once the server holds
 *    the document: only with `session`, the document's offline session,
 *    reporting no unsynced edits (after its `'same'` verdict's
 *    `markSynced()`). Without it,
 *    or while the document holds edits the server lacks (a replay that has
 *    not synced), such a capture is returned with no blocks: until the
 *    server holds what was written, the capture may be its only stored
 *    copy.
 *
 * The result is the Offline edits panel's content: at `'replay'` with
 * `wrap`, what was reapplied and where the rest was inserted. Stage `'off'`
 * returns an empty list and touches nothing.
 */
export async function recoverYOfflineEdits(
  input: YOfflineRecoverInput,
): Promise<YOfflineResult<YOfflineRecovered[]>> {
  const entry = 'recoverYOfflineEdits';
  // At every stage, 'off' included: a call shipped dark fails here, not on
  // the day the stage is raised.
  requireLeftovers(entry, input);
  requireAutoReplay(entry, input);
  requireStage(entry, input.stage);
  const {
    autoReplay,
    binding,
    config,
    epoch,
    key,
    leftovers,
    migrate,
    stage,
    store,
  } = input;
  if (stage === 'off' || store === null) {
    return ok([]);
  }
  requireOption(
    typeof epoch === 'string' && epoch !== '',
    `${entry} needs epoch: the epoch the fresh document is at, as a non-empty string.`,
  );
  const now = input.now ?? Date.now;
  // 1. Slots left at another epoch.
  const slots = await store.slots(key);
  if (!slots.ok) {
    return slots;
  }
  for (const info of slots.value) {
    if (info.epoch === epoch) {
      continue;
    }
    // Only rows whose writer is gone: a tab still open at that epoch keeps
    // its rows, and captures them itself when it learns the epoch moved.
    // In one transaction where the store can, so two tabs recovering at
    // once make one capture (the second finds no rows).
    if (store.captureSlot !== undefined) {
      const staleEpoch = info.epoch;
      const made = await store.captureSlot(key, staleEpoch, stored => ({
        base: stored.base,
        baseAt: stored.base === null ? null : (stored.baseAt ?? null),
        capturedAt: now(),
        claimed: false,
        differs: false,
        epoch: staleEpoch,
        id: newCaptureId(now()),
        json: null,
        key,
        reason: 'stale',
        state: stored.state,
        text: null,
      }));
      if (!made.ok) {
        // Left as it is, for the app to salvage or clear (error.epoch).
        return made;
      }
      continue;
    }
    const stale = store.slot(key, info.epoch);
    const stored = await stale.load({writers: 'gone'});
    if (!stored.ok) {
      // Left as it is, for the app to salvage or clear.
      return stored;
    }
    if (stored.value !== null && stored.value.hasUnsyncedEdits) {
      const saved = await store.putCapture({
        base: stored.value.base,
        baseAt:
          stored.value.base === null ? null : (stored.value.baseAt ?? null),
        capturedAt: now(),
        claimed: false,
        differs: false,
        epoch: info.epoch,
        id: newCaptureId(now()),
        json: null,
        key,
        reason: 'stale',
        state: stored.value.state,
        text: null,
      });
      if (!saved.ok) {
        return saved;
      }
    }
    const discarded = await stale.discard();
    if (!discarded.ok) {
      return discarded;
    }
  }
  // 2 to 5.
  const captures = await store.captures(key);
  if (!captures.ok) {
    return captures;
  }
  const doc = binding.binding.doc;
  const describe = (capture: YOfflineCapture) =>
    describeYOfflineCapture(capture, {
      blockMerge: input.blockMerge,
      config,
      current: encodeStateAsUpdate(doc),
      migrate,
    });
  const wraps = leftovers.wrap !== undefined;
  /**
   * Whether this document holds the write that resolved `capture` (the
   * state vector recorded with it): until then it may be only in the tab
   * that wrote it.
   */
  const holdsResolution = (capture: YOfflineCapture): boolean => {
    if (capture.resolved === undefined) {
      return false;
    }
    const held = readStateVector(encodeStateVector(doc));
    for (const [client, clock] of readStateVector(capture.resolved.vector)) {
      if ((held.get(client) ?? 0) < clock) {
        return false;
      }
    }
    return true;
  };
  const resolve = async (
    capture: YOfflineCapture,
    inserted: readonly string[],
  ): Promise<YOfflineResult<YOfflineCapture>> => {
    const made: YOfflineCapture = {
      ...capture,
      claimed: true,
      resolved: {at: now(), inserted, vector: encodeStateVector(doc)},
    };
    const saved = await store.putCapture(made);
    return saved.ok ? ok(made) : saved;
  };
  /** Give the claim up: nothing was written. */
  const release = (capture: YOfflineCapture) => {
    const {claimedWrite: _written, ...rest} = capture;
    return store.putCapture({...rest, claimed: false});
  };
  const recovered: YOfflineRecovered[] = [];
  for (const stored of captures.value) {
    let capture = stored;
    let report = describe(capture);
    let replay: YReplayResult | null = null;
    // Taken by this call: a capture nobody claimed, or (with wrap) one
    // claimed a minute ago or more whose write this document does not
    // hold: by a tab that closed before it wrote the capture, or before
    // what it wrote synced, or by a call that gave its blocks to a
    // handler. With wrap nothing else would ever show these blocks. The
    // retake is atomic across tabs (claimCapture's `retake`); what the
    // first claim wrote and synced after all would then be in the
    // document twice (seen twice, never not at all).
    let taken = false;
    if (
      stage === 'replay' &&
      report.ok &&
      binding.status.kind === 'active' &&
      report.value.blocks.length > 0
    ) {
      const stale =
        wraps &&
        capture.claimed &&
        !holdsResolution(capture) &&
        now() -
          (capture.resolved !== undefined
            ? capture.resolved.at
            : (capture.claimedAt ?? 0)) >=
          STALE_CLAIM_MS;
      const wanted =
        !capture.claimed &&
        // With wrap, every block is written; a handler's capture is claimed
        // only for what can be applied.
        (wraps ||
          (autoReplays(autoReplay, report.value.baseAt, now()) &&
            report.value.blocks.some(
              block =>
                block.replayable ||
                (input.blockMerge !== false && block.resolution === 'merged'),
            )));
      if (stale || wanted) {
        const claimed = await store.claimCapture(
          key,
          capture.id,
          stale ? {retake: {claimedAt: capture.claimedAt ?? null}} : undefined,
        );
        if (!claimed.ok) {
          return claimed;
        }
        taken = claimed.value;
        if (taken) {
          const {resolved: _resolved, claimedWrite: written, ...rest} = capture;
          capture = {...rest, claimed: true, claimedAt: now()};
          if (
            stale &&
            written !== undefined &&
            // A block it wrote for the leftovers is in this document.
            written.ids.some(id => holdsBlockId(binding.binding.editor, id))
          ) {
            // The first claimant's write is in this document: its mark
            // that everything was written was lost, not the write.
            // Resolved, not written again.
            const resolved = await resolve(capture, []);
            if (!resolved.ok) {
              return resolved;
            }
            capture = resolved.value;
            report = describe(capture);
            taken = false;
          } else if (wraps) {
            // The ids the first blocks it writes for the leftovers get,
            // chosen before the write: a retake can tell the write is in its
            // document if the mark after it is lost (by its content: the
            // document's clock also moves for a write that failed, then for
            // anything typed after). Only with wrap (a handler's claim
            // writes only the replayable blocks) and block ids; without
            // them a retake writes again: seen twice, never lost.
            const ids = report.ok
              ? chooseBlockIds(
                  binding.binding.editor,
                  CLAIMED_IDS,
                  report.value,
                )
              : [];
            if (ids.length > 0) {
              capture = {...capture, claimedWrite: {ids}};
              const recorded = await store.putCapture(capture);
              if (!recorded.ok) {
                return recorded;
              }
            }
          }
        }
      }
    }
    if (taken) {
      // Described again: the claim was awaited.
      report = describe(capture);
      if (
        !report.ok ||
        (binding.status as {readonly kind: string}).kind !== 'active'
      ) {
        // The document went read only while the claim was awaited (or the
        // capture cannot be read now): nothing is written, and the claim
        // is given up for a later call rather than left to time out.
        const released = await release(capture);
        if (!released.ok) {
          return released;
        }
        capture = {...capture, claimed: false};
        taken = false;
      }
    }
    if (taken && report.ok) {
      try {
        const preset =
          capture.claimedWrite === undefined
            ? []
            : [...capture.claimedWrite.ids];
        replay = replayWithIds(
          {
            autoReplay,
            binding,
            blockMerge: input.blockMerge,
            // A handler is called below, once, with what is left.
            leftovers:
              leftovers.wrap !== undefined ? leftovers : {handle: () => {}},
            now,
            report: report.value,
          },
          preset,
        );
        if (
          !wraps &&
          replay.notApplied.some(skip => skip.reason === 'not-written')
        ) {
          // The editor update failed (its onError did not throw): nothing
          // was written, so the claim is released for a later call. (With
          // wrap, the replay throws instead, below.)
          const released = await release(capture);
          if (!released.ok) {
            return released;
          }
        } else if (wraps) {
          // Everything of it is in the document: nothing is left to
          // show, and it goes once the server holds the document.
          const resolved = await resolve(capture, replay.inserted);
          if (!resolved.ok) {
            return resolved;
          }
          capture = resolved.value;
        }
        report = describe(capture);
      } catch (error) {
        // Nothing was applied: the claim is released, so a later call
        // replays it, and the failure is this capture's.
        await release(capture);
        report = fail({
          cause: error,
          code: 'failed',
          message: `@lexical/y/offline: replaying this capture failed (${String(
            error,
          )}); nothing was applied and the capture is kept for a later call or the panel.`,
        });
      }
    }
    if (
      wraps &&
      stage === 'replay' &&
      report.ok &&
      capture.resolved === undefined &&
      binding.status.kind === 'active' &&
      report.value.blocks.length === 0 &&
      report.value.orderDiffers
    ) {
      // Only the block order differs: everything of it is in the document,
      // and a move is not replayed (D125). With wrap there is no panel to
      // dismiss it from, and a capture kept for ever counts against the
      // store's limits, which refuse later writes: it is resolved, and this
      // call's result still says orderDiffers.
      const resolved = await resolve(capture, []);
      if (!resolved.ok) {
        return resolved;
      }
      capture = resolved.value;
      recovered.push({capture, replay, report});
      continue;
    }
    if (
      report.ok &&
      capture.resolved !== undefined &&
      (holdsResolution(capture) || now() - capture.resolved.at < STALE_CLAIM_MS)
    ) {
      // Its blocks were applied or written into the document (a later
      // change to one of them is the document's history, not an edit that
      // did not sync), here or, a moment ago, in another tab whose write
      // has not arrived yet. One whose write never arrives is taken again
      // above, a minute on.
      report = ok({...report.value, blocks: [], fragment: []});
    }
    if (
      leftovers.handle !== undefined &&
      report.ok &&
      report.value.blocks.length > 0
    ) {
      // The only place these blocks go: the app's handler, every call.
      leftovers.handle(report.value.blocks, {
        captureId: capture.id,
        report: report.value,
      });
      if (replay !== null) {
        replay = {...replay, handled: report.value.blocks.map(b => b.id)};
      }
    }
    // Nothing left to show, and the server holds the document: the capture
    // goes. Not in the call that replayed it, not while the document holds
    // edits the server lacks (what was written may be in this page only),
    // and not while its block order differs, unless it is resolved (with
    // wrap, nothing of it is left to show).
    const serverHolds =
      input.session !== undefined &&
      !input.session.ended &&
      input.session.epoch === epoch &&
      !input.session.hasUnsyncedEdits;
    if (
      serverHolds &&
      report.ok &&
      replay === null &&
      report.value.blocks.length === 0 &&
      (capture.resolved !== undefined
        ? // The write that resolved it is in this document, which the
          // server holds: not just marked by another tab.
          holdsResolution(capture)
        : !report.value.orderDiffers)
    ) {
      const deleted = await store.deleteCapture(key, capture.id);
      if (!deleted.ok) {
        return deleted;
      }
      continue;
    }
    recovered.push({capture, replay, report});
  }
  return ok(recovered);
}
