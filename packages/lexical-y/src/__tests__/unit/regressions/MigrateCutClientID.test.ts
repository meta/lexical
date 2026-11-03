/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The migration's client id names nothing of the input's history (code
// review round 2, M1), split material included: with the shipped 1to2
// step, an old client whose id is the hash the migration would take for
// the kept prefix, with a skipped first clock and live text past it (cut,
// with G and S that depend on it). The migration takes another id, the
// state and the split material give each id one payload, the
// reconstruction holds everything, and a completed pending record is
// actionable against the migrated state.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {migrateYState} from '../../../migrate';
import step1to2 from '../../../migrate/1to2';
import {
  createYDoc,
  quarantineRecord,
  type YRecordSource,
} from '../../../server';
import {SEED} from '../../utils/migrateSteps';
import {textOf, unitDump} from '../../utils/splitFixtures';

const SOURCE: YRecordSource = {
  generation: 'i/-',
  incarnation: 'i',
  layouts: [1, 2],
  renderer: 'r',
  schemaVersion: 1,
};

function base(gc: boolean): Uint8Array {
  const d = createYDoc(null, {gc});
  d.clientID = 100;
  const root = d.get('lexical-y');
  root.setAttr('lexical-y:1', true);
  root.setAttr('lexical-y-schema:1', true);
  root.insert(0, 'base');
  const out = Y.encodeStateAsUpdate(d);
  d.destroy();
  return out;
}

const firstClient = (r: ReturnType<typeof migrateYState>) =>
  r.receipt.roots[0].steps[0].client;

describe.skipIf(SEED !== 1)('cut client ids', () => {
  for (const gc of [false, true]) {
    for (const clientIDRange of ['uint53', 'uint32'] as const) {
      test(`gc ${gc}, ${clientIDRange}: the hash of the kept prefix, held by cut material, is not taken`, () => {
        const S = base(gc);
        const options = {clientIDRange, gc, to: 2};
        const oldClient = firstClient(migrateYState(S, [step1to2], options));
        const author = createYDoc(S, {gc});
        author.clientID = oldClient;
        const updates: Uint8Array[] = [];
        author.on('update', (u: Uint8Array) => updates.push(u));
        author.get('unseen').insert(0, 'm');
        author.get('lexical-y').insert(4, 'LATE');
        const stored = createYDoc(S, {gc});
        Y.applyUpdate(stored, updates[1]);
        const peer = createYDoc(Y.encodeStateAsUpdate(stored), {gc});
        peer.clientID = oldClient === 333 ? 334 : 333;
        const more: Uint8Array[] = [];
        peer.on('update', (u: Uint8Array) => more.push(u));
        peer.get('lexical-y').insert(4, 'G');
        peer.get('side').insert(0, 'S');
        more.forEach(u => Y.applyUpdate(stored, u));
        expect(stored.store.skips.isEmpty()).toBe(false);
        const input = Y.encodeStateAsUpdate(stored);
        const result = migrateYState(input, [step1to2], options);
        const client = firstClient(result);
        expect(client).not.toBe(oldClient);
        expect(stored.store.clients.has(client)).toBe(false);
        if (clientIDRange === 'uint32') {
          expect(client).toBeLessThanOrEqual(0xffffffff);
        }
        const out = createYDoc(result.state, {gc});
        expect(out.store.clients.has(oldClient)).toBe(false);
        Y.applyUpdate(out, result.pending!);
        Y.applyUpdate(out, updates[0]);
        const control = createYDoc(input, {gc});
        Y.applyUpdate(control, updates[0]);
        expect(unitDump(out)).toEqual(unitDump(control));
        expect(textOf(out.get('lexical-y'))).toBe(
          textOf(control.get('lexical-y')),
        );
        expect(textOf(out.get('unseen'))).toBe('m');
        [author, stored, peer, out, control].forEach(d => d.destroy());
      });
    }

    test(`gc ${gc}: a completed pending record of the cut client is actionable against the migrated state`, () => {
      const S = base(gc);
      const options = {gc, to: 2};
      const oldClient = firstClient(migrateYState(S, [step1to2], options));
      const author = createYDoc(S, {gc});
      author.clientID = oldClient;
      const updates: Uint8Array[] = [];
      author.on('update', (u: Uint8Array) => updates.push(u));
      author.get('unseen').insert(0, 'm');
      author.get('lexical-y').insert(4, 'L');
      const stored = createYDoc(S, {gc});
      Y.applyUpdate(stored, updates[1]);
      const input = Y.encodeStateAsUpdate(stored);
      const result = migrateYState(input, [step1to2], options);
      expect(firstClient(result)).not.toBe(oldClient);
      const completed = quarantineRecord(
        {
          deltas: [updates[0]],
          kind: 'pending',
          queue: [result.pending!],
          receivedAt: 1,
          snapshot: input,
          source: SOURCE,
        },
        {generation: 'i/new', state: result.state},
      );
      expect(completed.complete).toBe(true);
      expect(completed.actionable).toBe(true);
      [author, stored].forEach(d => d.destroy());
    });

    test(`gc ${gc}: the clientID allocator may not give a client of the cut material`, () => {
      const S = base(gc);
      const author = createYDoc(S, {gc});
      author.clientID = 4242;
      const updates: Uint8Array[] = [];
      author.on('update', (u: Uint8Array) => updates.push(u));
      author.get('unseen').insert(0, 'm');
      author.get('lexical-y').insert(4, 'L');
      const stored = createYDoc(S, {gc});
      Y.applyUpdate(stored, updates[1]);
      expect(() =>
        migrateYState(Y.encodeStateAsUpdate(stored), [step1to2], {
          clientID: () => 4242,
          gc,
          to: 2,
        }),
      ).toThrow(/not a free client id/);
      [author, stored].forEach(d => d.destroy());
    });
  }
});
