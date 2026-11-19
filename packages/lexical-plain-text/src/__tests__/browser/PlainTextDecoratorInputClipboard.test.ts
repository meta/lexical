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
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isTextNode,
  $setSelection,
  DecoratorNode,
  type LexicalEditor,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';
import {userEvent} from 'vitest/browser';

/** An inline decorator whose DOM holds a text field of its own. */
class TestInputNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_input', {extends: DecoratorNode});
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span');
    const input = document.createElement('input');
    input.value = 'field text';
    span.appendChild(input);
    return span;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): null {
    return null;
  }

  isInline(): true {
    return true;
  }
}

/** `hello world [field text]`, with `hello` selected in the editor. */
function mountEditor(): {editor: LexicalEditor; input: HTMLInputElement} {
  const rootElement = document.createElement('div');
  rootElement.contentEditable = 'true';
  document.body.appendChild(rootElement);
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append(
            $createTextNode('hello world '),
            new TestInputNode(),
          ),
        );
    },
    dependencies: [PlainTextExtension],
    name: 'test',
    nodes: [TestInputNode],
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

/** The editor's text, and the text of its selection. */
function readEditor(editor: LexicalEditor) {
  return editor.read(() => ({
    selected: $getSelection()?.getTextContent() ?? null,
    text: $getRoot().getTextContent(),
  }));
}

/** Selects `field` in the decorator's input, which takes the focus. */
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

describe('PlainTextExtension clipboard in a decorator input', () => {
  test('copy in the input is left to the input', async () => {
    const {editor, input} = mountEditor();
    await selectInInput(input);
    expect(await pressShortcut('c')).toEqual(LEFT_TO_THE_BROWSER);
    expect(readEditor(editor)).toEqual({
      selected: 'hello',
      text: 'hello world ',
    });
  });

  test('cut in the input is left to the input', async () => {
    const {editor, input} = mountEditor();
    await selectInInput(input);
    expect(await pressShortcut('x')).toEqual(LEFT_TO_THE_BROWSER);
    await vi.waitFor(() => expect(input.value).toBe(' text'));
    // The input's own input event drops the editor's selection, so only the
    // text is compared.
    expect(readEditor(editor).text).toBe('hello world ');
  });

  test('paste in the input is left to the input', async () => {
    const {editor, input} = mountEditor();
    await selectInInput(input);
    expect((await pressShortcut('v')).defaultPrevented).toBe(false);
    expect(readEditor(editor).text).toBe('hello world ');
  });

  test('copy in the editor copies the editor selection', async () => {
    const {editor} = mountEditor();
    expect(await pressShortcut('c')).toEqual({
      defaultPrevented: true,
      written: 'hello',
    });
    expect(readEditor(editor).text).toBe('hello world ');
  });

  test('cut in the editor cuts the editor selection', async () => {
    const {editor} = mountEditor();
    expect(await pressShortcut('x')).toEqual({
      defaultPrevented: true,
      written: 'hello',
    });
    await vi.waitFor(() => expect(readEditor(editor).text).toBe(' world '));
  });

  test("paste in the editor is the editor's", async () => {
    mountEditor();
    expect((await pressShortcut('v')).defaultPrevented).toBe(true);
  });
});

/** Selects the decorator itself, as clicking a selectable decorator does. */
function selectDecorator(editor: LexicalEditor) {
  editor.update(
    () => {
      const selection = $createNodeSelection();
      selection.add(
        $getRoot().getFirstDescendant()!.getNextSibling()!.getKey(),
      );
      $setSelection(selection);
    },
    {discrete: true},
  );
}

describe('PlainTextExtension clipboard in the input of a node-selected decorator', () => {
  test('copy in the input is left to the input', async () => {
    const {editor, input} = mountEditor();
    selectDecorator(editor);
    await selectInInput(input);
    expect(await pressShortcut('c')).toEqual(LEFT_TO_THE_BROWSER);
    expect(readEditor(editor).text).toBe('hello world ');
  });

  test('cut in the input is left to the input', async () => {
    const {editor, input} = mountEditor();
    selectDecorator(editor);
    await selectInInput(input);
    expect(await pressShortcut('x')).toEqual(LEFT_TO_THE_BROWSER);
    await vi.waitFor(() => expect(input.value).toBe(' text'));
    await new Promise(resolve => setTimeout(resolve, 0));
    // The decorator, and the input with it, is still in the editor.
    expect(editor.getRootElement()!.contains(input)).toBe(true);
    expect(readEditor(editor).text).toBe('hello world ');
  });
});
