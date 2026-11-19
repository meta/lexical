/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Block handles: the shortest prefix, at least MIN_BLOCK_HANDLE_LENGTH
// characters long, of a hash of a block's id that no other id's hash of the
// document starts with, like a short git hash. Hashing first makes handles
// short and typo-safe whatever the ids look like (random, a timestamp first,
// a counter, @lexical/y's derived ids). Handles are derived from the ids of
// one document and never stored. These helpers are pure: BlockIdExtension
// feeds them the ids and decides which blocks are live.

/**
 * The shortest handle.
 *
 * @experimental
 */
export const MIN_BLOCK_HANDLE_LENGTH = 4;

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * The length of a hash key, and so the longest handle: 64 bits in base64url.
 * A longer string is looked up as a whole id.
 */
export const HANDLE_KEY_LENGTH = 11;

/**
 * The hash key of an id: 64 bits of a fast non-cryptographic hash (cyrb53's
 * mixing, kept to 64 bits), in base64url, most significant bits first, so
 * that every prefix is as random as the hash. Not a security boundary:
 * collisions only make handles longer (or, for a whole 64-bit collision,
 * ambiguous).
 */
export function handleKey(id: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  // h2 then h1, 6 bits at a time: 10 whole characters and 4 bits.
  let key = '';
  for (let bit = 0; bit < 64; bit += 6) {
    let value: number;
    if (bit + 6 <= 32) {
      value = h2 >>> (26 - bit);
    } else if (bit >= 32) {
      const shift = 26 - (bit - 32);
      value = shift >= 0 ? h1 >>> shift : h1 << -shift;
    } else {
      const low = bit + 6 - 32;
      value = (h2 << low) | (h1 >>> (32 - low));
    }
    key += ALPHABET[value & 63];
  }
  return key;
}

/** The handles of a set of ids. */
export interface HandleTable {
  /** The distinct hash keys, in ascending UTF-16 code unit order. */
  readonly sorted: readonly string[];
  /** Hash key → the ids that have it (one, unless the hash collides). */
  readonly idsOfKey: ReadonlyMap<string, readonly string[]>;
  /** Id → its handle. */
  readonly handles: ReadonlyMap<string, string>;
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) {
    i++;
  }
  return i;
}

/**
 * The handle of `key` between its neighbours in sorted order: long enough to
 * differ from both, so from every other key.
 */
function handleBetween(
  key: string,
  prev: string | undefined,
  next: string | undefined,
): string {
  let length = MIN_BLOCK_HANDLE_LENGTH;
  if (prev !== undefined) {
    length = Math.max(length, commonPrefixLength(key, prev) + 1);
  }
  if (next !== undefined) {
    length = Math.max(length, commonPrefixLength(key, next) + 1);
  }
  return key.slice(0, length);
}

/** The first index of `sorted` whose key is not below `value`. */
function lowerBound(sorted: readonly string[], value: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * The handles of `ids` (duplicates allowed), in O(n log n): after sorting
 * their hash keys, only a key's neighbours can share a longer prefix with it
 * than any other key.
 */
export function buildHandleTable(ids: Iterable<string>): HandleTable {
  const idsOfKey = new Map<string, string[]>();
  for (const id of new Set(ids)) {
    const key = handleKey(id);
    const same = idsOfKey.get(key);
    if (same === undefined) {
      idsOfKey.set(key, [id]);
    } else {
      same.push(id);
    }
  }
  const sorted = Array.from(idsOfKey.keys()).sort();
  const handles = new Map<string, string>();
  for (let i = 0; i < sorted.length; i++) {
    const handle = handleBetween(sorted[i], sorted[i - 1], sorted[i + 1]);
    for (const id of idsOfKey.get(sorted[i])!) {
      handles.set(id, handle);
    }
  }
  return {handles, idsOfKey, sorted};
}

/**
 * The handle of `id` against the ids of `table`, whether or not `id` is one
 * of them.
 */
export function handleInTable(table: HandleTable, id: string): string {
  const known = table.handles.get(id);
  if (known !== undefined) {
    return known;
  }
  const key = handleKey(id);
  const {sorted} = table;
  const i = lowerBound(sorted, key);
  return handleBetween(
    key,
    sorted[i - 1],
    sorted[i] === key ? sorted[i + 1] : sorted[i],
  );
}

/** The ids of `table` whose hash key starts with `prefix`, by key. */
export function idsWithPrefix(table: HandleTable, prefix: string): string[] {
  const {sorted, idsOfKey} = table;
  const result: string[] = [];
  for (
    let i = lowerBound(sorted, prefix);
    i < sorted.length && sorted[i].startsWith(prefix);
    i++
  ) {
    for (const id of idsOfKey.get(sorted[i])!) {
      result.push(id);
    }
  }
  return result;
}
