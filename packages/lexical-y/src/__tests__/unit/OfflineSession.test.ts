/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The offline session of @lexical/y/offline, end to end over the fake
// IndexedDB and bound editors: edits made with no connection persist and
// merge on a reconnect at the same epoch; a moved epoch freezes and captures
// them with their base; the report and the replay (replayable blocks only,
// one undo step, never over a block someone else changed); the stages; a
// tab that closed before it could freeze; two tabs; a full quota; a base
// below the floor. Written against the build's own constants (a seed's
// layout, FLOOR), so the same file runs on a build of any layout. Run with
// gc off and on (LEXICAL_Y_GC=1).

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
  type LexicalEditor,
} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {
  createYDoc,
  yCollab,
  type YCollabBinding,
  YCollabExtension,
  type YStatus,
} from '../..';
import {seedYState} from '../../headless';
import {setMinLayoutForTests} from '../../internal/Binding';
import {migrateYState} from '../../migrate';
import {
  attachYOfflineSession,
  describeYOfflineCapture,
  loadYOffline,
  openYOfflineStore,
  recoverYOfflineEdits,
  replayUnsyncedEdits,
  Y_OFFLINE_DEFAULTS,
  Y_OFFLINE_STAGES,
  type YOfflineCapture,
  type YOfflineError,
  type YOfflineSession,
  type YOfflineSessionOptions,
  type YOfflineStore,
} from '../../offline';
import {catalogAppExtension, catalogHeadlessConfig} from '../catalog/bind';
import {createFakeIndexedDB, type FakeIndexedDB} from '../utils/fakeIndexedDB';
import {WITH_GC} from '../utils/harness';
import {FLOOR, rawDoc, stamp} from '../utils/migrateSteps';

const DB = Y_OFFLINE_DEFAULTS.databaseName;
const IDS = {blockIds: 'enabled'} as const;
const NO_IDS = {blockIds: 'absent'} as const;
const config = catalogHeadlessConfig(IDS, {onWarn: () => {}});
const configNoIds = catalogHeadlessConfig(NO_IDS, {onWarn: () => {}});

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function unwrap<T>(
  result: {ok: true; value: T} | {ok: false; error: {message: string}},
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

async function open(fake: FakeIndexedDB): Promise<YOfflineStore> {
  return unwrap(await openYOfflineStore({idb: fake.idb, locks: fake.locks}));
}

const $paragraph = (value: string, id?: string) => {
  const paragraph = $createParagraphNode().append($createTextNode(value));
  if (id !== undefined) {
    $setState(paragraph, blockIdState, id);
  }
  return paragraph;
};

/** A stored document of paragraphs `[text, id]`. */
const seed = (
  blocks: [string, string?][],
  ids: typeof IDS | typeof NO_IDS = IDS,
) =>
  seedYState(ids === IDS ? config : configNoIds, () => {
    $getRoot().append(...blocks.map(([value, id]) => $paragraph(value, id)));
  });

interface Client {
  readonly binding: YCollabBinding;
  readonly doc: Y.Doc;
  readonly editor: LexicalEditor;
  readonly statuses: YStatus[];
  /** `[id, text]` of every block. */
  blocks(): [string | undefined, string][];
  text(): string;
  /** Set the text of the block `id`. */
  edit(id: string, value: string): void;
  add(value: string, id?: string, afterId?: string): void;
  remove(id: string): void;
}

const live: {dispose(): void}[] = [];
afterEach(() => {
  for (const editor of live.splice(0)) {
    editor.dispose();
  }
  setMinLayoutForTests(null);
});

/** A tab: an editor bound to a document made from `state`. */
function client(
  state: Uint8Array | null,
  options: {synced?: boolean; ids?: typeof IDS | typeof NO_IDS} = {},
): Client {
  const doc = createYDoc(state, {gc: WITH_GC});
  const statuses: YStatus[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        catalogAppExtension(options.ids ?? IDS),
        yCollab({
          doc,
          onStatus: status => statuses.push(status),
          schemaVersion: 1,
          synced: options.synced ?? true,
        }),
      ],
      name: 'offline-test',
      onError: error => {
        throw error;
      },
      onWarn: () => {},
    }),
  );
  live.push(editor);
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.collab;
  const $find = (id: string) => {
    const found = $getRoot()
      .getChildren()
      .find(node => $getState(node, blockIdState) === id);
    if (found === undefined) {
      throw new Error(`no block ${id}`);
    }
    return found;
  };
  const update = (fn: () => void) => editor.update(fn, {discrete: true});
  return {
    add: (value, id, afterId) =>
      update(() => {
        if (afterId === undefined) {
          $getRoot().append($paragraph(value, id));
        } else {
          $find(afterId).insertAfter($paragraph(value, id));
        }
      }),
    binding,
    blocks: () =>
      editor.read(() =>
        $getRoot()
          .getChildren()
          .map((node): [string | undefined, string] => [
            $getState(node, blockIdState) as string | undefined,
            node.getTextContent(),
          ]),
      ),
    doc,
    edit: (id, value) =>
      update(() => {
        $find(id).replace($paragraph(value, id));
      }),
    editor,
    remove: id => update(() => $find(id).remove()),
    statuses,
    text: () => editor.read(() => $getRoot().getTextContent()),
  };
}

/** Exchange everything two documents hold (a provider's sync). */
function sync(a: Y.Doc, b: Y.Doc): void {
  const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, toB, 'provider');
  Y.applyUpdate(a, toA, 'provider');
}

function attach(
  c: Client,
  store: YOfflineStore | null,
  options: Partial<YOfflineSessionOptions> & {epoch: string | null},
): {session: YOfflineSession; errors: YOfflineError[]} {
  const errors: YOfflineError[] = [];
  const session = attachYOfflineSession({
    binding: c.binding,
    key: 'doc',
    onError: error => errors.push(error),
    stage: 'persist',
    store,
    ...options,
  });
  return {errors, session};
}

const THREE: [string, string][] = [
  ['one', 'b1'],
  ['two', 'b2'],
  ['three', 'b3'],
];

