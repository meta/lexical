/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// How a reorder of blocks is written. Yjs has no moves, so a block that changes
// place is deleted and inserted again, and what a peer types in it meanwhile is
// lost or stays at its old place. The binding rewrites the block that Lexical
// recorded as moved (an existing node passed to insertBefore, insertAfter,
// append or splice, as a block drag does), and every block it passed that
// Lexical did not record keeps its place, with what peers type there. Between
// recorded blocks, and in a reorder with no record (an editor state set whole),
// it rewrites the smaller side. Each case is named after its finding or after
// what it covers.

import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createQuoteNode} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
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
  expectConverged,
  type Peer,
  type Setup,
  setup,
} from '../../utils/harness';

const IDS = [
  [1, 2],
  [2, 1],
];

const $list = (...items: string[]) =>
  $createListNode('bullet').append(
    ...items.map(text => $createListItemNode().append($createTextNode(text))),
  );

const $table = (...rows: string[]) =>
  $createTableNode().append(
    ...rows.map(text =>
      $createTableRowNode().append($createTableCellNode().append($p(text))),
    ),
  );

/** The text that `peer`'s own transactions delete while `fn` runs. */
function deletedBy(peer: Peer, fn: () => void): string {
  let deleted = '';
  const onTransaction = (tr: Y.Transaction) => {
    if (!tr.local) {
      return;
    }
    Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
      if (s instanceof Y.Item && s.content instanceof Y.ContentString) {
        deleted += s.content.str;
      }
    });
  };
  peer.doc.on('afterTransaction', onTransaction);
  try {
    fn();
  } finally {
    peer.doc.off('afterTransaction', onTransaction);
  }
  return deleted;
}

function type(peer: Peer, text: string) {
  peer.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      selection.insertText(text);
    }
  });
}

// S7-2: moving a two-item list up past the paragraph before it (as a block
// drag does: `paragraph.insertBefore(list)`) was written as a move of the
// paragraph, the smaller block. A peer's concurrent typing in the paragraph
// landed in the list's first item ("Xitem one") on every client, and a
// peer's caret after "Another" went to the start of "item one". A one-item
// list, a quote and a paragraph (each smaller than the paragraph it passes)
// were controls.
describe('S7-2: a block moved up past the paragraph before it', () => {
  const MOVED = {
    'one-item list': () => $list('item one'),
    paragraph: () => $p('item one'),
    quote: () => $createQuoteNode().append($createTextNode('item one')),
    'two-item list': () => $list('item one', 'item two'),
  };
  const SHOWN = {
    'one-item list': 'list[bullet](listitem("item one"))',
    paragraph: 'paragraph("item one")',
    quote: 'quote("item one")',
    'two-item list': 'list[bullet](listitem("item one") listitem("item two"))',
  };
  for (const ids of IDS) {
    for (const surrounded of [false, true]) {
      for (const kind of Object.keys(MOVED) as (keyof typeof MOVED)[]) {
        const at = surrounded ? 1 : 0;
        const $init = () => {
          if (surrounded) {
            $getRoot().append($p('Hello world'));
          }
          $getRoot().append($p('Another line'), MOVED[kind]());
          if (surrounded) {
            $getRoot().append(
              $createQuoteNode().append($createTextNode('quote')),
            );
          }
        };
        const expected = [
          ...(surrounded ? ['paragraph("Hello world")'] : []),
          SHOWN[kind],
          'paragraph("AnotherX line")',
          ...(surrounded ? ['quote("quote")'] : []),
        ].join(' / ');
        const where = `${surrounded ? ', between other blocks' : ''} (ids ${ids})`;

        test(`S7-2 a ${kind} moved up ‖ typing in the paragraph it passed stays there${where}`, async () => {
          const t = await setup($init, {ids});
          t.offline();
          t.a.update(() => $block([at]).insertBefore($block([at + 1])));
          t.b.update(() => $selectIn([at], 7).insertText('X'));
          await t.sync();
          await expectConverged(t.peers, expected);
        });

        test(`S7-2 a ${kind} moved up: a caret in the paragraph it passed stays there${where}`, async () => {
          const t = await setup($init, {ids});
          t.b.update(() => $selectIn([at], 7));
          t.a.update(() => $block([at]).insertBefore($block([at + 1])));
          await t.sync();
          type(t.b, 'X');
          await t.sync();
          await expectConverged(t.peers, expected);
        });
      }
    }
  }
});

