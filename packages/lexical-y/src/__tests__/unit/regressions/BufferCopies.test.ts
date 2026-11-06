/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Records and captures copy the bytes they are given into fresh storage
// (API review round 3): a Node Buffer's `.slice()` shares its storage, so
// a copy made that way changed when the caller later wrote to its Buffer.

import * as Y from '@y/y';
import {Buffer} from 'node:buffer';
import {describe, expect, test} from 'vitest';

import {
  createYQuarantineRecord,
  createYSessionCapture,
  type YRecordSource,
} from '../../../server';
import {rawDoc, SEED} from '../../utils/migrateSteps';

const SOURCE: YRecordSource = {
  generation: null,
  incarnation: null,
  layouts: null,
  renderer: null,
  schemaVersion: null,
};

/** A Buffer holding a Yjs update, and a pristine copy of its bytes. */
function bufferOf(bytes: Uint8Array): [Buffer, number[]] {
  return [Buffer.from(bytes), [...bytes]];
}

function update(gc: boolean, text: string): Uint8Array {
  const doc = new Y.Doc({gc});
  doc.get('x').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

describe.each([false, true])('byte copies, gc %s', gc => {
  test('a record keeps its own bytes when the caller writes to its Buffers afterwards', () => {
    const [snapshot, snapshotBytes] = bufferOf(update(gc, 'snapshot'));
    const [delta, deltaBytes] = bufferOf(update(gc, 'delta'));
    const [queued, queuedBytes] = bufferOf(update(gc, 'queued'));
    const signalUpdate = Buffer.from([1, 2, 3]);
    const record = createYQuarantineRecord({
      deltas: [delta],
      kind: 'handoff',
      queue: [queued],
      receivedAt: 1,
      signals: [
        {
          client: 1,
          clock: 0,
          key: 'k',
          root: 'lexical-y',
          update: signalUpdate,
        },
      ],
      snapshot,
      source: SOURCE,
    });
    snapshot.fill(0);
    delta.fill(0);
    queued.fill(0);
    signalUpdate.fill(0);
    expect([...record.snapshot!]).toEqual(snapshotBytes);
    expect([...record.deltas[0]]).toEqual(deltaBytes);
    expect([...record.queue[0]]).toEqual(queuedBytes);
    expect([...record.signals[0].update]).toEqual([1, 2, 3]);
    // The pending form copies too.
    const [stored, storedBytes] = bufferOf(update(gc, 'stored'));
    const [pending, pendingBytes] = bufferOf(update(gc, 'pending'));
    const pendingRecord = createYQuarantineRecord({
      kind: 'pending',
      pending,
      receivedAt: 1,
      source: SOURCE,
      stored,
    });
    stored.fill(0);
    pending.fill(0);
    expect([...pendingRecord.snapshot!]).toEqual(storedBytes);
    expect([...pendingRecord.queue[0]]).toEqual(pendingBytes);
  });

  test('a capture keeps its own bytes when the caller writes to its Buffers afterwards', () => {
    // A legacy client's whole document (its sync step 2), then an update.
    const [first, firstBytes] = bufferOf(rawDoc(SEED));
    const [later, laterBytes] = bufferOf(update(gc, 'later'));
    const capture = createYSessionCapture();
    capture.add(first);
    capture.add(later);
    first.fill(0);
    later.fill(0);
    const material = capture.material();
    expect([...material.snapshot!]).toEqual(firstBytes);
    expect([...material.deltas[0]]).toEqual(laterBytes);
    // Resumed from Buffers (as read back from storage), and the signal it
    // hands out.
    const signal = capture.signal(SEED)!;
    const [snapshot, snapshotBytes] = bufferOf(material.snapshot!);
    const signalUpdate = Buffer.from(signal.update);
    const resumed = createYSessionCapture({
      ...material,
      signals: [{...signal, update: signalUpdate}],
      snapshot,
    });
    snapshot.fill(0);
    signalUpdate.fill(0);
    const again = resumed.material();
    expect([...again.snapshot!]).toEqual(snapshotBytes);
    expect([...again.signals[0].update]).toEqual([...signal.update]);
  });
});