describe('offline mode: edits persist and merge at the same epoch', () => {
  test('edits made with no connection survive a reload and sync on reconnect', async () => {
    const fake = createFakeIndexedDB();
    const room = client(seed(THREE));
    await flush();
    // First visit: fetched from the server at e1, synced.
    const tab = client(Y.encodeStateAsUpdate(room.doc));
    await flush();
    const {session} = attach(tab, await open(fake), {epoch: 'e1'});
    expect(await session.serverEpoch('e1')).toEqual({kind: 'same'});
    session.markSynced();
    expect(session.hasUnsyncedEdits).toBe(false);
    // Offline: the tab edits, someone else edits the room.
    tab.edit('b1', 'one, offline');
    tab.add('four, offline', 'b4');
    room.edit('b3', 'three, by a peer');
    expect(session.hasUnsyncedEdits).toBe(true);
    unwrap(await session.flush());
    expect(session.persisted).toBe(true);
    session.dispose();

    // The tab reloads with no connection.
    const store = await open(fake);
    const loaded = unwrap(await loadYOffline({key: 'doc', store}));
    expect(loaded.epoch).toBe('e1');
    expect(loaded.hasUnsyncedEdits).toBe(true);
    const reloaded = client(loaded.state);
    await flush();
    expect(reloaded.blocks()).toEqual([
      ['b1', 'one, offline'],
      ['b2', 'two'],
      ['b3', 'three'],
      ['b4', 'four, offline'],
    ]);
    const again = attach(reloaded, store, {epoch: loaded.epoch, loaded});
    expect(again.session.hasUnsyncedEdits).toBe(true);
    reloaded.edit('b2', 'two, offline too');

    // Reconnect: the room is still at e1, so the documents merge.
    expect(await again.session.serverEpoch('e1')).toEqual({kind: 'same'});
    sync(reloaded.doc, room.doc);
    again.session.markSynced();
    await flush();
    const merged = [
      ['b1', 'one, offline'],
      ['b2', 'two, offline too'],
      ['b3', 'three, by a peer'],
      ['b4', 'four, offline'],
    ];
    expect(reloaded.blocks()).toEqual(merged);
    expect(room.blocks()).toEqual(merged);
    expect(again.session.hasUnsyncedEdits).toBe(false);
    expect(reloaded.binding.status).toEqual({kind: 'active'});
    unwrap(await again.session.flush());
    // Stored: the merged document as the base, nothing unsynced, one row.
    const stored = unwrap(
      await loadYOffline({key: 'doc', store: await open(fake)}),
    );
    expect(stored.hasUnsyncedEdits).toBe(false);
    expect(fake.records(DB, 'updates').length).toBe(1);
    const check = client(stored.state);
    await flush();
    expect(check.blocks()).toEqual(merged);
    // Nothing was captured.
    expect(unwrap(await store.captures('doc'))).toEqual([]);
  });

  test('a document that never synced adopts the first epoch it meets', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const tab = client(null);
    await flush();
    const {session} = attach(tab, store, {epoch: null});
    tab.add('a new note', 'n1');
    unwrap(await session.flush());
    expect(unwrap(await store.slots('doc')).map(s => s.epoch)).toEqual([null]);
    expect(() => session.markSynced()).toThrow(
      /Call await session\.serverEpoch\(epoch\)/,
    );
    expect(await session.serverEpoch('e1')).toEqual({kind: 'same'});
    expect(session.epoch).toBe('e1');
    session.markSynced();
    unwrap(await session.flush());
    expect(unwrap(await store.slots('doc'))).toMatchObject([
      {epoch: 'e1', hasUnsyncedEdits: false},
    ]);
    const loaded = unwrap(await loadYOffline({key: 'doc', store}));
    const reloaded = client(loaded.state);
    await flush();
    expect(reloaded.text()).toContain('a new note');
  });

  test('stored updates are compacted as they accumulate', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const tab = client(seed(THREE));
    await flush();
    const {session} = attach(tab, store, {compactAfter: 4, epoch: 'e1'});
    await session.serverEpoch('e1');
    session.markSynced();
    for (let i = 0; i < 30; i++) {
      tab.edit('b2', `two, edit ${i}`);
      unwrap(await session.flush());
    }
    // The base, and at most compactAfter rows since.
    expect(fake.records(DB, 'updates').length).toBeLessThanOrEqual(5);
    const loaded = unwrap(
      await loadYOffline({key: 'doc', store: await open(fake)}),
    );
    expect(loaded.hasUnsyncedEdits).toBe(true);
    const reloaded = client(loaded.state);
    await flush();
    expect(reloaded.blocks()).toEqual(tab.blocks());
    // The base is still the synced document.
    const base = client(loaded.base);
    await flush();
    expect(base.blocks()).toEqual(THREE.map(([value, id]) => [id, value]));
  });

  test('two tabs on one key: both tabs edits are stored, and a reload holds both', async () => {
    const fake = createFakeIndexedDB();
    const state = seed(THREE);
    const a = client(state);
    const b = client(state);
    await flush();
    const sa = attach(a, await open(fake), {epoch: 'e1'}).session;
    const sb = attach(b, await open(fake), {epoch: 'e1'}).session;
    await Promise.all([sa.serverEpoch('e1'), sb.serverEpoch('e1')]);
    sa.markSynced();
    sb.markSynced();
    a.edit('b1', 'one, tab a');
    b.edit('b3', 'three, tab b');
    await Promise.all([sa.flush(), sb.flush()]);
    // Tab a syncs and confirms; tab b is still offline.
    const room = client(state);
    await flush();
    sync(a.doc, room.doc);
    sa.markSynced();
    unwrap(await sa.flush());
    const loaded = unwrap(
      await loadYOffline({key: 'doc', store: await open(fake)}),
    );
    expect(loaded.hasUnsyncedEdits).toBe(true);
    const reloaded = client(loaded.state);
    await flush();
    expect(reloaded.blocks()).toEqual([
      ['b1', 'one, tab a'],
      ['b2', 'two'],
      ['b3', 'three, tab b'],
    ]);
  });

  test('a failure that lasts is reported once, and a sync during it stores no phantom edits', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const tab = client(seed(THREE));
    await flush();
    const {errors, session} = attach(tab, store, {epoch: 'e1'});
    await session.serverEpoch('e1');
    session.markSynced();
    unwrap(await session.flush());
    fake.setQuota(1);
    for (let i = 0; i < 5; i++) {
      tab.edit('b1', `one, edit ${i}`);
      await session.flush();
    }
    expect(errors.map(e => e.code)).toEqual(['quota']);
    // The provider syncs while the store is still full, then space returns.
    session.markSynced();
    await session.flush();
    fake.setQuota(Infinity);
    unwrap(await session.flush());
    expect(session.persisted).toBe(true);
    const loaded = unwrap(
      await loadYOffline({key: 'doc', store: await open(fake)}),
    );
    // Everything is the base: nothing is stored as an edit the server lacks.
    expect(loaded.hasUnsyncedEdits).toBe(false);
    const reloaded = client(loaded.state);
    await flush();
    expect(reloaded.blocks()).toEqual(tab.blocks());
  });

  test('edits made while a never-synced document adopts its epoch land in that epoch', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const tab = client(null);
    await flush();
    const {session} = attach(tab, store, {epoch: null});
    tab.add('first', 'n1');
    const adopting = session.serverEpoch('e1');
    // Typed while the rows move.
    tab.add('second', 'n2');
    await adopting;
    tab.add('third', 'n3');
    unwrap(await session.flush());
    expect(unwrap(await store.slots('doc')).map(s => s.epoch)).toEqual(['e1']);
    const reloaded = client(
      unwrap(await loadYOffline({key: 'doc', store: await open(fake)})).state,
    );
    await flush();
    expect(reloaded.text()).toContain('first');
    expect(reloaded.text()).toContain('second');
    expect(reloaded.text()).toContain('third');
  });

  test('a full quota is reported, editing goes on, and the next write stores everything', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const tab = client(seed(THREE));
    await flush();
    const {errors, session} = attach(tab, store, {epoch: 'e1'});
    await session.serverEpoch('e1');
    session.markSynced();
    unwrap(await session.flush());
    fake.setQuota(1);
    tab.edit('b1', 'one, not stored yet');
    const refused = await session.flush();
    expect(!refused.ok && refused.error.code).toBe('quota');
    expect(errors.map(e => e.code)).toEqual(['quota']);
    expect(session.persisted).toBe(false);
    // The editor still has it, and still takes edits.
    tab.edit('b2', 'two, also waiting');
    expect(tab.binding.status).toEqual({kind: 'active'});
    fake.setQuota(Infinity);
    tab.edit('b3', 'three, after space was freed');
    unwrap(await session.flush());
    expect(session.persisted).toBe(true);
    const reloaded = client(
      unwrap(await loadYOffline({key: 'doc', store: await open(fake)})).state,
    );
    await flush();
    expect(reloaded.blocks()).toEqual(tab.blocks());
  });
});

