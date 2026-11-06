/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Writer#$fixStartsAfter reuses the format pass's fold of a line when the
// pass stopped at or before the line's end item, which `reaches` tells. It
// used to walk right from the stop until it met the end item, so a stop past
// the end (the pass read beyond a short line) walked every item left in the
// container: in a document whose root holds its lines, every deleted item a
// long history left after the line, on every local edit. It walks from both
// items now: the same answer, for about the distance between them.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {reaches} from '../../internal/Write';

type Link = {right: Link | null};

/** `n` linked items and a counter of the `right` reads made on them. */
function chain(n: number): {items: Y.Item[]; reads: () => number} {
  let reads = 0;
  const links: Link[] = [];
  for (let i = 0; i < n; i++) {
    let right: Link | null = null;
    links.push({
      get right() {
        reads++;
        return right;
      },
      set right(r: Link | null) {
        right = r;
      },
    });
  }
  for (let i = 0; i + 1 < n; i++) {
    links[i].right = links[i + 1];
  }
  return {items: links as unknown as Y.Item[], reads: () => reads};
}

/** The old walk: right from `from` until it meets `end` or runs out. */
function walk(from: Y.Item, end: Y.Item): boolean {
  for (let it: Y.Item | null = from; it !== null; it = it.right) {
    if (it === end) {
      return true;
    }
  }
  return false;
}

describe('reaches', () => {
  test('a stop past the end item costs the distance between them, not the rest of the container', () => {
    const {items, reads} = chain(100_000);
    // The end item at 10, the stop at 12, then 99,987 items.
    expect(reaches(items[12], items[10])).toBe(false);
    expect(reads()).toBeLessThanOrEqual(2 * 2);
  });

  test('a stop before the end item reads at most twice what the walk from the stop does', () => {
    const {items, reads} = chain(1_000);
    expect(reaches(items[100], items[150])).toBe(true);
    expect(reads()).toBeLessThanOrEqual(2 * 50);
  });

  test('the stop itself', () => {
    const {items, reads} = chain(10);
    expect(reaches(items[3], items[3])).toBe(true);
    expect(reads()).toBe(0);
  });

  test('items of different containers', () => {
    const a = chain(20);
    const b = chain(20);
    expect(reaches(a.items[5], b.items[2])).toBe(false);
    expect(reaches(b.items[2], a.items[5])).toBe(false);
  });

  test('answers as the walk does for every pair of items in a container with deleted and collected items', () => {
    for (const gc of [false, true]) {
      const doc = new Y.Doc({gc});
      const y = doc.get('c');
      // One item per character (each inserted before the last, so none
      // merge), then deletions in runs.
      for (let i = 0; i < 40; i++) {
        y.insert(0, String.fromCharCode(97 + (i % 26)));
      }
      for (const at of [30, 20, 20, 10, 3, 3, 3, 0]) {
        y.delete(at, 1);
      }
      const items: Y.Item[] = [];
      for (
        let it = (y as unknown as {_start: Y.Item | null})._start;
        it !== null;
        it = it.right
      ) {
        items.push(it);
      }
      expect(items.some(it => it.deleted)).toBe(true);
      for (const from of items) {
        for (const end of items) {
          expect(reaches(from, end)).toBe(walk(from, end));
        }
      }
    }
  });
});
