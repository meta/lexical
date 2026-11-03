/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A document of plain values (a main client's: a value, then a
// null where it was removed) leaves one run of no value per key it ever
// closed. Those runs are kept in one persistent map in the formats map, so a
// copy of the map (every unit start takes one) copies one reference for all
// of them; they are the same entries, found wherever a key's stack is.

import * as Y from '@y/y';
import {expect, test} from 'vitest';

import {equalStacks, isOnStack, stepFormat} from '../../../internal/Ident';

function fold(container: Y.Node): Map<string, unknown> {
  const formats = new Map<string, unknown>();
  for (
    let it = container._start as Y.Item | null;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    if (!it.deleted && it.content instanceof Y.ContentFormat) {
      stepFormat(formats, it);
    }
  }
  return formats;
}

test('runs of no value over nothing share one entry of the formats map', () => {
  const a = new Y.Doc({gc: false});
  a.cleanupFormatting = false;
  a.clientID = 1;
  const ra = a.get('c');
  const keys: string[] = [];
  for (let i = 0; i < 300; i++) {
    keys.push(`s:markIds\u001fc${i}`);
  }
  // As a main client stores a comment added, then removed: its value
  // before the text, a null after it.
  a.transact(tr => {
    let left: Y.Item | null = null;
    const append = (content: Y.ContentFormat | Y.ContentString) => {
      const item: Y.Item = new Y.Item(
        Y.createID(1, a.store.getClock(1)),
        left,
        left && left.lastId,
        null,
        null,
        ra,
        null,
        content,
      );
      item.integrate(tr, 0);
      left = item;
    };
    for (const key of keys) {
      append(new Y.ContentFormat(key, true as never));
      append(new Y.ContentString('ab'));
      append(new Y.ContentFormat(key, null as never));
      append(new Y.ContentString(' '));
    }
  });
  const formats = fold(ra);
  // One entry for all the runs of no value, not one per key.
  expect(formats.size).toBeLessThan(4);
  // Each null is still on its key's stack.
  let nulls = 0;
  for (
    let it = ra._start as Y.Item | null;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    if (
      !it.deleted &&
      it.content instanceof Y.ContentFormat &&
      it.content.value === null &&
      it.id.client === 1
    ) {
      const key = it.content.key;
      if (isOnStack(formats, key, it.id.client, it.id.clock)) {
        nulls++;
      }
    }
  }
  expect(nulls).toBe(keys.length);
  // A copy and an independent fold compare equal (sameFormats' rule).
  const again = fold(ra);
  for (const [k, v] of formats) {
    expect(equalStacks(v, again.get(k))).toBe(true);
  }
  expect(new Map(formats).size).toBe(formats.size);
});