/** A tab at e1 with offline edits, and the room it lost. */
async function staleTab(
  fake: FakeIndexedDB,
  options: Partial<YOfflineSessionOptions> = {},
) {
  const room = client(seed(THREE));
  await flush();
  const store = await open(fake);
  const tab = client(Y.encodeStateAsUpdate(room.doc));
  await flush();
  const attached = attach(tab, store, {epoch: 'e1', ...options});
  await attached.session.serverEpoch('e1');
  attached.session.markSynced();
  return {...attached, room, store, tab};
}

describe('sync, then bind (the server document and epoch before the editor)', () => {
  test('a slot at the same epoch merges into the server document; the live binding is never frozen', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const room = client(seed(THREE));
    await flush();
    // An earlier page at e1 edited with no connection, then closed.
    const earlier = client(Y.encodeStateAsUpdate(room.doc));
    await flush();
    const first = attach(earlier, store, {epoch: 'e1'});
    first.session.markSynced();
    earlier.edit('b1', 'one, offline');
    unwrap(await first.session.flush());
    first.session.dispose();
    await flush();
    // This page syncs first: the room is still at e1.
    const serverState = Y.encodeStateAsUpdate(room.doc);
    const loaded = unwrap(await loadYOffline({epoch: 'e1', key: 'doc', store}));
    expect(loaded.epoch).toBe('e1');
    expect(loaded.hasUnsyncedEdits).toBe(true);
    const doc = createYDoc(serverState, {gc: WITH_GC});
    Y.applyUpdate(doc, loaded.state!);
    const tab = client(Y.encodeStateAsUpdate(doc));
    await flush();
    const {session} = attach(tab, store, {epoch: loaded.epoch, loaded});
    expect(tab.binding.status).toEqual({kind: 'active'});
    expect(tab.blocks()[0]).toEqual(['b1', 'one, offline']);
    expect(await session.serverEpoch('e1')).toEqual({kind: 'same'});
    sync(tab.doc, room.doc);
    session.markSynced();
    expect(room.blocks()[0]).toEqual(['b1', 'one, offline']);
    session.dispose();
  });

  test('a slot at an older epoch is not loaded: the live binding stays active, and recovery captures it', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const state = seed(THREE);
    const earlier = client(state);
    await flush();
    const first = attach(earlier, store, {epoch: 'e1'});
    first.session.markSynced();
    earlier.edit('b2', 'two, offline');
    unwrap(await first.session.flush());
    first.session.dispose();
    await flush();
    // The room was replaced (e2) while the page was away; it syncs first.
    const loaded = unwrap(await loadYOffline({epoch: 'e2', key: 'doc', store}));
    expect(loaded).toMatchObject({epoch: 'e2', slot: null, state: null});
    const tab = client(state);
    await flush();
    const {session} = attach(tab, store, {epoch: loaded.epoch, loaded});
    session.markSynced();
    expect(tab.binding.status).toEqual({kind: 'active'});
    const recovered = unwrap(
      await recoverYOfflineEdits({
        binding: tab.binding,
        config,
        epoch: 'e2',
        key: 'doc',
        session,
        stage: 'replay',
        store,
      }),
    );
    expect(recovered.length).toBe(1);
    expect(recovered[0].replay!.applied).toEqual(['b2']);
    expect(tab.binding.status).toEqual({kind: 'active'});
    expect(tab.blocks()[1]).toEqual(['b2', 'two, offline']);
    session.dispose();
  });

  test("loadYOffline's epoch is checked, naming the fix", async () => {
    const store = await open(createFakeIndexedDB());
    await expect(
      loadYOffline({epoch: 3 as never, key: 'doc', store}),
    ).rejects.toThrow(/String\(epoch\) for a number/);
  });
});

