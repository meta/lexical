/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A minimal in-memory IndexedDB for the offline store's tests in Node: the
// repository has no fake among its dev dependencies, and the store uses a
// small part of the API. What it models, as browsers do:
//
// - out-of-line keys of numbers, strings and arrays of them, in IndexedDB's
//   key order (numbers, then strings, then arrays), and key ranges;
// - values stored and read as structured clones;
// - transactions that run one at a time per database (as readwrite
//   transactions over the same stores do), commit when no request is left,
//   and roll back as a whole on abort (a request callback that throws
//   aborts with an AbortError, the exception kept in `uncaught()`);
// - a storage quota: a write past it fails its request and aborts the
//   transaction with a QuotaExceededError.
//
// Not modelled: indexes, cursors, key paths, auto-increment, version
// upgrades of an existing database, and durability.
//
// It has not been compared with a browser's IndexedDB in this repository's
// test run: keep the store to this part of the API, or extend both.

// Node only: structuredClone is what IndexedDB stores values with.
/* eslint-disable compat/compat */

type Key = number | string | Key[];

function rank(key: Key): number {
  return typeof key === 'number' ? 0 : typeof key === 'string' ? 1 : 2;
}

export function compareKeys(a: Key, b: Key): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) {
    return ra - rb;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareKeys(a[i], b[i]);
      if (c !== 0) {
        return c;
      }
    }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

class FakeKeyRange {
  constructor(
    readonly lower: Key,
    readonly upper: Key,
  ) {}
  static bound(lower: Key, upper: Key): FakeKeyRange {
    return new FakeKeyRange(lower, upper);
  }
  static only(key: Key): FakeKeyRange {
    return new FakeKeyRange(key, key);
  }
  includes(key: Key): boolean {
    return (
      compareKeys(key, this.lower) >= 0 && compareKeys(key, this.upper) <= 0
    );
  }
}

type Records = {key: Key; value: unknown}[];
type Handler = ((event: {target: unknown}) => void) | null;

class FakeRequest {
  result: unknown = undefined;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  constructor(readonly run: () => unknown) {}
}

function domError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function sizeOf(value: unknown): number {
  if (value instanceof Uint8Array) {
    return value.byteLength;
  }
  if (Array.isArray(value)) {
    return value.reduce((n: number, v) => n + sizeOf(v), 0);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).reduce((n: number, v) => n + sizeOf(v), 0);
  }
  return typeof value === 'string' ? value.length : 8;
}

class FakeObjectStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly name: string,
  ) {}

  private get records(): Records {
    return this.tx.working.get(this.name)!;
  }

  private matches(query: Key | FakeKeyRange): (key: Key) => boolean {
    return query instanceof FakeKeyRange
      ? key => query.includes(key)
      : key => compareKeys(key, query) === 0;
  }

  put(value: unknown, key: Key): FakeRequest {
    const stored = structuredClone(value);
    const storedKey = structuredClone(key);
    return this.tx.request(() => {
      this.tx.requireWritable();
      const records = this.records.filter(
        r => compareKeys(r.key, storedKey) !== 0,
      );
      records.push({key: storedKey, value: stored});
      records.sort((a, b) => compareKeys(a.key, b.key));
      this.tx.working.set(this.name, records);
      if (
        this.tx.db.factory.usage(this.tx.working) >
        this.tx.db.factory.quotaBytes
      ) {
        throw domError('QuotaExceededError', 'The quota has been exceeded.');
      }
      return storedKey;
    });
  }

  delete(query: Key | FakeKeyRange): FakeRequest {
    const matches = this.matches(query);
    return this.tx.request(() => {
      this.tx.requireWritable();
      this.tx.working.set(
        this.name,
        this.records.filter(r => !matches(r.key)),
      );
      return undefined;
    });
  }

  get(query: Key | FakeKeyRange): FakeRequest {
    const matches = this.matches(query);
    return this.tx.request(() => {
      const found = this.records.find(r => matches(r.key));
      return found === undefined ? undefined : structuredClone(found.value);
    });
  }

  getAll(query: Key | FakeKeyRange): FakeRequest {
    const matches = this.matches(query);
    return this.tx.request(() =>
      this.records
        .filter(r => matches(r.key))
        .map(r => structuredClone(r.value)),
    );
  }

  getAllKeys(query: Key | FakeKeyRange): FakeRequest {
    const matches = this.matches(query);
    return this.tx.request(() =>
      this.records.filter(r => matches(r.key)).map(r => structuredClone(r.key)),
    );
  }
}

