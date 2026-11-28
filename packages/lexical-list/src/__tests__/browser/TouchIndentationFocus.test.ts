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
  ListExtension,
  TouchIndentationExtension,
} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  defineExtension,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';

function touch(
  type: 'touchstart' | 'touchmove' | 'touchend',
  target: Element,
  x: number,
  y: number,
) {
  // Touch and TouchEvent are missing from desktop Safari, so build a plain
  // event with the fields the extension reads.
  const point = {clientX: x, clientY: y, identifier: 1, target};
  const event = new Event(type, {bubbles: true, cancelable: true});
  Object.defineProperty(event, 'changedTouches', {value: [point]});
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? [] : [point],
  });
  target.dispatchEvent(event);
}

/** Returns the rendered element for a node, failing if there is none. */
function getElement(editor: LexicalEditor, key: NodeKey): HTMLElement {
  const element = editor.getElementByKey(key);
  assert(element !== null);
  return element;
}

function swipeRight(target: Element) {
  const {left, top} = target.getBoundingClientRect();
  const x = left + 20;
  const y = top + 5;
  touch('touchstart', target, x, y);
  touch('touchmove', target, x + 120, y);
  touch('touchend', target, x + 120, y);
}

/**
 * The editor keeps its Lexical selection after it loses focus. A swipe on
 * a blurred editor must indent the item without focusing the editor again.
 */
describe('TouchIndentationExtension focus', () => {
  test.each(['swiped', 'other'] as const)(
    'does not focus a blurred editor when the selection is in the %s item',
    which => {
      const keys: {first: NodeKey; second: NodeKey} = {first: '', second: ''};
      const root = document.createElement('div');
      root.contentEditable = 'true';
      document.body.appendChild(root);
      const editor = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => {
            const first = $createListItemNode().append(
              $createTextNode('First'),
            );
            const second = $createListItemNode().append(
              $createTextNode('Second'),
            );
            keys.first = first.getKey();
            keys.second = second.getKey();
            $getRoot().append($createListNode('bullet').append(first, second));
          },
          dependencies: [
            RichTextExtension,
            ListExtension,
            TouchIndentationExtension,
          ],
          name: 'test',
        }),
      );
      onTestFinished(() => {
        editor.dispose();
        root.remove();
      });
      editor.setRootElement(root);

      // Focus the editor with a non-collapsed selection inside an item, then
      // blur it. A range is what used to bring the focus back on swipe.
      const caretKey = which === 'swiped' ? keys.second : keys.first;
      root.focus();
      editor.update(
        () => {
          const item = $getNodeByKey(caretKey);
          assert($isListItemNode(item));
          const text = item.getFirstChild();
          assert($isTextNode(text));
          text.select(1, 4);
        },
        {discrete: true},
      );
      root.blur();
      expect(root.contains(document.activeElement)).toBe(false);

      swipeRight(getElement(editor, keys.second));
      editor.read(() => {});

      // The item was indented (now inside a nested list in an <li>)...
      const nestedList = getElement(editor, keys.second).parentElement;
      assert(nestedList !== null);
      const wrapper = nestedList.parentElement;
      assert(wrapper !== null);
      expect(wrapper.matches('li')).toBe(true);
      // ...the editor stayed blurred...
      expect(root.contains(document.activeElement)).toBe(false);
      // ...and the Lexical selection is where it was.
      const anchorParent = editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        return selection.anchor.getNode().getParentOrThrow().getKey();
      });
      expect(anchorParent).toBe(caretKey);
    },
  );
});
