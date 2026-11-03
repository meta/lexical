/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// GPT layout 3 review round 12's cells (P8 dormant runs; the text format
// rule of main's #9768).

// Text with a segment key of its own (a node kept apart, here a segmented
// text node) appended after a tab at a line's end, as a join of the next line
// writes it: the cursor can land inside the tab's run (before its ends), and a
// reader reads text under a tab's type as plain text without any segment key
// (see Reader's tabRuns). The text closes the tab's type for itself, so it
// reads with its own key (soak L1B 2656880129: `self-check: format k at N`
// after one join).

import {$createHeadingNode} from '@lexical/rich-text';
import {
  $create,
  $createTabNode,
  $createTextNode,
  $getRoot,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  $p,
  ColContainerNode,
  ColContentNode,
  ColTitleNode,
  expectConverged,
  freshReader,
  setup,
} from '../../utils/harness';

for (const gc of [false, true]) {
  for (const mode of ['segmented', 'token', 'normal'] as const) {
    test(`a ${mode} node joined after a line-ending tab reads with its own segment (gc ${gc})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createHeadingNode('h1').append(
              $createTextNode('t49z'),
              $createTabNode(),
              $createTextNode(' t50z'),
              $createTabNode(),
            ),
            $create(ColContainerNode).append(
              $create(ColTitleNode).append(
                $createTextNode('t51z').setMode(mode),
              ),
              $create(ColContentNode).append($p('t52z t53z')),
            ),
          ),
        {gc},
      );
      // Join the collapsible's title into line 0 (a backspace at its start):
      // its text is written again into the heading's line.
      t.a.update(() => {
        const title = (
          $getRoot().getChildAtIndex(1) as ElementNode
        ).getFirstChild() as ElementNode;
        (title.getFirstChild() as TextNode).select(0, 0).deleteCharacter(true);
      });
      await t.sync();
      expect(t.a.warnings.filter(w => /self-check/.test(w))).toEqual([]);
      const fresh = await freshReader(t.a);
      expect(fresh.describe()).toBe(t.a.describe());
      await expectConverged(t.peers);
      const final = t.a.describe();
      const modeOf = () =>
        t.a.read(() =>
          $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent().includes('t51z'))!
            .getMode(),
        );
      expect(modeOf()).toBe(mode);
      t.a.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
      expect(modeOf()).toBe(mode);
      t.a.binding.redo();
      await t.sync();
      await expectConverged(t.peers);
      expect((await freshReader(t.a)).describe()).toBe(t.a.describe());
      expect(modeOf()).toBe(mode);
      expect(t.a.describe()).toBe(final);
    });
  }
}
