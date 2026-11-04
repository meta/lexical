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
  keyInfoCount,
  keySlice,
  withSeeding,
  writesPairedRuns,
} from '../../../internal/Ident';

test('seeding one document leaves paired writes on in another', () => {
  const seeded = createYDoc();
  const other = createYDoc();
  const seededRoot = seeded.get('lexical-y');
  const otherRoot = other.get('lexical-y');
  expect(writesPairedRuns(seeded, seededRoot)).toBe(true);
  withSeeding(seeded, () => {
    expect(writesPairedRuns(seeded, seededRoot)).toBe(false);
    expect(writesPairedRuns(other, otherRoot)).toBe(true);
    // nested seeding of the same document
    withSeeding(seeded, () => {
      expect(writesPairedRuns(seeded, seededRoot)).toBe(false);
    });
    expect(writesPairedRuns(seeded, seededRoot)).toBe(false);
  });
  expect(writesPairedRuns(seeded, seededRoot)).toBe(true);
});

test('interned key infos stay bounded across many set member keys', () => {
  for (let i = 0; i < 20_000; i++) {
    keySlice(new Map(), `s:markIds\u001fcomment-${i}`);
  }
  expect(keyInfoCount()).toBeLessThanOrEqual(4096);
});
