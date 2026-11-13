/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Local persistence for Yjs 14 documents (`@lexical/y/offline`): a document's
// updates in IndexedDB, by an app-chosen key and the epoch (generation) the
// document was made against. No provider for Yjs 14 exists (`y-indexeddb`
// imports Yjs 13), and none keys by epoch or reports quota and corruption, so
// this one is written here on IndexedDB alone, with `@y/y` used only to merge
// updates.
//
// A slot (key, epoch) holds rows of two kinds:
//
// - `base`: a state the server is known to hold (written by `confirm`);
// - `since`: every update the document made or received after it.
//
// The document is their merge; what the server may lack is in `since`. Rows
// are keyed `[key, epoch, kind, writer, n]` with a random `writer` per slot
// handle, so two tabs on one key never overwrite each other. A handle only
// replaces rows it owns (the ones it loaded or wrote, all of which its
// document holds): another tab's rows stay until that tab, or a later load,
// replaces them.

import {mergeUpdates} from '@y/y';

/**
 * @experimental The defaults of the optional fields of `@lexical/y/offline`,
 * by name, so code can say which it relies on.
 */
export const Y_OFFLINE_DEFAULTS: {
  readonly databaseName: string;
  readonly compactAfter: number;
  readonly openTimeout: number;
} = /* @__PURE__ */ Object.freeze({
  /** `since` rows a slot handle writes before it compacts them into one. */
  compactAfter: 64,
  databaseName: 'lexical-y-offline',
  /** Milliseconds openYOfflineStore waits for the database to open. */
  openTimeout: 10000,
});

/** @experimental What failed (see {@link YOfflineError}). */
export type YOfflineErrorCode =
  /** There is no IndexedDB here (a private window, Node without a fake). */
  | 'unavailable'
  /** Another tab holds an older version of the database open. */
  | 'blocked'
  /** The browser refused the write: the origin's storage quota is full. */
  | 'quota'
  /** A stored row is not what this module wrote, or does not decode. */
  | 'corrupt'
  /** The store was closed (`store.close()`, or the database was deleted). */
  | 'closed'
  /**
   * The write would pass one of the store's `limits` (see `limit`): it was
   * refused, and nothing was evicted.
   */
  | 'limit'
  /** Any other IndexedDB failure; `cause` holds it. */
  | 'failed';

/**
 * @experimental A failure of the local store. Nothing here throws for a
 * storage failure: every call returns a {@link YOfflineResult}, and
 * `message` says what to do.
 */
export interface YOfflineError {
  readonly code: YOfflineErrorCode;
  /** What happened and what the app can do about it. */
  readonly message: string;
  /** The underlying error, when there is one. */
  readonly cause?: unknown;
  /**
   * With `'corrupt'`: what the readable rows hold (their merge, the base
   * apart), so the app can offer it before clearing the slot.
   */
  readonly salvage?: YOfflineSalvage;
  /** With `'limit'`: which limit (see {@link YOfflineLimits}). */
  readonly limit?: 'keys' | 'bytes';
}

/**
 * @experimental Caps a store keeps by refusing writes (`'limit'`), never by
 * evicting: what is stored stays until the app clears it.
 */
export interface YOfflineLimits {
  /** Most keys stored per group (a new key past it is refused). */
  readonly keys?: number;
  /**
   * Most bytes stored per key: its rows' updates and its captures' states
   * and bases (a capture's JSON and text are not counted). Each connection
   * counts what it last read of the key plus what it wrote since; another
   * tab's writes count from its next read (a compaction, a confirmation, a
   * capture), so tabs writing at once can pass it by what they wrote since.
   */
  readonly bytesPerKey?: number;
  /**
   * The group a key counts in for `keys`, e.g. its viewer for keys
   * `viewer|doc`: `key => key.split('|')[0]`. Default: one group.
   */
  readonly group?: (key: string) => string;
}

/** @experimental What a corrupt slot still holds (see {@link YOfflineError}). */
export interface YOfflineSalvage {
  /** The merge of every readable row, or null when none is. */
  readonly state: Uint8Array | null;
  readonly readableRows: number;
  readonly unreadableRows: number;
}

/** @experimental A value, or the error that kept it from being made. */
export type YOfflineResult<T> =
  | {readonly ok: true; readonly value: T}
  | {readonly ok: false; readonly error: YOfflineError};

/** @experimental What a slot holds (see {@link YOfflineSlot.load}). */
export interface YOfflineStored {
  /** The whole document: `base` and `since` merged (a Yjs update). */
  readonly state: Uint8Array;
  /** The state the server is known to hold, or null when none was confirmed. */
  readonly base: Uint8Array | null;
  /** Whether updates were stored after `base`: the server may lack them. */
  readonly hasUnsyncedEdits: boolean;
}

/** @experimental One slot of a key (see {@link YOfflineStore.slots}). */
export interface YOfflineSlotInfo {
  readonly key: string;
  /** The epoch the slot's document was made against; null: never synced. */
  readonly epoch: string | null;
  /** When its newest row was written (Unix ms). */
  readonly updatedAt: number;
  readonly hasUnsyncedEdits: boolean;
  readonly rows: number;
}

/**
 * @experimental A frozen copy of a client's document that did not sync,
 * with the base it was made against: what the Offline edits panel shows.
 */
