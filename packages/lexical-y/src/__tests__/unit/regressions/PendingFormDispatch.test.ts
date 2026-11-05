/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// createYQuarantineRecord takes its pending convenience form only for kind
// 'pending' with both `stored` and `pending` bytes (API review round 2,
// N6): a record of another kind that carries those keys keeps its kind and
// material, and an ambiguous 'pending' input is refused.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {
  createYQuarantineRecord,
  type YQuarantineRecordInput,
  type YRecordSource,
} from '../../../server';

const SOURCE: YRecordSource = {
  generation: 'g1:["i",[["lexical-y",null]]]',
  incarnation: 'i',
  layouts: [1, 2],
  renderer: null,
  schemaVersion: 1,
};

/** Two standalone updates: a replica's snapshot and other bytes. */
function updates(gc: boolean): [Uint8Array, Uint8Array] {
  const doc = new Y.Doc({gc});
  const out: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => out.push(u));
  doc.get('x').insert(0, 'snapshot');
  doc.get('y').insert(0, 'other');
  return [out[0], out[1]];
}

describe.each([false, true])('the pending form, gc %s', gc => {
  test('a record of an unknown kind with extra stored/pending keys keeps its kind and material', () => {
    const [snapshot, other] = updates(gc);
    const input = {
      kind: 'future-kind',
      pending: other,
      receivedAt: 1,
      snapshot,
      source: SOURCE,
      stored: other,
    };
    const record = createYQuarantineRecord(input as YQuarantineRecordInput);
    expect(record.kind).toBe('future-kind');
    expect(record.snapshot).toEqual(snapshot);
    expect(record.queue).toEqual([]);
    // The extra keys change nothing: the same record as without them.
    const {stored: _stored, pending: _pending, ...plain} = input;
    expect(record.hash).toBe(createYQuarantineRecord(plain).hash);
    // Known kinds too.
    for (const kind of ['handoff', 'capture']) {
      const known = createYQuarantineRecord({
        ...input,
        kind,
      } as YQuarantineRecordInput);
      expect(known.kind).toBe(kind);
      expect(known.snapshot).toEqual(snapshot);
    }
  });

  test("kind 'pending' with both stored and pending bytes is the pending form", () => {
    const [stored, cut] = updates(gc);
    const record = createYQuarantineRecord({
      kind: 'pending',
      pending: cut,
      receivedAt: 1,
      source: SOURCE,
      stored,
    });
    expect(record).toMatchObject({
      kind: 'pending',
      queue: [cut],
      snapshot: stored,
    });
    // A pending record given as material (as stored) is read as material.
    const asMaterial = createYQuarantineRecord({
      kind: 'pending',
      queue: [cut],
      receivedAt: 1,
      snapshot: stored,
      source: SOURCE,
    });
    expect(asMaterial.hash).toBe(record.hash);
  });

  test("an ambiguous 'pending' input is refused", () => {
    const [stored, cut] = updates(gc);
    const base = {kind: 'pending', receivedAt: 1, source: SOURCE};
    for (const bad of [
      {...base, stored},
      {...base, pending: cut},
      {...base, pending: [cut], stored},
      {...base, pending: cut, stored: 'bytes'},
      {...base, pending: cut, snapshot: stored, stored},
      {...base, pending: cut, queue: [cut], stored},
    ]) {
      expect(() =>
        createYQuarantineRecord(bad as unknown as YQuarantineRecordInput),
      ).toThrow(TypeError);
    }
  });
});
