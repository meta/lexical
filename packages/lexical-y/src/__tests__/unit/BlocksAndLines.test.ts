/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Block nodes next to lines, undo of container insertions, nested list shapes.
// @vitest-environment node

import type {ListItemNode} from '@lexical/list';

import {$createListItemNode, $createListNode, $insertList} from '@lexical/list';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type ElementNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $createBoxNode,
  $p,
  $selectIn,
  ColContainerNode,
  ColContentNode,
  ColTitleNode,
  type Delivery,
  expectConverged,
  freshReader,
  type Peer,
  setup,
  WidgetNode,
} from '../utils/harness';

const ORDERS: {ids: number[]; delivery: Delivery}[] = [
  {delivery: 'causal', ids: [1, 2]},
  {delivery: 'causal', ids: [2, 1]},
  {delivery: 'sender', ids: [1, 2]},
  {delivery: 'sender', ids: [2, 1]},
];

const $line = (i: number) => $getRoot().getChildAtIndex(i) as ElementNode;
const $typeAtStart = (i: number, text: string) => {
  const first = $line(i).getFirstDescendant()!;
  const sel = (first as ReturnType<typeof $createTextNode>).select(0, 0);
  sel.insertText(text);
};

async function report(peers: Peer[]) {
  const fresh = await freshReader(peers[0]);
  return {
    describe: [...peers, fresh].map(p => p.describe()),
    errors: peers.flatMap(p => p.errors.map(String)),
    warnings: peers.flatMap(p => p.warnings),
  };
}

function expectSame(r: Awaited<ReturnType<typeof report>>) {
  expect(r.errors).toEqual([]);
  expect(r.warnings.filter(w => w.includes('self-check'))).toEqual([]);
  // every peer and the fresh reader identical
  expect(new Set(r.describe).size, r.describe.join('\n')).toBe(1);
}

describe.each(ORDERS)('$ids $delivery', order => {
  // N1: a peer types at the start of a line while another inserts a block
  // node (box) right before that line.
  test('insert box before line ‖ type at its start', async () => {
    const t = await setup(() => $getRoot().append($p('AAA'), $p('BBB')), order);
    t.offline();
    t.a.update(() => $typeAtStart(1, 'X'));
    t.b.update(() =>
      $line(1).insertBefore($createBoxNode('b').append($p('IN'))),
    );
    await t.sync();
    const r = await report(t.peers);
    expectSame(r);
    expect(r.describe[0]).toContain('X');
  });

  // N1w: same with a block decorator.
  test('insert block decorator before line ‖ type at its start', async () => {
    const t = await setup(() => $getRoot().append($p('AAA'), $p('BBB')), order);
    t.offline();
    t.a.update(() => $typeAtStart(1, 'X'));
    t.b.update(() => $line(1).insertBefore($create(WidgetNode)));
    await t.sync();
    const r = await report(t.peers);
    expectSame(r);
    expect(r.describe[0]).toContain('X');
  });

  // N2: a peer moves a line into a box (delete + reinsert) while another
  // types at its start; the following unit is a node.
  test('wrap line into box ‖ type at its start', async () => {
    const t = await setup(
      () => $getRoot().append($p('AAA'), $p('BBB'), $p('CCC')),
      order,
    );
    t.offline();
    t.a.update(() => $typeAtStart(1, 'X'));
    t.b.update(() => {
      const line = $line(1);
      const box = $createBoxNode('w');
      line.insertBefore(box);
      box.append(line);
    });
    await t.sync();
    const r = await report(t.peers);
    expectSame(r);
    expect(r.describe[0]).toContain('X');
  });

  // N3: a peer removes a line that is followed by a box while another types
  // in it (documented: the text joins the next line; here the next unit is
  // a node).
  test('remove line before a box ‖ type in it', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $p('AAA'),
          $p('BBB'),
          $createBoxNode('b').append($p('IN')),
          $p('CCC'),
        ),
      order,
    );
    t.offline();
    t.a.update(() => $typeAtStart(1, 'X'));
    t.b.update(() => $line(1).remove());
    await t.sync();
    const r = await report(t.peers);
    expectSame(r);
  });

  // N4: undo of inserting a box a peer typed in keeps the box (by design),
  // but the box's own fields (tone) are undone.
  test('undo insert box after peer typed inside: box keeps its fields', async () => {
    const t = await setup(() => $getRoot().append($p('before')), order);
    t.a.update(() =>
      $getRoot().append($createBoxNode('tone1').append($p('box'))),
    );
    await t.sync();
    t.b.update(() => $typeAtStart(1, '!'));
    await t.sync();
    t.a.undo();
    await t.sync();
    const r = await report(t.peers);
    expectSame(r);
    expect(r.describe[0]).toContain('!');
    expect(r.describe[0]).toBe(
      'paragraph("before") / test_box[tone1](paragraph("!box"))',
    );
  });

  // N5: undo of inserting a container > title + content after a peer typed
  // in the content: the content is kept, the title is removed.
  test('undo insert col(title, content) after peer typed in content', async () => {
    const t = await setup(() => $getRoot().append($p('before')), order);
    t.a.update(() =>
      $getRoot().append(
        $create(ColContainerNode).append(
          $create(ColTitleNode).append($createTextNode('TITLE')),
          $create(ColContentNode).append($p('body')),
        ),
      ),
    );
    await t.sync();
    t.b.update(() => {
      const t2 = ($line(1).getLastChild() as ElementNode).getFirstDescendant()!;
      (t2 as ReturnType<typeof $createTextNode>).select(0, 0).insertText('!');
    });
    await t.sync();
    t.a.undo();
    await t.sync();
    const r = await report(t.peers);
    expectSame(r);
    expect(r.describe[0]).toContain('!');
    expect(r.describe[0]).toContain('test_col_title');
  });

  // N6: a list whose first item is an indent-only wrapper (nested list of
  // another type). No concurrency.
  test('bullet list starting with a nested number list: initial write', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $createListItemNode().append(
              $createListNode('number').append(
                $createListItemNode().append($createTextNode('nu')),
              ),
            ),
            $createListItemNode().append($createTextNode('juliet')),
          ),
        ),
      order,
    );
    await t.sync();
    const r = await report(t.peers);
    expectSame(r);
  });

  test('number list starting with nested number item: last item -> bullet', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('number').append(
            $createListItemNode().append(
              $createListNode('number').append(
                $createListItemNode().append($createTextNode('nu')),
              ),
            ),
            $createListItemNode().append($createTextNode('juliet')),
          ),
        ),
      order,
    );
    t.a.update(() => {
      const li = $line(0).getLastChild() as ListItemNode;
      li.select(0, 0);
      $insertList('bullet');
    });
    await t.sync();
    const r = await report(t.peers);
    expectSame(r);
  });

  // N7: smallest form: a number list whose only item is an indent wrapper
  // around a bullet list. No concurrency.
  test('number list > wrapper > bullet list: initial write', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('number').append(
            $createListItemNode().append(
              $createListNode('bullet').append(
                $createListItemNode().append($createTextNode('x')),
              ),
            ),
          ),
        ),
      order,
    );
    await t.sync();
    const r = await report(t.peers);
    expectSame(r);
  });
});

