/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/*
 * The canonical whole-container form of paired runs, as a seed writes it
 * (see Cursor#insert, Ident.withSeeding) and as the migration steps write
 * it from their own frozen copies (@lexical/y/migrate/2to3, 3to4).
 *
 * The countable units split into maximal stretches of units whose covered
 * values are all equal (the same keys, each with an equal stored value);
 * each stretch gets, for each key it holds, an opener `{key: value}` right
 * before its first unit and an end `{key: [d]}` right after its last unit
 * (`d`: the end's clock minus its opener's, both this client's). Where
 * stretches meet, the ends of the one ending there come first, then the
 * openers of the one starting there, each in key order (see runBoundary).
 *
 * Pure: no module state, no time or randomness, keys sorted by code unit.
 */

/** Covered key → stored value for one countable unit. */
export type StoredFormats = ReadonlyMap<string, unknown>;

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const unencodable = () =>
  new Error('@lexical/y: a format value JSON cannot encode');

/**
 * JSON of a value JSON.parse made (plain objects, arrays, strings, finite
 * numbers, booleans, null), object keys sorted by code unit.
 */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stable).join(',') + ']';
  }
  const parts: string[] = [];
  for (const k of Object.keys(value).sort(byCodeUnit)) {
    parts.push(
      JSON.stringify(k) + ':' + stable((value as Record<string, unknown>)[k]),
    );
  }
  return '{' + parts.join(',') + '}';
}

/**
 * The value stored for `value`, as Yjs encodes a format value
 * (JSON.stringify: toJSON honoured, an array's holes and undefined elements
 * null, an object's undefined and function properties left out): that JSON
 * read back, and a raw array as `{json}` of it (keys sorted). Throws where
 * JSON gives no value (undefined, a function or symbol at the top, a
 * toJSON that returns undefined), gives null (null is no value: a closer),
 * or throws (a bigint, a cycle).
 */
function storedValue(value: unknown): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw unencodable();
  }
  if (json === undefined) {
    throw unencodable();
  }
  const plain: unknown = JSON.parse(json);
  if (plain === null) {
    throw unencodable();
  }
  return Array.isArray(plain) ? {json: stable(plain)} : plain;
}

/** One unit's covered keys → [signature, stored value], in key order. */
export type StoredUnit = ReadonlyMap<string, readonly [string, unknown]>;

/**
 * A unit's covered values as written (see storedValue), each with its
 * signature (its JSON, keys sorted), in key order. Throws, before anything
 * is written, for a key `keys` does not cover or a value JSON cannot store.
 */
export function storedUnit(
  values: StoredFormats,
  keys: (key: string) => boolean,
): StoredUnit {
  const unit = new Map<string, [string, unknown]>();
  for (const key of [...values.keys()].sort(byCodeUnit)) {
    if (!keys(key)) {
      throw new Error(`@lexical/y: ${JSON.stringify(key)} is not covered`);
    }
    const stored = storedValue(values.get(key));
    unit.set(key, [stable(stored), stored]);
  }
  return unit;
}

/**
 * Where a unit with values `before` meets one with values `after` (either
 * empty at a container's edge): the keys whose run ends there and the keys
 * whose run starts there, in writing order: every key of both when the
 * two differ in any key or value, none when they are equal. The canonical
 * form's one boundary rule.
 */
export function runBoundary(
  before: StoredUnit,
  after: StoredUnit,
): {ends: string[]; starts: string[]} {
  let same = before.size === after.size;
  if (same) {
    for (const [key, [sig]] of before) {
      const next = after.get(key);
      if (next === undefined || next[0] !== sig) {
        same = false;
        break;
      }
    }
  }
  return same
    ? {ends: [], starts: []}
    : {ends: [...before.keys()], starts: [...after.keys()]};
}
