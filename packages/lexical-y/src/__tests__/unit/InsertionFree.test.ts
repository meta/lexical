/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {describe, expect, test} from 'vitest';

import {
  insertionFree,
  MAX_RUNS,
  type Recipient,
} from '../../internal/InsertionFree';

/** Text nodes before and after, by key; `order`: the old ones in order. */
function check(
  before: [string, string][],
  after: [string, string][],
  order = before.map(([k]) => k),
  moved: string[] = [],
  donors: [string, string, 'before' | 'after'][] = [],
) {
  return insertionFree(
    new Map(before),
    new Map(after),
    () => order,
    () => after.map(([k]) => k),
    () => new Set(moved),
    () => new Map(donors.map(([d, key, side]) => [d, {key, side}])),
  ).free;
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
  test('a node moved elsewhere leaves the text on both sides adjacent: left|abc|tail to lefttail with abc moved', () => {
    const before: [string, string][] = [
      ['l', 'left'],
      ['b', 'abc'],
      ['t', 'tail'],
    ];
    const after: [string, string][] = [
      ['l', 'lefttail'],
      ['b', 'abc'],
    ];
    expect(check(before, after, undefined, ['b'])).toBe(true);
    // Not told that abc moved, tail's run is abc's neighbour, not left's.
    expect(check(before, after)).toBe(false);
    // A moved node that gains text inserts it.
    expect(
      check(
        before,
        [
          ['l', 'left'],
          ['t', 'tail'],
          ['b', 'abcZ'],
        ],
        undefined,
        ['b'],
      ),
    ).toBe(false);
  });
});

describe('insertionFree with moved nodes', () => {
  test('L=a | M moved away | X=b removed | T=z: X merged into L, which T is next to once M is gone, inserts none', () => {
    expect(
      check(
        [
          ['l', 'a'],
          ['m', 'm'],
          ['x', 'b'],
          ['t', 'z'],
        ],
        [
          ['l', 'ab'],
          ['t', 'z'],
          ['m', 'm'],
        ],
        undefined,
        ['m'],
      ),
    ).toBe(true);
  });
  test('the same where L and T are not next to each other once X is gone (a changed node moved between them): counted as inserting', () => {
    expect(
      check(
        [
          ['l', 'a'],
          ['m', 'mm'],
          ['x', 'b'],
          ['t', 'z'],
        ],
        [
          ['l', 'ab'],
          ['m', 'm'],
          ['t', 'z'],
        ],
        undefined,
        ['m'],
      ),
    ).toBe(false);
  });
  test('a node moved between them unchanged is no neighbour, in the new order too: inserts none', () => {
    expect(
      check(
        [
          ['l', 'a'],
          ['m', 'm'],
          ['x', 'b'],
          ['t', 'z'],
        ],
        [
          ['l', 'ab'],
          ['m', 'm'],
          ['t', 'z'],
        ],
        undefined,
        ['m'],
      ),
    ).toBe(true);
  });
});

describe('insertionFree with the text of a moved or removed container', () => {
  // left | Box(aba) | right, dest: Box removed, its text moved after dest
  // and merged there, left and right merged.
  const before: [string, string][] = [
    ['l', 'left'],
    ['x', 'aba'],
    ['r', 'right'],
    ['d', 'dest'],
  ];
  test('text moved out of a container into a node elsewhere, recorded merged there, inserts none', () => {
    const after: [string, string][] = [
      ['l', 'leftright'],
      ['d', 'destaba'],
    ];
    expect(check(before, after, undefined, [], [['x', 'd', 'after']])).toBe(
      true,
    );
    // With no record of that merge (the same characters typed at the end of
    // dest while the container went): inserting.
    expect(check(before, after)).toBe(false);
    // A record of a merge elsewhere does not do.
    expect(check(before, after, undefined, [], [['x', 'l', 'after']])).toBe(
      false,
    );
  });
  test('the same with a character typed where it merged inserts it', () => {
    expect(
      check(
        before,
        [
          ['l', 'leftright'],
          ['d', 'destabaQ'],
        ],
        undefined,
        [],
        [['x', 'd', 'after']],
      ),
    ).toBe(false);
  });
});

