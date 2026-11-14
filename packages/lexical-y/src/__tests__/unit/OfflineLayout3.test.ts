/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The offline layer on layout 3 documents, as a layout 4 release meets
// them: a document an older release stored locally, whose server has since
// migrated it (3to4) and moved its epoch. Over every layout 3 state of the
// 3to4 golden fixtures, gc off and on:
//
// - the store keeps and returns the bytes whatever their layout;
// - a session on the document (read only here: below the floor) freezes
//   and captures it when the epoch moves;
// - the capture is described against the migrated document once
//   `migrate` brings its states up, and without `migrate` the base is
//   reported as gone (or, for a capture from storage alone, the error
//   names `migrate`).
//
// This file needs the 3to4 step and its fixtures, so it belongs to builds
// with layout 4; OfflineSession.test.ts covers the same flows relative to
// the build's own floor.

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import * as Y from '@y/y';
import {defineExtension} from 'lexical';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {createYDoc, yCollab, YCollabExtension} from '../..';
import {migrateYState} from '../../migrate';
import step3to4 from '../../migrate/3to4';
import step4to5 from '../../migrate/4to5';
import {
  attachYOfflineSession,
  describeYOfflineCapture,
  loadYOffline,
  openYOfflineStore,
  type YOfflineCapture,
} from '../../offline';
import {catalogAppExtension, catalogHeadlessConfig} from '../catalog/bind';
import {createFakeIndexedDB} from '../utils/fakeIndexedDB';

type Golden = {
  name: string;
  layout: number;
  input: string;
  cfg: Parameters<typeof catalogHeadlessConfig>[0];
};

const fixtures = (
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, 'golden', 'migrate-3to4-r1.json'),
      'utf8',
    ),
  ) as Golden[]
).filter(f => f.layout === 3);

/**
 * Fixtures a raw writer made (an array under a flat NodeState name), which
 * read differently before and after 3to4 (D103's exception, pinned in
 * BelowFloorDisplayEqualsMigratedRead.test.ts): the report lists that
 * difference, so they are checked for a report, not for an empty one.
 */
const RAW = /^raw\//;

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const migrate = (state: Uint8Array) =>
  migrateYState(state, [step3to4, step4to5]).state;

function unwrap<T>(
  result: {ok: true; value: T} | {ok: false; error: {message: string}},
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

test('the fixtures hold layout 3 states', () => {
  expect(fixtures.length).toBeGreaterThan(20);
});

describe.each([false, true])('layout 3 documents, gc %s', gc => {
  test.each(fixtures.map(f => [f.name, f] as const))(
    '%s',
    async (_name, fixture) => {
      const state = new Uint8Array(Buffer.from(fixture.input, 'base64'));
      const config = catalogHeadlessConfig(fixture.cfg, {onWarn: () => {}});
      const fake = createFakeIndexedDB();
      const store = unwrap(
        await openYOfflineStore({idb: fake.idb, locks: fake.locks}),
      );

      // Stored by the older release at e1, synced.
      // Stored by an earlier page, now closed.
      const earlier = store.slot('doc', 'e1');
      unwrap(await earlier.confirm(state));
      earlier.close();
      const loaded = unwrap(await loadYOffline({key: 'doc', store}));
      expect(loaded.epoch).toBe('e1');
      const doc = createYDoc(loaded.state, {gc});
      const direct = createYDoc(state, {gc});
      expect(Y.encodeStateAsUpdate(doc)).toEqual(Y.encodeStateAsUpdate(direct));

      // This release binds it read only, and the session attaches.
      const editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            catalogAppExtension(fixture.cfg),
            yCollab({doc, onStatus: () => {}, schemaVersion: 1, synced: true}),
          ],
          name: 'offline-layout-3',
          onWarn: () => {},
        }),
      );
      try {
        await flush();
        const {collab} = getExtensionDependencyFromEditor(
          editor,
          YCollabExtension,
        ).output;
        expect(collab.status).toMatchObject({
          cause: {code: 'layout-older', layout: 3},
        });
        const session = attachYOfflineSession({
          binding: collab,
          epoch: loaded.epoch,
          key: 'doc',
          loaded,
          onError: error => {
            throw new Error(error.message);
          },
          persistEdits: true,
          stage: 'persist',
          store,
        });
        // The server migrated the room: nothing unsynced, nothing kept.
        const verdict = await session.serverEpoch('e2');
        expect(verdict).toMatchObject({capture: null, kind: 'moved'});
        expect(unwrap(await store.slots('doc'))).toEqual([]);

        // Had it held edits, this is its capture: what the editor shows,
        // the layout 3 state and base.
        const current = migrate(state);
        const frozen = collab.freeze();
        const capture: YOfflineCapture = {
          base: state,
          capturedAt: 1,
          claimed: false,
          differs: frozen.differs,
          epoch: 'e1',
          id: 'c1',
          json: frozen.json,
          key: 'doc',
          reason: 'stale',
          state: frozen.state,
          text: frozen.text,
        };
        // Without migrate: the base is reported as gone.
        const without = unwrap(
          describeYOfflineCapture(capture, {config, current}),
        );
        expect(without.baseAvailable).toBe(false);
        expect(without.blocks.every(block => !block.replayable)).toBe(true);
        // With it: read against the base, and nothing differs.
        const report = unwrap(
          describeYOfflineCapture(capture, {config, current, migrate}),
        );
        expect(report.baseAvailable).toBe(true);
        if (!RAW.test(fixture.name)) {
          expect(report.blocks).toEqual([]);
        }
        // From storage alone (no JSON).
        const stored = {...capture, json: null, text: null};
        const refused = describeYOfflineCapture(stored, {config, current});
        expect(!refused.ok && refused.error.message).toMatch(
          /Pass options\.migrate/,
        );
        const fromState = unwrap(
          describeYOfflineCapture(stored, {config, current, migrate}),
        );
        expect(fromState.baseAvailable).toBe(true);
        expect(fromState.blocks).toEqual([]);
      } finally {
        editor.dispose();
      }
    },
  );
});
