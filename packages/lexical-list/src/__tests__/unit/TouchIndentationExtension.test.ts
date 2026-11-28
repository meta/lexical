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
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  configExtension,
  defineExtension,
  INDENT_CONTENT_COMMAND,
  type LexicalEditor,
  type NodeKey,
  OUTDENT_CONTENT_COMMAND,
} from 'lexical';
import {assert, describe, expect, it, vi} from 'vitest';

function createTouchEvent(type: string, x: number, y: number): Event {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  });
  const touchData = {
    clientX: x,
    clientY: y,
    identifier: 0,
    target: document.body,
  };
  if (type === 'touchend') {
    Object.defineProperty(event, 'changedTouches', {value: [touchData]});
    Object.defineProperty(event, 'touches', {value: []});
  } else {
    Object.defineProperty(event, 'touches', {value: [touchData]});
    Object.defineProperty(event, 'changedTouches', {value: [touchData]});
  }
  return event;
}

function simulateSwipe(
  element: HTMLElement,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) {
  element.dispatchEvent(createTouchEvent('touchstart', startX, startY));
  element.dispatchEvent(createTouchEvent('touchmove', endX, endY));
  element.dispatchEvent(createTouchEvent('touchend', endX, endY));
}

interface Keys {
  paragraph: NodeKey;
  first: NodeKey;
  second: NodeKey;
}

type CaretLocation = keyof Keys;

/**
 * Builds: paragraph("Intro"), then a bullet list with two items
 * ("First", "Second"). `caret` chooses where the selection starts, and the
 * node keys are written to `keys` so tests can target specific elements.
 */
function createInitialState(keys: Keys, caret: CaretLocation) {
  return () => {
    const paragraph = $createParagraphNode().append($createTextNode('Intro'));
    const list = $createListNode('bullet');
    const first = $createListItemNode().append($createTextNode('First'));
    const second = $createListItemNode().append($createTextNode('Second'));
    list.append(first, second);
    $getRoot().append(paragraph, list);

    keys.paragraph = paragraph.getKey();
    keys.first = first.getKey();
    keys.second = second.getKey();

    const nodes = {first, paragraph, second};
    nodes[caret].selectEnd();
  };
}

function newKeys(): Keys {
  return {first: '', paragraph: '', second: ''};
}

/** Returns the rendered DOM element for a node, flushing pending updates. */
function getElement(editor: LexicalEditor, key: NodeKey): HTMLElement {
  editor.read(() => {});
  const element = editor.getElementByKey(key);
  assert(element !== null);
  return element;
}

function afterRegistration(editor: LexicalEditor) {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  return () => {
    editor.setRootElement(null);
    root.remove();
  };
}

