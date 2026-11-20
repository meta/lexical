/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createListItemNode,
  $createListNode,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {$createTextNode, $getRoot} from 'lexical';
import {initializeUnitTest} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

function $item(text: string): ListItemNode {
  return $createListItemNode().append($createTextNode(text));
}

function valueAttributes(root: HTMLElement): (string | null)[] {
  return Array.from(root.querySelectorAll('li')).map(li =>
    li.getAttribute('value'),
  );
}

describe('ListItemNode value attribute', () => {
  initializeUnitTest(testEnv => {
    test('a number list writes no value where the browser count matches', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        $getRoot().append(
          $createListNode('number').append($item('a'), $item('b'), $item('c')),
        );
      });
      expect(valueAttributes(editor.getRootElement()!)).toEqual([
        null,
        null,
        null,
      ]);
    });

    test('a list with a start relies on <ol start>', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        $getRoot().append(
          $createListNode('number', 4).append($item('a'), $item('b')),
        );
      });
      const root = editor.getRootElement()!;
      expect(root.querySelector('ol')!.getAttribute('start')).toBe('4');
      expect(valueAttributes(root)).toEqual([null, null]);
    });

    test('inserting an item at the top writes no value on any item', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        $getRoot().append(
          $createListNode('number').append($item('a'), $item('b'), $item('c')),
        );
      });
      await editor.update(() => {
        const list = $getRoot().getFirstChildOrThrow() as ListNode;
        list.getFirstChildOrThrow().insertBefore($item('top'));
      });
      expect(valueAttributes(editor.getRootElement()!)).toEqual([
        null,
        null,
        null,
        null,
      ]);
    });

    test('the item after a nested list keeps its number', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const nested = $createListItemNode().append(
          $createListNode('number').append($item('x'), $item('y')),
        );
        $getRoot().append(
          $createListNode('number').append(
            $item('a'),
            $item('b'),
            nested,
            $item('c'),
          ),
        );
      });
      // a, b, (nested: x, y), c: the browser counts the nested list's item, so
      // only "c" carries a value, the 3 Lexical numbers it with.
      expect(valueAttributes(editor.getRootElement()!)).toEqual([
        null,
        null,
        null,
        null,
        null,
        '3',
      ]);
    });

    test('removing the nested list clears the value it needed', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const nested = $createListItemNode().append(
          $createListNode('number').append($item('x')),
        );
        $getRoot().append(
          $createListNode('number').append($item('a'), nested, $item('b')),
        );
      });
      await editor.update(() => {
        const list = $getRoot().getFirstChildOrThrow() as ListNode;
        list.getChildAtIndex(1)!.remove();
      });
      expect(valueAttributes(editor.getRootElement()!)).toEqual([null, null]);
    });

    test('bullet and check items never carry a value', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        $getRoot().append(
          $createListNode('bullet').append($item('a'), $item('b')),
          $createListNode('check').append($item('c'), $item('d')),
        );
      });
      expect(valueAttributes(editor.getRootElement()!)).toEqual([
        null,
        null,
        null,
        null,
      ]);
    });

    test('exportDOM keeps every item value', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        $getRoot().append(
          $createListNode('number').append($item('a'), $item('b'), $item('c')),
        );
      });
      const values = editor.read(() =>
        ($getRoot().getFirstChildOrThrow() as ListNode)
          .getChildren()
          .map(li => (li.exportDOM(editor).element as HTMLLIElement).value),
      );
      expect(values).toEqual([1, 2, 3]);
    });
  });
});
