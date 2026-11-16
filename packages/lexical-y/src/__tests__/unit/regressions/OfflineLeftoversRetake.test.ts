/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Leftovers (D134, D136), found by review: dropping one of two equal blocks
// without text falls back to the raw blocks, and two tabs taking the same
// old claim again write the capture once (claimCapture's atomic retake).

import {
  $createHorizontalRuleNode,
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  HorizontalRuleExtension,
} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setState,
  configExtension,
  defineExtension,
} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {createYDoc, yCollab, YCollabExtension} from '../../..';
import {type HeadlessYConfig, seedYState} from '../../../headless';
import {
  openYOfflineStore,
  recoverYOfflineEdits,
  type YOfflineCapture,
  type YOfflineResult,
  type YOfflineStore,
} from '../../../offline';
import {createFakeIndexedDB} from '../../utils/fakeIndexedDB';

const config: HeadlessYConfig = {
  extensions: [BlockIdExtension, HorizontalRuleExtension],
  onWarn: () => {},
  schemaVersion: 1,
};
const clean: (() => void)[] = [];
afterEach(() => {
  for (const fn of clean.splice(0).reverse()) fn();
});
const tick = () => new Promise<void>(r => setTimeout(r, 0));
function unwrap<T>(r: YOfflineResult<T>): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
function base() {
  return seedYState(config, () => {
    $getRoot().append(
      $setState(
        $createParagraphNode().append($createTextNode('server')),
        blockIdState,
        'b1',
      ),
    );
  });
}
function yours() {
  return seedYState(config, () => {
    $getRoot().append(
      $setState(
        $createParagraphNode().append($createTextNode('server')),
        blockIdState,
        'b1',
      ),
      $setState($createHorizontalRuleNode(), blockIdState, 'hr-a'),
      $setState($createHorizontalRuleNode(), blockIdState, 'hr-b'),
    );
  });
}
function tab(bytes: Uint8Array, generateId?: () => string) {
  const doc = createYDoc(bytes);
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        generateId === undefined
          ? BlockIdExtension
          : configExtension(BlockIdExtension, {generateId}),
        HorizontalRuleExtension,
        yCollab({doc, onStatus: () => {}, schemaVersion: 1, synced: true}),
      ],
      name: 'lv-races',
      onError: e => {
        throw e;
      },
      onWarn: () => {},
    }),
  );
  clean.push(() => {
    editor.dispose();
    doc.destroy();
  });
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.collab;
  return {
    binding,
    doc,
    editor,
    json: () =>
      editor.read(() => editor.getEditorState().toJSON().root.children),
  };
}
function cap(b: Uint8Array, y: Uint8Array): YOfflineCapture {
  return {
    base: b,
    baseAt: 1000,
    capturedAt: 1000,
    claimed: false,
    differs: false,
    epoch: 'e1',
    id: 'cap',
    json: null,
    key: 'doc',
    reason: 'stale',
    state: y,
    text: null,
  };
}
async function storage(clock: () => number) {
  const fake = createFakeIndexedDB();
  const store = unwrap(
    await openYOfflineStore({idb: fake.idb, locks: fake.locks, now: clock}),
  );
  clean.push(() => store.close());
  return store;
}
function recover(
  t: ReturnType<typeof tab>,
  store: YOfflineStore,
  now: () => number,
  wrap: Parameters<typeof recoverYOfflineEdits>[0]['leftovers'],
) {
  return recoverYOfflineEdits({
    autoReplay: 'none',
    binding: t.binding,
    config,
    epoch: 'e2',
    key: 'doc',
    leftovers: wrap,
    now,
    stage: 'replay',
    store,
  });
}

test('textless decorators: dropping one of two horizontal rules must fall back and preserve both', async () => {
  const b = base();
  const y = yours();
  const store = await storage(() => 1000);
  const a = tab(b);
  await tick();
  unwrap(await store.putCapture(cap(b, y)));
  unwrap(
    await recover(a, store, () => 1000, {
      placement: 'top',
      wrap: blocks => [blocks[0].yours],
    }),
  );
  const hrs = a.json().filter(n => n.type === 'horizontalrule');
  expect(
    hrs,
    'two offline decorators require two preserved occurrences',
  ).toHaveLength(2);
});

