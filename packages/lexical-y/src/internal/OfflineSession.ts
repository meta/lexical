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
//   const session = attachYOfflineSession({binding, store, key,
//     epoch: loaded.epoch, loaded, stage, onError});
//
//   // 1. the server said which epoch the room is at: before syncing, on
//   //    every connect, and on a "replaced" event (a reload or a layout
//   //    upgrade of the room is the same signal: a new epoch):
//   const verdict = await session.serverEpoch(epoch);
//   //    'same': sync this document. 'moved': it is frozen and captured;
//   //    open a fresh document at the new epoch, then
//   //    recoverYOfflineEdits() there.
//   // 2. the server holds everything the document holds:
//   session.markSynced();
//
// It uses the binding's public API only (`freeze()`, `status`, the editor)
// and `describeUnsyncedEdits`: nothing here depends on a layout.

import {
  encodeStateAsUpdate,
  encodeStateVector,
  mergeUpdates,
  type Transaction,
} from '@y/y';
import {
  $getEditor,
  $getRoot,
  $getSelection,
  $parseSerializedNode,
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
 * - `'persist'`: every edit is stored on the device as it is made
 *   (`persistEdits`), and a document whose epoch moved (a reconnect to a
 *   replaced or upgraded room) is frozen and stored with its base, for the
 *   Offline edits panel;
 * - `'replay'`: as `'persist'`, and {@link recoverYOfflineEdits} applies the
 *   blocks that are replayable.
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
 *   turns it into a capture. There is nothing to ask `serverEpoch` until
 *   the server replaces the room.
 *
 * A key has more than one slot only when a tab was left at an earlier
 * epoch.
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
      epoch: wanted === undefined ? null : wanted,
      hasUnsyncedEdits: false,
      slot: null,
      state: null,
    });
  }
  const {epoch} = found;
  const slot = input.store.slot(input.key, epoch);
  const stored = await slot.load();
  if (!stored.ok) {
    return stored;
  }
  return ok({
    base: stored.value === null ? null : stored.value.base,
    epoch,
    hasUnsyncedEdits: stored.value !== null && stored.value.hasUnsyncedEdits,
    slot,
    state: stored.value === null ? null : stored.value.state,
  });
}

/**
 * @experimental Options of {@link attachYOfflineSession}: `binding`, `store`,
 * `key`, `epoch`, `stage` and `onError` are required.
 */
