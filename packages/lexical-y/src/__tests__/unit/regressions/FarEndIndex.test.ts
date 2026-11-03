/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The index of ends finds most openers a few items left of their end, and
// any other by the store and the container's order: an opener more than
// 16 items before its end (text deleted from the run in many places leaves
// its pieces and tombstones between them) is indexed the same, and the run
// reads the same in a fresh read.

import * as Y from '@y/y';
import {$getRoot, $setSelection} from 'lexical';
import {expect, test} from 'vitest';

import {endsOf, isValidEnd} from '../../../internal/Ident';
import {
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  setup,
} from '../../utils/harness';

for (const gc of [false, true]) {
  test(`an end far from its opener is indexed as a near one (gc ${gc})`, async () => {
    const t = await setup(
      () => $getRoot().append($p('abcdefghijklmnopqrstuvwxyz tail')),
      {gc},
    );
    t.a.update(() => {
      $selectIn([0], 0, 26).formatText('bold');
      $setSelection(null);
    });
    await t.sync();
    // Every other letter deleted, one at a time: the run's text becomes
    // 25 items (13 live, 12 tombstones) between its opener and its end.
    for (let i = 0; i < 12; i++) {
      t.b.update(() => {
        $selectIn([0], 1 + i, 2 + i).removeText();
        $setSelection(null);
      });
    }
    await t.sync();
    const fresh = await freshReader(t.a);
    expect(fresh.describe()).toBe(t.a.describe());
    // The run's opener and end in the fresh reader's document, and the
    // items between them.
    const root = fresh.doc.get('lexical-y') as unknown as {
      _start: Y.Item | null;
    };
    let opener: Y.Item | null = null;
    let end: Y.Item | null = null;
    let between = 0;
    for (let it = root._start; it !== null; it = it.right) {
      if (
        !it.deleted &&
        it.content instanceof Y.ContentFormat &&
        it.content.key === 'f:bold'
      ) {
        if (Array.isArray(it.content.value)) {
          end = it;
          break;
        }
        opener = it;
        between = 0;
      } else if (opener !== null) {
        between++;
      }
    }
    expect(opener).not.toBeNull();
    expect(end).not.toBeNull();
    expect(between).toBeGreaterThan(16);
    expect(isValidEnd(end!)).toBe(true);
    expect(endsOf(opener!)).toContain(end);
    expect(fresh.warnings.filter(w => /self-check/.test(w))).toEqual([]);
    fresh.binding.dispose();
    await expectConverged(t.peers);
  });
}