class FakeTransaction {
  oncomplete: Handler = null;
  onabort: Handler = null;
  onerror: Handler = null;
  error: unknown = null;
  working: Map<string, Records> = new Map();
  private queue: FakeRequest[] = [];
  private state: 'waiting' | 'running' | 'done' = 'waiting';

  constructor(
    readonly db: FakeDatabase,
    private readonly names: string[],
    private readonly mode: string,
  ) {}

  objectStore(name: string): FakeObjectStore {
    if (!this.names.includes(name)) {
      throw domError('NotFoundError', `No object store '${name}' in scope.`);
    }
    return new FakeObjectStore(this, name);
  }

  requireWritable(): void {
    if (this.mode !== 'readwrite') {
      throw domError('ReadOnlyError', 'The transaction is read only.');
    }
  }

  request(run: () => unknown): FakeRequest {
    if (this.state === 'done') {
      throw domError('TransactionInactiveError', 'The transaction finished.');
    }
    const request = new FakeRequest(run);
    this.queue.push(request);
    return request;
  }

  abort(): void {
    if (this.state !== 'done') {
      this.finish(this.error ?? domError('AbortError', 'Aborted.'));
    }
  }

  /** Called by the database when this transaction's turn comes. */
  start(): void {
    this.state = 'running';
    for (const name of this.names) {
      this.working.set(name, [...this.db.stores.get(name)!]);
    }
    this.pump();
  }

  private pump(): void {
    setTimeout(() => {
      if (this.state === 'done') {
        return;
      }
      const request = this.queue.shift();
      if (request === undefined) {
        this.finish(null);
        return;
      }
      try {
        request.result = request.run();
      } catch (error) {
        request.error = error;
        if (request.onerror !== null) {
          request.onerror({target: request});
        }
        if (this.onerror !== null) {
          this.onerror({target: request});
        }
        this.finish(error);
        return;
      }
      try {
        if (request.onsuccess !== null) {
          request.onsuccess({target: request});
        }
      } catch (error) {
        // As browsers do: a callback that throws aborts its transaction
        // with an AbortError, and the exception goes to the window (here,
        // the factory's list), not to the transaction.
        this.db.factory.uncaught.push(error);
        this.finish(domError('AbortError', 'A request callback threw.'));
        return;
      }
      this.pump();
    }, 0);
  }

  private finish(error: unknown): void {
    this.state = 'done';
    this.queue = [];
    if (error === null) {
      for (const [name, records] of this.working) {
        this.db.stores.set(name, records);
      }
      if (this.oncomplete !== null) {
        this.oncomplete({target: this});
      }
    } else {
      this.error = error;
      if (this.onabort !== null) {
        this.onabort({target: this});
      }
    }
    this.db.finished(this);
  }
}

class FakeDatabase {
  readonly stores: Map<string, Records> = new Map();
  private active: FakeTransaction | null = null;
  private waiting: FakeTransaction[] = [];
  deleted = false;

  constructor(readonly factory: FakeFactory) {}

  enqueue(tx: FakeTransaction): void {
    this.waiting.push(tx);
    this.next();
  }

  finished(tx: FakeTransaction): void {
    if (this.active === tx) {
      this.active = null;
      this.next();
    }
  }

  private next(): void {
    if (this.active === null && this.waiting.length > 0) {
      this.active = this.waiting.shift()!;
      this.active.start();
    }
  }
}

/** One connection (a tab's) to a database. */
class FakeConnection {
  onversionchange: Handler = null;
  closed = false;
  constructor(private readonly db: FakeDatabase) {}

  get objectStoreNames(): {contains(name: string): boolean} {
    return {contains: name => this.db.stores.has(name)};
  }

  createObjectStore(name: string): void {
    this.db.stores.set(name, []);
  }

  transaction(names: string | string[], mode: string = 'readonly') {
    if (this.closed || this.db.deleted) {
      throw domError('InvalidStateError', 'The connection is closed.');
    }
    const tx = new FakeTransaction(
      this.db,
      typeof names === 'string' ? [names] : names,
      mode,
    );
    this.db.enqueue(tx);
    return tx;
  }

  close(): void {
    this.closed = true;
  }
}

class FakeOpenRequest {
  result: FakeConnection | undefined = undefined;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

class FakeFactory {
  readonly databases: Map<string, FakeDatabase> = new Map();
  quotaBytes = Infinity;
  /** Set to make the next open() fail with this error. */
  failOpenWith: Error | null = null;
  /** Set to hold the next open() until the promise resolves. */
  holdOpenUntil: Promise<void> | null = null;
  /** Every connection opened, to tell which were closed. */
  readonly connections: FakeConnection[] = [];
  /** What request callbacks threw (a browser reports it at the window). */
  readonly uncaught: unknown[] = [];

