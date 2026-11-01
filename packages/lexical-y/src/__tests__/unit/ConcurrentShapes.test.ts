/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Shapes that concurrent edits leave (a table whose rows differ in length,
// two equal lists side by side in a list item's line, a line without its
// marker): every client and a fresh reader show them as stored, and no
// client repairs them. A local edit changes them as that client's own edit:
// Lexical pads a table before every table command.

import {
  $createListItemNode,
  $createListNode,
  type ListNode,
} from '@lexical/list';
import {
  $createTableNodeWithDimensions,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type ElementNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, YBinding} from '../..';
import {
  $block,
  $selectIn,
  describeNode,
  expectConverged,
  NODES,
  type Peer,
  setup,
} from '../utils/harness';

const $li = (text: string) =>
  $createListItemNode().append($createTextNode(text));

function tableShape(p: Peer): number[] {
  return p.read(() => {
    const t = $getRoot().getChildren().find($isTableNode) as ElementNode;
    return t.getChildren().map(r => (r as ElementNode).getChildrenSize());
  });
}

function $cell(r: number, c: number): ElementNode {
  const t = $getRoot().getChildren().find($isTableNode) as ElementNode;
  return (t.getChildAtIndex(r) as ElementNode).getChildAtIndex(
    c,
  ) as ElementNode;
}

describe('@lexical/y a table left ragged', () => {
  for (const ids of [
    [1, 2, 3],
    [2, 1, 3],
  ]) {
    for (const who of ['row', 'column'] as const) {
      test(`row ‖ column insert: shown as stored, then the ${who} inserter undoes (ids ${ids})`, async () => {
        const t = await setup(
          () => {
            $getRoot().append($createTableNodeWithDimensions(3, 3, false));
            $getRoot().append($createParagraphNode());
          },
          {ids},
        );
        const [a, b] = t.peers;
        t.offline();
        a.update(() => {
          ($cell(0, 0).getFirstChild() as ElementNode).selectEnd();
          $insertTableRowAtSelection(true);
        });
        b.update(() => {
          ($cell(0, 1).getFirstChild() as ElementNode).selectEnd();
          $insertTableColumnAtSelection(true);
        });
        await t.sync();
        await expectConverged(t.peers);
        // The inserted row does not have the inserted column.
        expect(tableShape(a)).toEqual([4, 3, 4, 4]);
        (who === 'row' ? a : b).undo();
        await t.sync();
        await expectConverged(t.peers);
        expect(tableShape(a)).toEqual(who === 'row' ? [4, 4, 4] : [3, 3, 3, 3]);
      });
    }
    test(`row ‖ column insert: the next table command pads the row, as its author's edit (ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append($createTableNodeWithDimensions(3, 3, false));
          $getRoot().append($createParagraphNode());
        },
        {ids},
      );
      const [a, b, c] = t.peers;
      t.offline();
      a.update(() => {
        ($cell(0, 0).getFirstChild() as ElementNode).selectEnd();
        $insertTableRowAtSelection(true);
      });
      b.update(() => {
        ($cell(0, 1).getFirstChild() as ElementNode).selectEnd();
        $insertTableColumnAtSelection(true);
      });
      await t.sync();
      await expectConverged(t.peers);
      expect(tableShape(a)).toEqual([4, 3, 4, 4]);
      c.update(() => {
        ($cell(3, 0).getFirstChild() as ElementNode).selectEnd();
        $insertTableRowAtSelection(true);
      });
      await t.sync();
      await expectConverged(t.peers);
      expect(tableShape(a)).toEqual([4, 4, 4, 4, 4]);
      // C's undo takes back its row and the padding together.
      c.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(tableShape(a)).toEqual([4, 3, 4, 4]);
    });
  }
});

function client(id: number, state?: Uint8Array) {
  const doc = createYDoc(null, {gc: false});
  doc.clientID = id;
  if (state !== undefined) {
    Y.applyUpdate(doc, state, 'load');
  }
  const editor = createEditor({
    namespace: 'concurrent-shapes',
    nodes: NODES,
    onError: e => {
      throw e;
    },
    onWarn: () => {},
  });
  const binding = new YBinding(editor, doc, {
    schemaVersion: 1,
    selfCheck: true,
  });
  binding.start();
  return {binding, doc, editor};
}

const describeClient = (c: ReturnType<typeof client>) =>
  c.editor
    .getEditorState()
    .read(() => $getRoot().getChildren().map(describeNode).join(' / '));

// Lexical's own commands, paste and import never put a list into a list
// item's line next to its text (they nest lists in wrapper items): only
// direct API calls and writers outside the binding do.
describe('@lexical/y two lists added to one list item', () => {
  for (const reloaded of [false, true]) {
    test(`keep both lists' items, on every client (the second list's author ${reloaded ? 'has reloaded' : 'is online'})`, () => {
      const p1 = client(1);
      p1.editor.update(
        () =>
          $getRoot().append(
            $createListNode('bullet').append($li('item'), $li('next')),
          ),
        {discrete: true},
      );
      p1.binding.initialize();
      let p2 = client(2, Y.encodeStateAsUpdate(p1.doc));
      p2.binding.initialize();
      const sv = Y.encodeStateVector(p1.doc);
      const $item = () =>
        (
          $getRoot().getFirstChild() as ElementNode
        ).getFirstChild() as ElementNode;
      p1.editor.update(
        () => $item().append($createListNode('check').append($li('x'))),
        {discrete: true},
      );
      p2.editor.update(
        () => $item().append($createListNode('check').append($li('y'))),
        {discrete: true},
      );
      const u1 = Y.encodeStateAsUpdate(p1.doc, sv);
      const u2 = Y.encodeStateAsUpdate(p2.doc, sv);
      if (reloaded) {
        p2.binding.dispose();
        p2 = client(22, Y.encodeStateAsUpdate(p2.doc));
        p2.binding.initialize();
      }
      for (const [from, to] of [
        [p1, p2],
        [p2, p1],
      ]) {
        from.doc.on('update', (u: Uint8Array, origin: unknown) => {
          if (origin !== 'net') {
            Y.applyUpdate(to.doc, u, 'net');
          }
        });
      }
      Y.applyUpdate(p2.doc, u1, 'net');
      Y.applyUpdate(p1.doc, u2, 'net');
      const d = describeClient(p1);
      expect(describeClient(p2)).toBe(d);
      // Each list moves into an item of its own after "item" (a list item
      // holding a nested list holds nothing else); the two nested lists meet
      // and read as one, each item once.
      expect(d.match(/list\[check\]/g)).toHaveLength(1);
      expect(d.match(/"x"/g)).toHaveLength(1);
      expect(d.match(/"y"/g)).toHaveLength(1);
      // A fresh reader agrees.
      const fresh = client(99, Y.encodeStateAsUpdate(p1.doc));
      fresh.binding.initialize();
      expect(describeClient(fresh)).toBe(d);
    });
  }

  test('undoing either added list takes back that list only', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createListNode('bullet').append($li('item'), $li('next')),
        ),
      {ids: [1, 2, 3]},
    );
    const [p1, p2] = t.peers;
    t.offline();
    p1.update(() =>
      $block([0, 0]).append($createListNode('check').append($li('x'))),
    );
    p2.update(() =>
      $block([0, 0]).append($createListNode('check').append($li('y'))),
    );
    await t.sync();
    await expectConverged(t.peers);
    p1.undo();
    await t.sync();
    await expectConverged(t.peers);
    expect(p1.describe()).not.toContain('"x"');
    expect(p1.describe()).toContain('"y"');
  });
});

describe('@lexical/y a line left without its marker', () => {
  // P removes the last paragraph while Q types into it: the text Q typed is
  // kept, as a line without a marker. Concurrent edits elsewhere in its
  // container then leave it as it is, on every client.
  const cases = [
    {
      end: 'list[check](listitem[ ]("a") listitem[ ]("b")) / paragraph("X")',
      name: 'list type ‖ list type',
      p: () => ($block([0]) as ListNode).setListType('bullet'),
      q: () => ($block([0]) as ListNode).setListType('check'),
    },
    {
      end: 'list[number](listitem("a") listitem() listitem("b") listitem()) / paragraph("X")',
      name: 'Enter ‖ Enter',
      p: () => $selectIn([0, 0], 1).insertParagraph(),
      q: () => $selectIn([0, 1], 1).insertParagraph(),
    },
    {
      end: 'list[bullet](listitem("1a") listitem("2b")) / paragraph("X")',
      name: 'typing and a list type ‖ typing',
      p: () => {
        $selectIn([0, 0], 0).insertText('1');
        ($block([0]) as ListNode).setListType('bullet');
      },
      q: () => $selectIn([0, 1], 0).insertText('2'),
    },
  ];
  for (const c of cases) {
    test(`${c.name} in its container leaves it a line without a marker`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createListNode('number').append($li('a'), $li('b')),
            $createParagraphNode().append($createTextNode('p')),
          ),
        {ids: [1, 2, 3]},
      );
      const [p, q] = t.peers;
      t.offline();
      p.update(() => $block([1]).remove());
      q.update(() => $selectIn([1], 1).insertText('X'));
      await t.sync();
      await expectConverged(
        t.peers,
        'list[number](listitem("a") listitem("b")) / paragraph("X")',
      );
      t.offline();
      p.update(c.p);
      q.update(c.q);
      await t.sync();
      await expectConverged(t.peers, c.end);
    });
  }

  test('two clients typing into it at once each give it a marker, which splits it in two (a documented limit)', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('one')),
          $createParagraphNode().append($createTextNode('p')),
        ),
      {ids: [1, 2, 3]},
    );
    const [p, q] = t.peers;
    t.offline();
    p.update(() => $block([1]).remove());
    q.update(() => $selectIn([1], 1).insertText('X'));
    await t.sync();
    await expectConverged(t.peers, 'paragraph("one") / paragraph("X")');
    t.offline();
    p.update(() => $selectIn([1], 0).insertText('a'));
    q.update(() => $selectIn([1], 0).insertText('b'));
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("one") / paragraph("abX") / paragraph()',
    );
  });
});
