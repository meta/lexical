/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Regressions from the independent review of meta/lexical#9899
// (@lexical/y/offline), each an edit that was neither on the server, in a
// stored slot, nor in a capture, or a limit counted wrong:
//
// 1. keep 'unsynced': a sync and a new local edit while the first write
//    since the previous sync was in flight; its end cleared the new start,
//    and the clearing then removed every row (the edit after the sync was
//    stored nowhere);
// 2. a second recovery deleted a capture whose blocks the document held
//    only because this page had reapplied them, before the server had them;
// 3. a tab whose epoch moved removed a base row another live tab's rows
//    were built on;
// 4. a tab that adopted an epoch moved a live tab's rows with its own, so
//    that tab's later rows were split from the ones they build on;
// 5. putting a capture again under its id counted its old bytes too;
// 6. (the automated review) a replay with the caret inside a block it
//    replaced threw (the selection stayed on removed nodes), and in a
//    recovery the capture stayed claimed, so it was never replayed again;
// 7. (the same) a replay whose editor update failed under an onError that
//    does not throw kept the capture claimed;
// 8. (the same) recovery captured a live tab's rows at an older epoch on
//    every call;
// 9. (the same) a document loaded with nothing unsynced was stored again
//    as unsynced;
// 10. (the review of e81ad88c0) two tabs recovering the same stale slot at
//    once made two captures, and each replayed one (the block twice);
// 11. (the same) a moved epoch's capture was checked against bytesPerKey
//    with the rows it replaces still counted, so a key needed room for
//    three documents;
// 12. (the same) a corrupt slot at another epoch failed recovery with no
//    epoch to clear.
//
// Run with gc off and on (LEXICAL_Y_GC=1).

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
  $getSelection,
  $setState,
  defineExtension,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {createYDoc, yCollab, YCollabExtension} from '../../..';
import {seedYState} from '../../../headless';
import {
  attachYOfflineSession,
  loadYOffline,
  openYOfflineStore,
  recoverYOfflineEdits,
  type YOfflineBinding,
  type YOfflineCapture,
  type YOfflineError,
  type YOfflineResult,
  type YOfflineSessionOptions,
  type YOfflineStore,
} from '../../../offline';
import {catalogAppExtension, catalogHeadlessConfig} from '../../catalog/bind';
import {createFakeIndexedDB} from '../../utils/fakeIndexedDB';
import {WITH_GC} from '../../utils/harness';

const IDS = {blockIds: 'enabled'} as const;
const config = catalogHeadlessConfig(IDS, {onWarn: () => {}});

const live: {dispose(): void}[] = [];
afterEach(() => {
  for (const item of live.splice(0)) {
    item.dispose();
  }
});

function unwrap<T>(result: YOfflineResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

async function open() {
  const fake = createFakeIndexedDB();
  const store = unwrap(
    await openYOfflineStore({idb: fake.idb, locks: fake.locks}),
  );
  return {fake, store};
}

const textOf = (state: Uint8Array | null) => {
  const doc = new Y.Doc({gc: WITH_GC});
  if (state !== null) {
    Y.applyUpdate(doc, state);
  }
  return doc.get('t').toString();
};

/** A plain document and a binding stand-in for it. */
function plain() {
  const doc = new Y.Doc({gc: WITH_GC});
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

const seed = (blocks: [string, string][] = [['one', 'b1']]) =>
  seedYState(config, () => {
    for (const [value, id] of blocks) {
      const paragraph = $createParagraphNode().append($createTextNode(value));
      $setState(paragraph, blockIdState, id);
      $getRoot().append(paragraph);
    }
  });

function client(state: Uint8Array | null) {
  const doc = createYDoc(state, {gc: WITH_GC});
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        catalogAppExtension(IDS),
        yCollab({doc, onStatus: () => {}, schemaVersion: 1, synced: true}),
      ],
      name: 'offline-review-regressions',
      onError: error => {
        throw error;
      },
      onWarn: () => {},
    }),
  );
  live.push(editor);
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.collab;
  return {
    binding,
    doc,
    edit: (value: string) =>
      editor.update(
        () => {
          (
            (
              $getRoot().getFirstChildOrThrow() as ElementNode
            ).getFirstChildOrThrow() as TextNode
          ).setTextContent(value);
        },
        {discrete: true},
      ),
    editor,
    text: () => editor.read(() => $getRoot().getTextContent()),
  };
}

