/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The local store of @lexical/y/offline over the in-repo fake IndexedDB:
// incremental rows, compaction, reload, the typed errors (quota, corrupt,
// unavailable, closed), clearing, captures, and two tabs on one key. Run
// with gc off and on (LEXICAL_Y_GC=1): the documents are the harness's.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {createYDoc} from '../..';
import {
  openYOfflineStore,
  Y_OFFLINE_DEFAULTS,
  type YOfflineCapture,
  type YOfflineStore,
} from '../../offline';
import {createFakeIndexedDB, type FakeIndexedDB} from '../utils/fakeIndexedDB';
import {WITH_GC} from '../utils/harness';

const DB = Y_OFFLINE_DEFAULTS.databaseName;

async function open(fake: FakeIndexedDB, now?: () => number) {
  const opened = await openYOfflineStore({
    idb: fake.idb,
    locks: fake.locks,
    now,
  });
  if (!opened.ok) {
    throw new Error(opened.error.message);
  }
  return opened.value;
}

function unwrap<T>(
  result: {ok: true; value: T} | {ok: false; error: {message: string}},
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

/** A document that records its updates. */
function typingDoc() {
  const doc = createYDoc(null, {gc: WITH_GC});
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  const text = doc.get('t');
  return {
    doc,
    text,
    type: (value: string) => text.insert(text.length, value),
    updates,
  };
}

const textOf = (state: Uint8Array) =>
  createYDoc(state, {gc: WITH_GC}).get('t').toString();

describe('openYOfflineStore', () => {
  test('without IndexedDB: unavailable, with what to do', async () => {
    const opened = await openYOfflineStore({
      idb: {IDBKeyRange: undefined, indexedDB: undefined},
    });
    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error.code).toBe('unavailable');
    expect(!opened.ok && opened.error.message).toMatch(
      /Run without local persistence/,
    );
  });

  test('idb is required, and the error names the call', () => {
    expect(() => openYOfflineStore({} as never)).toThrow(
      /needs options\.idb: pass \{indexedDB: globalThis\.indexedDB/,
    );
  });

  test('an open that fails is a typed result', async () => {
    const fake = createFakeIndexedDB();
    fake.failNextOpen('UnknownError');
    const opened = await openYOfflineStore({idb: fake.idb, locks: fake.locks});
    expect(!opened.ok && opened.error.code).toBe('failed');
    // The next one succeeds.
    expect(
      (await openYOfflineStore({idb: fake.idb, locks: fake.locks})).ok,
    ).toBe(true);
  });

  test('the defaults are exported and frozen', () => {
    expect(Y_OFFLINE_DEFAULTS).toEqual({
      compactAfter: 64,
      databaseName: 'lexical-y-offline',
      openTimeout: 10000,
    });
    expect(Object.isFrozen(Y_OFFLINE_DEFAULTS)).toBe(true);
  });

  test("an open the browser never answers is 'unavailable' after the timeout, and a connection that opens later is closed", async () => {
    const fake = createFakeIndexedDB();
    const release = fake.holdNextOpen();
    const opened = await openYOfflineStore({
      idb: fake.idb,
      locks: fake.locks,
      openTimeout: 20,
    });
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.error.code).toBe('unavailable');
      expect(opened.error.message).toMatch(
        /did not open the store within 20 ms/,
      );
    }
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fake.connections()).toEqual({open: 0, opened: 1});
    // The next open works.
    const again = await openYOfflineStore({
      idb: fake.idb,
      locks: fake.locks,
      openTimeout: 20,
    });
    expect(again.ok).toBe(true);
    expect(fake.connections()).toEqual({open: 1, opened: 2});
  });

  test('keys and epochs are checked, naming the fix', async () => {
    const store = await open(createFakeIndexedDB());
    expect(() => store.slot('', 'e1')).toThrow(
      /key must be a non-empty string/,
    );
    expect(() => store.slot('doc', 3 as never)).toThrow(
      /String\(epoch\) for a number/,
    );
    expect(() => store.clear('doc', {} as never)).toThrow(
      /needs what\.captures/,
    );
  });
});

