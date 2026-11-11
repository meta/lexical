/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Text typed at the edge of an inline element that keeps ElementNode's default
 * canInsertTextBefore()/canInsertTextAfter() (true) stays inside the element,
 * including when typing goes through RangeSelection.insertText because of a
 * pending format or a selection that is replaced.
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  ElementNode,
  FORMAT_TEXT_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

class AllowTextInlineNode extends ElementNode {
  $config() {
    return this.config('test_edge_typing_inline', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): false {
    return false;
  }
  isInline(): true {
    return true;
  }
}

function setUpEditor(): LexicalEditor {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $create(AllowTextInlineNode).append($createTextNode('ab')),
            ),
          );
      },
      dependencies: [RichTextExtension],
      name: '[inline-element-edge-typing]',
      nodes: [AllowTextInlineNode],
    }),
  );
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  root.focus();
  return editor;
}

function selectInlineText(
  editor: LexicalEditor,
  anchorOffset: number,
  focusOffset: number,
): void {
  editor.update(
    () => {
      const text = $getRoot().getFirstDescendant();
      assert($isTextNode(text), 'Expected the text node');
      text.select(anchorOffset, focusOffset);
    },
    {discrete: true},
  );
}

function readParagraph(editor: LexicalEditor) {
  return editor.read('latest', () => {
    const paragraph = $getRoot().getFirstChild();
    assert($isElementNode(paragraph), 'Expected the paragraph');
    return paragraph.getChildren().map(child => ({
      text: child.getTextContent(),
      type: child.getType(),
      ...($isElementNode(child)
        ? {
            bold: child
              .getChildren()
              .map(t => $isTextNode(t) && t.hasFormat('bold')),
          }
        : {}),
    }));
  });
}

test('typing after toggling a format at the end of an inline element keeps the text inside it', async () => {
  const editor = setUpEditor();
  selectInlineText(editor, 2, 2);
  editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
  await userEvent.keyboard('x');
  await expect
    .poll(() => readParagraph(editor))
    .toEqual([
      {bold: [false, true], text: 'abx', type: 'test_edge_typing_inline'},
    ]);
});

test('retyping a selection that ends at the edge of an inline element keeps the text inside it', async () => {
  const editor = setUpEditor();
  selectInlineText(editor, 1, 2);
  await userEvent.keyboard('x');
  await expect
    .poll(() => readParagraph(editor))
    .toEqual([{bold: [false], text: 'ax', type: 'test_edge_typing_inline'}]);
});
