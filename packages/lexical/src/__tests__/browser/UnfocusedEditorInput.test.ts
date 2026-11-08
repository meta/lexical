/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {PlainTextExtension} from '@lexical/plain-text';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  getActiveElementDeep,
  getDOMSelection,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';
import {page, userEvent} from 'vitest/browser';

function mountEditor(inShadowRoot = false) {
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
    dependencies: [PlainTextExtension],
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

    // WebKit sends beforeinput to the old contenteditable even though the
    // keydown and focus belong to the outside surface. No editor API update
    // is issued after the focus handoff.
    await userEvent.keyboard(keys);
    expect(document.activeElement).toBe(outside);
    expect(rootElement.textContent).toBe(textBefore);
    expect(editor.read(() => $getRoot().getTextContent())).toBe(textBefore);
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
  const {rootElement} = mountEditor(true);
  await page.getByTestId('editor').click();
  expect(getActiveElementDeep(document)).toBe(rootElement);
  await userEvent.keyboard('hello{Backspace}!');
  expect(getActiveElementDeep(document)).toBe(rootElement);
  expect(rootElement.textContent).toBe('hell!');
});