describe('a slot', () => {
  test('stores updates incrementally and reloads them', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const slot = store.slot('doc', 'e1');
    expect(unwrap(await slot.load())).toBeNull();
    const a = typingDoc();
    a.type('hello');
    a.type(' world');
    for (const update of a.updates) {
      unwrap(await slot.append(update));
    }
    // One row per update.
    expect(fake.records(DB, 'updates').length).toBe(2);
    // A reload (another connection: a new page).
    const reloaded = unwrap(await (await open(fake)).slot('doc', 'e1').load());
    expect(reloaded).not.toBeNull();
    expect(textOf(reloaded!.state)).toBe('hello world');
    expect(reloaded!.base).toBeNull();
    expect(reloaded!.hasUnsyncedEdits).toBe(true);
  });

  test('an update that is a short view of a long buffer is stored at its own size', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const a = typingDoc();
    a.type('view');
    // As an encoder hands it out: a view into a larger buffer.
    const long = new Uint8Array(4096);
    long.set(a.updates[0], 100);
    const view = long.subarray(100, 100 + a.updates[0].length);
    unwrap(await store.slot('doc', 'e1').append(view));
    const row = fake.records(DB, 'updates')[0].value as {u: Uint8Array};
    expect(row.u.buffer.byteLength).toBe(a.updates[0].length);
    expect(textOf(unwrap(await store.slot('doc', 'e1').load())!.state)).toBe(
      'view',
    );
  });

  test('an epoch is its own slot; null is the never-synced one', async () => {
    const fake = createFakeIndexedDB();
    let clock = 0;
    const store = await open(fake, () => ++clock);
    const one = typingDoc();
    one.type('one');
    const two = typingDoc();
    two.type('two');
    const none = typingDoc();
    none.type('none');
    unwrap(await store.slot('doc', 'e1').append(one.updates[0]));
    unwrap(await store.slot('doc', 'e2').append(two.updates[0]));
    unwrap(await store.slot('doc', null).append(none.updates[0]));
    unwrap(await store.slot('other', 'e1').append(two.updates[0]));
    expect(textOf(unwrap(await store.slot('doc', 'e1').load())!.state)).toBe(
      'one',
    );
    expect(textOf(unwrap(await store.slot('doc', 'e2').load())!.state)).toBe(
      'two',
    );
    expect(textOf(unwrap(await store.slot('doc', null).load())!.state)).toBe(
      'none',
    );
    // Newest first.
    expect(unwrap(await store.slots('doc')).map(s => s.epoch)).toEqual([
      null,
      'e2',
      'e1',
    ]);
    expect(unwrap(await store.slots('doc'))[0]).toEqual({
      epoch: null,
      hasUnsyncedEdits: true,
      key: 'doc',
      rows: 1,
      updatedAt: 3,
    });
  });

  test('confirm makes the state the base and drops the rows it covers', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const slot = store.slot('doc', 'e1');
    const a = typingDoc();
    a.type('synced');
    unwrap(await slot.append(a.updates[0]));
    unwrap(await slot.confirm(Y.encodeStateAsUpdate(a.doc)));
    expect(fake.records(DB, 'updates').length).toBe(1);
    a.type(' and more');
    unwrap(await slot.append(a.updates[1]));
    const stored = unwrap(await store.slot('doc', 'e1').load())!;
    expect(textOf(stored.base!)).toBe('synced');
    expect(textOf(stored.state)).toBe('synced and more');
    expect(stored.hasUnsyncedEdits).toBe(true);
    // Confirmed again: nothing unsynced.
    unwrap(await slot.confirm(Y.encodeStateAsUpdate(a.doc)));
    const after = unwrap(await store.slot('doc', 'e1').load())!;
    expect(after.hasUnsyncedEdits).toBe(false);
    expect(textOf(after.base!)).toBe('synced and more');
    expect(fake.records(DB, 'updates').length).toBe(1);
  });

  test('compaction replaces the rows by one, with the same document', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const slot = store.slot('doc', 'e1');
    const a = typingDoc();
    for (let i = 0; i < 20; i++) {
      a.type(String(i % 10));
      unwrap(await slot.append(a.updates[i]));
    }
    expect(slot.rowsSinceCompaction).toBe(20);
    expect(fake.records(DB, 'updates').length).toBe(20);
    // By merging the rows.
    unwrap(await slot.compact());
    expect(slot.rowsSinceCompaction).toBe(0);
    expect(fake.records(DB, 'updates').length).toBe(1);
    expect(textOf(unwrap(await store.slot('doc', 'e1').load())!.state)).toBe(
      a.text.toString(),
    );
    // With the document's own encoding (what the session passes).
    a.type('!');
    unwrap(await slot.append(a.updates[20]));
    unwrap(await slot.compact(Y.encodeStateAsUpdate(a.doc)));
    expect(fake.records(DB, 'updates').length).toBe(1);
    const stored = unwrap(await store.slot('doc', 'e1').load())!;
    expect(textOf(stored.state)).toBe(a.text.toString());
    expect(stored.hasUnsyncedEdits).toBe(true);
  });

  test('deleted text stays deleted across compaction and reload', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const slot = store.slot('doc', 'e1');
    const a = typingDoc();
    a.type('keep drop');
    a.text.delete(4, 5);
    for (const update of a.updates) {
      unwrap(await slot.append(update));
    }
    unwrap(await slot.compact());
    expect(textOf(unwrap(await store.slot('doc', 'e1').load())!.state)).toBe(
      'keep',
    );
  });

  test('adopt moves the never-synced slot to its first epoch', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const slot = store.slot('doc', null);
    const a = typingDoc();
    a.type('new note');
    unwrap(await slot.append(a.updates[0]));
    unwrap(await slot.adopt('e1'));
    expect(slot.epoch).toBe('e1');
    expect(unwrap(await store.slots('doc')).map(s => s.epoch)).toEqual(['e1']);
    // The handle keeps its rows: a confirm covers them.
    unwrap(await slot.confirm(Y.encodeStateAsUpdate(a.doc)));
    expect(fake.records(DB, 'updates').length).toBe(1);
    await expect(slot.adopt('e2')).rejects.toThrow(/never synced/);
  });

  test('clear: one epoch, a key, and its captures', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const a = typingDoc();
    a.type('x');
    for (const [key, epoch] of [
      ['doc', 'e1'],
      ['doc', 'e2'],
      ['other', 'e1'],
    ] as const) {
      unwrap(await store.slot(key, epoch).append(a.updates[0]));
    }
    unwrap(await store.putCapture(capture('doc', 'c1')));
    unwrap(await store.clear('doc', {captures: false, epoch: 'e1'}));
    expect(unwrap(await store.slots('doc')).map(s => s.epoch)).toEqual(['e2']);
    expect(unwrap(await store.captures('doc')).length).toBe(1);
    unwrap(await store.clear('doc', {captures: true}));
    expect(unwrap(await store.slots('doc'))).toEqual([]);
    expect(unwrap(await store.captures('doc'))).toEqual([]);
    // Another key is untouched.
    expect(unwrap(await store.slots('other')).length).toBe(1);
  });
});

