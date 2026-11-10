/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {PlainTextExtension} from '@lexical/plain-text';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  BEFORE_INPUT_COMMAND,
  COMMAND_PRIORITY_HIGH,
  getActiveElementDeep,
  getDOMSelection,
  HISTORY_PUSH_TAG,
} from 'lexical';
import {IS_APPLE, IS_FIREFOX} from 'lexical/src/environment';
import {assert, expect, onTestFinished, test, vi} from 'vitest';
import {page, userEvent} from 'vitest/browser';

function mountEditor({inShadowRoot = false, history = false} = {}) {
  const container = document.createElement('div');
  const outside = document.createElement('div');
  const rootElement = document.createElement('div');
  outside.tabIndex = 0;
  outside.textContent = 'Canvas';
  outside.style.userSelect = 'none';
  // Canvas-style surfaces take focus without moving the native selection.
  outside.addEventListener('pointerdown', event => {
    event.preventDefault();
    outside.focus();
  });
  outside.setAttribute('data-testid', 'outside');
  rootElement.contentEditable = 'true';
  rootElement.setAttribute('data-testid', 'editor');
  if (inShadowRoot) {
    const host = document.createElement('div');
    host.attachShadow({mode: 'open'}).append(rootElement);
    container.append(host, outside);
  } else {
    container.append(rootElement, outside);
  }
  document.body.append(container);

  const editor = buildEditorFromExtensions({
    dependencies: [PlainTextExtension, ...(history ? [HistoryExtension] : [])],
    name: '[unfocused-editor-input]',
  });
  editor.setRootElement(rootElement);
  onTestFinished(() => {
    editor.setRootElement(null);
    editor.dispose();
    container.remove();
  });
  return {editor, outside, rootElement};
}

test.each([
  ['text', 'x', false],
  ['shifted digits', '{Shift>}12{/Shift}', true],
  ['deletion', '{Backspace}', false],
] as const)(
  'does not edit or refocus a stale editor caret when %s is sent to another surface',
  async (_name, keys, clearMessage) => {
    const {editor, outside, rootElement} = mountEditor();
    await page.getByTestId('editor').click();
    await userEvent.keyboard('hello');
    if (clearMessage) {
      // Sending a message leaves a collapsed caret in the empty paragraph.
      editor.update(
        () => {
          $getRoot().clear().append($createParagraphNode()).selectEnd();
        },
        {discrete: true},
      );
    }
    const textBefore = rootElement.textContent;
    await page.getByTestId('outside').click();
    expect(document.activeElement).toBe(outside);
    const selection = getDOMSelection(rootElement.ownerDocument.defaultView);
    assert(selection);
    expect(selection.isCollapsed).toBe(true);
    expect(rootElement.contains(selection.anchorNode)).toBe(true);
    const onBeforeInput = vi.fn(() => false);
    editor.registerCommand(
      BEFORE_INPUT_COMMAND,
      onBeforeInput,
      COMMAND_PRIORITY_HIGH,
    );

    // WebKit sends beforeinput to the old contenteditable even though the
    // keydown and focus belong to the outside surface. No editor API update
    // is issued after the focus handoff.
    await userEvent.keyboard(keys);
    expect(document.activeElement).toBe(outside);
    expect(rootElement.textContent).toBe(textBefore);
    expect(editor.read(() => $getRoot().getTextContent())).toBe(textBefore);
    expect(onBeforeInput).not.toHaveBeenCalled();
  },
);

test('an explicit editor update from an outside control still edits and focuses the editor', async () => {
  const {editor, outside, rootElement} = mountEditor();
  await page.getByTestId('editor').click();
  await userEvent.keyboard('hello');
  await page.getByTestId('outside').click();
  expect(document.activeElement).toBe(outside);

  editor.update(
    () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      selection.insertText('!');
    },
    {discrete: true},
  );
  expect(document.activeElement).toBe(rootElement);
  expect(rootElement.textContent).toBe('hello!');
});

test('native input still edits a focused editor inside a shadow root', async () => {
  const {rootElement} = mountEditor({inShadowRoot: true});
  await page.getByTestId('editor').click();
  expect(getActiveElementDeep(document)).toBe(rootElement);
  await userEvent.keyboard('hello{Backspace}!');
  expect(getActiveElementDeep(document)).toBe(rootElement);
  expect(rootElement.textContent).toBe('hell!');
});

// Firefox keeps native history scoped to the input and never forwards it.
test.skipIf(IS_FIREFOX)(
  'native undo and forwarded redo from an outside input use editor history (#6714)',
  async () => {
    const {editor, outside, rootElement} = mountEditor({history: true});
    const input = document.createElement('input');
    outside.after(input);
    await page.getByTestId('editor').click();
    await userEvent.keyboard('hello');
    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        selection.insertText('!');
      },
      {discrete: true, tag: HISTORY_PUSH_TAG},
    );
    expect(rootElement.textContent).toBe('hello!');

    // The input has no native undo history. Chromium and WebKit forward its
    // undo to the editor root, where @lexical/history owns the operation.
    input.focus();
    const modifier = IS_APPLE ? 'Meta' : 'Control';
    await userEvent.keyboard(`{${modifier}>}z{/${modifier}}`);
    await expect.poll(() => rootElement.textContent).toBe('hello');
    input.focus();
    // Chromium does not emit native redo after the native undo was canceled.
    // Exercise historyRedo once it reaches the root, independent of that scope.
    rootElement.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'historyRedo',
      }),
    );
    await expect.poll(() => rootElement.textContent).toBe('hello!');
    expect(input.value).toBe('');
  },
);

test.each(['body', 'drop'] as const)(
  'preserves application beforeinput handling for %s input',
  async target => {
    const {editor, outside, rootElement} = mountEditor();
    await page.getByTestId('editor').click();
    await userEvent.keyboard('hello');
    if (target === 'drop') {
      outside.focus();
    } else {
      rootElement.blur();
      expect(document.activeElement).toBe(document.body);
    }
    editor.registerCommand(
      BEFORE_INPUT_COMMAND,
      event => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        selection.insertText(event.data ?? '');
        event.preventDefault();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    // Drops target a location in the editor even when the drag source still
    // has focus. The body fallback likewise does not identify another owner.
    rootElement.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: '!',
        inputType: target === 'drop' ? 'insertFromDrop' : 'insertText',
      }),
    );
    await expect.poll(() => rootElement.textContent).toBe('hello!');
  },
);