export interface YOfflineSessionOptions {
  /**
   * The bound editor: what `createYBinding` returns, YCollabExtension's
   * `collab`, or any {@link YOfflineBinding}.
   */
  readonly binding: YOfflineBinding;
  /** From `openYOfflineStore`; null only with stage `'off'`. */
  readonly store: YOfflineStore | null;
  /** The document's name in your app (its id). */
  readonly key: string;
  /**
   * The epoch (generation) the document was made against, as a string:
   * `loaded.epoch` for a document created from {@link loadYOffline}, the
   * server's for one fetched from it, null for one that never synced.
   */
  readonly epoch: string | null;
  /** The rollout stage (see {@link YOfflineStage}). */
  readonly stage: YOfflineStage;
  /**
   * `true` (the default): every update is stored as it is made, so the
   * document survives a reload, a crash or a closed tab with no connection,
   * and a later page captures what did not sync. `false`: only captures
   * are stored (a moved epoch while the tab is open); unsynced edits live
   * in the tab until it syncs, and adds no `update` listener. Whether the
   * editor is editable before the server answers (offline editing) is the
   * app's choice, made when it binds (`synced`), not this one.
   * @defaultValue `true`
   */
  readonly persistEdits?: boolean;
  /**
   * What `persistEdits` keeps on the device:
   * - `'document'` (the default): the whole document, always (its base and
   *   what came since), so the page can open it with no connection
   *   (`loadYOffline`);
   * - `'unsynced'`: only while the document holds edits the server lacks.
   *   Nothing is stored while it is synced; the first local edit stores the
   *   base and what came since, and `markSynced()` deletes them.
   * @defaultValue `'document'`
   */
  readonly keep?: 'document' | 'unsynced';
  /**
   * Milliseconds to wait for updates to pause before storing them (0:
   * store each at once). While they do not pause, they are stored at least
   * every ten times this. `flush()` stores at once; call it on `pagehide`.
   * @defaultValue `0`
   */
  readonly writeDelay?: number;
  /**
   * Called with every storage failure (a full quota, a closed store): tell
   * the user their edits are not saved on this device. Editing goes on, and
   * the next write retries.
   */
  readonly onError: (error: YOfflineError) => void;
  /**
   * What {@link loadYOffline} returned, when the document was created from
   * it: its base and its stored rows continue here.
   */
  readonly loaded?: YOfflineLoaded;
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
  /** The document belongs to this epoch (or just adopted it): sync it. */
  | {readonly kind: 'same'}
  /**
   * The room moved on. The binding is frozen and the session has ended:
   * never sync this document. Open a fresh one at the new epoch and call
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
   * provider syncs this document (on every connect), and when the server
   * says the room was replaced. The binding is frozen before this returns
   * its promise, so nothing typed after a `'moved'` is lost or written.
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
  /**
   * The authoritative copy holds everything this document holds: the
   * document as it is now becomes the base later edits are judged against,
   * and what is stored since is replaced by it (with `keep: 'unsynced'`,
   * deleted). "Holds" means persisted by the copy a reload or replace of
   * the room is seeded from: for a relay in front of a product's store
   * (a connector), the product's save, not the relay's acknowledgement. A
   * reload drops what the relay holds above that copy. Call it only when
   * that copy holds every update this document has (nothing newer since):
   * an edit made after what was persisted would fold into the base, and a
   * later capture would not list it. With a relay that acknowledges
   * nothing, call it when the provider has synced; that leaves a window (an
   * edit sent in that sync that never arrived is in the base).
   */
  markSynced(): void;
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
    `${entry} needs stage: 'off' (do nothing), 'persist' (store edits on this device, and keep edits that did not sync for the Offline edits panel) or 'replay' (also reapply the replayable ones); got ${String(
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
  /** The state vector of the base this session stored, once it has. */
  private storedBaseVector: Uint8Array | null = null;
  private unsynced: boolean;
  private isEnded = false;
  private isPersisted = true;
  private slot: YOfflineSlot | null = null;
  /** Updates not stored yet, oldest first. */
  private pending: Uint8Array[] = [];
  /** A confirmed state not stored yet: it replaces what was pending before it. */
  private confirmed: {state: Uint8Array; vector: Uint8Array} | null = null;
  /** The epoch a never-synced slot is moving to, until it has. */
  private adopting: string | null = null;
  private lastFailure: string | null = null;
  private writing: Promise<YOfflineResult<void>> | null = null;
  private stop: () => void = () => {};
  private readonly now: () => number;
  private readonly compactAfter: number;
  private readonly persistEdits: boolean;
  private readonly keepUnsyncedOnly: boolean;
  private readonly writeDelay: number;
  /** With `keep: 'unsynced'`: whether the slot holds the base and since. */
  private started: boolean;
  /** With `keep: 'unsynced'`: the slot's rows are to be deleted (synced). */
  private clearing = false;
  /** With `keep: 'unsynced'`: the state vector of the base in memory. */
  private baseVector: Uint8Array | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstDelayed = 0;

  constructor(private readonly options: YOfflineSessionOptions) {
    const {binding, loaded, store} = options;
    this.persistEdits = options.persistEdits ?? true;
    this.keepUnsyncedOnly = options.keep === 'unsynced';
    this.writeDelay = options.writeDelay ?? 0;
    this.started =
      loaded !== undefined && loaded.state !== null && loaded.hasUnsyncedEdits;
    this.now = options.now ?? Date.now;
    this.compactAfter = options.compactAfter ?? Y_OFFLINE_DEFAULTS.compactAfter;
    this.epochValue = options.epoch;
    this.base = loaded === undefined ? null : loaded.base;
    this.unsynced = loaded !== undefined && loaded.hasUnsyncedEdits;
    if (options.stage === 'off' || store === null) {
      return;
    }
    const doc = binding.binding.doc;
    if (this.persistEdits) {
      this.slot =
        loaded !== undefined && loaded.slot !== null
          ? loaded.slot
          : store.slot(options.key, options.epoch);
      // This handle's first row is the whole document, so its later rows
      // build only on rows it wrote: another tab may replace the rows it
      // loaded. With keep 'unsynced', only when it loaded unsynced rows
      // (otherwise its first local edit stores the base and since).
      if (
        doc.store.clients.size > 0 &&
        (!this.keepUnsyncedOnly || this.started)
      ) {
        if (
          loaded !== undefined &&
          loaded.state !== null &&
          !loaded.hasUnsyncedEdits &&
          loaded.base !== null
        ) {
          // Loaded with nothing unsynced: the document is its base, stored
          // as one (a later load reports nothing unsynced).
          this.confirmed = {
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
      }
    };
    doc.on('afterTransaction', onTransaction);
    let offUpdate = () => {};
    if (this.persistEdits) {
      // Every update, a peer's too: the slot is the whole document. With
      // keep 'unsynced', only once a local edit made it unsynced (the
      // transaction's afterTransaction, which marks it, runs first).
      const onUpdate = (update: Uint8Array) => {
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
    return this.options.stage;
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
    while (this.hasQueued()) {
      let result: YOfflineResult<void>;
      if (this.adopting !== null) {
        // In the queue, so no write lands under the old key meanwhile.
        result = await slot.adopt(this.adopting);
        if (result.ok) {
          this.adopting = null;
        }
      } else if (this.clearing) {
        // keep 'unsynced', synced: the stored base and since go.
        this.clearing = false;
        result = await slot.discard();
        if (!result.ok && !this.clearing) {
          this.clearing = true;
        }
      } else if (this.needsStart()) {
        // keep 'unsynced', first edit since a sync: the base, then what the
        // document holds beyond it (null base: the whole document).
        const doc = this.options.binding.binding.doc;
        const base = this.base;
        const vector = this.baseVector;
        // A sync and a new local edit while this writes start another
        // generation: its own start stays due.
        const generation = this.startGeneration;
        if (base !== null && vector !== null) {
          result = await slot.confirm(base);
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
        result = await slot.confirm(confirming.state);
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

  /** Counts markSynced() calls: a batch whose append failed across one is covered. */
  private syncs = 0;
  /** keep 'unsynced': the slot's first write since a sync is due. */
  private startPending = false;
  /** keep 'unsynced': counts starts, so an old one's end clears no new one. */
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
    return this.write().then(result =>
      // Queued while it ran.
      result.ok && this.hasQueued() ? this.flush() : result,
    );
  }

  markSynced(): void {
    if (this.options.stage === 'off' || this.isEnded) {
      return;
    }
    if (this.epochValue === null) {
      throw new Error(
        "@lexical/y/offline: markSynced() before the session knows the room's epoch. Call await session.serverEpoch(epoch) when the server names its epoch (before the provider syncs), then markSynced() after the sync.",
      );
    }
    const doc = this.options.binding.binding.doc;
    const state = encodeStateAsUpdate(doc);
    this.base = state;
    this.unsynced = false;
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
        this.confirmed = {state, vector: encodeStateVector(doc)};
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
    if (this.options.stage === 'off') {
      return {kind: 'off'};
    }
    if (this.isEnded) {
      throw new Error(
        '@lexical/y/offline: this session has ended (its epoch moved, or it was disposed). Attach a new session to the new document: attachYOfflineSession({binding, epoch, ...}).',
      );
    }
    if (this.epochValue === epoch) {
      return {kind: 'same'};
    }
    if (this.epochValue === null) {
      // A document that never synced belongs to the first epoch it meets.
      this.epochValue = epoch;
      if (this.slot !== null) {
        // A failure is reported through onError; the queue retries.
        this.adopting = epoch;
        await this.flush();
      }
      return {kind: 'same'};
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
    if (this.options.stage === 'off') {
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
    const {binding, key, store} = this.options;
    const edits = binding.freeze();
    // Read after the freeze: it commits what the editor still held.
    const wasUnsynced = this.unsynced;
    this.isEnded = true;
    this.stop();
    const capture: YOfflineCapture | null =
      wasUnsynced || edits.differs
        ? {
            base: this.base,
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
    let saved: YOfflineResult<void> = DONE;
    const slot = this.slot;
    if (slot !== null && slot.moveIntoCapture !== undefined) {
      // One transaction: the capture in, this page's rows out (only its
      // own: another tab at the old epoch may hold edits it has not
      // captured yet), the capture's room counted without those rows.
      // What is still queued (what the freeze committed) stays queued
      // until the capture is in.
      await this.writing;
      saved = await slot.moveIntoCapture(capture);
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
        await this.flush();
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
        await this.flush();
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
 * 3. `const session = attachYOfflineSession({binding, store, key, epoch:
 *    loaded.epoch, loaded, stage, onError})`;
 * 4. `await session.serverEpoch(epoch)` whenever the server names its epoch:
 *    before the provider syncs (every connect and reconnect), and when the
 *    room is replaced or upgraded. `'same'` means sync, `'moved'` means the
 *    document was frozen and captured;
 * 5. `session.markSynced()` when the server holds the document;
 * 6. on the document the page syncs (a fresh one after `'moved'`),
 *    `await recoverYOfflineEdits({...})` for the Offline edits panel (and
 *    the replay, at stage `'replay'`).
 */
export function attachYOfflineSession(
  options: YOfflineSessionOptions,
): YOfflineSession {
  const entry = 'attachYOfflineSession';
  requireOption(
    typeof options === 'object' && options !== null,
    `${entry} needs options: {binding, store, key, epoch, stage, onError}.`,
  );
  requireStage(entry, options.stage);
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
    options.persistEdits === undefined ||
      typeof options.persistEdits === 'boolean',
    `${entry}'s persistEdits is true (the default: store every edit as it is made, so the document survives a reload with no connection) or false (store only captures); got ${typeof options.persistEdits}.`,
  );
  requireOption(
    typeof options.onError === 'function',
    `${entry} needs onError: a function that tells the user their edits are not saved on this device (a full quota, a closed store), so a storage failure is never silent.`,
  );
  requireOption(
    options.keep === undefined ||
      options.keep === 'document' ||
      options.keep === 'unsynced',
    `${entry}'s keep is 'document' (the default: store the whole document, to open it with no connection) or 'unsynced' (store only while the server lacks edits; markSynced() deletes them); got ${String(options.keep)}.`,
  );
  requireOption(
    options.writeDelay === undefined ||
      (typeof options.writeDelay === 'number' && options.writeDelay >= 0),
    `${entry}'s writeDelay is the milliseconds to wait for updates to pause before storing them (0 or more); got ${String(options.writeDelay)}.`,
  );
  requireOption(
    options.store !== null || options.stage === 'off',
    `${entry} needs store at stage '${options.stage}': pass the value of openYOfflineStore({idb}) (when it failed, run this session at stage 'off' and tell the user).`,
  );
  requireOption(
    options.loaded === undefined || options.loaded.epoch === options.epoch,
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
}

