/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Leftovers (D134), found by review: a wrapper's output must hold each block
// without text as a node of its own, in order (two equal blocks need two),
// and an old copy is not replayed by itself under maxBaseAge.

import {
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setState,
  defineExtension,
  type SerializedLexicalNode,
} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {createYDoc, yCollab, YCollabExtension} from '../../..';
import {
  describeUnsyncedEdits,
  type HeadlessYConfig,
  seedYState,
} from '../../../headless';
import {
  attachYOfflineSession,
  openYOfflineStore,
  recoverYOfflineEdits,
  replayUnsyncedEdits,
  wrapLeftoversAsQuote,
  type YOfflineResult,
} from '../../../offline';
import {createFakeIndexedDB} from '../../utils/fakeIndexedDB';

const config: HeadlessYConfig = {
  extensions: [BlockIdExtension],
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
const $p = (text: string, id: string) =>
  $setState(
    $createParagraphNode().append($createTextNode(text)),
    blockIdState,
    id,
  );
const seed = (pairs: [string, string][]) =>
  seedYState(config, () => {
    $getRoot().append(...pairs.map(([text, id]) => $p(text, id)));
  });
function tab(bytes: Uint8Array) {
  const doc = createYDoc(bytes);
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        BlockIdExtension,
        yCollab({doc, onStatus: () => {}, schemaVersion: 1, synced: true}),
      ],
      name: 'lv-additional',
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

test('baseAt policy: seven-day-old keep-unsynced base must not qualify for three-day autoReplay after reload', async () => {
  let now = 1000;
  const clock = () => now;
  const fake = createFakeIndexedDB();
  const store = unwrap(
    await openYOfflineStore({idb: fake.idb, locks: fake.locks, now: clock}),
  );
  clean.push(() => store.close());
  const base = seed([['server', 'b1']]);
  const a = tab(base);
  await tick();
  const s = attachYOfflineSession({
    binding: a.binding,
    epoch: 'e1',
    keep: 'unsynced',
    key: 'doc',
    now: clock,
    onError: () => {},
    stage: 'persist',
    store,
  });
  clean.push(() => s.dispose());
  s.markSynced();
  unwrap(await s.flush());
  now += 7 * 24 * 3600 * 1000;
  a.editor.update(
    () => {
      $getRoot().getFirstChildOrThrow().replace($p('offline content', 'b1'));
    },
    {discrete: true},
  );
  unwrap(await s.flush());
  s.dispose();
  await tick();
  const fresh = tab(base);
  await tick();
  const result = unwrap(
    await recoverYOfflineEdits({
      autoReplay: {maxBaseAge: 3 * 24 * 3600 * 1000},
      binding: fresh.binding,
      config,
      epoch: 'e2',
      key: 'doc',
      leftovers: {wrap: wrapLeftoversAsQuote('Offline')},
      now: clock,
      stage: 'replay',
      store,
    }),
  );
  expect(
    result[0].replay?.applied,
    'old base must be routed to wrap, not overwrite server block',
  ).toEqual([]);
});

test('wrapper validation must count two identical textless blocks, not allow a single copy', async () => {
  const base = seed([['server', 'b1']]);
  const yours = seed([
    ['server', 'b1'],
    ['', 'empty-a'],
    ['', 'empty-b'],
  ]);
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
  expect(report.blocks).toHaveLength(2);
  const r = replayUnsyncedEdits({
    autoReplay: 'none',
    binding: a.binding,
    leftovers: {placement: 'top', wrap: blocks => [blocks[0].yours]},
    report,
  });
  expect(
    r.leftovers[0].fallback,
    'wrapper dropped the second block',
  ).not.toBeNull();
  expect(a.json()).toHaveLength(3);
});

test('wrapper validation must reject reordered textless blocks', async () => {
  const base = seed([['server', 'b1']]);
  const yours = seed([
    ['server', 'b1'],
    ['', 'empty-a'],
  ]);
  const a = tab(base);
  await tick();
  // Textless paragraphs have different formatting; both must appear in their original order.
  a.editor.update(
    () => {
      $getRoot().append(
        $setState(
          $createParagraphNode().setFormat('right'),
          blockIdState,
          'empty-b',
        ),
      );
    },
    {discrete: true},
  );
  const local = tab(yours);
  await tick();
  local.editor.update(
    () => {
      $getRoot().append(
        $setState(
          $createParagraphNode().setFormat('right'),
          blockIdState,
          'empty-b',
        ),
      );
    },
    {discrete: true},
  );
  const report = describeUnsyncedEdits({
    base,
    capturedAt: 1000,
    config,
    current: base,
    edits: {json: local.editor.getEditorState().toJSON()},
    reason: 'stale',
  });
  const fresh = tab(base);
  await tick();
  const r = replayUnsyncedEdits({
    autoReplay: 'none',
    binding: fresh.binding,
    leftovers: {
      placement: 'top',
      wrap: blocks => [...blocks].reverse().map(b => b.yours!),
    },
    report,
  });
  expect(
    r.leftovers[0].fallback,
    'empty-a and empty-b reversed',
  ).not.toBeNull();
});

// CodeBunny on #9924: a block's text was searched in the joined text of the
// whole output, label included, so a wrapper that returned only its label
// passed for a block whose text is a word of the label.
test('wrapper validation must not find a block in the label: a block whose text is a word of the label, dropped by the wrapper, falls back', async () => {
  const base = seed([['server', 'b1']]);
  const yours = seed([
    ['server', 'b1'],
    ['merge', 'n1'],
  ]);
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
  const label = wrapLeftoversAsQuote('Offline edits that did not merge');
  const r = replayUnsyncedEdits({
    autoReplay: 'none',
    binding: a.binding,
    leftovers: {
      placement: 'top',
      // Only the label: the block is dropped.
      wrap: (blocks, context) => label(blocks, context).slice(0, 1),
    },
    report,
  });
  expect(r.leftovers[0].fallback).toMatch(
    /does not hold the text of block n1 as a node of its own/,
  );
  expect(
    a.json().filter(node => JSON.stringify(node).includes('"merge"')),
  ).toHaveLength(1);
});

test('wrapper validation must not count one node for two blocks of the same text', async () => {
  const base = seed([['server', 'b1']]);
  const yours = seed([
    ['server', 'b1'],
    ['same', 'n1'],
    ['same', 'n2'],
  ]);
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
    leftovers: {placement: 'top', wrap: blocks => [blocks[0].yours]},
    report,
  });
  expect(r.leftovers[0].fallback).toMatch(/does not hold the text of block n2/);
  expect(a.json()).toHaveLength(3);
});

