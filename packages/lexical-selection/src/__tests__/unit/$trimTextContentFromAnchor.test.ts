/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {$trimTextContentFromAnchor} from '@lexical/selection';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

/**
 * Commit `paragraphs` with the caret at `caret` (paragraph index, offset),
 * then paste `text` at the caret and trim to `maxLength` from the anchor,
 * the way MaxLengthPlugin does in a transform of the same update.
 */
function pasteWithMaxLength(
  editor: LexicalEditor,
  paragraphs: string[],
  caret: [number, number],
  text: string,
  maxLength: number,
) {
  editor.update(
    () => {
      $getRoot().clear();
      paragraphs.forEach((content, index) => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        if (content === '') {
          if (index === caret[0]) {
            paragraph.select();
          }
          return;
        }
        const textNode = $createTextNode(content);
        paragraph.append(textNode);
        if (index === caret[0]) {
          textNode.select(caret[1], caret[1]);
        }
      });
    },
    {discrete: true},
  );
  editor.update(
    () => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        throw new Error('Expected a range selection');
      }
      selection.insertText(text);
      const delCount = $getRoot().getTextContentSize() - maxLength;
      if (delCount > 0) {
        $trimTextContentFromAnchor(editor, selection.anchor, delCount);
      }
    },
    {discrete: true},
  );
  return editor.read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      throw new Error('Expected a range selection');
    }
    return {
      anchorOffset: selection.anchor.offset,
      anchorText: selection.anchor.getNode().getTextContent(),
      isCollapsed: selection.isCollapsed(),
      size: $getRoot().getTextContentSize(),
      text: $getRoot().getTextContent(),
    };
  });
}

describe('$trimTextContentFromAnchor (#3775)', () => {
  test('keeps the start of a paste into an empty editor', () => {
    using editor = buildEditorFromExtensions({name: 'trim-test'});
    expect(pasteWithMaxLength(editor, [''], [0, 0], '0123456789', 4)).toEqual({
      anchorOffset: 4,
      anchorText: '0123',
      isCollapsed: true,
      size: 4,
      text: '0123',
    });
  });

  test('keeps the start of a paste after existing text', () => {
    using editor = buildEditorFromExtensions({name: 'trim-test'});
    expect(pasteWithMaxLength(editor, ['a'], [0, 1], '0123456789', 5)).toEqual({
      anchorOffset: 5,
      anchorText: 'a0123',
      isCollapsed: true,
      size: 5,
      text: 'a0123',
    });
  });

  test('trims a paste in the middle of the text just before the caret', () => {
    using editor = buildEditorFromExtensions({name: 'trim-test'});
    expect(
      pasteWithMaxLength(editor, ['Hello world'], [0, 5], 'XYZ', 13),
    ).toEqual({
      anchorOffset: 7,
      anchorText: 'HelloXY world',
      isCollapsed: true,
      size: 13,
      text: 'HelloXY world',
    });
  });

  test('trims a paste into the last of several paragraphs', () => {
    using editor = buildEditorFromExtensions({name: 'trim-test'});
    expect(
      pasteWithMaxLength(editor, ['abc', 'de'], [1, 2], '123456', 10),
    ).toEqual({
      anchorOffset: 5,
      anchorText: 'de123',
      isCollapsed: true,
      size: 10,
      text: 'abc\n\nde123',
    });
  });

  test('drops an emoji whole instead of splitting its surrogate pair', () => {
    using editor = buildEditorFromExtensions({name: 'trim-test'});
    expect(pasteWithMaxLength(editor, ['abc'], [0, 3], 'd💏', 5)).toEqual({
      anchorOffset: 4,
      anchorText: 'abcd',
      isCollapsed: true,
      size: 4,
      text: 'abcd',
    });
  });

  test('drops a multi code point grapheme whole', () => {
    using editor = buildEditorFromExtensions({name: 'trim-test'});
    expect(pasteWithMaxLength(editor, ['ab'], [0, 2], 'c👨‍💻', 6)).toEqual({
      anchorOffset: 3,
      anchorText: 'abc',
      isCollapsed: true,
      size: 3,
      text: 'abc',
    });
  });

  test('drops a flag emoji whole', () => {
    using editor = buildEditorFromExtensions({name: 'trim-test'});
    expect(pasteWithMaxLength(editor, ['ab'], [0, 2], 'c🇨🇦', 5)).toEqual({
      anchorOffset: 3,
      anchorText: 'abc',
      isCollapsed: true,
      size: 3,
      text: 'abc',
    });
  });

  test('drops a letter with a combining mark whole', () => {
    using editor = buildEditorFromExtensions({name: 'trim-test'});
    expect(pasteWithMaxLength(editor, ['ab'], [0, 2], 'ce\u0301', 4)).toEqual({
      anchorOffset: 3,
      anchorText: 'abc',
      isCollapsed: true,
      size: 3,
      text: 'abc',
    });
  });

  test('drops an emoji whole when the cut lands in an earlier node', () => {
    using editor = buildEditorFromExtensions({name: 'trim-test'});
    expect(pasteWithMaxLength(editor, ['ab💏', 'x'], [1, 1], 'yz', 3)).toEqual({
      anchorOffset: 2,
      anchorText: 'ab',
      isCollapsed: true,
      size: 2,
      text: 'ab',
    });
  });

  test('keeps surrogate pairs whole without Intl.Segmenter', () => {
    vi.stubGlobal('Intl', {...Intl, Segmenter: undefined});
    try {
      using editor = buildEditorFromExtensions({name: 'trim-test'});
      expect(pasteWithMaxLength(editor, ['abc'], [0, 3], 'd💏', 5)).toEqual({
        anchorOffset: 4,
        anchorText: 'abcd',
        isCollapsed: true,
        size: 4,
        text: 'abcd',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
