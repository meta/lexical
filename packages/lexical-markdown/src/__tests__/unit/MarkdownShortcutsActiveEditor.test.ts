/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {registerMarkdownShortcuts} from '@lexical/markdown';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getEditor,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMPOSITION_END_TAG,
  defineExtension,
  type LexicalEditor,
  TextNode,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';

import {MarkdownTestExtension} from '../utils';

// getTextContent can depend on the editor, e.g. to read an extension's config
// (https://github.com/meta/lexical/issues/9934).
class EditorReadingTextNode extends TextNode {
  $config() {
    return this.config('editor-reading-text', {extends: TextNode});
  }

  getTextContent(): string {
    $getEditor();
    return super.getTextContent();
  }
}

const ShortcutsTestExtension = defineExtension({
  dependencies: [MarkdownTestExtension],
  name: 'ShortcutsActiveEditorTest',
  nodes: [EditorReadingTextNode],
  register: editor => registerMarkdownShortcuts(editor),
});

function createEditor(after: string): LexicalEditor {
  const editor = buildEditorFromExtensions([ShortcutsTestExtension]);
  onTestFinished(() => editor.dispose());
  editor.update(
    () => {
      const custom = $create(EditorReadingTextNode).setTextContent('ab');
      const paragraph = $createParagraphNode().append(custom);
      $getRoot().clear().append(paragraph);
      if (after === '') {
        custom.selectEnd();
      } else {
        const text = $createTextNode(after);
        paragraph.append(text);
        text.selectEnd();
      }
    },
    {discrete: true},
  );
  return editor;
}

function type(editor: LexicalEditor, text: string, tag?: string): void {
  editor.update(
    () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      selection.insertText(text);
    },
    {discrete: true, tag},
  );
}

describe('registerMarkdownShortcuts reads nodes with the active editor', () => {
  test('when measuring the text before the caret', () => {
    const editor = createEditor('cd');
    type(editor, 'e');
    expect(editor.read(() => $getRoot().getTextContent())).toBe('abcde');
  });

  test('when a composition ends', () => {
    const editor = createEditor('');
    type(editor, '*', COMPOSITION_END_TAG);
    expect(editor.read(() => $getRoot().getTextContent())).toBe('ab*');
  });
});
