/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// A line without a marker (text typed into a block a collaborator removed)
// before a block node: an unrelated edit in its container leaves it without
// a marker, and a caret on it stays on it when it does get one (#9525).
// Before, any structural edit in the container (Enter in a list item lines
// above) gave it a marker, and the caret on it was not mapped through that:
// a position in a line without a marker was not captured at all, so the
// caret went to the end of the line before, and the next keys landed there.

import {$createListItemNode, $createListNode} from '@lexical/list';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {$createTextNode, $getRoot, $getSelection} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $p,
  $selectIn,
  expectConverged,
  type Peer,
  setup,
} from '../utils/harness';

const IDS = [
  [1, 2, 3, 4],
  [4, 3, 2, 1],
];

const $table = () =>
  $createTableNode().append(
    $createTableRowNode().append($createTableCellNode().append($p('cell'))),
  );

/** The live line markers and block nodes of the root container (list
 * items are lines there too). */
function rootEnds(peer: Peer): number {
  const root = peer.doc.get('lexical-y') as unknown as {
    _start: Y.Item | null;
  };
  let n = 0;
  for (let it = root._start; it !== null; it = it.right as Y.Item | null) {
    if (!it.deleted && it.content instanceof Y.ContentType) {
      n++;
    }
  }
  return n;
}

/**
 * list("item") / "t3z t4z" / " typed" (no marker) / what C appended: A
 * removes "last" while B types " typed" at its end and C appends a block.
 */
async function markerless(ids: number[], appended: 'table' | 'none') {
  const t = await setup(
    () =>
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('item')),
        ),
        $p('t3z t4z'),
        $p('last'),
      ),
    {ids},
  );
  t.offline();
  t.peers[0].update(() => $getRoot().getChildAtIndex(2)!.remove());
  t.peers[1].update(() => void $selectIn([2], 4).insertText(' typed'));
  if (appended === 'table') {
    t.peers[2].update(() => $getRoot().append($table()));
  }
  await t.sync();
  await expectConverged(
    t.peers,
    'list[bullet](listitem("item")) / paragraph("t3z t4z") / paragraph(" typed")' +
      (appended === 'table'
        ? ' / table(tablerow(tablecell(paragraph("cell"))))'
        : ''),
  );
  return t;
}

const EDITS: [string, () => void, number][] = [
  // [D's edit, the edit, the root ends it adds]
  [
    'Enter in the list item',
    () => void $selectIn([0, 0], 2).insertParagraph(),
    1,
  ],
  ['Enter in "t3z t4z"', () => void $selectIn([1], 3).insertParagraph(), 1],
  ['types in "t3z t4z"', () => void $selectIn([1], 3).insertText(' Y'), 0],
];

describe('a line without a marker before a table', () => {
  test.each(EDITS)(
    'D: %s: the line keeps no marker, and my caret on it stays',
    async (_name, $edit, added) => {
      for (const ids of IDS) {
        const t = await markerless(ids, 'table');
        const [, b, , d] = t.peers;
        b.update(() => void $selectIn([2], 6));
        const before = rootEnds(b);
        t.offline();
        d.update($edit);
        await t.sync();
        expect(rootEnds(b)).toBe(before + added);
        b.update(() => $getSelection()!.insertText('X'));
        await t.sync();
        await expectConverged(t.peers);
        expect(b.describe()).toContain('paragraph(" typedX")');
      }
    },
  );

  test('two clients that press Enter in the list item at once add no empty line', async () => {
    for (const ids of IDS) {
      const t = await markerless(ids, 'table');
      const [a, , c] = t.peers;
      t.offline();
      a.update(() => void $selectIn([0, 0], 2).insertParagraph());
      c.update(() => void $selectIn([0, 0], 2).insertParagraph());
      await t.sync();
      await expectConverged(t.peers);
      expect(a.describe()).toMatch(
        /\) \/ paragraph\("t3z t4z"\) \/ paragraph\(" typed"\) \/ table\(/,
      );
    }
  });

  test('my caret stays on it when an edit gives it a marker', async () => {
    for (const ids of IDS) {
      const t = await markerless(ids, 'table');
      const [, b, c] = t.peers;
      b.update(() => void $selectIn([2], 6));
      // C writes the line itself (a format on its text), which stores it
      // with a marker.
      c.update(() => void $selectIn([2], 1, 6).formatText('bold'));
      await t.sync();
      b.update(() => $getSelection()!.insertText('X'));
      await t.sync();
      await expectConverged(t.peers);
      expect(
        b.read(() => $getRoot().getChildAtIndex(2)!.getTextContent()),
      ).toBe(' typedX');
    }
  });
});

describe('a line without a marker that ends its container', () => {
  test.each([
    [
      'D presses Enter in the list item',
      () => void $selectIn([0, 0], 2).insertParagraph(),
    ],
    [
      'D appends a paragraph after it',
      () => void $getRoot().append($p('after')),
    ],
    ['D appends a table after it', () => void $getRoot().append($table())],
  ] as [string, () => void][])(
    '%s: my caret on it stays',
    async (_name, $edit) => {
      for (const ids of IDS) {
        const t = await markerless(ids, 'none');
        const [, b, , d] = t.peers;
        b.update(() => void $selectIn([2], 6));
        t.offline();
        d.update($edit);
        await t.sync();
        b.update(() => $getSelection()!.insertText('X'));
        await t.sync();
        await expectConverged(t.peers);
        expect(b.describe()).toContain('paragraph(" typedX")');
      }
    },
  );
});
