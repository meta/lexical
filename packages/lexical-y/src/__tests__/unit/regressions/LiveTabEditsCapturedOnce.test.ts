/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A page does not capture another open tab's unsynced edits as its own
// (reported from an app's offline layer). Tab A is open at an older epoch
// E1, offline, holding unsynced edits and its writer lock; the room moved
// to E2. Before, every new page B loaded A's rows, bound at E1, met E2
// (`'moved'`) and stored a capture of A's edits, again on every page load
// (A's rows stay: a live writer's), and once more when A reconnected. Now
// the load says those edits are only a live tab's (`unsyncedInLiveTabs`),
// B captures nothing of them unless it edits, and A captures its own.

import * as Y from '@y/y';
import {expect, test} from 'vitest';

import {
  attachYOfflineSession,
  loadYOffline,
  openYOfflineStore,
  Y_OFFLINE_DEFAULTS,
  type YOfflineBinding,
  type YOfflineResult,
} from '../../../offline';
import {createFakeIndexedDB} from '../../utils/fakeIndexedDB';
import {WITH_GC} from '../../utils/harness';

function unwrap<T>(result: YOfflineResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function plain(state: Uint8Array | null) {
  const doc = new Y.Doc({gc: WITH_GC});
  if (state !== null) {
    Y.applyUpdate(doc, state);
  }
  const text = doc.get('t');
  const binding = {
    binding: {doc},
    freeze: () => ({
      differs: false,
      json: null,
      state: Y.encodeStateAsUpdate(doc),
      text: text.toString(),
    }),
    status: {kind: 'active'},
  } as unknown as YOfflineBinding;
  return {binding, doc, text};
}

test("a live tab's unsynced edits are captured once, by that tab", async () => {
  const fake = createFakeIndexedDB();
  const open = async () =>
    unwrap(await openYOfflineStore({idb: fake.idb, locks: fake.locks}));
  // Tab A at E1, synced, then offline with an edit: still open.
  const storeA = await open();
  const a = plain(null);
  a.text.insert(0, 'synced');
  const sessionA = attachYOfflineSession({
    binding: a.binding,
    epoch: 'E1',
    key: 'doc',
    loaded: null,
    offline: {persist: 'document', stage: 'persist', store: storeA},
    onError: () => {},
    stopSync: () => {},
  });
  const confirmed = await sessionA.serverEpoch('E1');
  if (confirmed.kind === 'same') {
    confirmed.markSynced();
  }
  a.text.insert(a.text.length, ', typed in tab A offline');
  unwrap(await sessionA.flush());

  // Page B, three page loads while A is open; the room is at E2.
  const storeB = await open();
  for (let round = 0; round < 3; round++) {
    const loaded = unwrap(await loadYOffline({key: 'doc', store: storeB}));
    // B shows what A holds...
    expect(loaded.epoch).toBe('E1');
    expect(plain(loaded.state).text.toString()).toBe(
      'synced, typed in tab A offline',
    );
    // ...and knows those edits are A's.
    expect(loaded.hasUnsyncedEdits).toBe(true);
    expect(loaded.unsyncedInLiveTabs).toBe(true);
    const b = plain(loaded.state);
    const sessionB = attachYOfflineSession({
      binding: b.binding,
      epoch: loaded.epoch,
      key: 'doc',
      loaded,
      offline: {persist: 'document', stage: 'persist', store: storeB},
      onError: () => {},
      stopSync: () => {},
    });
    const verdict = await sessionB.serverEpoch('E2');
    expect(verdict.kind).toBe('moved');
    expect(verdict.kind === 'moved' && verdict.capture).toBeNull();
  }
  expect(unwrap(await storeB.captures('doc'))).toEqual([]);

  // A reconnects: it captures its own edits, once.
  const moved = await sessionA.serverEpoch('E2');
  expect(moved.kind === 'moved' && moved.capture !== null).toBe(true);
  const captures = unwrap(await storeB.captures('doc'));
  expect(captures.length).toBe(1);
  expect(plain(captures[0].state).text.toString()).toBe(
    'synced, typed in tab A offline',
  );
});

test("a page that edits a live tab's document captures what it holds", async () => {
  const fake = createFakeIndexedDB();
  const store = unwrap(
    await openYOfflineStore({idb: fake.idb, locks: fake.locks}),
  );
  const a = plain(null);
  a.text.insert(0, 'A');
  const sessionA = attachYOfflineSession({
    binding: a.binding,
    epoch: 'E1',
    key: 'doc',
    loaded: null,
    offline: {persist: 'document', stage: 'persist', store},
    onError: () => {},
    stopSync: () => {},
  });
  unwrap(await sessionA.flush());
  const loaded = unwrap(await loadYOffline({key: 'doc', store}));
  expect(loaded.unsyncedInLiveTabs).toBe(true);
  const b = plain(loaded.state);
  const sessionB = attachYOfflineSession({
    binding: b.binding,
    epoch: loaded.epoch,
    key: 'doc',
    loaded,
    offline: {persist: 'document', stage: 'persist', store},
    onError: () => {},
    stopSync: () => {},
  });
  b.text.insert(b.text.length, ' and B');
  const verdict = await sessionB.serverEpoch('E2');
  expect(verdict.kind === 'moved' && verdict.capture !== null).toBe(true);
  expect(
    verdict.kind === 'moved' && plain(verdict.capture!.state).text.toString(),
  ).toBe('A and B');
  sessionA.dispose();
});

test('a live tab that closes before the page learns the epoch moved keeps its rows for recovery', async () => {
  const fake = createFakeIndexedDB();
  const open = async () =>
    unwrap(await openYOfflineStore({idb: fake.idb, locks: fake.locks}));
  const storeA = await open();
  const a = plain(null);
  a.text.insert(0, 'typed in tab A offline');
  const sessionA = attachYOfflineSession({
    binding: a.binding,
    epoch: 'E1',
    key: 'doc',
    loaded: null,
    offline: {persist: 'document', stage: 'persist', store: storeA},
    onError: () => {},
    stopSync: () => {},
  });
  unwrap(await sessionA.flush());
  const storeB = await open();
  const loaded = unwrap(await loadYOffline({key: 'doc', store: storeB}));
  expect(loaded.unsyncedInLiveTabs).toBe(true);
  const b = plain(loaded.state);
  const sessionB = attachYOfflineSession({
    binding: b.binding,
    epoch: loaded.epoch,
    key: 'doc',
    loaded,
    offline: {persist: 'document', stage: 'persist', store: storeB},
    onError: () => {},
    stopSync: () => {},
  });
  unwrap(await sessionB.flush());
  // A closes, then B learns the room moved.
  sessionA.dispose();
  storeA.close();
  await new Promise(resolve => setTimeout(resolve, 0));
  const verdict = await sessionB.serverEpoch('E2');
  expect(verdict.kind === 'moved' && verdict.capture).toBeNull();
  // B removed only its own rows: A's are there for the next recovery
  // (rows of a gone tab at another epoch become a capture).
  const left = unwrap(await storeB.slot('doc', 'E1').load({writers: 'gone'}));
  expect(left === null ? null : plain(left.state).text.toString()).toBe(
    'typed in tab A offline',
  );
  expect(left !== null && left.hasUnsyncedEdits).toBe(true);
  // What recovery does with them: one capture, A's edits.
  const captured = unwrap(
    await storeB.captureSlot!('doc', 'E1', stored => ({
      base: stored.base,
      capturedAt: 1,
      claimed: false,
      differs: false,
      epoch: 'E1',
      id: 'recovered',
      json: null,
      key: 'doc',
      reason: 'stale',
      state: stored.state,
      text: null,
    })),
  );
  expect(captured === null ? null : plain(captured.state).text.toString()).toBe(
    'typed in tab A offline',
  );
  expect(unwrap(await storeB.captures('doc')).length).toBe(1);
});

test("pages that sync beside a live tab replace each other's rows, never the tab's", async () => {
  const fake = createFakeIndexedDB();
  const open = async () =>
    unwrap(await openYOfflineStore({idb: fake.idb, locks: fake.locks}));
  const storeA = await open();
  const a = plain(null);
  a.text.insert(0, 'synced');
  const sessionA = attachYOfflineSession({
    binding: a.binding,
    epoch: 'E1',
    key: 'doc',
    loaded: null,
    offline: {persist: 'document', stage: 'persist', store: storeA},
    onError: () => {},
    stopSync: () => {},
  });
  a.text.insert(a.text.length, ', typed in tab A offline');
  unwrap(await sessionA.flush());
  const rows = () =>
    fake.records(Y_OFFLINE_DEFAULTS.databaseName, 'updates').length;
  const counts: number[] = [];
  for (let round = 0; round < 5; round++) {
    const store = await open();
    const loaded = unwrap(await loadYOffline({key: 'doc', store}));
    expect(loaded.unsyncedInLiveTabs).toBe(true);
    const b = plain(loaded.state);
    const session = attachYOfflineSession({
      binding: b.binding,
      epoch: loaded.epoch,
      key: 'doc',
      loaded,
      offline: {persist: 'document', stage: 'persist', store},
      onError: () => {},
      stopSync: () => {},
    });
    const verdict = await session.serverEpoch('E1');
    if (verdict.kind === 'same') {
      verdict.markSynced();
    }
    unwrap(await session.flush());
    session.dispose();
    store.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    counts.push(rows());
  }
  // One page's base at a time beside the tab's rows, not one per page.
  expect(new Set(counts.slice(1)).size).toBe(1);
  // The tab's edits are still the tab's.
  const left = unwrap(await storeA.slot('doc', 'E1').load());
  expect(plain(left!.state).text.toString()).toBe(
    'synced, typed in tab A offline',
  );
  sessionA.dispose();
});

test("a page whose epoch moved leaves the base row a live tab's rows build on", async () => {
  const fake = createFakeIndexedDB();
  const open = async () =>
    unwrap(await openYOfflineStore({idb: fake.idb, locks: fake.locks}));
  const attach = (
    binding: YOfflineBinding,
    store: Awaited<ReturnType<typeof open>>,
    loaded: Awaited<ReturnType<typeof loadYOffline>> extends YOfflineResult<
      infer L
    >
      ? L | null
      : never,
    compactAfter?: number,
  ) =>
    attachYOfflineSession({
      binding,
      compactAfter,
      epoch: loaded === null ? 'E1' : loaded.epoch,
      key: 'doc',
      loaded,
      offline: {persist: 'document', stage: 'persist', store},
      onError: () => {},
      stopSync: () => {},
    });
  // An earlier page synced (a base row) and left an unsynced edit; gone.
  const storeG = await open();
  const g = plain(null);
  g.text.insert(0, 'base');
  const sessionG = attach(g.binding, storeG, null);
  const same = await sessionG.serverEpoch('E1');
  if (same.kind === 'same') {
    same.markSynced();
  }
  g.text.insert(g.text.length, ' +G');
  unwrap(await sessionG.flush());
  sessionG.dispose();
  storeG.close();
  await new Promise(resolve => setTimeout(resolve, 0));
  // Tab A opens it and compacts: its rows are since rows on G's base row.
  const storeA = await open();
  const loadedA = unwrap(await loadYOffline({key: 'doc', store: storeA}));
  expect(loadedA.unsyncedInLiveTabs).toBe(false);
  const a = plain(loadedA.state);
  const sessionA = attach(a.binding, storeA, loadedA, 1);
  a.text.insert(a.text.length, ' +A');
  unwrap(await sessionA.flush());
  a.text.insert(a.text.length, '!');
  unwrap(await sessionA.flush());
  // Page B loads while A is open, makes no edit, and its epoch moves.
  const storeB = await open();
  const loadedB = unwrap(await loadYOffline({key: 'doc', store: storeB}));
  expect(loadedB.unsyncedInLiveTabs).toBe(true);
  const b = plain(loadedB.state);
  const sessionB = attach(b.binding, storeB, loadedB);
  const verdict = await sessionB.serverEpoch('E2');
  expect(verdict.kind === 'moved' && verdict.capture).toBeNull();
  // A closes offline: what recovery reads still has its base.
  sessionA.dispose();
  storeA.close();
  await new Promise(resolve => setTimeout(resolve, 0));
  const left = unwrap(await storeB.slot('doc', 'E1').load());
  expect(left).not.toBeNull();
  expect(left!.base === null ? null : plain(left!.base).text.toString()).toBe(
    'base',
  );
  expect(plain(left!.state).text.toString()).toBe('base +G +A!');
});

test("a page that closes beside a live tab, without dispose(), leaves no copy of the tab's edits to capture", async () => {
  const fake = createFakeIndexedDB();
  const open = async () =>
    unwrap(await openYOfflineStore({idb: fake.idb, locks: fake.locks}));
  const attach = (
    binding: YOfflineBinding,
    store: Awaited<ReturnType<typeof open>>,
    loaded: Parameters<typeof attachYOfflineSession>[0]['loaded'],
  ) =>
    attachYOfflineSession({
      binding,
      epoch: loaded === null ? 'E1' : loaded.epoch,
      key: 'doc',
      loaded,
      offline: {persist: 'document', stage: 'persist', store},
      onError: () => {},
      stopSync: () => {},
    });
  // Tab A at E1, offline with an edit, still open.
  const storeA = await open();
  const a = plain(null);
  const sessionA = attach(a.binding, storeA, null);
  a.text.insert(0, 'typed in tab A offline');
  unwrap(await sessionA.flush());
  // Page B opens it and closes, all offline, without dispose() (a closing
  // tab rarely runs it): its writer lock goes with the page.
  const storeB = await open();
  const loadedB = unwrap(await loadYOffline({key: 'doc', store: storeB}));
  expect(loadedB.unsyncedInLiveTabs).toBe(true);
  const sessionB = attach(plain(loadedB.state).binding, storeB, loadedB);
  unwrap(await sessionB.flush());
  loadedB.slot!.close();
  storeB.close();
  await new Promise(resolve => setTimeout(resolve, 0));
  // Page C opens it and meets the room's new epoch.
  const storeC = await open();
  const loadedC = unwrap(await loadYOffline({key: 'doc', store: storeC}));
  expect(loadedC.unsyncedInLiveTabs).toBe(true);
  const sessionC = attach(plain(loadedC.state).binding, storeC, loadedC);
  const verdict = await sessionC.serverEpoch('E2');
  expect(verdict.kind === 'moved' && verdict.capture).toBeNull();
  // A reconnects: one capture of its edits, its own.
  await sessionA.serverEpoch('E2');
  expect(unwrap(await storeC.captures('doc')).length).toBe(1);
});

test("a page's first own edit beside a live tab stores the whole document", async () => {
  const fake = createFakeIndexedDB();
  const open = async () =>
    unwrap(await openYOfflineStore({idb: fake.idb, locks: fake.locks}));
  const attach = (
    binding: YOfflineBinding,
    store: Awaited<ReturnType<typeof open>>,
    loaded: Parameters<typeof attachYOfflineSession>[0]['loaded'],
  ) =>
    attachYOfflineSession({
      binding,
      epoch: loaded === null ? 'E1' : loaded.epoch,
      key: 'doc',
      loaded,
      offline: {persist: 'document', stage: 'persist', store},
      onError: () => {},
      stopSync: () => {},
    });
  const storeA = await open();
  const a = plain(null);
  const sessionA = attach(a.binding, storeA, null);
  a.text.insert(0, 'A');
  unwrap(await sessionA.flush());
  const storeB = await open();
  const loadedB = unwrap(await loadYOffline({key: 'doc', store: storeB}));
  const b = plain(loadedB.state);
  const sessionB = attach(b.binding, storeB, loadedB);
  b.text.insert(b.text.length, ' and B');
  unwrap(await sessionB.flush());
  // One of B's rows, read alone, is the whole document: B's later rows
  // build on a row of its own, never on A's.
  const alone = fake
    .records(Y_OFFLINE_DEFAULTS.databaseName, 'updates')
    .map(r => plain((r.value as {u: Uint8Array}).u).text.toString());
  expect(alone).toContain('A and B');
  sessionA.dispose();
  sessionB.dispose();
});
