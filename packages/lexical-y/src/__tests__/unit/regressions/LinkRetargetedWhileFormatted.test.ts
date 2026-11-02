/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// A links t4z, and B gets it. Then, at the same time, A extends that link
// over t4z..t6z with a new URL (after linking t2z..t3z, or not), while B
// underlines text covering the link or inside it. Every character of t4z,
// t5z and t6z shows A's new link: B's format writes no value for the link
// (#9597, whose fix this shares), so the old URL does not come back over t4z
// and the extension is not cut. Compared per character (a word can span
// text nodes).

import {$toggleLink, LinkNode} from '@lexical/link';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
} from 'lexical';
import {expect, test} from 'vitest';

import {$selectIn, expectConverged, setup} from '../../utils/harness';

// "t1z t2z t3z t4z t5z t6z": t2z 4..7 t3z 8..11 t4z 12..15 t5z 16..19 t6z 20..23
for (const ids of [
  [1, 2],
  [2, 1],
]) {
  for (const [name, withB, with02, bs, be] of [
    ['A 02 + 03 || B underlines t3z-t4z', true, true, 8, 15],
    ['A 03 only || B underlines t3z-t4z', true, false, 8, 15],
    [
      'A 03 only || B underlines t4z (the link text exactly)',
      true,
      false,
      12,
      15,
    ],
    ['A 03 only || B underlines "4z" (inside the link)', true, false, 13, 15],
    [
      'A 03 only || B underlines t2z-t3z (control: not the link)',
      true,
      false,
      4,
      11,
    ],
    ['control: A 02 + 03, B does nothing', false, true, 0, 0],
  ] as [string, boolean, boolean, number, number][]) {
    test(`${name} (ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('t1z t2z t3z t4z t5z t6z'),
            ),
          );
        },
        {ids},
      );
      t.a.update(() => {
        $selectIn([0], 12, 15);
        $toggleLink('https://x.test/01');
        $setSelection(null);
      });
      await t.sync();
      t.offline();
      if (with02) {
        t.a.update(() => {
          $selectIn([0], 4, 11);
          $toggleLink('https://x.test/02');
          $setSelection(null);
        });
      }
      t.a.update(() => {
        $selectIn([0], 12, 23);
        $toggleLink('https://x.test/03');
        $setSelection(null);
      });
      if (withB) {
        t.b.update(() => {
          $selectIn([0], bs, be).formatText('underline');
          $setSelection(null);
        });
      }
      await t.sync();
      await expectConverged(t.peers);
      // per character link URL, then per word (a word can span text nodes)
      const urls = t.a.read(() => {
        let text = '';
        const per: string[] = [];
        for (const n of $getRoot().getAllTextNodes()) {
          const p = n.getParent();
          for (const ch of n.getTextContent()) {
            text += ch;
            per.push(p instanceof LinkNode ? p.getURL().slice(-2) : '-');
          }
        }
        const out: Record<string, string> = {};
        for (const m of text.matchAll(/t\d+z/g))
          out[m[0]] = [
            ...new Set(per.slice(m.index!, m.index! + m[0].length)),
          ].join('|');
        return out;
      });
      expect({t4z: urls.t4z, t5z: urls.t5z, t6z: urls.t6z}).toEqual({
        t4z: '03',
        t5z: '03',
        t6z: '03',
      });
    });
  }
}
