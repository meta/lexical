/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  type ElementNode,
  IS_BOLD,
  type RangeSelection,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {$assertNodeType} from '../utils';

const ext = defineExtension({
  dependencies: [RichTextExtension, ListExtension],
  name: '@test/armed-format',
});

// A format toggled with nothing selected is armed for the *next* insertion and
// is deliberately not backed by any node yet. Edits reposition the caret
// through ElementNode.select()/TextNode.select() as an implementation detail —
// Enter moves it into the block `insertNewAfter` just created, paste moves it
// to the end of the pasted content — so anything that re-derives the format
// from the node those land on silently cancels what the user armed.
function $arm(): RangeSelection {
  const selection = $getSelection();
  assert($isRangeSelection(selection), 'Expected RangeSelection');
  selection.formatText('bold');
  expect(selection.format).toBe(IS_BOLD);
  return selection;
}

function armBoldThen(
  $seed: () => void,
  $op: (selection: RangeSelection) => void,
): number {
  const editor = buildEditorFromExtensions(ext);
  try {
    editor.update($seed, {discrete: true});
    editor.update(() => void $op($arm()), {discrete: true});
    let format = -1;
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected RangeSelection');
      format = selection.format;
    });
    return format;
  } finally {
    editor.dispose();
  }
}

const $seedAtEndOf = ($make: () => ElementNode) => () => {
  const block = $make();
  $getRoot().clear().append(block);
  block.selectEnd();
};

const $seedParagraph = $seedAtEndOf(() =>
  $createParagraphNode().append($createTextNode('abc')),
);

describe('a format armed on a collapsed caret survives an edit', () => {
  test.for([
    {
      $seed: $seedAtEndOf(() =>
        $createHeadingNode('h1').append($createTextNode('abc')),
      ),
      kind: 'a heading',
    },
    {$seed: $seedParagraph, kind: 'a paragraph'},
    {
      $seed: $seedAtEndOf(() =>
        $createQuoteNode().append($createTextNode('abc')),
      ),
      kind: 'a quote',
    },
    {
      $seed: $seedAtEndOf(() =>
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('abc')),
        ),
      ),
      kind: 'a list item',
    },
    {
      // Splitting mid-block moves the trailing TextNode into the new block, so
      // the caret lands on a node that carries its own (unbolded) format.
      $seed: () => {
        const text = $createTextNode('abcdef');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(3, 3);
      },
      kind: 'the middle of a paragraph',
    },
  ])('Enter in $kind', ({$seed}) => {
    expect(armBoldThen($seed, selection => selection.insertParagraph())).toBe(
      IS_BOLD,
    );
  });

  test('Shift+Enter', () => {
    expect(
      armBoldThen($seedParagraph, selection => selection.insertLineBreak()),
    ).toBe(IS_BOLD);
  });

  test('pasting inline content', () => {
    expect(
      armBoldThen($seedParagraph, selection =>
        selection.insertNodes([$createTextNode('pasted')]),
      ),
    ).toBe(IS_BOLD);
  });

  test('pasting a block', () => {
    expect(
      armBoldThen($seedParagraph, selection =>
        selection.insertNodes([
          $createParagraphNode().append($createTextNode('pasted')),
        ]),
      ),
    ).toBe(IS_BOLD);
  });

  test('the armed format reaches the text typed after Enter', () => {
    const editor = buildEditorFromExtensions(ext);
    try {
      editor.update($seedParagraph, {discrete: true});
      editor.update(
        () => {
          const selection = $arm();
          selection.insertParagraph();
          selection.insertText('typed');
        },
        {discrete: true},
      );
      editor.read(() => {
        const typed = $assertNodeType(
          $getRoot().getLastDescendant(),
          $isTextNode,
        );
        expect(typed.getTextContent()).toBe('typed');
        expect(typed.getFormat()).toBe(IS_BOLD);
      });
    } finally {
      editor.dispose();
    }
  });
});
