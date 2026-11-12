/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes `abc` in an inline container that follows a text `x` with the
// same format; B types R in it (and, the second case, bolds it), held.
// A unwraps the container: its text lands next to `x`, and Lexical merges
// the two text nodes, the composed one into `x` (its key is gone, its text
// lives on in the survivor). Writing that would delete R with the
// container, so the unwrap is refused before it writes anything: R, and
// B's bold, stay in the container on every peer and a fresh reader, with
// one warning.

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
  ORDERS,
  refused,
  settled,
} from '../../utils/composeHold';

const OTHER = 'paragraph("separator") / list[number,7](listitem("other"))';

describe('an unwrap under a hold that merges the composed text into a survivor', () => {
  for (const gc of GCS) {
    for (const ids of ORDERS) {
      for (const bold of [false, true]) {
        const id = `(${bold ? "R and B's bold" : 'R'}, gc ${gc ? 'on' : 'off'}, ids ${ids})`;
        const abc = bold ? '"aRbc"{1}' : '"aRbc"';
        const $merge = async () => {
          const t = await composing(
            () =>
              $listDocument(() => [
                $createTextNode('x'),
                $create(HoldBox).append($createTextNode('abc')),
              ]),
            gc,
            ids,
          );
          await held(t, () => {
            const n = $composed();
            if (bold) {
              n.setFormat('bold');
            }
            n.spliceText(1, 0, 'R');
          });
          t.a.update(() => $relocate('unwrap'));
          await t.sync();
          refused(t);
          return settled(t);
        };
        test(`the unwrap that merges the composed text into the text before it is refused: R${bold ? " and B's bold" : ''} stay in the container ${id}`, async () => {
          expect(await $merge()).toBe(
            `list[number](listitem("x" hold_box(${abc})) listitem("tail")) / ${OTHER}`,
          );
        });
      }
    }
  }
});
