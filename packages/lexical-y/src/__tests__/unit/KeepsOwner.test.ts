/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Yjs's `Item.keep` has one owner in this package (see Keeps): the rules by
// which the undo stacks' keeps and the composition hold's are set and
// released, pinned, and no other module writes the flag.
import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {createYDoc} from '../..';
import {keepShown, UndoKeeps, unkeepShown} from '../../internal/Keeps';
import {scanKeepWrites} from '../utils/keepGuard';

/** A document with one text item in a nested node: [the text item, its parent's item]. */
function items(): [Y.Item, Y.Item] {
  const doc = createYDoc(null, {gc: false});
  const root = doc.get('lexical-y');
  const child = new Y.Node('b:box');
  root.insert(0, [child]);
  child.insert(0, 'text');
  return [child._start!, child._item!];
}

describe('Item.keep', () => {
  test('an undo lifetime keeps an item with the items of the nodes it is in, and releases them', () => {
    const [item, parent] = items();
    const keeps = new UndoKeeps();
    expect(keeps.keepsAny).toBe(false);
    keeps.keep(item);
    expect([item.keep, parent.keep, keeps.keepsAny]).toEqual([
      true,
      true,
      true,
    ]);
    keeps.release();
    expect([item.keep, parent.keep, keeps.keepsAny]).toEqual([
      false,
      false,
      false,
    ]);
  });

  test('an item two lifetimes keep is released by the last of them', () => {
    const [item] = items();
    const a = new UndoKeeps();
    const b = new UndoKeeps();
    a.keep(item);
    b.keep(item);
    a.release();
    expect(item.keep).toBe(true);
    b.release();
    expect(item.keep).toBe(false);
  });

  test('an item kept before any lifetime kept it stays kept', () => {
    const [item] = items();
    item.keep = true;
    const keeps = new UndoKeeps();
    keeps.keep(item);
    keeps.release();
    expect(item.keep).toBe(true);
  });

  test('a keep set again after a clear is released when the lifetime ends', () => {
    const [item] = items();
    const keeps = new UndoKeeps();
    keeps.keep(item);
    // The UndoManager's clear of a stack lets the item go.
    item.keep = false;
    keeps.keepAgain();
    expect([item.keep, keeps.rekeepsAny]).toEqual([true, true]);
    keeps.release();
    expect(item.keep).toBe(false);
    keeps.releaseRekept();
    expect([item.keep, keeps.rekeepsAny]).toEqual([false, false]);
  });

  test('a keep set again that another lifetime relies on goes to it', () => {
    const [item] = items();
    const a = new UndoKeeps();
    const b = new UndoKeeps();
    a.keep(item);
    b.keep(item);
    item.keep = false;
    a.keepAgain();
    // `b` holds it too once it finds it kept again.
    b.keepAgain();
    a.release();
    a.releaseRekept();
    expect(item.keep).toBe(true);
    b.release();
    b.releaseRekept();
    expect(item.keep).toBe(false);
  });

  test('a keep set again by one lifetime goes to another that still keeps the item', () => {
    const [item] = items();
    const a = new UndoKeeps();
    const b = new UndoKeeps();
    a.keep(item);
    b.keep(item);
    item.keep = false;
    // Only `a` keeps it again; `b` still keeps the item for a step.
    a.keepAgain();
    a.release();
    a.releaseRekept();
    expect(item.keep).toBe(true);
    b.release();
    b.releaseRekept();
    expect(item.keep).toBe(false);
  });

  test('the hold sets the flag only where it is not set, and says so', () => {
    const [item] = items();
    expect(keepShown(item)).toBe(true);
    expect(item.keep).toBe(true);
    expect(keepShown(item)).toBe(false);
    unkeepShown(item);
    expect(item.keep).toBe(false);
  });

  // The sources, read with the TypeScript compiler (see utils/keepGuard):
  // the declaration a property resolves to decides, so a comment, a line
  // break or an alias of the item neither hides a write nor makes one.
  test('no other module writes Item.keep', () => {
    expect(scanKeepWrites()).toEqual([]);
  }, 120_000);

  test('the scan finds a write over lines, through an alias, an element access and a compound assignment, and none in a comment, a string or a read', () => {
    const probe = `
import type {Item} from '@y/y';

// item.keep = true in a comment is not a write
/* item.keep = false */
export function reads(item: Item, other: {keep: boolean}): boolean {
  const text = 'item.keep = true';
  // A flag of the same name on another type is not Yjs's.
  other.keep = text.length > 0;
  return item.keep === other.keep;
}
export function overLines(item: Item): void {
  item
    // a comment between
    .keep =
    true;
}
export function aliased(item: Item): void {
  const it = item;
  it.keep = false;
}
export function indexed(item: Item): void {
  item['keep'] = true;
}
export function compound(item: Item, on: boolean): void {
  item.keep ||= on;
}
export function untyped(item: any): void {
  item.keep = true;
}
`;
    expect(
      scanKeepWrites({'ZzProbe.ts': probe}).filter(line =>
        line.startsWith('ZzProbe.ts '),
      ),
    ).toEqual([
      'ZzProbe.ts aliased',
      'ZzProbe.ts compound',
      'ZzProbe.ts indexed',
      'ZzProbe.ts overLines',
      'ZzProbe.ts untyped',
    ]);
  }, 120_000);
});
