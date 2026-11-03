/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A migration's pending material has a self-contained quarantine record
// (code review round 1, S2): split bytes alone render nothing, so
// pendingYRecord keeps the stored state they were split from as its
// snapshot. The fixture is the review's right-origin split: G (client 333)
// has its left origin in client 100 and its right origin in client 222's
// suffix past a gap; S is a later item of 333 in another root.

import {describe, expect, test} from 'vitest';

import {migrateYState} from '../../../migrate';
import {pendingYRecord, sourceView, type YRecordSource} from '../../../server';
import {stamp} from '../../utils/migrateSteps';
import {rightOriginSplit, textOf} from '../../utils/splitFixtures';

const SOURCE: YRecordSource = {
  generation: 'i/-',
  incarnation: 'i',
  layouts: [1, 2],
  renderer: null,
  schemaVersion: 1,
};

describe.each([false, true])('pending records, gc %s', gc => {
  test('the split bytes alone render nothing; the pending record renders the cut items in place', () => {
    const {stored, missing, docs} = rightOriginSplit(gc);
    const result = migrateYState(stored, [stamp(2)], {gc, to: 3});
    expect(result.pending).not.toBeNull();
    const alone = sourceView({deltas: [], queue: [], snapshot: result.pending});
    expect(alone.complete).toBe(false);
    expect(textOf(alone.doc.get('lexical-y'))).toBe('');
    alone.doc.destroy();

    const record = pendingYRecord(
      {pending: result.pending!, receivedAt: 1, source: SOURCE, stored},
      {generation: 'i/2', state: result.state},
    );
    expect(record.kind).toBe('pending');
    // The raw export carries the pre-split bytes and the cut bytes.
    expect(record.snapshot).toEqual(stored);
    expect(record.queue).toEqual([result.pending]);
    // The stored state itself lacked client 222's prefix: incomplete, and
    // actionable against the migrated state (which lacks the cut items).
    expect(record.complete).toBe(false);
    expect(record.actionable).toBe(true);
    const view = sourceView(record);
    expect(textOf(view.doc.get('lexical-y'))).toBe('baseGLATE');
    expect(textOf(view.doc.get('side'))).toBe('S');
    view.doc.destroy();
    // The missing prefix, appended as a delta, completes it.
    const completed = sourceView({...record, deltas: [missing]});
    expect(completed.complete).toBe(true);
    expect(textOf(completed.doc.get('unseen'))).toBe('missing');
    completed.doc.destroy();
    docs.forEach(d => d.destroy());
  });
});
