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
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
} from 'lexical';
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

describe('ListItemNode exportDOM', () => {
  test('writes value before the theme classes, as before', () => {
    const editor = createEditor({
      nodes: [ListNode, ListItemNode],
      onError: e => {
        throw e;
      },
      theme: {list: {listitem: 'item', olDepth: ['ol1']}},
    });
    editor.setRootElement(document.createElement('div'));
    editor.update(
      () => {
        $getRoot().append($createListNode('number').append($item('a')));
      },
      {discrete: true},
    );
    const html = editor.read(
      () =>
        (
          ($getRoot().getFirstChildOrThrow() as ListNode)
            .getFirstChildOrThrow()
            .exportDOM(editor).element as HTMLElement
        ).outerHTML,
    );
    expect(html).toBe('<li value="1" class="item"></li>');
  });

  test('every exported item keeps its value, in the same place, in every list type', () => {
    const editor = createEditor({
      nodes: [ListNode, ListItemNode],
      onError: e => {
        throw e;
      },
      theme: {list: {listitem: 'item', nested: {listitem: 'holder'}}},
    });
    editor.setRootElement(document.createElement('div'));
    editor.update(
      () => {
        $getRoot().append(
          $createListNode('number').append(
            $item('a'),
            $createListItemNode().append(
              $createListNode('number').append($item('x')),
            ),
            $item('b'),
          ),
          $createListNode('bullet').append($item('c'), $item('d')),
          $createListNode('check').append($item('e'), $item('f')),
        );
      },
      {discrete: true},
    );
    const exported = editor.read(() =>
      $getRoot()
        .getChildren()
        .flatMap(list => (list as ListNode).getChildren())
        .map(item => {
          const element = (item as ListItemNode).exportDOM(editor)
            .element as HTMLElement;
          return Array.from(element.attributes)
            .map(a => a.name)
            .filter(n => n === 'value' || n === 'class')
            .join(',');
        }),
    );
    // As before: `value` first on every item, then the theme classes.
    expect(exported).toEqual(Array(7).fill('value,class'));
  });

  test('a live item whose number the browser draws reads li.value 0', () => {
    const editor = createEditor({
      nodes: [ListNode, ListItemNode],
      onError: e => {
        throw e;
      },
    });
    const root = document.createElement('div');
    editor.setRootElement(root);
    editor.update(
      () => {
        $getRoot().append(
          $createListNode('number').append($item('a'), $item('b')),
        );
      },
      {discrete: true},
    );
    // The documented change: read the number with getValue() or exportDOM.
    expect(
      Array.from(root.querySelectorAll('li')).map(
        li => (li as HTMLLIElement).value,
      ),
    ).toEqual([0, 0]);
  });

  test('an item after a non-item child writes its value', () => {
    // Only reachable with the list transforms skipped (a remote apply): the
    // browser does not count the stray child, so the item says its number.
    const editor = createEditor({
      nodes: [ListNode, ListItemNode],
      onError: e => {
        throw e;
      },
    });
    const root = document.createElement('div');
    editor.setRootElement(root);
    editor.update(
      () => {
        $getRoot().append(
          $createListNode('number').append($item('a'), $item('b'), $item('c')),
        );
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const list = $getRoot().getFirstChildOrThrow() as ListNode;
        list
          .getChildAtIndex(1)!
          .insertBefore($createParagraphNode().append($createTextNode('x')));
      },
      {discrete: true, skipTransforms: true},
    );
    expect(valueAttributes(root)).toEqual([null, '2', null]);
  });
});