describe('insertionFree with the text nodes of a subtree the update made', () => {
  // lead | Value(left, Box(abc), post) | tail, where Value is replaced by a
  // copy of it under new keys: its three text nodes made from one run.
  const before: [string, string][] = [
    ['l', 'lead'],
    ['a', 'left'],
    ['b', 'abc'],
    ['c', 'post'],
    ['t', 'tail'],
  ];
  const copied = (box: string): [string, string][] => [
    ['l', 'lead'],
    ['a2', 'left'],
    ['b2', box],
    ['c2', 'post'],
    ['t', 'tail'],
  ];
  const free = (after: [string, string][], groups?: string[][]) =>
    insertionFree(
      new Map(before),
      new Map(after),
      () => before.map(([k]) => k),
      () => after.map(([k]) => k),
      () => new Set(),
      () => new Map(),
      groups === undefined ? undefined : () => groups,
    ).free;
  test('a node replaced by a copy of it under new keys inserts none, its text nodes taken together', () => {
    expect(free(copied('abc'), [['a2', 'b2', 'c2']])).toBe(true);
    // Each made node alone needs a run of its own, and there is one.
    expect(free(copied('abc'))).toBe(false);
  });
  test('the same copy with a character typed in it inserts it', () => {
    expect(free(copied('abXc'), [['a2', 'b2', 'c2']])).toBe(false);
  });
  test('the copy in another order inserts (a permutation)', () => {
    expect(
      free(
        [
          ['l', 'lead'],
          ['c2', 'post'],
          ['a2', 'left'],
          ['b2', 'abc'],
          ['t', 'tail'],
        ],
        [['c2', 'a2', 'b2']],
      ),
    ).toBe(false);
  });
  test('the groups never make an update that inserts none count as inserting', () => {
    // Two made nodes each from a run of its own, in two groups or one.
    const order: [string, string][] = [
      ['x', 'ab'],
      ['k', 'K'],
      ['y', 'cd'],
    ];
    const after: [string, string][] = [
      ['x2', 'ab'],
      ['k', 'K'],
      ['y2', 'cd'],
    ];
    for (const groups of [[['x2'], ['y2']], [['x2', 'y2']]]) {
      expect(
        insertionFree(
          new Map(order),
          new Map(after),
          () => order.map(([k]) => k),
          () => after.map(([k]) => k),
          () => new Set(),
          () => new Map(),
          () => groups,
        ).free,
      ).toBe(true);
    }
  });
});

describe('insertionFree with a made node over donor runs next to each other', () => {
  // L | Value(pre, Box(abc), tail) | aside: the update removes the value's
  // text nodes (runs of their own: their container goes) and makes a copy
  // whose text Lexical merged into one text node.
  const run = (
    before: [string, string][],
    after: [string, string][],
    donors: string[],
  ) =>
    insertionFree(
      new Map(before),
      new Map(after),
      () => before.map(([k]) => k),
      () => after.map(([k]) => k),
      () => new Set(),
      () => new Map<string, Recipient | null>(donors.map(d => [d, null])),
    ).free;
  const before: [string, string][] = [
    ['l', 'L'],
    ['p', 'pre'],
    ['b', 'abc'],
    ['t', 'tail'],
    ['a', 'aside'],
  ];
  const copy = (text: string): [string, string][] => [
    ['l', 'L'],
    ['m', text],
    ['a', 'aside'],
  ];
  const donors = ['p', 'b', 't'];
  test('one made node takes several donor runs next to each other, in their order', () => {
    expect(run(before, copy('pretail'), donors)).toBe(true);
    expect(run(before, copy('preabctail'), donors)).toBe(true);
    // As one run, before its nodes were runs of their own.
    expect(run(before, copy('pretail'), [])).toBe(true);
  });
  test('out of their order, or with a character typed, it inserts', () => {
    expect(run(before, copy('tailpre'), donors)).toBe(false);
    expect(run(before, copy('preXtail'), donors)).toBe(false);
  });
  test('donor runs with a kept node between them are not next to each other', () => {
    expect(
      run(
        [
          ['l', 'L'],
          ['p', 'pre'],
          ['k', 'K'],
          ['t', 'tail'],
          ['a', 'aside'],
        ],
        [
          ['l', 'L'],
          ['k', 'K'],
          ['m', 'pretail'],
          ['a', 'aside'],
        ],
        ['p', 't'],
      ),
    ).toBe(false);
  });
});

describe('insertionFree cost', () => {
  test('a long changed text is checked once per set of runs given, not per assignment: a 20,000-character text with eight runs decides in well under 50 ms', () => {
    const long = 'x'.repeat(20000);
    const before: [string, string][] = [];
    const after: [string, string][] = [];
    for (let i = 0; i < 8; i++) {
      before.push([`r${i}`, 'a'], [`k${i}`, i === 0 ? long : 'x']);
      after.push([`k${i}`, i === 0 ? long + 'z' : 'x'], [`m${i}`, 'a']);
    }
    const started = performance.now();
    expect(check(before, after)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
  test('eight runs no assignment fits end within the step budget, as inserting', () => {
    // 8 removed runs `ab` between kept `x` nodes, and 8 made `ba` nodes: a
    // permutation, which no assignment gives.
    const before: [string, string][] = [];
    const after: [string, string][] = [];
    for (let i = 0; i < 8; i++) {
      before.push([`r${i}`, 'ab'], [`k${i}`, 'x']);
      after.push([`k${i}`, 'x'], [`m${i}`, 'ba']);
    }
    const started = performance.now();
    expect(check(before, after)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
  test('eight runs whose made nodes fit but a kept node never does stop at the budget', () => {
    const before: [string, string][] = [];
    const after: [string, string][] = [];
    for (let i = 0; i < 8; i++) {
      before.push([`r${i}`, 'ab'], [`k${i}`, 'x']);
      after.push([`k${i}`, i === 7 ? 'xz' : 'x'], [`m${i}`, 'a']);
    }
    before.push(['z', 'z']);
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