/**
 * @experimental What a capture changed, block by block
 * (`describeUnsyncedEdits`), against the document as it is now. Blocks the
 * document already holds as the user had them are left out (an edit that
 * did reach the server, or one already reapplied): an empty `blocks` with
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
  for (const block of report.blocks) {
    if (sameJSON(block.yours, block.now)) {
      inDocument.push(block.id);
    } else {
      blocks.push(block);
    }
  }
  return ok({
    ...report,
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
  /** `only` named it, but the report does not hold it. */
  | 'not-in-report'
  /** The editor update failed (the editor's onError has the error). */
  | 'not-written';

/** @experimental What {@link replayUnsyncedEdits} did. */
export interface YReplayResult {
  /** The ids of the blocks applied, in the order applied. */
  readonly applied: readonly string[];
  /** The blocks left for the panel, with why. */
  readonly notApplied: readonly {
    readonly id: string;
    readonly reason: YReplaySkipReason;
  }[];
}

/**
 * @experimental Apply a report's replayable blocks to the bound editor, as
 * one editor update the binding writes and one undo step: a changed block
 * replaces the current one, an added block is inserted after the nearest
 * block before it that the document holds (before the nearest after it when
 * there is none; at the end for a plain `YUnsyncedReport`, which does not
 * carry the user's order), a deleted block is removed. Each
 * is checked again against the editor as it is now (the block still equals
 * the base, an added block's id is still absent), so a block someone else
 * changed is never overwritten: it comes back in `notApplied`.
 *
 * `only` limits it to those block ids (the panel's Reapply button). Call it
 * outside an editor update (not from an update listener or a command
 * handler): the edit must be written before it returns.
 *
 * @example
 * ```ts
 * const {applied, notApplied} = replayUnsyncedEdits({binding, report});
 * ```
 */
