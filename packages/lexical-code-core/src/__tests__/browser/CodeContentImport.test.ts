/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {ClipboardDOMImportExtension} from '@lexical/clipboard';
import {
  $isCodeHighlightNode,
  $isCodeNode,
  CodeExtension,
} from '@lexical/code-core';
import {buildEditorFromExtensions} from '@lexical/extension';
import {LinkExtension} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $getRoot,
  $isLineBreakNode,
  $isTabNode,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';

test('HTML code paste flattens rich blocks into code lines in the DOM', () => {
  const contentEditable = document.createElement('div');
  contentEditable.contentEditable = 'true';
  document.body.appendChild(contentEditable);
  const editor = buildEditorFromExtensions({
    dependencies: [
      RichTextExtension,
      LinkExtension,
      CodeExtension,
      ClipboardDOMImportExtension,
    ],
    name: 'code-content-import',
  });
  editor.setRootElement(contentEditable);
  onTestFinished(() => {
    editor.setRootElement(null);
    contentEditable.remove();
    editor.dispose();
  });
  contentEditable.focus();
  editor.update(
    () => $getRoot().clear().append($createParagraphNode()).selectEnd(),
    {discrete: true},
  );

  const event = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: new DataTransfer(),
  });
  // Firefox creates its own clipboardData instead of using the supplied one.
  assert(event.clipboardData);
  event.clipboardData.setData(
    'text/html',
    '<pre><h2>heading</h2><p><a href="https://example.com">linked</a>\tend<br>tail</p></pre>',
  );
  contentEditable.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);

  editor.read(() => {
    const code = $getRoot().getFirstChild();
    assert($isCodeNode(code));
    expect.soft(code.getTextContent()).toBe('heading\nlinked\tend\ntail');
    expect
      .soft(
        code
          .getChildren()
          .every(
            child =>
              $isCodeHighlightNode(child) ||
              $isTabNode(child) ||
              $isLineBreakNode(child),
          ),
      )
      .toBe(true);
    expect.soft(code.getChildren().filter($isTabNode)).toHaveLength(1);
  });

  const codeDOM = contentEditable.querySelector('code');
  assert(codeDOM);
  expect.soft(codeDOM.querySelector('h2, p, a')).toBeNull();
  expect.soft(codeDOM.querySelectorAll('br')).toHaveLength(2);
  expect
    .soft(Array.from(codeDOM.children, child => child.tagName))
    .toEqual(['SPAN', 'BR', 'SPAN', 'SPAN', 'SPAN', 'BR', 'SPAN']);
  expect(
    Array.from(codeDOM.querySelectorAll('span'), span => span.textContent),
  ).toEqual(['heading', 'linked', '\t', 'end', 'tail']);
});