export interface YOfflineCapture {
  /** Unique per key. */
  readonly id: string;
  readonly key: string;
  /** The epoch the edits were made against; null: never synced. */
  readonly epoch: string | null;
  readonly reason: 'stale' | 'legacy' | 'expired';
  /** When it was captured (Unix ms). */
  readonly capturedAt: number;
  /** The whole document as the client held it (a Yjs update). */
  readonly state: Uint8Array;
  /**
   * The editor's content as Lexical JSON (`freeze()`'s), or null for a
   * capture made from storage alone (a tab that closed before it could
   * freeze).
   */
  readonly json: unknown | null;
  /** The plain text of the editor, for Copy; null as `json` is. */
  readonly text: string | null;
  /**
   * Whether the editor held edits the document did not (`freeze()`'s
   * `differs`): the report then reads `json`, else `state`.
   */
  readonly differs: boolean;
  /** The document the edits were made against, or null when unknown. */
  readonly base: Uint8Array | null;
  /** Set once a replay stage took the capture (see claimCapture). */
  readonly claimed: boolean;
}

/** @experimental One (key, epoch) of a {@link YOfflineStore}. */
export interface YOfflineSlot {
  readonly key: string;
  /** Changes with {@link YOfflineSlot.adopt}. */
  readonly epoch: string | null;
  /**
   * Read the slot: null when it holds nothing. The rows read become this
   * handle's (create the document from `state`, so it holds them).
   */
  load(): Promise<YOfflineResult<YOfflineStored | null>>;
  /** Store one update the document made or received. */
  append(update: Uint8Array): Promise<YOfflineResult<void>>;
  /**
   * The server holds `state` (the whole document, which holds every row of
   * this handle): it becomes the base and this handle's rows are removed.
   */
  confirm(state: Uint8Array): Promise<YOfflineResult<void>>;
  /**
   * Replace this handle's `since` rows by one: `since` when given (what the
   * document holds beyond the base), else their merge.
   */
  compact(since?: Uint8Array): Promise<YOfflineResult<void>>;
  /**
   * Delete this handle's rows (the ones it loaded or wrote), and no other:
   * for a document that was captured, whose rows another tab at the same
   * epoch may still be adding to.
   */
  discard(): Promise<YOfflineResult<void>>;
  /** `since` rows this handle wrote since it last compacted or confirmed. */
  readonly rowsSinceCompaction: number;
  /**
   * Release the handle's writer lock (see `locks`): its rows become another
   * handle's to replace. Call it when the document is closed; a closed tab
   * releases it on its own.
   */
  close(): void;
  /**
   * Move a slot that never synced (`epoch` null) to the epoch the server
   * gave it: this handle's rows, and those it loaded whose writer is gone.
   * A live tab's rows stay for that tab to move.
   */
  adopt(epoch: string): Promise<YOfflineResult<void>>;
}

/** @experimental The local store (see {@link openYOfflineStore}). */
export interface YOfflineStore {
  /** A handle on one slot; nothing is read or written until it is used. */
  slot(key: string, epoch: string | null): YOfflineSlot;
  /** The slots stored for `key`, newest first. */
  slots(key: string): Promise<YOfflineResult<YOfflineSlotInfo[]>>;
  /** The captures stored for `key`, oldest first. */
  captures(key: string): Promise<YOfflineResult<YOfflineCapture[]>>;
  putCapture(capture: YOfflineCapture): Promise<YOfflineResult<void>>;
  /**
   * Mark a capture as taken by a replay: true for the one caller that gets
   * it (a second tab, or a second call, gets false), so a capture is
   * replayed automatically at most once.
   */
  claimCapture(key: string, id: string): Promise<YOfflineResult<boolean>>;
  deleteCapture(key: string, id: string): Promise<YOfflineResult<void>>;
  /**
   * Delete what is stored for `key`: one slot when `what.epoch` is given
   * (null names the never-synced slot), else every slot; its captures too
   * with `what.captures`.
   */
  clear(
    key: string,
    what: {readonly epoch?: string | null; readonly captures: boolean},
  ): Promise<YOfflineResult<void>>;
  /** Every key that holds a slot or a capture (for clearing by owner). */
  keys(): Promise<YOfflineResult<string[]>>;
  /** Close the database: later calls return `'closed'`. */
  close(): void;
}

/** @experimental Options of {@link openYOfflineStore}. */
export interface YOfflineStoreOptions {
  /**
   * The IndexedDB to use. Required, so every caller decides: pass
   * `{indexedDB, IDBKeyRange}` from `globalThis` in a browser, or a fake's
   * in Node (the store works without a DOM).
   */
  readonly idb: {
    readonly indexedDB: IDBFactory | undefined;
    readonly IDBKeyRange: typeof IDBKeyRange | undefined;
  };
  /**
   * The database's name: one per app.
   * @defaultValue `Y_OFFLINE_DEFAULTS.databaseName`
   */
  readonly databaseName?: string;
  /** The clock, for tests. @defaultValue `Date.now` */
  readonly now?: () => number;
  /**
   * Milliseconds to wait for the database to open before answering
   * `'unavailable'` (some browsers never answer an open in some states).
   * A connection that opens later is closed.
   * @defaultValue `Y_OFFLINE_DEFAULTS.openTimeout`
   */
  readonly openTimeout?: number;
  /** Caps kept by refusing writes, never by evicting. Default: none. */
  readonly limits?: YOfflineLimits;
  /**
   * The Web Locks the store tells live tabs by: each writing handle holds a
   * lock, and no handle removes rows a live handle wrote (they may be what
   * that tab's later rows build on). Rows of a handle that is gone (a
   * closed tab, an earlier page load) are replaced by the next handle that
   * loads them. Null: every other handle counts as live, so rows of earlier
   * page loads are kept until the app clears them.
   * @defaultValue `navigator.locks`, where there is one, else null
   */
  readonly locks?: YOfflineLocks | null;
}

