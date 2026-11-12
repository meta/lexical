/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$toggleLink} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  ElementNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $createBoxNode,
  $p,
  $selectIn,
  type BoxNode,
  type Delivery,
  expectConverged,
  setup,
} from '../utils/harness';

const $li = (text: string) =>
  $createListItemNode().append($createTextNode(text));

// Block-marker scenarios: offline edits, then sync, in both id orders, causal and per-sender
// delivery, two and three peers; every peer and a fresh reader must show the
// same tree.
const P = 'Revenue grew 4% in Q3.';

// Both id orders of two peers, and three peers in the orders that matter.
const ORDERS: {name: string; ids: number[]; delivery: Delivery}[] = [
  {delivery: 'causal', ids: [1, 2], name: 'ids 1,2 causal'},
  {delivery: 'causal', ids: [2, 1], name: 'ids 2,1 causal'},
  {delivery: 'sender', ids: [1, 2], name: 'ids 1,2 per-sender'},
  {delivery: 'sender', ids: [2, 1], name: 'ids 2,1 per-sender'},
  {delivery: 'causal', ids: [1, 2, 3], name: 'three peers 1,2,3 causal'},
  {delivery: 'sender', ids: [3, 2, 1], name: 'three peers 3,2,1 per-sender'},
];

describe.each(ORDERS)('@lexical/y block markers, $name', ({ids, delivery}) => {
  const opts = {delivery, ids};

  test('split ‖ type in the tail', async () => {
    const t = await setup(() => $getRoot().append($p(P)), opts);
    t.offline();
    t.a.update(() => $selectIn([0], 8).insertParagraph());
    t.b.update(() => $selectIn([0], 15).insertText('X'));
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("Revenue ") / paragraph("grew 4%X in Q3.")',
    );
  });

  test('join ‖ type', async () => {
    const t = await setup(
      () => $getRoot().append($p('Hello'), $p('World')),
      opts,
    );
    t.offline();
    t.a.update(() => $selectIn([1], 0).deleteCharacter(true));
    t.b.update(() => $selectIn([1], 5).insertText('!'));
    await t.sync();
    await expectConverged(t.peers, 'paragraph("HelloWorld!")');
  });

  test('heading ‖ type', async () => {
    const t = await setup(() => $getRoot().append($p(P)), opts);
    t.offline();
    t.a.update(() =>
      $setBlocksType($selectIn([0], 0), () => $createHeadingNode('h2')),
    );
    t.b.update(() => $selectIn([0], 14).insertText('.5'));
    await t.sync();
    await expectConverged(t.peers, 'heading[h2]("Revenue grew 4.5% in Q3.")');
  });

  test('quote ‖ type', async () => {
    const t = await setup(() => $getRoot().append($p(P)), opts);
    t.offline();
    t.a.update(() =>
      $setBlocksType($selectIn([0], 0), () => $createQuoteNode()),
    );
    t.b.update(() => $selectIn([0], 22).insertText('!'));
    await t.sync();
    await expectConverged(t.peers, 'quote("Revenue grew 4% in Q3.!")');
  });

  test('list indent ‖ type', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append($li('one'), $li('two')),
        ),
      opts,
    );
    t.offline();
    t.a.update(() => ($block([0, 1]) as ListItemNode).setIndent(1));
    t.b.update(() => $selectIn([0, 1], 3).insertText('!'));
    await t.sync();
    await expectConverged(
      t.peers,
      'list[bullet](listitem("one") listitem(list[bullet](listitem("two!"))))',
    );
  });

  test('list type change ‖ type', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append($li('one'), $li('two')),
        ),
      opts,
    );
    t.offline();
    t.a.update(() => ($block([0]) as ListNode).setListType('number'));
    t.b.update(() => $selectIn([0, 0], 3).insertText('!'));
    await t.sync();
    await expectConverged(
      t.peers,
      'list[number](listitem("one!") listitem("two"))',
    );
  });

  test('Enter inside a list item ‖ type', async () => {
    const t = await setup(
      () => $getRoot().append($createListNode('bullet').append($li('one two'))),
      opts,
    );
    t.offline();
    t.a.update(() => $selectIn([0, 0], 4).insertParagraph());
    t.b.update(() => $selectIn([0, 0], 7).insertText('!'));
    await t.sync();
    await expectConverged(
      t.peers,
      'list[bullet](listitem("one ") listitem("two!"))',
    );
  });

  test('link ‖ type (inline formats)', async () => {
    const t = await setup(() => $getRoot().append($p(P)), opts);
    t.offline();
    t.a.update(() => {
      $selectIn([0], 8, 15);
      $toggleLink('https://x');
    });
    t.b.update(() => $selectIn([0], 13).insertText('by '));
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("Revenue " link<https://x>("grew by 4%") " in Q3.")',
    );
  });

  test('table cell paragraphs (nested container) ‖ type', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createTableNode().append(
            $createTableRowNode().append(
              $createTableCellNode().append($p('cell one')),
              $createTableCellNode().append($p('cell two')),
            ),
          ),
          $p('after'),
        ),
      opts,
    );
    t.offline();
    t.a.update(() => $selectIn([0, 0, 0, 0], 4).insertParagraph());
    t.b.update(() => $selectIn([0, 0, 0, 0], 8).insertText('!'));
    await t.sync();
    await expectConverged(
      t.peers,
      'table(tablerow(tablecell(paragraph("cell") paragraph(" one!")) tablecell(paragraph("cell two")))) / paragraph("after")',
    );
  });

  test('undeclared custom block ‖ type', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createBoxNode('info').append($p('Note this'), $p('and this')),
        ),
      opts,
    );
    t.offline();
    t.a.update(() => {
      $selectIn([0, 0], 4).insertParagraph();
      ($block([0]) as BoxNode).setTone('warn');
    });
    t.b.update(() => $selectIn([0, 0], 9).insertText('!'));
    await t.sync();
    await expectConverged(
      t.peers,
      'test_box[warn](paragraph("Note") paragraph(" this!") paragraph("and this"))',
    );
  });
});