export function replayUnsyncedEdits(input: {
  readonly binding: YOfflineBinding;
  readonly report: YOfflineReport | YUnsyncedReport;
  readonly only?: readonly string[];
}): YReplayResult {
  const {binding, only, report} = input;
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
  const order = 'order' in report ? report.order : [];
  const todo: YUnsyncedBlock[] = [];
  for (const block of candidates) {
    if (!block.replayable) {
      notApplied.push({id: block.id, reason: 'not-replayable'});
    } else if (!hasIds) {
      notApplied.push({id: block.id, reason: 'no-block-ids'});
    } else {
      const at = liveIndex.get(block.id);
      const now = at === undefined ? null : live[at];
      if (!sameJSON(now, block.base)) {
        notApplied.push({id: block.id, reason: 'changed-since'});
      } else {
        todo.push(block);
      }
    }
  }
  if (todo.length === 0) {
    return {applied, notApplied};
  }
  const um = binding.binding.undoManager;
  if (um !== null) {
    um.stopCapturing();
  }
  // Pushed to `applied` once the update has committed.
  const done: string[] = [];
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
      for (const block of todo) {
        let made: LexicalNode | null = null;
        if (block.yours !== null) {
          try {
            made = $parseSerializedNode(block.yours);
          } catch {
            notApplied.push({id: block.id, reason: 'unreadable'});
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
  if (committed) {
    for (const id of done) {
      applied.push(id);
    }
  } else {
    for (const id of done) {
      notApplied.push({id, reason: 'not-written'});
    }
  }
  return {applied, notApplied};
}

/** @experimental One capture of {@link recoverYOfflineEdits}' result. */
export interface YOfflineRecovered {
  readonly capture: YOfflineCapture;
  /** What is left to show, or why the capture could not be read. */
  readonly report: YOfflineResult<YOfflineReport>;
  /** What the replay stage applied; null when it did not run for this capture. */
  readonly replay: YReplayResult | null;
}

/**
 * @experimental On a fresh document at the current epoch, after its first
 * sync: gather what did not sync and, at stage `'replay'`, reapply what is
 * safe. In order:
 *
 * 1. every slot of `key` left at another epoch (a tab that closed before it
 *    could freeze), or never synced (edits made on this device that never
 *    reached a server: their base is unknown, so nothing of them is
 *    replayable), becomes a capture;
 * 2. each capture is described against the document as it is now;
 * 3. at stage `'replay'`, each capture this call claims (once, across tabs)
 *    has its replayable blocks applied as one undo step;
 * 4. a capture with nothing left to show is deleted once the server holds
 *    the document: only with `session`, the document's offline session,
 *    reporting no unsynced edits (after its `markSynced()`). Without it,
 *    or while the document holds edits the server lacks (a replay that has
 *    not synced), such a capture is returned with no blocks, for the panel
 *    to dismiss: until the server holds what was reapplied, the capture may
 *    be its only stored copy.
 *
 * The result is the Offline edits panel's content. Stage `'off'` returns an
 * empty list and touches nothing.
 */
export async function recoverYOfflineEdits(input: {
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
   * The fresh document's offline session: with it, a capture the server
   * already holds (its session reports no unsynced edits) is deleted.
   */
  readonly session?: YOfflineSession;
  /** The clock, for tests. @defaultValue `Date.now` */
  readonly now?: () => number;
}): Promise<YOfflineResult<YOfflineRecovered[]>> {
  const entry = 'recoverYOfflineEdits';
  requireStage(entry, input.stage);
  const {binding, config, epoch, key, migrate, stage, store} = input;
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
  // 2 to 4.
  const captures = await store.captures(key);
  if (!captures.ok) {
    return captures;
  }
  const doc = binding.binding.doc;
  const describe = (capture: YOfflineCapture) =>
    describeYOfflineCapture(capture, {
      config,
      current: encodeStateAsUpdate(doc),
      migrate,
    });
  const recovered: YOfflineRecovered[] = [];
  for (const capture of captures.value) {
    let report = describe(capture);
    let replay: YReplayResult | null = null;
    if (
      stage === 'replay' &&
      report.ok &&
      !capture.claimed &&
      binding.status.kind === 'active' &&
      report.value.blocks.some(block => block.replayable)
    ) {
      const claimed = await store.claimCapture(key, capture.id);
      if (!claimed.ok) {
        return claimed;
      }
      if (claimed.value) {
        // Described again: the claim was awaited.
        report = describe(capture);
        if (report.ok) {
          try {
            replay = replayUnsyncedEdits({binding, report: report.value});
            if (
              replay.applied.length === 0 &&
              replay.notApplied.some(skip => skip.reason === 'not-written')
            ) {
              // The editor update failed (its onError did not throw):
              // nothing was applied, so the claim is released for a later
              // call to replay it.
              const released = await store.putCapture({
                ...capture,
                claimed: false,
              });
              if (!released.ok) {
                return released;
              }
            }
            report = describe(capture);
          } catch (error) {
            // Nothing was applied: the claim is released, so a later call
            // replays it, and the failure is this capture's.
            await store.putCapture({...capture, claimed: false});
            report = fail({
              cause: error,
              code: 'failed',
              message: `@lexical/y/offline: replaying this capture failed (${String(
                error,
              )}); nothing was applied and the capture is kept for a later call or the panel.`,
            });
          }
        }
      }
    }
    // Nothing left to show, and the server holds the document: the capture
    // goes. Not in the call that replayed it, not while the document holds
    // edits the server lacks (what was reapplied may be in this page only),
    // and not while its block order differs.
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
      !report.value.orderDiffers
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