// Identity on #9924: a wrapper that rebuilt a block from its text passed and
// dropped what the block holds besides text (a line break, an inline
// decorator).
test('wrapper validation must not pass a block rebuilt from its text: what it holds besides text is kept', async () => {
  const base = seed([['server', 'b1']]);
  const yours = seedYState(config, () => {
    $getRoot().append(
      $p('server', 'b1'),
      $setState(
        $createParagraphNode().append(
          $createTextNode('a'),
          $createLineBreakNode(),
          $createTextNode('b'),
        ),
        blockIdState,
        'n1',
      ),
    );
  });
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
      placement: 'top',
      // Rebuilt from its text: the line break is gone.
      wrap: blocks =>
        blocks.map(
          block =>
            ({
              children: [
                {
                  detail: 0,
                  format: 0,
                  mode: 'normal',
                  style: '',
                  text: (
                    block.yours as unknown as {children: {text?: string}[]}
                  ).children
                    .map(child => child.text ?? '')
                    .join(''),
                  type: 'text',
                  version: 1,
                },
              ],
              direction: null,
              format: '',
              indent: 0,
              type: 'paragraph',
              version: 1,
            }) as SerializedLexicalNode,
        ),
    },
    report,
  });
  expect(r.leftovers[0].fallback).toMatch(
    /does not hold the text of block n1 as a node of its own/,
  );
  expect(JSON.stringify(a.json())).toContain('"linebreak"');
});
