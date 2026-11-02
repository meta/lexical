/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  createEditor,
  type LexicalEditor,
  type LexicalNode,
  RootNode,
  type TextNode,
} from 'lexical';
import {afterEach, describe, expect, test, vi} from 'vitest';

function createHeadlessEditor(paragraphs: number): LexicalEditor {
  const editor = createEditor({
    onError: e => {
      throw e;
    },
  });
  editor.update(
    () => {
      for (let i = 0; i < paragraphs; i++) {
        $getRoot().append(
          $createParagraphNode().append($createTextNode(`para ${i}`)),
        );
      }
    },
    {discrete: true},
  );
  return editor;
}

function $firstText(paragraph: LexicalNode | null): TextNode {
  const text = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
  if (!$isTextNode(text)) {
    throw new Error('expected a paragraph with text');
  }
  return text;
}

/** Prepend "x" to the text of paragraph `index`. */
function edit(editor: LexicalEditor, index: number) {
  editor.update(
    () => {
      const text = $firstText($getRoot().getChildAtIndex(index));
      text.setTextContent('x' + text.getTextContent());
    },
    {discrete: true},
  );
}

describe('text content listeners in a headless editor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a commit computes no document text while nothing listens', () => {
    const editor = createHeadlessEditor(100);
    const getTextContent = vi.spyOn(RootNode.prototype, 'getTextContent');
    for (let i = 0; i < 20; i++) {
      edit(editor, i);
    }
    expect(getTextContent).not.toHaveBeenCalled();
  });

  test('a listener still gets each change of the text, and only those', () => {
    const editor = createHeadlessEditor(3);
    const listener = vi.fn();
    const unregister = editor.registerTextContentListener(listener);
    edit(editor, 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith('para 0\n\nxpara 1\n\npara 2');
    // A change that leaves the text as it was
    editor.update(
      () => {
        $firstText($getRoot().getFirstChild()).toggleFormat('bold');
      },
      {discrete: true},
    );
    expect(listener).toHaveBeenCalledTimes(1);
    unregister();
    const getTextContent = vi.spyOn(RootNode.prototype, 'getTextContent');
    edit(editor, 2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getTextContent).not.toHaveBeenCalled();
  });
});
