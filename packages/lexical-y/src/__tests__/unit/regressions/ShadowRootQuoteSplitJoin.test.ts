/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Splitting (Enter) or joining (Backspace at a paragraph's start) the
// paragraphs of a quote that is a shadow root, while a collaborator types in
// the text the edit moves. Such a quote is a line class at a block position,
// so it is stored as one line, and each of its paragraphs as a node of its
// own holding only inline content: a split deletes the paragraph's tail from
// one node and inserts a copy into a new node, and a join moves the second
// paragraph's text into the first node. The collaborator's typing, made in
// the original text, stays where the original was: after a split it shows in
// the paragraph before the caret, and after a join it is deleted with the
// node it was typed into. In the root, or in a table cell (a shadow root
// stored as a container of lines), the same edits are one marker inserted or
// deleted, and the typing stays in its text.
//
// The quote cases are open (found by #9905): the follow-up layout 5 pull
// request stores a shadow-root instance of a line class as a container of
// lines, as table cells are stored.

import {$getBlockById, $getBlockId} from '@lexical/extension';
import {$createQuoteNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {$getRoot, $isTextNode, type ElementNode} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  setup,
} from '../../utils/harness';

type Where = {
  name: string;
  /** The document: two paragraphs, 'Lorem ipsum' and 'dolor', somewhere. */
  $init: () => void;
  /** The path of the first paragraph; the second follows it. */
  first: number[];
  /** describe() of the root with `inner` as the paragraphs. */
  expected: (inner: string) => string;
  open: boolean;
};

const WHERE: readonly Where[] = [
  {
    $init: () =>
      $getRoot().append(
        $p('title'),
        $createQuoteNode({shadowRoot: true}).append(
          $p('Lorem ipsum'),
          $p('dolor'),
        ),
        $p('end'),
      ),
    expected: inner =>
      `paragraph("title") / quote(${inner}) / paragraph("end")`,
    first: [1, 0],
    name: 'a shadow-root quote',
    open: true,
  },
  {
    $init: () =>
      $getRoot().append($p('title'), $p('Lorem ipsum'), $p('dolor'), $p('end')),
    expected: inner =>
      `paragraph("title") / ${inner.replace(/\) p/g, ') / p')} / paragraph("end")`,
    first: [1],
    name: 'the root',
    open: false,
  },
  {
    $init: () =>
      $getRoot().append(
        $p('title'),
        $createTableNode().append(
          $createTableRowNode().append(
            $createTableCellNode().append($p('Lorem ipsum'), $p('dolor')),
          ),
        ),
        $p('end'),
      ),
    expected: inner =>
      `paragraph("title") / table(tablerow(tablecell(${inner}))) / paragraph("end")`,
    first: [1, 0, 0, 0],
    name: 'a table cell',
    open: false,
  },
];

const second = (first: number[]) => [
  ...first.slice(0, -1),
  first[first.length - 1] + 1,
];

describe('a split or join of paragraphs ‖ typing in the text it moves', () => {
  for (const where of WHERE) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      (where.open ? test.fails : test)(
        `${where.name}, ids ${ids}: Enter in 'Lorem ipsum' at 5 ‖ 'XY' typed at 8`,
        async () => {
          const t = await setup(where.$init, {ids});
          t.offline();
          t.a.update(() => {
            $selectIn(where.first, 5).insertParagraph();
          });
          t.b.update(() => {
            $selectIn(where.first, 8).insertText('XY');
          });
          await t.sync();
          await expectConverged(
            t.peers,
            where.expected(
              'paragraph("Lorem") paragraph(" ipXYsum") paragraph("dolor")',
            ),
          );
        },
      );
      (where.open ? test.fails : test)(
        `${where.name}, ids ${ids}: Backspace at the start of 'dolor' ‖ 'XY' typed in it at 2`,
        async () => {
          const t = await setup(where.$init, {ids});
          t.offline();
          t.a.update(() => {
            $selectIn(second(where.first), 0).deleteCharacter(true);
          });
          t.b.update(() => {
            $selectIn(second(where.first), 2).insertText('XY');
          });
          await t.sync();
          await expectConverged(
            t.peers,
            where.expected('paragraph("Lorem ipsumdoXYlor")'),
          );
        },
      );
    }
  }
});

// An edit addressed by block id, as a writing assistant makes it: replace
// the word 'ipsum' of the block whose id it read. A collaborator splits the
// paragraph before the word at the same time. In the root the replacement
// follows the word into the paragraph the split made; in the quote the word
// was moved before the edit arrived, so the edit deletes nothing that shows
// and inserts its word into the paragraph before the caret: the old word
// stays and the new one is added next to it.
describe('an edit addressed by block id ‖ a split of its paragraph', () => {
  for (const where of WHERE.slice(0, 2)) {
    (where.open ? test.fails : test)(
      `${where.name}: replace 'ipsum' in the block of 'Lorem ipsum' ‖ Enter at 5`,
      async () => {
        const t = await setup(where.$init, {withBlockIds: true});
        const id = t.b.read(() => $getBlockId($block(where.first)))!;
        expect(id).toEqual(expect.any(String));
        t.offline();
        t.a.update(() => {
          $selectIn(where.first, 5).insertParagraph();
        });
        t.b.update(() => {
          const block = $getBlockById(id) as ElementNode;
          const text = block.getFirstChild();
          if (!$isTextNode(text)) {
            throw new Error('no text');
          }
          text.spliceText(6, 5, 'IPSUM', true);
        });
        await t.sync();
        await expectConverged(
          t.peers,
          where.expected(
            'paragraph("Lorem") paragraph(" IPSUM") paragraph("dolor")',
          ),
        );
      },
    );
  }
});
