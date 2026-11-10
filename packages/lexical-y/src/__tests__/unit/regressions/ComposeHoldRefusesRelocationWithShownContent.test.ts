/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A local relocation under a hold is refused before it changes anything
// (the local change undone, B's R kept everywhere, one warning) in these
// shapes too:
// - The inline container A composes in also holds an inline decorator the
//   editor shows (not held: it was there before A composed).
// - A takes two text nodes out of that container at once.

import {$create, $createTextNode, type ElementNode} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $composed,
  $listDocument,
  $relocate,
  composing,
  GCS,
  held,
  HoldBox,
  HoldChip,
  ORDERS,
  refused,
  relocated,
  type Relocation,
  settled,
} from '../../utils/composeHold';

const OTHER = 'paragraph("separator") / list[number,7](listitem("other"))';

describe('a relocation under a hold with other content in the container composed in', () => {
  for (const gc of GCS) {
    for (const ids of ORDERS) {
      for (const relocation of [
        'move',
        'other list',
        'nest',
        'unwrap',
      ] as Relocation[]) {
        const id = `(${relocation}, gc ${gc ? 'on' : 'off'}, ids ${ids})`;
        test(`the container composed in also holds an inline decorator the editor shows: refused, R kept ${id}`, async () => {
          const t = await composing(
            () =>
              $listDocument(() => [
                $create(HoldBox).append(
                  $createTextNode('abc'),
                  $create(HoldChip),
                ),
              ]),
            gc,
            ids,
          );
          await held(t, () => $composed().spliceText(1, 0, 'R'));
          t.a.update(() => $relocate(relocation));
          await t.sync();
          refused(t);
          expect(await settled(t)).toBe(
            relocated(null, 'box', '"aRbc" hold_chip'),
          );
        });
      }
      const id = `(gc ${gc ? 'on' : 'off'}, ids ${ids})`;
      test(`two text nodes taken out of the container composed in at once: refused, R kept ${id}`, async () => {
        const t = await composing(
          () =>
            $listDocument(() => [
              $create(HoldBox).append(
                $createTextNode('abc'),
                $createTextNode('xyz').setFormat('bold'),
              ),
            ]),
          gc,
          ids,
        );
        await held(t, () => $composed().spliceText(1, 0, 'R'));
        t.a.update(() => {
          const abc = $composed();
          const box = abc.getParentOrThrow() as ElementNode;
          const xyz = abc.getNextSibling()!;
          box.insertAfter(xyz);
          box.insertAfter(abc);
        });
        await t.sync();
        refused(t);
        expect(await settled(t)).toBe(
          `list[number](listitem(hold_box("aRbc" "xyz"{1})) listitem("tail")) / ${OTHER}`,
        );
      });
    }
  }
});
