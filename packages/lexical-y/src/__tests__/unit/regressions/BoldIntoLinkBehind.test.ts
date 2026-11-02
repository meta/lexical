/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// A bolds t5z t6z, links t7z..t10z and underlines t6z, and B gets those.
// Then, at the same time, A bolds "t6z t7z" (the bold now reaches into the
// link's first word) while B, one update behind, types after t5z inside the
// old bold run. B's write closes that run again at its old end, in the same
// spot where A's write extends it: two items of one format key at one spot
// (#9626). For client ids 1,2, B's closer wins, and A's bold ends after t6z.
// The space after t6z loses it on main too. t7z keeps it on main only because
// A's bold over the link also wrote the link's value again and opened bold
// inside it. With a link's text fields no longer stored (#9597), the link
// behaves like a mark there (a comment on t7z loses it on main the same
// way), so t7z loses it too: expected failures naming #9626.

import {$toggleLink} from '@lexical/link';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {$selectIn, expectConverged, setup} from '../../utils/harness';

// "t1z t2z t3z t4z t5z t6z t7z t8z t9z t10z"
const $range = (from: string, to: string) => {
  const text = $getRoot().getTextContent().replace(/\n/g, '');
  return [text.indexOf(from), text.indexOf(to) + to.length];
};

for (const ids of [
  [1, 2],
  [2, 1],
]) {
  for (const [name, bTypes, bUnstrike] of [
    ['B types after t5z', true, false],
    ['B types after t5z, after a no-op unstrike', true, true],
    ['control: B does nothing', false, false],
  ] as [string, boolean, boolean][]) {
    // #9626: B's closer at the old end of the bold run wins over A's
    // extension of it for this order.
    const known = bTypes && ids[0] === 1;
    (known ? test.fails : test)(
      `${name}, ids ${ids}: t7z keeps A's bold${known ? ' (#9626)' : ''}`,
      async () => {
        const t = await setup(
          () => {
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('t1z t2z t3z t4z t5z t6z t7z t8z t9z t10z'),
              ),
            );
          },
          {ids},
        );
        const $select = (from: string, to: string) => {
          const [s, e] = $range(from, to);
          return $selectIn([0], s, e);
        };
        try {
          t.offline();
          if (bUnstrike) {
            t.b.update(() => {
              const selection = $select('t8z', 't8z');
              selection.format = 4;
              selection.formatText('strikethrough');
              $setSelection(null);
            });
          }
          t.a.update(() => {
            $select('t5z', 't6z').formatText('bold');
            $setSelection(null);
          });
          t.a.update(() => {
            $select('t7z', 't10z');
            $toggleLink('https://x.test/01');
            $setSelection(null);
          });
          t.a.update(() => {
            $select('t6z', 't6z').formatText('underline');
            $setSelection(null);
          });
          t.a.update(() => {
            $select('t6z', 't7z').formatText('bold');
            $setSelection(null);
          });
          // B gets A's first three updates, not the fourth.
          const pending = (
            t.b as unknown as {pending: Map<unknown, Uint8Array[]>}
          ).pending.get(t.a)!;
          for (const update of pending.splice(0, 3)) {
            Y.applyUpdate(
              t.b.doc,
              update,
              (t.b as unknown as {net: unknown}).net,
            );
          }
          await new Promise(resolve => setTimeout(resolve, 0));
          if (bTypes) {
            t.b.update(() => {
              const [, end] = $range('t5z', 't5z');
              const selection = $selectIn([0], end, end);
              selection.format = 0;
              selection.insertText(' q12z');
              $setSelection(null);
            });
          }
          await t.sync();
          await expectConverged(t.peers);
          expect(
            t.a.read(() =>
              (
                $getRoot()
                  .getAllTextNodes()
                  .find(n => n.getTextContent().includes('t7z')) as TextNode
              ).hasFormat('bold'),
            ),
          ).toBe(true);
        } finally {
          for (const p of t.peers) {
            p.stop();
          }
        }
      },
    );
  }
}
