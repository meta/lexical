/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// An undo whose read made the binding write again (a follow-up, here while
// A composes in a merging TextNode subclass and holds a collaborator's
// change to it) pushed that write as a step of its own onto the redo stack,
// above the undone change: Yjs never merges a write into the last step while
// it undoes. One redo then redid only the follow-up, and the change A undid
// (a character A typed) was not restored: after the composition it was gone
// on every peer and in a fresh reader:
// https://github.com/meta/lexical/issues/9816.

import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setCompositionKey,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$composed, composing, held, HoldBox} from '../../utils/composeHold';
import {expectConverged, freshReader} from '../../utils/harness';

/** A TextNode subclass that merges like plain text (isSimpleText). */
class MergingText extends TextNode {
  $config() {
    return this.config('follow_up_merging_text', {extends: TextNode});
  }
  isSimpleText(): boolean {
    return true;
  }
}

type Stacks = {undoStack: unknown[]; redoStack: unknown[]};

describe.each([false, true])('an undo that writes a follow-up, gc %s', gc => {
  // [text class, B's held change, fails on main]
  for (const [cls, change, fails] of [
    ['a merging subclass', 'unbold and type', true],
    ['a merging subclass', 'type', false],
    ['TextNode', 'unbold and type', false],
  ] as const) {
    (fails ? test.fails : test)(
      `${cls}, B's held change: ${change}: one redo restores the change`,
      async () => {
        const $text = (s: string): TextNode =>
          cls === 'TextNode'
            ? $createTextNode(s)
            : $create(MergingText).setTextContent(s);
        const t = await composing(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('left'),
                $create(HoldBox).append($text('abc').setFormat(1)),
                $createTextNode('right'),
              ),
            ),
          gc,
          [1, 2, 3],
          undefined,
          [MergingText],
        );
        const {a} = t;
        await held(t, () => {
          const n = $composed();
          if (change === 'unbold and type') {
            n.setFormat(0);
          }
          n.spliceText(3, 0, 'R');
        });
        // A splits the composed text and types a new bold node between.
        a.update(() => {
          const [left] = $composed().splitText(2);
          const typed = $text('X').setFormat(1).toggleUnmergeable();
          left.getLatest().insertAfter(typed);
          typed.select(1, 1);
        });
        await t.sync();
        const um = a.binding.undoManager as unknown as Stacks;
        const steps = um.undoStack.length;
        a.binding.undo();
        await t.sync();
        // The undo is one step to redo.
        expect([um.undoStack.length, um.redoStack.length]).toEqual([
          steps - 1,
          1,
        ]);
        a.binding.redo();
        await t.sync();
        a.update(() => $setCompositionKey(null));
        await t.sync();
        const fresh = await freshReader(a);
        expect(fresh.read(() => $getRoot().getTextContent())).toBe(
          'leftabXcRright',
        );
        expect(fresh.describe()).toBe(a.describe());
        fresh.stop();
        await expectConverged(t.peers);
      },
    );
  }
});
