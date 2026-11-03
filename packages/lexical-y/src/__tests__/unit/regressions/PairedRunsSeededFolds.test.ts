/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// N1-soak-11's class: a fold or a write cursor seeded with formats folded
// past where it starts walking (the end of the unit before is gone or held,
// so its walk starts at an earlier end) steps the items between twice; a
// paired run must not be pushed twice (development builds throw when one
// is). These replays reach such seeds with paired runs written.

import * as fs from 'fs';
import * as path from 'path';
import {afterEach, expect, test} from 'vitest';

import {runScript, type Script} from '../../utils/fuzz';
import {setFormatIdentityWritesDefault} from '../../utils/noSwitch';

const DIR = path.join(__dirname, '..', '..', 'fuzz');

afterEach(() => setFormatIdentityWritesDefault(false));

for (const file of [
  'diverge-format-span-after-moved-line-s5887.json',
  'diverge-heading-format-after-move-s7486.json',
  'diverge-comment-after-move-and-undo-s9715.json',
]) {
  for (const gc of ['', '1']) {
    test(`${file}, paired runs, gc ${gc === '1' ? 'on' : 'off'}`, () => {
      setFormatIdentityWritesDefault(true);
      const script: Script = JSON.parse(
        fs.readFileSync(path.join(DIR, file), 'utf8'),
      );
      const prev = process.env.FUZZ_GC;
      process.env.FUZZ_GC = gc;
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
  }
}
