/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$createQuoteNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  defineExtension,
  type ElementNode,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

const QuoteTestExtension = defineExtension({
  $initialEditorState: null,
  dependencies: [RichTextExtension],
  name: '[test-quote-insert-new-after]',
});

type BlockSnapshot = {
  format: string;
  style: string;
  textFormat: number;
  type: string;
};

/**
 * Put the caret at the end of a centred, styled block and press Enter, then
 * describe the continuation block that Enter produced.
 */
function pressEnterAtEndOf(
  $createBlock: () => ElementNode,
  boldPending: boolean,
): BlockSnapshot {
  using editor = buildEditorFromExtensions(QuoteTestExtension);
  editor.setRootElement(document.createElement('div'));

  editor.update(
    () => {
      const block = $createBlock();
      block.setFormat('center');
      block.setStyle('color: red');
      block.append($createTextNode('hello'));
      $getRoot().clear().append(block);
      block.selectEnd();
    },
    {discrete: true},
  );

  if (boldPending) {
    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'RangeSelection');
        selection.formatText('bold');
      },
      {discrete: true},
    );
  }

  editor.update(
    () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'RangeSelection');
      selection.insertParagraph();
    },
    {discrete: true},
  );

  return editor.read(() => {
    const children = $getRoot().getChildren();
    const last = children[children.length - 1] as ElementNode;
    assert(children.length === 2, 'expected the block plus its continuation');
    return {
      format: last.getFormatType(),
      style: last.getStyle(),
      textFormat: last.getTextFormat(),
      type: last.getType(),
    };
  });
}

describe('QuoteNode.insertNewAfter', () => {
  it('keeps the block alignment and style, as ParagraphNode does', () => {
    // The reference behaviour, from core ParagraphNode.insertNewAfter.
    const fromParagraph = pressEnterAtEndOf($createParagraphNode, false);
    expect(fromParagraph).toMatchObject({
      format: 'center',
      style: 'color: red',
      type: 'paragraph',
    });

    const fromQuote = pressEnterAtEndOf($createQuoteNode, false);
    expect(fromQuote).toMatchObject({
      format: 'center',
      style: 'color: red',
      type: 'paragraph',
    });
  });

  it('seeds the continuation block with the pending text format', () => {
    const fromParagraph = pressEnterAtEndOf($createParagraphNode, true);
    const fromQuote = pressEnterAtEndOf($createQuoteNode, true);

    expect(fromParagraph.textFormat).not.toBe(0);
    expect(fromQuote.textFormat).toBe(fromParagraph.textFormat);
  });
});
