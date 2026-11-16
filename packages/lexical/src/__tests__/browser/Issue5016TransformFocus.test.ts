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
  type LexicalEditor,
  TextNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

// https://github.com/facebook/lexical/issues/5016
// Registering a transform re-validates the existing nodes. That must not move
// focus into an editor that does not have it, and must not stop a focus
// request made in the same tick either.

function createEditor(): {
  editor: LexicalEditor;
  input: HTMLInputElement;
  root: HTMLElement;
} {
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('hello world')),
      );
      $getRoot().selectStart();
    },
    dependencies: [RichTextExtension],
    name: 'test',
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  const input = document.createElement('input');
  document.body.append(root, input);
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.setRootElement(null);
    root.remove();
    input.remove();
    editor.dispose();
  });
  return {editor, input, root};
}

const registerTransform = (editor: LexicalEditor) =>
  onTestFinished(editor.registerNodeTransform(TextNode, () => {}));

// Lets the batched update commit
const nextCommit = () => new Promise(resolve => setTimeout(resolve, 0));

test('registering a transform leaves focus in another input', async () => {
  const {editor, input} = createEditor();
  await userEvent.click(input);
  registerTransform(editor);
  await nextCommit();
  expect(document.activeElement).toBe(input);
  await userEvent.keyboard('abc');
  expect(input.value).toBe('abc');
});

test('editor.focus() after registering a transform still focuses the editor', async () => {
  const {editor, input, root} = createEditor();
  await userEvent.click(input);
  registerTransform(editor);
  editor.focus();
  await nextCommit();
  expect(document.activeElement).toBe(root);
});

test('a selection made after registering a transform is still applied', async () => {
  const {editor, input, root} = createEditor();
  await userEvent.click(input);
  registerTransform(editor);
  editor.update(() => {
    $getRoot().selectEnd();
  });
  await nextCommit();
  expect(document.activeElement).toBe(root);
  expect(
    editor.read(() => {
      const selection = $getSelection();
      return $isRangeSelection(selection) && selection.anchor.offset;
    }),
  ).toBe(11);
  expect(window.getSelection()!.anchorOffset).toBe(11);
});
