/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Leftovers (D134), found by review: a resolved capture is deleted only by
// a document that holds the write that resolved it, and taken again a
// minute on when that write never arrived; baseAt is when the base was
// confirmed, not when it was stored again; and a replay whose editor update
// failed hands every block with content to the handler.

import {
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setState,
  defineExtension,
  ParagraphNode,
} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {createYDoc, yCollab, YCollabExtension} from '../../..';
import {
  describeUnsyncedEdits,
  type HeadlessYConfig,
  seedYState,
} from '../../../headless';
import {readStateVector} from '../../../internal/OfflineSession';
import {
  attachYOfflineSession,
  loadYOffline,
  openYOfflineStore,
  recoverYOfflineEdits,
  replayUnsyncedEdits,
  wrapLeftoversAsQuote,
  type YOfflineCapture,
  type YOfflineResult,
  type YOfflineSession,
  type YOfflineStore,
} from '../../../offline';
import {createFakeIndexedDB} from '../../utils/fakeIndexedDB';
import {textIn} from '../../utils/offlineLeftovers';

const config: HeadlessYConfig = {
  extensions: [BlockIdExtension],
  onWarn: () => {},
  schemaVersion: 1,
};
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const fn of dispose.splice(0).reverse()) fn();
});
const tick = () => new Promise<void>(r => setTimeout(r, 0));
function unwrap<T>(r: YOfflineResult<T>): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
function $p(text: string, id = 'b1') {
  return $setState(
    $createParagraphNode().append($createTextNode(text)),
    blockIdState,
    id,
  );
}
function state(text: string) {
  return seedYState(config, () => {
    $getRoot().append($p(text));
  });
}
function tab(bytes: Uint8Array, swallow = false) {
  const doc = createYDoc(bytes);
  const errors: Error[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        BlockIdExtension,
        yCollab({doc, onStatus: () => {}, schemaVersion: 1, synced: true}),
      ],
      name: 'lv-review',
      onError: e => {
        errors.push(e);
        if (!swallow) throw e;
      },
      onWarn: () => {},
    }),
  );
  dispose.push(() => {
    editor.dispose();
    doc.destroy();
  });
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.collab;
  const json = () =>
    editor.read(() => editor.getEditorState().toJSON().root.children);
  return {
    binding,
    doc,
    editor,
    errors,
    json,
    text: () => json().map(textIn).join('|'),
  };
}
async function storeAt(clock: () => number) {
  const fake = createFakeIndexedDB();
  const store = unwrap(
    await openYOfflineStore({idb: fake.idb, locks: fake.locks, now: clock}),
  );
  dispose.push(() => store.close());
  return {fake, store};
}
function session(
  t: ReturnType<typeof tab>,
  store: YOfflineStore,
  clock: () => number,
  extra: Partial<Parameters<typeof attachYOfflineSession>[0]> = {},
) {
  const s = attachYOfflineSession({
    binding: t.binding,
    epoch: 'e2',
    key: 'doc',
    now: clock,
    onError: () => {},
    persistEdits: false,
    stage: 'replay',
    store,
    ...extra,
  });
  dispose.push(() => s.dispose());
  return s;
}
function capture(base: Uint8Array, yours: Uint8Array): YOfflineCapture {
  return {
    base,
    baseAt: 1000,
    capturedAt: 1000,
    claimed: false,
    differs: false,
    epoch: 'e1',
    id: 'capture',
    json: null,
    key: 'doc',
    reason: 'stale',
    state: yours,
    text: null,
  };
}
async function recover(
  t: ReturnType<typeof tab>,
  store: YOfflineStore,
  s?: YOfflineSession,
  now?: () => number,
) {
  return recoverYOfflineEdits({
    autoReplay: 'none',
    binding: t.binding,
    config,
    epoch: 'e2',
    key: 'doc',
    leftovers: {wrap: wrapLeftoversAsQuote('Offline')},
    now,
    session: s,
    stage: 'replay',
    store,
  });
}

test("P1: second synced tab must not delete another tab's unsynced resolved content", async () => {
  const base = state('server');
  const yours = state('offline content');
  const {store} = await storeAt(() => 1000);
  unwrap(await store.putCapture(capture(base, yours)));
  const a = tab(base);
  const b = tab(base);
  await tick();
  const sa = session(a, store, () => 1000);
  sa.markSynced();
  const sb = session(b, store, () => 1000);
  sb.markSynced();
  const first = unwrap(await recover(a, store, sa));
  expect(first[0].capture.resolved).toBeDefined();
  expect(a.text()).toContain('offline content');
  expect(sa.hasUnsyncedEdits).toBe(true);
  expect(b.text()).toBe('server');
  expect(sb.hasUnsyncedEdits).toBe(false);
  unwrap(await recover(b, store, sb));
  expect(
    unwrap(await store.captures('doc')),
    'content absent from server must remain recoverable',
  ).toHaveLength(1);
});