// S7-2, other shapes: which block was rewritten followed content size, so a
// table (1x2 or 2x2) or a list with more text than the paragraph, moved up
// or down past it, put the peer's typing in a paragraph of its own at the
// paragraph's old place; a short list and a quote passed.
describe('S7-2: blocks of every shape moved up or down past a paragraph', () => {
  const $cells = (rows: string[][]) =>
    $createTableNode().append(
      ...rows.map(cells =>
        $createTableRowNode().append(
          ...cells.map(text => $createTableCellNode().append($p(text))),
        ),
      ),
    );
  const SHAPES: [string, () => ElementNode][] = [
    ['short list', () => $list('i1', 'i2')],
    ['list of 3', () => $list('i1', 'i2', 'i3')],
    ['long list', () => $list('the first item', 'the second item')],
    ['1x2 table', () => $cells([['c1', 'c2']])],
    [
      '2x2 table',
      () =>
        $cells([
          ['r0c0', 'r0c1'],
          ['r1c0', 'r1c1'],
        ]),
    ],
    ['quote', () => $createQuoteNode().append($createTextNode('q1'))],
  ];
  for (const ids of IDS) {
    for (const [shape, $make] of SHAPES) {
      for (const direction of ['up', 'down'] as const) {
        test(`S7-2 a ${shape} moved ${direction} past a paragraph ‖ typing in the paragraph stays there (ids ${ids})`, async () => {
          const t = await setup(
            () =>
              direction === 'up'
                ? $getRoot().append($p('Another line'), $make())
                : $getRoot().append($make(), $p('Another line')),
            {ids},
          );
          t.offline();
          t.a.update(() =>
            direction === 'up'
              ? $block([0]).insertBefore($block([1]))
              : $block([1]).insertAfter($block([0])),
          );
          t.b.update(() =>
            $selectIn([direction === 'up' ? 0 : 1], 7).insertText('X'),
          );
          await t.sync();
          await expectConverged(t.peers);
          const blocks = t.a.read(() =>
            $getRoot()
              .getChildren()
              .map(block => block.getTextContent()),
          );
          expect(blocks).toHaveLength(2);
          expect(blocks[direction === 'up' ? 1 : 0]).toBe('AnotherX line');
        });
      }
    }
  }
});

