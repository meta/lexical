/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $getTaskListItemChecked,
  $isListItemNode,
  $isListNode,
  $setTaskListItemChecked,
  CheckListExtension,
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  type ListType,
} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {$createTextNode, $getRoot} from 'lexical';
import {invariant} from 'lexical/src/__tests__/utils';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// GFM decides per item whether a list item is a task, so a bullet or number
// list can hold task items next to plain ones (`- plain` / `- [x] done`).
// $setTaskListItemChecked makes an item of such a list a task; a check list
// makes every item one, as before.
describe('task items in bullet and number lists', () => {
  // jsdom has no layout for ::before, which the click hit-test measures (see
  // checkList.test.tsx).
  const originalGetComputedStyle = window.getComputedStyle;
  beforeAll(() => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element: Element, pseudoElement?: string | null) => {
        if (pseudoElement === '::before') {
          return {width: '16px'} as unknown as CSSStyleDeclaration;
        }
        return originalGetComputedStyle.call(window, element, pseudoElement);
      },
    );
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  let container: HTMLDivElement;
  let rootElement: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    container.appendChild(rootElement);
  });
  afterEach(() => {
    document.body.removeChild(container);
  });

  /** A list of `plain`, `todo` (unchecked task) and `done` (checked task). */
  function buildEditor(listType: ListType = 'bullet') {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          const list = $createListNode(listType).append(
            $createListItemNode().append($createTextNode('plain')),
            $createListItemNode().append($createTextNode('todo')),
            $createListItemNode().append($createTextNode('done')),
          );
          $getRoot().append(list);
          const [, todo, done] = list.getChildren().filter($isListItemNode);
          $setTaskListItemChecked(todo, false);
          $setTaskListItemChecked(done, true);
        },
        dependencies: [CheckListExtension, RichTextExtension],
        name: '[task-items-test]',
        theme: {
          list: {
            listitem: 'item',
            listitemChecked: 'checked',
            listitemUnchecked: 'unchecked',
          },
        },
      }),
    );
    editor.setRootElement(rootElement);
    return editor;
  }

  function $items(): ListItemNode[] {
    const list = $getRoot().getFirstChildOrThrow();
    invariant($isListNode(list), 'Expected a ListNode at root');
    return list.getChildren().filter($isListItemNode);
  }

  function readChecked(editor: ReturnType<typeof buildEditor>) {
    return editor.read(() => $items().map($getTaskListItemChecked));
  }

  function readListType(editor: ReturnType<typeof buildEditor>) {
    return editor.read(() => {
      const list = $getRoot().getFirstChildOrThrow();
      invariant($isListNode(list), 'Expected a ListNode at root');
      return list.getListType();
    });
  }

  function itemDOM(index: number): HTMLLIElement {
    const li = rootElement.querySelectorAll('li')[index];
    invariant(li !== undefined, `No <li> at index ${index}`);
    return li;
  }

  function click(li: HTMLLIElement) {
    li.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 5,
      }),
    );
  }

  for (const listType of ['bullet', 'number'] as const) {
    describe(`in a ${listType} list`, () => {
      it('keeps the checked state of the task items only', () => {
        using editor = buildEditor(listType);
        expect(readListType(editor)).toBe(listType);
        expect(readChecked(editor)).toEqual([undefined, false, true]);
      });

      it('leaves getChecked() and setChecked() as they were', () => {
        using editor = buildEditor(listType);
        // getChecked() is only defined in a check list, as before.
        expect(
          editor.read(() => $items().map(item => item.getChecked())),
        ).toEqual([undefined, undefined, undefined]);
        // A checked state set the old way still does not show outside a check
        // list, and does not make the item a task.
        editor.update(() => $items()[0].setChecked(true), {discrete: true});
        expect(readChecked(editor)).toEqual([undefined, false, true]);
      });

      it('gives a task item a checkbox and a plain item none', () => {
        using _editor = buildEditor(listType);
        expect(rootElement.querySelector('ol, ul')?.tagName).toBe(
          listType === 'number' ? 'OL' : 'UL',
        );
        const [plain, todo, done] = [0, 1, 2].map(itemDOM);
        expect(plain.getAttribute('role')).toBe(null);
        expect(plain.getAttribute('aria-checked')).toBe(null);
        expect(plain.className).toBe('item');
        expect(todo.getAttribute('role')).toBe('checkbox');
        expect(todo.getAttribute('aria-checked')).toBe('false');
        expect(todo.className).toBe('item unchecked');
        expect(done.getAttribute('role')).toBe('checkbox');
        expect(done.getAttribute('aria-checked')).toBe('true');
        expect(done.className).toBe('item checked');
      });

      it('toggles a task item on a click on its checkbox, but not a plain item', () => {
        using editor = buildEditor(listType);
        click(itemDOM(0));
        click(itemDOM(1));
        click(itemDOM(2));
        expect(readChecked(editor)).toEqual([undefined, true, false]);
        expect(itemDOM(1).getAttribute('aria-checked')).toBe('true');
      });

      it('adds a plain item after a plain item, and a task after a task', () => {
        using editor = buildEditor(listType);
        editor.update(
          () => {
            const [plain, , done] = $items();
            plain.insertNewAfter(plain.selectEnd());
            done.insertNewAfter(done.selectEnd());
          },
          {discrete: true},
        );
        expect(readChecked(editor)).toEqual([
          undefined,
          undefined,
          false,
          true,
          false,
        ]);
      });

      it('keeps the task items in a saved editor state', () => {
        using editor = buildEditor(listType);
        const json = JSON.stringify(editor.getEditorState().toJSON());
        editor.update(() => $getRoot().clear(), {discrete: true});
        editor.setEditorState(editor.parseEditorState(json));
        expect(readChecked(editor)).toEqual([undefined, false, true]);
      });
    });
  }

  describe('a list command makes the whole list one kind', () => {
    function $selectList() {
      $items()[0].selectStart();
    }

    it('a bullet list makes every item plain', () => {
      using editor = buildEditor('number');
      editor.update($selectList, {discrete: true});
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
      expect(readListType(editor)).toBe('bullet');
      expect(readChecked(editor)).toEqual([undefined, undefined, undefined]);
    });

    it('a number list makes every item plain', () => {
      using editor = buildEditor('bullet');
      editor.update($selectList, {discrete: true});
      editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
      expect(readListType(editor)).toBe('number');
      expect(readChecked(editor)).toEqual([undefined, undefined, undefined]);
    });

    it('a task item moved into a check list keeps its tick', () => {
      using editor = buildEditor('bullet');
      editor.update(
        () => {
          const done = $items()[2];
          $getRoot().append(
            $createListNode('check').append(
              $createListItemNode().append($createTextNode('other')),
              done,
            ),
          );
        },
        {discrete: true},
      );
      expect(
        editor.read(() => {
          const check = $getRoot().getLastChildOrThrow();
          invariant($isListNode(check), 'Expected a ListNode');
          return check
            .getChildren()
            .filter($isListItemNode)
            .map(item => item.getChecked());
        }),
      ).toEqual([false, true]);
    });

    it('a check list makes every item a task and keeps the ticks', () => {
      using editor = buildEditor('bullet');
      editor.update($selectList, {discrete: true});
      editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
      expect(readListType(editor)).toBe('check');
      expect(readChecked(editor)).toEqual([false, false, true]);
    });

    it('setListType keeps the ticks in a check list, and leaves none behind', () => {
      using editor = buildEditor('bullet');
      // setListType marks only the list, not its items.
      const $setListType = (listType: ListType) => () => {
        const list = $getRoot().getFirstChildOrThrow();
        invariant($isListNode(list), 'Expected a ListNode at root');
        list.setListType(listType);
      };
      editor.update($setListType('check'), {discrete: true});
      expect(readChecked(editor)).toEqual([false, false, true]);
      editor.update($setListType('bullet'), {discrete: true});
      expect(readChecked(editor)).toEqual([undefined, undefined, undefined]);
    });
  });

  describe('when the list becomes a check list', () => {
    function $setListType(listType: ListType) {
      const list = $getRoot().getFirstChildOrThrow();
      invariant($isListNode(list), 'Expected a ListNode at root');
      list.setListType(listType);
    }

    // Outside a check list, setChecked() only hides the value, so an item can
    // still hold one when it is made a task.
    it('the task state wins over a checked state set the old way', () => {
      using editor = buildEditor('bullet');
      editor.update(() => $items()[1].setChecked(true), {discrete: true});
      editor.update(() => $setTaskListItemChecked($items()[1], false), {
        discrete: true,
      });
      editor.update(() => $setListType('check'), {discrete: true});
      expect(readChecked(editor)).toEqual([false, false, true]);
    });

    it('the task state wins over the tick of a check list left in the same update', () => {
      using editor = buildEditor('check');
      editor.update(
        () => {
          $setListType('bullet');
          $setTaskListItemChecked($items()[2], false);
          $setListType('check');
        },
        {discrete: true},
      );
      expect(readChecked(editor)).toEqual([false, false, false]);
    });

    it('a checked state set in the check list wins over the task state', () => {
      // As the `[x] ` shortcut does on a task item: the list becomes a check
      // list, then the item is checked, before the transforms run.
      using editor = buildEditor('bullet');
      editor.update(
        () => {
          $setListType('check');
          $items()[1].setChecked(true);
        },
        {discrete: true},
      );
      expect(readChecked(editor)).toEqual([false, true, true]);
    });
  });

  it('a click on a check list item still goes through toggleChecked()', () => {
    // A ListItemNode subclass may override toggleChecked().
    const toggleChecked = vi.spyOn(ListItemNode.prototype, 'toggleChecked');
    try {
      using editor = buildEditor('check');
      click(itemDOM(1));
      expect(toggleChecked).toHaveBeenCalledTimes(1);
      expect(readChecked(editor)).toEqual([false, true, true]);
    } finally {
      toggleChecked.mockRestore();
    }
  });
});
