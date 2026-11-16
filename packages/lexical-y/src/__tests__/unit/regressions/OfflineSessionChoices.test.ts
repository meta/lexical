/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// D135, the offline session: the choices that lose edits when left to a
// default or to the order of calls are made by the types.
//
// Before:
// - `session.markSynced()` could run on a document loaded from the store
//   before `serverEpoch()` confirmed the room's epoch: its unsynced edits
//   became the base, so when the room had moved the capture was null and
//   the rows were deleted. Now only a `'same'` verdict carries it.
// - a `'moved'` verdict could be ignored and the provider kept syncing the
//   frozen document into the room that replaced it. Now the session calls
//   the required `stopSync` itself.
// - `loaded` was optional (a document from the store attached without it
//   started with no base and nothing unsynced), `persistEdits: false`
//   silently kept unsynced edits in the tab alone, and `store: null` at a
//   stage that needs one was only a runtime throw.

import * as Y from '@y/y';
import {expect, test} from 'vitest';

import {
  attachYOfflineSession,
  loadYOffline,
  openYOfflineStore,
  type YOfflineBinding,
  type YOfflineResult,
  type YOfflineSessionOptions,
} from '../../../offline';
import {createFakeIndexedDB} from '../../utils/fakeIndexedDB';
import {WITH_GC} from '../../utils/harness';

function unwrap<T>(result: YOfflineResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

/** A plain document and a binding stand-in for it, logging its freeze. */
function plain(state: Uint8Array | null, calls: string[] = []) {
  const doc = new Y.Doc({gc: WITH_GC});
  if (state !== null) {
    Y.applyUpdate(doc, state);
  }
  const text = doc.get('t');
  const binding = {
    binding: {doc},
    freeze: () => {
      calls.push('freeze');
      return {
        differs: false,
        json: null,
        state: Y.encodeStateAsUpdate(doc),
        text: text.toString(),
      };
    },
    status: {kind: 'active'},
  } as unknown as YOfflineBinding;
  return {binding, doc, text};
}

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc({gc: WITH_GC});
  Y.applyUpdate(doc, state);
  return doc.get('t').toString();
};

test('markSynced exists only on a confirmed epoch, so unsynced edits of a replaced room are captured', async () => {
  const fake = createFakeIndexedDB();
  const store = unwrap(
    await openYOfflineStore({idb: fake.idb, locks: fake.locks}),
  );
  // An earlier page at e1 synced, then edited with no connection.
  const first = plain(null);
  first.text.insert(0, 'synced');
  const earlier = attachYOfflineSession({
    binding: first.binding,
    epoch: 'e1',
    key: 'doc',
    loaded: null,
    offline: {persist: 'document', stage: 'persist', store},
    onError: () => {},
    stopSync: () => {},
  });
  const verdict = await earlier.serverEpoch('e1');
  expect(verdict.kind).toBe('same');
  if (verdict.kind === 'same') {
    verdict.markSynced();
  }
  first.text.insert(first.text.length, ' and offline');
  unwrap(await earlier.flush());
  earlier.dispose();

  // This page opens it from the store, with no connection yet.
  const loaded = unwrap(await loadYOffline({key: 'doc', store}));
  expect(loaded.hasUnsyncedEdits).toBe(true);
  const tab = plain(loaded.state);
  const session = attachYOfflineSession({
    binding: tab.binding,
    epoch: loaded.epoch,
    key: 'doc',
    loaded,
    offline: {persist: 'document', stage: 'persist', store},
    onError: () => {},
    stopSync: () => {},
  });
  // The provider synced something: nothing can mark the document synced
  // before the session confirmed the room's epoch.
  // @ts-expect-error -- markSynced is a 'same' verdict's, not the session's.
  expect(() => session.markSynced()).toThrow(TypeError);
  // The room was replaced: the edits made offline are in the capture.
  const moved = await session.serverEpoch('e2');
  expect(moved.kind).toBe('moved');
  if (moved.kind !== 'moved') {
    return;
  }
  expect(moved.capture).not.toBeNull();
  expect(textOf(moved.capture!.state)).toBe('synced and offline');
  expect(textOf(moved.capture!.base!)).toBe('synced');
});

test('a moved epoch calls stopSync, right after the freeze and before the verdict resolves; a same one does not', async () => {
  const fake = createFakeIndexedDB();
  const store = unwrap(
    await openYOfflineStore({idb: fake.idb, locks: fake.locks}),
  );
  for (const move of ['serverEpoch', 'freeze'] as const) {
    const calls: string[] = [];
    const tab = plain(null, calls);
    const session = attachYOfflineSession({
      binding: tab.binding,
      epoch: 'e1',
      key: move,
      loaded: null,
      offline: {persist: 'document', stage: 'persist', store},
      onError: () => {},
      stopSync: () => calls.push('stopSync'),
    });
    expect((await session.serverEpoch('e1')).kind).toBe('same');
    expect(calls).toEqual([]);
    tab.text.insert(0, 'typed');
    const verdict =
      move === 'serverEpoch' ? session.serverEpoch('e2') : session.freeze();
    // Synchronously, before anything is stored.
    expect(calls).toEqual(['freeze', 'stopSync']);
    expect((await verdict).kind).toBe('moved');
    expect(calls).toEqual(['freeze', 'stopSync']);
  }
});

test('the options make every choice explicit (types)', () => {
  type Options = YOfflineSessionOptions;
  const base = {
    binding: null as unknown as YOfflineBinding,
    epoch: null,
    key: 'doc',
    onError: () => {},
    stopSync: () => {},
  };
  const ok: Options = {...base, loaded: null, offline: {stage: 'off'}};
  // @ts-expect-error -- loaded is required: the load, or null.
  const noLoaded: Options = {...base, offline: {stage: 'off'}};
  const noStore: Options = {
    ...base,
    loaded: null,
    // @ts-expect-error -- a stage that stores needs the store.
    offline: {persist: 'document', stage: 'persist'},
  };
  const noPersist: Options = {
    ...base,
    loaded: null,
    // @ts-expect-error -- and says what it keeps.
    offline: {stage: 'replay', store: null as never},
  };
  const old: Options = {
    ...base,
    loaded: null,
    offline: {stage: 'off'},
    // @ts-expect-error -- persistEdits is gone: offline.persist says it.
    persistEdits: false,
  };
  // @ts-expect-error -- stopSync is required.
  const noStop: Options = {
    binding: base.binding,
    epoch: null,
    key: 'doc',
    loaded: null,
    offline: {stage: 'off'},
    onError: () => {},
  };
  expect([ok, noLoaded, noStore, noPersist, old, noStop].length).toBe(6);
});