describe('a recorded move rewrites the block that moved, not the blocks it passed', () => {
  for (const ids of IDS) {
    test(`a list moved up past a paragraph: the list is rewritten (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append($p('Another line'), $list('item one', 'item two')),
        {ids},
      );
      const deleted = deletedBy(t.a, () =>
        t.a.update(() => $block([0]).insertBefore($block([1]))),
      );
      expect(deleted).toContain('item one');
      expect(deleted).toContain('item two');
      expect(deleted).not.toContain('Another');
      await t.sync();
      await expectConverged(
        t.peers,
        'list[bullet](listitem("item one") listitem("item two")) / paragraph("Another line")',
      );
    });

    test(`a list moved down past a paragraph ‖ typing in the paragraph stays there (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append($list('item one', 'item two'), $p('Another line')),
        {ids},
      );
      t.offline();
      const deleted = deletedBy(t.a, () =>
        t.a.update(() => $block([1]).insertAfter($block([0]))),
      );
      expect(deleted).not.toContain('Another');
      t.b.update(() => $selectIn([1], 7).insertText('X'));
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("AnotherX line") / list[bullet](listitem("item one") listitem("item two"))',
      );
    });

    test(`a paragraph moved down past a list ‖ typing in the list stays there (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append($p('Another line'), $list('item one', 'item two')),
        {ids},
      );
      t.offline();
      t.a.update(() => $block([1]).insertAfter($block([0])));
      t.b.update(() => $selectIn([1, 0], 4).insertText('X'));
      await t.sync();
      await expectConverged(
        t.peers,
        'list[bullet](listitem("itemX one") listitem("item two")) / paragraph("Another line")',
      );
    });

    for (const direction of ['up', 'down'] as const) {
      test(`two long paragraphs moved ${direction} past a short one in one update ‖ typing in the short one stays there (ids ${ids})`, async () => {
        const long = ['the first long paragraph', 'the second long paragraph'];
        const t = await setup(
          () =>
            direction === 'up'
              ? $getRoot().append($p('short'), $p(long[0]), $p(long[1]))
              : $getRoot().append($p(long[0]), $p(long[1]), $p('short')),
          {ids},
        );
        t.offline();
        const deleted = deletedBy(t.a, () =>
          t.a.update(() => {
            const children = $getRoot().getChildren();
            if (direction === 'up') {
              const [short, first, second] = children;
              short.insertBefore(first);
              short.insertBefore(second);
            } else {
              const [first, second, short] = children;
              short.insertAfter(second);
              short.insertAfter(first);
            }
          }),
        );
        expect(deleted).not.toContain('short');
        const shortAt = direction === 'up' ? 0 : 2;
        t.b.update(() => $selectIn([shortAt], 5).insertText('X'));
        await t.sync();
        const moved = `paragraph("${long[0]}") / paragraph("${long[1]}")`;
        await expectConverged(
          t.peers,
          direction === 'up'
            ? `${moved} / paragraph("shortX")`
            : `paragraph("shortX") / ${moved}`,
        );
      });
    }

    test(`a list and a table moved up past a paragraph in one update ‖ typing in the paragraph stays there (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('Another line'),
            $list('item one', 'item two'),
            $table('cell one', 'cell two'),
          ),
        {ids},
      );
      t.offline();
      t.a.update(() => {
        const [paragraph, list, table] = $getRoot().getChildren();
        paragraph.insertBefore(list);
        paragraph.insertBefore(table);
      });
      t.b.update(() => $selectIn([0], 7).insertText('X'));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toMatch(
        /^list.*table.*paragraph\("AnotherX line"\)$/,
      );
    });
  }
});

// A container written in place (a list given an item, in a box it moves
// into) and then given new storage by the move of its node, in one update:
// the self-check compares the box as stored now.
describe('a block written, then moved, in one update', () => {
  for (const ids of IDS) {
    for (const inside of [false, true]) {
      test(`a list given an item, moved into ${inside ? 'a' : 'an empty'} box that moves too (ids ${ids})`, async () => {
        const t = await setup(
          () => {
            const box = $createBoxNode();
            if (inside) {
              box.append($p('inside'));
            }
            $getRoot().append($list('a', 'b'), box, $p('gap'));
          },
          {ids},
        );
        t.a.update(() => {
          const [list, box] = [$block([0]), $block([1])];
          list.splice(0, 0, [
            $createListItemNode().append($createTextNode('z')),
          ]);
          box.append(list);
          $block([1]).insertAfter(box);
        });
        await t.sync();
        await expectConverged(t.peers);
        expect(t.b.read(() => $block([1]).getTextContent())).toBe(
          `${inside ? 'inside\n\n' : ''}z\n\na\n\nb`,
        );
      });
    }
  }
});

