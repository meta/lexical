/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getTextPointCaret,
  $getTextPointCaretSlice,
  $splitTextPointCaretSlice,
  IS_BOLD,
} from 'lexical';
import {expect, test} from 'vitest';

test.each(['next', 'previous'] as const)('split a %s text slice', direction => {
  using editor = buildEditorFromExtensions({name: 'caret-selection-test'});
  editor.update(
    () => {
      const text = $createTextNode('abcde')
        .setFormat('bold')
        .setStyle('color: red;');
      const paragraph = $createParagraphNode().append(text);
      $getRoot().clear().append(paragraph);
      const caret = $getTextPointCaret(
        text,
        direction,
        direction === 'next' ? 1 : 4,
      );
      const slice = $getTextPointCaretSlice(
        caret,
        direction === 'next' ? 3 : -3,
      );
      const extracted = $splitTextPointCaretSlice(slice)!;
      expect(
        paragraph.getChildren().map(node => node.getTextContent()),
      ).toEqual(['a', 'bcd', 'e']);
      expect(extracted.getTextContent()).toBe('bcd');
      expect(extracted.getFormat()).toBe(IS_BOLD);
      expect(extracted.getStyle()).toBe('color: red;');
    },
    {discrete: true},
  );
});

test('empty and full text slices leave the node intact', () => {
  using editor = buildEditorFromExtensions({name: 'caret-selection-test'});
  editor.update(
    () => {
      const text = $createTextNode('abcde');
      const paragraph = $createParagraphNode().append(text);
      $getRoot().clear().append(paragraph);
      expect(
        $splitTextPointCaretSlice(
          $getTextPointCaretSlice($getTextPointCaret(text, 'next', 2), 0),
        ),
      ).toBeNull();
      expect(
        $splitTextPointCaretSlice(
          $getTextPointCaretSlice($getTextPointCaret(text, 'previous', 5), -5),
        ),
      ).toBe(text);
      expect(paragraph.getChildren()).toEqual([text]);
    },
    {discrete: true},
  );
});
