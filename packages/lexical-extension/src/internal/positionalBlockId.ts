/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Positional block ids: the ids BlockIdExtension gives the blocks that a
// document stored without ids leaves unnamed. They are derived from the
// document and the block's place in it, so every reader and every replica of the
// same document derives the same ones. The derivation is part of the stored
// format: changing anything here changes the ids of every document that is
// read without ids, so it is pinned by tests.

import {
  $exportNodeJSON,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $withCompactExport,
  type LexicalNode,
} from 'lexical';

/**
 * The 64 characters of ids, in base64url order (RFC 4648, section 5): one
 * character per 6 bits.
 */
export const ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Characters in a generated or positional id: 126 bits. */
export const ID_LENGTH = 21;

// SHA-256 (FIPS 180-4) round constants: the first 32 bits of the fractional
// parts of the cube roots of the first 64 primes.
const K = [
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

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Runs the compression function over the 64-byte block at `offset`. */
function compress(
  h: Int32Array,
  w: Int32Array,
  bytes: Uint8Array,
  offset: number,
): void {
  for (let t = 0; t < 16; t++) {
    const i = offset + t * 4;
    w[t] =
      (bytes[i] << 24) |
      (bytes[i + 1] << 16) |
      (bytes[i + 2] << 8) |
      bytes[i + 3];
  }
  for (let t = 16; t < 64; t++) {
    const x = w[t - 15];
    const y = w[t - 2];
    const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
    const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
    w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
  }
  let a = h[0];
  let b = h[1];
  let c = h[2];
  let d = h[3];
  let e = h[4];
  let f = h[5];
  let g = h[6];
  let hh = h[7];
  for (let t = 0; t < 64; t++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + s1 + ch + K[t] + w[t]) | 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) | 0;
    hh = g;
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
  h[7] = (h[7] + hh) | 0;
}

// Scratch for the message schedule and the padded tail, allocated on first
// use and reused: ids are derived thousands at a time.
let schedule: Int32Array | null = null;
let tailBuffer: Uint8Array | null = null;
let inputBuffer: Uint8Array | null = null;
let words: Int32Array | null = null;

/** The SHA-256 state words after hashing `message`. */
function sha256Words(message: Uint8Array): Int32Array {
  const length = message.length;
  // Reused: callers read the words before hashing again.
  const h = words || (words = new Int32Array(8));
  h[0] = 0x6a09e667;
  h[1] = 0xbb67ae85;
  h[2] = 0x3c6ef372;
  h[3] = 0xa54ff53a;
  h[4] = 0x510e527f;
  h[5] = 0x9b05688c;
  h[6] = 0x1f83d9ab;
  h[7] = 0x5be0cd19;
  const w = schedule || (schedule = new Int32Array(64));
  const full = length - (length % 64);
  for (let offset = 0; offset < full; offset += 64) {
    compress(h, w, message, offset);
  }
  // The rest of the message, a 1 bit, zeros, and the 64-bit length.
  const buffer = tailBuffer || (tailBuffer = new Uint8Array(128));
  const end = length - full < 56 ? 64 : 128;
  buffer.fill(0);
  buffer.set(message.subarray(full));
  buffer[length - full] = 0x80;
  const high = Math.floor(length / 0x20000000);
  const low = (length * 8) >>> 0;
  buffer[end - 8] = high >>> 24;
  buffer[end - 7] = high >>> 16;
  buffer[end - 6] = high >>> 8;
  buffer[end - 5] = high;
  buffer[end - 4] = low >>> 24;
  buffer[end - 3] = low >>> 16;
  buffer[end - 2] = low >>> 8;
  buffer[end - 1] = low;
  for (let offset = 0; offset < end; offset += 64) {
    compress(h, w, buffer, offset);
  }
  return h;
}

/**
 * The SHA-256 digest of `message`. Synchronous, because ids are derived
 * inside editor updates, where Web Crypto's asynchronous digest cannot run.
 */
export function sha256(message: Uint8Array): Uint8Array {
  const h = sha256Words(message);
  const digest = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    digest[i] = h[i >>> 2] >>> (24 - (i & 3) * 8);
  }
  return digest;
}

/**
 * The UTF-8 bytes of `text`. A lone surrogate becomes U+FFFD, as with
 * `TextEncoder`.
 */
export function utf8(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) {
      bytes[n++] = c;
      continue;
    }
    if (c >= 0xd800 && c <= 0xdfff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    }
    if (c < 0x800) {
      bytes[n++] = 0xc0 | (c >> 6);
      bytes[n++] = 0x80 | (c & 63);
    } else if (c < 0x10000) {
      bytes[n++] = 0xe0 | (c >> 12);
      bytes[n++] = 0x80 | ((c >> 6) & 63);
      bytes[n++] = 0x80 | (c & 63);
    } else {
      bytes[n++] = 0xf0 | (c >> 18);
      bytes[n++] = 0x80 | ((c >> 12) & 63);
      bytes[n++] = 0x80 | ((c >> 6) & 63);
      bytes[n++] = 0x80 | (c & 63);
    }
  }
  return bytes.subarray(0, n);
}

