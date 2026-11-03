/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {expect, test, vi} from 'vitest';

import {genScript, mulberry32, runScript} from '../../utils/fuzz';

let rng = mulberry32(1);
vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(
  <T extends ArrayBufferView | null>(array: T): T => {
    const bytes = new Uint8Array(
      array!.buffer,
      array!.byteOffset,
      array!.byteLength,
    );
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rng() * 256);
    return array;
  },
);

const SEEDS: [string, number, {moves: boolean; long: boolean}][] = [
  ['long', 16, {long: true, moves: true}],
  ['long', 286, {long: true, moves: true}],
  ['long', 289, {long: true, moves: true}],
  ['long', 329, {long: true, moves: true}],
  ['long', 390, {long: true, moves: true}],
  ['moves', 726, {long: false, moves: true}],
];

for (const [lane, seed, opts] of SEEDS) {
  test(`golden ${lane} seed ${seed}: no self-check disagreement`, () => {
    rng = mulberry32(seed * 31 + 7);
    const res = runScript(genScript(seed, opts));
    const sigs: string[] = res.failures.map(f => f.sig);
    expect(sigs.filter(s => s.includes('self-check'))).toEqual([]);
  });
}
