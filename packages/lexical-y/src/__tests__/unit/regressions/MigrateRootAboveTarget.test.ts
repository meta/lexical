/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A root at or above the migration's target needs no step, even above this
// build's LAYOUT_VERSION (a rollback from a newer release, or a server
// upgraded after its clients): the runner and prepareYRoom return it
// unchanged instead of refusing it 'newer'. Only a root below the target
// without a chain of steps is refused.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {LAYOUT_VERSION} from '../../..';
import {migrateYDoc, migrateYState, recordedLayout} from '../../../migrate';
import {createYDoc, prepareYRoom} from '../../../server';
import {rawDoc, SEED, STAMP} from '../../utils/migrateSteps';

describe.each([false, true])('a root at or above the target, gc %s', gc => {
  const ABOVE = LAYOUT_VERSION + 3;

  test('migrateYState and migrateYDoc: unchanged, no step, the same bytes', () => {
    const state = rawDoc(ABOVE);
    for (const to of [SEED, SEED + 1, LAYOUT_VERSION, ABOVE]) {
      const result = migrateYState(state, [STAMP], {gc, to});
      expect(result.update).toBeNull();
      expect(result.pending).toBeNull();
      expect(Buffer.from(result.state)).toEqual(Buffer.from(state));
      expect(result.receipt).toMatchObject({changed: false});
    }
    const doc = createYDoc(state, {gc});
    expect(migrateYDoc(doc, [], {to: LAYOUT_VERSION}).changed).toBe(false);
    expect(recordedLayout(doc)).toBe(ABOVE);
    doc.destroy();
  });

  test('prepareYRoom on a room a newer release migrated: changed false, the stored bytes', () => {
    const state = rawDoc(ABOVE);
    const room = prepareYRoom(state, {
      gc,
      incarnation: 'inc-1',
      steps: [],
      to: LAYOUT_VERSION,
    });
    expect(room.changed).toBe(false);
    expect(room.state).toBe(state);
    expect(room.base).toBeNull();
  });

  test('a root below the target without a chain is still refused (missing-step), one at it is not', () => {
    const below = createYDoc(rawDoc(SEED), {gc});
    expect(() =>
      migrateYState(Y.encodeStateAsUpdate(below), [], {gc, to: SEED + 1}),
    ).toThrow(expect.objectContaining({code: 'missing-step'}));
    expect(
      migrateYState(Y.encodeStateAsUpdate(below), [], {gc, to: SEED}).update,
    ).toBeNull();
    below.destroy();
  });
});
