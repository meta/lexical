/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The handshake reads every served root (code review round 1, M7): a root
// at the client's ceiling must not hide another served root below its
// floor, nor one without a well-formed record.

import {describe, expect, test} from 'vitest';

import {checkYSession, createYDoc, describeYRoom} from '../../../server';

describe.each([false, true])('served roots, gc %s', gc => {
  test('a root below the client floor beside one at its ceiling: stale with material, refuse-layout without', () => {
    const doc = createYDoc(null, {gc});
    doc.get('old').setAttr('lexical-y:1', true);
    doc.get('old').insert(0, 'old text');
    doc.get('new').setAttr('lexical-y:2', true);
    doc.get('new').insert(0, 'new text');
    const room = describeYRoom(doc, {
      incarnation: 'i',
      inherited: false,
      roots: ['old', 'new'],
      seedContract: 1,
    });
    expect(room.layouts).toEqual([1, 2]);
    expect(
      checkYSession(room, {
        generation: room.generation,
        layouts: [2, 2],
        material: true,
        seed: 1,
        v: 1,
      }),
    ).toMatchObject({verdict: 'stale'});
    expect(
      checkYSession(room, {
        generation: null,
        layouts: [2, 2],
        material: false,
        seed: 1,
        v: 1,
      }),
    ).toMatchObject({verdict: 'refuse-layout'});
    // A client reading both: admitted.
    expect(
      checkYSession(room, {
        generation: room.generation,
        layouts: [1, 2],
        material: true,
        seed: 1,
        v: 1,
      }),
    ).toEqual({initialize: false, verdict: 'admit'});
    doc.destroy();
  });

  test('a served root with content but no layout record: no client reads the room', () => {
    const doc = createYDoc(null, {gc});
    doc.get('a').setAttr('lexical-y:2', true);
    doc.get('a').insert(0, 'a');
    doc.get('b').insert(0, 'no record');
    // Not served: ignored.
    doc.get('c').setAttr('lexical-y:x', true);
    const room = describeYRoom(doc, {
      incarnation: 'i',
      inherited: false,
      roots: ['a', 'b'],
      seedContract: 1,
    });
    expect(room.unreadable).toEqual(['b']);
    for (const material of [false, true]) {
      expect(
        checkYSession(room, {
          generation: room.generation,
          layouts: [1, 9],
          material,
          seed: 1,
          v: 1,
        }).verdict,
      ).toBe(material ? 'stale' : 'refuse-layout');
    }
    expect(
      describeYRoom(doc, {
        incarnation: 'i',
        inherited: false,
        roots: ['a'],
        seedContract: 1,
      }).unreadable,
    ).toEqual([]);
    doc.destroy();
  });
});