test('P1: a fresh reload must recover resolved content that was never sent to the server', async () => {
  const base = state('server');
  const yours = state('offline content');
  const {store} = await storeAt(() => 1000);
  unwrap(await store.putCapture(capture(base, yours)));
  const a = tab(base);
  await tick();
  unwrap(await recover(a, store));
  // This app persists captures only, an explicitly supported mode. Its tab closes without syncing.
  a.editor.dispose();
  const next = tab(base);
  await tick();
  const sn = session(next, store, () => 2000);
  sn.markSynced();
  // Within a minute the write may still be on its way from the tab that made it: nothing is shown, and nothing deleted.
  const soon = unwrap(await recover(next, store, sn));
  expect(next.text()).not.toContain('offline content');
  expect(
    soon.length + unwrap(await store.captures('doc')).length,
  ).toBeGreaterThan(0);
  expect(unwrap(await store.captures('doc')).length).toBe(1);
  // A minute on, the write never arrived: the capture is taken again and written here.
  const later = Date.now() + 61000;
  unwrap(await recover(next, store, sn, () => later));
  expect(
    next.text(),
    'resolved marker cannot replace document content',
  ).toContain('offline content');
});

test('P1: keep unsynced must retain markSynced baseAt rather than first-edit time', async () => {
  let now = 1000;
  const clock = () => now;
  const {store} = await storeAt(clock);
  const base = state('server');
  const a = tab(base);
  await tick();
  const s = session(a, store, clock, {
    epoch: 'e1',
    keep: 'unsynced',
    persistEdits: true,
  });
  s.markSynced();
  unwrap(await s.flush());
  now = 1000 + 7 * 24 * 3600 * 1000;
  a.editor.update(
    () => {
      $getRoot().getFirstChildOrThrow().replace($p('offline content'));
    },
    {discrete: true},
  );
  unwrap(await s.flush());
  const loaded = unwrap(await loadYOffline({epoch: 'e1', key: 'doc', store}));
  expect(
    loaded.baseAt,
    'persisting an old base is not a fresh server confirmation',
  ).toBe(1000);
});

test('P1: loading an unchanged stored base offline must not rejuvenate baseAt', async () => {
  let now = 1000;
  const clock = () => now;
  const {store} = await storeAt(clock);
  const base = state('server');
  const slot = store.slot('doc', 'e1');
  unwrap(await slot.confirm(base, 1000));
  slot.close();
  await tick();
  now = 1000 + 7 * 24 * 3600 * 1000;
  const loaded = unwrap(await loadYOffline({epoch: 'e1', key: 'doc', store}));
  expect(loaded.baseAt).toBe(1000);
  const a = tab(loaded.state!);
  await tick();
  const s = session(a, store, clock, {epoch: 'e1', loaded, persistEdits: true});
  unwrap(await s.flush());
  const again = unwrap(await loadYOffline({epoch: 'e1', key: 'doc', store}));
  expect(
    again.baseAt,
    'no new markSynced or server confirmation occurred',
  ).toBe(1000);
});

test('P1: swallowed failed replay must hand every unapplied block to the required handler', async () => {
  const base = state('server');
  const yours = state('offline content');
  const a = tab(base, true);
  await tick();
  const report = describeUnsyncedEdits({
    base,
    capturedAt: 1000,
    config,
    current: base,
    edits: {state: yours},
    reason: 'stale',
  });
  const off = a.editor.registerNodeTransform(ParagraphNode, node => {
    if (node.getTextContent() === 'offline content')
      throw new Error('review transform failure');
  });
  dispose.push(off);
  const handed: string[][] = [];
  const r = replayUnsyncedEdits({
    autoReplay: 'replayable',
    binding: a.binding,
    leftovers: {handle: blocks => handed.push(blocks.map(b => b.id))},
    report,
  });
  expect(a.text()).toBe('server');
  expect(a.errors).toHaveLength(1);
  expect(r.applied).toEqual([]);
  expect(handed, 'unapplied todo blocks are leftovers too').toEqual([['b1']]);
});

test('control: wrap throwing falls back to raw blocks', async () => {
  const base = state('server');
  const yours = state('offline content');
  const a = tab(base);
  await tick();
  const report = describeUnsyncedEdits({
    base,
    capturedAt: 1000,
    config,
    current: base,
    edits: {state: yours},
    reason: 'stale',
  });
  const r = replayUnsyncedEdits({
    autoReplay: 'none',
    binding: a.binding,
    leftovers: {
      wrap: () => {
        throw new Error('bad app wrapper');
      },
    },
    report,
  });
  expect(a.text()).toBe('server|offline content');
  expect(r.leftovers[0].fallback).toContain('wrap threw');
  expect(r.inserted).toHaveLength(1);
});

test('the state vector a resolution records is read as @y/y reads it', async () => {
  const a = tab(state('server'));
  await tick();
  for (let i = 0; i < 20; i++) {
    a.editor.update(
      () => {
        $getRoot()
          .getFirstChildOrThrow()
          .replace($p('x'.repeat(i * 300 + 1)));
      },
      {discrete: true},
    );
    const vector = Y.encodeStateVector(a.doc);
    expect(readStateVector(vector)).toEqual(Y.decodeStateVector(vector));
  }
});

// CodeBunny on #9924: past the end of the bytes the reader never returned.
test('a state vector cut short is read, as one no document holds', () => {
  const doc = new Y.Doc();
  const vector = Y.encodeStateVector(doc);
  expect(readStateVector(vector)).toEqual(new Map());
  expect(readStateVector(new Uint8Array(0)).get(0)).toBe(
    Number.MAX_SAFE_INTEGER,
  );
  // A count of one, then a client cut short.
  expect(readStateVector(new Uint8Array([1, 0x80])).get(0)).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});
