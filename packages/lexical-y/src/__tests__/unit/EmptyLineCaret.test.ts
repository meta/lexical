/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// A caret in an empty line stays at that line's start when a collaborator
// types there (#9517). It is stored at the line's marker, before which
// everything typed into the line goes, so it moved after the first
// character a collaborator typed, and their next keys went after it: the
// caret ended up inside their word, and its own next key split it.

import {$createListItemNode, $createListNode} from '@lexical/list';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  flush,
  setup,
} from '../utils/harness';

const IDS = [
  [1, 2],
  [2, 1],
];

/** The text before a peer's caret in its line. */
const $textBeforeCaret = () => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }
  const node = selection.anchor.getNode();
  if (selection.anchor.type === 'element') {
    return '';
  }
  let before = '';
  for (const text of node.getParentOrThrow().getAllTextNodes()) {
    if (text.is(node)) {
      return before + text.getTextContent().slice(0, selection.anchor.offset);
    }
    before += text.getTextContent();
  }
  return null;
};

/** The text a peer's range selection holds. */
const $selectedText = () => {
  const selection = $getSelection();
  return $isRangeSelection(selection) ? selection.getTextContent() : null;
};

describe('a collaborator types into the empty line holding my caret', () => {
  test.each([
    [
      'a paragraph after a line',
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Hello')),
          $createParagraphNode(),
        ),
      [1],
    ],
    [
      'the first paragraph',
      () =>
        $getRoot().append(
          $createParagraphNode(),
          $createParagraphNode().append($createTextNode('after')),
        ),
      [0],
    ],
    [
      'a list item',
      () =>
        $getRoot().append(
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('one')),
            $createListItemNode(),
          ),
        ),
      [0, 1],
    ],
    [
      'a table cell',
      () =>
        $getRoot().append(
          $createTableNode().append(
            $createTableRowNode().append(
              $createTableCellNode().append($createParagraphNode()),
            ),
          ),
        ),
      [0, 0, 0, 0],
    ],
  ] as [string, () => void, number[]][])(
    'in %s: key by key, my caret stays before their word',
    async (_name, $init, path) => {
      for (const ids of IDS) {
        const t = await setup($init, {ids});
        const $line = () => $block(path) as ElementNode;
        t.b.update(() => void $line().select(0, 0));
        t.a.update(() => void $line().select(0, 0));
        for (const ch of ['x', 'y', 'z']) {
          t.a.update(() => $getSelection()!.insertText(ch));
          await flush();
          expect(t.b.read($textBeforeCaret)).toBe('');
        }
        // My next key goes before their word, not inside it.
        t.b.update(() => $getSelection()!.insertText('B'));
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.read(() => $line().getTextContent())).toBe('Bxyz');
      }
    },
  );

  test('a range ending in the empty line does not grow over their word', async () => {
    for (const ids of IDS) {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Hello')),
            $createParagraphNode(),
          ),
        {ids},
      );
      t.b.update(() => {
        const selection = ($block([0]) as ElementNode).select(0, 0);
        selection.focus.set($block([1]).getKey(), 0, 'element');
      });
      t.a.update(() => void ($block([1]) as ElementNode).select(0, 0));
      for (const ch of ['x', 'y']) {
        t.a.update(() => $getSelection()!.insertText(ch));
        await flush();
      }
      await t.sync();
      await expectConverged(t.peers);
      expect(t.b.read($selectedText)).toBe('Hello\n');
    }
  });

  test.each([
    ['forward, its anchor', false],
    ['backward, its focus', true],
  ])(
    'a range starting in the empty line (%s there) does not grow over their word',
    async (_name, backward) => {
      for (const ids of IDS) {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('Hello')),
              $createParagraphNode(),
              $createParagraphNode().append($createTextNode('World')),
            ),
          {ids},
        );
        t.b.update(() => {
          const empty = $block([1]) as ElementNode;
          const world = $block([2]).getFirstChildOrThrow() as TextNode;
          if (backward) {
            world.select(5, 5).focus.set(empty.getKey(), 0, 'element');
          } else {
            empty.select(0, 0).focus.set(world.getKey(), 5, 'text');
          }
        });
        t.a.update(() => void ($block([1]) as ElementNode).select(0, 0));
        for (const ch of ['x', 'y']) {
          t.a.update(() => $getSelection()!.insertText(ch));
          await flush();
        }
        await t.sync();
        await expectConverged(t.peers);
        expect(t.b.read($selectedText)).toBe('\nWorld');
        // A delete of the range leaves their word.
        t.b.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.removeText();
          }
        });
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.read(() => $getRoot().getTextContent())).toBe('Hello\n\nxy');
      }
    },
  );

  test('select all with an empty first line does not grow over their word', async () => {
    for (const ids of IDS) {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode(),
            $createParagraphNode().append($createTextNode('World')),
          ),
        {ids},
      );
      t.b.update(() => {
        const world = $block([1]).getFirstChildOrThrow() as TextNode;
        ($block([0]) as ElementNode)
          .select(0, 0)
          .focus.set(world.getKey(), 5, 'text');
      });
      t.a.update(() => void ($block([0]) as ElementNode).select(0, 0));
      for (const ch of ['x', 'y']) {
        t.a.update(() => $getSelection()!.insertText(ch));
        await flush();
      }
      await t.sync();
      await expectConverged(t.peers);
      expect(t.b.read($selectedText)).toBe('\nWorld');
    }
  });

  // A point at the end of a line with text can be stored at the line's
  // marker too (an element point, the start of a forward range or the end of
  // a backward one): it stays at that line's end.
  test('control: an element caret at the end of a line with text stays at its end', async () => {
    for (const ids of IDS) {
      const t = await setup(() => $getRoot().append($p('Hello'), $p('after')), {
        ids,
      });
      t.b.update(() => void ($block([0]) as ElementNode).select(1, 1));
      t.a.update(() => $selectIn([1], 5).insertText('!'));
      await t.sync();
      t.b.update(() => $getSelection()!.insertText('Z'));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read(() => $block([0]).getTextContent())).toBe('HelloZ');
    }
  });

  test.each([
    ['forward', false],
    ['backward', true],
  ])(
    'control: a range from the end of a line with text (%s) keeps its text',
    async (_name, backward) => {
      for (const ids of IDS) {
        const t = await setup(
          () => $getRoot().append($p('Hello'), $p('after'), $p('tail')),
          {ids},
        );
        t.b.update(() => {
          // From the end of "Hello" to "af|ter".
          const hello = $block([0]).getFirstChildOrThrow() as TextNode;
          const after = $block([1]).getFirstChildOrThrow() as TextNode;
          if (backward) {
            after.select(2, 2).focus.set(hello.getKey(), 5, 'text');
          } else {
            hello.select(5, 5).focus.set(after.getKey(), 2, 'text');
          }
        });
        const before = t.b.read($selectedText);
        t.a.update(() => $selectIn([2], 4).insertText('!'));
        await t.sync();
        await expectConverged(t.peers);
        expect(t.b.read($selectedText)).toBe(before);
      }
    },
  );

  test('control: in a line with text, my caret at its end stays before their word', async () => {
    for (const ids of IDS) {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Hello')),
          ),
        {ids},
      );
      t.b.update(() => void ($block([0]) as ElementNode).selectEnd());
      t.a.update(() => void ($block([0]) as ElementNode).selectEnd());
      for (const ch of ['x', 'y']) {
        t.a.update(() => $getSelection()!.insertText(ch));
        await flush();
      }
      t.b.update(() => $getSelection()!.insertText('B'));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read(() => $block([0]).getTextContent())).toBe('HelloBxy');
    }
  });
});