describe('TouchIndentationExtension', () => {
  it('dispatches INDENT_CONTENT_COMMAND on swipe right on a list item', () => {
    const keys = newKeys();
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: createInitialState(keys, 'first'),
        afterRegistration,
        dependencies: [TouchIndentationExtension, ListExtension],
        name: 'test',
      }),
    );
    const indentHandler = vi.fn(() => true);

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);

    simulateSwipe(getElement(editor, keys.first), 100, 200, 200, 200);

    expect(indentHandler).toHaveBeenCalledTimes(1);
  });

  it('dispatches OUTDENT_CONTENT_COMMAND on swipe left on a list item', () => {
    const keys = newKeys();
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: createInitialState(keys, 'first'),
        afterRegistration,
        dependencies: [TouchIndentationExtension, ListExtension],
        name: 'test',
      }),
    );
    const outdentHandler = vi.fn(() => true);

    editor.registerCommand(OUTDENT_CONTENT_COMMAND, outdentHandler, 1);

    simulateSwipe(getElement(editor, keys.first), 200, 200, 50, 200);

    expect(outdentHandler).toHaveBeenCalledTimes(1);
  });

  it('indents the swiped list item even when the caret is elsewhere', () => {
    const keys = newKeys();
    using editor = buildEditorFromExtensions(
      defineExtension({
        // Caret starts in the first item, but we swipe the second.
        $initialEditorState: createInitialState(keys, 'first'),
        afterRegistration,
        dependencies: [TouchIndentationExtension, ListExtension],
        name: 'test',
      }),
    );
    let selectedParentKey: NodeKey | null = null;
    const indentHandler = vi.fn(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selectedParentKey = selection.anchor.getNode().getParent()!.getKey();
      }
      return true;
    });

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);

    simulateSwipe(getElement(editor, keys.second), 100, 200, 200, 200);

    expect(indentHandler).toHaveBeenCalledTimes(1);
    // While the command ran, the selection was inside the swiped item.
    expect(selectedParentKey).toBe(keys.second);
  });

  it('indents a list item when the caret is in a paragraph', () => {
    const keys = newKeys();
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: createInitialState(keys, 'paragraph'),
        afterRegistration,
        dependencies: [TouchIndentationExtension, ListExtension],
        name: 'test',
      }),
    );
    const indentHandler = vi.fn(() => true);

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);

    simulateSwipe(getElement(editor, keys.first), 100, 200, 200, 200);

    expect(indentHandler).toHaveBeenCalledTimes(1);
  });

  it('restores the original selection after the swipe', () => {
    const keys = newKeys();
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: createInitialState(keys, 'paragraph'),
        afterRegistration,
        dependencies: [TouchIndentationExtension, ListExtension],
        name: 'test',
      }),
    );
    editor.registerCommand(INDENT_CONTENT_COMMAND, () => true, 1);

    simulateSwipe(getElement(editor, keys.second), 100, 200, 200, 200);

    const anchorParentKey = editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      return selection.anchor.getNode().getParent()!.getKey();
    });
    expect(anchorParentKey).toBe(keys.paragraph);
  });

  it.each([
    ['the swiped item', 'second'],
    ['another item', 'first'],
  ] as const)(
    'keeps a collapsed caret at the same position when it is in %s',
    (_name, caretItem) => {
      const keys = newKeys();
      using editor = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: createInitialState(keys, 'paragraph'),
          afterRegistration,
          // RichTextExtension handles INDENT_CONTENT_COMMAND for real.
          dependencies: [
            TouchIndentationExtension,
            ListExtension,
            RichTextExtension,
          ],
          name: 'test',
        }),
      );
      const root = editor.getRootElement();
      assert(root !== null);
      root.focus();
      // Collapsed caret in the middle of the text, not at the end.
      let caretTextKey = '';
      editor.update(
        () => {
          const item = $getNodeByKey(keys[caretItem]);
          assert($isListItemNode(item));
          const text = item.getFirstChild();
          assert($isTextNode(text));
          caretTextKey = text.getKey();
          text.select(2, 2);
        },
        {discrete: true},
      );
      const readCaret = () =>
        editor.read(() => {
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          expect(selection.isCollapsed()).toBe(true);
          return [
            selection.anchor.key,
            selection.anchor.offset,
            selection.anchor.type,
          ];
        });
      const before = readCaret();
      expect(before).toEqual([caretTextKey, 2, 'text']);

      simulateSwipe(getElement(editor, keys.second), 100, 200, 200, 200);

      // The swiped item really moved into a nested list.
      expect(
        getElement(editor, keys.second).parentElement!.parentElement!.matches(
          'li',
        ),
      ).toBe(true);
      expect(readCaret()).toEqual(before);
      // The native selection still points at the same text and offset.
      const dom = window.getSelection()!;
      expect(dom.isCollapsed).toBe(true);
      expect(dom.anchorNode).toBe(
        editor.getElementByKey(caretTextKey)!.firstChild,
      );
      expect(dom.anchorOffset).toBe(2);
    },
  );

  it('does NOT trigger when swiping a paragraph, even if the caret is in a list item', () => {
    const keys = newKeys();
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: createInitialState(keys, 'first'),
        afterRegistration,
        dependencies: [TouchIndentationExtension, ListExtension],
        name: 'test',
      }),
    );
    const indentHandler = vi.fn(() => true);
    const outdentHandler = vi.fn(() => true);

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);
    editor.registerCommand(OUTDENT_CONTENT_COMMAND, outdentHandler, 1);

    simulateSwipe(getElement(editor, keys.paragraph), 100, 200, 200, 200);

    expect(indentHandler).not.toHaveBeenCalled();
    expect(outdentHandler).not.toHaveBeenCalled();
  });

  it('does NOT trigger on paragraph (non-list) content', () => {
    const keys = newKeys();
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: createInitialState(keys, 'paragraph'),
        afterRegistration,
        dependencies: [TouchIndentationExtension, ListExtension],
        name: 'test',
      }),
    );
    const indentHandler = vi.fn(() => true);
    const outdentHandler = vi.fn(() => true);

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);
    editor.registerCommand(OUTDENT_CONTENT_COMMAND, outdentHandler, 1);

    simulateSwipe(getElement(editor, keys.paragraph), 100, 200, 200, 200);

    expect(indentHandler).not.toHaveBeenCalled();
    expect(outdentHandler).not.toHaveBeenCalled();
  });

  it('does NOT trigger on vertical swipe (scroll)', () => {
    const keys = newKeys();
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: createInitialState(keys, 'first'),
        afterRegistration,
        dependencies: [TouchIndentationExtension, ListExtension],
        name: 'test',
      }),
    );
    const indentHandler = vi.fn(() => true);

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);

    simulateSwipe(getElement(editor, keys.first), 100, 100, 120, 300);

    expect(indentHandler).not.toHaveBeenCalled();
  });

  it('does NOT trigger when horizontal movement is below threshold', () => {
    const keys = newKeys();
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: createInitialState(keys, 'first'),
        afterRegistration,
        dependencies: [TouchIndentationExtension, ListExtension],
        name: 'test',
      }),
    );
    const indentHandler = vi.fn(() => true);

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);

    simulateSwipe(getElement(editor, keys.first), 100, 200, 130, 200);

    expect(indentHandler).not.toHaveBeenCalled();
  });

  it('respects custom swipeThreshold', () => {
    const keys = newKeys();
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: createInitialState(keys, 'first'),
        afterRegistration,
        dependencies: [
          configExtension(TouchIndentationExtension, {swipeThreshold: 100}),
          ListExtension,
        ],
        name: 'test',
      }),
    );

    const indentHandler = vi.fn(() => true);
    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);

    const item = getElement(editor, keys.first);
    // 60px swipe: below custom threshold of 100
    simulateSwipe(item, 100, 200, 160, 200);
    expect(indentHandler).not.toHaveBeenCalled();

    // 120px swipe: above custom threshold of 100
    simulateSwipe(item, 100, 200, 220, 200);
    expect(indentHandler).toHaveBeenCalledTimes(1);
  });

  it('does NOT trigger when disabled', () => {
    const keys = newKeys();
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: createInitialState(keys, 'first'),
        afterRegistration,
        dependencies: [
          configExtension(TouchIndentationExtension, {disabled: true}),
          ListExtension,
        ],
        name: 'test',
      }),
    );
    const indentHandler = vi.fn(() => true);

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);

    simulateSwipe(getElement(editor, keys.first), 100, 200, 200, 200);

    expect(indentHandler).not.toHaveBeenCalled();
  });

  it('does NOT trigger when the editor is read-only', () => {
    const keys = newKeys();
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: createInitialState(keys, 'first'),
        afterRegistration,
        dependencies: [TouchIndentationExtension, ListExtension],
        name: 'test',
      }),
    );
    const indentHandler = vi.fn(() => true);

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);
    editor.setEditable(false);

    simulateSwipe(getElement(editor, keys.first), 100, 200, 200, 200);

    expect(indentHandler).not.toHaveBeenCalled();
  });

  it('cleans up event listeners on dispose', () => {
    const keys = newKeys();
    const indentHandler = vi.fn(() => true);
    let item: HTMLElement;
    {
      using editor = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: createInitialState(keys, 'first'),
          afterRegistration,
          dependencies: [TouchIndentationExtension, ListExtension],
          name: 'test',
        }),
      );
      editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);
      item = getElement(editor, keys.first);

      // Sanity check: the listener works before disposal.
      simulateSwipe(item, 100, 200, 200, 200);
      expect(indentHandler).toHaveBeenCalledTimes(1);
    }

    // The editor is disposed here; further swipes must be ignored.
    simulateSwipe(item, 100, 200, 200, 200);
    expect(indentHandler).toHaveBeenCalledTimes(1);
  });
});
