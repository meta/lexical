/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @lexical/y/offline against the browser's own IndexedDB (the unit tests
// use an in-repo fake): rows survive a closed and reopened connection,
// compaction, confirm, discard and adopt keep the document, two
// connections on one key keep each other's rows, a capture is claimed once
// across connections, damage reads as 'corrupt' with salvage, a request
// callback that throws is reported with its cause, the limits refuse
// without evicting, another connection's upgrade closes the store, and a
// session persists an editor's edits across a reload and captures them on
// a moved epoch. A full quota is not reached here: Playwright's contexts
// are ephemeral, and Chromium's DevTools quota override did not make an
// IndexedDB write fail in one; the unit tests' fake covers 'quota'.

import {
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $setState,
  defineExtension,
} from 'lexical';
import {afterEach, describe, expect, onTestFinished, test} from 'vitest';

import {createYDoc, yCollab, YCollabExtension} from '../..';
import {seedYState} from '../../headless';
import {
  attachYOfflineSession,
  loadYOffline,
  openYOfflineStore,
  recoverYOfflineEdits,
  type YOfflineCapture,
  type YOfflineResult,
  type YOfflineStore,
  type YOfflineStoreOptions,
} from '../../offline';
import {catalogAppExtension, catalogHeadlessConfig} from '../catalog/bind';

const idb = {
  IDBKeyRange: globalThis.IDBKeyRange,
  indexedDB: globalThis.indexedDB,
};

let names = 0;
const opened: YOfflineStore[] = [];
const databases: string[] = [];

afterEach(async () => {
  for (const store of opened.splice(0)) {
    store.close();
  }
  for (const name of databases.splice(0)) {
    await new Promise(resolve => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = resolve;
    });
  }
});

function unwrap<T>(result: YOfflineResult<T>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** A fresh database name for the test. */
function newDatabase(): string {
  const name = `lexical-y-offline-test-${Date.now()}-${names++}`;
  databases.push(name);
  return name;
}

async function open(
  databaseName: string,
  options: Partial<YOfflineStoreOptions> = {},
): Promise<YOfflineStore> {
  const store = unwrap(
    await openYOfflineStore({databaseName, idb, ...options}),
  );
  opened.push(store);
  return store;
}

function typing() {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  const text = doc.get('t');
  return {
    doc,
    type: (value: string) => text.insert(text.length, value),
    updates,
  };
}

const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.get('t').toString();
};