describe("keep: 'unsynced' and writeDelay", () => {
  test("keep 'unsynced': nothing stored while synced, base and since from the first local edit, deleted on markSynced", async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const room = client(seed(THREE));
    await flush();
    const tab = client(Y.encodeStateAsUpdate(room.doc));
    await flush();
    const {session} = attach(tab, store, {epoch: 'e1', keep: 'unsynced'});
    expect(await session.serverEpoch('e1')).toEqual({kind: 'same'});
    session.markSynced();
    unwrap(await session.flush());
    expect(fake.records(DB, 'updates')).toEqual([]);
    // A peer's edit while synced stores nothing.
    room.edit('b3', 'three, by a peer');
    sync(tab.doc, room.doc);
    unwrap(await session.flush());
    expect(fake.records(DB, 'updates')).toEqual([]);
    // The first local edit stores the base and what came since (the
    // peer's edit included), so the slot reads as the whole document.
    tab.edit('b1', 'one, mine');
    unwrap(await session.flush());
    const loaded = unwrap(await loadYOffline({key: 'doc', store}));
    expect(loaded.epoch).toBe('e1');
    expect(loaded.hasUnsyncedEdits).toBe(true);
    expect(loaded.base).not.toBeNull();
    const reloaded = client(loaded.state);
    await flush();
    expect(reloaded.blocks()).toEqual([
      ['b1', 'one, mine'],
      ['b2', 'two'],
      ['b3', 'three, by a peer'],
    ]);
    // Acknowledged: the rows go.
    session.markSynced();
    unwrap(await session.flush());
    expect(fake.records(DB, 'updates')).toEqual([]);
    // And the next edit starts again from the new base.
    tab.edit('b2', 'two, mine');
    unwrap(await session.flush());
    const again = client(unwrap(await loadYOffline({key: 'doc', store})).state);
    await flush();
    expect(again.blocks()).toEqual([
      ['b1', 'one, mine'],
      ['b2', 'two, mine'],
      ['b3', 'three, by a peer'],
    ]);
    session.dispose();
  });

  test("keep 'unsynced': a moved epoch captures from what is stored after the tab closed", async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const tab = client(seed(THREE));
    await flush();
    const {session} = attach(tab, store, {epoch: 'e1', keep: 'unsynced'});
    await session.serverEpoch('e1');
    session.markSynced();
    tab.edit('b2', 'two, unsynced');
    unwrap(await session.flush());
    session.dispose();
    // The room moved to e2 while the tab was closed.
    const fresh = client(seed(THREE));
    await flush();
    const recovered = unwrap(
      await recoverYOfflineEdits({
        binding: fresh.binding,
        config,
        epoch: 'e2',
        key: 'doc',
        stage: 'persist',
        store,
      }),
    );
    expect(recovered.length).toBe(1);
    const report = unwrap(recovered[0].report);
    expect(report.blocks.map(b => [b.id, b.change, b.replayable])).toEqual([
      ['b2', 'changed', true],
    ]);
  });

  test('writeDelay stores once updates pause, flush() stores at once, and continuous typing is stored at least every ten delays', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const tab = client(seed(THREE));
    await flush();
    const {session} = attach(tab, store, {epoch: 'e1', writeDelay: 40});
    await session.serverEpoch('e1');
    session.markSynced();
    unwrap(await session.flush());
    const rows = () => fake.records(DB, 'updates').length;
    const base = rows();
    tab.edit('b1', 'o');
    tab.edit('b1', 'on');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(rows()).toBe(base);
    // One row for the two updates, once they paused.
    await expect.poll(rows, {timeout: 2000}).toBe(base + 1);
    tab.edit('b1', 'one');
    unwrap(await session.flush());
    expect(rows()).toBe(base + 2);
    // Typing every 20 ms never pauses 40 ms, but is stored within 400.
    const start = rows();
    for (let i = 0; i < 25; i++) {
      tab.edit('b2', `two ${i}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(rows()).toBeGreaterThan(start);
    session.dispose();
    await flush();
  });

  test('a never-synced slot left by a closed tab becomes a capture (base unknown: listed, not replayed)', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const offline = client(seed(THREE));
    await flush();
    const left = attach(offline, store, {epoch: null});
    offline.edit('b1', 'one, made offline');
    unwrap(await left.session.flush());
    left.session.dispose();
    const fresh = client(seed(THREE));
    await flush();
    const recovered = unwrap(
      await recoverYOfflineEdits({
        binding: fresh.binding,
        config,
        epoch: 'e1',
        key: 'doc',
        stage: 'replay',
        store,
      }),
    );
    expect(recovered.length).toBe(1);
    expect(recovered[0].capture).toMatchObject({base: null, epoch: null});
    expect(recovered[0].replay).toBeNull();
    const report = unwrap(recovered[0].report);
    expect(report.baseAvailable).toBe(false);
    expect(report.blocks.map(b => [b.id, b.change, b.replayable])).toEqual([
      ['b1', 'changed', false],
    ]);
    expect(unwrap(await store.slots('doc'))).toEqual([]);
    expect(fresh.blocks()[0]).toEqual(['b1', 'one']);
  });
});

describe('a moved epoch captures', () => {
  test('the document is frozen and stored with its base; nothing merges', async () => {
    const fake = createFakeIndexedDB();
    const {room, session, store, tab} = await staleTab(fake);
    tab.edit('b1', 'one, offline');
    tab.add('four, offline', 'b4');
    tab.remove('b2');
    unwrap(await session.flush());
    const before = Y.encodeStateAsUpdate(room.doc);

    const verdict = await session.serverEpoch('e2');
    expect(verdict.kind).toBe('moved');
    if (verdict.kind !== 'moved') {
      return;
    }
    expect(verdict.saved).toEqual({ok: true, value: undefined});
    // Frozen: read only, with the cause, and the session has ended.
    expect(tab.binding.status).toEqual({
      cause: {code: 'frozen'},
      kind: 'readonly',
    });
    expect(tab.editor.isEditable()).toBe(false);
    expect(session.ended).toBe(true);
    await expect(session.serverEpoch('e2')).rejects.toThrow(
      /this session has ended/,
    );
    // The capture: what the user saw, and the base it was made against.
    const capture = verdict.capture!;
    expect(capture).toMatchObject({
      claimed: false,
      epoch: 'e1',
      key: 'doc',
      reason: 'stale',
    });
    expect(capture.text).toContain('one, offline');
    const base = client(capture.base);
    await flush();
    expect(base.blocks()).toEqual(THREE.map(([value, id]) => [id, value]));
    // Stored, and the stale slot is gone.
    const stored = unwrap(await store.captures('doc'));
    expect(stored.map(c => c.id)).toEqual([capture.id]);
    expect(unwrap(await store.slots('doc'))).toEqual([]);
    // Nothing reached the room.
    expect(Y.encodeStateAsUpdate(room.doc)).toEqual(before);
  });

  test('a replaced event while connected takes the same path, with its reason', async () => {
    const fake = createFakeIndexedDB();
    const {session, tab} = await staleTab(fake, {persistEdits: false});
    tab.edit('b2', 'two, typed as the room was replaced');
    const verdict = await session.serverEpoch('e2', {reason: 'expired'});
    expect(verdict.kind === 'moved' && verdict.capture!.reason).toBe('expired');
    // Capture only: no document rows were ever stored.
    expect(fake.records(DB, 'updates')).toEqual([]);
    expect(fake.records(DB, 'captures').length).toBe(1);
  });

  test('freeze(): the room was replaced and its new epoch is not known yet', async () => {
    const fake = createFakeIndexedDB();
    const {room, session, store, tab} = await staleTab(fake);
    tab.edit('b2', 'two, unsynced');
    const verdict = await session.freeze();
    expect(verdict.kind).toBe('moved');
    expect(verdict.kind === 'moved' && verdict.saved.ok).toBe(true);
    expect(session.ended).toBe(true);
    expect(tab.binding.status).toMatchObject({kind: 'readonly'});
    // On the new document, once its epoch is known.
    const fresh = client(Y.encodeStateAsUpdate(room.doc));
    await flush();
    const recovered = unwrap(
      await recoverYOfflineEdits({
        binding: fresh.binding,
        config,
        epoch: 'e2',
        key: 'doc',
        stage: 'persist',
        store,
      }),
    );
    expect(
      unwrap(recovered[0].report).blocks.map(block => [block.id, block.change]),
    ).toEqual([['b2', 'changed']]);
    await expect(session.freeze()).rejects.toThrow(/has ended/);
  });

  test('with nothing unsynced there is nothing to capture', async () => {
    const fake = createFakeIndexedDB();
    const {session, store, tab} = await staleTab(fake);
    const verdict = await session.serverEpoch('e2');
    expect(verdict).toEqual({
      capture: null,
      kind: 'moved',
      saved: {ok: true, value: undefined},
    });
    expect(tab.binding.status.kind).toBe('readonly');
    expect(unwrap(await store.captures('doc'))).toEqual([]);
    expect(unwrap(await store.slots('doc'))).toEqual([]);
  });

  test("two tabs at the old epoch: one tab's capture leaves the other tab's stored edits", async () => {
    const fake = createFakeIndexedDB();
    const state = seed(THREE);
    const a = client(state);
    const b = client(state);
    await flush();
    const store = await open(fake);
    const sa = attach(a, store, {epoch: 'e1'}).session;
    const sb = attach(b, await open(fake), {epoch: 'e1'}).session;
    await Promise.all([sa.serverEpoch('e1'), sb.serverEpoch('e1')]);
    sa.markSynced();
    sb.markSynced();
    a.edit('b1', 'one, tab a');
    b.edit('b3', 'three, tab b');
    await Promise.all([sa.flush(), sb.flush()]);
    // Tab a learns the room moved; tab b has not yet, and then closes.
    const verdict = await sa.serverEpoch('e2');
    expect(verdict.kind === 'moved' && verdict.capture!.text).toContain(
      'one, tab a',
    );
    expect(unwrap(await store.slots('doc'))).toMatchObject([
      {epoch: 'e1', hasUnsyncedEdits: true},
    ]);
    sb.dispose();
    // The next page gathers both: a's capture, and b's stored document.
    const fresh = client(state);
    await flush();
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
    expect(recovered.length).toBe(2);
    expect(fresh.blocks()).toEqual([
      ['b1', 'one, tab a'],
      ['b2', 'two'],
      ['b3', 'three, tab b'],
    ]);
    expect(unwrap(await store.slots('doc'))).toEqual([]);
  });

  test('a capture the quota refuses is still returned, and the stored document stays', async () => {
    const fake = createFakeIndexedDB();
    const {errors, session, store, tab} = await staleTab(fake);
    tab.edit('b1', 'one, offline');
    unwrap(await session.flush());
    fake.setQuota(1);
    const verdict = await session.serverEpoch('e2');
    expect(verdict.kind).toBe('moved');
    if (verdict.kind === 'moved') {
      expect(!verdict.saved.ok && verdict.saved.error.code).toBe('quota');
      expect(verdict.capture!.text).toContain('one, offline');
    }
    expect(errors.map(e => e.code)).toEqual(['quota']);
    fake.setQuota(Infinity);
    // The slot still holds the edits: the next page captures them.
    expect(unwrap(await store.slots('doc'))).toMatchObject([
      {epoch: 'e1', hasUnsyncedEdits: true},
    ]);
  });
});

describe('the report and the replay', () => {
  /**
   * The stale tab changed b1, added b4 after b1, deleted b2 and changed b3;
   * in the new epoch someone else changed b3.
   */
  async function moved(fake: FakeIndexedDB) {
    const {room, session, store, tab} = await staleTab(fake);
    tab.edit('b1', 'one, mine');
    tab.add('four, mine', 'b4', 'b1');
    tab.remove('b2');
    tab.edit('b3', 'three, mine');
    const verdict = await session.serverEpoch('e2');
    if (verdict.kind !== 'moved' || verdict.capture === null) {
      throw new Error('expected a capture');
    }
    // The room at e2: the same document, and a peer's change to b3.
    const next = client(Y.encodeStateAsUpdate(room.doc));
    await flush();
    next.edit('b3', 'three, theirs');
    // The tab's fresh document.
    const fresh = client(Y.encodeStateAsUpdate(next.doc));
    await flush();
    return {capture: verdict.capture, fresh, next, store};
  }

  test('persist stage: the panel content, nothing applied', async () => {
    const fake = createFakeIndexedDB();
    const {capture, fresh, store} = await moved(fake);
    const before = fresh.blocks();
    const recovered = unwrap(
      await recoverYOfflineEdits({
        binding: fresh.binding,
        config,
        epoch: 'e2',
        key: 'doc',
        stage: 'persist',
        store,
      }),
    );
    expect(recovered.length).toBe(1);
    expect(recovered[0].capture.id).toBe(capture.id);
    expect(recovered[0].replay).toBeNull();
    const report = unwrap(recovered[0].report);
    expect(report.baseAvailable).toBe(true);
    expect(report.blocks.map(b => [b.id, b.change, b.replayable])).toEqual([
      ['b1', 'changed', true],
      ['b4', 'added', true],
      ['b3', 'changed', false],
      ['b2', 'deleted', true],
    ]);
    expect(report.order).toEqual(['b1', 'b4', 'b3']);
    expect(fresh.blocks()).toEqual(before);
    // Still stored, unclaimed.
    expect(unwrap(await store.captures('doc'))).toMatchObject([
      {claimed: false, id: capture.id},
    ]);
  });

  test('replay stage: replayable blocks are applied as one undo step; the changed block stays in the panel', async () => {
    const fake = createFakeIndexedDB();
    const {fresh, store} = await moved(fake);
    const before = fresh.blocks();
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
    expect(recovered[0].replay).toEqual({
      applied: ['b1', 'b4', 'b2'],
      notApplied: [{id: 'b3', reason: 'not-replayable'}],
    });
    // b3 is theirs: never overwritten.
    expect(fresh.blocks()).toEqual([
      ['b1', 'one, mine'],
      ['b4', 'four, mine'],
      ['b3', 'three, theirs'],
    ]);
    // What is left for the panel: b3 alone.
    const left = unwrap(recovered[0].report);
    expect(left.blocks.map(b => [b.id, b.replayable])).toEqual([['b3', false]]);
    expect([...left.inDocument].sort()).toEqual(['b1', 'b2', 'b4']);
    expect(unwrap(await store.captures('doc'))).toMatchObject([
      {claimed: true},
    ]);
    // One undo step takes all of it back.
    expect(fresh.binding.history!.undo()).toBe(true);
    await flush();
    expect(fresh.blocks()).toEqual(before);
    expect(fresh.binding.history!.canUndo).toBe(false);
  });

  test('the replay reaches the room like any edit', async () => {
    const fake = createFakeIndexedDB();
    const {fresh, next, store} = await moved(fake);
    unwrap(
      await recoverYOfflineEdits({
        binding: fresh.binding,
        config,
        epoch: 'e2',
        key: 'doc',
        stage: 'replay',
        store,
      }),
    );
    sync(fresh.doc, next.doc);
    await flush();
    expect(next.blocks()).toEqual(fresh.blocks());
  });

  test('a capture is replayed automatically once: a second tab leaves it to the panel', async () => {
    const fake = createFakeIndexedDB();
    const {fresh, next, store} = await moved(fake);
    const other = client(Y.encodeStateAsUpdate(next.doc));
    await flush();
    const recover = (c: Client, s: YOfflineStore) =>
      recoverYOfflineEdits({
        binding: c.binding,
        config,
        epoch: 'e2',
        key: 'doc',
        stage: 'replay',
        store: s,
      });
    const [first, second] = await Promise.all([
      recover(fresh, store),
      recover(other, await open(fake)),
    ]);
    const replays = [unwrap(first)[0].replay, unwrap(second)[0].replay];
    expect(replays.filter(r => r !== null).length).toBe(1);
    sync(fresh.doc, other.doc);
    await flush();
    // Applied once: no block twice.
    expect(fresh.blocks().map(([id]) => id)).toEqual(['b1', 'b4', 'b3']);
    expect(other.blocks()).toEqual(fresh.blocks());
  });

  test('Reapply one block; a block that changed since the report is refused', async () => {
    const fake = createFakeIndexedDB();
    const {capture, fresh} = await moved(fake);
    const describeNow = () =>
      unwrap(
        describeYOfflineCapture(capture, {
          config,
          current: Y.encodeStateAsUpdate(fresh.doc),
        }),
      );
    const report = describeNow();
    // The panel's button for b4.
    expect(
      replayUnsyncedEdits({binding: fresh.binding, only: ['b4'], report}),
    ).toEqual({applied: ['b4'], notApplied: []});
    expect(fresh.blocks().map(([id]) => id)).toEqual(['b1', 'b4', 'b2', 'b3']);
    // Someone changes b1 after the report was made.
    fresh.edit('b1', 'one, changed since');
    expect(
      replayUnsyncedEdits({
        binding: fresh.binding,
        only: ['b1', 'b3', 'nope'],
        report,
      }),
    ).toEqual({
      applied: [],
      notApplied: [
        {id: 'nope', reason: 'not-in-report'},
        {id: 'b1', reason: 'changed-since'},
        {id: 'b3', reason: 'not-replayable'},
      ],
    });
    expect(fresh.blocks()[0]).toEqual(['b1', 'one, changed since']);
    // Replaying b4 again does nothing: it is in the document.
    expect(
      replayUnsyncedEdits({binding: fresh.binding, only: ['b4'], report}),
    ).toEqual({applied: [], notApplied: [{id: 'b4', reason: 'changed-since'}]});
    // A new report no longer lists it.
    expect(describeNow().blocks.map(b => b.id)).toEqual(['b1', 'b3', 'b2']);
    expect(describeNow().inDocument).toEqual(['b4']);
  });

  test('a replayed capture stays stored until the server holds what was reapplied', async () => {
    const fake = createFakeIndexedDB();
    const {room, session, store, tab} = await staleTab(fake);
    tab.edit('b1', 'one, mine');
    await session.serverEpoch('e2');
    const fresh = client(Y.encodeStateAsUpdate(room.doc));
    await flush();
    const now = attach(fresh, store, {epoch: 'e2', persistEdits: false});
    now.session.markSynced();
    const recover = (withSession: boolean) =>
      recoverYOfflineEdits({
        binding: fresh.binding,
        config,
        epoch: 'e2',
        key: 'doc',
        session: withSession ? now.session : undefined,
        stage: 'replay',
        store,
      });
    // Everything was reapplied, but only this page holds it yet.
    const first = unwrap(await recover(true));
    expect(first[0].replay!.applied).toEqual(['b1']);
    expect(unwrap(first[0].report).blocks).toEqual([]);
    expect(unwrap(await store.captures('doc')).length).toBe(1);
    // Called again before the server has it (a panel refresh): kept, with
    // nothing left to show.
    const again = unwrap(await recover(true));
    expect(again.length).toBe(1);
    expect(unwrap(again[0].report).blocks).toEqual([]);
    expect(unwrap(await store.captures('doc')).length).toBe(1);
    // Without the session nothing tells it the server holds the document.
    sync(fresh.doc, room.doc);
    now.session.markSynced();
    expect(unwrap(await recover(false)).length).toBe(1);
    // With it, after the sync: it goes.
    expect(unwrap(await recover(true))).toEqual([]);
    expect(unwrap(await store.captures('doc'))).toEqual([]);
    expect(fresh.blocks()[0]).toEqual(['b1', 'one, mine']);
    now.session.dispose();
  });

  test('blocks the user only moved: no block entry, the report says so, and the capture is kept', async () => {
    const fake = createFakeIndexedDB();
    const {room, session, store, tab} = await staleTab(fake);
    tab.editor.update(
      () => {
        const first = $getRoot().getFirstChild()!;
        $getRoot().append(first);
      },
      {discrete: true},
    );
    expect(tab.blocks().map(([id]) => id)).toEqual(['b2', 'b3', 'b1']);
    const verdict = await session.serverEpoch('e2');
    expect(verdict.kind === 'moved' && verdict.capture).not.toBeNull();
    const fresh = client(Y.encodeStateAsUpdate(room.doc));
    await flush();
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
    const report = unwrap(recovered[0].report);
    expect(report.blocks).toEqual([]);
    expect(report.orderDiffers).toBe(true);
    expect(report.order).toEqual(['b2', 'b3', 'b1']);
    expect(unwrap(await store.captures('doc')).length).toBe(1);
    // The document keeps its order: a move is not replayed.
    expect(fresh.blocks().map(([id]) => id)).toEqual(['b1', 'b2', 'b3']);
  });

  test('an added block with none of its earlier neighbours left goes before the next one', async () => {
    const fake = createFakeIndexedDB();
    const {room, session, tab} = await staleTab(fake);
    // Added between b1 and b2; in the new epoch b1 is gone.
    tab.add('new, mine', 'n1', 'b1');
    const verdict = await session.serverEpoch('e2');
    const next = client(Y.encodeStateAsUpdate(room.doc));
    await flush();
    next.remove('b1');
    const report = unwrap(
      describeYOfflineCapture((verdict as {capture: YOfflineCapture}).capture, {
        config,
        current: Y.encodeStateAsUpdate(next.doc),
      }),
    );
    expect(
      replayUnsyncedEdits({binding: next.binding, only: ['n1'], report})
        .applied,
    ).toEqual(['n1']);
    expect(next.blocks().map(([id]) => id)).toEqual(['n1', 'b2', 'b3']);
  });

  test('replay needs an active binding, and says where to replay', async () => {
    const fake = createFakeIndexedDB();
    const {capture, fresh} = await moved(fake);
    const report = unwrap(
      describeYOfflineCapture(capture, {
        config,
        current: Y.encodeStateAsUpdate(fresh.doc),
      }),
    );
    fresh.binding.freeze();
    expect(() => replayUnsyncedEdits({binding: fresh.binding, report})).toThrow(
      /needs an active binding \(it is readonly\): replay into the fresh document/,
    );
  });

  test('edits that did reach the server are left out, and the capture is deleted', async () => {
    const fake = createFakeIndexedDB();
    const {room, session, store, tab} = await staleTab(fake);
    tab.edit('b1', 'one, sent in time');
    // The room received it, but the tab never learned that.
    sync(tab.doc, room.doc);
    await flush();
    const verdict = await session.serverEpoch('e2');
    expect(verdict.kind === 'moved' && verdict.capture).not.toBeNull();
    const fresh = client(Y.encodeStateAsUpdate(room.doc));
    await flush();
    const now = attach(fresh, store, {epoch: 'e2'});
    now.session.markSynced();
    const recovered = unwrap(
      await recoverYOfflineEdits({
        binding: fresh.binding,
        config,
        epoch: 'e2',
        key: 'doc',
        session: now.session,
        stage: 'replay',
        store,
      }),
    );
    expect(recovered).toEqual([]);
    expect(unwrap(await store.captures('doc'))).toEqual([]);
    now.session.dispose();
  });

  test('a tab that closed before it could freeze: its stored document becomes a capture', async () => {
    const fake = createFakeIndexedDB();
    const {room, session, tab} = await staleTab(fake);
    tab.edit('b1', 'one, then the tab closed');
    tab.add('four, never frozen', 'b4');
    unwrap(await session.flush());
    session.dispose();
    // Later: a new page, the room is at e2.
    const store = await open(fake);
    const fresh = client(Y.encodeStateAsUpdate(room.doc));
    await flush();
    const recovered = unwrap(
      await recoverYOfflineEdits({
        binding: fresh.binding,
        config,
        epoch: 'e2',
        key: 'doc',
        stage: 'persist',
        store,
      }),
    );
    expect(recovered.length).toBe(1);
    expect(recovered[0].capture).toMatchObject({
      epoch: 'e1',
      json: null,
      text: null,
    });
    const report = unwrap(recovered[0].report);
    expect(report.blocks.map(b => [b.id, b.change, b.replayable])).toEqual([
      ['b1', 'changed', true],
      ['b4', 'added', true],
    ]);
    expect(report.order).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(unwrap(await store.slots('doc'))).toEqual([]);
    // And it replays like any other.
    expect(
      replayUnsyncedEdits({binding: fresh.binding, report}).applied,
    ).toEqual(['b1', 'b4']);
    expect(fresh.blocks()).toEqual([
      ['b1', 'one, then the tab closed'],
      ['b2', 'two'],
      ['b3', 'three'],
      ['b4', 'four, never frozen'],
    ]);
  });

  test('without block ids: reported by position, nothing replayed', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const state = seed([['one'], ['two']], NO_IDS);
    const tab = client(state, {ids: NO_IDS});
    await flush();
    const {session} = attach(tab, store, {epoch: 'e1'});
    await session.serverEpoch('e1');
    session.markSynced();
    tab.editor.update(
      () => {
        $getRoot().getLastChild()!.replace($paragraph('two, mine'));
      },
      {discrete: true},
    );
    await session.serverEpoch('e2');
    const fresh = client(state, {ids: NO_IDS});
    await flush();
    const recovered = unwrap(
      await recoverYOfflineEdits({
        binding: fresh.binding,
        config: configNoIds,
        epoch: 'e2',
        key: 'doc',
        stage: 'replay',
        store,
      }),
    );
    expect(recovered[0].replay).toBeNull();
    const report = unwrap(recovered[0].report);
    expect(report.blocks.map(b => [b.id, b.change, b.replayable])).toEqual([
      ['#1', 'changed', false],
    ]);
    expect(fresh.text()).not.toContain('mine');
  });
});

describe('stages', () => {
  test('the stages are exported in rollout order', () => {
    expect(Y_OFFLINE_STAGES).toEqual(['off', 'persist', 'replay']);
  });

  test('off: nothing is listened to, stored, frozen or recovered', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const tab = client(seed(THREE));
    await flush();
    const observers = () =>
      [
        ...(tab.doc as unknown as {_observers: Map<string, Set<unknown>>})
          ._observers,
      ].map(([name, set]) => [name, set.size]);
    const before = observers();
    // No store is needed at this stage.
    const {session} = attach(tab, null, {epoch: 'e1', stage: 'off'});
    expect(observers()).toEqual(before);
    session.markSynced();
    tab.edit('b1', 'one, edited');
    expect(await session.serverEpoch('e2')).toEqual({kind: 'off'});
    expect(tab.binding.status).toEqual({kind: 'active'});
    expect(unwrap(await session.flush())).toBeUndefined();
    expect(
      unwrap(
        await recoverYOfflineEdits({
          binding: tab.binding,
          config,
          epoch: 'e2',
          key: 'doc',
          stage: 'off',
          store,
        }),
      ),
    ).toEqual([]);
    expect(fake.records(DB, 'updates')).toEqual([]);
    expect(fake.records(DB, 'captures')).toEqual([]);
  });

  test('persist stores every edit by default (persistEdits left out)', async () => {
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    const tab = client(seed(THREE));
    await flush();
    const {session} = attach(tab, store, {epoch: 'e1'});
    session.markSynced();
    tab.edit('b1', 'one, edited');
    unwrap(await session.flush());
    const loaded = unwrap(await loadYOffline({key: 'doc', store}));
    expect(loaded.epoch).toBe('e1');
    expect(loaded.hasUnsyncedEdits).toBe(true);
    expect(client(loaded.state).text()).toContain('one, edited');
    session.dispose();
  });

  test('persist without persistEdits adds no update listener', async () => {
    const fake = createFakeIndexedDB();
    const tab = client(seed(THREE));
    await flush();
    const updateListeners = () => {
      const set = (
        tab.doc as unknown as {_observers: Map<string, Set<unknown>>}
      )._observers.get('update');
      return set === undefined ? 0 : set.size;
    };
    const before = updateListeners();
    const {session} = attach(tab, await open(fake), {
      epoch: 'e1',
      persistEdits: false,
    });
    expect(updateListeners()).toBe(before);
    session.dispose();
  });
});

describe('required choices fail with the fix', () => {
  test.each([
    ['no stage', {stage: undefined}, /needs stage: 'off' \(do nothing\)/],
    ['no binding', {binding: undefined}, /needs binding: what createYBinding/],
    ['no key', {key: ''}, /needs key/],
    ['a numeric epoch', {epoch: 3}, /String\(epoch\) for a number/],
    ['an unknown keep', {keep: 'all'}, /keep is 'document' \(the default/],
    [
      'a negative writeDelay',
      {writeDelay: -1},
      /writeDelay is the milliseconds/,
    ],
    [
      'a persistEdits that is not a boolean',
      {persistEdits: 'yes'},
      /persistEdits is true \(the default/,
    ],
    ['no onError', {onError: undefined}, /needs onError/],
    ['no store', {store: null}, /needs store at stage 'persist'/],
    [
      'a loaded document of another epoch',
      {
        loaded: {
          base: null,
          epoch: 'e0',
          hasUnsyncedEdits: false,
          slot: null,
          state: null,
        },
      },
      /pass epoch: loaded\.epoch/,
    ],
  ])('%s', async (_name, options, message) => {
    const tab = client(null);
    const store = await open(createFakeIndexedDB());
    expect(() =>
      attachYOfflineSession({
        binding: tab.binding,
        epoch: 'e1',
        key: 'doc',
        onError: () => {},
        stage: 'persist',
        store,
        ...(options as object),
      } as never),
    ).toThrow(message);
  });

  test('serverEpoch and recoverYOfflineEdits check their arguments', async () => {
    const tab = client(null);
    const store = await open(createFakeIndexedDB());
    const {session} = attach(tab, store, {epoch: null});
    await expect(session.serverEpoch(2 as never)).rejects.toThrow(
      /String\(epoch\) for a number/,
    );
    await expect(
      session.serverEpoch('e1', {reason: 'gone' as never}),
    ).rejects.toThrow(/reason is 'stale'/);
    await expect(
      recoverYOfflineEdits({
        binding: tab.binding,
        config,
        epoch: 'e1',
        key: 'doc',
        stage: 'on' as never,
        store,
      }),
    ).rejects.toThrow(/needs stage/);
  });
});

describe('a base below the floor', () => {
  // A capture whose base an older release stored: the layout one below the
  // floor of this build (as a layout 3 base is to a layout 4 release).
  const below = () => rawDoc(FLOOR - 1, 'one');
  const capture = (
    base: Uint8Array | null,
    json: unknown,
  ): YOfflineCapture => ({
    base,
    capturedAt: 1,
    claimed: false,
    // The editor held what `json` shows; the state is the base's.
    differs: json !== null,
    epoch: 'e1',
    id: 'c1',
    json,
    key: 'doc',
    reason: 'stale',
    state: base ?? new Uint8Array([0, 0]),
    text: null,
  });
  const migrate = (state: Uint8Array) =>
    migrateYState(state, [stamp(FLOOR - 1)]).state;
  const plain = catalogHeadlessConfig(NO_IDS, {onWarn: () => {}});

  test('without migrate: reported as gone, nothing replayable, the edits still listed', async () => {
    setMinLayoutForTests(FLOOR);
    const tab = client(seed([['one, mine']], NO_IDS), {ids: NO_IDS});
    await flush();
    const report = unwrap(
      describeYOfflineCapture(
        capture(below(), tab.editor.getEditorState().toJSON()),
        {config: plain, current: migrate(below())},
      ),
    );
    expect(report.baseAvailable).toBe(false);
    expect(report.blocks.map(b => [b.id, b.change, b.replayable])).toEqual([
      ['#0', 'changed', false],
    ]);
    expect(JSON.stringify(report.blocks[0].yours)).toContain('one, mine');
  });

  test('with migrate: the base is read, and the report is made against it', async () => {
    setMinLayoutForTests(FLOOR);
    const tab = client(seed([['one, mine']], NO_IDS), {ids: NO_IDS});
    await flush();
    const report = unwrap(
      describeYOfflineCapture(
        capture(below(), tab.editor.getEditorState().toJSON()),
        {config: plain, current: migrate(below()), migrate},
      ),
    );
    expect(report.baseAvailable).toBe(true);
    expect(JSON.stringify(report.blocks[0].base)).toContain('"one"');
  });

  test('a capture from storage alone, below the floor: unreadable without migrate, read with it', () => {
    setMinLayoutForTests(FLOOR);
    const stored = capture(below(), null);
    const without = describeYOfflineCapture(stored, {
      config: plain,
      current: migrate(below()),
    });
    expect(without.ok).toBe(false);
    expect(!without.ok && without.error.message).toMatch(
      /Pass options\.migrate \(migrateYState from @lexical\/y\/migrate/,
    );
    const report = unwrap(
      describeYOfflineCapture(stored, {
        config: plain,
        current: migrate(below()),
        migrate,
      }),
    );
    // The same document, migrated: nothing differs.
    expect(report.blocks).toEqual([]);
    expect(report.baseAvailable).toBe(true);
  });

  test('a document below the floor is stored and captured as bytes, whatever its layout', async () => {
    setMinLayoutForTests(FLOOR);
    const fake = createFakeIndexedDB();
    const store = await open(fake);
    // Stored by an older release, with an edit the server lacks.
    const slot = store.slot('doc', 'e1');
    unwrap(await slot.confirm(below()));
    const edited = createYDoc(below(), {gc: WITH_GC});
    const vector = Y.encodeStateVector(edited);
    edited.get('lexical-y').insert(3, ' more');
    unwrap(await slot.append(Y.encodeStateAsUpdate(edited, vector)));
    // This release loads it: read only (its server must migrate it).
    const loaded = unwrap(
      await loadYOffline({key: 'doc', store: await open(fake)}),
    );
    expect(loaded.hasUnsyncedEdits).toBe(true);
    const tab = client(loaded.state, {ids: NO_IDS});
    await flush();
    expect(tab.binding.status).toEqual({
      cause: {code: 'layout-older', layout: FLOOR - 1},
      kind: 'readonly',
    });
    expect(tab.text()).toBe('one more');
    const {session} = attach(tab, store, {epoch: 'e1', loaded});
    // The server migrated the room: a new epoch.
    const verdict = await session.serverEpoch('e2');
    expect(verdict.kind).toBe('moved');
    if (verdict.kind !== 'moved') {
      return;
    }
    expect(verdict.capture!.text).toBe('one more');
    const report = unwrap(
      describeYOfflineCapture(verdict.capture!, {
        config: plain,
        current: migrate(below()),
        migrate,
      }),
    );
    expect(report.baseAvailable).toBe(true);
    expect(report.blocks.map(b => [b.id, b.change])).toEqual([
      ['#0', 'changed'],
    ]);
    expect(JSON.stringify(report.blocks[0].yours)).toContain('one more');
  });
});