describe('@lexical/y a block in a box that $insertList replaces', () => {
  // $insertList on a block in a box that is not a shadow root replaces the
  // box with a list: a paragraph becomes the list item's text, and a heading
  // is lifted out of the list, which is left empty and removed.
  // No list item here holds a block: NodeStructureExtension, which every
  // @lexical/y editor runs, keeps blocks out of list items (only a writer
  // without it stores one).
  const $listFromBox = (child: ElementNode) => {
    $getRoot().append($createBoxNode('o').append(child), $p('end'));
    child.selectStart();
    $insertList('bullet');
  };
  const $target = () => {
    const box = $block([0]);
    return box.getFirstDescendant()!.getParent() as ElementNode;
  };
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`retype the list item made from the paragraph ‖ type in it keeps the text (${ids})`, async () => {
      const t = await setup(
        () =>
          $listFromBox($createParagraphNode().append($createTextNode('abc'))),
        {ids},
      );
      t.offline();
      t.a.update(() => $target().replace($createHeadingNode('h1'), true));
      t.b.update(() => $target().selectStart().insertText('X'));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toContain('Xabc');
      expect(t.a.describe()).toContain('heading[h1]');
    });

    // The empty paragraph after the paragraph becomes a line break of the
    // list item: the replacement keeps the replaced item's content.
    test(`retype the list item made from a paragraph and an empty paragraph ‖ type in it keeps the text (${ids})`, async () => {
      const t = await setup(
        () => {
          const first = $createParagraphNode().append($createTextNode('abc'));
          $listFromBox(first);
          first.insertAfter($createParagraphNode());
        },
        {ids},
      );
      t.offline();
      t.a.update(() => $target().replace($createQuoteNode(), true));
      t.b.update(() => $target().selectStart().insertText('X'));
      await t.sync();
      await expectConverged(t.peers);
      // The quote takes the list item's place and its line break.
      expect(t.a.describe()).toContain('quote("Xabc" br)');
    });

    test(`Enter at the start of the heading on both peers duplicates nothing (${ids})`, async () => {
      const t = await setup(
        () =>
          $listFromBox($createHeadingNode('h2').append($createTextNode('abc'))),
        {ids},
      );
      t.offline();
      for (const peer of [t.a, t.b]) {
        peer.update(() => {
          $target().selectStart();
          const s = $getSelection();
          if ($isRangeSelection(s)) {
            s.insertParagraph();
          }
        });
      }
      await t.sync();
      await expectConverged(t.peers);
      expect(
        t.a.read(() => $getRoot().getTextContent()).match(/abc/g),
      ).toHaveLength(1);
    });
  }
});

