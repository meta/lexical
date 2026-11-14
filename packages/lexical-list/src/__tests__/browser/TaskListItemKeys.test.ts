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
  $getTaskListItemChecked,
  $isListItemNode,
  $isListNode,
  $setTaskListItemChecked,
  CheckListExtension,
  type ListItemNode,
} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {$createTextNode, $getRoot} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

function $items(): ListItemNode[] {
  const list = $getRoot().getFirstChild();
  assert($isListNode(list), 'Expected a ListNode at root');
  return list.getChildren().filter($isListItemNode);
}

/** A bullet list of `plain` and `todo`, an unchecked task item. */
function mountEditor() {
  const rootElement = document.createElement('div');
  rootElement.contentEditable = 'true';
  document.body.appendChild(rootElement);
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot()
        .clear()
        .append(
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('plain')),
            $createListItemNode().append($createTextNode('todo')),
          ),
        );
      $setTaskListItemChecked($items()[1], false);
    },
    dependencies: [CheckListExtension, RichTextExtension],
    name: 'task-list-item-keys',
  });
  editor.setRootElement(rootElement);
  onTestFinished(() => {
    editor.setRootElement(null);
    rootElement.remove();
    editor.dispose();
  });
  rootElement.focus();
  return {editor, rootElement};
}

// Space and the arrow keys find a task item of a bullet or number list the
// way they find a check list item. They need the browser's focus, which
// jsdom does not move the same way.
describe('keys on a task item next to a plain item', () => {
  test('ArrowLeft at the start of a task item focuses its checkbox, and Space ticks it', async () => {
    const {editor, rootElement} = mountEditor();
    editor.update(() => $items()[1].selectStart(), {discrete: true});

    await userEvent.keyboard('{ArrowLeft}');
    const todo = rootElement.querySelectorAll('li')[1];
    expect(document.activeElement).toBe(todo);

    await userEvent.keyboard(' ');
    expect(editor.read(() => $items().map($getTaskListItemChecked))).toEqual([
      undefined,
      true,
    ]);
    expect(todo.getAttribute('aria-checked')).toBe('true');
  });

  test('ArrowLeft at the start of a plain item leaves the focus in the editor', async () => {
    const {editor, rootElement} = mountEditor();
    editor.update(() => $items()[0].selectStart(), {discrete: true});

    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(rootElement);
    expect(editor.read(() => $items().map($getTaskListItemChecked))).toEqual([
      undefined,
      false,
    ]);
  });
});
