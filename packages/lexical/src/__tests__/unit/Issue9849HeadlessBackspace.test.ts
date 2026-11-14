/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

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
  createEditor,
  DELETE_CHARACTER_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$internalCreateSelection} from '../../LexicalSelection';

describe('Regression #9849: Headless editor selection and backspace operations', () => {
  function createHeadlessRichEditor(): LexicalEditor {
    const editor = createEditor({
      nodes: [QuoteNode],
      onError: error => {
        throw error;
      },
    });
    registerRichText(editor);
    return editor;
  }

  test('backspace at start of the first block collapses to paragraph without throwing', () => {
    const editor = createHeadlessRichEditor();

    editor.update(
      () => {
        const quote = $createQuoteNode().append($createTextNode('quote text'));
        $getRoot().append(quote);
        quote.selectStart();
      },
      {discrete: true},
    );

    expect(() => {
      editor.update(
        () => {
          editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
        },
        {discrete: true},
      );
    }).not.toThrow();

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children.length).toBe(1);
      expect(children[0].getType()).toBe('paragraph');
      expect(children[0].getTextContent()).toBe('quote text');
    });
  });

  test('RangeSelection.modify does not throw when editor has no window', () => {
    const editor = createHeadlessRichEditor();

    editor.update(
      () => {
        const p = $createParagraphNode().append($createTextNode('hello'));
        $getRoot().append(p);
        p.select(1, 1);
      },
      {discrete: true},
    );

    expect(() => {
      editor.update(
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.modify('move', true, 'character');
            selection.modify('extend', false, 'character');
          }
        },
        {discrete: true},
      );
    }).not.toThrow();
  });

  test('$internalCreateSelection returns null when editor has no window', () => {
    const editor = createHeadlessRichEditor();
    const result = $internalCreateSelection(editor, null);
    expect(result).toBeNull();
  });
});