// The APIs y.md (Limits, Moves) names as recorded moves: each moves the
// list here, and the paragraph it passes keeps a peer's typing.
describe('every Lexical API that moves a node records the move', () => {
  const MOVES: [string, 'up' | 'down', () => void][] = [
    ['insertBefore', 'up', () => $block([0]).insertBefore($block([1]))],
    ['insertAfter', 'down', () => $block([1]).insertAfter($block([0]))],
    ['append', 'down', () => $getRoot().append($block([0]))],
    ['splice', 'up', () => $getRoot().splice(0, 0, [$block([1])])],
  ];
  for (const ids of IDS) {
    for (const [api, direction, $move] of MOVES) {
      test(`${api} moves a list ${direction} past a paragraph ‖ typing in the paragraph stays there (ids ${ids})`, async () => {
        const $twoItems = () => $list('item one', 'item two');
        const t = await setup(
          () =>
            direction === 'up'
              ? $getRoot().append($p('Another line'), $twoItems())
              : $getRoot().append($twoItems(), $p('Another line')),
          {ids},
        );
        t.offline();
        const deleted = deletedBy(t.a, () => t.a.update($move));
        expect(deleted).not.toContain('Another');
        const at = direction === 'up' ? 0 : 1;
        t.b.update(() => $selectIn([at], 7).insertText('X'));
        await t.sync();
        const shownList =
          'list[bullet](listitem("item one") listitem("item two"))';
        await expectConverged(
          t.peers,
          direction === 'up'
            ? `${shownList} / paragraph("AnotherX line")`
            : `paragraph("AnotherX line") / ${shownList}`,
        );
      });
    }

    test(`a block detached and inserted back where it was is not rewritten (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('Another line'),
            $list('item one', 'item two'),
            $p('end'),
          ),
        {ids},
      );
      const deleted = deletedBy(t.a, () =>
        t.a.update(() => $block([0]).insertAfter($block([1]))),
      );
      expect(deleted).toBe('');
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("Another line") / list[bullet](listitem("item one") listitem("item two")) / paragraph("end")',
      );
    });
  }
});

describe('recorded moves in nested lists', () => {
  // one / two / [n1 / the nested item that moves]
  const $nested = () =>
    $createListNode('bullet').append(
      $createListItemNode().append($createTextNode('one')),
      $createListItemNode().append($createTextNode('two')),
      $createListItemNode().append($list('n1', 'the nested item that moves')),
    );
  const $nestedList = () =>
    ($block([0]).getLastChild() as ElementNode).getFirstChild() as ElementNode;
  for (const ids of IDS) {
    test(`a nested item moved up past its sibling ‖ typing in the sibling stays there (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($nested()), {ids});
      t.offline();
      t.a.update(() => {
        const [n1, mover] = $nestedList().getChildren();
        n1.insertBefore(mover);
      });
      t.b.update(() => $selectIn([0, 2, 0, 0], 2).insertText('X'));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toContain(
        'list[bullet](listitem("the nested item that moves") listitem("n1X"))',
      );
    });

    test(`a nested item moved down past its sibling ‖ typing in the sibling stays there (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('one')),
              $createListItemNode().append(
                $list('the nested item that moves', 'n2'),
              ),
            ),
          ),
        {ids},
      );
      t.offline();
      t.a.update(() => {
        const [mover, n2] = $nestedList().getChildren();
        n2.insertAfter(mover);
      });
      t.b.update(() => $selectIn([0, 1, 0, 1], 2).insertText('X'));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toContain(
        'list[bullet](listitem("n2X") listitem("the nested item that moves"))',
      );
    });

    test(`a nested list moved up past the outer items ‖ typing in an outer item stays there (ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($nested()), {ids});
      t.offline();
      t.a.update(() => {
        const [one, , level] = $block([0]).getChildren();
        one.insertBefore(level);
      });
      t.b.update(() => $selectIn([0, 0], 3).insertText('X'));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toContain('listitem("oneX") listitem("two")');
    });
  }
});