/** @experimental The part of the Web Locks API the store uses. */
export interface YOfflineLocks {
  request(
    name: string,
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
  query(): Promise<{readonly held?: readonly {readonly name?: string}[]}>;
}

/** Wraps a request callback so that what it throws fails the transaction. */
type Guard = (fn: () => void) => () => void;

const UPDATES = 'updates';
const CAPTURES = 'captures';
const DB_VERSION = 1;
const ROW_VERSION = 1;

type RowKind = 'b' | 's';
/** `[key, epoch (0 for null), kind, writer, n]`. */
type RowKey = [string, string | 0, RowKind, string, number];

interface Row {
  readonly v: number;
  /** The update. */
  readonly u: Uint8Array;
  /** FNV-1a of `u`: a row cut short or changed does not read as an update. */
  readonly h: number;
  /** When it was written (Unix ms). */
  readonly t: number;
}

const ok = <T>(value: T): YOfflineResult<T> => ({ok: true, value});
const fail = <T>(error: YOfflineError): YOfflineResult<T> => ({
  error,
  ok: false,
});
const DONE: YOfflineResult<void> = /* @__PURE__ */ ok(undefined);

function checksum(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A Uint8Array of any realm: a value read back from IndexedDB in an iframe,
 * or under a test runner's VM, is not `instanceof` this realm's.
 */
function isBytes(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === '[object Uint8Array]'
  );
}

/**
 * `bytes` with a buffer of its own size: IndexedDB stores a view's whole
 * buffer, and an update can be a short view of an encoder's long one.
 */
function exact(bytes: Uint8Array): Uint8Array {
  return bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

function isRow(value: unknown): value is Row {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Partial<Row>;
  return (
    row.v === ROW_VERSION &&
    isBytes(row.u) &&
    row.u.length > 0 &&
    typeof row.t === 'number' &&
    row.h === checksum(row.u)
  );
}

function merge(updates: readonly Uint8Array[]): Uint8Array | null {
  return updates.length === 0
    ? null
    : updates.length === 1
      ? updates[0]
      : mergeUpdates(updates as Parameters<typeof mergeUpdates>[0]);
}

const epochKey = (epoch: string | null): string | 0 =>
  epoch === null ? 0 : epoch;
const epochOf = (key: string | 0): string | null => (key === 0 ? null : key);

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as {name: unknown}).name)
    : '';
}

/** A limit a write would pass, thrown inside a transaction to abort it. */
class LimitReached {
  constructor(readonly error: YOfflineError) {}
}

/** The typed error of an IndexedDB failure. */
function storageError(cause: unknown, doing: string): YOfflineError {
  if (cause instanceof LimitReached) {
    return cause.error;
  }
  const name = errorName(cause);
  if (name === 'QuotaExceededError') {
    return {
      cause,
      code: 'quota',
      message: `@lexical/y/offline: the browser's storage quota is full, so ${doing} was not stored. The edits are still in the page: tell the user they are not saved on this device, free space (store.clear(key, {captures: true}) for documents no longer needed) and the next write retries.`,
    };
  }
  if (name === 'InvalidStateError' || name === 'TransactionInactiveError') {
    return {
      cause,
      code: 'closed',
      message: `@lexical/y/offline: the store is closed, so ${doing} did not run; open a new one with openYOfflineStore().`,
    };
  }
  return {
    cause,
    code: 'failed',
    message: `@lexical/y/offline: IndexedDB failed while ${doing} (${
      name || String(cause)
    }); the edits are still in the page. Retry, or tell the user they are not saved on this device.`,
  };
}

