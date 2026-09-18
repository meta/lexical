/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListExtension,
  type ListNode,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [ListExtension],
      name: 'issue-7032-host',
    }),
  );
}

function $listAt(index: number): ListNode {
  const node: LexicalNode | null = $getRoot().getChildAtIndex(index);
  assert($isListNode(node), `expected a ListNode at root index ${index}`);
  return node;
}

function $itemValues(list: ListNode): number[] {
  return list
    .getChildren()
    .filter($isListItemNode)
    .map(item => item.getValue());
}

describe('Issue #7032: splitting a numbered list restarts its numbering', () => {
  test('inserting a block between list items continues the numbering', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        const list = $createListNode('number');
        for (const text of ['a', 'b', 'c']) {
          list.append($createListItemNode().append($createTextNode(text)));
        }
        $getRoot().clear().append(list);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const first = $listAt(0).getFirstChild();
        assert($isListItemNode(first), 'expected a ListItemNode');
        // Inserting a non-list node between two items splits the list around
        // it — the page-break case from issue #7032.
        first.insertAfter(
          $createParagraphNode().append($createTextNode('break')),
        );
      },
      {discrete: true},
    );

    editor.read(() => {
      expect(
        $getRoot()
          .getChildren()
          .map(n => n.getType()),
      ).toEqual(['list', 'paragraph', 'list']);
      expect($itemValues($listAt(0))).toEqual([1]);
      const tail = $listAt(2);
      expect(tail.getStart()).toBe(2);
      expect($itemValues(tail)).toEqual([2, 3]);
    });
  });

  test('a list that does not start at 1 continues from the split point', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        const list = $createListNode('number', 5);
        for (const text of ['a', 'b', 'c']) {
          list.append($createListItemNode().append($createTextNode(text)));
        }
        $getRoot().clear().append(list);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const items = $listAt(0).getChildren();
        const second = items[1];
        assert($isListItemNode(second), 'expected a ListItemNode');
        second.insertAfter(
          $createParagraphNode().append($createTextNode('break')),
        );
      },
      {discrete: true},
    );

    editor.read(() => {
      expect($itemValues($listAt(0))).toEqual([5, 6]);
      expect($listAt(2).getStart()).toBe(7);
      expect($itemValues($listAt(2))).toEqual([7]);
    });
  });

  test('a bullet list keeps its start when it is split', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        const list = $createListNode('bullet');
        for (const text of ['a', 'b']) {
          list.append($createListItemNode().append($createTextNode(text)));
        }
        $getRoot().clear().append(list);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const first = $listAt(0).getFirstChild();
        assert($isListItemNode(first), 'expected a ListItemNode');
        first.insertAfter(
          $createParagraphNode().append($createTextNode('break')),
        );
      },
      {discrete: true},
    );

    editor.read(() => {
      expect($listAt(2).getStart()).toBe(1);
    });
  });
});
