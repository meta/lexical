/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
  registerList,
} from '@lexical/list';
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  createEditor,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';

test('replacing a list item preserves a caret inside its text', () => {
  const editor = createEditor({
    nodes: [ListNode, ListItemNode],
    onError(error) {
      throw error;
    },
  });
  onTestFinished(registerList(editor));
  let original: ListItemNode;
  let replacement: ListItemNode;
  let textKey: string;
  editor.update(
    () => {
      const text = $createTextNode('original');
      textKey = text.getKey();
      original = $createListItemNode().append(text);
      $getRoot().append($createListNode('bullet').append(original));
      text.select(2, 2);
    },
    {discrete: true},
  );
  expect(() =>
    editor.update(
      () => {
        replacement = $createListItemNode();
        expect(original.replace(replacement, true)).toBe(replacement);
      },
      {discrete: true},
    ),
  ).not.toThrow();
  editor.read(() => {
    const list = $getRoot().getFirstChildOrThrow();
    assert($isListNode(list));
    const item = list.getFirstChildOrThrow();
    assert($isListItemNode(item));
    expect(item.is(replacement)).toBe(true);
    expect(original.isAttached()).toBe(false);
    expect(item.getChildren().map(node => node.getKey())).toEqual([textKey]);
    expect(item.getTextContent()).toBe('original');
    const selection = $getSelection();
    assert($isRangeSelection(selection));
    expect(selection.anchor.key).toBe(textKey);
    expect(selection.anchor.offset).toBe(2);
    expect(selection.anchor.type).toBe('text');
    expect(selection.isCollapsed()).toBe(true);
  });
});

for (const includeChildren of [true, false, undefined]) {
  test(`replacing a list item respects includeChildren=${includeChildren}`, () => {
    const editor = createEditor({
      nodes: [ListNode, ListItemNode],
      onError(error) {
        throw error;
      },
    });
    onTestFinished(registerList(editor));
    let original: ListItemNode;
    let replacement: ListItemNode;
    let textKey: string;
    let nestedKey: string;
    editor.update(
      () => {
        const text = $createTextNode('original').toggleFormat('bold');
        const nested = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('nested')),
        );
        textKey = text.getKey();
        nestedKey = nested.getKey();
        original = $createListItemNode().append(text, nested);
        $getRoot().append($createListNode('bullet').append(original));
      },
      {discrete: true},
    );
    editor.update(
      () => {
        original.select(1, 1);
        replacement = $createListItemNode().append($createTextNode('prefix'));
        expect(original.replace(replacement, includeChildren)).toBe(
          replacement,
        );
      },
      {discrete: true},
    );
    editor.read(() => {
      const list = $getRoot().getFirstChildOrThrow();
      assert($isListNode(list));
      const item = list.getFirstChildOrThrow();
      assert($isListItemNode(item));
      expect(item.is(replacement)).toBe(true);
      expect(original.isAttached()).toBe(false);
      if (includeChildren) {
        expect(item.getChildren().map(node => node.getKey())).toEqual([
          item.getFirstChildOrThrow().getKey(),
          textKey,
          nestedKey,
        ]);
        expect(item.getChildAtIndex(1)?.getTextContent()).toBe('original');
        expect(item.getChildAtIndex(2)?.getTextContent()).toBe('nested');
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(selection.anchor.key).toBe(item.getKey());
        expect(selection.anchor.offset).toBe(2);
        expect(selection.anchor.type).toBe('element');
        expect(selection.isCollapsed()).toBe(true);
      } else {
        expect(item.getTextContent()).toBe('prefix');
        expect(item.getChildrenSize()).toBe(1);
      }
    });
  });
}
