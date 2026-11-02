/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {AutoLinkExtension, autoLinkUrlMatcher} from '@lexical/link';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $setSelection,
  configExtension,
  TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

test.each([1, 2])(
  'wrapping a URL preserves a paragraph caret at child offset %i beside a line break',
  offset => {
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        configExtension(AutoLinkExtension, {
          matchers: [autoLinkUrlMatcher],
        }),
      ],
      name: '[autolink element caret]',
    });
    editor.update(
      () => {
        const paragraph = $createParagraphNode().append(
          $createTextNode('https://a.'),
          $createLineBreakNode(),
        );
        $getRoot().append(paragraph);
        const selection = $createRangeSelection();
        selection.anchor.set(paragraph.getKey(), offset, 'element');
        selection.focus.set(paragraph.getKey(), offset, 'element');
        $setSelection(selection);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        if ($isElementNode(paragraph)) {
          // An application completes the URL while the caret is at the
          // adjacent line-break boundary. The transform must not move it.
          const text = paragraph.getFirstChildOrThrow();
          if (text instanceof TextNode) {
            text.setTextContent('https://a.co');
          }
        }
      },
      {discrete: true},
    );
    editor.read(() => {
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if ($isRangeSelection(selection)) {
        const paragraph = $getRoot().getFirstChildOrThrow();
        expect($isElementNode(paragraph)).toBe(true);
        if ($isElementNode(paragraph)) {
          expect(paragraph.getChildren().map(node => node.getType())).toEqual([
            'autolink',
            'linebreak',
          ]);
        }
        expect(selection.anchor.key).toBe(paragraph.getKey());
        expect(selection.anchor.type).toBe('element');
        expect(selection.anchor.offset).toBe(offset);
        expect(selection.focus.offset).toBe(offset);
      }
    });
  },
);