class Store implements YOfflineStore {
  private closed = false;
  /**
   * Bytes stored per key, as this store last read them plus what it wrote
   * since (only with `limits.bytesPerKey`, so an append reads nothing). A
   * write that removes rows forgets the key: the next write reads it again.
   */
  private readonly sizes = new Map<string, number>();
  constructor(
    private readonly db: IDBDatabase,
    private readonly range: typeof IDBKeyRange,
    readonly now: () => number,
    private readonly limits: YOfflineLimits | null,
    private readonly locks: YOfflineLocks | null,
    private readonly name: string,
  ) {
    // Another tab upgrades or deletes the database: let it.
    db.onversionchange = () => this.close();
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
      for (const release of this.held) {
        release();
      }
      this.held.clear();
    }
  }

  /** Releases of the writer locks this store's handles hold. */
  private readonly held = new Set<() => void>();

  private lockName(writer: string): string {
    return `lexical-y-offline:${this.name}:${writer}`;
  }

  /**
   * Hold `writer`'s lock: resolves once it is held (a row of a writer only
   * exists while its lock is held, or after its handle is gone). Returns
   * its release.
   */
  async hold(writer: string): Promise<() => void> {
    const locks = this.locks;
    if (locks === null) {
      return () => {};
    }
    let release = () => {};
    await new Promise<void>(granted => {
      void locks.request(this.lockName(writer), () => {
        granted();
        return new Promise<void>(done => {
          release = () => {
            this.held.delete(release);
            done();
          };
          this.held.add(release);
        });
      });
    });
    return release;
  }

  /** The writers whose handles are live, or null when that is unknown. */
  async liveWriters(): Promise<ReadonlySet<string> | null> {
    if (this.locks === null) {
      return null;
    }
    const prefix = this.lockName('');
    const {held = []} = await this.locks.query();
    const live = new Set<string>();
    for (const lock of held) {
      if (typeof lock.name === 'string' && lock.name.startsWith(prefix)) {
        live.add(lock.name.slice(prefix.length));
      }
    }
    return live;
  }

  /** Every key that starts with `prefix` (arrays sort after every string and number). */
  prefix(prefix: readonly (string | number)[]): IDBKeyRange {
    return this.range.bound(prefix, [...prefix, []]);
  }

  /**
   * One transaction: `work` issues its requests (more from their callbacks)
   * and the result is what it left in `out` once the transaction commits.
   */
  run<T>(
    stores: string[],
    mode: IDBTransactionMode,
    doing: string,
    work: (tx: IDBTransaction, out: {value: T}, guard: Guard) => void,
    initial: T,
  ): Promise<YOfflineResult<T>> {
    if (this.closed) {
      return Promise.resolve(
        fail(storageError({name: 'InvalidStateError'}, doing)),
      );
    }
    return new Promise(resolve => {
      const out = {value: initial};
      let tx: IDBTransaction;
      try {
        tx = this.db.transaction(stores, mode);
      } catch (error) {
        resolve(fail(storageError(error, doing)));
        return;
      }
      let failure: unknown = null;
      tx.oncomplete = () => resolve(ok(out.value));
      tx.onabort = () =>
        resolve(fail(storageError(failure ?? tx.error, doing)));
      tx.onerror = event => {
        // The request's error (a quota failure arrives here, or as the
        // transaction's own error on abort).
        const target = event.target as IDBRequest | null;
        failure = failure ?? (target === null ? null : target.error);
      };
      const abort = (error: unknown) => {
        failure = failure ?? error;
        try {
          tx.abort();
        } catch {
          resolve(fail(storageError(error, doing)));
        }
      };
      // A request callback that throws would abort the transaction with no
      // error to report (and throw at the window): it is reported instead.
      const guard: Guard = fn => () => {
        try {
          fn();
        } catch (error) {
          abort(error);
        }
      };
      try {
        work(tx, out, guard);
      } catch (error) {
        abort(error);
      }
    });
  }

  slot(key: string, epoch: string | null): YOfflineSlot {
    requireKey(key);
    requireEpoch(epoch);
    return new Slot(this, key, epoch);
  }

  keys(): Promise<YOfflineResult<string[]>> {
    return this.run<string[]>(
      [UPDATES, CAPTURES],
      'readonly',
      'listing the keys',
      (tx, out, guard) => {
        const keys = new Set<string>();
        const updates = tx.objectStore(UPDATES).getAllKeys();
        updates.onsuccess = guard(() => {
          for (const k of updates.result as RowKey[]) {
            keys.add(k[0]);
          }
          const captures = tx.objectStore(CAPTURES).getAllKeys();
          captures.onsuccess = guard(() => {
            for (const k of captures.result as [string, string][]) {
              keys.add(k[0]);
            }
            out.value = [...keys].sort();
          });
        });
      },
      [],
    );
  }

  /**
   * The object stores a write needs: with limits, both (the check reads
   * the key's rows and captures).
   */
  stores(store: string): string[] {
    return this.limits === null ? [store] : [UPDATES, CAPTURES];
  }

  /** The store forgets what it knew of `key`'s size (rows were removed). */
  forget(key: string): void {
    this.sizes.delete(key);
  }

  /**
   * Inside a write transaction, before it writes `adding` bytes for `key`
   * (and removes the rows `removing`, whose bytes then do not count): run
   * `then`, or abort with `'limit'` when the write would pass a limit.
   * Reads nothing without limits, nor for an append whose key's size is
   * known.
   */
  withinLimits(
    tx: IDBTransaction,
    guard: Guard,
    key: string,
    adding: number,
    removing: ReadonlySet<string> | null,
    then: () => void,
    replacingCapture: string | null = null,
  ): void {
    const limits = this.limits;
    if (limits === null) {
      then();
      return;
    }
    const known = this.sizes.get(key);
    if (removing === null && known !== undefined) {
      this.check(key, known + adding, false, limits);
      this.sizes.set(key, known + adding);
      then();
      return;
    }
    // Read the key's rows and captures (a first write, or one that removes).
    readRows(tx, this.prefix([key]), guard, rows => {
      const captures = tx.objectStore(CAPTURES).getAll(this.prefix([key]));
      captures.onsuccess = guard(() => {
        let bytes = 0;
        for (const [rowKey, value] of rows) {
          if (
            (removing === null || !removing.has(JSON.stringify(rowKey))) &&
            isRow(value)
          ) {
            bytes += value.u.byteLength;
          }
        }
        for (const capture of captures.result as unknown[]) {
          // A capture put again under its id replaces itself.
          if (
            replacingCapture === null ||
            (capture as {id?: unknown}).id !== replacingCapture
          ) {
            bytes += captureBytes(capture);
          }
        }
        const isNew = rows.length === 0 && captures.result.length === 0;
        const finish = () => {
          this.check(key, bytes + adding, false, limits);
          this.sizes.set(key, bytes + adding);
          then();
        };
        if (!isNew || limits.keys === undefined) {
          finish();
          return;
        }
        // A new key: count its group's keys.
        const group = limits.group ?? (() => '');
        const mine = group(key);
        const updates = tx.objectStore(UPDATES).getAllKeys();
        updates.onsuccess = guard(() => {
          const all = tx.objectStore(CAPTURES).getAllKeys();
          all.onsuccess = guard(() => {
            const keys = new Set<string>();
            for (const k of updates.result as RowKey[]) {
              keys.add(k[0]);
            }
            for (const k of all.result as [string, string][]) {
              keys.add(k[0]);
            }
            let inGroup = 0;
            for (const k of keys) {
              if (group(k) === mine) {
                inGroup++;
              }
            }
            this.check(key, inGroup + 1, true, limits);
            finish();
          });
        });
      });
    });
  }

  /** Throws (aborting the transaction) when `amount` passes a limit. */
  private check(
    key: string,
    amount: number,
    isKeys: boolean,
    limits: YOfflineLimits,
  ): void {
    const max = isKeys ? limits.keys : limits.bytesPerKey;
    if (max !== undefined && amount > max) {
      this.forget(key);
      throw new LimitReached({
        code: 'limit',
        limit: isKeys ? 'keys' : 'bytes',
        message: isKeys
          ? `@lexical/y/offline: storing '${key}' would make ${amount} keys in its group, past limits.keys (${max}); it was refused and nothing was evicted. The edits are still in the page: tell the user they are not saved on this device, or clear documents no longer needed (store.clear(key, {captures: true})).`
          : `@lexical/y/offline: storing '${key}' would hold ${amount} bytes, past limits.bytesPerKey (${max}); it was refused and nothing was evicted. The edits are still in the page: tell the user they are not saved on this device.`,
      });
    }
  }

  async slots(key: string): Promise<YOfflineResult<YOfflineSlotInfo[]>> {
    requireKey(key);
    const read = await this.rows([key], 'listing the slots');
    if (!read.ok) {
      return read;
    }
    const byEpoch = new Map<string | 0, YOfflineSlotInfo>();
    for (const [rowKey, value] of read.value) {
      const before = byEpoch.get(rowKey[1]);
      const t = isRow(value) ? value.t : 0;
      byEpoch.set(rowKey[1], {
        epoch: epochOf(rowKey[1]),
        hasUnsyncedEdits:
          (before !== undefined && before.hasUnsyncedEdits) ||
          rowKey[2] === 's',
        key,
        rows: (before === undefined ? 0 : before.rows) + 1,
        updatedAt: Math.max(before === undefined ? 0 : before.updatedAt, t),
      });
    }
    return ok([...byEpoch.values()].sort((a, b) => b.updatedAt - a.updatedAt));
  }

  /** The rows under a key prefix, with their keys, in key order. */
  rows(
    prefix: readonly (string | number)[],
    doing: string,
  ): Promise<YOfflineResult<[RowKey, unknown][]>> {
    return this.run<[RowKey, unknown][]>(
      [UPDATES],
      'readonly',
      doing,
      (tx, out, guard) =>
        readRows(tx, this.prefix(prefix), guard, rows => (out.value = rows)),
      [],
    );
  }

  async captures(key: string): Promise<YOfflineResult<YOfflineCapture[]>> {
    requireKey(key);
    const read = await this.run<unknown[]>(
      [CAPTURES],
      'readonly',
      'reading the captures',
      (tx, out) => {
        const request = tx.objectStore(CAPTURES).getAll(this.prefix([key]));
        request.onsuccess = () => (out.value = request.result);
      },
      [],
    );
    if (!read.ok) {
      return read;
    }
    const captures = read.value.filter(isCapture);
    if (captures.length !== read.value.length) {
      return fail({
        code: 'corrupt',
        message: `@lexical/y/offline: ${
          read.value.length - captures.length
        } stored capture(s) of '${key}' are not readable. Call store.clear(key, {captures: true}) to drop them.`,
      });
    }
    return ok(captures.sort((a, b) => a.capturedAt - b.capturedAt));
  }

  putCapture(capture: YOfflineCapture): Promise<YOfflineResult<void>> {
    return this.run<void>(
      this.stores(CAPTURES),
      'readwrite',
      'storing a capture',
      (tx, _out, guard) => {
        // A capture replaces any of the same id: forget the key's size so
        // the check reads it.
        this.forget(capture.key);
        this.withinLimits(
          tx,
          guard,
          capture.key,
          captureBytes(capture),
          new Set(),
          () => {
            tx.objectStore(CAPTURES).put(
              {
                ...capture,
                base: capture.base === null ? null : exact(capture.base),
                state: exact(capture.state),
              },
              [capture.key, capture.id],
            );
          },
          capture.id,
        );
      },
      undefined,
    );
  }

  claimCapture(key: string, id: string): Promise<YOfflineResult<boolean>> {
    return this.run<boolean>(
      [CAPTURES],
      'readwrite',
      'claiming a capture',
      (tx, out, guard) => {
        const store = tx.objectStore(CAPTURES);
        const request = store.get([key, id]);
        request.onsuccess = guard(() => {
          const capture: unknown = request.result;
          if (isCapture(capture) && !capture.claimed) {
            store.put({...capture, claimed: true}, [key, id]);
            out.value = true;
          }
        });
      },
      false,
    );
  }

  deleteCapture(key: string, id: string): Promise<YOfflineResult<void>> {
    return this.run<void>(
      [CAPTURES],
      'readwrite',
      'deleting a capture',
      tx => {
        this.forget(key);
        tx.objectStore(CAPTURES).delete([key, id]);
      },
      undefined,
    );
  }

  clear(
    key: string,
    what: {readonly epoch?: string | null; readonly captures: boolean},
  ): Promise<YOfflineResult<void>> {
    requireKey(key);
    if (
      typeof what !== 'object' ||
      what === null ||
      typeof what.captures !== 'boolean'
    ) {
      throw new TypeError(
        "@lexical/y/offline: clear(key, what) needs what.captures: true to delete the key's captures (the Offline edits panel's content) too, false to keep them.",
      );
    }
    return this.run<void>(
      [UPDATES, CAPTURES],
      'readwrite',
      'clearing',
      tx => {
        this.forget(key);
        tx.objectStore(UPDATES).delete(
          this.prefix(
            what.epoch === undefined ? [key] : [key, epochKey(what.epoch)],
          ),
        );
        if (what.captures) {
          tx.objectStore(CAPTURES).delete(this.prefix([key]));
        }
      },
      undefined,
    );
  }
}

