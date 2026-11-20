/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$createLinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {$createQuoteNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createLineBreakNode,
  $createTextNode,
  $getRoot,
  type ElementNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  setup,
  shape,
} from '../utils/harness';

const $li = (text: string) =>
  $createListItemNode().append($createTextNode(text));
const $wrap = (list: ListNode) => $createListItemNode().append(list);

// Lexical keeps blocks pasted into a list item inside it, so a list item can
// hold lists of its own; the binding stores those as nodes inside the line.
// With NodeStructureExtension, which @lexical/y registers, a nested list next
// to other content in a list item moves into an item of its own (the list
// item's structure rule), so a local edit no longer leaves that shape: these
// cases start from it and run on the shape the rule makes of it.
describe('@lexical/y lists stored inside a line', () => {
  for (const order of ['p1 first', 'p2 first']) {
    test(`two peers adding a list to the same list item: both lists' items stay, on every peer (${order})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createListNode('bullet').append($li('item'), $li('next')),
          ),
        {ids: [1, 2, 3]},
      );
      const [p1, p2] = t.peers;
      t.offline();
      const e1 = () =>
        p1.update(() =>
          $block([0, 0]).append($createListNode('check').append($li('x'))),
        );
      const e2 = () =>
        p2.update(() =>
          $block([0, 0]).append($createListNode('check').append($li('y'))),
        );
      if (order === 'p1 first') {
        e1();
        e2();
      } else {
        e2();
        e1();
      }
      await t.sync();
      await expectConverged(t.peers);
      // Each list moves into an item of its own after "item"; the two
      // wrapper items meet, and their lists join.
      expect(p1.describe()).toBe(
        'list[bullet](listitem("item") listitem(list[check](listitem[ ]("x") listitem[ ]("y"))) listitem("next"))',
      );
    });
  }

  test('text typed into an item a peer removed is kept on every reader', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $createListItemNode().append(
              $createTextNode('item'),
              $createListNode('check').append($li('x'), $li('y')),
            ),
          ),
        ),
      {ids: [1, 2, 3]},
    );
    const [p1, p2] = t.peers;
    t.offline();
    p1.update(() => $block([0, 1, 0, 1]).remove());
    p2.update(() => $selectIn([0, 1, 0, 1], 1).insertText('Z'));
    await t.sync();
    await expectConverged(t.peers);
    // As for any nested list (also before the rule): the text typed into the
    // removed item reads as a paragraph after the list.
    expect(p1.describe()).toBe(
      'list[bullet](listitem("item") listitem(list[check](listitem[ ]("x")))) / paragraph("Z")',
    );
  });

  test('peers emptying a list held in a line: no peer and no fresh reader shows the empty list', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $createListItemNode().append(
              $createTextNode('item'),
              $createListNode('check').append($li('x'), $li('y')),
            ),
          ),
        ),
      {ids: [1, 2, 3]},
    );
    const [p1, p2] = t.peers;
    t.offline();
    p1.update(() => $block([0, 1, 0, 0]).remove());
    p2.update(() => $block([0, 1, 0, 1]).remove());
    await t.sync();
    await expectConverged(t.peers);
    expect(p1.describe()).not.toContain('list[check]');
  });
});

describe('@lexical/y lists stored inside a line, emptied', () => {
  test('a marker-only write on a line holding a list peers emptied raises no self-check warning', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('check').append(
            $createListItemNode(false).append(
              $createTextNode('item'),
              $createListNode('bullet').append($li('x'), $li('y')),
            ),
          ),
        ),
      {ids: [1, 2, 3]},
    );
    const [p1, p2] = t.peers;
    t.offline();
    p1.update(() => $block([0, 1, 0, 0]).remove());
    p2.update(() => $block([0, 1, 0, 1]).remove());
    await t.sync();
    // Only the line's marker changes (its checked field).
    p1.update(() => ($block([0, 0]) as ListItemNode).setChecked(true));
    await t.sync();
    await expectConverged(t.peers);
    expect(p1.describe()).toBe('list[check](listitem[x]("item"))');
  });
});

describe('@lexical/y nested list canonical form', () => {
  test('a list type change that joins two wrapper items also joins the lists they hold', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $li('top'),
            $wrap(
              $createListNode('bullet').append(
                $li('a'),
                $wrap($createListNode('check').append($li('b'))),
              ),
            ),
            $wrap(
              $createListNode('number').append(
                $wrap(
                  $createListNode('check').append(
                    $wrap($createListNode('check').append($li('c'))),
                  ),
                ),
                $li('d'),
              ),
            ),
          ),
        ),
      {ids: [1, 2]},
    );
    const [p1] = t.peers;
    p1.update(() => ($block([0, 1, 0]) as ListNode).setListType('number'));
    await t.sync();
    await expectConverged(t.peers);
    expect(p1.describe()).toBe(
      'list[bullet](listitem("top") listitem(list[number](listitem("a") listitem(list[check](listitem[ ]("b") listitem[ ](list[check](listitem[ ]("c"))))) listitem("d"))))',
    );
  });

  test('moving away the item between two wrapper items joins their nested lists', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $li('a'),
            $wrap($createListNode('bullet').append($li('b'))),
            $li('c'),
            $wrap($createListNode('bullet').append($li('d'))),
          ),
        ),
      {ids: [1, 2]},
    );
    const [p1] = t.peers;
    p1.update(() => {
      const c = $block([0, 2]);
      $getRoot().append($createListNode('number').append(c));
    });
    await t.sync();
    await expectConverged(t.peers);
    expect(p1.describe()).toBe(
      'list[bullet](listitem("a") listitem(list[bullet](listitem("b") listitem("d")))) / list[number](listitem("c"))',
    );
  });

  test("a wrapper item's and a nested list's text format reach every peer", async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $li('a'),
            $wrap($createListNode('check').append($li('b'))),
          ),
        ),
      {ids: [1, 2]},
    );
    const [p1, p2] = t.peers;
    p1.update(() => {
      const wrapper = $block([0, 1]);
      wrapper.setTextFormat(8);
      (wrapper.getFirstChild() as ElementNode).setTextFormat(8);
    });
    await t.sync();
    await expectConverged(t.peers);
    expect(JSON.stringify(shape(p2))).toContain('"textFormat":8');
  });

  test('each of two adjacent wrapper items reads its own fields', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('number').append(
            $li('a'),
            $wrap($createListNode('bullet').append($li('b'))),
            $wrap(
              $createListNode('number').append(
                $wrap($createListNode('bullet').append($li('c'))),
              ),
            ),
          ),
        ),
      {ids: [1, 2]},
    );
    const [p1] = t.peers;
    p1.update(() => {
      const second = $block([0, 2]);
      second.setTextFormat(8);
      (second.getFirstChild() as ElementNode).setTextFormat(8);
    });
    await t.sync();
    await expectConverged(t.peers);
  });
});

describe('@lexical/y inline details', () => {
  test('a link holding only a line break keeps its text format on every peer', async () => {
    const t = await setup(() => $getRoot().append($p('x')), {ids: [1, 2]});
    const [p1, p2] = t.peers;
    p1.update(() => {
      const link = $createLinkNode('https://a.x').append(
        $createLineBreakNode(),
      );
      link.setTextFormat(8);
      $block([0]).append(link);
    });
    await t.sync();
    await expectConverged(t.peers);
    expect(JSON.stringify(shape(p2))).toContain('"textFormat":8');
  });

  test('text typed at the end of a line equal to its last character lands at the caret', async () => {
    const t = await setup(() => $getRoot().append($p('ab')), {ids: [1, 2]});
    const [p1] = t.peers;
    p1.update(() => {
      $selectIn([0], 1).insertText('b');
    });
    await t.sync();
    await expectConverged(t.peers, 'paragraph("abb")');
  });

  test('a change of the start of a list held by a list item renumbers its items on every peer', async () => {
    const t = await setup(() =>
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append(
            $createTextNode('item'),
            $createListNode('number').append($li('one'), $li('two')),
          ),
        ),
      ),
    );
    t.b.update(() => {
      const list = ($block([0, 1]) as ListItemNode)
        .getChildren()
        .find((c): c is ListNode => c.getType() === 'list')!;
      list.setStart(4);
    });
    await t.sync();
    await expectConverged(t.peers);
    const values = JSON.stringify(t.a.json()).match(/"value":\d+/g);
    expect(values).toEqual([
      '"value":1',
      '"value":4',
      '"value":5',
      '"value":2',
    ]);
  });
});

describe('@lexical/y a line of another type in a list stored inside a line', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`reads as a fresh reader reads it (ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createListNode('bullet').append(
              $li('outer').append(
                $createListNode('check').append($li('a'), $li('b')),
              ),
            ),
          ),
        {ids},
      );
      // B, without the normalization, adds an item to the inner list that
      // holds a quote: stored as a quote line in that list.
      const updates: Uint8Array[] = [];
      const record = (u: Uint8Array) => updates.push(u);
      t.b.doc.on('update', record);
      t.b.editor.update(
        () => {
          const inner = (
            $block([0, 1]) as ElementNode
          ).getLastChild() as ListNode;
          const item = $createListItemNode();
          inner.append(item);
          item.append($createQuoteNode().append($createTextNode('Q')));
        },
        {discrete: true, skipTransforms: true},
      );
      t.b.doc.off('update', record);
      // A reads that update alone (before B's normalization of it).
      Y.applyUpdate(t.a.doc, updates[0], t.a.net);
      const fresh = await freshReader(t.a);
      expect(t.a.describe()).toBe(fresh.describe());
      // As for any nested list (also before the rule): the quote is lifted
      // out of the list.
      expect(t.a.describe()).toBe(
        'list[bullet](listitem("outer") listitem(list[check](listitem[ ]("a") listitem[ ]("b")))) / quote("Q")',
      );
      await t.sync();
      await expectConverged(t.peers);
    });
  }
});
