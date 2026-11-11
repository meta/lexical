/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  SELECTION_CHANGE_COMMAND,
  TextNode,
} from 'lexical';
import {assert, expect, onTestFinished, test, vi} from 'vitest';
import {userEvent} from 'vitest/browser';

const settle = () => new Promise(resolve => setTimeout(resolve, 75));

test('native events still notify a dirty but unchanged selection', async () => {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions();
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  editor.update(
    () => {
      const text = $createTextNode('Hello world');
      $getRoot().clear().append($createParagraphNode().append(text));
      text.select(2, 2);
    },
    {discrete: true},
  );
  await settle();
  const listener = vi.fn(() => false);
  onTestFinished(
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      listener,
      COMMAND_PRIORITY_LOW,
    ),
  );
  editor.update(
    () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      selection.dirty = true;
      document.dispatchEvent(new Event('selectionchange'));
    },
    {discrete: true},
  );
  expect(listener).toHaveBeenCalledTimes(1);
  await settle();
  expect(listener).toHaveBeenCalledTimes(1);
});

test.each(['typing', 'backspace', 'format', 'style', 'clear'])(
  'notifies a %s selection change',
  async operation => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.append(root);
    const editor = buildEditorFromExtensions(RichTextExtension);
    editor.setRootElement(root);
    onTestFinished(() => {
      editor.dispose();
      root.remove();
    });
    editor.update(
      () => {
        const text = $createTextNode('hello world');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(2, 2);
      },
      {discrete: true},
    );
    root.focus();
    await settle();
    const listener = vi.fn(() => false);
    onTestFinished(
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        listener,
        COMMAND_PRIORITY_LOW,
      ),
    );
    if (operation === 'typing') {
      window.focus();
      await userEvent.keyboard('x');
      expect(editor.read(() => $getRoot().getTextContent())).toBe(
        'hexllo world',
      );
    } else if (operation === 'backspace') {
      window.focus();
      await userEvent.keyboard('{Backspace}');
      expect(editor.read(() => $getRoot().getTextContent())).toBe('hllo world');
    } else {
      editor.update(
        () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          if (operation === 'format') selection.toggleFormat('bold');
          else if (operation === 'style') selection.setStyle('color: red');
          else $setSelection(null);
        },
        {discrete: true},
      );
    }
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
  },
);

test.each([false, true])(
  'preserves a mutation-listener update without command listeners (discrete: %s)',
  async discrete => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    const editor = buildEditorFromExtensions();
    editor.setRootElement(root);
    onTestFinished(() => {
      editor.dispose();
      root.remove();
    });
    editor.update(
      () => {
        const text = $createTextNode('Hello world');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(1, 1);
      },
      {discrete: true},
    );
    await settle();

    const unregister = editor.registerMutationListener(
      TextNode,
      () => {
        unregister();
        editor.update(
          () => $getRoot().getAllTextNodes()[0].select(7, 7),
          discrete ? {discrete: true} : undefined,
        );
      },
      {skipInitialization: true},
    );
    editor.update(
      () => {
        const text = $getRoot().getAllTextNodes()[0];
        text.setTextContent('Hello world!');
        text.select(2, 2);
      },
      {discrete: true},
    );
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect([selection.anchor.offset, selection.focus.offset]).toEqual([7, 7]);
    });
    // Native selectionchange events must not restore the older selection either.
    await settle();
    const selection = document.getSelection();
    expect([selection?.anchorOffset, selection?.focusOffset]).toEqual([7, 7]);
  },
);
