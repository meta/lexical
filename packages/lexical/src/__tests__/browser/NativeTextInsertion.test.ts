/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {PlainTextExtension} from '@lexical/plain-text';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';
import {server} from 'vitest/browser';

function mountEditor(isPlainText: boolean, paragraphs = ['']) {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  root.style.whiteSpace = 'pre-wrap';
  document.body.append(root);
  const editor = buildEditorFromExtensions(
    isPlainText ? PlainTextExtension : RichTextExtension,
  );
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
    window.getSelection()?.removeAllRanges();
  });
  editor.update(
    () => {
      $getRoot().clear();
      for (const text of paragraphs) {
        const paragraph = $createParagraphNode();
        if (text) {
          paragraph.append($createTextNode(text));
        }
        $getRoot().append(paragraph);
      }
      $getRoot().selectEnd();
    },
    {discrete: true},
  );
  window.focus();
  root.focus();
  return {editor, root};
}

function paste(root: HTMLElement, text: string) {
  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', text);
  root.dispatchEvent(
    new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }),
  );
  clipboardData.clearData();
}

async function expectContent(
  editor: LexicalEditor,
  root: HTMLElement,
  paragraphs: string[],
  offset = paragraphs[paragraphs.length - 1].length,
) {
  await expect
    .poll(() => root.innerHTML)
    .toBe(
      paragraphs
        .map(
          text =>
            `<p dir="auto"><span data-lexical-text="true">${text}</span></p>`,
        )
        .join(''),
    );
  await expect
    .poll(() =>
      editor.read('latest', () =>
        $getRoot()
          .getChildren()
          .map(node => node.getTextContent()),
      ),
    )
    .toEqual(paragraphs);
  const textDOM = root.lastElementChild!.firstChild!.firstChild!;
  const native = window.getSelection()!;
  await expect
    .poll(() => [
      native.anchorNode,
      native.anchorOffset,
      native.focusNode,
      native.focusOffset,
    ])
    .toEqual([textDOM, offset, textDOM, offset]);
  editor.read('latest', () => {
    const selection = $getSelection();
    assert($isRangeSelection(selection));
    expect(selection.isCollapsed()).toBe(true);
    expect(selection.anchor.type).toBe('text');
    expect(selection.anchor.offset).toBe(offset);
    expect(selection.anchor.getNode().getTextContent()).toBe(
      paragraphs[paragraphs.length - 1],
    );
  });
}

describe.each([false, true])(
  'native insertion (plain text: %s)',
  isPlainText => {
    test('execCommand inserts text at the caret', async () => {
      const {editor, root} = mountEditor(isPlainText);
      document.execCommand('insertText', false, 'foo');
      await expectContent(editor, root, ['foo']);
    });

    // Firefox does not expose the synthetic ClipboardEvent payload to paste.
    test.skipIf(server.browser === 'firefox')(
      'consecutive paste events append text',
      async () => {
        const {editor, root} = mountEditor(isPlainText);
        paste(root, 'foo');
        await expectContent(editor, root, ['foo']);
        paste(root, 'bar');
        await expectContent(editor, root, ['foobar']);
      },
    );

    test('paste followed immediately by execCommand preserves insertion order', async () => {
      const {editor, root} = mountEditor(isPlainText);
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'foo');
      root.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
      document.execCommand('insertText', false, 'bar');
      await expectContent(editor, root, [
        server.browser === 'firefox' ? 'bar' : 'foobar',
      ]);
    });

    test.each(['backward', 'forward'])(
      'execCommand replaces a %s selection',
      async direction => {
        const {editor, root} = mountEditor(isPlainText, ['Paragraph 1']);
        const textDOM = root.firstElementChild!.firstChild!.firstChild!;
        const native = window.getSelection()!;
        const [anchor, focus] = direction === 'backward' ? [11, 0] : [0, 11];
        native.setBaseAndExtent(textDOM, anchor, textDOM, focus);
        await expect
          .poll(() =>
            editor.read('latest', () => {
              const selection = $getSelection();
              return $isRangeSelection(selection)
                ? [selection.anchor.offset, selection.focus.offset]
                : null;
            }),
          )
          .toEqual([anchor, focus]);
        document.execCommand('insertText', false, 'New text');
        await expectContent(editor, root, ['New text']);
      },
    );
  },
);

test('execCommand replaces a native selection in a different paragraph', async () => {
  const {editor, root} = mountEditor(false, ['hello world', 'asd t']);
  editor.update(() => $getRoot().getFirstChildOrThrow().selectEnd(), {
    discrete: true,
  });
  const textDOM = root.lastElementChild!.firstChild!.firstChild!;
  window.getSelection()!.setBaseAndExtent(textDOM, 0, textDOM, 3);
  await expect
    .poll(() =>
      editor.read('latest', () => {
        const selection = $getSelection();
        return $isRangeSelection(selection)
          ? [
              selection.anchor.getNode().getTextContent(),
              selection.anchor.offset,
              selection.focus.offset,
            ]
          : null;
      }),
    )
    .toEqual(['asd t', 0, 3]);
  document.execCommand('insertText', false, 'and');
  await expectContent(editor, root, ['hello world', 'and t'], 3);
});