function capture(key: string, id: string, at = 1): YOfflineCapture {
  const a = typingDoc();
  a.type(id);
  return {
    base: null,
    capturedAt: at,
    claimed: false,
    differs: false,
    epoch: 'e1',
    id,
    json: {root: {children: []}},
    key,
    reason: 'stale',
    state: Y.encodeStateAsUpdate(a.doc),
    text: id,
  };
}

describe('captures', () => {
  test('stored, listed oldest first, claimed once, deleted', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    unwrap(await store.putCapture(capture('doc', 'later', 2)));
    unwrap(await store.putCapture(capture('doc', 'first', 1)));
    unwrap(await store.putCapture(capture('other', 'theirs', 1)));
    const listed = unwrap(await store.captures('doc'));
    expect(listed.map(c => c.id)).toEqual(['first', 'later']);
    expect(listed[0].state).toBeInstanceOf(Uint8Array);
    expect(listed[0].json).toEqual({root: {children: []}});
    // Two tabs claim at once: one gets it.
    const other = await open(fake);
    const claims = await Promise.all([
      store.claimCapture('doc', 'first'),
      other.claimCapture('doc', 'first'),
    ]);
    expect(claims.map(unwrap).sort()).toEqual([false, true]);
    expect(unwrap(await store.captures('doc'))[0].claimed).toBe(true);
    expect(unwrap(await store.claimCapture('doc', 'missing'))).toBe(false);
    unwrap(await store.deleteCapture('doc', 'first'));
    expect(unwrap(await store.captures('doc')).map(c => c.id)).toEqual([
      'later',
    ]);
  });
});

