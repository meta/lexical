/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {serializedDocumentFromEditorState} from '@lexical/file';
import {
  $create,
  $createParagraphNode,
  $getEditor,
  $getRoot,
  type SerializedTextNode,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// exportJSON can depend on the editor, e.g. to read an extension's config
// (https://github.com/meta/lexical/issues/9934).
class EditorReadingTextNode extends TextNode {
  $config() {
    return this.config('editor-reading-text', {extends: TextNode});
  }

  exportJSON(): SerializedTextNode {
    return {...super.exportJSON(), text: $getEditor().getKey()};
  }
}

describe('serializedDocumentFromEditorState', () => {
  test('exports with the given editor active', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        name: 'editor-reading-file',
        nodes: [EditorReadingTextNode],
      }),
    );
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($create(EditorReadingTextNode)),
          );
      },
      {discrete: true},
    );
    const {editorState} = serializedDocumentFromEditorState(
      editor.getEditorState(),
      {editor, lastSaved: 1},
    );
    expect(editorState.root.children).toMatchObject([
      {children: [{text: editor.getKey()}]},
    ]);
  });
});
