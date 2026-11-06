/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// A remote change that shortens, splits or replaces the text node a range
// selection is in keeps the range (#9516, #9526). The read changes that node
// before the selection is put back, and Lexical moves points past the end of
// a changed node to its end: both points of the range could end on one
// offset, and the binding then took the range for a caret the user had made
// and kept it collapsed.

import {$createCodeNode} from '@lexical/code';
import {$toggleLink} from '@lexical/link';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$addMarkID, MarkStateExtension} from '@lexical/mark';
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
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYWriter, editYState} from '../../headless';
import {$block, $p, $selectIn, expectConverged, setup} from '../utils/harness';

const LINE = 't1z t2z t3z t4z';

/** Selects `text` in the line at `path`, backward if asked. */
function $selectWords(path: number[], text: string, backward = false) {
  const at = $block(path).getTextContent().indexOf(text);
  return backward
    ? $selectIn(path, at + text.length, at)
    : $selectIn(path, at, at + text.length);
}

/** The text a peer's range selection holds ('' for a caret). */
const $selected = () => {
  const selection = $getSelection();
  return $isRangeSelection(selection) ? selection.getTextContent() : null;
};

describe('a collaborator deletes text before a range selection (#9516)', () => {
  test.each([
    // [line, B selects, A deletes]
    ['aaa bbb ccc', 'ccc', 'bbb'],
    ['aaa bbbb ccc', 'ccc', 'bbbb'],
    ['aaa bbbbbbb ccc', 'ccc', 'bbbbbbb'],
    ['one two three', 'three', 'one two'],
    // A shorter delete always kept the range.
    ['aaa bb ccc', 'ccc', 'bb'],
  ])(
    '"%s": B selects "%s", A deletes "%s"',
    async (line, selected, deleted) => {
      for (const ids of [
        [1, 2],
        [2, 1],
      ]) {
        for (const backward of [false, true]) {
          const t = await setup(() => $getRoot().append($p(line), $p('tail')), {
            ids,
          });
          t.b.update(() => void $selectWords([0], selected, backward));
          t.a.update(() => $selectWords([0], deleted).removeText());
          await t.sync();
          await expectConverged(t.peers);
          expect(t.b.read($selected)).toBe(selected);
        }
      }
    },
  );
});

describe('a collaborator edits at an edge of a range selection (#9526)', () => {
  const EDITS: [string, () => void][] = [
    ['bolds the range', () => $selectWords([0], 't2z t3z').formatText('bold')],
    ['bolds its first word', () => $selectWords([0], 't2z').formatText('bold')],
    [
      'comments the range',
      () => $addMarkID('c1', $selectWords([0], 't2z t3z')),
    ],
    [
      'comments its first word',
      () => $addMarkID('c1', $selectWords([0], 't2z')),
    ],
    [
      'links the range',
      () => {
        $selectWords([0], 't2z t3z');
        $toggleLink('https://example.com');
      },
    ],
    [
      'links its first word',
      () => {
        $selectWords([0], 't2z');
        $toggleLink('https://example.com');
      },
    ],
    [
      'links a word before it',
      () => {
        $selectWords([0], 't1z');
        $toggleLink('https://example.com');
      },
    ],
    [
      'presses Enter right after it',
      () => $selectIn([0], LINE.indexOf(' t4z')).insertParagraph(),
    ],
    // These always kept the range.
    [
      'bolds from inside it',
      () => $selectWords([0], 't3z t4z').formatText('bold'),
    ],
    [
      'presses Enter right before it',
      () => $selectIn([0], LINE.indexOf('t2z')).insertParagraph(),
    ],
  ];
  test.each(EDITS)('B selects "t2z t3z", A %s', async (_name, $edit) => {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      for (const backward of [false, true]) {
        const t = await setup(() => $getRoot().append($p(LINE), $p('tail')), {
          ids,
        });
        t.b.update(() => void $selectWords([0], 't2z t3z', backward));
        t.a.update($edit);
        await t.sync();
        await expectConverged(t.peers);
        expect(t.b.read($selected)).toBe('t2z t3z');
      }
    }
  });

  test.each([
    [
      'a list item',
      () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode(LINE)),
          ),
          $p('tail'),
        ),
      [0, 0],
    ],
    [
      'a table cell',
      () =>
        $getRoot().append(
          $createTableNode().append(
            $createTableRowNode().append(
              $createTableCellNode().append($p(LINE)),
            ),
          ),
          $p('tail'),
        ),
      [0, 0, 0, 0],
    ],
    [
      'a code line',
      () =>
        $getRoot().append(
          $createCodeNode().append($createTextNode(LINE)),
          $p('tail'),
        ),
      [0],
    ],
  ] as [string, () => void, number[]][])(
    'in %s: B selects "t2z", A bolds it',
    async (_name, $init, path) => {
      const t = await setup($init);
      t.b.update(() => void $selectWords(path, 't2z'));
      t.a.update(() => $selectWords(path, 't2z').formatText('bold'));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.b.read($selected)).toBe('t2z');
    },
  );

  test("a headless writer's comment on the range keeps it", async () => {
    const t = await setup(() => $getRoot().append($p(LINE), $p('tail')));
    t.b.update(() => void $selectWords([0], 't2z t3z'));
    const {update} = editYState(
      Y.encodeStateAsUpdate(t.b.doc),
      {extensions: [MarkStateExtension], schemaVersion: 1},
      () => {
        const text = (
          $getRoot().getFirstChildOrThrow() as ElementNode
        ).getFirstChildOrThrow() as TextNode;
        $addMarkID('ai1', text.select(4, 11));
      },
      {writer: createYWriter('agent')},
    );
    for (const peer of t.peers) {
      Y.applyUpdate(peer.doc, update!, peer.net);
    }
    await t.sync();
    await expectConverged(t.peers);
    expect(t.b.read($selected)).toBe('t2z t3z');
  });
});