  usage(working: Map<string, Records>): number {
    let total = 0;
    for (const db of this.databases.values()) {
      for (const [name, records] of db.stores) {
        for (const record of working.get(name) ?? records) {
          total += sizeOf(record.value);
        }
      }
    }
    return total;
  }

  open(name: string): FakeOpenRequest {
    const request = new FakeOpenRequest();
    const hold = this.holdOpenUntil;
    this.holdOpenUntil = null;
    const run = () => {
      if (this.failOpenWith !== null) {
        request.error = this.failOpenWith;
        this.failOpenWith = null;
        if (request.onerror !== null) {
          request.onerror({target: request});
        }
        return;
      }
      let db = this.databases.get(name);
      const isNew = db === undefined;
      if (db === undefined) {
        db = new FakeDatabase(this);
        this.databases.set(name, db);
      }
      request.result = new FakeConnection(db);
      this.connections.push(request.result);
      if (isNew && request.onupgradeneeded !== null) {
        request.onupgradeneeded({target: request});
      }
      if (request.onsuccess !== null) {
        request.onsuccess({target: request});
      }
    };
    if (hold === null) {
      setTimeout(run, 0);
    } else {
      void hold.then(() => setTimeout(run, 0));
    }
    return request;
  }

  deleteDatabase(name: string): void {
    const db = this.databases.get(name);
    if (db !== undefined) {
      db.deleted = true;
      this.databases.delete(name);
    }
  }
}

/**
 * The origin's Web Locks, as the store uses them: exclusive locks by name,
 * granted in request order, released when the callback's promise settles.
 */
class FakeLocks {
  private readonly held = new Set<string>();
  private readonly waiting = new Map<string, (() => void)[]>();

  request(
    name: string,
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.held.add(name);
        Promise.resolve()
          .then(() => callback({mode: 'exclusive', name}))
          .then(resolve, reject)
          .finally(() => {
            this.held.delete(name);
            const next = this.waiting.get(name)?.shift();
            if (next !== undefined) {
              next();
            }
          });
      };
      if (this.held.has(name)) {
        const queue = this.waiting.get(name) ?? [];
        queue.push(run);
        this.waiting.set(name, queue);
      } else {
        run();
      }
    });
  }

  query(): Promise<{held: {name: string}[]}> {
    return Promise.resolve({held: [...this.held].map(name => ({name}))});
  }
}

/** What the tests hold: the pair the store takes, and the fake's controls. */
export interface FakeIndexedDB {
  /** `openYOfflineStore({idb})`. */
  readonly idb: {
    readonly indexedDB: IDBFactory;
    readonly IDBKeyRange: typeof IDBKeyRange;
  };
  /** `openYOfflineStore({locks})`: the origin's Web Locks. */
  readonly locks: FakeLocks;
  /** The origin's quota in bytes (default: none). */
  setQuota(bytes: number): void;
  /** The next open() fails with an error of this name. */
  failNextOpen(name: string): void;
  /**
   * The next open() answers nothing until the returned function is called
   * (as some browsers leave an open pending).
   */
  holdNextOpen(): () => void;
  /** How many connections were opened, and how many of them are open. */
  connections(): {opened: number; open: number};
  /** What request callbacks threw, as a browser reports it at the window. */
  uncaught(): readonly unknown[];
  /** The stored records of an object store, to read or damage. */
  records(database: string, store: string): {key: unknown; value: unknown}[];
  deleteDatabase(name: string): void;
}

/** A new, empty origin. */
export function createFakeIndexedDB(): FakeIndexedDB {
  const factory = new FakeFactory();
  const locks = new FakeLocks();
  return {
    connections: () => ({
      open: factory.connections.filter(c => !c.closed).length,
      opened: factory.connections.length,
    }),
    deleteDatabase: name => factory.deleteDatabase(name),
    failNextOpen: name => {
      factory.failOpenWith = domError(name, name);
    },
    holdNextOpen: () => {
      let release = () => {};
      factory.holdOpenUntil = new Promise<void>(resolve => {
        release = resolve;
      });
      return () => release();
    },
    idb: {
      IDBKeyRange: FakeKeyRange as unknown as typeof IDBKeyRange,
      indexedDB: factory as unknown as IDBFactory,
    },
    locks,
    records: (database, store) => {
      const db = factory.databases.get(database);
      const records = db === undefined ? undefined : db.stores.get(store);
      if (records === undefined) {
        throw new Error(`no store ${database}/${store}`);
      }
      return records;
    },
    setQuota: bytes => {
      factory.quotaBytes = bytes;
    },
    uncaught: () => factory.uncaught,
  };
}
