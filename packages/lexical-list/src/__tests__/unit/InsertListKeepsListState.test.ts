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
  $insertList,
  $isListNode,
  ListExtension,
  type ListNode,
} from '@lexical/list';
import {$createTextNode, $getRoot, defineExtension} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [ListExtension],
      name: 'insert-list-state-host',
    }),
  );
}

function $rootList(): ListNode {
  const node = $getRoot().getFirstChild();
  assert($isListNode(node), 'expected a ListNode at the root');
  return node;
}

describe('$insertList keeps the replaced list state', () => {
  test('converting a populated list keeps its direction, format and start', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        const list = $createListNode('number', 4)
          .setDirection('rtl')
          .setFormat('center')
          .setStyle('color: red;');
        list.append(
          $createListItemNode().append($createTextNode('a')),
          $createListItemNode().append($createTextNode('b')),
        );
        $getRoot().clear().append(list);
        list.getFirstChild()!.selectEnd();
      },
      {discrete: true},
    );

    editor.update(() => $insertList('bullet'), {discrete: true});

    editor.read(() => {
      const list = $rootList();
      expect(list.getListType()).toBe('bullet');
      expect(list.getDirection()).toBe('rtl');
      expect(list.getFormatType()).toBe('center');
      expect(list.getStyle()).toBe('color: red;');
      expect(list.getStart()).toBe(4);
      expect(list.getChildren().map(item => item.getTextContent())).toEqual([
        'a',
        'b',
      ]);
    });
  });

  test('converting from an empty list item keeps the list state', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        const list = $createListNode('bullet')
          .setDirection('rtl')
          .setFormat('right');
        list.append($createListItemNode());
        $getRoot().clear().append(list);
        list.getFirstChild()!.selectEnd();
      },
      {discrete: true},
    );

    editor.update(() => $insertList('number'), {discrete: true});

    editor.read(() => {
      const list = $rootList();
      expect(list.getListType()).toBe('number');
      expect(list.getDirection()).toBe('rtl');
      expect(list.getFormatType()).toBe('right');
    });
  });
});
