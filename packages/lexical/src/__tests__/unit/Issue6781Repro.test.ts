/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {IS_BOLD, IS_ITALIC} from '../../LexicalConstants';
import {$assertNodeType, initializeUnitTest} from '../utils';

describe('Backspacing an empty block updates the pending format (#6781)', () => {
  initializeUnitTest(testEnv => {
    test('merging into the previous block adopts that block text format and style', async () => {
      const {editor} = testEnv;
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          const text = $createTextNode('hello');
          text.setFormat(IS_BOLD);
          text.setStyle('color: red');
          paragraph.append(text);
          // The empty paragraph the caret sits in carries its own pending
          // format and style, as it would after the toolbar is used on an
          // empty line.
          const emptyParagraph = $createParagraphNode();
          emptyParagraph.setTextFormat(IS_ITALIC);
          emptyParagraph.setTextStyle('color: blue');
          $getRoot().clear().append(paragraph, emptyParagraph);
          const selection = emptyParagraph.select(0, 0);
          selection.setFormat(IS_ITALIC);
          selection.setStyle('color: blue');
        },
        {discrete: true},
      );

      editor.update(
        () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection), 'Expected RangeSelection');
          selection.deleteCharacter(true);
        },
        {discrete: true},
      );

      editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        expect(selection.format).toBe(IS_BOLD);
        expect(selection.style).toBe('color: red');
      });

      editor.update(
        () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection), 'Expected RangeSelection');
          selection.insertText('X');
        },
        {discrete: true},
      );

      editor.read(() => {
        const root = $getRoot();
        expect(root.getTextContent()).toBe('helloX');
        const text = $assertNodeType(root.getLastDescendant(), $isTextNode);
        expect(text.getFormat()).toBe(IS_BOLD);
        expect(text.getStyle()).toBe('color: red');
        // The inserted text merges into the existing node rather than
        // starting a differently styled one.
        const paragraph = $assertNodeType(root.getFirstChild(), $isElementNode);
        expect(paragraph.getChildrenSize()).toBe(1);
      });
    });

    test('backspacing inside a block leaves the pending format alone', async () => {
      const {editor} = testEnv;
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          const text = $createTextNode('hello');
          text.setFormat(IS_BOLD);
          text.setStyle('color: red');
          paragraph.append(text);
          $getRoot().clear().append(paragraph);
          const selection = text.select(5, 5);
          selection.setFormat(IS_ITALIC);
          selection.setStyle('color: blue');
        },
        {discrete: true},
      );

      editor.update(
        () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection), 'Expected RangeSelection');
          selection.deleteCharacter(true);
        },
        {discrete: true},
      );

      editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        // The caret never left the text node, so the format the user chose
        // for the next keystroke is preserved.
        expect(selection.format).toBe(IS_ITALIC);
        expect(selection.style).toBe('color: blue');
      });
    });
  });
});
