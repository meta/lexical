/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// hasNewYEdits compares the ids each side actually holds (code review round
// 1, M3): a base with a skipped range does not hide a replica's text in
// that range, and a replica behind its base (a shorter prefix of a client's
// clocks) is compared without throwing.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {
  createYDoc,
  hasNewYEdits,
  quarantineRecord,
  type YRecordSource,
} from '../../../server';
import {rawDoc} from '../../utils/migrateSteps';

const SOURCE: YRecordSource = {
  generation: 'i/-',
  incarnation: 'i',
  layouts: [1, 2],
  renderer: 'r',
  schemaVersion: 1,
};
const material = (snapshot: Uint8Array) => ({
  deltas: [],
  draft: null,
  queue: [],
  signals: [],
  snapshot,
});

describe.each([false, true])('hasNewYEdits by held ids, gc %s', gc => {
  test('a complete replica filling a range its base skipped has new edits', () => {
    const initial = createYDoc(null, {gc});
    initial.clientID = 100;
    initial.get('lexical-y').setAttr('lexical-y:2', true);
    initial.get('lexical-y').setAttr('lexical-y-schema:1', true);
    initial.get('lexical-y').insert(0, 'base');
    const start = Y.encodeStateAsUpdate(initial);
    const replica = createYDoc(start, {gc});
    replica.clientID = 222;
    const sent: Uint8Array[] = [];
    replica.on('update', (u: Uint8Array) => sent.push(u));
    replica.get('lexical-y').insert(0, 'MISSING');
    replica.get('lexical-y').insert(replica.get('lexical-y').length, 'LATE');
    // The base received only the later update: MISSING is skipped.
    const authority = createYDoc(start, {gc});
    Y.applyUpdate(authority, sent[1]);
    expect(authority.store.skips.isEmpty()).toBe(false);
    const base = Y.encodeStateAsUpdate(authority);
    const snapshot = Y.encodeStateAsUpdate(replica);
    expect(hasNewYEdits(material(snapshot), base)).toBe(true);
    const record = quarantineRecord(
      {kind: 'handoff', receivedAt: 1, snapshot, source: SOURCE},
      {generation: 'i/-', state: base},
    );
    expect(record.complete).toBe(true);
    expect(record.actionable).toBe(true);
    [initial, replica, authority].forEach(d => d.destroy());
  });

  test('a replica holding the same ids as a complete base, skipped ranges absent on both, has none', () => {
    const doc = createYDoc(rawDoc(1), {gc});
    const state = Y.encodeStateAsUpdate(doc);
    expect(hasNewYEdits(material(state), state)).toBe(false);
    doc.destroy();
  });

  test('a replica behind its base (a shorter prefix of one client) has no new edits and does not throw', () => {
    const doc = createYDoc(rawDoc(1), {gc});
    const snapshot = Y.encodeStateAsUpdate(doc);
    doc.clientID = 80;
    doc.get('lexical-y').insert(0, 'SERVER');
    const base = Y.encodeStateAsUpdate(doc);
    expect(hasNewYEdits(material(snapshot), base)).toBe(false);
    // And with its own later edit (another client) and a deletion of an
    // item both hold: new.
    const replica = createYDoc(snapshot, {gc});
    replica.clientID = 81;
    replica.get('lexical-y').insert(0, 'X');
    expect(hasNewYEdits(material(Y.encodeStateAsUpdate(replica)), base)).toBe(
      true,
    );
    const deleting = createYDoc(snapshot, {gc});
    deleting.clientID = 82;
    deleting.get('lexical-y').delete(0, 1);
    expect(hasNewYEdits(material(Y.encodeStateAsUpdate(deleting)), base)).toBe(
      true,
    );
    [doc, replica, deleting].forEach(d => d.destroy());
  });

  test('a deletion of an id only the replica holds is its own new edit, not a deletion the base lacks', () => {
    const doc = createYDoc(rawDoc(1), {gc});
    const base = Y.encodeStateAsUpdate(doc);
    const replica = createYDoc(base, {gc});
    replica.clientID = 90;
    replica.get('lexical-y').insert(0, 'tmp');
    replica.get('lexical-y').delete(0, 3);
    // Made and removed while apart: nothing shows; the base lacks the ids.
    expect(hasNewYEdits(material(Y.encodeStateAsUpdate(replica)), base)).toBe(
      true,
    );
    [doc, replica].forEach(d => d.destroy());
  });
});
