/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes `abc` (in an inline container in a list item, or straight in
// the item's line); B inserts something in the composed text, which A's
// hold keeps back; A then relocates what it composed in (see
// composeHold's $relocate). Writing the relocation would delete what B
// inserted with the old shared nodes, so it is refused: the relocation is
// undone, B's insertion stays where B made it on every peer and a fresh
// reader, and A is warned once. Two held spans, a link (an inline element
// with its text), an inline decorator, and a split of the composed line
// (its successor line).

import {$createLinkNode} from '@lexical/link';
import {$create, $createTextNode} from 'lexical';
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
  type Shape,
} from '../../utils/composeHold';

const RELOCATIONS: [Relocation, Shape][] = [
  ['move', 'box'],
  ['other list', 'box'],
  ['nest', 'box'],
  ['unwrap', 'box'],
  ['move', 'line'],
  ['other list', 'line'],
  ['nest', 'line'],
];

const $init = (shape: Shape) => () =>
  $listDocument(() => {
    const abc = $createTextNode('abc');
    return shape === 'box' ? [$create(HoldBox).append(abc)] : [abc];
  });

/** B's insertion held, A's relocation refused: what everyone shows. */
async function $refusedOver(
  shape: Shape,
  relocation: Relocation,
  gc: boolean,
  ids: number[],
  insert: () => void,
): Promise<string> {
  const t = await composing($init(shape), gc, ids);
  await held(t, insert);
  t.a.update(() => $relocate(relocation));
  await t.sync();
  refused(t);
  return settled(t);
}

describe('a local relocation of what A composed in, over a held insertion, is refused', () => {
  for (const gc of GCS) {
    for (const ids of ORDERS) {
      for (const [relocation, shape] of RELOCATIONS) {
        const id = `(${relocation}, ${shape}, gc ${gc ? 'on' : 'off'}, ids ${ids})`;
        test(`two held spans stay where B typed them ${id}`, async () => {
          const shown = await $refusedOver(shape, relocation, gc, ids, () => {
            const n = $composed();
            n.spliceText(2, 0, 'S');
            n.spliceText(1, 0, 'R');
          });
          expect(shown).toBe(relocated(null, shape, '"aRbSc"'));
        });
        test(`a held link and its text stay where B inserted them ${id}`, async () => {
          const shown = await $refusedOver(shape, relocation, gc, ids, () => {
            $composed()
              .select(1, 1)
              .insertNodes([
                $createLinkNode('https://x.test').append($createTextNode('L')),
              ]);
          });
          expect(shown).toBe(
            relocated(null, shape, '"a" link<https://x.test>("L") "bc"'),
          );
        });
        test(`a held inline decorator stays where B inserted it ${id}`, async () => {
          const shown = await $refusedOver(shape, relocation, gc, ids, () => {
            $composed()
              .select(1, 1)
              .insertNodes([$create(HoldChip)]);
          });
          expect(shown).toBe(relocated(null, shape, '"a" hold_chip "bc"'));
        });
        if (shape === 'line') {
          // B splits the composed line after `ab`: its successor line `c`.
          test(`a held split of the composed line stays as B made it ${id}`, async () => {
            const shown = await $refusedOver(shape, relocation, gc, ids, () => {
              $composed().select(2, 2).insertParagraph();
            });
            expect(shown).toBe(
              'list[number](listitem("ab") listitem("c") listitem("tail")) / paragraph("separator") / list[number,7](listitem("other"))',
            );
          });
        }
      }
    }
  }
});
