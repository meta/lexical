/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {$createLinkNode, $isLinkNode, LinkNode} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  $isTextNode,
  $setSelection,
} from 'lexical';
import {expect, test} from 'vitest';

import {$assertNodeType} from '../utils';

const testExtension = defineExtension({
  dependencies: [RichTextExtension],
  name: 'insert-paragraph-endpoint-repair',
  nodes: [LinkNode],
});

test.each([false, true])(
  'insertParagraph over a range from an empty paragraph into styled text (backward=%s)',
  backward => {
    using editor = buildEditorFromExtensions(testExtension);
    editor.update(
      () => {
        const empty = $createParagraphNode();
        const text = $createTextNode('ead').setStyle('color: red');
        $getRoot()
          .clear()
          .append(
            empty,
            $createParagraphNode().append(
              text,
              $createLinkNode('https://example.com').append(
                $createTextNode('caa'),
              ),
            ),
          );
        const selection = $createRangeSelection();
        const [start, end] = backward
          ? [selection.focus, selection.anchor]
          : [selection.anchor, selection.focus];
        start.set(empty.getKey(), 0, 'element');
        end.set(text.getKey(), 2, 'text');
        $setSelection(selection);
        selection.insertParagraph();
      },
      {discrete: true},
    );
    editor.read('latest', () => {
      const root = $getRoot();
      expect(root.getTextContent()).toBe('\n\ndcaa');
      expect(root.getChildrenSize()).toBe(2);
      expect(root.getFirstChildOrThrow().getTextContent()).toBe('');
      const paragraph = $assertNodeType(
        root.getLastChildOrThrow(),
        $isParagraphNode,
      );
      expect(paragraph.getChildrenSize()).toBe(2);
      const remainingText = $assertNodeType(
        paragraph.getFirstChildOrThrow(),
        $isTextNode,
      );
      expect(remainingText.getTextContent()).toBe('d');
      expect(remainingText.getStyle()).toBe('color: red');
      const link = $assertNodeType(
        paragraph.getLastChildOrThrow(),
        $isLinkNode,
      );
      expect(link.getURL()).toBe('https://example.com');
      expect(link.getTextContent()).toBe('caa');
    });
  },
);
