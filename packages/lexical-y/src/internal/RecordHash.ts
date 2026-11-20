/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The quarantine record hash (@lexical/y/server, y-server.md "Records"):
// SHA-256, synchronous and dependency-free (an authority hashes a record
// while it holds the room, so no Web Crypto promise), over the record's
// canonical payload, version 1. Frozen: a change is a new tag.

/**
 * SHA-256's round constants (a plain array: a typed array built at module
 * scope would keep this module in every bundle that imports it).
 */
const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** An incremental SHA-256 (FIPS 180-4) over byte chunks. */
export class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly w = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private filled = 0;
  /** Bytes hashed so far (exact up to 2^53). */
  private length = 0;

  update(bytes: Uint8Array): this {
    let i = 0;
    this.length += bytes.length;
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, bytes.length);
      this.block.set(bytes.subarray(0, take), this.filled);
      this.filled += take;
      i = take;
      if (this.filled < 64) {
        return this;
      }
      this.compress(this.block, 0);
      this.filled = 0;
    }
    for (; i + 64 <= bytes.length; i += 64) {
      this.compress(bytes, i);
    }
    if (i < bytes.length) {
      this.block.set(bytes.subarray(i), 0);
      this.filled = bytes.length - i;
    }
    return this;
  }

  /** The digest, in lowercase hex. The hasher is spent afterwards. */
  hex(): string {
    const bits = this.length * 8;
    const tail = new Uint8Array(this.filled < 56 ? 64 : 128);
    tail.set(this.block.subarray(0, this.filled), 0);
    tail[this.filled] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(tail.length - 4, bits >>> 0);
    for (let i = 0; i < tail.length; i += 64) {
      this.compress(tail, i);
    }
    let out = '';
    for (let i = 0; i < 8; i++) {
      out += this.h[i].toString(16).padStart(8, '0');
    }
    return out;
  }

  private compress(bytes: Uint8Array, at: number): void {
    const w = this.w;
    for (let t = 0; t < 16; t++) {
      const j = at + t * 4;
      w[t] =
        (bytes[j] << 24) |
        (bytes[j + 1] << 16) |
        (bytes[j + 2] << 8) |
        bytes[j + 3];
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15];
      const y = w[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 =
        ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    const h = this.h;
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let k = h[7];
    for (let t = 0; t < 64; t++) {
      const S1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (k + S1 + ch + K[t] + w[t]) | 0;
      const S0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + k) | 0;
  }
}

/**
 * Canonical JSON (version 1) of a JSON value: object keys sorted by UTF-16
 * code units, no whitespace, strings and numbers as `JSON.stringify` writes
 * them, arrays in order. Throws a TypeError on anything that is not JSON:
 * undefined (an object member whose value is undefined is left out, as JSON
 * does), a function, a symbol, a bigint, a number that is not finite, an
 * array with a hole, an object that is not plain (a Date, a Map, a class
 * instance) or a cycle.
 */
export function canonicalJSON(value: unknown): string {
  const seen = new Set<object>();
  const write = (v: unknown, where: string): string => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') {
      return JSON.stringify(v);
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        throw new TypeError(`@lexical/y: not JSON at ${where}: ${v}`);
      }
      return JSON.stringify(v);
    }
    if (typeof v !== 'object') {
      throw new TypeError(`@lexical/y: not JSON at ${where}: a ${typeof v}`);
    }
    if (seen.has(v)) {
      throw new TypeError(`@lexical/y: not JSON at ${where}: a cycle`);
    }
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const parts: string[] = [];
        for (let i = 0; i < v.length; i++) {
          if (!(i in v) || v[i] === undefined) {
            throw new TypeError(
              `@lexical/y: not JSON at ${where}[${i}]: undefined`,
            );
          }
          parts.push(write(v[i], `${where}[${i}]`));
        }
        return `[${parts.join(',')}]`;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(
          `@lexical/y: not JSON at ${where}: an object that is not plain`,
        );
      }
      const record = v as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        if (record[key] === undefined) {
          continue;
        }
        parts.push(
          `${JSON.stringify(key)}:${write(record[key], `${where}.${key}`)}`,
        );
      }
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(v);
    }
  };
  return write(value, '$');
}
