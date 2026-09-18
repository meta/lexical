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
  $selectAll,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$assertNodeType, initializeUnitTest} from '../utils';

const EMPTY_ATTRIBUTES_HTML =
  '<p dir="auto"><span data-lexical-text="true">abc</span></p>';

function $getParagraph(): ElementNode {
  return $assertNodeType($getRoot().getFirstChild(), $isElementNode);
}

function $getText(): TextNode {
  return $assertNodeType($getParagraph().getFirstChild(), $isTextNode);
}

// Regression tests for #5307. `classList.remove()` and
// `style.setProperty(prop, '')` leave the attribute behind with an empty
// value, so clearing the last theme class / inline declaration used to render
// `<span class="">` and `<p style="">`.
describe('Issue 5307: empty style attribute', () => {
  initializeUnitTest(testEnv => {
    test('clearing an element format removes the style attribute', () => {
      const {editor} = testEnv;
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('abc')));
        },
        {discrete: true},
      );
      editor.update(() => $getParagraph().setFormat('center'), {
        discrete: true,
      });
      expect(testEnv.innerHTML).toBe(
        '<p dir="auto" style="text-align: center;">' +
          '<span data-lexical-text="true">abc</span></p>',
      );

      editor.update(() => $getParagraph().setFormat(''), {discrete: true});
      expect(testEnv.innerHTML).toBe(EMPTY_ATTRIBUTES_HTML);
    });

    test('clearing an element indent removes the style attribute', () => {
      const {editor} = testEnv;
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('abc')));
        },
        {discrete: true},
      );
      editor.update(() => $getParagraph().setIndent(1), {discrete: true});
      expect(testEnv.innerHTML).toContain('padding-inline-start');

      editor.update(() => $getParagraph().setIndent(0), {discrete: true});
      expect(testEnv.innerHTML).toBe(EMPTY_ATTRIBUTES_HTML);
    });

    test('clearing a text style removes the style attribute', () => {
      const {editor} = testEnv;
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('abc')));
        },
        {discrete: true},
      );
      editor.update(() => $getText().setStyle('color: red'), {discrete: true});
      expect(testEnv.innerHTML).toContain('color: red');

      editor.update(() => $getText().setStyle(''), {discrete: true});
      expect(testEnv.innerHTML).toBe(EMPTY_ATTRIBUTES_HTML);
    });
  });
});

describe('Issue 5307: empty class attribute', () => {
  initializeUnitTest(
    testEnv => {
      test('clearing the last text format removes the class attribute', () => {
        const {editor} = testEnv;
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append($createParagraphNode().append($createTextNode('abc')));
            $selectAll();
          },
          {discrete: true},
        );
        editor.update(
          () => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.formatText('underline');
            }
          },
          {discrete: true},
        );
        expect(testEnv.innerHTML).toBe(
          '<p dir="auto">' +
            '<span data-lexical-text="true" class="my-underline">abc</span></p>',
        );

        editor.update(
          () => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.formatText('underline');
            }
          },
          {discrete: true},
        );
        expect(testEnv.innerHTML).toBe(EMPTY_ATTRIBUTES_HTML);
      });
    },
    {namespace: 'test', theme: {text: {underline: 'my-underline'}}},
  );
});
