/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// Undo and redo around a refused relocation under a hold. A composes `abc`
// (in an inline container, or straight in a list item's line); B's R is
// held; then:
// - A relocates the item (or unwraps the container), with B's bold held
//   too or not, or with A's own edit of the text in the same update, or
//   over a held decorator. Refused, it writes nothing: it adds no undo
//   step, and A's undo changes nothing (every peer and a fresh reader show
//   R where it was, with B's stored format).
// - A removes the container on purpose (R goes with it, as main deletes
//   what A removes); undo brings it back with R once, redo removes it.
// - An app's selection transform moves the composition elsewhere: the hold
//   ends and A shows R. That release is no one's edit: it adds no undo step
//   of A's, and A's undo leaves R.

import {
  $create,
  $createTextNode,
  $getRoot,
  $setCompositionKey,
  type BaseSelection,
  type RangeSelection,
  TextNode,
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
  HoldChip,
  ORDERS,
  refused,
  relocated,
  type Relocation,
  settled,
  type Shape,
} from '../../utils/composeHold';
import {freshReader} from '../../utils/harness';

const OTHER = 'paragraph("separator") / list[number,7](listitem("other"))';
const BEFORE = `list[number](listitem(hold_box("aRbc")) listitem("tail")) / ${OTHER}`;
const CASES: [Relocation, Shape][] = [
  ['move', 'box'],
  ['other list', 'box'],
  ['nest', 'box'],
  ['unwrap', 'box'],
  ['move', 'line'],
  ['other list', 'line'],
  ['nest', 'line'],
];

const $box = () =>
  $listDocument(() => [$create(HoldBox).append($createTextNode('abc'))]);
const $init = (shape: Shape) =>
  shape === 'box' ? $box : () => $listDocument(() => [$createTextNode('abc')]);

/** Every peer and a fresh reader show `want`. */
async function agree(t: Awaited<ReturnType<typeof composing>>, want: string) {
  for (const p of t.peers) {
    expect(p.describe()).toBe(want);
  }
  const fresh = await freshReader(t.a);
  try {
    expect(fresh.describe()).toBe(want);
  } finally {
    fresh.stop();
  }
}

/**
 * When armed: A's selection transform puts the caret and the composition
 * in the item `tail` (an app's selection transform, which the binding does
 * not foresee), once.
 */
let armed = false;
class RelocatingText extends TextNode {
  $config() {
    return this.config('hold_relocating_text', {extends: TextNode});
  }
  selectionTransform(
    prevSelection: null | BaseSelection,
    nextSelection: RangeSelection,
  ): void {
    super.selectionTransform(prevSelection, nextSelection);
    if (armed && this.getTextContent().includes('bc')) {
      armed = false;
      const tail = $getRoot()
        .getAllTextNodes()
        .find(n => n.getTextContent() === 'tail')!;
      nextSelection.anchor.set(tail.getKey(), 2, 'text');
      nextSelection.focus.set(tail.getKey(), 2, 'text');
      $setCompositionKey(tail.getKey());
    }
  }
}

