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
import {expectConverged, freshReader, setup} from '../../utils/harness';

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
  for (const how of ['called', 'called in an update'] as const) {
    // [text class, B's held change]
    for (const [cls, change] of [
      ['a merging subclass', 'unbold and type'],
      ['a merging subclass', 'type'],
      ['TextNode', 'unbold and type'],
    ] as const) {
      test(`${cls}, B's held change: ${change}, undo and redo ${how}: one redo restores the change`, async () => {
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
        // Called in an update (as from a command handler), the step is read
        // in an update of its own that commits after it returns.
        const step = (undo: boolean) =>
          how === 'called'
            ? undo
              ? a.binding.undo()
              : a.binding.redo()
            : a.update(() => {
                if (undo) {
                  a.binding.undo();
                } else {
                  a.binding.redo();
                }
              });
        step(true);
        await t.sync();
        // The undo is one step to redo.
        expect([um.undoStack.length, um.redoStack.length]).toEqual([
          steps - 1,
          1,
        ]);
        step(false);
        await t.sync();
        // And the redo is one step to undo.
        expect([um.undoStack.length, um.redoStack.length]).toEqual([steps, 0]);
        a.update(() => $setCompositionKey(null));
        await t.sync();
        const fresh = await freshReader(a);
        expect(fresh.read(() => $getRoot().getTextContent())).toBe(
          'leftabXcRright',
        );
        expect(fresh.describe()).toBe(a.describe());
        fresh.stop();
        await expectConverged(t.peers);
      });
    }
  }
});

// An undo with nothing to normalize leaves no step open: the next update,
// tagged as the binding's normalization or not, is a step of its own.
describe.each([false, true])('after an undo with no follow-up, gc %s', gc => {
  for (const tag of [undefined, 'lexical-y-normalize'] as const) {
    test(`the next update (tag ${String(tag)}) is a step of its own`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('abc')),
          ),
        {gc, ids: [1, 2]},
      );
      const {a} = t;
      a.update(() => {
        $getRoot().getAllTextNodes()[0].spliceText(3, 0, 'X');
      });
      await t.sync();
      const um = a.binding.undoManager as unknown as Stacks;
      a.update(() => {
        a.binding.undo();
      });
      await t.sync();
      expect([um.undoStack.length, um.redoStack.length]).toEqual([0, 1]);
      a.update(() => {
        $getRoot().getAllTextNodes()[0].spliceText(0, 0, 'N');
      }, tag);
      await t.sync();
      expect([um.undoStack.length, um.redoStack.length]).toEqual([1, 0]);
    });
  }
});
