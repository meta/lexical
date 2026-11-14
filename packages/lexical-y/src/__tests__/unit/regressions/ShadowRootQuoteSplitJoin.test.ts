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
// the text the edit moves. Layout 4 stored such a quote (a line class at a
// block position) as one line, and each of its paragraphs as a node of its
// own holding only inline content: a split deleted the paragraph's tail
// from one node and inserted a copy into a new node, and a join moved the
// second paragraph's text into the first node. The collaborator's typing,
// made in the original text, stayed where the original was: after a split
// it showed in the paragraph before the caret, and after a join it was
// deleted with the node it was typed into. Layout 5 stores the quote as a
// container of lines, as a table cell (the control here, with the root):
// the same edits are one marker inserted or deleted, and the typing stays in
// its text.

import {$getBlockById, $getBlockId} from '@lexical/extension';
import {$createQuoteNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {
  $createTextNode,
  $getRoot,
  $isTextNode,
  type ElementNode,
} from 'lexical';
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
  },
  {
    $init: () =>
      $getRoot().append($p('title'), $p('Lorem ipsum'), $p('dolor'), $p('end')),
    expected: inner =>
      `paragraph("title") / ${inner.replace(/\) p/g, ') / p')} / paragraph("end")`,
    first: [1],
    name: 'the root',
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
      test(`${where.name}, ids ${ids}: Enter in 'Lorem ipsum' at 5 ‖ 'XY' typed at 8`, async () => {
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
      });
      test(`${where.name}, ids ${ids}: Backspace at the start of 'dolor' ‖ 'XY' typed in it at 2`, async () => {
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
      });
    }
  }
});

// An edit addressed by block id, as a writing assistant makes it: replace
// the word 'ipsum' of the block whose id it read. A collaborator splits the
// paragraph before the word at the same time. In the root the replacement
// follows the word into the paragraph the split made, in the quote too. A
// quote stored as a line whose paragraphs were nodes of their own moved the
// word before the edit arrived, so the edit deleted nothing that showed and
// inserted its word into the paragraph before the caret: the old word
// stays and the new one is added next to it (layout 4).
describe('an edit addressed by block id ‖ a split of its paragraph', () => {
  for (const where of WHERE.slice(0, 2)) {
    test(`${where.name}: replace 'ipsum' in the block of 'Lorem ipsum' ‖ Enter at 5`, async () => {
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
    });
  }
});

// Enter on both peers in one paragraph: A at 'Br|avo two', B at 'B|ravo two',
// then B types at the start of the paragraph its Enter made. One editor
// making the edits one after another (and a paragraph in the root or a
// cell) gives 'B' / 'XYZr' / 'avo two'. Layout 4 copied each tail into a
// new node, so the tail showed twice ('B' / 'avo two' / 'XYZravo two').
describe('Enter ‖ Enter in one paragraph, then typing after the second', () => {
  for (const where of WHERE) {
    test(`${where.name}: Enter at 'Br|avo two' ‖ Enter at 'B|ravo two', then 'XYZ'`, async () => {
      const t = await setup(() => {
        where.$init();
        $block(where.first).clear().append($createTextNode('Bravo two'));
        $block(second(where.first)).remove();
      });
      t.offline();
      t.a.update(() => {
        $selectIn(where.first, 2).insertParagraph();
      });
      t.b.update(() => {
        $selectIn(where.first, 1).insertParagraph();
        $selectIn(second(where.first), 0).insertText('XYZ');
      });
      await t.sync();
      await expectConverged(
        t.peers,
        where.expected('paragraph("B") paragraph("XYZr") paragraph("avo two")'),
      );
    });
  }
});

// Backspace at the start of a quote's paragraph (it leaves the quote: the
// paragraph moves out, and the quote goes once it is empty) while a peer
// types in the paragraph. The paragraph moves from the quote to the root, a
// move (see y.md, Limits: Moves): what the peer typed stays where the
// paragraph was, in the quote, which A removed, so it is lost. Layout 4 lost
// it too, and so does a move of a paragraph out of a box or a cell; open
// until moves keep what collaborators type in the moved block.
describe("a quote's paragraph moved out of it ‖ typing in the paragraph", () => {
  test.fails('the typed text is kept (a move out of a container)', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $p('title'),
        $createQuoteNode({shadowRoot: true}).append($p('Lorem ipsum')),
        $p('end'),
      ),
    );
    t.offline();
    t.a.update(() => {
      const quote = $block([1]);
      quote.insertBefore(quote.getFirstChildOrThrow());
      quote.remove();
    });
    t.b.update(() => {
      $selectIn([1, 0], 5).insertText('XY');
    });
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("title") / paragraph("LoremXY ipsum") / paragraph("end")',
    );
  });
});
