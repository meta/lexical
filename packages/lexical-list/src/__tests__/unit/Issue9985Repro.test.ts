/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$createLinkNode, LinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {$createTextNode, $getRoot, $isTextNode, createEditor} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

describe('ListItemNode $transform repairs an orphan inside a link', () => {
  test('when the link is the only child of the first list item', () => {
    const editor = createEditor({
      nodes: [ListNode, ListItemNode, LinkNode],
      onError: error => {
        throw error;
      },
    });
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createListNode('bullet').append(
              $createListItemNode().append(
                $createLinkNode('https://lexical.dev').append(
                  $createListItemNode().append($createTextNode('item')),
                ),
              ),
            ),
          );
      },
      {discrete: true},
    );
    editor.read(() => {
      const root = $getRoot();
      expect(root.getChildrenSize()).toBe(1);
      const list = root.getFirstChild();
      assert($isListNode(list));
      expect(list.getChildrenSize()).toBe(1);
      const listItem = list.getFirstChild();
      assert($isListItemNode(listItem));
      expect(listItem.getChildrenSize()).toBe(1);
      const text = listItem.getFirstChild();
      assert($isTextNode(text));
      expect(text.getTextContent()).toBe('item');
    });
  });
});
