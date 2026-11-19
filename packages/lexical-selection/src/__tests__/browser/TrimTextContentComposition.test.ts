/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {$trimTextContentFromAnchor} from '@lexical/selection';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
  RootNode,
} from 'lexical';
import {compose} from 'lexical/src/__tests__/browser/utils/compose';
import {describe, expect, onTestFinished, test} from 'vitest';

// While a composition is in progress, the editor commits the text being
// composed (and, when it starts on an element point such as an empty
// paragraph, a placeholder character inserted for it). Trimming the text the
// composition commits must not "revert" the node to that state, which holds
// text the user never wrote.

function createEditor(
  maxLength: number,
  $initialEditorState: () => void,
): LexicalEditor {
  const editor = buildEditorFromExtensions({
    $initialEditorState,
    dependencies: [RichTextExtension],
    name: 'test',
  });
  // The trimming of the playground's MaxLengthPlugin, left alone while a
  // composition is in progress
  editor.registerNodeTransform(RootNode, rootNode => {
    const selection = $getSelection();
    if (
      editor.isComposing() ||
      !$isRangeSelection(selection) ||
      !selection.isCollapsed()
    ) {
      return;
    }
    const deleteCount = rootNode.getTextContentSize() - maxLength;
    if (deleteCount > 0) {
      $trimTextContentFromAnchor(editor, selection.anchor, deleteCount);
    }
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.setRootElement(null);
    document.body.removeChild(root);
    editor.dispose();
  });
  return editor;
}

async function focusAt(
  rootElement: HTMLElement,
  where: 'paragraph' | 'text-end',
): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
  rootElement.focus();
  const selection = document.getSelection()!;
  const textSpan = rootElement.querySelector('[data-lexical-text]');
  if (where === 'text-end' && textSpan?.firstChild instanceof Text) {
    selection.collapse(
      textSpan.firstChild,
      textSpan.firstChild.nodeValue!.length,
    );
  } else {
    selection.collapse(rootElement.querySelector('p')!, 0);
  }
  await new Promise(r => setTimeout(r, 0));
}

describe('$trimTextContentFromAnchor after a composition', () => {
  test('trims text composed into an empty paragraph to the limit', async () => {
    const editor = createEditor(2, () => {
      $getRoot().append($createParagraphNode());
    });
    const rootElement = editor.getRootElement()!;
    await focusAt(rootElement, 'paragraph');

    await compose(
      {editor, rootElement},
      {
        commitText: '日本語',
        steps: [{text: 'に'}, {text: 'にほ'}],
      },
    );

    expect(editor.read(() => $getRoot().getTextContent())).toBe('日本');
  });

  test('trims text composed at the end of existing text to the limit', async () => {
    const editor = createEditor(3, () => {
      $getRoot().append($createParagraphNode().append($createTextNode('ab')));
    });
    const rootElement = editor.getRootElement()!;
    await focusAt(rootElement, 'text-end');

    await compose(
      {editor, rootElement},
      {
        commitText: '日本',
        steps: [{text: 'に'}],
      },
    );

    expect(editor.read(() => $getRoot().getTextContent())).toBe('ab日');
  });
});