/** The bytes a stored capture counts for `limits.bytesPerKey`. */
function captureBytes(value: unknown): number {
  if (typeof value !== 'object' || value === null) {
    return 0;
  }
  const c = value as {state?: unknown; base?: unknown};
  return (
    (isBytes(c.state) ? c.state.byteLength : 0) +
    (isBytes(c.base) ? c.base.byteLength : 0)
  );
}

function isCapture(value: unknown): value is YOfflineCapture {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const c = value as Partial<YOfflineCapture>;
  return (
    typeof c.id === 'string' &&
    typeof c.key === 'string' &&
    (c.epoch === null || typeof c.epoch === 'string') &&
    typeof c.capturedAt === 'number' &&
    isBytes(c.state) &&
    (c.base === null || isBytes(c.base))
  );
}

function readRows(
  tx: IDBTransaction,
  range: IDBKeyRange,
  guard: Guard,
  then: (rows: [RowKey, unknown][]) => void,
): void {
  const store = tx.objectStore(UPDATES);
  const keys = store.getAllKeys(range);
  keys.onsuccess = guard(() => {
    const values = store.getAll(range);
    values.onsuccess = guard(() => {
      // Both in key order, read in one transaction.
      then(
        (keys.result as RowKey[]).map((key, i): [RowKey, unknown] => [
          key,
          values.result[i],
        ]),
      );
    });
  });
}

function requireKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key === '') {
    throw new TypeError(
      `@lexical/y/offline: key must be a non-empty string that names the document in your app (its id), got ${
        key === '' ? "''" : typeof key
      }.`,
    );
  }
}

function requireEpoch(epoch: unknown): asserts epoch is string | null {
  if (epoch !== null && (typeof epoch !== 'string' || epoch === '')) {
    throw new TypeError(
      `@lexical/y/offline: epoch must be the string your server names the document's epoch or generation with (String(epoch) for a number), or null for a document that never synced; got ${
        epoch === '' ? "''" : typeof epoch
      }.`,
    );
  }
}

let writers = 0;
/** A writer id no other handle has, in this tab or another. */
function newWriter(): string {
  const random = new Uint32Array(2);
  globalThis.crypto.getRandomValues(random);
  return `${random[0].toString(36)}${random[1].toString(36)}.${writers++}`;
}

class Slot implements YOfflineSlot {
  private writer = newWriter();
  private n = 0;
  /** Rows this handle loaded or wrote: its document holds them all. */
  private owned: RowKey[] = [];
  private epochValue: string | null;
  /** The writer lock, held from this handle's first write until close(). */
  private holding: Promise<() => void> | null = null;
  rowsSinceCompaction = 0;

  constructor(
    private readonly store: Store,
    readonly key: string,
    epoch: string | null,
  ) {
    this.epochValue = epoch;
  }

  get epoch(): string | null {
    return this.epochValue;
  }

  close(): void {
    const holding = this.holding;
    this.holding = null;
    if (holding !== null) {
      void holding.then(release => release());
    }
  }

  /** Before a write: this handle's writer lock is held. */
  private hold(): Promise<() => void> {
    if (this.holding === null) {
      this.holding = this.store.hold(this.writer);
    }
    return this.holding;
  }

  /**
   * Of `keys` (rows this handle owns), the ones it may remove: its own, and
   * those whose writer is gone. A live handle's rows stay.
   */
  private async removable(keys: readonly RowKey[]): Promise<RowKey[]> {
    const live = await this.store.liveWriters();
    return keys.filter(
      key => key[3] === this.writer || (live !== null && !live.has(key[3])),
    );
  }

