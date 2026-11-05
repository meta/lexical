/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A unit's start notes the item it was folded up to (Seen.noteFolded), so a
// walk from an earlier left does not step those items twice. A note can go
// stale: the item it names is deleted (a moved block's old marker) while the
// unit keeps the start, and items inserted later between the unit's left and
// that item (an undo restoring a word) were never folded into it. The walk
// skipped them: an author's resolve then wrote against a line read without
// its restored word's comment and code format (self-check "format f:code
// at 0" and the author dropping the comment). A gone fold point is no boundary: the walk steps
// everything from its left.

import type * as Y from '@y/y';

import {expect, test, vi} from 'vitest';

import {createYDoc} from '../../..';
import {frontierOf, noteFolded} from '../../../internal/Seen';

test('a fold point that is gone is no frontier', () => {
  const doc = createYDoc(null, {gc: false});
  const root = doc.get('lexical-y');
  root.setAttr('lexical-y:3', true);
  // Four items (inserted before one another: none merges).
  for (const ch of ['d', 'c', 'b', 'a']) {
    root.insert(0, ch);
  }
  const items: Y.Item[] = [];
  for (let it = root._start; it !== null; it = it.right) {
    items.push(it);
  }
  const [left, to] = [items[0], items[items.length - 1]];
  const start = new Map<string, unknown>([['f:bold', true]]);
  noteFolded(start, to);
  // While the fold point is live and after the walk's left: skipped up to it.
  expect(frontierOf(null, start, left, root, null)).toBe(to);
  // Once it is gone (a fresh note: the answer is kept per note and left).
  root.delete(3, 1);
  const again = new Map(start);
  noteFolded(again, to);
  expect(to.deleted).toBe(true);
  expect(frontierOf(null, again, left, root, null)).toBeNull();
});

test('a start folded again once is a fresh fold: no refold per later walk', () => {
  const doc = createYDoc(null, {gc: false});
  const root = doc.get('lexical-y');
  root.setAttr('lexical-y:3', true);
  // A container: 1,000 items before the unit's left.
  for (let i = 0; i < 1_000; i++) {
    root.insert(0, String.fromCharCode(97 + (i % 26)));
  }
  // Two items that do not merge (the second inserted before the first).
  root.insert(root.length, 'y');
  root.insert(root.length - 1, 'x');
  const items: Y.Item[] = [];
  for (let it = root._start; it !== null; it = it.right) {
    items.push(it);
  }
  const to = items[items.length - 1];
  const left = items[items.length - 3];
  const start = new Map<string, unknown>();
  noteFolded(start, to);
  root.delete(root.length - 1, 1);
  expect(to.deleted).toBe(true);
  // The first walk folds the start again (once: a refold clears the start
  // and folds it up to `left`); 1,000 more walks from the same left
  // (keystrokes in that line) take it as folded up to `left`.
  const refolds = vi.spyOn(start, 'clear');
  expect(frontierOf(null, start, left, root, null)).toBeNull();
  expect(refolds).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 1000; i++) {
    expect(frontierOf(null, start, left, root, null)).toBeNull();
  }
  expect(refolds).toHaveBeenCalledTimes(1);
});
