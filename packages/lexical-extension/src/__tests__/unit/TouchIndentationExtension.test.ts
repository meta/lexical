/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  TouchIndentationExtension,
} from '@lexical/extension';
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
  configExtension,
  defineExtension,
  INDENT_CONTENT_COMMAND,
  OUTDENT_CONTENT_COMMAND,
} from 'lexical';
import {describe, expect, it, vi} from 'vitest';

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

function setupEditorWithList() {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);

  const editor = buildEditorFromExtensions(
    TouchIndentationExtension,
    defineExtension({name: 'test-nodes', nodes: [ListNode, ListItemNode]}),
  );
  editor.setRootElement(root);

  editor.update(
    () => {
      const list = $createListNode('bullet');
      const item = $createListItemNode();
      item.append($createTextNode('Hello'));
      list.append(item);
      $getRoot().append(list);
      item.selectEnd();
    },
    {discrete: true},
  );

  return {editor, root};
}

function setupEditorWithParagraph() {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);

  const editor = buildEditorFromExtensions(
    TouchIndentationExtension,
    defineExtension({name: 'test-nodes', nodes: [ListNode, ListItemNode]}),
  );
  editor.setRootElement(root);

  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode('Hello'));
      $getRoot().append(paragraph);
      paragraph.selectEnd();
    },
    {discrete: true},
  );

  return {editor, root};
}

describe('TouchIndentationExtension', () => {
  it('dispatches INDENT_CONTENT_COMMAND on swipe right in list item', () => {
    const {editor, root} = setupEditorWithList();
    const indentHandler = vi.fn(() => true);

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);

    simulateSwipe(root, 100, 200, 200, 200);

    expect(indentHandler).toHaveBeenCalledTimes(1);
    editor.dispose();
    root.remove();
  });

  it('dispatches OUTDENT_CONTENT_COMMAND on swipe left in list item', () => {
    const {editor, root} = setupEditorWithList();
    const outdentHandler = vi.fn(() => true);

    editor.registerCommand(OUTDENT_CONTENT_COMMAND, outdentHandler, 1);

    simulateSwipe(root, 200, 200, 50, 200);

    expect(outdentHandler).toHaveBeenCalledTimes(1);
    editor.dispose();
    root.remove();
  });

  it('does NOT trigger on paragraph (non-list) content', () => {
    const {editor, root} = setupEditorWithParagraph();
    const indentHandler = vi.fn(() => true);
    const outdentHandler = vi.fn(() => true);

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);
    editor.registerCommand(OUTDENT_CONTENT_COMMAND, outdentHandler, 1);

    simulateSwipe(root, 100, 200, 200, 200);

    expect(indentHandler).not.toHaveBeenCalled();
    expect(outdentHandler).not.toHaveBeenCalled();
    editor.dispose();
    root.remove();
  });

  it('does NOT trigger on vertical swipe (scroll)', () => {
    const {editor, root} = setupEditorWithList();
    const indentHandler = vi.fn(() => true);

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);

    simulateSwipe(root, 100, 100, 120, 300);

    expect(indentHandler).not.toHaveBeenCalled();
    editor.dispose();
    root.remove();
  });

  it('does NOT trigger when horizontal movement is below threshold', () => {
    const {editor, root} = setupEditorWithList();
    const indentHandler = vi.fn(() => true);

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);

    simulateSwipe(root, 100, 200, 130, 200);

    expect(indentHandler).not.toHaveBeenCalled();
    editor.dispose();
    root.remove();
  });

  it('respects custom swipeThreshold', () => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);

    const editor = buildEditorFromExtensions(
      configExtension(TouchIndentationExtension, {swipeThreshold: 100}),
      defineExtension({name: 'test-nodes', nodes: [ListNode, ListItemNode]}),
    );
    editor.setRootElement(root);

    editor.update(
      () => {
        const list = $createListNode('bullet');
        const item = $createListItemNode();
        item.append($createTextNode('Hello'));
        list.append(item);
        $getRoot().append(list);
        item.selectEnd();
      },
      {discrete: true},
    );

    const indentHandler = vi.fn(() => true);
    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);

    // 60px swipe — below custom threshold of 100
    simulateSwipe(root, 100, 200, 160, 200);
    expect(indentHandler).not.toHaveBeenCalled();

    // 120px swipe — above custom threshold of 100
    simulateSwipe(root, 100, 200, 220, 200);
    expect(indentHandler).toHaveBeenCalledTimes(1);

    editor.dispose();
    root.remove();
  });

  it('cleans up event listeners on dispose', () => {
    const {editor, root} = setupEditorWithList();
    const indentHandler = vi.fn(() => true);

    editor.registerCommand(INDENT_CONTENT_COMMAND, indentHandler, 1);

    editor.dispose();

    simulateSwipe(root, 100, 200, 200, 200);
    expect(indentHandler).not.toHaveBeenCalled();
    root.remove();
  });
});