/** A deep copy of `value` whose objects have their keys inserted sorted. */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortKeys(record[key]);
  }
  return sorted;
}

/**
 * Canonical JSON: `JSON.stringify` (no whitespace) of a deep copy of `value`
 * in which the keys of every object were inserted in UTF-16 code unit order.
 * ECMAScript fixes the order `JSON.stringify` writes them in: keys that are
 * array indices first, in numeric order, then the others in that order.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * A node's compact JSON with its children and slots, without its block id
 * (and without a `$` that held only that).
 */
function $nodeJSON(node: LexicalNode): Record<string, unknown> {
  const json = $exportNodeJSON(node) as Record<string, unknown>;
  const state = json.$;
  if (state !== null && typeof state === 'object' && 'blockId' in state) {
    const {blockId: _, ...rest} = state as Record<string, unknown>;
    if (Object.keys(rest).length > 0) {
      json.$ = rest;
    } else {
      delete json.$;
    }
  }
  if ($isElementNode(node)) {
    json.children = node.getChildren().map($nodeJSON);
  }
  const names = $getSlotNames(node);
  if (names.length > 0) {
    const slots: Record<string, unknown> = {};
    for (const name of names) {
      const slot = $getSlot(node, name);
      if (slot !== null) {
        slots[name] = $nodeJSON(slot);
      }
    }
    json.$slots = slots;
  }
  return json;
}

/**
 * The active document as the canonical JSON its key is hashed from: the
 * compact export of the root (`editorState.toJSON(true).root`), without any
 * `blockId` (and without a `$` that held only that), in
 * {@link canonicalJSON}.
 */
export function $canonicalDocument(): string {
  return $withCompactExport(true, () => canonicalJSON($nodeJSON($getRoot())));
}

/**
 * The key of the active document: SHA-256 of the UTF-8 bytes of
 * {@link $canonicalDocument}. Ids are left out, so naming blocks does not
 * change it.
 */
export function $documentKey(): Uint8Array {
  return sha256(utf8($canonicalDocument()));
}

/**
 * An id from the SHA-256 of `input`: the first 21 characters (126 bits) of
 * the digest's unpadded base64url encoding.
 */
function idFromDigestOf(input: Uint8Array): string {
  const h = sha256Words(input);
  // The digest's bits, 6 at a time from the most significant.
  let id = '';
  for (let bit = 0; id.length < ID_LENGTH; bit += 6) {
    const word = bit >>> 5;
    const offset = bit & 31;
    const pair =
      offset <= 26
        ? h[word] >>> (26 - offset)
        : (h[word] << (offset - 26)) | (h[word + 1] >>> (58 - offset));
    id += ID_ALPHABET[pair & 63];
  }
  return id;
}

/** `prefix` followed by `bytes`, in a reused buffer when it is small. */
function concat(prefix: Uint8Array, bytes: Uint8Array): Uint8Array {
  const length = prefix.length + bytes.length;
  const input =
    length <= 64
      ? (inputBuffer || (inputBuffer = new Uint8Array(64))).subarray(0, length)
      : new Uint8Array(length);
  input.set(prefix);
  input.set(bytes, prefix.length);
  return input;
}

/**
 * The positional id of the block at `place` in the document with key
 * `documentKey`: the first 21 characters (126 bits) of the unpadded base64url
 * encoding of SHA-256(`documentKey` ‖ UTF-8(`place`)). `place` is the block's
 * path among identified blocks, its indices joined by `.` (`"3"`, `"0.2"`),
 * with `#n` appended for the n-th retry after a collision.
 */
export function derivePositionalId(
  documentKey: Uint8Array,
  place: string,
): string {
  return idFromDigestOf(concat(documentKey, utf8(place)));
}

/**
 * The id of the k-th later holder of the repeated id `id` (in document
 * order, after the holder that keeps it): the first 21 characters (126 bits)
 * of the unpadded base64url encoding of
 * SHA-256(UTF-8(`"dup"` + U+0000 + `id` + U+0000 + `ordinal`)), where
 * `ordinal` is k in decimal (`"1"` for the first later holder), with `#n`
 * appended for the n-th retry after a collision. It depends only on the id
 * and the ordinal, so it costs the same whatever the document's size.
 */
export function deriveDuplicateId(id: string, ordinal: string): string {
  return idFromDigestOf(utf8(`dup\u0000${id}\u0000${ordinal}`));
}
