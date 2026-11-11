/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// Paired runs' process-wide state is scoped:
// seeding suppresses paired writes only in the document being seeded, so a
// write to another document during a seed (an app listener editing another
// room) writes as that document says; and the interned key infos stay
// bounded however many set member keys (one per comment id) a process reads.

import {expect, test} from 'vitest';

import {createYDoc} from '../../..';
import {
  isSeeding,
  keyInfoCount,
  keySlice,
  withSeeding,
} from '../../../internal/Ident';

test('seeding one document leaves the writes of another as they are', () => {
  const seeded = createYDoc();
  const other = createYDoc();
  expect(isSeeding(seeded)).toBe(false);
  withSeeding(seeded, () => {
    expect(isSeeding(seeded)).toBe(true);
    expect(isSeeding(other)).toBe(false);
    // nested seeding of the same document
    withSeeding(seeded, () => {
      expect(isSeeding(seeded)).toBe(true);
    });
    expect(isSeeding(seeded)).toBe(true);
  });
  expect(isSeeding(seeded)).toBe(false);
});

test('interned key infos stay bounded across many set member keys', () => {
  for (let i = 0; i < 20_000; i++) {
    keySlice(new Map(), `s:markIds\u001fcomment-${i}`);
  }
  expect(keyInfoCount()).toBeLessThanOrEqual(4096);
});
