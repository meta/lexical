/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {PlainTextExtension} from '@lexical/plain-text';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

const samples = [
  {
    backspaceCount: 3,
    description: 'grapheme cluster',
    grapheme: '각',
  },
  {
    backspaceCount: 2,
    description: 'extended grapheme cluster',
    grapheme: 'நி',
  },
  {
    backspaceCount: 4,
    description: 'tailored grapheme cluster',
    grapheme: 'क्षि',
  },
  {
    backspaceCount: 1,
    description: 'Emoji sequence combined using zero-width joiners',
    grapheme: '👩‍👩‍👧‍👦',
  },
  {
    backspaceCount: 1,
    description: 'Emoji sequence with skin-tone modifier',
    grapheme: '👏🏽',
  },
  {
    backspaceCount: 2,
    description: 'Arabic text with accent',
    grapheme: 'هَ',
  },
  {
    backspaceCount: 2,
    description: 'Latin with decomposed combining character',
    grapheme: 'ñ',
  },
  {
    backspaceCount: 1,
    description:
      'Multiple codepoint Emoji with variation selector entirely in the BMP',
    grapheme: '❤️',
  },
  {
    backspaceCount: 1,
    description: 'Multiple codepoint keycap Emoji',
    grapheme: '#️⃣',
  },
  {
    backspaceCount: 8,
    description: 'Hindi',
    grapheme: 'अनुच्छेद',
  },
  {
    backspaceCount: 4,
    description: 'Korean',
    grapheme: '뎌쉐',
  },
  {
    backspaceCount: 5,
    description: 'Emojis outside the BMP',
    grapheme: '🌷🎁💩😜👍',
  },
  {
    backspaceCount: 1,
    description:
      'ZWJ emoji cluster with variation selection that looks like 4 characters but treated as one',
    grapheme: '👩🏽‍👨🏽‍👶🏽‍👦🏽',
  },
  {
    backspaceCount: 1,
    description: 'Flag emoji with ZWJ and variation selector',
    grapheme: '🏳️‍🌈',
  },
  {
    backspaceCount: 1,
    description: 'Chinese for seaborgium (surrogate pair)',
    grapheme: '𨭎',
  },
];

// Regression #7163: preserve the line before the grapheme and collapse both
// selections at the empty line after the expected number of native Backspaces.
describe.each([false, true])(
  'grapheme deletion (plain text: %s)',
  isPlainText => {
    test.each(samples)(
      '$description',
      async ({backspaceCount, description, grapheme}) => {
        const root = document.createElement('div');
        root.contentEditable = 'true';
        root.style.whiteSpace = 'pre-wrap';
        document.body.append(root);
        const editor = buildEditorFromExtensions(
          isPlainText ? PlainTextExtension : RichTextExtension,
        );
        editor.setRootElement(root);
        onTestFinished(() => {
          editor.dispose();
          root.remove();
          window.getSelection()?.removeAllRanges();
        });
        editor.update(
          () => {
            const paragraph = $createParagraphNode().append(
              $createTextNode(description),
            );
            const text = $createTextNode(grapheme);
            $getRoot().clear().append(paragraph);
            if (isPlainText) {
              paragraph.append($createLineBreakNode(), text);
            } else {
              $getRoot().append($createParagraphNode().append(text));
            }
            text.selectEnd();
          },
          {discrete: true},
        );
        window.focus();
        root.focus();
        const paragraph = isPlainText
          ? root.firstElementChild!
          : root.lastElementChild!;
        const graphemeDOM = paragraph.lastChild!.firstChild!;
        const native = window.getSelection()!;
        await expect
          .poll(() => [
            native.anchorNode,
            native.anchorOffset,
            native.focusNode,
            native.focusOffset,
          ])
          .toEqual([
            graphemeDOM,
            grapheme.length,
            graphemeDOM,
            grapheme.length,
          ]);
        expect(graphemeDOM.textContent).toBe(grapheme);

        await userEvent.keyboard('{Backspace}'.repeat(backspaceCount));

        const offset = isPlainText ? 2 : 0;
        await expect
          .poll(() => [
            native.anchorNode,
            native.anchorOffset,
            native.focusNode,
            native.focusOffset,
          ])
          .toEqual([paragraph, offset, paragraph, offset]);
        const expectedHTML = isPlainText
          ? `<p dir="auto"><span data-lexical-text="true">${description}</span><br><br data-lexical-managed-linebreak="true"></p>`
          : `<p dir="auto"><span data-lexical-text="true">${description}</span></p><p dir="auto"><br data-lexical-managed-linebreak="true"></p>`;
        expect(root.innerHTML).toBe(expectedHTML);
        editor.read(() => {
          expect($getRoot().getChildrenSize()).toBe(isPlainText ? 1 : 2);
          const texts = $getRoot().getAllTextNodes();
          expect(texts.map(text => text.getTextContent())).toEqual([
            description,
          ]);
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          expect(selection.isCollapsed()).toBe(true);
          expect(selection.anchor.type).toBe('element');
          expect(selection.anchor.offset).toBe(offset);
          expect(selection.anchor.key).toBe(
            $getRoot().getLastChildOrThrow().getKey(),
          );
        });
      },
    );
  },
);
