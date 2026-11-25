/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {createHeadlessEditor} from '@lexical/headless';
import {
  $createQuoteNode,
  QuoteNode,
  registerRichText,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  DELETE_CHARACTER_COMMAND,
} from 'lexical';
import {afterEach, describe, expect, it, vi} from 'vitest';

// Runs on jsdom, so a DOM is available when lexical loads. An editor without a
// root element has no window of its own and must not fall back to the page's
// global selection.
describe('headless editor in a page with a DOM', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not read the global selection on Backspace', () => {
    const editor = createHeadlessEditor({
      nodes: [QuoteNode],
      onError: error => {
        throw error;
      },
    });
    registerRichText(editor);
    editor.update(
      () => {
        const quote = $createQuoteNode().append($createTextNode('quote'));
        $getRoot().append(quote);
        quote.selectStart();
      },
      {discrete: true},
    );
    const getSelection = vi.spyOn(window, 'getSelection');

    editor.update(
      () => {
        editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
      },
      {discrete: true},
    );

    expect(getSelection).not.toHaveBeenCalled();
    expect(
      editor.read(() =>
        $getRoot()
          .getChildren()
          .map(node => [node.getType(), node.getTextContent()]),
      ),
    ).toEqual([['paragraph', 'quote']]);
  });

  it('does not read the global selection on RangeSelection.modify', () => {
    const editor = createHeadlessEditor({
      onError: error => {
        throw error;
      },
    });
    editor.update(
      () => {
        $getRoot().append(
          $createParagraphNode().append($createTextNode('hello')),
        );
        $getRoot().selectStart();
      },
      {discrete: true},
    );
    const getSelection = vi.spyOn(window, 'getSelection');

    editor.update(
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.modify('move', false, 'character');
        }
      },
      {discrete: true},
    );

    expect(getSelection).not.toHaveBeenCalled();
  });
});
