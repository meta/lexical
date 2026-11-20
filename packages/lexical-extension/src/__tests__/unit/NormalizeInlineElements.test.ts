/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  buildEditorFromExtensions,
  NormalizeInlineElementsExtension,
} from '@lexical/extension';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  configExtension,
} from 'lexical';
import {TestInlineElementNode} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test} from 'vitest';

describe('NormalizeInlineElements', () => {
  test('should remove empty inline elements by default', async () => {
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        paragraph.append(
          $create(TestInlineElementNode),
          $create(TestInlineElementNode),
        );
      },
      dependencies: [configExtension(NormalizeInlineElementsExtension)],
      name: 'test',
      nodes: [TestInlineElementNode],
    });

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = root.getFirstChild();
      assert($isParagraphNode(paragraph));

      // An empty inline element cannot be inserted
      expect(paragraph.isEmpty()).toBe(true);

      // try to create non-empty and edit it to empty later
      paragraph.append(
        $create(TestInlineElementNode).append($createTextNode('foo')),
      );
    });

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = root.getFirstChild();
      assert($isParagraphNode(paragraph));
      const inlineNode = paragraph.getFirstChild();
      assert(inlineNode instanceof TestInlineElementNode);

      inlineNode.getFirstChildOrThrow().remove();
    });

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = root.getFirstChild();
      assert($isParagraphNode(paragraph));

      expect(paragraph.isEmpty()).toBe(true);
    });
  });

  test('should not to remove empty inline elements if extension is disabled', async () => {
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        const root = $getRoot();
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        paragraph.append(
          $create(TestInlineElementNode),
          $create(TestInlineElementNode),
        );
      },
      dependencies: [
        configExtension(NormalizeInlineElementsExtension, {disabled: true}),
      ],
      name: 'test',
      nodes: [TestInlineElementNode],
    });

    await editor.update(() => {
      const root = $getRoot();
      const paragraph = root.getFirstChild();
      assert($isParagraphNode(paragraph));

      expect(paragraph.getChildrenSize()).toBe(2);
      expect(paragraph.getFirstChildOrThrow()).toBeInstanceOf(
        TestInlineElementNode,
      );
      expect(paragraph.getLastChildOrThrow()).toBeInstanceOf(
        TestInlineElementNode,
      );
    });
  });
});
