/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The record hash's pieces: SHA-256 against node:crypto over sizes around
// every block boundary and random chunk splits, and canonical JSON (sorted
// keys, JSON's own number and string forms, non-JSON refused).

import {createHash} from 'node:crypto';
import {describe, expect, test} from 'vitest';

import {canonicalJSON, Sha256} from '../../internal/RecordHash';

/** Deterministic bytes (xorshift). */
function bytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed | 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

describe('Sha256', () => {
  test('equals node:crypto at and around every block boundary, whole and in random chunks', () => {
    const sizes = [0, 1, 3, 55, 56, 57, 63, 64, 65, 111, 112, 119, 120, 127];
    sizes.push(128, 129, 1000, 4096, 65537, 1 << 20);
    for (const [i, n] of sizes.entries()) {
      const data = bytes(n, i + 1);
      const want = createHash('sha256').update(data).digest('hex');
      expect(new Sha256().update(data).hex()).toBe(want);
      const chunked = new Sha256();
      const cuts = bytes(64, n + 7);
      let at = 0;
      for (let c = 0; at < n; c++) {
        const size = Math.min(n - at, 1 + (cuts[c % cuts.length] % 130));
        chunked.update(data.subarray(at, at + size));
        at += size;
      }
      expect(chunked.hex()).toBe(want);
    }
  });

  test('the FIPS 180-4 examples', () => {
    const utf8 = (s: string) => new TextEncoder().encode(s);
    expect(new Sha256().update(utf8('abc')).hex()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      new Sha256()
        .update(
          utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
        )
        .hex(),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });
});

describe('canonicalJSON', () => {
  test('sorts keys by code units at every depth and keeps array order', () => {
    expect(
      canonicalJSON(
        // Keys out of order on purpose.
        /* eslint-disable sort-keys-fix/sort-keys-fix */
        {
          b: [{z: 1, a: 2}, 3],
          a: {'\u00e9': 1, Z: 2, z: 3},
        },
        /* eslint-enable sort-keys-fix/sort-keys-fix */
      ),
    ).toBe('{"a":{"Z":2,"z":3,"\u00e9":1},"b":[{"a":2,"z":1},3]}');
  });

  test("uses JSON's own forms for strings and numbers, and leaves out undefined members", () => {
    expect(canonicalJSON(['a"\\\u0000\ud800', 1e21, -0, 0.1, null, true])).toBe(
      JSON.stringify(['a"\\\u0000\ud800', 1e21, -0, 0.1, null, true]),
    );
    expect(canonicalJSON({a: undefined, b: 1})).toBe('{"b":1}');
    expect(canonicalJSON(Object.create(null))).toBe('{}');
  });

  test('refuses what is not JSON', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      undefined,
      NaN,
      Infinity,
      BigInt(1),
      () => 1,
      Symbol('s'),
      new Date(0),
      new Map(),
      [1, undefined],
      // eslint-disable-next-line no-sparse-arrays
      [1, , 2],
      cycle,
    ]) {
      expect(() => canonicalJSON(value)).toThrow(TypeError);
    }
    // A shared (not cyclic) object is fine.
    const shared = {x: 1};
    expect(canonicalJSON({a: shared, b: shared})).toBe(
      '{"a":{"x":1},"b":{"x":1}}',
    );
  });
});
