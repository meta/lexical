/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// D135, the offline store: a clear names what it deletes, and an error
// carries what its code needs to be acted on.
//
// Before: `store.clear(key, {captures})` without `epoch` deleted every slot
// of the key (every epoch's and every tab's unsynced edits), and the store's
// own message for unreadable captures prescribed exactly that call;
// `error.salvage` was optional on every code, so a `'corrupt'` handler was
// never told the readable rows existed, and a corrupt slot met by recovery
// (`captureSlot`) carried no salvage at all.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {createYDoc} from '../../..';
import {
  openYOfflineStore,
  Y_OFFLINE_DEFAULTS,
  type YOfflineCapture,
  type YOfflineError,
} from '../../../offline';
import {
  createFakeIndexedDB,
  type FakeIndexedDB,
} from '../../utils/fakeIndexedDB';
import {WITH_GC} from '../../utils/harness';
import {corruptSlotError, offlineError} from '../../utils/offlineErrors';

const DB = Y_OFFLINE_DEFAULTS.databaseName;

async function open(fake: FakeIndexedDB) {
  const opened = await openYOfflineStore({idb: fake.idb, locks: fake.locks});
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

function update(text: string): Uint8Array {
  const doc = createYDoc(null, {gc: WITH_GC});
  doc.get('t').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

const textOf = (state: Uint8Array) =>
  createYDoc(state, {gc: WITH_GC}).get('t').toString();

function capture(key: string, id: string): YOfflineCapture {
  return {
    base: null,
    capturedAt: 1,
    claimed: false,
    differs: false,
    epoch: 'e1',
    id,
    json: {root: {children: []}},
    key,
    reason: 'stale',
    state: update(id),
    text: id,
  };
}

describe('store.clear names what it deletes', () => {
  test('a call in the old shape (no slots) is refused, and deletes nothing', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    unwrap(await store.slot('doc', 'e1').append(update('one')));
    unwrap(await store.slot('doc', 'e2').append(update('two')));
    expect(() =>
      // @ts-expect-error -- `slots` is required: {epoch}, 'all' or 'none'.
      store.clear('doc', {captures: 'none'}),
    ).toThrow(/needs what\.slots .*'all' for every slot of the key/);
    expect(() =>
      // @ts-expect-error -- the old boolean shape.
      store.clear('doc', {captures: false, epoch: 'e1'}),
    ).toThrow(TypeError);
    expect(unwrap(await store.slots('doc')).map(s => s.epoch)).toEqual([
      'e2',
      'e1',
    ]);
  });

  test("captures 'unreadable' drops only what cannot be read; slots and readable captures stay", async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    unwrap(await store.slot('doc', 'e1').append(update('unsynced')));
    unwrap(await store.putCapture(capture('doc', 'good')));
    unwrap(await store.putCapture(capture('doc', 'bad')));
    const records = fake.records(DB, 'captures');
    const bad = records.find(r => (r.value as {id?: string}).id === 'bad')!;
    bad.value = 'damaged';

    const listed = await store.captures('doc');
    const error = offlineError(listed, 'corrupt');
    expect(error.where).toBe('captures');
    if (error.where !== 'captures') {
      return;
    }
    expect(error.unreadable).toBe(1);
    // The message names the call that keeps everything else.
    expect(error.message).toMatch(
      /store\.clear\(key, \{slots: 'none', captures: 'unreadable'\}\)/,
    );
    unwrap(await store.clear('doc', {captures: 'unreadable', slots: 'none'}));
    expect(unwrap(await store.captures('doc')).map(c => c.id)).toEqual([
      'good',
    ]);
    const stored = unwrap(await store.slot('doc', 'e1').load());
    expect(stored === null ? null : textOf(stored.state)).toBe('unsynced');
  });
});

describe('a typed error carries what its code needs', () => {
  test('a corrupt slot met by recovery carries the salvage, as load() does', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const slot = store.slot('doc', 'e1');
    unwrap(await slot.append(update('kept')));
    unwrap(await slot.append(update('lost')));
    slot.close();
    fake.records(DB, 'updates')[1].value = 'damaged';
    const again = await open(fake);
    const result = await again.captureSlot!('doc', 'e1', stored => ({
      ...capture('doc', 'c'),
      state: stored.state,
    }));
    const error = corruptSlotError(result);
    expect(error.epoch).toBe('e1');
    expect(error.salvage.unreadableRows).toBe(1);
    expect(error.salvage.readableRows).toBe(1);
    expect(textOf(error.salvage.state!)).toBe('kept');
    expect(error.message).toMatch(/error\.salvage\.state/);
    // Nothing was deleted: the rows wait for the app.
    expect(fake.records(DB, 'updates').length).toBe(2);
  });

  test("a corrupt slot's salvage holds every readable row the clear it names removes, a live tab's too", async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    // An earlier page (gone): one readable row, one that will be damaged.
    const gone = store.slot('doc', 'e1');
    unwrap(await gone.append(update('kept')));
    unwrap(await gone.append(update('damaged')));
    gone.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    // A tab still open writes at the same epoch.
    const live = store.slot('doc', 'e1');
    unwrap(await live.append(update('liveA')));
    const damaged = fake
      .records(DB, 'updates')
      .find(r => textOf((r.value as {u: Uint8Array}).u) === 'damaged')!;
    damaged.value = 'damaged';
    const result = await (
      await open(fake)
    ).captureSlot!('doc', 'e1', stored => ({
      ...capture('doc', 'c'),
      state: stored.state,
    }));
    const error = corruptSlotError(result);
    expect(error.salvage.readableRows).toBe(2);
    const offered = textOf(error.salvage.state!);
    expect(offered).toContain('kept');
    expect(offered).toContain('liveA');
    live.close();
  });

  test('fields are reachable only after narrowing on code', () => {
    const read = (error: YOfflineError) => {
      // @ts-expect-error -- salvage exists only on a corrupt slot.
      void error.salvage;
      // @ts-expect-error -- limit exists only on 'limit'.
      void error.limit;
      if (error.code === 'corrupt' && error.where === 'slot') {
        return error.salvage.state;
      }
      if (error.code === 'limit') {
        return error.limit;
      }
      return null;
    };
    expect(read({code: 'limit', limit: 'keys', message: ''})).toBe('keys');
  });
});
