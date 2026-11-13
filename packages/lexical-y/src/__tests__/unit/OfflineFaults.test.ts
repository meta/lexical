/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Faults injected between two specific transactions of @lexical/y/offline,
// for the fixes its review made that no end-to-end test reaches: a
// compaction while a confirmation is queued, a merge that throws in the
// write queue, a capture the store refuses after the freeze committed more,
// and a request callback that throws inside a transaction. Each test fails
// on the code before its fix. The session runs over a plain document and a
// stand-in binding (the session reads `binding.binding.doc` and calls
// `freeze()`, nothing else here). Run with gc off and on (LEXICAL_Y_GC=1).

import * as Y from '@y/y';
import {describe, expect, test, vi} from 'vitest';

import {type YCollabBinding} from '../..';
import {
  attachYOfflineSession,
  openYOfflineStore,
  Y_OFFLINE_DEFAULTS,
  type YOfflineError,
  type YOfflineResult,
  type YOfflineSlot,
  type YOfflineStore,
} from '../../offline';
import {createFakeIndexedDB, type FakeIndexedDB} from '../utils/fakeIndexedDB';
import {WITH_GC} from '../utils/harness';

// `mergeUpdates` with a switch that makes its next call throw.
const faults = vi.hoisted(() => ({failNextMerge: false}));
vi.mock('@y/y', async importOriginal => {
  const actual = await importOriginal<typeof import('@y/y')>();
  return {
    ...actual,
    mergeUpdates: (...args: Parameters<typeof actual.mergeUpdates>) => {
      if (faults.failNextMerge) {
        faults.failNextMerge = false;
        throw new Error('injected: mergeUpdates threw');
      }
      return actual.mergeUpdates(...args);
    },
  };
});

const DB = Y_OFFLINE_DEFAULTS.databaseName;