  private nextKey(kind: RowKind): RowKey {
    return [this.key, epochKey(this.epochValue), kind, this.writer, this.n++];
  }

  private row(update: Uint8Array): Row {
    return {
      h: checksum(update),
      t: this.store.now(),
      u: exact(update),
      v: ROW_VERSION,
    };
  }

  async load(): Promise<YOfflineResult<YOfflineStored | null>> {
    const read = await this.store.rows(
      [this.key, epochKey(this.epochValue)],
      'loading the document',
    );
    if (!read.ok) {
      return read;
    }
    if (read.value.length === 0) {
      return ok(null);
    }
    const base: Uint8Array[] = [];
    const since: Uint8Array[] = [];
    let unreadable = 0;
    for (const [key, value] of read.value) {
      if (isRow(value)) {
        (key[2] === 'b' ? base : since).push(value.u);
      } else {
        unreadable++;
      }
    }
    let stored: YOfflineStored | null = null;
    let cause: unknown;
    try {
      const mergedBase = merge(base);
      const state = merge([...base, ...since]);
      stored =
        state === null
          ? null
          : {base: mergedBase, hasUnsyncedEdits: since.length > 0, state};
    } catch (error) {
      cause = error;
      unreadable = read.value.length;
    }
    if (unreadable > 0) {
      return fail({
        cause,
        code: 'corrupt',
        message: `@lexical/y/offline: ${unreadable} of ${
          read.value.length
        } stored rows of '${this.key}' are not readable (the store was changed or damaged). Offer the user error.salvage.state if it is not null (createYDoc(state) reads it), then call store.clear(key, {epoch, captures: false}) and load the document from the server.`,
        salvage: {
          readableRows: read.value.length - unreadable,
          state: stored === null ? null : stored.state,
          unreadableRows: unreadable,
        },
      });
    }
    for (const [key] of read.value) {
      this.owned.push(key);
    }
    return ok(stored);
  }

  async append(update: Uint8Array): Promise<YOfflineResult<void>> {
    await this.hold();
    const key = this.nextKey('s');
    const result = await this.store.run<void>(
      this.store.stores(UPDATES),
      'readwrite',
      'an edit',
      (tx, _out, guard) => {
        this.store.withinLimits(
          tx,
          guard,
          this.key,
          update.byteLength,
          null,
          () => {
            tx.objectStore(UPDATES).put(this.row(update), key);
          },
        );
      },
      undefined,
    );
    if (result.ok) {
      this.owned.push(key);
      this.rowsSinceCompaction++;
    }
    return result;
  }

  async confirm(state: Uint8Array): Promise<YOfflineResult<void>> {
    return this.replace(
      await this.removable(this.owned),
      'b',
      state,
      'the synced document',
    );
  }

  async discard(): Promise<YOfflineResult<void>> {
    const mine = await this.removable(this.owned);
    if (mine.length === 0) {
      return DONE;
    }
    const result = await this.store.run<void>(
      [UPDATES],
      'readwrite',
      'removing a captured document',
      tx => {
        this.store.forget(this.key);
        const store = tx.objectStore(UPDATES);
        for (const key of mine) {
          store.delete(key);
        }
      },
      undefined,
    );
    if (result.ok) {
      const removed = new Set(mine);
      this.owned = this.owned.filter(key => !removed.has(key));
    }
    return result;
  }

  async compact(since?: Uint8Array): Promise<YOfflineResult<void>> {
    const mine = await this.removable(this.owned.filter(key => key[2] === 's'));
    if (mine.length <= 1 && since === undefined) {
      return DONE;
    }
    return this.replace(mine, 's', since ?? null, 'a compaction');
  }

  /**
   * In one transaction: remove `remove` (rows of this handle) and write one
   * row of `kind` holding `update`, or the merge of the removed rows that
   * are still stored when `update` is null.
   */
  private async replace(
    remove: readonly RowKey[],
    kind: RowKind,
    update: Uint8Array | null,
    doing: string,
  ): Promise<YOfflineResult<void>> {
    await this.hold();
    const key = this.nextKey(kind);
    const removed = new Set(remove);
    const result = await this.store.run<void>(
      this.store.stores(UPDATES),
      'readwrite',
      doing,
      (tx, _out, guard) => {
        const store = tx.objectStore(UPDATES);
        const write = (value: Uint8Array | null, keep?: Set<string>) => {
          for (const old of remove) {
            // A row that does not read stays, for load() to report.
            if (keep === undefined || !keep.has(JSON.stringify(old))) {
              store.delete(old);
            }
          }
          if (value !== null) {
            store.put(this.row(value), key);
          }
        };
        if (update !== null) {
          this.store.withinLimits(
            tx,
            guard,
            this.key,
            update.byteLength,
            new Set(remove.map(old => JSON.stringify(old))),
            () => write(update),
          );
          return;
        }
        readRows(
          tx,
          this.store.prefix([this.key, epochKey(this.epochValue), kind]),
          guard,
          rows => {
            // Keys read back are copies: compare them by value.
            const ids = new Set(remove.map(old => JSON.stringify(old)));
            const updates: Uint8Array[] = [];
            const keep = new Set<string>();
            for (const [rowKey, value] of rows) {
              const id = JSON.stringify(rowKey);
              if (ids.has(id)) {
                if (isRow(value)) {
                  updates.push(value.u);
                } else {
                  keep.add(id);
                }
              }
            }
            const merged = merge(updates);
            const removing = new Set(
              remove
                .map(old => JSON.stringify(old))
                .filter(id => !keep.has(id)),
            );
            this.store.withinLimits(
              tx,
              guard,
              this.key,
              merged === null ? 0 : merged.byteLength,
              removing,
              () => write(merged, keep),
            );
          },
        );
      },
      undefined,
    );
    if (result.ok) {
      this.owned = this.owned.filter(old => !removed.has(old));
      this.owned.push(key);
      this.rowsSinceCompaction = 0;
    }
    return result;
  }