const ORDERS3: {name: string; ids: number[]; delivery: Delivery}[] = [
  {delivery: 'causal', ids: [1, 2, 3], name: 'ids 1,2,3 causal'},
  {delivery: 'causal', ids: [3, 1, 2], name: 'ids 3,1,2 causal'},
  {delivery: 'sender', ids: [1, 2, 3], name: 'ids 1,2,3 per-sender'},
  {delivery: 'sender', ids: [3, 2, 1], name: 'ids 3,2,1 per-sender'},
];

// Removing a line deletes exactly its characters and marker: lines that
// share letters with it, and concurrent edits to its neighbours, are kept.
describe.each(ORDERS3)('@lexical/y removals, $name', opts => {
  const $nested = (text: string) =>
    $createListItemNode().append($createListNode('bullet').append($li(text)));

  test('remove a line ‖ clear the next line', async () => {
    const t = await setup(
      () => $getRoot().append($p('alpha'), $p('beta'), $p('bravo')),
      opts,
    );
    t.offline();
    t.a.update(() => $block([1]).remove());
    t.c.update(() => $selectIn([2], 0, 5).removeText());
    await t.sync();
    await expectConverged(t.peers, 'paragraph("alpha") / paragraph()');
  });

  test('remove a list item ‖ clear the next item', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $li('one'),
            $li('two'),
            $li('three'),
          ),
        ),
      opts,
    );
    t.offline();
    t.a.update(() => $block([0, 1]).remove());
    t.c.update(() => $selectIn([0, 2], 0, 5).removeText());
    await t.sync();
    await expectConverged(t.peers, 'list[bullet](listitem("one") listitem())');
  });

  test('remove a line ‖ type after the first character of the next', async () => {
    const t = await setup(
      () => $getRoot().append($p('alpha'), $p('beta'), $p('bravo')),
      opts,
    );
    t.offline();
    t.a.update(() => $block([1]).remove());
    t.c.update(() => $selectIn([2], 1).insertText('#C#'));
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("alpha") / paragraph("b#C#ravo")',
    );
  });

  test('remove a line ‖ bold the first character of the next', async () => {
    const t = await setup(
      () => $getRoot().append($p('alpha'), $p('beta'), $p('bravo')),
      opts,
    );
    t.offline();
    t.a.update(() => $block([1]).remove());
    t.c.update(() => $selectIn([2], 0, 1).formatText('bold'));
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("alpha") / paragraph("b"{1} "ravo")',
    );
  });

  test('remove an empty line ‖ type in the next empty line ‖ retype the title', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $p('Title'),
          $createParagraphNode(),
          $createParagraphNode(),
          $p('y'),
        ),
      opts,
    );
    t.offline();
    t.a.update(() => $block([1]).remove());
    t.b.update(() => $block([2]).selectStart().insertText('#B#'));
    t.c.update(() =>
      $setBlocksType($selectIn([0], 0), () => $createHeadingNode('h3')),
    );
    await t.sync();
    await expectConverged(
      t.peers,
      'heading[h3]("Title") / paragraph("#B#") / paragraph("y")',
    );
  });

  test('remove a duplicate line ‖ quote the next line', async () => {
    const t = await setup(
      () => $getRoot().append($p('same'), $p('same'), $p('same')),
      opts,
    );
    t.offline();
    t.a.update(() => $block([1]).remove());
    t.b.update(() =>
      $setBlocksType($selectIn([2], 0), () => $createQuoteNode()),
    );
    await t.sync();
    await expectConverged(t.peers, 'paragraph("same") / quote("same")');
  });

  test('typing into a line a peer removed joins the next line', async () => {
    // A documented limit: the removed line's marker is gone, so what was
    // typed into it belongs to the next marker.
    const t = await setup(
      () => $getRoot().append($p('keep'), $p('gone'), $p('next')),
      opts,
    );
    t.offline();
    t.a.update(() => $block([1]).remove());
    t.b.update(() => $selectIn([1], 2).insertText('#B#'));
    await t.sync();
    await expectConverged(t.peers, 'paragraph("keep") / paragraph("#B#next")');
  });

  test('outdent ‖ indent of one item leaves its neighbours alone', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $li('one'),
            $nested('two'),
            $li('three'),
          ),
        ),
      opts,
    );
    t.offline();
    t.a.update(() => ($block([0, 1, 0, 0]) as ListItemNode).setIndent(0));
    t.b.update(() => ($block([0, 1, 0, 0]) as ListItemNode).setIndent(2));
    await t.sync();
    await expectConverged(t.peers);
    // "three" was not edited: it stays at the top level.
    expect(
      t.a.read(() => {
        const list = $block([0]);
        const last = list.getLastChild() as ListItemNode;
        return [last.getTextContent(), last.getIndent()];
      }),
    ).toEqual(['three', 0]);
  });
});