describe('@lexical/y moves', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    const $col = () =>
      $create(ColContainerNode).append(
        $create(ColTitleNode).append($createTextNode('t')),
        $create(ColContentNode).append($p('c1'), $p('c2')),
      );
    test(`a collapsible dragged past a box ‖ typing in the box keeps the typing (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $col(),
            $createBoxNode('o').append($p('box')),
            $p('end'),
          ),
        {ids},
      );
      t.offline();
      t.a.update(() => $block([1]).insertAfter($block([0])));
      t.b.update(() => $selectIn([1, 0], 3).insertText('TYPED'));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toContain('boxTYPED');
    });

    // Moves limit (y.md): the dragged block is the one deleted and written
    // again, so typing inside it at the same time is lost.
    test.fails(
      `a collapsible dragged past a box ‖ typing inside it keeps the typing (ids ${ids})`,
      async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $col(),
              $createBoxNode('o').append($p('box')),
              $p('end'),
            ),
          {ids},
        );
        t.offline();
        t.a.update(() => $block([1]).insertAfter($block([0])));
        t.b.update(() => $selectIn([0, 1, 0], 2).insertText('TYPED'));
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.describe()).toContain('c1TYPED');
      },
    );

    test(`moving a paragraph down one slot ‖ typing in the paragraph it passed stays there (ids ${ids})`, async () => {
      const t = await setup(
        () => $getRoot().append($p('Revenue grew 4% in Q3.'), $p('Second.')),
        {ids},
      );
      t.offline();
      t.a.update(() => $selectIn([1], 6).insertText(' line'));
      t.b.update(() => $block([1]).insertAfter($block([0])));
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("Second line.") / paragraph("Revenue grew 4% in Q3.")',
      );
    });

    // Moves limit (y.md): the moved paragraph is the one deleted and written
    // again, so typing in it at the same time lands at its old place.
    test.fails(
      `moving a paragraph down one slot ‖ typing in it keeps the typing in it (ids ${ids})`,
      async () => {
        const t = await setup(
          () => $getRoot().append($p('Revenue grew 4% in Q3.'), $p('Second.')),
          {ids},
        );
        t.offline();
        t.a.update(() => $selectIn([0], 13).insertText('by '));
        t.b.update(() => $block([1]).insertAfter($block([0])));
        await t.sync();
        await expectConverged(
          t.peers,
          'paragraph("Second.") / paragraph("Revenue grew by 4% in Q3.")',
        );
      },
    );

    test(`between equal blocks, the moved one is rewritten: typing in the other is kept (ids ${ids})`, async () => {
      const t = await setup(
        () => $getRoot().append($p('one'), $p('two'), $p('three')),
        {ids},
      );
      t.offline();
      t.a.update(() => $block([1]).insertAfter($block([0])));
      t.b.update(() => $selectIn([1], 3).insertText('TYPED'));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toContain('twoTYPED');
    });

    test(`moving a list down past a table ‖ typing in the table keeps the typing (${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('one')),
              $createListItemNode().append($createTextNode('two')),
            ),
            $createTableNode().append(
              $createTableRowNode().append(
                $createTableCellNode().append($p('cell')),
              ),
            ),
            $p('end'),
          ),
        {ids},
      );
      t.offline();
      t.a.update(() => $block([1]).insertAfter($block([0])));
      t.b.update(() => $selectIn([1, 0, 0, 0], 4).insertText('!'));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read(() => $getRoot().getTextContent())).toContain('cell!');
    });

    test(`undo of a move after a peer typed in the moved block duplicates nothing (${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('a'),
            $createBoxNode('o').append($p('inside')),
            $p('b'),
          ),
        {ids},
      );
      t.a.update(() => $block([2]).insertAfter($block([1])));
      await t.sync();
      t.b.update(() => $selectIn([2, 0], 6).insertText('!'));
      await t.sync();
      t.a.binding.undoManager?.stopCapturing();
      t.a.binding.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(
        t.a.read(() => $getRoot().getTextContent()).match(/inside/g),
      ).toHaveLength(1);
    });
  }
});
