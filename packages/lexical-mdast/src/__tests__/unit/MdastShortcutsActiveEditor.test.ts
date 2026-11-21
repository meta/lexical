/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $create,
  $createParagraphNode,
  $getEditor,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  defineExtension,
  TextNode,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';

import {MdastCommonMarkExtension, MdastShortcutsExtension} from '../../index';

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

describe('MdastShortcutsExtension reads nodes with the active editor', () => {
  test('when reading the typed character', () => {
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [MdastCommonMarkExtension, MdastShortcutsExtension],
        name: '[root]',
        nodes: [EditorReadingTextNode],
      }),
    );
    onTestFinished(() => editor.dispose());
    editor.update(
      () => {
        const custom = $create(EditorReadingTextNode).setTextContent('ab');
        $getRoot().clear().append($createParagraphNode().append(custom));
        custom.selectEnd();
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        selection.insertText('*');
      },
      {discrete: true},
    );
    expect(editor.read(() => $getRoot().getTextContent())).toBe('ab*');
  });
});
