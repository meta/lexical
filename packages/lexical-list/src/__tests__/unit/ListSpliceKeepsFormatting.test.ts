/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$createLinkNode, $isLinkNode, LinkExtension} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListExtension,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [ListExtension, LinkExtension],
      name: 'list-splice-host',
    }),
  );
}

function $splicedItemChildren() {
  const list = $getRoot().getFirstChild();
  assert($isListNode(list), 'expected a ListNode at the root');
  const item = list.getChildAtIndex(1);
  assert($isListItemNode(item), 'expected a ListItemNode');
  return item.getChildren();
}

describe('ListNode.splice converting a block into a list item', () => {
  test('keeps the text formats of the block it unwraps', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        const list = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('A')),
          $createListItemNode().append($createTextNode('C')),
        );
        $getRoot().clear().append(list);

        const paragraph = $createParagraphNode();
        paragraph.append(
          $createTextNode('bold').toggleFormat('bold'),
          $createTextNode('styled').setStyle('color: red;'),
        );
        list.splice(1, 0, [paragraph]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $splicedItemChildren();
      expect(children.map(n => n.getTextContent())).toEqual(['bold', 'styled']);
      assert($isTextNode(children[0]), 'expected a TextNode');
      assert($isTextNode(children[1]), 'expected a TextNode');
      expect(children[0].hasFormat('bold')).toBe(true);
      expect(children[1].getStyle()).toBe('color: red;');
    });
  });

  test('keeps an inline node of the block it unwraps', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        const list = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('A')),
          $createListItemNode().append($createTextNode('C')),
        );
        $getRoot().clear().append(list);

        const paragraph = $createParagraphNode();
        paragraph.append(
          $createLinkNode('https://lexical.dev/').append(
            $createTextNode('link'),
          ),
        );
        list.splice(1, 0, [paragraph]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $splicedItemChildren();
      expect(children).toHaveLength(1);
      assert($isLinkNode(children[0]), 'expected the LinkNode to survive');
      expect(children[0].getURL()).toBe('https://lexical.dev/');
      expect(children[0].getTextContent()).toBe('link');
    });
  });
});
