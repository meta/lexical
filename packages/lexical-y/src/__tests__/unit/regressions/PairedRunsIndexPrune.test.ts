/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Paired runs: the index of ends (which opener each end names) drops what no
// reader can need once every change is read: deleted ends and the entries of
// deleted openers. A word bolded and unbolded 1,000 times deletes each run
// it made (K1); the index stays at most 256 openers (pruned whenever it
// doubles) instead of holding all 500 runs ever written (gc on and off; the
// document's one binding per peer).

import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {afterEach, expect, test} from 'vitest';

import {indexedOpeners} from '../../../internal/Ident';
import {$selectIn, expectConverged, setup} from '../../utils/harness';
import {setFormatIdentityWritesDefault} from '../../utils/noSwitch';

afterEach(() => {
  setFormatIdentityWritesDefault(false);
});

for (const gc of [false, true]) {
  test(`1,000 toggles of one word keep the index of ends bounded (gc ${gc ? 'on' : 'off'})`, async () => {
    setFormatIdentityWritesDefault(true);
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('alpha beta gamma')),
        ),
      {gc},
    );
    for (let i = 0; i < 1000; i++) {
      t.a.update(() => {
        $selectIn([0], 6, 10).formatText('bold', i % 2 === 0 ? 1 : 0);
      });
      await t.sync();
    }
    await expectConverged(t.peers, 'paragraph("alpha beta gamma")');
    for (const peer of t.peers) {
      expect(indexedOpeners(peer.doc)).toBeLessThanOrEqual(256);
    }
  }, 120_000);
}
