/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// D135: a migration's pending material is never in the migrated state, and
// the caller cannot take that state without seeing it. Before, `pending` was
// a field beside `state`, and a caller that kept `.state` (a reader of a
// migrated copy did) dropped it without a compile error. Now:
// - migrateYState requires `pending: 'return' | 'discard'`; with `'return'`
//   the result is a union on `split`, and where it is split the migrated
//   state is `integrated` beside `pending`, so `.state` does not compile
//   until the caller narrows; with `'discard'` it is never split, and the
//   receipt's `pendingBytes` says what was dropped; from JavaScript a call
//   without the choice throws, naming it.
// - prepareYRoom (the authority's store path) always returns the material,
//   inside `write`, which exists only where `changed` is true.

import {describe, expect, expectTypeOf, test} from 'vitest';

import {migrateYState, type YMigrationResult} from '../../../migrate';
import {prepareYRoom, type YPreparedRoom} from '../../../server';
import {stamp} from '../../utils/migrateSteps';
import {rightOriginSplit} from '../../utils/splitFixtures';

describe.each([false, true])('the pending material, gc %s', gc => {
  test("migrateYState 'return': split, the material beside the migrated state", () => {
    const {stored} = rightOriginSplit(gc);
    const result = migrateYState(stored, [stamp(2)], {
      gc,
      pending: 'return',
      to: 3,
    });
    // @ts-expect-error -- the state is reached only after narrowing on split.
    void result.state;
    expect(result.split).toBe(true);
    if (!result.split) {
      return;
    }
    expect(result.pending.byteLength).toBeGreaterThan(0);
    expect(result.receipt.pendingBytes).toBe(result.pending.byteLength);

    const discarded = migrateYState(stored, [stamp(2)], {
      gc,
      pending: 'discard',
      to: 3,
    });
    expectTypeOf(discarded).toEqualTypeOf<
      Extract<YMigrationResult, {readonly split: false}>
    >();
    expect(discarded.split).toBe(false);
    // The migrated state is the same either way; the receipt says how much
    // was dropped.
    expect(discarded.state).toEqual(result.integrated);
    expect(discarded.receipt.pendingBytes).toBe(result.pending.byteLength);
  });

  test('migrateYState: the choice is required, and enforced for JavaScript callers', () => {
    const {stored} = rightOriginSplit(gc);
    expect(() =>
      // @ts-expect-error -- `pending` is required: the call must decide.
      migrateYState(stored, [stamp(2)], {gc, to: 3}),
    ).toThrow(/migrateYState needs options\.pending .*'return'.*'discard'/);
    expect(() =>
      // @ts-expect-error -- and so are the options.
      migrateYState(stored, [stamp(2)]),
    ).toThrow(TypeError);
  });

  test('prepareYRoom: what to store is one object, the material in it', () => {
    const {stored} = rightOriginSplit(gc);
    const prepared = prepareYRoom(stored, {
      gc,
      incarnation: 'i',
      steps: [stamp(2)],
      to: 3,
    });
    // @ts-expect-error -- `write` exists only where `changed` is true.
    void prepared.write;
    expect(prepared.changed).toBe(true);
    if (!prepared.changed) {
      return;
    }
    expectTypeOf(prepared.write.pending).toEqualTypeOf<Uint8Array | null>();
    expect(prepared.write.pending).not.toBeNull();
    expect(prepared.write.base.state).toBe(stored);
    // @ts-expect-error -- no 'discard' on the authority's store path.
    void prepareYRoom(stored, {gc, incarnation: 'i', pending: 'discard'});
    expectTypeOf<
      Extract<YPreparedRoom, {readonly changed: false}>
    >().not.toHaveProperty('write');
  });
});
