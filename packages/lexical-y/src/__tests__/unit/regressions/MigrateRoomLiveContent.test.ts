/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// describeYRoom reads a root's live content, as the runner does: a root
// whose items and attributes were all deleted (tombstones only, gc off) is
// pristine and not unreadable, so the room is offered a seed instead of
// being refused for a root nothing can read.

import {describe, expect, test} from 'vitest';

import {createYDoc, describeYRoom} from '../../../server';

describe.each([false, true])('describeYRoom live content, gc %s', gc => {
  test('a root whose items and attributes were all deleted is pristine', () => {
    const doc = createYDoc(null, {gc});
    const root = doc.get('lexical-y');
    root.insert(0, 'abc');
    root.setAttr('unrelated', 1);
    root.delete(0, 3);
    root.deleteAttr('unrelated');
    expect(root.length).toBe(0);
    const room = describeYRoom(doc, {
      incarnation: 'inc-1',
      inherited: false,
      seedContract: 1,
    });
    expect(room.pristine).toBe(true);
    expect(room.unreadable).toEqual([]);
    expect(room.layouts).toBeNull();
    doc.destroy();
  });

  test('control: a root with live content and no record is unreadable, not pristine', () => {
    const doc = createYDoc(null, {gc});
    doc.get('lexical-y').insert(0, 'abc');
    const room = describeYRoom(doc, {
      incarnation: 'inc-1',
      inherited: false,
      seedContract: 1,
    });
    expect(room.pristine).toBe(false);
    expect(room.unreadable).toEqual(['lexical-y']);
    doc.destroy();
  });
});