describe('keys and limits', () => {
  test('keys() lists every key with a slot or a capture, for clearing by owner', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const {doc, type} = typingDoc();
    type('x');
    const update = Y.encodeStateAsUpdate(doc);
    unwrap(await store.slot('alice|d1|s', 'e1').append(update));
    unwrap(await store.slot('alice|d2|s', null).append(update));
    unwrap(await store.slot('bob|d1|s', 'e1').append(update));
    unwrap(await store.putCapture(capture('carol|d9|s', 'c1', 1)));
    expect(unwrap(await store.keys())).toEqual([
      'alice|d1|s',
      'alice|d2|s',
      'bob|d1|s',
      'carol|d9|s',
    ]);
    // Clear every viewer but alice.
    for (const key of unwrap(await store.keys())) {
      if (!key.startsWith('alice|')) {
        unwrap(await store.clear(key, {captures: true}));
      }
    }
    expect(unwrap(await store.keys())).toEqual(['alice|d1|s', 'alice|d2|s']);
  });

  test('limits.keys refuses a new key past the cap of its group, evicts nothing, and admits it once there is room', async () => {
    const fake = createFakeIndexedDB();
    const opened = await openYOfflineStore({
      idb: fake.idb,
      limits: {group: key => key.split('|')[0], keys: 2},
      locks: fake.locks,
    });
    const store = unwrap(opened);
    const {doc, type} = typingDoc();
    type('x');
    const update = Y.encodeStateAsUpdate(doc);
    unwrap(await store.slot('alice|d1', 'e1').append(update));
    unwrap(await store.putCapture(capture('alice|d2', 'c', 1)));
    // Another viewer's keys count in their own group.
    unwrap(await store.slot('bob|d1', 'e1').append(update));
    const refused = await store.slot('alice|d3', 'e1').append(update);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('limit');
      expect(refused.error.limit).toBe('keys');
      expect(refused.error.message).toMatch(/nothing was evicted/);
    }
    const capRefused = await store.putCapture(capture('alice|d4', 'c', 1));
    expect(!capRefused.ok && capRefused.error.limit).toBe('keys');
    // An existing key still writes.
    unwrap(await store.slot('alice|d1', 'e1').append(update));
    expect(unwrap(await store.keys())).toEqual([
      'alice|d1',
      'alice|d2',
      'bob|d1',
    ]);
    unwrap(await store.clear('alice|d2', {captures: true}));
    unwrap(await store.slot('alice|d3', 'e1').append(update));
  });

  test('limits.bytesPerKey refuses a write past it (rows and captures count), evicts nothing, and a compaction or clear makes room', async () => {
    const fake = createFakeIndexedDB();
    const {doc, type, updates} = typingDoc();
    type('a'.repeat(300));
    const big = Y.encodeStateAsUpdate(doc);
    const store = unwrap(
      await openYOfflineStore({
        idb: fake.idb,
        limits: {bytesPerKey: big.byteLength + 200},
        locks: fake.locks,
      }),
    );
    const slot = store.slot('doc', 'e1');
    unwrap(await slot.append(big));
    updates.length = 0;
    type('b');
    unwrap(await slot.append(updates[0]));
    // A capture of the whole document does not fit beside the rows.
    const refused = await store.putCapture({
      ...capture('doc', 'c', 1),
      state: big,
    });
    expect(!refused.ok && refused.error.code).toBe('limit');
    expect(!refused.ok && refused.error.limit).toBe('bytes');
    expect(unwrap(await store.captures('doc'))).toEqual([]);
    // Neither does an update past it; the rows stay.
    const tooBig = await slot.append(new Uint8Array(300).fill(1));
    expect(!tooBig.ok && tooBig.error.limit).toBe('bytes');
    expect(textOf(unwrap(await slot.load())!.state)).toBe(
      'a'.repeat(300) + 'b',
    );
    // Another handle (another tab) sees the same stored bytes.
    const other = store.slot('doc', 'e1');
    const refusedToo = await other.append(new Uint8Array(300).fill(1));
    expect(!refusedToo.ok && refusedToo.error.limit).toBe('bytes');
    // A compaction replaces rows by fewer bytes: allowed.
    unwrap(await slot.compact());
    unwrap(await store.clear('doc', {captures: true}));
    unwrap(await store.slot('doc', 'e1').append(big));
  });
});

