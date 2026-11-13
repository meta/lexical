/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The offline layer on layout 3 documents, on a release whose binding
// writes layout 3 (the pre-layout-4 pin), over the layout 3 states of the
// 2to3 golden fixtures, the 71 layout 3 states the 3to4 golden fixtures of
// later builds start from (`golden/offline-layout3-states.json`, copied as
// data), and every catalog node shape (with and without block ids), gc off
// and on:
//
// - the store returns the bytes it was given, and a reload of what a
//   session stored is the document;
// - edits made with no connection persist and survive a reload;
// - at the same epoch they merge into the room on sync;
// - on a moved epoch the document is frozen and captured, and the capture
//   is described against the new room (with block ids, the added block is
//   replayed into a fresh document; without, it is listed by position);
// - a base below the floor (the fixtures' layout 1 and 2 inputs) is
//   reported as gone without `migrate`, and read with it.
//
// It builds every state at this release's layout and imports no 3to4
// step, so it runs on builds whose floor is layout 3.

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
  $setState,
  defineExtension,
} from 'lexical';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {afterEach, describe, expect, test} from 'vitest';

import {createYDoc, LAYOUT_VERSION, yCollab, YCollabExtension} from '../..';
import {readYState} from '../../headless';
import {migrateYState} from '../../migrate';
import step1to2 from '../../migrate/1to2';
import step2to3 from '../../migrate/2to3';
import {
  attachYOfflineSession,
  describeYOfflineCapture,
  loadYOffline,
  openYOfflineStore,
  recoverYOfflineEdits,
  type YOfflineResult,
} from '../../offline';
import {
  catalogAppExtension,
  catalogHeadlessConfig,
  seedShapes,
} from '../catalog/bind';
import {NODE_SHAPES} from '../catalog/nodes';
import {createFakeIndexedDB} from '../utils/fakeIndexedDB';

type Cfg = Parameters<typeof catalogHeadlessConfig>[0] & {
  blockIds: 'enabled' | 'absent' | 'disabled';
};

interface Fixture {
  readonly name: string;
  readonly cfg: Cfg;
  /** The layout 3 state, by gc mode. */
  readonly state: (gc: boolean) => Uint8Array;
  /** A state below the floor and the steps that bring it up, if any. */
  readonly below: {
    readonly state: Uint8Array;
    readonly layout: number;
  } | null;
}

const golden = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'golden', 'migrate-2to3-r1.json'),
    'utf8',
  ),
) as {
  name: string;
  layout: number;
  cfg: Cfg;
  input: string;
  output: {gcOff: string; gcOn: string};
}[];

const states = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'golden', 'offline-layout3-states.json'),
    'utf8',
  ),
) as {name: string; cfg: Cfg; input: string}[];

const bytes = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));

const FIXTURES: Fixture[] = [
  ...golden.map(
    (g): Fixture => ({
      below: {layout: g.layout, state: bytes(g.input)},
      cfg: g.cfg,
      name: `from-2to3/${g.name}`,
      state: gc => bytes(gc ? g.output.gcOn : g.output.gcOff),
    }),
  ),
  ...states.map(
    (g): Fixture => ({
      below: null,
      cfg: g.cfg,
      name: `layout-3-golden/${g.name}`,
      state: () => bytes(g.input),
    }),
  ),
  ...(['enabled', 'absent'] as const).flatMap(blockIds =>
    NODE_SHAPES.map((shape): Fixture => {
      const seeded = seedShapes([shape], {blockIds});
      return {
        below: null,
        cfg: {blockIds},
        name: `catalog/${blockIds}/${shape.name}`,
        state: () => seeded,
      };
    }),
  ),
];

const STEPS = [step1to2, step2to3];
const migrateFrom = (layout: number) => (state: Uint8Array) =>
  migrateYState(state, STEPS.slice(layout - 1)).state;

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function unwrap<T>(result: YOfflineResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

const live: {dispose(): void}[] = [];
afterEach(() => {
  for (const item of live.splice(0)) {
    item.dispose();
  }
});

function client(state: Uint8Array | null, cfg: Cfg, gc: boolean) {
  const doc = createYDoc(state, {gc});
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        catalogAppExtension(cfg),
        yCollab({doc, onStatus: () => {}, schemaVersion: 1, synced: true}),
      ],
      name: 'offline-layout-3-native',
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
    /** Append a paragraph (with a block id when the app has them). */
    add: (text: string, id: string) =>
      editor.update(
        () => {
          const paragraph = $createParagraphNode().append(
            $createTextNode(text),
          );
          if (cfg.blockIds === 'enabled') {
            $setState(paragraph, blockIdState, id);
          }
          $getRoot().append(paragraph);
        },
        {discrete: true},
      ),
    binding,
    doc,
    text: () => editor.read(() => $getRoot().getTextContent()),
  };
}