describe('@lexical/y randomized intent checks', () => {
  // Lines carry unique tokens. After every round: every peer, and a fresh
  // reader, show the same tree; no Lexical text holds U+2029; the tokens of
  // removed lines are gone; and a line whose type was set by one peer, with
  // no other structural change to it in that round, keeps that type.
  const tokens = ['Ka1', 'Lb2', 'Mc3', 'Nd4', 'Oe5', 'Pf6', 'Qg7', 'Rh8'];
  test.each(Array.from({length: 40}, (_, i) => i + 1))(
    'seed %i',
    async seed => {
      let x = seed * 2654435761;
      const rnd = () => {
        x = (x * 1103515245 + 12345) % 2147483648;
        return x / 2147483648;
      };
      const useList = seed % 3 === 0;
      const lines = tokens.slice(0, 4 + (seed % 4));
      const t = await setup(
        () =>
          $getRoot().append(
            ...(useList
              ? [
                  $createListNode('bullet').append(
                    ...lines.map(w => $li(`ab ${w} ab`)),
                  ),
                ]
              : lines.map(w => $p(`ab ${w} ab`))),
          ),
        {delivery: seed % 2 === 0 ? 'causal' : 'sender', ids: [1, 2, 3]},
      );
      const removed = new Set<string>();
      for (let round = 0; round < 3; round++) {
        t.offline();
        const typed = new Map<string, {peer: number; type: string}>();
        const structural = new Map<string, number>();
        for (const peer of t.peers) {
          const n = 1 + Math.floor(rnd() * 2);
          for (let k = 0; k < n; k++) {
            const r = rnd();
            const r2 = rnd();
            peer.update(() => {
              const container = useList ? $block([0]) : $getRoot();
              const count = container.getChildrenSize();
              if (count === 0) {
                return;
              }
              const i = Math.floor(r2 * count);
              const line = container.getChildAtIndex(i) as ElementNode;
              if (
                !(line instanceof ElementNode) ||
                !line
                  .getChildren()
                  .every(c => !(c instanceof ElementNode) || c.isInline())
              ) {
                return;
              }
              const text = line.getTextContent();
              const token = tokens.find(w => text.includes(w));
              const path = useList ? [0, i] : [i];
              const len = line.getTextContentSize();
              const mark = (kind: 'structural' | string) => {
                if (token === undefined) {
                  return;
                }
                if (kind === 'structural') {
                  structural.set(token, (structural.get(token) ?? 0) + 1);
                }
              };
              if (r < 0.2 && count > 1 && token !== undefined) {
                removed.add(token);
                mark('structural');
                line.remove();
              } else if (r < 0.45 && len > 0) {
                $selectIn(path, Math.floor(rnd() * (len + 1))).insertText('xy');
              } else if (r < 0.6 && len > 0) {
                mark('structural');
                $selectIn(
                  path,
                  Math.floor(rnd() * (len + 1)),
                ).insertParagraph();
              } else if (r < 0.7 && i > 0 && !useList) {
                mark('structural');
                const prev = container.getChildAtIndex(i - 1);
                const prevText = prev ? prev.getTextContent() : '';
                const prevToken = tokens.find(w => prevText.includes(w));
                if (prevToken !== undefined) {
                  structural.set(
                    prevToken,
                    (structural.get(prevToken) ?? 0) + 1,
                  );
                }
                line.selectStart().deleteCharacter(true);
              } else if (r < 0.85 && !useList && token !== undefined) {
                const type = rnd() < 0.5 ? 'heading' : 'quote';
                $setBlocksType($selectIn(path, 0), () =>
                  type === 'heading'
                    ? $createHeadingNode('h2')
                    : $createQuoteNode(),
                );
                if (typed.has(token)) {
                  mark('structural');
                }
                typed.set(token, {peer: peer.doc.clientID, type});
              } else if (len > 0) {
                $selectIn(path, 0, Math.min(2, len)).formatText('bold');
              }
            });
          }
        }
        await t.sync();
        await expectConverged(t.peers);
        for (const peer of t.peers) {
          const all = peer.read(() => $getRoot().getTextContent());
          expect(all).not.toContain('\u2029');
          for (const token of removed) {
            expect(all).not.toContain(token);
          }
        }
        for (const [token, {type}] of typed) {
          if ((structural.get(token) ?? 0) > 0 || removed.has(token)) {
            continue;
          }
          const lineType = t.a.read(() => {
            const line = $getRoot()
              .getChildren()
              .find(c => c.getTextContent().includes(token));
            return line === undefined ? null : line.getType();
          });
          if (lineType !== null) {
            expect(lineType).toBe(type);
          }
        }
      }
    },
  );
});