  async adopt(epoch: string): Promise<YOfflineResult<void>> {
    requireEpoch(epoch);
    if (this.epochValue !== null) {
      throw new Error(
        `@lexical/y/offline: adopt(epoch) moves a slot that never synced (epoch null); this one is at '${this.epochValue}'. A document made against another epoch is captured, not moved: call session.serverEpoch(epoch).`,
      );
    }
    const from = this.store.prefix([this.key, 0]);
    // This handle's rows and those it loaded whose writer is gone; a live
    // tab's rows stay at null for it to move (its later rows build on them).
    const moving = new Set(
      (await this.removable(this.owned)).map(key => JSON.stringify(key)),
    );
    const result = await this.store.run<void>(
      [UPDATES],
      'readwrite',
      'adopting an epoch',
      (tx, _out, guard) => {
        const store = tx.objectStore(UPDATES);
        readRows(tx, from, guard, rows => {
          for (const [key, value] of rows) {
            if (moving.has(JSON.stringify(key))) {
              store.delete(key);
              store.put(value, [key[0], epoch, key[2], key[3], key[4]]);
            }
          }
        });
      },
      undefined,
    );
    if (result.ok) {
      this.epochValue = epoch;
      this.owned = this.owned
        .filter(key => moving.has(JSON.stringify(key)))
        .map((key): RowKey => [key[0], epoch, key[2], key[3], key[4]]);
    }
    return result;
  }
}

/**
 * @experimental Open the local store: one IndexedDB database per app, which
 * holds every document's slots and captures. Never throws for a storage
 * failure: a browser without IndexedDB returns `'unavailable'`, and the app
 * goes on without local persistence.
 *
 * @example
 * ```ts
 * const opened = await openYOfflineStore({
 *   idb: {indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange},
 * });
 * if (!opened.ok) showNotSavedLocally(opened.error.message);
 * ```
 */
export function openYOfflineStore(
  options: YOfflineStoreOptions,
): Promise<YOfflineResult<YOfflineStore>> {
  if (
    typeof options !== 'object' ||
    options === null ||
    typeof options.idb !== 'object' ||
    options.idb === null
  ) {
    throw new TypeError(
      '@lexical/y/offline: openYOfflineStore needs options.idb: pass {indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange} in a browser, or the two from a fake IndexedDB in Node.',
    );
  }
  const {indexedDB, IDBKeyRange: range} = options.idb;
  const name = options.databaseName ?? Y_OFFLINE_DEFAULTS.databaseName;
  const now = options.now ?? Date.now;
  const openTimeout = options.openTimeout ?? Y_OFFLINE_DEFAULTS.openTimeout;
  const nav = (globalThis as {navigator?: {locks?: YOfflineLocks}}).navigator;
  const locks =
    options.locks !== undefined
      ? options.locks
      : nav !== undefined && nav.locks !== undefined
        ? nav.locks
        : null;
  if (indexedDB == null || range == null) {
    return Promise.resolve(
      fail({
        code: 'unavailable',
        message:
          '@lexical/y/offline: there is no IndexedDB here (options.idb.indexedDB or IDBKeyRange is undefined: a private window, or Node without a fake). Run without local persistence and tell the user edits are kept in this tab only.',
      }),
    );
  }
  return new Promise(resolve => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(name, DB_VERSION);
    } catch (error) {
      resolve(fail(storageError(error, 'opening the store')));
      return;
    }
    // Answered once: blocked, failed, timed out or opened. A connection that
    // opens after another answer is closed: nobody holds it, and it must not
    // block the next upgrade.
    let answered = false;
    const answer = (result: YOfflineResult<YOfflineStore>) => {
      if (!answered) {
        answered = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    const timer = setTimeout(
      () =>
        answer(
          fail({
            code: 'unavailable',
            message: `@lexical/y/offline: IndexedDB did not open the store within ${openTimeout} ms. Run without local persistence for now and tell the user edits are kept in this tab only; open the store again later.`,
          }),
        ),
      openTimeout,
    );
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of [UPDATES, CAPTURES]) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store);
        }
      }
    };
    request.onblocked = () => {
      answer(
        fail({
          code: 'blocked',
          message:
            '@lexical/y/offline: another tab holds an older version of the database open. Ask the user to close the other tabs of this app, then open the store again.',
        }),
      );
    };
    request.onerror = () =>
      answer(fail(storageError(request.error, 'opening the store')));
    request.onsuccess = () => {
      if (answered) {
        request.result.close();
        return;
      }
      answer(
        ok(
          new Store(
            request.result,
            range,
            now,
            options.limits ?? null,
            locks,
            name,
          ),
        ),
      );
    };
  });
}

export {fail as offlineFail, ok as offlineOk};
