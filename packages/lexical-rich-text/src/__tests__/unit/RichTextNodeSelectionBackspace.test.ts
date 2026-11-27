/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
} from 'lexical';
import {
  $createTestDecoratorNode,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

function makeKey(key: 'Backspace' | 'Delete'): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key,
  });
}

function createEditor(inline: boolean) {
  return buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('before')),
        $createTestDecoratorNode().setIsInline(inline),
      );
    },
    dependencies: [RichTextExtension],
    name: 'test',
    nodes: [TestDecoratorNode],
  });
}

describe('KEY_BACKSPACE_COMMAND on a single-decorator NodeSelection', () => {
  // Regression for meta/lexical#8712: the early "target within decorator"
  // pass-through used to fire even when the active selection was a
  // NodeSelection on the decorator itself, so a click that selected a block
  // decorator followed by Backspace was a silent no-op. We now skip the
  // pass-through when the active selection is a NodeSelection.
  test('block decorator: deletes the node', () => {
    using editor = createEditor(false);

    editor.update(
      () => {
        const decorator = $getRoot().getLastChild()!;
        const selection = $createNodeSelection();
        selection.add(decorator.getKey());
        $setSelection(selection);
      },
      {discrete: true},
    );

    // Synthesize a target inside the decorator's DOM range — the
    // pass-through reads event.target.
    const decoratorKey = editor.getEditorState().read(() => {
      return $getRoot().getLastChild()!.getKey();
    });
    const decoratorDOM = editor.getElementByKey(decoratorKey)!;
    const event = makeKey('Backspace');
    Object.defineProperty(event, 'target', {value: decoratorDOM});

    const handled = editor.dispatchCommand(KEY_BACKSPACE_COMMAND, event);
    expect(handled).toBe(true);

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(1);
      expect(root.getChildren()[0]).not.toBeInstanceOf(TestDecoratorNode);
      const selection = $getSelection();
      // Selection collapses to a RangeSelection at the sibling.
      expect($isRangeSelection(selection)).toBe(true);
    });
  });
});

describe('KEY_DELETE_COMMAND on a single-decorator NodeSelection', () => {
  // Symmetric to the KEY_BACKSPACE_COMMAND fix above. The same pass-through
  // gap existed for forward-Delete and is closed by the same NodeSelection
  // guard.
  test('block decorator: deletes the node', () => {
    using editor = createEditor(false);

    editor.update(
      () => {
        const decorator = $getRoot().getLastChild()!;
        const selection = $createNodeSelection();
        selection.add(decorator.getKey());
        $setSelection(selection);
      },
      {discrete: true},
    );

    const decoratorKey = editor.getEditorState().read(() => {
      return $getRoot().getLastChild()!.getKey();
    });
    const decoratorDOM = editor.getElementByKey(decoratorKey)!;
    const event = makeKey('Delete');
    Object.defineProperty(event, 'target', {value: decoratorDOM});

    const handled = editor.dispatchCommand(KEY_DELETE_COMMAND, event);
    expect(handled).toBe(true);

    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(1);
      expect(root.getChildren()[0]).not.toBeInstanceOf(TestDecoratorNode);
    });
  });
});
