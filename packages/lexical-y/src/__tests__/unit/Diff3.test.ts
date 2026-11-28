/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The vendored node-diff3 (internal/Diff3.ts, 4.0.0, whose LCS is a
// rewrite of 3.x's) against a dynamic-programming LCS: the LCS it returns
// is a common subsequence of the longest length, and diffIndices rebuilds
// the second sequence from the first.

import {expect, test} from 'vitest';

import {diffIndices, LCS} from '../../internal/Diff3';

test('LCS is a longest common subsequence, and diffIndices rebuilds the second sequence', () => {
  let seed = 825643;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let round = 0; round < 3000; round++) {
    const values = 2 + (round % 4);
    const a = Array.from({length: random() % 60}, () =>
      String(random() % values),
    );
    const b = Array.from({length: random() % 60}, () =>
      String(random() % values),
    );
    let row: number[] = new Array(b.length + 1).fill(0);
    for (const item of a) {
      const next = [0];
      for (let j = 0; j < b.length; j++) {
        next.push(item === b[j] ? row[j] + 1 : Math.max(next[j], row[j + 1]));
      }
      row = next;
    }
    let length = 0;
    let i = a.length;
    let j = b.length;
    for (
      let match: ReturnType<typeof LCS> | null = LCS(a, b);
      match !== null && match.buffer1index >= 0;
      match = match.chain
    ) {
      expect(match.buffer1index).toBeLessThan(i);
      expect(match.buffer2index).toBeLessThan(j);
      expect(a[match.buffer1index]).toBe(b[match.buffer2index]);
      i = match.buffer1index;
      j = match.buffer2index;
      length++;
    }
    expect(length).toBe(row[b.length]);
    const rebuilt: string[] = [];
    let at = 0;
    for (const hunk of diffIndices(a, b)) {
      rebuilt.push(...a.slice(at, hunk.buffer1[0]), ...hunk.buffer2Content);
      at = hunk.buffer1[0] + hunk.buffer1[1];
    }
    rebuilt.push(...a.slice(at));
    expect(rebuilt).toEqual(b);
  }
});
