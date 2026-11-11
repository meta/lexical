/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Fuzz seeds with BlockIdExtension where an author's editor held one id on a
// top-level list and on its nested item (a copy) when it wrote them: readers
// give the item its derived id, so the author reads those containers again
// and shows the same (before: a self-check warning on the author, and in
// seed 890 a list id that differed between clients at the end).
import '../utils/blockIdsEnv';

import {expect, test} from 'vitest';

import {genScript, runScript} from '../utils/fuzz';
import {WITH_BLOCK_IDS} from '../utils/harness';

delete process.env.LEXICAL_Y_BLOCK_ID;

test.each([21, 24, 124, 890])('seed %i with block ids', seed => {
  expect(WITH_BLOCK_IDS).toBe(true);
  const res = runScript(genScript(seed, {moves: false}));
  const sigs = res.failures
    .map(f => f.sig)
    .filter(
      s =>
        !s.startsWith('limit:') &&
        !s.startsWith('nit:') &&
        s !== 'loss(container)',
    );
  expect(sigs).toEqual([]);
});
