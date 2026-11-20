/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Minimized fuzz scripts of fixed failures (divergence, fresh-reader
// mismatch, lost or duplicated text, a hang, an exception), replayed.

import * as fs from 'fs';
import * as path from 'path';
import {expect, test} from 'vitest';

import {runScript, type Script} from '../utils/fuzz';

const DIR = path.join(__dirname, '..', 'fuzz');
const files = fs
  .readdirSync(DIR)
  .filter(f => f.endsWith('.json'))
  .sort();

test.each(files)('replay %s', file => {
  const script: Script = JSON.parse(
    fs.readFileSync(path.join(DIR, file), 'utf8'),
  );
  const prev = process.env.FUZZ_GC;
  process.env.FUZZ_GC = file.startsWith('gc-') ? '1' : '';
  try {
    const res = runScript(script);
    expect(
      res.failures
        .map(f => f.sig)
        .filter(s => !s.startsWith('limit:') && !s.startsWith('nit:')),
    ).toEqual([]);
  } finally {
    process.env.FUZZ_GC = prev;
  }
});
