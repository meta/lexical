/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createNodeSelection,
  $getRoot,
  $getSelection,
  $isNodeSelection,
  $isParagraphNode,
  $isRangeSelection,
  $setSelection,
  KEY_ENTER_COMMAND,
  ParagraphNode,
} from 'lexical';
import {
  $createTestDecoratorNode,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test} from 'vitest';

function createEditor(inline: boolean) {
  return buildEditorFromExtensions({
    $initialEditorState: () => {
      const decorator = $createTestDecoratorNode().setIsInline(inline);
      $getRoot().append(decorator);
      const selection = $createNodeSelection();
      selection.add(decorator.getKey());
      $setSelection(selection);
    },
    dependencies: [RichTextExtension],
    name: 'test',
    nodes: [TestDecoratorNode],
  });
}

describe('KEY_ENTER_COMMAND on a single-decorator NodeSelection', () => {
  test('block decorator: inserts a paragraph after it and moves the caret', () => {
    using editor = createEditor(false);

    editor.dispatchCommand(KEY_ENTER_COMMAND, null);

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(2);
      const children = root.getChildren();
      expect(children[0]).toBeInstanceOf(TestDecoratorNode);
      expect(children[1]).toBeInstanceOf(ParagraphNode);
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect(selection.anchor.key).toBe(children[1].getKey());
    });
  });

  test('inline decorator: no-op', () => {
    using editor = createEditor(true);

    editor.dispatchCommand(KEY_ENTER_COMMAND, null);

    editor.read(() => {
      const root = $getRoot();
      // inline nodes are wrapped
      const children = root.getChildren();
      expect(children).toHaveLength(1);
      assert(children.every($isParagraphNode));
      const paragraphChildren = children[0].getChildren();
      expect(paragraphChildren).toHaveLength(1);
      expect(paragraphChildren[0]).toBeInstanceOf(TestDecoratorNode);
      const selection = $getSelection();
      assert($isNodeSelection(selection));
    });
  });
});
