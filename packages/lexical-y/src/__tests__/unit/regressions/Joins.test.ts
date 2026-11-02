/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Regression cases for joins. A line is stored as its text followed by its
// marker, which holds its type, so a join deletes the earlier line's marker
// and writes the earlier line's type onto the later line's marker, which now
// ends the joined line. Each case is named after its finding.

import {$createCodeNode} from '@lexical/code';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$p, expectConverged, type Setup, setup} from '../../utils/harness';

/** Delete from the end of block `from` to the start of block `to`. */
function $joinBlocks(from: number, to: number) {
  const blocks = $getRoot().getChildren() as ElementNode[];
  const end = blocks[from].getLastChild() as TextNode;
  const start = blocks[to].getFirstChild() as TextNode;
  const selection = $createRangeSelection();
  selection.anchor.set(end.getKey(), end.getTextContentSize(), 'text');
  selection.focus.set(start.getKey(), 0, 'text');
  $setSelection(selection);
  selection.removeText();
}

// S7-22: two joins at once into the same line. A deletes from the end of a
// heading (or code block) to the start of the paragraph after the quote that
// follows it; B joins that paragraph into the quote (Backspace at its
// start). Both write the type of the line that ends at the paragraph's
// marker, A the heading's and B the quote's, and Yjs keeps one of the two
// writes by client id: when it keeps B's, the heading becomes a quote on
// every client although neither edit retyped it. Open: the type is one
// value on that shared marker, so the two writes cannot both be kept;
// agreeing on the earlier line's type would need each join to record which
// line it came from and a follow-up to elect one (#9511; y.md, Limits,
// Other races).
describe('S7-22: two joins at once into the same line', () => {
  const FIRST: [string, string, () => ElementNode][] = [
    [
      'heading',
      'heading',
      () => $createHeadingNode('h1').append($createTextNode('Title t44z')),
    ],
    [
      'code block',
      'code',
      () => $createCodeNode().append($createTextNode('const t44z = 1;')),
    ],
  ];
  for (const [kind, type, $first] of FIRST) {
    const run = async (ids: number[]): Promise<Setup> => {
      const t = await setup(
        () =>
          $getRoot().append(
            $first(),
            $createQuoteNode().append($createTextNode('t48z')),
            $p('t49z t50z'),
          ),
        {ids},
      );
      t.offline();
      t.a.update(() => $joinBlocks(0, 2));
      t.b.update(() => $joinBlocks(1, 2));
      await t.sync();
      return t;
    };
    const firstType = (t: Setup) =>
      t.a.read(() => $getRoot().getFirstChildOrThrow().getType());

    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      test(`S7-22 ${kind}: converges, with the text of both joins (ids ${ids})`, async () => {
        const t = await run(ids);
        await expectConverged(t.peers);
        expect(t.a.read(() => $getRoot().getTextContent())).not.toContain(
          't48z',
        );
        expect(t.a.read(() => $getRoot().getChildrenSize())).toBe(1);
      });
    }

    test(`S7-22 ${kind}: the joined line keeps the ${kind}'s type when the client that joined the ${kind} has the higher id`, async () => {
      const t = await run([2, 1]);
      expect(firstType(t)).toBe(type);
    });

    test.fails(
      `S7-22 ${kind}: the joined line keeps the ${kind}'s type when the client that joined the quote has the higher id`,
      async () => {
        const t = await run([1, 2]);
        expect(firstType(t)).toBe(type);
      },
    );
  }
});
