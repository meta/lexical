/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, configExtension} from '@lexical/extension';
import {domOverride, DOMRenderExtension} from '@lexical/html';
import {PlainTextExtension} from '@lexical/plain-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  isHTMLElement,
  type Klass,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
  setDOMUnmanaged,
  TextNode,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';
import {userEvent} from 'vitest/browser';

const FIELD_ATTR = 'data-test-field';

/**
 * A render override that puts a text field of its own, as unmanaged DOM, ahead
 * of the children or text of every node of `klass`.
 */
function fieldOverride(klass: Klass<LexicalNode>) {
  return domOverride([klass], {
    $createDOM: (_node, $next) => {
      const dom = $next();
      const field = document.createElement('span');
      field.setAttribute(FIELD_ATTR, 'true');
      field.contentEditable = 'false';
      const input = document.createElement('input');
      input.value = 'field text';
      field.appendChild(input);
      setDOMUnmanaged(field);
      dom.insertBefore(field, dom.firstChild);
      return dom;
    },
    $getDOMSlot: (_node, dom, $next) => {
      const field = dom.querySelector(`:scope > [${FIELD_ATTR}]`);
      return isHTMLElement(field) ? $next().withAfter(field) : $next();
    },
  });
}

/** `[field text] hello world `, with `hello` selected in the editor. */
function mountEditor(klass: Klass<LexicalNode>) {
  const rootElement = document.createElement('div');
  rootElement.contentEditable = 'true';
  document.body.appendChild(rootElement);
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createTextNode('hello world ')));
    },
    dependencies: [
      PlainTextExtension,
      configExtension(DOMRenderExtension, {overrides: [fieldOverride(klass)]}),
    ],
    name: 'test',
  });
  editor.setRootElement(rootElement);
  rootElement.focus();
  editor.update(
    () => {
      const text = $getRoot().getFirstDescendant();
      assert($isTextNode(text));
      text.select(0, 5);
    },
    {discrete: true},
  );
  onTestFinished(() => {
    editor.setRootElement(null);
    rootElement.remove();
    editor.dispose();
  });
  return {editor, input: rootElement.querySelector('input')!};
}
/** The editor's text. */
function readEditor(editor: LexicalEditor) {
  return editor.read(() => $getRoot().getTextContent());
}
/** Selects `field` in the input, which takes the focus. */
async function selectInInput(input: HTMLInputElement) {
  await userEvent.click(input);
  input.setSelectionRange(0, 5);
}

const EVENT_TYPES = {c: 'copy', v: 'paste', x: 'cut'} as const;

/**
 * Presses the shortcut for a copy, a cut or a paste, and reports the clipboard
 * event it fired as the page sees it once the editor's listeners have run:
 * whether they prevented the browser's own action, and the text they wrote.
 * The system clipboard itself is left unread, since test files share it.
 */
async function pressShortcut(key: 'c' | 'x' | 'v') {
  const type = EVENT_TYPES[key];
  const seen: {defaultPrevented: boolean; written: string}[] = [];
  const record = (event: Event) => {
    const {clipboardData, defaultPrevented} = event as ClipboardEvent;
    seen.push({
      defaultPrevented,
      written: type === 'paste' ? '' : clipboardData!.getData('text/plain'),
    });
  };
  window.addEventListener(type, record);
  try {
    await userEvent.keyboard(`{ControlOrMeta>}${key}{/ControlOrMeta}`);
    // Let any update the event started, and its commit, run.
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    window.removeEventListener(type, record);
  }
  expect(seen).toHaveLength(1);
  return seen[0];
}

const LEFT_TO_THE_BROWSER = {defaultPrevented: false, written: ''};
for (const klass of [ParagraphNode, TextNode]) {
  describe(`PlainTextExtension clipboard in an input in ${klass.name}'s unmanaged DOM`, () => {
    test('copy in the input is left to the input', async () => {
      const {editor, input} = mountEditor(klass);
      await selectInInput(input);
      expect(await pressShortcut('c')).toEqual(LEFT_TO_THE_BROWSER);
      expect(readEditor(editor)).toBe('hello world ');
    });
    test('cut in the input is left to the input', async () => {
      const {editor, input} = mountEditor(klass);
      await selectInInput(input);
      expect(await pressShortcut('x')).toEqual(LEFT_TO_THE_BROWSER);
      await vi.waitFor(() => expect(input.value).toBe(' text'));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(readEditor(editor)).toBe('hello world ');
    });
    test('paste in the input is left to the input', async () => {
      const {editor, input} = mountEditor(klass);
      await selectInInput(input);
      expect((await pressShortcut('v')).defaultPrevented).toBe(false);
      expect(readEditor(editor)).toBe('hello world ');
    });
  });
}
