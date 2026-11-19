/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {} from 'lexical';
import {describe, expect, test} from 'vitest';

import {cloneMap, GenMap} from '../../LexicalGenMap';

function buildGenMap(
  entries: readonly [string, number][],
): GenMap<string, number> {
  const g = new GenMap<string, number>();
  for (const [k, v] of entries) {
    g.set(k, v);
  }
  return g;
}

describe('GenMap', () => {
  test('clone shares state until first write', () => {
    const a = buildGenMap([
      ['x', 1],
      ['y', 2],
    ]);
    const b = a.clone();

    // Both see the same entries.
    expect(b.get('x')).toBe(1);
    expect(b.get('y')).toBe(2);
    expect(b.size).toBe(2);

    // The internal references are shared.
    expect(b._old).toBe(a._old);
    expect(b._nursery).toBe(a._nursery);
  });

  test('write to a clone isolates that clone from the original', () => {
    const a = buildGenMap([['x', 1]]);
    const b = a.clone();

    b.set('y', 99);

    expect(b.get('y')).toBe(99);
    expect(a.get('y')).toBeUndefined();
    expect(a.size).toBe(1);
    expect(b.size).toBe(2);
  });

  test('write to the original after clone isolates the original', () => {
    const a = buildGenMap([['x', 1]]);
    const b = a.clone();

    a.set('z', 42);

    expect(a.get('z')).toBe(42);
    expect(b.get('z')).toBeUndefined();
    expect(a.size).toBe(2);
    expect(b.size).toBe(1);
  });

  test('delete then resurrect preserves size and value', () => {
    const a = buildGenMap([['x', 1]]);
    a.delete('x');
    expect(a.has('x')).toBe(false);
    expect(a.size).toBe(0);

    a.set('x', 7);
    expect(a.get('x')).toBe(7);
    expect(a.size).toBe(1);
  });

  test('size tracks set/delete correctly across clone boundaries', () => {
    const a = buildGenMap([
      ['x', 1],
      ['y', 2],
    ]);
    const b = a.clone();

    b.delete('x');
    b.set('z', 3);

    expect(a.size).toBe(2);
    expect(b.size).toBe(2);
    expect(b.get('x')).toBeUndefined();
    expect(b.get('z')).toBe(3);
    expect(a.get('x')).toBe(1);
  });

  test('iteration yields entries in nursery-overrides-old order', () => {
    const a = buildGenMap([
      ['x', 1],
      ['y', 2],
    ]);
    a.compact(true);
    a.set('y', 20); // override existing
    a.set('z', 3); // new

    expect(Array.from(a.entries())).toEqual([
      ['x', 1],
      ['y', 20],
      ['z', 3],
    ]);
  });

  test('iteration skips tombstoned keys', () => {
    const a = buildGenMap([
      ['x', 1],
      ['y', 2],
      ['z', 3],
    ]);
    a.compact(true);
    a.delete('y');

    expect(Array.from(a.keys()).sort()).toEqual(['x', 'z']);
  });

  test('compact folds nursery into old and resets nursery', () => {
    const a = buildGenMap([
      ['x', 1],
      ['y', 2],
    ]);
    a.compact(true);
    a.set('z', 3);
    a.delete('x');

    a.compact(true);
    expect(a._nursery).toBeUndefined();
    expect(a.get('x')).toBeUndefined();
    expect(a.get('y')).toBe(2);
    expect(a.get('z')).toBe(3);
    expect(a.size).toBe(2);
  });

  test('clear resets all state', () => {
    const a = buildGenMap([
      ['x', 1],
      ['y', 2],
    ]);
    a.clear();

    expect(a.size).toBe(0);
    expect(a.get('x')).toBeUndefined();
    expect(a._old).toBeUndefined();
    expect(a._nursery).toBeUndefined();
  });
});

describe('cloneMap', () => {
  test('GenMap source returns a clone (O(1) path)', () => {
    const a = buildGenMap([['x', 1]]);
    const b = cloneMap(a);

    expect(b).toBeInstanceOf(GenMap);
    expect((b as GenMap<string, number>)._old).toBe(a._old);
    expect((b as GenMap<string, number>)._nursery).toBe(a._nursery);
  });

  test('plain Map below threshold returns a fresh plain Map', () => {
    const m = new Map<string, number>([['x', 1]]);
    const cloned = cloneMap(m, 1000);

    expect(cloned).not.toBe(m);
    expect(cloned).toBeInstanceOf(Map);
    expect(cloned).not.toBeInstanceOf(GenMap);
    expect(cloned.get('x')).toBe(1);
  });

  test('plain Map at or above threshold returns a GenMap snapshot', () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 5; i++) {
      m.set(String(i), i);
    }
    const cloned = cloneMap(m, 4);

    expect(cloned).toBeInstanceOf(GenMap);
    expect(cloned.size).toBe(5);
    expect(cloned.get('3')).toBe(3);
  });
});
