/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// Whatever B's held change stores, a local relocation over it is refused,
// and every peer and a fresh reader show what is stored, not what the
// composer showed (A's hold shows `abc` as it was): a hold with nothing
// kept (B only typed R), B's own format change, B's undo of a format it
// gave before A composed (the stored text is plain again; A still showed
// it bold), and formats the composed text inherits from a run opened
// before it in its container. A composes `abc`; B's change is held; A
// relocates; the relocation is refused with one warning.

import {
  $create,
  $createTextNode,
  $setSelection,
  type ElementNode,
} from 'lexical';
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
  relocated,
  type Relocation,
  settled,
} from '../../utils/composeHold';

const OTHER = 'paragraph("separator") / list[number,7](listitem("other"))';
const RELOCATIONS: Relocation[] = ['move', 'other list', 'nest', 'unwrap'];

const $box = () =>
  $listDocument(() => [$create(HoldBox).append($createTextNode('abc'))]);

describe("a local relocation over B's held change is refused, and the stored text and formats stay", () => {
  for (const gc of GCS) {
    for (const ids of ORDERS) {
      for (const relocation of RELOCATIONS) {
        const id = `(${relocation}, gc ${gc ? 'on' : 'off'}, ids ${ids})`;
        test(`a hold that keeps nothing (B only typed R) ${id}`, async () => {
          const t = await composing($box, gc, ids);
          await held(t, () => $composed().spliceText(1, 0, 'R'));
          t.a.update(() => $relocate(relocation));
          await t.sync();
          refused(t);
          expect(await settled(t)).toBe(relocated(null, 'box', '"aRbc"'));
        });
        test(`B's format change and R ${id}`, async () => {
          const t = await composing($box, gc, ids);
          await held(t, () => {
            const n = $composed();
            n.setFormat('bold');
            n.spliceText(1, 0, 'R');
          });
          t.a.update(() => $relocate(relocation));
          await t.sync();
          refused(t);
          expect(await settled(t)).toBe(relocated(null, 'box', '"aRbc"{1}'));
        });
        test(`B's undo of a format given before A composed, then R: the stored text is plain ${id}`, async () => {
          // B bolds `abc` before A composes.
          const t = await composing($box, gc, ids, async s => {
            s.b.update(() => {
              $composed().setFormat('bold');
              $setSelection(null);
            });
            await s.sync();
          });
          // B undoes its bold (A keeps showing it bold) and types R.
          t.b.undo();
          await t.sync();
          await held(t, () => $composed().spliceText(1, 0, 'R'));
          t.a.update(() => $relocate(relocation));
          await t.sync();
          refused(t);
          expect(await settled(t)).toBe(relocated(null, 'box', '"aRbc"'));
        });
      }
      // The composed text inherits bold from a run opened before it in its
      // container ("xx" bold and red, then "abc" bold: one bold run).
      for (const bChange of ['R', 'R and plain'] as const) {
        const id = `(${bChange}, gc ${gc ? 'on' : 'off'}, ids ${ids})`;
        const $inherit = () =>
          $listDocument(() => [
            $create(HoldBox).append(
              $createTextNode('xx').setFormat('bold').setStyle('color: red;'),
              $createTextNode('abc').setFormat('bold'),
            ),
          ]);
        const hold = async (t: Awaited<ReturnType<typeof composing>>) =>
          held(t, () => {
            const n = $composed();
            if (bChange === 'R and plain') {
              n.setFormat(0);
            }
            n.spliceText(1, 0, 'R');
          });
        const abc = bChange === 'R' ? '"aRbc"{1}' : '"aRbc"';
        const unmoved = `list[number](listitem(hold_box("xx"{1} ${abc})) listitem("tail")) / ${OTHER}`;
        test(`formats inherited from a run opened before the composed text: the container unwrapped ${id}`, async () => {
          const t = await composing($inherit, gc, ids);
          await hold(t);
          t.a.update(() => $relocate('unwrap'));
          await t.sync();
          refused(t);
          expect(await settled(t)).toBe(unmoved);
        });
        test(`formats inherited from a run opened before the composed text: the composed text taken out of its container ${id}`, async () => {
          const t = await composing($inherit, gc, ids);
          await hold(t);
          t.a.update(() => {
            const n = $composed();
            (n.getParentOrThrow() as ElementNode).insertAfter(n);
          });
          await t.sync();
          refused(t);
          expect(await settled(t)).toBe(unmoved);
        });
      }
    }
  }
});