/** The raw database, to read or damage rows as another program would. */
function raw(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function rawPut(db: IDBDatabase, key: IDBValidKey, value: unknown) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('updates', 'readwrite');
    tx.objectStore('updates').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function capture(key: string, id: string, state: Uint8Array): YOfflineCapture {
  return {
    base: null,
    capturedAt: 1,
    claimed: false,
    differs: false,
    epoch: 'e1',
    id,
    json: null,
    key,
    reason: 'stale',
    state,
    text: null,
  };
}

describe('the store on a real IndexedDB', () => {
  test('rows survive a closed connection, and compaction, confirm, discard and adopt keep the document', async () => {
    const name = newDatabase();
    const {doc, type, updates} = typing();
    let store = await open(name);
    let slot = store.slot('doc', null);
    for (const value of ['a', 'b', 'c']) {
      type(value);
      unwrap(await slot.append(updates[updates.length - 1]));
    }
    store.close();
    store = await open(name);
    slot = store.slot('doc', null);
    const loaded = unwrap(await slot.load())!;
    // A value read back from IndexedDB is a Uint8Array of this realm or
    // another: the store accepts either.
    expect(Object.prototype.toString.call(loaded.state)).toBe(
      '[object Uint8Array]',
    );
    expect(textOf(loaded.state)).toBe('abc');
    expect(loaded.hasUnsyncedEdits).toBe(true);
    unwrap(await slot.adopt('e1'));
    expect(unwrap(await store.slots('doc')).map(info => info.epoch)).toEqual([
      'e1',
    ]);
    unwrap(await slot.compact());
    unwrap(await slot.confirm(Y.encodeStateAsUpdate(doc)));
    type('d');
    unwrap(await slot.append(updates[updates.length - 1]));
    const after = unwrap(await store.slot('doc', 'e1').load())!;
    expect(textOf(after.state)).toBe('abcd');
    expect(textOf(after.base!)).toBe('abc');
    unwrap(await slot.discard());
    expect(unwrap(await store.slots('doc'))).toEqual([]);
  });

  test("two connections on one key keep each other's rows, and a capture is claimed once", async () => {
    const name = newDatabase();
    const a = await open(name);
    const b = await open(name);
    const one = typing();
    const two = typing();
    one.type('one');
    two.type('two');
    const slotA = a.slot('doc', 'e1');
    const slotB = b.slot('doc', 'e1');
    await Promise.all([
      slotA.append(one.updates[0]).then(unwrap),
      slotB.append(two.updates[0]).then(unwrap),
    ]);
    unwrap(await slotA.confirm(Y.encodeStateAsUpdate(one.doc)));
    const both = new Y.Doc();
    Y.applyUpdate(both, unwrap(await a.slot('doc', 'e1').load())!.state);
    expect(both.get('t').toString()).toMatch(/one|two/);
    expect(both.get('t').toString().length).toBe(6);
    unwrap(await a.putCapture(capture('doc', 'c1', one.updates[0])));
    const claims = await Promise.all([
      a.claimCapture('doc', 'c1'),
      b.claimCapture('doc', 'c1'),
    ]);
    expect(claims.map(unwrap).sort()).toEqual([false, true]);
  });

  test("a damaged row reads as 'corrupt', with the readable rows as salvage", async () => {
    const name = newDatabase();
    const store = await open(name);
    const {type, updates} = typing();
    type('kept');
    unwrap(await store.slot('doc', 'e1').append(updates[0]));
    const db = await raw(name);
    await rawPut(db, ['doc', 'e1', 's', 'zz', 0], {
      h: 1,
      t: 1,
      u: new Uint8Array([1, 2, 3]),
      v: 1,
    });
    db.close();
    const loaded = await store.slot('doc', 'e1').load();
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('corrupt');
      expect(loaded.error.salvage!.unreadableRows).toBe(1);
      expect(textOf(loaded.error.salvage!.state!)).toBe('kept');
    }
  });

  test('a request callback that throws is reported with its cause, and the rows stay', async () => {
    const name = newDatabase();
    const store = await open(name);
    const slot = store.slot('doc', 'e1');
    const {type, updates} = typing();
    type('x');
    unwrap(await slot.append(updates[0]));
    // Passes its checksum, but is no update: the compaction's merge throws.
    unwrap(await slot.append(new Uint8Array([200, 1, 2, 3])));
    const windowErrors: unknown[] = [];
    const onError = (event: ErrorEvent) => windowErrors.push(event.error);
    window.addEventListener('error', onError);
    onTestFinished(() => window.removeEventListener('error', onError));
    const compacted = await slot.compact();
    expect(compacted.ok).toBe(false);
    if (!compacted.ok) {
      expect(compacted.error.code).toBe('failed');
      expect(String(compacted.error.cause)).not.toMatch(/AbortError/);
    }
    expect(windowErrors).toEqual([]);
    expect(unwrap(await store.slots('doc'))[0].rows).toBe(2);
  });

  test('limits refuse a new key and a key past its bytes, evicting nothing', async () => {
    const name = newDatabase();
    const store = await open(name, {
      limits: {bytesPerKey: 2000, group: key => key.split('|')[0], keys: 1},
    });
    const {type, updates} = typing();
    type('x');
    unwrap(await store.slot('alice|1', 'e1').append(updates[0]));
    const refused = await store.slot('alice|2', 'e1').append(updates[0]);
    expect(!refused.ok && refused.error.limit).toBe('keys');
    unwrap(await store.slot('bob|1', 'e1').append(updates[0]));
    const big = await store
      .slot('alice|1', 'e1')
      .append(new Uint8Array(3000).fill(7));
    expect(!big.ok && big.error.limit).toBe('bytes');
    expect(unwrap(await store.keys())).toEqual(['alice|1', 'bob|1']);
  });

  test("another connection's upgrade closes the store: it answers 'closed', and the upgrade is not blocked", async () => {
    const name = newDatabase();
    const store = await open(name);
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('blocked'));
    });
    upgraded.close();
    const after = await store.slot('doc', 'e1').load();
    expect(!after.ok && after.error.code).toBe('closed');
  });
});