describe('errors as typed results', () => {
  test('a full quota: the write is refused whole, and succeeds once there is room', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const slot = store.slot('doc', 'e1');
    const a = typingDoc();
    a.type('small');
    unwrap(await slot.append(a.updates[0]));
    fake.setQuota(64);
    a.type('x'.repeat(500));
    const refused = await slot.append(a.updates[1]);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.code).toBe('quota');
    expect(!refused.ok && refused.error.message).toMatch(
      /not saved on this device/,
    );
    // Nothing of the refused write is stored.
    expect(fake.records(DB, 'updates').length).toBe(1);
    expect(textOf(unwrap(await store.slot('doc', 'e1').load())!.state)).toBe(
      'small',
    );
    fake.setQuota(Infinity);
    unwrap(await slot.append(a.updates[1]));
    expect(
      textOf(unwrap(await store.slot('doc', 'e1').load())!.state).length,
    ).toBe(505);
  });

  test('a compaction refused by the quota keeps every row', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const slot = store.slot('doc', 'e1');
    const a = typingDoc();
    a.type('one');
    a.type('two');
    for (const update of a.updates) {
      unwrap(await slot.append(update));
    }
    fake.setQuota(1);
    const refused = await slot.compact();
    expect(!refused.ok && refused.error.code).toBe('quota');
    expect(fake.records(DB, 'updates').length).toBe(2);
    fake.setQuota(Infinity);
    expect(textOf(unwrap(await store.slot('doc', 'e1').load())!.state)).toBe(
      'onetwo',
    );
  });

  test.each([
    [
      'a row cut short',
      (value: {u: Uint8Array}) => ({...value, u: value.u.slice(0, 3)}),
    ],
    [
      'a changed byte',
      (value: {u: Uint8Array}) => {
        const u = value.u.slice();
        u[u.length - 1] ^= 0xff;
        return {...value, u};
      },
    ],
    ['a value of another shape', () => 'not a row'],
  ])(
    'a corrupted store (%s): corrupt, with what is readable',
    async (_name, damage) => {
      const fake = createFakeIndexedDB();
      const store = await open(fake);
      const slot = store.slot('doc', 'e1');
      const a = typingDoc();
      a.type('good');
      a.type(' bad');
      for (const update of a.updates) {
        unwrap(await slot.append(update));
      }
      const records = fake.records(DB, 'updates');
      records[1].value = damage(records[1].value as {u: Uint8Array});
      const loaded = await (await open(fake)).slot('doc', 'e1').load();
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.error.code).toBe('corrupt');
        expect(loaded.error.epoch).toBe('e1');
        expect(loaded.error.message).toMatch(/store\.clear\(key/);
        expect(loaded.error.salvage).toMatchObject({
          readableRows: 1,
          unreadableRows: 1,
        });
        expect(textOf(loaded.error.salvage!.state!)).toBe('good');
      }
      // Clearing it is the way out.
      unwrap(await store.clear('doc', {captures: false, epoch: 'e1'}));
      expect(unwrap(await store.slot('doc', 'e1').load())).toBeNull();
    },
  );

  test("a row of a later format: 'newer', with the slot's epoch, and nothing to clear", async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const slot = store.slot('doc', 'e1');
    const a = typingDoc();
    a.type('good');
    a.type(' newer');
    for (const update of a.updates) {
      unwrap(await slot.append(update));
    }
    const records = fake.records(DB, 'updates');
    records[1].value = {...(records[1].value as object), v: 99};
    const loaded = await (await open(fake)).slot('doc', 'e1').load();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('newer');
      expect(loaded.error.epoch).toBe('e1');
      expect(loaded.error.message).toMatch(/Keep them \(do not clear/);
      expect(loaded.error.salvage).toBeUndefined();
    }
    // Nothing was removed.
    expect(fake.records(DB, 'updates').length).toBe(2);
  });

  test('a compaction leaves a row it cannot read for load() to report', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const slot = store.slot('doc', 'e1');
    const a = typingDoc();
    a.type('a');
    a.type('b');
    a.type('c');
    for (const update of a.updates) {
      unwrap(await slot.append(update));
    }
    fake.records(DB, 'updates')[0].value = 'damaged';
    unwrap(await slot.compact());
    const loaded = await store.slot('doc', 'e1').load();
    expect(!loaded.ok && loaded.error.code).toBe('corrupt');
    expect(!loaded.ok && loaded.error.salvage!.unreadableRows).toBe(1);
  });

  test('a closed store: closed', async () => {
    const store = await open(createFakeIndexedDB());
    store.close();
    const result = await store.slot('doc', 'e1').append(new Uint8Array([1]));
    expect(!result.ok && result.error.code).toBe('closed');
    expect(!result.ok && result.error.message).toMatch(/openYOfflineStore/);
  });
});