function unwrap<T>(result: YOfflineResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

/** A document and a binding stand-in whose freeze() commits `onFreeze`. */
function tab(onFreeze: (text: ReturnType<Y.Doc['get']>) => void = () => {}) {
  const doc = new Y.Doc({gc: WITH_GC});
  const text = doc.get('t');
  const binding = {
    binding: {doc, editor: null, undoManager: null},
    freeze: () => {
      // The editor's last update, committed by the freeze.
      doc.transact(() => onFreeze(text));
      return {
        differs: false,
        json: null,
        state: Y.encodeStateAsUpdate(doc),
        text: text.toString(),
      };
    },
    status: {kind: 'active'},
  } as unknown as YCollabBinding;
  const type = (value: string) =>
    doc.transact(() => text.insert(text.length, value));
  return {binding, doc, text, type};
}

/** What a fresh document made from the stored slot reads. */
async function storedText(
  store: YOfflineStore,
  epoch: string,
): Promise<string> {
  const stored = unwrap(await store.slot('doc', epoch).load());
  const doc = new Y.Doc({gc: WITH_GC});
  if (stored !== null) {
    Y.applyUpdate(doc, stored.state);
  }
  return doc.get('t').toString();
}

/** `store`, with some of its slot or capture calls replaced. */
function withFaults(
  store: YOfflineStore,
  slotFaults: Partial<Pick<YOfflineSlot, 'confirm' | 'moveIntoCapture'>>,
  storeFaults: Partial<Pick<YOfflineStore, 'putCapture'>> = {},
): YOfflineStore {
  return {
    ...store,
    captures: key => store.captures(key),
    claimCapture: (key, id) => store.claimCapture(key, id),
    clear: (key, what) => store.clear(key, what),
    close: () => store.close(),
    deleteCapture: (key, id) => store.deleteCapture(key, id),
    keys: () => store.keys(),
    putCapture: storeFaults.putCapture ?? (c => store.putCapture(c)),
    slot: (key, epoch) => {
      const slot = store.slot(key, epoch);
      return new Proxy(slot, {
        get(target, name, receiver) {
          if (name === 'confirm' && slotFaults.confirm !== undefined) {
            return slotFaults.confirm;
          }
          if (
            name === 'moveIntoCapture' &&
            slotFaults.moveIntoCapture !== undefined
          ) {
            return slotFaults.moveIntoCapture;
          }
          const value = Reflect.get(target, name, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    slots: key => store.slots(key),
  };
}

const quota: YOfflineError = {
  code: 'quota',
  message: 'injected: quota',
};

async function open(fake: FakeIndexedDB): Promise<YOfflineStore> {
  return unwrap(await openYOfflineStore({idb: fake.idb, locks: fake.locks}));
}

describe('faults between transactions', () => {
  test('a compaction while a confirmation is queued is not a diff against the unstored base', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const {binding, type} = tab();
    type('base. ');
    let failConfirm = false;
    const faulty = withFaults(store, {
      confirm: function (this: YOfflineSlot, state: Uint8Array) {
        return failConfirm
          ? Promise.resolve({error: quota, ok: false} as const)
          : store.slot('doc', 'e1').confirm.call(this, state);
      },
    });
    const errors: YOfflineError[] = [];
    const session = attachYOfflineSession({
      binding,
      compactAfter: 1,
      epoch: 'e1',
      key: 'doc',
      onError: error => errors.push(error),
      stage: 'persist',
      store: faulty,
    });
    unwrap(await session.flush());
    // A base is stored.
    session.markSynced();
    unwrap(await session.flush());
    // An edit, whose append is in flight when the provider reports a sync;
    // that confirmation fails, after the append's compaction ran.
    type('edit.');
    failConfirm = true;
    session.markSynced();
    await session.flush();
    await ticks();
    expect(errors.map(error => error.code)).toContain('quota');
    // The edit is in the stored rows: the compaction diffed against the
    // base that is stored, not the one that was still queued.
    expect(await storedText(store, 'e1')).toBe('base. edit.');
    session.dispose();
  });

  test('a merge that throws in the write queue is reported, and nothing it held is lost', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const {binding, type} = tab();
    const errors: YOfflineError[] = [];
    const session = attachYOfflineSession({
      binding,
      epoch: 'e1',
      key: 'doc',
      onError: error => errors.push(error),
      stage: 'persist',
      store,
    });
    // The first update's append is in flight; the next two queue behind it
    // and are merged into one row, which throws once.
    type('a');
    type('b');
    type('c');
    faults.failNextMerge = true;
    await ticks();
    expect(faults.failNextMerge).toBe(false);
    expect(errors.map(error => error.code)).toEqual(['failed']);
    expect(session.persisted).toBe(false);
    // The queue is not rejected for good: the next update stores what was
    // held, and flush() resolves.
    type('d');
    expect(unwrap(await session.flush())).toBeUndefined();
    expect(session.persisted).toBe(true);
    expect(await storedText(store, 'e1')).toBe('abcd');
    session.dispose();
  });

  test('when the store refuses the capture, what the freeze committed is stored before serverEpoch returns', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const {binding, type} = tab(text => text.insert(text.length, ' (held)'));
    const refuse = () => Promise.resolve({error: quota, ok: false} as const);
    const faulty = withFaults(
      store,
      {moveIntoCapture: refuse},
      {putCapture: refuse},
    );
    const errors: YOfflineError[] = [];
    const session = attachYOfflineSession({
      binding,
      epoch: 'e1',
      key: 'doc',
      onError: error => errors.push(error),
      stage: 'persist',
      store: faulty,
    });
    type('typed');
    unwrap(await session.flush());
    const verdict = await session.serverEpoch('e2');
    expect(verdict.kind).toBe('moved');
    if (verdict.kind === 'moved') {
      expect(verdict.saved.ok).toBe(false);
      expect(verdict.capture).not.toBeNull();
    }
    // Committed rows, read at once (the page may close on 'moved'): the
    // slot holds what the freeze committed, for the next page to capture.
    const rows = fake.records(DB, 'updates').map(record => record.value);
    const doc = new Y.Doc({gc: WITH_GC});
    for (const row of rows) {
      Y.applyUpdate(doc, (row as {u: Uint8Array}).u);
    }
    expect(doc.get('t').toString()).toBe('typed (held)');
    expect(errors.map(error => error.code)).toEqual(['quota']);
  });

  test('a request callback that throws aborts its transaction with an error, and leaves the rows', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const slot = store.slot('doc', 'e1');
    const doc = new Y.Doc({gc: WITH_GC});
    doc.get('t').insert(0, 'x');
    unwrap(await slot.append(Y.encodeStateAsUpdate(doc)));
    // A row that passes its checksum but is no update: merging it, inside
    // the compaction's read callback, throws.
    unwrap(await slot.append(new Uint8Array([200, 1, 2, 3])));
    const before = fake.records(DB, 'updates').map(r => ({...r}));
    const compacted = await slot.compact();
    expect(compacted.ok).toBe(false);
    if (!compacted.ok) {
      expect(compacted.error.code).toBe('failed');
      // The error names what threw, not the abort it caused, and nothing
      // reached the window.
      expect(String(compacted.error.cause)).not.toMatch(/AbortError/);
      expect(compacted.error.message).not.toMatch(/AbortError/);
    }
    expect(fake.uncaught()).toEqual([]);
    expect(fake.records(DB, 'updates')).toEqual(before);
  });
});