const textOf = (state: Uint8Array, cfg: Cfg) =>
  readYState(state, catalogHeadlessConfig(cfg, {onWarn: () => {}}), () =>
    $getRoot().getTextContent(),
  );

test('this build writes layout 3, and there are fixtures', () => {
  expect(LAYOUT_VERSION).toBe(3);
  expect(golden.length).toBeGreaterThan(10);
  expect(states.length).toBe(71);
  expect(NODE_SHAPES.length).toBeGreaterThan(10);
});

describe.each([false, true])('layout 3 documents, gc %s', gc => {
  test.each(FIXTURES.map(f => [f.name, f] as const))(
    '%s',
    async (_name, fixture) => {
      const {cfg} = fixture;
      const state = fixture.state(gc);
      const config = catalogHeadlessConfig(cfg, {onWarn: () => {}});
      const fake = createFakeIndexedDB();
      const store = unwrap(
        await openYOfflineStore({idb: fake.idb, locks: fake.locks}),
      );

      // Stored by an earlier page at e1 (synced), now closed: the bytes
      // come back as they went in.
      const earlier = store.slot('doc', 'e1');
      unwrap(await earlier.confirm(state));
      earlier.close();
      const loaded = unwrap(await loadYOffline({key: 'doc', store}));
      expect(loaded.epoch).toBe('e1');
      expect(loaded.hasUnsyncedEdits).toBe(false);
      expect(Y.encodeStateAsUpdate(createYDoc(loaded.state, {gc}))).toEqual(
        Y.encodeStateAsUpdate(createYDoc(state, {gc})),
      );

      // This release binds it editable, and edits persist with no
      // connection.
      const tab = client(loaded.state, cfg, gc);
      await flush();
      expect(tab.binding.status).toEqual({kind: 'active'});
      const session = attachYOfflineSession({
        binding: tab.binding,
        epoch: loaded.epoch,
        key: 'doc',
        loaded,
        onError: error => {
          throw new Error(error.message);
        },
        stage: 'replay',
        store,
      });
      live.push(session);
      expect(await session.serverEpoch('e1')).toEqual({kind: 'same'});
      tab.add('offline edit', 'n1');
      unwrap(await session.flush());
      const reloaded = unwrap(await loadYOffline({key: 'doc', store}));
      expect(reloaded.hasUnsyncedEdits).toBe(true);
      expect(textOf(reloaded.state!, cfg)).toContain('offline edit');

      // Same epoch: the edit merges into the room on sync.
      const room = createYDoc(state, {gc});
      Y.applyUpdate(
        room,
        Y.encodeStateAsUpdate(tab.doc, Y.encodeStateVector(room)),
      );
      Y.applyUpdate(
        tab.doc,
        Y.encodeStateAsUpdate(room, Y.encodeStateVector(tab.doc)),
      );
      session.markSynced();
      expect(textOf(Y.encodeStateAsUpdate(room), cfg)).toContain(
        'offline edit',
      );

      // Moved epoch: frozen and captured; the new room is the original.
      tab.add('after the sync', 'n2');
      const verdict = await session.serverEpoch('e2');
      expect(verdict.kind).toBe('moved');
      if (verdict.kind !== 'moved') {
        return;
      }
      expect(verdict.saved.ok).toBe(true);
      expect(verdict.capture).not.toBeNull();
      expect(tab.binding.status).toMatchObject({kind: 'readonly'});
      const capture = verdict.capture!;
      const report = unwrap(
        describeYOfflineCapture(capture, {config, current: state}),
      );
      expect(report.baseAvailable).toBe(true);
      const added = report.blocks.filter(block =>
        JSON.stringify(block.yours).includes('after the sync'),
      );
      expect(added.length).toBe(1);
      expect(
        report.blocks.some(block =>
          JSON.stringify(block.yours).includes('offline edit'),
        ),
      ).toBe(false);

      // Recovery on a fresh document at e2.
      const fresh = client(state, cfg, gc);
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
      if (cfg.blockIds === 'enabled') {
        expect(recovered[0].replay!.applied).toEqual(['n2']);
        expect(fresh.text()).toContain('after the sync');
      } else {
        expect(added[0].replayable).toBe(false);
        expect(added[0].id).toMatch(/^#\d+$/);
        expect(fresh.text()).not.toContain('after the sync');
      }

      // A base below the floor.
      if (fixture.below !== null) {
        const old = {...capture, base: fixture.below.state};
        const without = unwrap(
          describeYOfflineCapture(old, {config, current: state}),
        );
        expect(without.baseAvailable).toBe(false);
        expect(without.blocks.every(block => !block.replayable)).toBe(true);
        const withMigrate = unwrap(
          describeYOfflineCapture(old, {
            config,
            current: state,
            migrate: migrateFrom(fixture.below.layout),
          }),
        );
        expect(withMigrate.baseAvailable).toBe(true);
      }
    },
  );
});
