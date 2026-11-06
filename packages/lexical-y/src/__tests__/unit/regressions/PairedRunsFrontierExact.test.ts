/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Seen.frontierOf (where a unit's folded start stops: the walk skips the
// items up to it) is exact:
// - whether the fold point lies after the walk's left is a two-way walk,
//   with no bound (a bound hit gave a wrong "no");
// - a fold point Yjs merged into the item before it (adjacent text of one
//   client) is resolved by its stored id: the noted object is no longer in
//   the container, and a walk never met it, so the start was taken as not
//   folded and its items stepped twice;
// - the answer is kept per left asked, not for the last left only.

import type * as Y from '@y/y';

import {expect, test} from 'vitest';

import {createYDoc} from '../../..';
import {frontierOf, noteFolded} from '../../../internal/Seen';

function itemsOf(root: Y.Node): Y.Item[] {
  const items: Y.Item[] = [];
  for (let it = root._start; it !== null; it = it.right) {
    items.push(it);
  }
  return items;
}

for (const gc of [false, true]) {
  test(`a fold point merged into the item before it is resolved by its id (gc ${gc ? 'on' : 'off'})`, () => {
    const doc = createYDoc(null, {gc});
    const root = doc.get('lexical-y');
    root.setAttr('lexical-y:3', true);
    const start = new Map<string, unknown>([['f:bold', true]]);
    let b: Y.Item | null = null;
    doc.transact(() => {
      root.insert(0, 'a');
      root.insert(1, 'b');
      b = itemsOf(root).find(it => (it.content as {str?: string}).str === 'b')!;
      // Folded up to "b" before the transaction's cleanup merges it.
      noteFolded(start, b);
    });
    // A left of another clock run (inserted before: it does not merge).
    root.insert(0, 'z');
    const items = itemsOf(root);
    expect(items.length).toBe(2);
    expect(items.includes(b!)).toBe(false);
    const merged = items[1];
    expect((merged.content as unknown as {str: string}).str).toBe('ab');
    expect(frontierOf(null, start, items[0], root, null)).toBe(merged);
    expect(frontierOf(null, start, null, root, null)).toBe(merged);
    // The merged item is the walk's left: no frontier.
    expect(frontierOf(null, start, merged, root, null)).toBeNull();
  });
}

test('the order test is exact both ways, per left asked', () => {
  const doc = createYDoc(null, {gc: false});
  const root = doc.get('lexical-y');
  root.setAttr('lexical-y:3', true);
  // 6,000 items that do not merge (each inserted before the previous one).
  for (let i = 0; i < 6000; i++) {
    root.insert(0, String.fromCharCode(97 + (i % 26)));
  }
  const items = itemsOf(root);
  const to = items[5000];
  const start = new Map<string, unknown>();
  noteFolded(start, to);
  // More than 4,096 items between left and the fold point: still found.
  expect(frontierOf(null, start, items[10], root, null)).toBe(to);
  expect(frontierOf(null, start, null, root, null)).toBe(to);
  expect(frontierOf(null, start, to, root, null)).toBeNull();
  // Lefts after it: no frontier; alternating lefts keep their answers.
  for (let k = 0; k < 3; k++) {
    expect(frontierOf(null, start, items[5001], root, null)).toBeNull();
    expect(frontierOf(null, start, items[10], root, null)).toBe(to);
    expect(frontierOf(null, start, items[5999], root, null)).toBeNull();
  }
});

test('a fold point at the container start answers a later left at once', () => {
  const doc = createYDoc(null, {gc: false});
  const root = doc.get('lexical-y');
  root.setAttr('lexical-y:3', true);
  for (let i = 0; i < 60_000; i++) {
    root.insert(0, String.fromCharCode(97 + (i % 26)));
  }
  const items = itemsOf(root);
  const t0 = performance.now();
  // 2,000 fresh notes at the first item, each asked from a left far after
  // it: the walk left from the fold point leaves the container at once.
  for (let i = 0; i < 2000; i++) {
    const start = new Map<string, unknown>();
    noteFolded(start, items[0]);
    expect(frontierOf(null, start, items[50_000 + i], root, null)).toBeNull();
  }
  expect(performance.now() - t0).toBeLessThan(500);
}, 30_000);
