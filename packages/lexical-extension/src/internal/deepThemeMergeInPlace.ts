/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Recursively merge the given theme configuration in-place.
 *
 * @returns If `a` and `b` are both objects (and `b` is not an Array) then
 * all keys in `b` are merged into `a` then `a` is returned.
 * Otherwise `b` is returned.
 *
 * @example
 * ```ts
 * const a = { a: "a", nested: { a: 1 } };
 * const b = { b: "b", nested: { b: 2 } };
 * const rval = deepThemeMergeInPlace(a, b);
 * expect(a).toBe(rval);
 * expect(a).toEqual({ a: "a", b: "b", nested: { a: 1, b: 2 } });
 * ```
 */
// Keys that must never be merged: assigning or recursing through them can
// mutate the prototype chain (prototype pollution). A malicious `__proto__`
// entry — e.g. from `JSON.parse('{"__proto__": {...}}')` — would otherwise
// leak into `Object.prototype` and affect every object in the realm.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function deepThemeMergeInPlace(a: unknown, b: unknown) {
  if (
    a &&
    b &&
    !Array.isArray(b) &&
    typeof a === 'object' &&
    typeof b === 'object'
  ) {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    for (const k in bObj) {
      // Only merge own, prototype-safe keys.
      if (
        UNSAFE_KEYS.has(k) ||
        !Object.prototype.hasOwnProperty.call(bObj, k)
      ) {
        continue;
      }
      aObj[k] = deepThemeMergeInPlace(aObj[k], bObj[k]);
    }
    return a;
  }
  return b;
}
