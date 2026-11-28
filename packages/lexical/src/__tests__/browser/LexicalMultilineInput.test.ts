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
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

test.each([
  ['plain text', PlainTextExtension],
  ['rich text', RichTextExtension],
] as const)('handles a multiline text commit in %s', async (_, extension) => {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  root.style.whiteSpace = 'pre-wrap';
  document.body.append(root);
  const editor = buildEditorFromExtensions(extension);
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  root.focus();
  editor.update(
    () => {
      const text = $createTextNode('XY');
      $getRoot().clear().append($createParagraphNode().append(text));
      text.select(1, 1);
    },
    {discrete: true},
  );
  const data = 'AAA\nBBB';
  const event = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data,
    inputType: 'insertText',
  });
  root.dispatchEvent(event);

  // Allowing the default would let Chromium split this commit into multiple
  // DOM edits, including edits outside the current text node.
  expect(event.defaultPrevented).toBe(true);
  expect(editor.read('force-commit', () => $getRoot().getTextContent())).toBe(
    `X${data}Y`,
  );
});