function session(
  binding: YOfflineBinding,
  store: YOfflineStore,
  options: Partial<YOfflineSessionOptions> = {},
) {
  const errors: YOfflineError[] = [];
  const s = attachYOfflineSession({
    binding,
    epoch: 'e1',
    key: 'doc',
    onError: error => errors.push(error),
    stage: 'persist',
    store,
    ...options,
  });
  live.push(s);
  return {errors, s};
}

test("1. keep 'unsynced': an edit after a sync that lands while the previous write is in flight is stored", async () => {
  const {store} = await open();
  const c = plain();
  c.text.insert(0, 'base');
  // Holds the next append until released.
  let hold = false;
  let entered = () => {};
  const inFlight = new Promise<void>(resolve => (entered = resolve));
  let release = () => {};
  const released = new Promise<void>(resolve => (release = resolve));
  const held = new Proxy(store, {
    get(target, name) {
      if (name === 'slot') {
        return (key: string, epoch: string | null) => {
          const slot = target.slot(key, epoch);
          return new Proxy(slot, {
            get(s, n) {
              if (n === 'append') {
                return async (update: Uint8Array) => {
                  if (hold) {
                    hold = false;
                    entered();
                    await released;
                  }
                  return s.append(update);
                };
              }
              const value = Reflect.get(s, n);
              return typeof value === 'function' ? value.bind(s) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const {errors, s} = session(c.binding, held, {keep: 'unsynced'});
  s.markSynced();
  unwrap(await s.flush());
  hold = true;
  c.text.insert(c.text.length, ' A');
  await inFlight;
  // A reached the server while its append was in flight; B did not.
  s.markSynced();
  c.text.insert(c.text.length, ' B');
  release();
  unwrap(await s.flush());
  const loaded = unwrap(await loadYOffline({key: 'doc', store}));
  expect(textOf(loaded.state)).toBe('base A B');
  expect(s.hasUnsyncedEdits).toBe(true);
  expect(errors).toEqual([]);
});

test('2. a capture whose blocks only this page reapplied stays until the server holds them', async () => {
  const {store} = await open();
  const initial = seed();
  const stale = client(initial);
  const old = session(stale.binding, store);
  old.s.markSynced();
  stale.edit('mine');
  unwrap(await old.s.flush());
  await old.s.serverEpoch('e2');
  const fresh = client(initial);
  const now = session(fresh.binding, store, {
    epoch: 'e2',
    persistEdits: false,
  });
  now.s.markSynced();
  const recover = () =>
    recoverYOfflineEdits({
      binding: fresh.binding,
      config,
      epoch: 'e2',
      key: 'doc',
      session: now.s,
      stage: 'replay',
      store,
    });
  expect(unwrap(await recover())[0].replay!.applied).toEqual(['b1']);
  // A second call before any sync: the replay is in this page only.
  await recover();
  expect(unwrap(await store.captures('doc')).length).toBe(1);
  expect(fresh.text()).toBe('mine');
});

test("3. a tab whose epoch moved leaves a live tab's rows and the rows they build on", async () => {
  const {store} = await open();
  const initial = seed();
  const first = client(initial);
  const a = session(first.binding, store);
  a.s.markSynced();
  unwrap(await a.s.flush());
  // Another tab loads what A stored, and edits offline.
  const loaded = unwrap(await loadYOffline({key: 'doc', store}));
  const second = client(loaded.state);
  const b = session(second.binding, store, {loaded});
  second.edit('mine from B');
  unwrap(await b.s.flush());
  // A never held B's edit: its epoch moves with nothing to capture.
  const verdict = await a.s.serverEpoch('e2');
  expect(verdict.kind === 'moved' && verdict.capture).toBeNull();
  // B closes.
  b.s.dispose();
  await new Promise(resolve => setTimeout(resolve, 0));
  const remaining = unwrap(await loadYOffline({key: 'doc', store}));
  expect(client(remaining.state).text()).toBe('mine from B');
});

test("4. adopting an epoch leaves a live tab's rows for that tab to move", async () => {
  const {store} = await open();
  const initial = seed();
  const a = client(initial);
  const b = client(initial);
  const sa = session(a.binding, store, {epoch: null});
  const sb = session(b.binding, store, {epoch: null});
  unwrap(await sa.s.flush());
  unwrap(await sb.s.flush());
  await sa.s.serverEpoch('e1');
  b.edit('B typed after A adopted');
  unwrap(await sb.s.flush());
  await sb.s.serverEpoch('e2');
  const stored = unwrap(await store.slot('doc', 'e2').load())!;
  expect(client(stored.state).text()).toBe('B typed after A adopted');
  expect(sb.errors).toEqual([]);
});

test("3b. a tab that loaded a live tab's rows leaves them when its epoch moves", async () => {
  const {store} = await open();
  const initial = seed();
  const writer = client(initial);
  const b = session(writer.binding, store);
  b.s.markSynced();
  writer.edit('B, first');
  unwrap(await b.s.flush());
  // A loads B's rows (and so holds B's edit), then its epoch moves.
  const loaded = unwrap(await loadYOffline({key: 'doc', store}));
  const reader = client(loaded.state);
  const a = session(reader.binding, store, {loaded});
  unwrap(await a.s.flush());
  const verdict = await a.s.serverEpoch('e2');
  expect(verdict.kind).toBe('moved');
  // B, still at e1 and live, edits again, then closes.
  writer.edit('B, second');
  unwrap(await b.s.flush());
  b.s.dispose();
  await new Promise(resolve => setTimeout(resolve, 0));
  const remaining = unwrap(await store.slot('doc', 'e1').load())!;
  expect(client(remaining.state).text()).toBe('B, second');
});

test("4b. a tab that loaded a live tab's never-synced rows moves only its own when it adopts", async () => {
  const {store} = await open();
  const initial = seed();
  const writer = client(initial);
  const b = session(writer.binding, store, {epoch: null});
  writer.edit('B, offline');
  unwrap(await b.s.flush());
  const loaded = unwrap(await loadYOffline({key: 'doc', store}));
  const reader = client(loaded.state);
  const a = session(reader.binding, store, {epoch: null, loaded});
  unwrap(await a.s.flush());
  await a.s.serverEpoch('e1');
  writer.edit('B, still offline');
  unwrap(await b.s.flush());
  await b.s.serverEpoch('e2');
  const stored = unwrap(await store.slot('doc', 'e2').load())!;
  expect(client(stored.state).text()).toBe('B, still offline');
});

test('5. a capture put again under its id counts once against bytesPerKey', async () => {
  const fake = createFakeIndexedDB();
  const doc = new Y.Doc({gc: WITH_GC});
  doc.get('t').insert(0, 'hello');
  const state = Y.encodeStateAsUpdate(doc);
  const store = unwrap(
    await openYOfflineStore({
      idb: fake.idb,
      limits: {bytesPerKey: state.length},
      locks: fake.locks,
    }),
  );
  const capture: YOfflineCapture = {
    base: null,
    capturedAt: 1,
    claimed: false,
    differs: false,
    epoch: 'e1',
    id: 'same-id',
    json: null,
    key: 'doc',
    reason: 'stale',
    state,
    text: null,
  };
  unwrap(await store.putCapture(capture));
  unwrap(await store.putCapture({...capture, capturedAt: 2}));
  // A second capture does not fit.
  const second = await store.putCapture({...capture, id: 'other'});
  expect(!second.ok && second.error.limit).toBe('bytes');
});

test('6. a replay with the caret inside the replaced block applies it and moves the caret into it', async () => {
  const {store} = await open();
  const initial = seed([
    ['one', 'b1'],
    ['two', 'b2'],
  ]);
  const stale = client(initial);
  const old = session(stale.binding, store);
  old.s.markSynced();
  stale.edit('one, mine');
  unwrap(await old.s.flush());
  await old.s.serverEpoch('e2');
  const fresh = client(initial);
  // The caret in the block the replay replaces.
  fresh.editor.update(
    () => {
      (
        (
          $getRoot().getFirstChildOrThrow() as ElementNode
        ).getFirstDescendant() as TextNode
      ).select(1, 1);
    },
    {discrete: true},
  );
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
  expect(recovered[0].replay!.applied).toEqual(['b1']);
  expect(fresh.text()).toBe('one, mine\n\ntwo');
  const caret = fresh.editor.read(() => {
    const selection = $getSelection();
    return selection === null
      ? null
      : selection.getNodes()[0].getTopLevelElementOrThrow().getTextContent();
  });
  expect(caret).toBe('one, mine');
});

test('6b. a replay that throws in a recovery is a typed failure, and the capture is replayed by a later call', async () => {
  const {store} = await open();
  const initial = seed();
  const stale = client(initial);
  const old = session(stale.binding, store);
  old.s.markSynced();
  stale.edit('mine');
  unwrap(await old.s.flush());
  await old.s.serverEpoch('e2');
  const fresh = client(initial);
  let failNext = true;
  const editor = new Proxy(fresh.editor, {
    get(target, name) {
      if (name === 'update' && failNext) {
        return () => {
          failNext = false;
          throw new Error('injected: the editor update threw');
        };
      }
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const binding = {
    binding: new Proxy(fresh.binding.binding, {
      get(target, name) {
        return name === 'editor' ? editor : Reflect.get(target, name);
      },
    }),
    freeze: () => fresh.binding.freeze(),
    get status() {
      return fresh.binding.status;
    },
  } as YOfflineBinding;
  const recover = () =>
    recoverYOfflineEdits({
      binding,
      config,
      epoch: 'e2',
      key: 'doc',
      stage: 'replay',
      store,
    });
  const first = unwrap(await recover());
  expect(first[0].report.ok).toBe(false);
  expect(first[0].replay).toBeNull();
  expect(unwrap(await store.captures('doc'))[0].claimed).toBe(false);
  const second = unwrap(await recover());
  expect(second[0].replay!.applied).toEqual(['b1']);
  expect(fresh.text()).toBe('mine');
});

test('7. a replay whose editor update fails under a non-throwing onError releases the claim', async () => {
  const {store} = await open();
  const initial = seed();
  const stale = client(initial);
  const old = session(stale.binding, store);
  old.s.markSynced();
  stale.edit('mine');
  unwrap(await old.s.flush());
  await old.s.serverEpoch('e2');
  const fresh = client(initial);
  // The editor's onError swallows; the next update fails inside.
  let failNext = true;
  const editor = new Proxy(fresh.editor, {
    get(target, name) {
      if (name === 'update' && failNext) {
        return (fn: () => void, options: object) => {
          failNext = false;
          try {
            target.update(() => {
              fn();
              throw new Error('injected: the update failed');
            }, options);
          } catch {
            // The editor's onError would have swallowed it.
          }
        };
      }
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const binding = {
    binding: new Proxy(fresh.binding.binding, {
      get(target, name) {
        return name === 'editor' ? editor : Reflect.get(target, name);
      },
    }),
    freeze: () => fresh.binding.freeze(),
    get status() {
      return fresh.binding.status;
    },
  } as YOfflineBinding;
  const recover = () =>
    recoverYOfflineEdits({
      binding,
      config,
      epoch: 'e2',
      key: 'doc',
      stage: 'replay',
      store,
    });
  const first = unwrap(await recover());
  expect(first[0].replay!.applied).toEqual([]);
  expect(first[0].replay!.notApplied).toEqual([
    {id: 'b1', reason: 'not-written'},
  ]);
  expect(unwrap(await store.captures('doc'))[0].claimed).toBe(false);
  expect(unwrap(await recover())[0].replay!.applied).toEqual(['b1']);
  expect(fresh.text()).toBe('mine');
});

test("8. recovery leaves a live tab's rows at an older epoch, and captures them once that tab is gone", async () => {
  const {store} = await open();
  const initial = seed();
  const left = client(initial);
  const old = session(left.binding, store);
  old.s.markSynced();
  left.edit('left open');
  unwrap(await old.s.flush());
  const fresh = client(initial);
  const recover = () =>
    recoverYOfflineEdits({
      binding: fresh.binding,
      config,
      epoch: 'e2',
      key: 'doc',
      stage: 'persist',
      store,
    });
  expect(unwrap(await recover())).toEqual([]);
  expect(unwrap(await recover())).toEqual([]);
  expect(unwrap(await store.captures('doc'))).toEqual([]);
  // The tab closes.
  old.s.dispose();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(unwrap(await recover()).length).toBe(1);
  expect(unwrap(await recover()).length).toBe(1);
  expect(unwrap(await store.captures('doc')).length).toBe(1);
});

test('9. a document loaded with nothing unsynced is stored as its base', async () => {
  const {store} = await open();
  const first = client(seed());
  const a = session(first.binding, store);
  a.s.markSynced();
  unwrap(await a.s.flush());
  a.s.dispose();
  await new Promise(resolve => setTimeout(resolve, 0));
  for (let reload = 0; reload < 2; reload++) {
    const loaded = unwrap(await loadYOffline({key: 'doc', store}));
    expect(loaded.hasUnsyncedEdits).toBe(false);
    const again = client(loaded.state);
    const s = session(again.binding, store, {loaded});
    unwrap(await s.s.flush());
    s.s.dispose();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  expect(unwrap(await loadYOffline({key: 'doc', store})).hasUnsyncedEdits).toBe(
    false,
  );
});

test('10. two tabs recovering the same stale slot at once make one capture, replayed once', async () => {
  const fake = createFakeIndexedDB();
  const store = unwrap(
    await openYOfflineStore({idb: fake.idb, locks: fake.locks}),
  );
  const initial = seed();
  const left = client(initial);
  const old = session(left.binding, store);
  old.s.markSynced();
  left.edit('one, mine');
  unwrap(await old.s.flush());
  old.s.dispose();
  await new Promise(resolve => setTimeout(resolve, 0));
  const other = unwrap(
    await openYOfflineStore({idb: fake.idb, locks: fake.locks}),
  );
  const a = client(initial);
  const b = client(initial);
  const recover = (c: ReturnType<typeof client>, s: YOfflineStore) =>
    recoverYOfflineEdits({
      binding: c.binding,
      config,
      epoch: 'e2',
      key: 'doc',
      stage: 'replay',
      store: s,
    });
  const [ra, rb] = await Promise.all([recover(a, store), recover(b, other)]);
  const replays = [...unwrap(ra), ...unwrap(rb)].filter(
    r => r.replay !== null && r.replay.applied.length > 0,
  );
  expect(replays.length).toBe(1);
  expect(unwrap(await store.captures('doc')).length).toBe(1);
  // The two documents sync: the block once.
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  expect(a.text()).toBe('one, mine');
  expect(b.text()).toBe('one, mine');
});

test("11. a moved epoch's capture fits when it fits without the rows it replaces", async () => {
  const fake = createFakeIndexedDB();
  const probe = unwrap(
    await openYOfflineStore({
      databaseName: 'probe',
      idb: fake.idb,
      locks: fake.locks,
    }),
  );
  // How big the document is stored.
  const state = seed();
  const sized = client(state);
  const p = session(sized.binding, probe);
  p.s.markSynced();
  sized.edit('one, mine');
  unwrap(await p.s.flush());
  const doc = Y.encodeStateAsUpdate(sized.doc).byteLength;
  p.s.dispose();
  // Room for 2.5 documents: rows plus a capture (state and base) did not fit.
  const store = unwrap(
    await openYOfflineStore({
      idb: fake.idb,
      limits: {bytesPerKey: Math.floor(doc * 2.5)},
      locks: fake.locks,
    }),
  );
  const tab = client(state);
  const s = session(tab.binding, store);
  s.s.markSynced();
  tab.edit('one, mine');
  unwrap(await s.s.flush());
  const verdict = await s.s.serverEpoch('e2');
  expect(verdict.kind === 'moved' && verdict.saved).toEqual({
    ok: true,
    value: undefined,
  });
  expect(s.errors).toEqual([]);
  expect(unwrap(await store.captures('doc')).length).toBe(1);
  expect(unwrap(await store.slots('doc'))).toEqual([]);
});

test('12. a corrupt slot at another epoch fails recovery with its epoch, and clearing it lets recovery go on', async () => {
  const fake = createFakeIndexedDB();
  const store = unwrap(
    await openYOfflineStore({idb: fake.idb, locks: fake.locks}),
  );
  const initial = seed();
  const left = client(initial);
  const old = session(left.binding, store);
  old.s.markSynced();
  left.edit('one, mine');
  unwrap(await old.s.flush());
  old.s.dispose();
  await new Promise(resolve => setTimeout(resolve, 0));
  const records = fake.records('lexical-y-offline', 'updates');
  records[records.length - 1].value = 'damaged';
  const fresh = client(initial);
  const recover = () =>
    recoverYOfflineEdits({
      binding: fresh.binding,
      config,
      epoch: 'e2',
      key: 'doc',
      stage: 'persist',
      store,
    });
  const failed = await recover();
  expect(failed.ok).toBe(false);
  if (!failed.ok) {
    expect(failed.error.code).toBe('corrupt');
    expect(failed.error.epoch).toBe('e1');
    unwrap(
      await store.clear('doc', {captures: false, epoch: failed.error.epoch}),
    );
  }
  expect(unwrap(await recover())).toEqual([]);
});
