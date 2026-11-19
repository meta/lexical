/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createListItemNode,
  $createListNode,
  $insertList,
  $isListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $createBoxNode,
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../utils/harness';

const $li = (text: string) =>
  $createListItemNode().append($createTextNode(text));
const $deep = () =>
  $createListNode('bullet').append(
    $li('a1'),
    $createListItemNode().append(
      $createListNode('number').append(
        $li('b1'),
        $createListItemNode().append(
          $createListNode('check').append($li('c1'), $li('c2')),
        ),
      ),
    ),
    $li('a2'),
  );

describe('@lexical/y nested lists', () => {
  for (const preSync of [true, false]) {
    for (const order of ['p1 first', 'p2 first']) {
      test(`removing a nested list in a cell ‖ Enter in two of its items applies everywhere (pre-sync ${preSync}, ${order})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createTableNode().append(
                $createTableRowNode().append(
                  $createTableCellNode().append($p('x')),
                  $createTableCellNode().append($deep()),
                ),
              ),
              $createListNode('number').append($li('n1n2'), $li('n3')),
            ),
          {ids: [1, 2, 3]},
        );
        const [p1, p2, p3] = t.peers;
        t.offline();
        if (preSync) {
          await t.sync();
          t.offline();
        }
        p3.update(() => $block([0, 0, 1, 0]).remove());
        const e2 = () =>
          p2.update(() =>
            $selectIn([0, 0, 1, 0, 1, 0, 0], 2).insertParagraph(),
          );
        const e1 = () =>
          p1.update(() =>
            $selectIn([0, 0, 1, 0, 1, 0, 1, 0, 1], 0).insertParagraph(),
          );
        if (order === 'p1 first') {
          e1();
          e2();
        } else {
          e2();
          e1();
        }
        await t.sync();
        expect(t.peers.flatMap(p => p.errors.map(String))).toEqual([]);
        await expectConverged(t.peers);
      });
    }
  }

  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`undo of a list type change after a peer checked an item (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createListNode('check').append($li('x'), $li('y'), $li('z')),
          ),
        {ids},
      );
      t.offline();
      t.a.update(() => ($block([0]) as ListNode).setListType('number'));
      t.b.update(() => ($block([0, 1]) as ListItemNode).setChecked(true));
      await t.sync();
      t.a.undo();
      await t.sync();
      await expectConverged(t.peers);
    });
  }

  test('one user: paste blocks with a list into a nested item, indent, undo: numbering agrees', async () => {
    const t = await setup(() => $getRoot().append($deep(), $p('end')));
    t.a.update(() => {
      $selectIn([0, 1, 0, 1, 0, 0], 1).insertNodes([
        $p('P1'),
        $createListNode('number').append($li('PI1'), $li('PI2')),
        $p('P2'),
      ]);
    });
    t.a.binding.undoManager!.stopCapturing();
    t.a.update(() => {
      const items = $getRoot()
        .getAllTextNodes()
        .map(n => n.getParent())
        .filter(
          n => n !== null && n.getType() === 'listitem',
        ) as ListItemNode[];
      for (const li of items.slice(3, 5)) {
        li.setIndent(li.getIndent() + 1);
      }
    });
    await t.sync();
    t.a.undo();
    await t.sync();
    await expectConverged(t.peers);
  });

  for (const boxed of [true, false]) {
    test(`typing in a nested list, then a peer turning the next paragraph into a list keeps the typing (boxed ${boxed})`, async () => {
      const t = await setup(() =>
        boxed
          ? $getRoot().append(
              $createBoxNode('o').append(
                $createBoxNode('i').append($deep(), $p('para')),
              ),
            )
          : $getRoot().append($deep(), $p('para')),
      );
      const base = boxed ? [0, 0] : [];
      t.a.update(() => $selectIn([...base, 0, 0], 0).insertText('TYPED'));
      await t.sync();
      t.b.update(() => {
        $selectIn([...base, 1], 0);
        $insertList('number');
      });
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toContain('TYPED');
    });
  }

  // In a container that is not a shadow root (a box), $insertList wraps the
  // paragraph in a list item (a move): a documented limit.
  const shapes: [string, () => void, number[]][] = [
    ['root', () => $getRoot().append($p('x'), $p('para'), $p('y')), [1]],
    [
      'table cell',
      () =>
        $getRoot().append(
          $createTableNode().append(
            $createTableRowNode().append(
              $createTableCellNode().append($p('para')),
            ),
          ),
        ),
      [0, 0, 0, 0],
    ],
    [
      'after a list',
      () =>
        $getRoot().append(
          $createListNode('bullet').append($li('li')),
          $p('para'),
        ),
      [1],
    ],
  ];
  for (const [name, init, path] of shapes) {
    for (const listType of ['check', 'number'] as const) {
      for (const at of [0, 4]) {
        test(`typing at ${at} ‖ turning the paragraph into a ${listType} list keeps the typing (${name})`, async () => {
          const t = await setup(init);
          t.offline();
          t.a.update(() => $selectIn(path, at).insertText('TYPED'));
          t.b.update(() => {
            $selectIn(path, 2);
            $insertList(listType);
          });
          await t.sync();
          await expectConverged(t.peers);
          expect(t.a.describe()).toContain('TYPED');
        });
      }
    }
  }
});

describe('@lexical/y list depth', () => {
  /** `count` lists nested in one another, alternating types and starts. */
  const $chain = (count: number) => {
    let list = $createListNode('number', 1000 + count - 1).append($li('leaf'));
    for (let depth = count - 2; depth >= 0; depth--) {
      list = $createListNode(
        depth % 2 ? 'bullet' : 'number',
        1000 + depth,
      ).append($createListItemNode().append(list));
    }
    return list;
  };
  const path = (p: Peer) =>
    p.read(() => {
      const out: string[] = [];
      for (
        let n: LexicalNode | null = $getRoot().getFirstChild();
        n !== null;
        n = $isElementNode(n) ? n.getFirstChild() : null
      ) {
        if ($isListNode(n)) {
          out.push(`${n.getListType()}:${n.getStart()}`);
        }
      }
      return out;
    });
  // Before: a reader capped the level a marker stores at 64 and then
  // dropped its record of the outer levels, so from 66 lists on readers
  // showed one list fewer, with the leaf's type and start at every level.
  for (const count of [64, 65, 66, 80]) {
    test(`${count} lists nested in one another: every reader shows them all, with their types and starts`, async () => {
      const t = await setup(() => $getRoot().append($p('start')));
      t.a.update(() => {
        $getRoot().clear().append($chain(count));
      });
      await t.sync();
      const fresh = await freshReader(t.a);
      const author = path(t.a);
      expect(author.length).toBe(count);
      expect(author[0]).toBe('number:1000');
      expect(path(t.b)).toEqual(author);
      expect(path(fresh)).toEqual(author);
      expect(t.b.read(() => $getRoot().getTextContent())).toBe('leaf');
    });
  }
});
