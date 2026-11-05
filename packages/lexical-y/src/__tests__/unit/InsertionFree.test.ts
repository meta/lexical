/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {describe, expect, test} from 'vitest';

import {insertionFree, MAX_RUNS, MAX_STEPS} from '../../internal/InsertionFree';

/** Text nodes before and after, by key; `order`: the old ones in order. */
function check(
  before: [string, string][],
  after: [string, string][],
  order = before.map(([k]) => k),
) {
  return insertionFree(new Map(before), new Map(after), () => order).free;
}

describe('insertionFree', () => {
  test('nothing changed', () => {
    expect(check([['s', 'abc']], [['s', 'abc']])).toBe(true);
  });
  test('deleting characters inserts none; typing one does', () => {
    expect(check([['s', 'abc']], [['s', 'ac']])).toBe(true);
    expect(check([['s', 'abc']], [['s', 'abXc']])).toBe(false);
  });
  test('a node removed with its text inserts none', () => {
    expect(
      check(
        [
          ['s', 'ab'],
          ['x', 'cd'],
        ],
        [['s', 'ab']],
      ),
    ).toBe(true);
  });
  test('an unwrap whose text merges into the text before it, or after it', () => {
    // x + Box(abc): Lexical keeps x and merges abc into it.
    expect(
      check(
        [
          ['s', 'x'],
          ['b', 'abc'],
        ],
        [['s', 'xabc']],
      ),
    ).toBe(true);
    // Box(abc) + y: the kept node after the removed one takes its text first.
    expect(
      check(
        [
          ['b', 'abc'],
          ['t', 'y'],
        ],
        [['t', 'abcy']],
      ),
    ).toBe(true);
  });
  test('a block cut and pasted (new keys, the same text)', () => {
    expect(
      check(
        [
          ['p', 'after'],
          ['q', 'other'],
        ],
        [
          ['q', 'other'],
          ['p2', 'after'],
        ],
      ),
    ).toBe(true);
    expect(
      check(
        [
          ['p', 'after'],
          ['q', 'other'],
        ],
        [
          ['q', 'other'],
          ['p2', 'afterQ'],
        ],
      ),
    ).toBe(false);
  });
  test('one removed run serves one consumer: L|x|y|x to Lx|xy|(empty) inserts the second x', () => {
    expect(
      check(
        [
          ['s', 'L'],
          ['x', 'x'],
          ['t', 'y'],
          ['u', 'x'],
        ],
        [
          ['s', 'Lx'],
          ['t', 'xy'],
          ['u', ''],
        ],
      ),
    ).toBe(false);
  });
  test('a permutation inserts (teh to the)', () => {
    expect(check([['s', 'teh']], [['s', 'the']])).toBe(false);
  });
  test('by code points: 😀🤣 to 🔣 inserts a character', () => {
    expect(check([['s', '😀🤣']], [['s', '🔣']])).toBe(false);
    expect(check([['s', '😀🤣']], [['s', '🤣']])).toBe(true);
  });
  test('documented limit: a node removed and its characters added next to it, in order, insert none', () => {
    expect(
      check(
        [
          ['s', 'ab'],
          ['x', 'cd'],
        ],
        [['s', 'abcd']],
      ),
    ).toBe(true);
  });
  test(`more than ${MAX_RUNS} runs of removed text count as inserting (not searched)`, () => {
    const before: [string, string][] = [];
    const after: [string, string][] = [];
    for (let i = 0; i <= MAX_RUNS; i++) {
      before.push([`k${i}`, `${i}`], [`r${i}`, 'z']);
      after.push([`k${i}`, i === 0 ? '0z' : `${i}`]);
    }
    expect(check(before, after)).toBe(false);
  });
  test('made text from the shortest removed text that holds it', () => {
    expect(
      check(
        [
          ['k', 'K'],
          ['r1', 'abc'],
          ['k2', 'K2'],
          ['r2', 'ab'],
        ],
        [
          ['k', 'K'],
          ['k2', 'K2'],
          ['n1', 'a'],
          ['n2', 'bc'],
        ],
      ),
    ).toBe(true);
  });
});

describe('insertionFree cost', () => {
  test('an assignment search that cannot succeed stops at the step budget, as inserting', () => {
    // 8 one-character runs, 6 made nodes that each fit any run, and two kept
    // nodes that both need the one run between them (`x` + it, it + `x`):
    // the characters add up, but no assignment fits, and the search stops
    // at MAX_STEPS.
    const before: [string, string][] = [];
    const after: [string, string][] = [];
    for (let i = 0; i < 8; i++) {
      before.push([`r${i}`, 'a'], [`k${i}`, 'x']);
      after.push([`k${i}`, i === 0 ? 'xa' : i === 1 ? 'ax' : 'x']);
      if (i < 6) {
        after.push([`m${i}`, 'a']);
      }
    }
    const started = performance.now();
    const result = insertionFree(new Map(before), new Map(after), () =>
      before.map(([k]) => k),
    );
    expect(result).toEqual({
      free: false,
      reason: `more than ${MAX_STEPS} assignments tried`,
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });
  test('a made text no removed run gives counts as inserting at once', () => {
    const before: [string, string][] = [];
    const after: [string, string][] = [];
    for (let i = 0; i < 8; i++) {
      before.push([`r${i}`, 'ab'], [`k${i}`, 'x']);
      after.push([`k${i}`, 'x'], [`m${i}`, 'ba']);
    }
    expect(check(before, after)).toBe(false);
  });
  test('a long changed text is checked once, not per assignment', () => {
    const long = 'x'.repeat(20000);
    const before: [string, string][] = [];
    const after: [string, string][] = [];
    for (let i = 0; i < 8; i++) {
      before.push([`r${i}`, 'a'], [`k${i}`, i === 0 ? long : 'x']);
      after.push([`k${i}`, i === 0 ? long + 'z' : 'x'], [`m${i}`, 'a']);
    }
    const started = performance.now();
    expect(check(before, after)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
  test('eight runs each moved into a made node of its own is found', () => {
    const before: [string, string][] = [];
    const after: [string, string][] = [];
    for (let i = 0; i < 8; i++) {
      before.push([`r${i}`, `a${i}`], [`k${i}`, 'x']);
      after.push([`k${i}`, 'x'], [`m${i}`, `a${i}`]);
    }
    expect(check(before, after)).toBe(true);
  });
});
