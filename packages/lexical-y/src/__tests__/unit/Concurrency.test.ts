/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Lists, links, moves and formats found by randomized runs: every order and delivery.
// @vitest-environment node

import {$createLinkNode, $toggleLink} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $insertList,
  $isListItemNode,
  $isListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {$createHeadingNode} from '@lexical/rich-text';
import {$create, $createTextNode, $getRoot, type ElementNode} from 'lexical';
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
  setup,
} from '../utils/harness';

const MATRIX: [number[], Delivery][] = [
  [[1, 2, 3], 'causal'],
  [[3, 2, 1], 'causal'],
  [[1, 2, 3], 'sender'],
  [[3, 2, 1], 'sender'],
];
const $li = (t: string) => $createListItemNode().append($createTextNode(t));
const allText = (t: {a: {read: <T>(fn: () => T) => T}}) =>
  t.a.read(() => $getRoot().getTextContent());

describe.each(MATRIX)('ids %j %s', (ids, delivery) => {
  test('typing "<b>" between "<a>" and "<c>" ‖ peer removes the line: typed text survives intact', async () => {
    const t = await setup(() => $getRoot().append($p('<a><c>'), $p('next')), {
      delivery,
      ids,
    });
    t.offline();
    t.a.update(() => {
      $selectIn([0], 3).insertText('<b>');
    });
    t.b.update(() => {
      $block([0]).remove();
    });
    await t.sync();
    await expectConverged(t.peers);
    // documented: text typed into a removed line joins the next line
    expect(allText(t)).toContain('<b>');
  });

  test('same with plain words: typing "cat " before "cats" ‖ remove line', async () => {
    const t = await setup(() => $getRoot().append($p('my cats'), $p('next')), {
      delivery,
      ids,
    });
    t.offline();
    t.a.update(() => {
      $selectIn([0], 3).insertText('cat ');
    });
    t.b.update(() => {
      $block([0]).remove();
    });
    await t.sync();
    await expectConverged(t.peers);
    expect(allText(t)).toContain('cat ');
  });

  test('moving the only item of a list into another list (sequential) does not duplicate it', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append($li('a'), $li('b')),
          $p('mid'),
          $createListNode('bullet').append($li('z')),
        ),
      {delivery, ids},
    );
    t.a.update(() => {
      const z = $block([2, 0]);
      $block([0, 0]).insertAfter(z);
    });
    await t.sync();
    const local = t.a.describe();
    await expectConverged(t.peers);
    expect(t.b.describe()).toBe(local);
    expect(allText(t).match(/z/g)?.length).toBe(1);
  });

  test("moving the only item of a list that is a box's only child into another list (sequential)", async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append($li('a'), $li('b')),
          $createBoxNode('x').append(
            $createListNode('bullet').append($li('z')),
          ),
          $p('end'),
        ),
      {delivery, ids},
    );
    t.a.update(() => {
      const z = $block([1, 0, 0]);
      $block([0, 0]).insertAfter(z);
    });
    await t.sync();
    const local = t.a.describe();
    await expectConverged(t.peers);
    expect(t.b.describe()).toBe(local);
    expect(allText(t).match(/z/g)?.length).toBe(1);
  });

  test('outer list whose items are all indented keeps its own list type (sequential)', async () => {
    const t = await setup(
      () =>
        $getRoot().append($createListNode('bullet').append($li('a'), $li('b'))),
      {delivery, ids},
    );
    t.a.update(() => {
      ($block([0, 0]) as ListItemNode).setIndent(1);
    });
    t.a.update(() => {
      // the nested list created by the indent
      ($block([0, 0, 0]) as ListNode).setListType('number');
    });
    t.a.update(() => {
      ($block([0, 1]) as ListItemNode).setIndent(1);
    });
    await t.sync();
    const local = t.a.describe();
    await expectConverged(t.peers);
    expect(t.b.describe()).toBe(local);
  });

  test('indent the first item ‖ change the list type', async () => {
    const t = await setup(
      () =>
        $getRoot().append($createListNode('bullet').append($li('a'), $li('b'))),
      {delivery, ids},
    );
    t.offline();
    t.a.update(() => {
      ($block([0, 0]) as ListItemNode).setIndent(1);
    });
    t.b.update(() => {
      ($block([0]) as ListNode).setListType('number');
    });
    await t.sync();
    await expectConverged(t.peers);
  });

  test('bold a whole paragraph ‖ peer deletes its text: element textFormat converges', async () => {
    const t = await setup(() => $getRoot().append($p('aa'), $p('bb')), {
      delivery,
      ids,
    });
    t.offline();
    t.a.update(() => {
      $selectIn([0], 0, 2).formatText('bold');
    });
    t.b.update(() => {
      $selectIn([0], 0, 2).removeText();
    });
    await t.sync();
    await expectConverged(t.peers);
  });

  test('bold across an indented list: ListNode and wrapper ListItem textFormat sync', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append($li('a'), $li('b')),
          $p('cc'),
        ),
      {delivery, ids},
    );
    t.a.update(() => {
      ($block([0, 0]) as ListItemNode).setIndent(1);
    });
    t.a.update(() => {
      const sel = $selectIn([1], 0, 2);
      const first = $block([0, 0, 0, 0]).getFirstChild()!;
      sel.anchor.set(first.getKey(), 0, 'text');
      sel.formatText('bold');
    });
    await t.sync();
    await expectConverged(t.peers);
  });

  test('indent a nested first item ‖ change the outer list type: content after the list survives', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append($li('a'), $li('b')),
          $p('after'),
          $createBoxNode('x').append($p('box')),
          $p('end'),
        ),
      {delivery, ids},
    );
    t.b.update(() => {
      ($block([0, 0]) as ListItemNode).setIndent(1);
    });
    await t.sync();
    t.offline();
    t.a.update(() => {
      ($block([0]) as ListNode).setListType('check');
    });
    t.b.update(() => {
      // the nested item 'a'
      ($block([0, 0, 0, 0]) as ListItemNode).setIndent(2);
    });
    await t.sync();
    await expectConverged(t.peers);
    expect(allText(t)).toContain('after');
    expect(allText(t)).toContain('box');
    expect(allText(t)).toContain('end');
    await expectConverged(t.peers);
  });

  test('two adjacent links with the same URL (sequential): node structure converges', async () => {
    const t = await setup(() => $getRoot().append($p('aabb')), {
      delivery,
      ids,
    });
    t.a.update(() => {
      $selectIn([0], 2, 4);
      $toggleLink('https://x');
    });
    t.a.update(() => {
      $selectIn([0], 0, 2);
      $toggleLink('https://x');
    });
    await t.sync();
    const local = t.a.describe();
    await expectConverged(t.peers);
    expect(t.b.describe()).toBe(local);
  });

  // Documented limit: a move is a delete and a reinsert, so a block a peer
  // replaces while another moves it is kept twice. Converges.
  test('checklist from a box paragraph ‖ move a collapsible after the box: converges', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $create(ColContainerNode).append(
            $create(ColTitleNode).append($createTextNode('t')),
            $create(ColContentNode).append($p('c')),
          ),
          $createBoxNode('o').append($p('x')),
          $p('end'),
        ),
      {delivery, ids},
    );
    t.offline();
    t.a.update(() => {
      $block([1]).insertAfter($block([0]));
    });
    t.b.update(() => {
      $selectIn([1, 0], 0);
      $insertList('check');
    });
    await t.sync();
    await expectConverged(t.peers);
    expect(allText(t)).toContain('x');
  });

  test('list type check -> (peer) number -> undo: ListItem checked converges', async () => {
    const t = await setup(
      () =>
        $getRoot().append($createListNode('bullet').append($li('a'), $li('b'))),
      {delivery, ids},
    );
    t.c.update(() => {
      ($block([0]) as ListNode).setListType('check');
    });
    await t.sync();
    t.b.update(() => {
      ($block([0]) as ListNode).setListType('number');
    });
    t.b.undo();
    await t.sync();
    await expectConverged(t.peers);
  });

  test('relink a linked word with another URL (sequential, other peer): url converges', async () => {
    const t = await setup(() => $getRoot().append($p('aa bb cc')), {
      delivery,
      ids,
    });
    t.a.update(() => {
      $selectIn([0], 3, 5);
      $toggleLink('https://b.x');
    });
    await t.sync();
    t.c.update(() => {
      $selectIn([0], 3, 5);
      $toggleLink('https://a.x');
    });
    await t.sync();
    await expectConverged(t.peers);
  });

  test('bold heading+list item ‖ move a box before the heading: converge', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $p('p'),
          $createHeadingNode('h2').append($createTextNode('hh')),
          $createListNode('bullet').append($li('ii')),
          $createBoxNode('o').append($p('box')),
        ),
      {delivery, ids},
    );
    t.offline();
    t.a.update(() => {
      const sel = $selectIn([1], 0);
      const n = $block([2, 0]).getFirstChild()!;
      sel.focus.set(n.getKey(), 2, 'text');
      sel.formatText('bold');
    });
    t.b.update(() => {
      $block([1]).insertBefore($block([3]));
    });
    await t.sync();
    await expectConverged(t.peers);
  });

  test('one user: heading -> checklist, then indent it: content after the list survives', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $p('top'),
          $createHeadingNode('h2').append($createTextNode('head')),
          $createListNode('bullet').append($li('a'), $li('b')),
          $p('after'),
          $p('end'),
        ),
      {delivery, ids},
    );
    t.a.update(() => {
      $selectIn([1], 0);
      $insertList('check');
    });
    await t.sync();
    t.a.update(() => {
      ($block([1, 0]) as ListItemNode).setIndent(1);
    });
    await t.sync();
    expect(allText(t)).toContain('after');
    expect(allText(t)).toContain('end');
    await expectConverged(t.peers);
  });

  test.each([null, 'https://c.x'])(
    'join a heading holding a link into the paragraph above, peer then toggles link %s: no exception',
    async url => {
      const t = await setup(
        () =>
          $getRoot().append(
            $p('aa'),
            $createHeadingNode('h2').append(
              $createLinkNode('https://b.x').append($createTextNode('bb')),
            ),
            $p('end'),
          ),
        {delivery, ids},
      );
      t.a.update(() => {
        $selectIn([0], 2).deleteCharacter(false);
      });
      await t.sync();
      t.c.update(() => {
        $selectIn([0], 2, 4);
        $toggleLink(url);
      });
      await t.sync();
      await expectConverged(t.peers);
    },
  );

  test('italic across paragraph > heading > paragraph ‖ insert a box between: converge', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $p('aa'),
          $createHeadingNode('h2').append($createTextNode('bb')),
          $p('cc'),
        ),
      {delivery, ids},
    );
    t.offline();
    t.a.update(() => {
      $block([0]).insertAfter($createBoxNode('x').append($p('box')));
    });
    t.b.update(() => {
      const sel = $selectIn([0], 1);
      const [n, o] = [$block([2]).getFirstChild()!, 1];
      sel.focus.set(n.getKey(), o, 'text');
      sel.formatText('italic');
    });
    await t.sync();
    await expectConverged(t.peers);
  });
});

export const _unused = [
  $isListItemNode,
  $isListNode,
] as unknown as ElementNode[];