test('stale-claim retake must be atomic across two live recovering tabs', async () => {
  let at = 1000;
  const clock = () => at;
  const b = base();
  const y = yours();
  const real = await storage(clock);
  unwrap(await real.putCapture(cap(b, y)));
  unwrap(await real.claimCapture('doc', 'cap'));
  at += 60001;
  const a = tab(b);
  const btab = tab(b);
  await tick();
  let releases = 0;
  let letSecondGo = () => {};
  const firstResolved = new Promise<void>(r => (letSecondGo = r));
  // Force an allowed interleaving: both read the stale claim, B's release transaction arrives only after A has claimed and resolved it.
  const store = new Proxy(real, {
    get(target, name) {
      if (name === 'putCapture')
        return async (c: YOfflineCapture) => {
          if (!c.claimed) {
            releases++;
            if (releases === 2) await firstResolved;
          }
          const result = await target.putCapture(c);
          if (c.resolved) letSecondGo();
          return result;
        };
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const wrap = {
    placement: 'top' as const,
    wrap: (blocks: readonly {yours: unknown}[]) =>
      blocks.map(block => block.yours),
  } as Parameters<typeof recoverYOfflineEdits>[0]['leftovers'];
  const [ra, rb] = await Promise.all([
    recover(a, store, clock, wrap),
    recover(btab, store, clock, wrap),
  ]);
  const ca = unwrap(ra)[0];
  const cb = unwrap(rb)[0];
  const writes = Number(ca.replay !== null) + Number(cb.replay !== null);
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(btab.doc), 'provider');
  await tick();
  expect(writes, 'exactly one retaking tab should claim the capture').toBe(1);
}, 10000);

// CodeBunny on #9924: the ids a recovery chose before its write came from
// the default generator, not the editor's own (which an app sets where
// crypto.getRandomValues is not a global).
test("a recovery gives its leftovers ids from the editor's own generateId", async () => {
  const b = base();
  const y = yours();
  const store = await storage(() => 1000);
  let n = 0;
  const a = tab(b, () => `app-${n++}`);
  await tick();
  unwrap(await store.putCapture(cap(b, y)));
  const [entry] = unwrap(
    await recover(a, store, () => 1000, {
      placement: 'top',
      wrap: blocks => blocks.map(block => block.yours),
    }),
  );
  expect(entry.replay!.inserted.length).toBe(2);
  for (const id of entry.replay!.inserted) {
    expect(id).toMatch(/^app-\d+$/);
  }
});

// Identity on #9924 (G-R2): a counting generateId gives the document's own
// ids again. A claim recorded them, the write skipped them, and a retake
// after a failed write found one in the document and resolved the capture
// unwritten.
test('a claim records no id the document already has, and the ids it records are the ones written', async () => {
  const b = base();
  const y = yours();
  const real = await storage(() => 1000);
  let n = 1;
  const a = tab(b, () => `b${n++}`);
  await tick();
  unwrap(await real.putCapture(cap(b, y)));
  // The mark after the write is refused: the claim and its ids stay.
  const store = new Proxy(real, {
    get(target, name) {
      if (name === 'putCapture') {
        return async (capture: YOfflineCapture) =>
          capture.resolved !== undefined
            ? {error: {code: 'failed', message: 'refused'}, ok: false}
            : target.putCapture(capture);
      }
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await recover(a, store, () => 1000, {
    placement: 'top',
    wrap: blocks => blocks.map(block => block.yours),
  });
  const [kept] = unwrap(await real.captures('doc'));
  expect(kept.claimedWrite!.ids).not.toContain('b1');
  const written = a
    .json()
    .map(node => (node as {$?: {blockId?: string}}).$?.blockId)
    .filter(id => id !== 'b1');
  expect(written).toEqual(kept.claimedWrite!.ids.slice(0, written.length));
});
