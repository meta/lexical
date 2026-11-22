/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A edits the composed text in the same update as its relocation of the
// inline container composed in (appends Z, deletes the last character, or
// italicizes it), while B's R is held. The relocation would delete R with
// the old shared nodes, so the whole local change is refused before it
// writes anything: R is kept where it was, the relocation and A's edit are
// undone, with one warning. The same edits without a relocation are the
// controls, written with no warning.

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
  REFUSAL,
  type Relocation,
  settled,
} from '../../utils/composeHold';

const OTHER = 'paragraph("separator") / list[number,7](listitem("other"))';
type Edit = 'append' | 'delete' | 'format';

const $edit = (edit: Edit) => {
  const n = $composed();
  if (edit === 'append') {
    n.setTextContent(n.getTextContent() + 'Z');
  } else if (edit === 'delete') {
    n.spliceText(n.getTextContentSize() - 1, 1, '');
  } else {
    n.toggleFormat('italic');
  }
};

/** The box's children once A's edit applies to what A saw. */
const EDITED: Record<Edit, string> = {
  append: '"aRbcZ"',
  delete: '"aRb"',
  format: '"a"{2} "R" "bc"{2}',
};

function relocated(relocation: Relocation | null, content: string): string {
  if (relocation === 'move') {
    return `list[number](listitem("tail") listitem(hold_box(${content}))) / ${OTHER}`;
  }
  if (relocation === 'unwrap') {
    return `list[number](listitem(${content}) listitem("tail")) / ${OTHER}`;
  }
  return `list[number](listitem(hold_box(${content})) listitem("tail")) / ${OTHER}`;
}

const $box = () =>
  $listDocument(() => [$create(HoldBox).append($createTextNode('abc'))]);

async function run(
  edit: Edit,
  relocation: Relocation | null,
  gc: boolean,
  ids: number[],
) {
  const t = await composing($box, gc, ids);
  await held(t, () => $composed().spliceText(1, 0, 'R'));
  t.a.update(() => {
    $edit(edit);
    if (relocation !== null) {
      $relocate(relocation);
    }
  });
  await t.sync();
  const refused = t.a.warnings.length > 0;
  if (refused) {
    expect(t.a.warnings).toHaveLength(1);
    expect(t.a.warnings[0]).toMatch(REFUSAL);
    t.a.warnings.length = 0;
  }
  return {refused, shown: await settled(t)};
}

describe('local edits in the same update as a relocation under a hold', () => {
  for (const gc of GCS) {
    for (const ids of ORDERS) {
      for (const edit of ['append', 'delete', 'format'] as Edit[]) {
        const id = `(${edit}, gc ${gc ? 'on' : 'off'}, ids ${ids})`;
        test(`control: A's edit without a relocation keeps R ${id}`, async () => {
          const {refused, shown} = await run(edit, null, gc, ids);
          expect(refused).toBe(false);
          expect(shown).toBe(relocated(null, EDITED[edit]));
        });
        for (const relocation of ['move', 'unwrap'] as Relocation[]) {
          const rid = `(${edit}, ${relocation}, gc ${gc ? 'on' : 'off'}, ids ${ids})`;
          if (edit === 'append') {
            // An update that inserts a character is written as made, so that
            // no typed character is undone (see $heldDecision): A's typing
            // and the relocation are written, and R goes with the old
            // container, as main writes it.
            test(`the relocation with A's typing in the text composed in is written: the typing is kept and every peer agrees ${rid}`, async () => {
              const {refused, shown} = await run(edit, relocation, gc, ids);
              expect(refused).toBe(false);
              expect(shown).toContain('abcZ');
            });
            test.fails(
              `an update that types and moves the container being composed in loses the collaborator's held text, as main does ${rid}`,
              async () => {
                const {shown} = await run(edit, relocation, gc, ids);
                expect(shown).toContain('R');
              },
            );
          } else {
            test(`the relocation with A's edit of the text composed in is refused: R is kept, the relocation and the edit are undone ${rid}`, async () => {
              const {refused, shown} = await run(edit, relocation, gc, ids);
              expect(refused).toBe(true);
              expect(shown).toBe(relocated(null, '"aRbc"'));
            });
          }
        }
      }
    }
  }
});