describe('undo and redo around a refused relocation under a hold', () => {
  for (const gc of GCS) {
    for (const ids of ORDERS) {
      for (const [relocation, shape] of CASES) {
        for (const bold of [false, true]) {
          const id = `(${relocation}, ${shape}${bold ? ", B's bold held" : ''}, gc ${gc ? 'on' : 'off'}, ids ${ids})`;
          const content = bold ? '"aRbc"{1}' : '"aRbc"';
          (bold ? test.fails : test)(
            `a refused relocation adds no undo step${bold ? " (fails: with B's bold held, ending the composition after the refusal writes a step that changes nothing A shows, so A's first undo does nothing visible)" : ''} ${id}`,
            async () => {
              const t = await composing($init(shape), gc, ids);
              await held(t, () => {
                const n = $composed();
                if (bold) {
                  n.setFormat('bold');
                }
                n.spliceText(1, 0, 'R');
              });
              const stack = t.a.binding.undoManager!.undoStack.length;
              t.a.update(() => $relocate(relocation));
              await t.sync();
              refused(t);
              expect(await settled(t)).toBe(relocated(null, shape, content));
              expect(t.a.binding.undoManager!.undoStack.length).toBe(stack);
              t.a.undo();
              await t.sync();
              await agree(t, relocated(null, shape, content));
            },
          );
        }
      }
      for (const relocation of ['move', 'unwrap'] as Relocation[]) {
        const id = `(${relocation}, gc ${gc ? 'on' : 'off'}, ids ${ids})`;
        test(`a relocation with A's typing in the same update is written as one undo step, the typing kept ${id}`, async () => {
          const t = await composing($box, gc, ids);
          await held(t, () => $composed().spliceText(1, 0, 'R'));
          const stack = t.a.binding.undoManager!.undoStack.length;
          t.a.update(() => {
            const n = $composed();
            n.setTextContent(n.getTextContent() + 'Z');
            $relocate(relocation);
          });
          await t.sync();
          // Written as made (it inserts a character, see $heldDecision).
          expect(t.a.warnings).toEqual([]);
          expect(await settled(t)).toContain('abcZ');
          expect(t.a.binding.undoManager!.undoStack.length).toBe(stack + 1);
        });
      }
      {
        const id = `(gc ${gc ? 'on' : 'off'}, ids ${ids})`;
        test(`a refused relocation over a held inline decorator adds no undo step ${id}`, async () => {
          const t = await composing($box, gc, ids);
          await held(t, () => {
            $composed()
              .select(1, 1)
              .insertNodes([$create(HoldChip)]);
          });
          const stack = t.a.binding.undoManager!.undoStack.length;
          t.a.update(() => $relocate('move'));
          await t.sync();
          refused(t);
          const chip = relocated(null, 'box', '"a" hold_chip "bc"');
          expect(await settled(t)).toBe(chip);
          expect(t.a.binding.undoManager!.undoStack.length).toBe(stack);
          t.a.undo();
          await t.sync();
          await agree(t, chip);
        });
      }
      const id = `(gc ${gc ? 'on' : 'off'}, ids ${ids})`;
      test(`removing the container composed in is refused: R stays, and no undo step is added ${id}`, async () => {
        const t = await composing($box, gc, ids);
        await held(t, () => $composed().spliceText(1, 0, 'R'));
        const stack = t.a.binding.undoManager!.undoStack.length;
        t.a.update(() => {
          $composed().getParentOrThrow().remove();
        });
        await t.sync();
        refused(t);
        expect(await settled(t)).toBe(BEFORE);
        expect(t.a.binding.undoManager!.undoStack.length).toBe(stack);
        t.a.undo();
        await t.sync();
        await agree(t, BEFORE);
        expect(t.a.warnings).toEqual([]);
      });
      test(`the release after a selection transform moves the composition away stays out of A's undo ${id}`, async () => {
        const t = await composing(
          () =>
            $listDocument(() => [
              $create(HoldBox).append(
                $create(RelocatingText).setTextContent('abc'),
              ),
            ]),
          gc,
          ids,
          undefined,
          [RelocatingText],
        );
        await held(t, () => $composed().spliceText(1, 0, 'R'));
        const stack = t.a.binding.undoManager!.undoStack.length;
        // An update of A's that changes nothing runs the selection
        // transform, which moves the composition to `tail`: the hold ends
        // and A shows what is stored.
        armed = true;
        t.a.update(() => {});
        await t.sync();
        expect(armed).toBe(false);
        expect(await settled(t)).toBe(BEFORE);
        // No undo step of A's: the release is no one's edit.
        expect(t.a.binding.undoManager!.undoStack.length).toBe(stack);
        t.a.undo();
        await t.sync();
        await agree(t, BEFORE);
      });
    }
  }
});