describe('recorded moves of tables and table rows', () => {
  for (const ids of IDS) {
    for (const direction of ['up', 'down'] as const) {
      test(`a table moved ${direction} past a paragraph ‖ typing in the paragraph stays there (ids ${ids})`, async () => {
        const t = await setup(
          () =>
            direction === 'up'
              ? $getRoot().append(
                  $p('Another line'),
                  $table('cell one', 'cell two'),
                )
              : $getRoot().append(
                  $table('cell one', 'cell two'),
                  $p('Another line'),
                ),
          {ids},
        );
        t.offline();
        const deleted = deletedBy(t.a, () =>
          t.a.update(() =>
            direction === 'up'
              ? $block([0]).insertBefore($block([1]))
              : $block([1]).insertAfter($block([0])),
          ),
        );
        expect(deleted).not.toContain('Another');
        const at = direction === 'up' ? 0 : 1;
        t.b.update(() => $selectIn([at], 7).insertText('X'));
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.describe()).toMatch(
          direction === 'up'
            ? /^table\(.*\) \/ paragraph\("AnotherX line"\)$/
            : /^paragraph\("AnotherX line"\) \/ table\(.*\)$/,
        );
      });

      test(`a table row moved ${direction} past another ‖ typing in the other row stays there (ids ${ids})`, async () => {
        const long = 'a row with more text than the other';
        const t = await setup(
          () =>
            $getRoot().append(
              direction === 'up'
                ? $table('short', long)
                : $table(long, 'short'),
            ),
          {ids},
        );
        t.offline();
        const deleted = deletedBy(t.a, () =>
          t.a.update(() => {
            const [first, second] = $block([0]).getChildren();
            if (direction === 'up') {
              first.insertBefore(second);
            } else {
              second.insertAfter(first);
            }
          }),
        );
        expect(deleted).not.toContain('short');
        const shortRow = direction === 'up' ? 0 : 1;
        t.b.update(() => $selectIn([0, shortRow, 0, 0], 5).insertText('X'));
        await t.sync();
        await expectConverged(t.peers);
        const rows = t.a.read(() =>
          $block([0])
            .getChildren()
            .map(row => row.getTextContent()),
        );
        expect(rows).toEqual(
          direction === 'up' ? [long, 'shortX'] : ['shortX', long],
        );
      });
    }

    test(`a table moved up: a caret in the paragraph it passed stays there (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append($p('Another line'), $table('cell one', 'cell two')),
        {ids},
      );
      t.b.update(() => $selectIn([0], 7));
      t.a.update(() => $block([0]).insertBefore($block([1])));
      await t.sync();
      type(t.b, 'X');
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toMatch(
        /^table\(.*\) \/ paragraph\("AnotherX line"\)$/,
      );
    });
  }
});

// The limits that remain (y.md, Limits, Moves). The moved block is deleted
// and inserted again: what a peer types in it meanwhile is lost (in a block
// node) or stays at its old place, a peer's caret in it goes to the block now
// at that place, and an undo of the move takes the moved copy back, with what
// a peer typed in it since. Every case converges; its expected failure states
// what a native move would keep.
describe('Moves limit: the block that moved', () => {
  type Moved = 'list' | 'table';
  const $doc = (moved: Moved) => () =>
    $getRoot().append(
      $p('Another line'),
      moved === 'list'
        ? $list('item one', 'item two')
        : $table('cell one', 'cell two'),
    );
  // The path of the moved block's first line, before and after the move.
  const FIRST: Record<Moved, [number[], number[]]> = {
    list: [
      [1, 0],
      [0, 0],
    ],
    table: [
      [1, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  };
  const KEPT: Record<Moved, string> = {
    list: 'list[bullet](listitem("itemX one") listitem("item two"))',
    table:
      'table(tablerow(tablecell(paragraph("cellX one"))) tablerow(tablecell(paragraph("cell two"))))',
  };
  const $move = () => $block([0]).insertBefore($block([1]));
  const CASES: [
    string,
    Moved[],
    (t: Setup, moved: Moved) => Promise<void>,
    (moved: Moved) => string,
  ][] = [
    [
      'typing in the moved block while it moves stays in it',
      ['list', 'table'],
      async (t, moved) => {
        t.offline();
        t.a.update($move);
        t.b.update(() => $selectIn(FIRST[moved][0], 4).insertText('X'));
        await t.sync();
      },
      moved => `${KEPT[moved]} / paragraph("Another line")`,
    ],
    [
      'a caret in the moved block stays in it',
      ['list'],
      async (t, moved) => {
        t.b.update(() => $selectIn(FIRST[moved][0], 4));
        t.a.update($move);
        await t.sync();
        type(t.b, 'X');
        await t.sync();
      },
      moved => `${KEPT[moved]} / paragraph("Another line")`,
    ],
    [
      'undoing the move keeps what a peer typed in the block since',
      ['list', 'table'],
      async (t, moved) => {
        t.a.update($move);
        await t.sync();
        t.b.update(() => $selectIn(FIRST[moved][1], 4).insertText('X'));
        await t.sync();
        t.a.undo();
        await t.sync();
      },
      moved => `paragraph("Another line") / ${KEPT[moved]}`,
    ],
  ];
  for (const ids of IDS) {
    for (const [name, kinds, run, kept] of CASES) {
      for (const moved of kinds) {
        test(`a ${moved} moved up past a paragraph, ${name}: converges (ids ${ids})`, async () => {
          const t = await setup($doc(moved), {ids});
          await run(t, moved);
          await expectConverged(t.peers);
        });
        test.fails(
          `a ${moved} moved up past a paragraph, ${name} (ids ${ids})`,
          async () => {
            const t = await setup($doc(moved), {ids});
            await run(t, moved);
            await expectConverged(t.peers, kept(moved));
          },
        );
      }
    }
  }
});

// Lexical records every node detached in the update, also one put back where
// it was in the same update (an insert next to the sibling it already has, a
// remove and a re-insert, a move away and back). Such a node counts as moved,
// so when it is also the block a real move passes, neither is known to have
// stayed, and the smaller one (here the paragraph) is rewritten.
describe('Moves limit: a node put back where it was in the update of a move', () => {
  // Each moves the list up past the paragraph, and puts the paragraph back.
  const UPDATES: [string, () => void][] = [
    [
      'inserted next to the sibling it has, before the move',
      () => {
        const [paragraph, list] = $getRoot().getChildren();
        list.insertBefore(paragraph);
        paragraph.insertBefore(list);
      },
    ],
    [
      'inserted next to the sibling it has, after the move',
      () => {
        const [paragraph, list, end] = $getRoot().getChildren();
        paragraph.insertBefore(list);
        end.insertBefore(paragraph);
      },
    ],
    [
      'removed and inserted again',
      () => {
        const [paragraph, list] = $getRoot().getChildren();
        paragraph.remove();
        list.insertBefore(paragraph);
        paragraph.insertBefore(list);
      },
    ],
    [
      'moved away and back',
      () => {
        const [paragraph, list, end] = $getRoot().getChildren();
        end.insertAfter(paragraph);
        list.insertBefore(paragraph);
        paragraph.insertBefore(list);
      },
    ],
  ];
  const $init = () =>
    $getRoot().append(
      $p('Another line'),
      $list('item one', 'item two'),
      $p('end'),
    );
  for (const ids of IDS) {
    for (const [how, $update] of UPDATES) {
      const run = async (t: Setup) => {
        t.offline();
        t.a.update($update);
        t.b.update(() => $selectIn([0], 7).insertText('X'));
        await t.sync();
      };
      test(`the paragraph ${how}: converges (ids ${ids})`, async () => {
        const t = await setup($init, {ids});
        await run(t);
        await expectConverged(t.peers);
      });
      test.fails(
        `the paragraph ${how} ‖ typing in the paragraph stays there (ids ${ids})`,
        async () => {
          const t = await setup($init, {ids});
          await run(t);
          await expectConverged(
            t.peers,
            'list[bullet](listitem("item one") listitem("item two")) / paragraph("AnotherX line") / paragraph("end")',
          );
        },
      );
    }
  }
});

// Without a record of moves (an editor state set whole: here a state from
// before the move), the binding cannot tell which block moved: it keeps the
// side that keeps more blocks and content in place, and rewrites the other.
describe('a reorder with no record of moves', () => {
  for (const ids of IDS) {
    test(`an editor state set whole that swaps two blocks rewrites the smaller one (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append($p('Another line'), $list('item one', 'item two')),
        {ids},
      );
      const before = t.a.editor.getEditorState();
      t.a.update(() => $block([0]).insertBefore($block([1])));
      await t.sync();
      t.offline();
      const deleted = deletedBy(t.a, () => t.a.editor.setEditorState(before));
      expect(deleted).toContain('Another line');
      expect(deleted).not.toContain('item');
      t.b.update(() => $selectIn([0, 0], 4).insertText('X'));
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("Another line") / list[bullet](listitem("itemX one") listitem("item two"))',
      );
    });
  }
});
