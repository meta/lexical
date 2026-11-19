/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Splitting (Enter) or joining (Backspace at a paragraph's start) the
// paragraphs of a quote that holds blocks, while a collaborator types in the
// text the edit moves.
//
// A QuoteContainerNode declares `children: 'block'`, so it is stored as a
// container of lines (storage kind `nested`), as a table cell is: its
// paragraphs are lines (text, then a marker), a split is one marker inserted
// and a join one marker deleted, and the collaborator's typing stays in its
// text. The root and a table cell are the controls.
//
// The same cells fail for a QuoteNode with the opt-in `shadowRoot` state
// (found by #9905): its class declares `children: 'inline'`, so the quote is
// stored as one line and each of its paragraphs as a node of its own. A
// split then copies the paragraph's tail into a new node and a join moves
// the second paragraph's text into the first, and the typing stays in the
// node it was made in: it shows in the paragraph before the caret after a
// split, and is deleted with its node after a join.

import {$getBlockById, $getBlockId} from '@lexical/extension';
import {
  $createQuoteContainerNode,
  QuoteContainerNode,
  QuoteNode,
} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {$getRoot, $isTextNode, type ElementNode} from 'lexical';
import {describe, expect, test} from 'vitest';

import {describeStorage} from '../../../';
import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  NODES as HARNESS_NODES,
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

const NODES = [...HARNESS_NODES, QuoteContainerNode];

const WHERE: readonly Where[] = [
  {
    $init: () =>
      $getRoot().append(
        $p('title'),
        $createQuoteContainerNode().append($p('Lorem ipsum'), $p('dolor')),
        $p('end'),
      ),
    expected: inner =>
      `paragraph("title") / quote-container(${inner}) / paragraph("end")`,
    first: [1, 0],
    name: 'a quote container',
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
        const t = await setup(where.$init, {ids, nodes: NODES});
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
        const t = await setup(where.$init, {ids, nodes: NODES});
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
// paragraph before the word at the same time. The replacement follows the
// word into the paragraph the split made, in the container as in the root.
describe('an edit addressed by block id ‖ a split of its paragraph', () => {
  for (const where of WHERE.slice(0, 2)) {
    test(`${where.name}: replace 'ipsum' in the block of 'Lorem ipsum' ‖ Enter at 5`, async () => {
      const t = await setup(where.$init, {nodes: NODES, withBlockIds: true});
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

describe('how a quote container is stored', () => {
  test('as a container (nested), where a quote is a line', async () => {
    const t = await setup(() => $getRoot().append($p('x')), {nodes: NODES});
    const storage = describeStorage(t.a.editor);
    expect(storage[QuoteContainerNode.getType()]).toBe('nested');
    expect(storage[QuoteNode.getType()]).toBe('line');
    // The same kind as the other shadow roots that hold blocks.
    expect(storage.tablecell).toBe('nested');
  });
});