describe('two tabs on one key', () => {
  async function tabs() {
    const fake = createFakeIndexedDB();
    const a: YOfflineStore = await open(fake);
    const b: YOfflineStore = await open(fake);
    return {a, b, fake};
  }

  test('interleaved writes are all kept, and a reload holds both', async () => {
    const {a, b, fake} = await tabs();
    const slotA = a.slot('doc', 'e1');
    const slotB = b.slot('doc', 'e1');
    const docA = typingDoc();
    const docB = typingDoc();
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      docA.type('a');
      docB.type('b');
      writes.push(slotA.append(docA.updates[i]), slotB.append(docB.updates[i]));
    }
    (await Promise.all(writes)).forEach(r => unwrap(r as never));
    expect(fake.records(DB, 'updates').length).toBe(20);
    const merged = createYDoc(
      unwrap(await (await open(fake)).slot('doc', 'e1').load())!.state,
      {gc: WITH_GC},
    );
    const expected = createYDoc(null, {gc: WITH_GC});
    Y.applyUpdate(expected, Y.encodeStateAsUpdate(docA.doc));
    Y.applyUpdate(expected, Y.encodeStateAsUpdate(docB.doc));
    expect(merged.get('t').toString()).toBe(expected.get('t').toString());
    expect(merged.get('t').toString().length).toBe(20);
  });

  test("one tab's compaction and confirm never drop the other tab's rows", async () => {
    const {a, b, fake} = await tabs();
    const slotA = a.slot('doc', 'e1');
    const slotB = b.slot('doc', 'e1');
    const docA = typingDoc();
    const docB = typingDoc();
    docA.type('from a');
    docB.type('from b');
    unwrap(await slotA.append(docA.updates[0]));
    unwrap(await slotB.append(docB.updates[0]));
    docA.type('!');
    unwrap(await slotA.append(docA.updates[1]));
    // A compacts, then confirms its own document, which never held B's.
    unwrap(await slotA.compact());
    expect(fake.records(DB, 'updates').length).toBe(2);
    unwrap(await slotA.confirm(Y.encodeStateAsUpdate(docA.doc)));
    const stored = unwrap(await (await open(fake)).slot('doc', 'e1').load())!;
    // B's edit is still stored, and still unsynced.
    expect(stored.hasUnsyncedEdits).toBe(true);
    expect(textOf(stored.base!)).toBe('from a!');
    const all = createYDoc(stored.state, {gc: WITH_GC}).get('t').toString();
    expect(all).toContain('from a!');
    expect(all).toContain('from b');
    // B syncs later (its document holds both by then).
    Y.applyUpdate(docB.doc, Y.encodeStateAsUpdate(docA.doc));
    unwrap(await slotB.confirm(Y.encodeStateAsUpdate(docB.doc)));
    const after = unwrap(await (await open(fake)).slot('doc', 'e1').load())!;
    expect(after.hasUnsyncedEdits).toBe(false);
    expect(textOf(after.state)).toBe(docB.text.toString());
  });

  test("discard removes a handle's own rows and leaves the other tab's", async () => {
    const {a, b, fake} = await tabs();
    const slotA = a.slot('doc', 'e1');
    const slotB = b.slot('doc', 'e1');
    const docA = typingDoc();
    const docB = typingDoc();
    docA.type('from a');
    docB.type('from b');
    unwrap(await slotA.append(docA.updates[0]));
    unwrap(await slotB.append(docB.updates[0]));
    unwrap(await slotA.discard());
    expect(fake.records(DB, 'updates').length).toBe(1);
    const stored = unwrap(await (await open(fake)).slot('doc', 'e1').load())!;
    expect(textOf(stored.state)).toBe('from b');
    expect(stored.hasUnsyncedEdits).toBe(true);
    // Nothing left of its own: a second discard does nothing.
    unwrap(await slotA.discard());
    expect(fake.records(DB, 'updates').length).toBe(1);
  });

  test('a tab that loaded the rows of a closed tab owns them', async () => {
    const {a, fake} = await tabs();
    const closed = a.slot('doc', 'e1');
    const doc = typingDoc();
    doc.type('left behind');
    unwrap(await closed.append(doc.updates[0]));
    closed.close();
    // A new page loads them, syncs, confirms.
    const next = (await open(fake)).slot('doc', 'e1');
    const loaded = unwrap(await next.load())!;
    const reopened = createYDoc(loaded.state, {gc: WITH_GC});
    unwrap(await next.confirm(Y.encodeStateAsUpdate(reopened)));
    const stored = unwrap(await (await open(fake)).slot('doc', 'e1').load())!;
    expect(stored.hasUnsyncedEdits).toBe(false);
    expect(textOf(stored.base!)).toBe('left behind');
    expect(fake.records(DB, 'updates').length).toBe(1);
  });
});
