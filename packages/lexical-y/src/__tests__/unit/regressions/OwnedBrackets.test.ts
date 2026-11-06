/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The brackets around a writer's own Yjs mutations (see Owned.ts): what
// another owner writes inside one (a binding's write nested in a hook the
// mutation runs) is left out of it, and what anyone writes between two is
// in neither.

import {expect, test} from 'vitest';

import {createYDoc} from '../../..';
import {
  asOwner,
  collectOwned,
  isOwned,
  owned,
  type OwnedRanges,
} from '../../../internal/Owned';

test("a nested owner's write inside a bracket is left out of it", () => {
  const doc = createYDoc(null, {gc: false});
  const root = doc.get('owned-test');
  const writer = {};
  const other = {};
  const ranges: OwnedRanges = [];
  const clock = () => doc.store.getClock(doc.clientID);
  const marks: Record<string, [number, number]> = {};
  const mark = (name: string, fn: () => void) => {
    const start = clock();
    fn();
    marks[name] = [start, clock()];
  };
  doc.transact(() => {
    collectOwned(writer, ranges, () =>
      asOwner(writer, () => {
        owned(doc, () => {
          mark('own before', () => root.insert(0, 'ab'));
          // Another owner's write, nested inside the bracket.
          asOwner(other, () =>
            owned(doc, () => mark('nested', () => root.insert(0, 'XY'))),
          );
          mark('own after', () => root.insert(0, 'cd'));
        });
        // Anyone's write between two brackets.
        mark('between', () => root.insert(0, 'Q'));
        owned(doc, () => mark('own later', () => root.insert(0, 'ef')));
      }),
    );
  });
  const covers = ([start, end]: [number, number], want: boolean) => {
    for (let c = start; c < end; c++) {
      expect(isOwned(ranges, c)).toBe(want);
    }
  };
  covers(marks['own before'], true);
  covers(marks['own after'], true);
  covers(marks['own later'], true);
  covers(marks.nested, false);
  covers(marks.between, false);
});