describe('a session on a real IndexedDB', () => {
  const IDS = {blockIds: 'enabled'} as const;
  const config = catalogHeadlessConfig(IDS, {onWarn: () => {}});

  function tab(state: Uint8Array | null) {
    const doc = createYDoc(state);
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          catalogAppExtension(IDS),
          yCollab({doc, onStatus: () => {}, schemaVersion: 1, synced: true}),
        ],
        name: 'offline-browser-test',
        onError: error => {
          throw error;
        },
        onWarn: () => {},
      }),
    );
    onTestFinished(() => editor.dispose());
    const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
      .output.collab;
    return {
      binding,
      blocks: () =>
        editor.read(() =>
          $getRoot()
            .getChildren()
            .map(node => [
              $getState(node, blockIdState),
              node.getTextContent(),
            ]),
        ),
      edit: (id: string, value: string) =>
        editor.update(
          () => {
            const node = $getRoot()
              .getChildren()
              .find(child => $getState(child, blockIdState) === id)!;
            const paragraph = $createParagraphNode().append(
              $createTextNode(value),
            );
            $setState(paragraph, blockIdState, id);
            node.replace(paragraph);
          },
          {discrete: true},
        ),
    };
  }

  const seed = () =>
    seedYState(config, () => {
      for (const [value, id] of [
        ['one', 'b1'],
        ['two', 'b2'],
      ]) {
        const paragraph = $createParagraphNode().append($createTextNode(value));
        $setState(paragraph, blockIdState, id);
        $getRoot().append(paragraph);
      }
    });

  test("with the browser's Web Locks, a tab whose epoch moved leaves a live tab's rows", async () => {
    const name = newDatabase();
    const store = await open(name);
    const state = seed();
    const writer = tab(state);
    const b = attachYOfflineSession({
      binding: writer.binding,
      epoch: 'e1',
      key: 'doc',
      onError: error => {
        throw new Error(error.message);
      },
      stage: 'persist',
      store,
    });
    b.markSynced();
    writer.edit('b1', 'B, first');
    unwrap(await b.flush());
    // Another tab loads B's rows, then its epoch moves.
    const other = await open(name);
    const loaded = unwrap(await loadYOffline({key: 'doc', store: other}));
    const reader = tab(loaded.state);
    const a = attachYOfflineSession({
      binding: reader.binding,
      epoch: loaded.epoch,
      key: 'doc',
      loaded,
      onError: error => {
        throw new Error(error.message);
      },
      stage: 'persist',
      store: other,
    });
    unwrap(await a.flush());
    expect((await a.serverEpoch('e2')).kind).toBe('moved');
    // B is live: it edits again, then closes.
    writer.edit('b1', 'B, second');
    unwrap(await b.flush());
    b.dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
    const remaining = unwrap(await store.slot('doc', 'e1').load())!;
    expect(tab(remaining.state).blocks()[0]).toEqual(['b1', 'B, second']);
  });

  test('edits persist across a reload, and a moved epoch captures them for recovery', async () => {
    const name = newDatabase();
    const state = seed();
    const first = tab(state);
    let store = await open(name);
    const session = attachYOfflineSession({
      binding: first.binding,
      epoch: 'e1',
      key: 'doc',
      onError: error => {
        throw new Error(error.message);
      },
      stage: 'replay',
      store,
    });
    expect(await session.serverEpoch('e1')).toEqual({kind: 'same'});
    session.markSynced();
    first.edit('b1', 'one, offline');
    unwrap(await session.flush());
    session.dispose();
    store.close();

    // The page reloads with no connection.
    store = await open(name);
    const loaded = unwrap(await loadYOffline({key: 'doc', store}));
    expect(loaded.epoch).toBe('e1');
    const second = tab(loaded.state);
    expect(second.blocks()).toEqual([
      ['b1', 'one, offline'],
      ['b2', 'two'],
    ]);
    const again = attachYOfflineSession({
      binding: second.binding,
      epoch: loaded.epoch,
      key: 'doc',
      loaded,
      onError: error => {
        throw new Error(error.message);
      },
      stage: 'replay',
      store,
    });
    // The room was replaced while the page was away.
    const verdict = await again.serverEpoch('e2');
    expect(verdict.kind).toBe('moved');
    expect(verdict.kind === 'moved' && verdict.saved.ok).toBe(true);
    const fresh = tab(state);
    const recovered = unwrap(
      await recoverYOfflineEdits({
        binding: fresh.binding,
        config,
        epoch: 'e2',
        key: 'doc',
        stage: 'replay',
        store,
      }),
    );
    expect(recovered.length).toBe(1);
    expect(recovered[0].replay!.applied).toEqual(['b1']);
    expect(fresh.blocks()).toEqual([
      ['b1', 'one, offline'],
      ['b2', 'two'],
    ]);
  });
});
