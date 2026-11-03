/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The copy repair notes which item first held each end's value array. It
// did so with a symbol property defined on the array, for every array on a
// covered name, below layout 3 too: a raw writer's frozen array threw
// ("object is not extensible") where main accepts it, and arrays of a
// document below layout 3 were changed (GPT code review r1, item 6). Arrays
// in a document without the layout 3 record are now left untouched (read
// as identity syntax all the same: the raw-array trade), and a frozen array
// is noted off the array in layout 3 too.

import {$getRoot, $setSelection} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';
import {setFormatIdentityWritesDefault} from '../../utils/noSwitch';

afterEach(() => {
  setFormatIdentityWritesDefault(false);
});

const rootOf = (peer: Peer) => peer.doc.get('lexical-y');

for (const gc of [false, true]) {
  for (const on of [false, true]) {
    test(`a raw writer's frozen array on a covered name (switch ${on ? 'on' : 'off'}, gc ${gc ? 'on' : 'off'})`, async () => {
      setFormatIdentityWritesDefault(on);
      const t = await setup(() => $getRoot().append($p('abc')), {gc});
      // A client's first edit: with the switch on it records layout 3.
      t.a.update(() => {
        $selectIn([0], 2, 3).formatText('bold');
        $setSelection(null);
      });
      const value = Object.freeze([1]);
      expect(() =>
        t.a.doc.transact(
          () => rootOf(t.a).format(0, 1, {'s:tags\u001fx': value}),
          'raw',
        ),
      ).not.toThrow();
      expect(Object.getOwnPropertySymbols(value)).toEqual([]);
      await t.sync();
      await expectConverged([...t.peers, await freshReader(t.a)]);
    });
  }
}
