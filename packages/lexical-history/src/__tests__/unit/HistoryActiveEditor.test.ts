/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $create,
  $createParagraphNode,
  $getEditor,
  $getRoot,
  COMPOSITION_END_TAG,
  COMPOSITION_START_TAG,
  configExtension,
  type LexicalEditor,
  type SerializedTextNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

// exportJSON can depend on the editor, e.g. to read an extension's config
// (https://github.com/meta/lexical/issues/9934).
class EditorReadingTextNode extends TextNode {
  $config() {
    return this.config('editor-reading-text', {extends: TextNode});
  }

  exportJSON(): SerializedTextNode {
    $getEditor();
    return super.exportJSON();
  }
}

function createEditor() {
  const editor = buildEditorFromExtensions({
    dependencies: [
      configExtension(HistoryExtension, {
        delay: 1000,
        disabled: false,
        now: () => 0,
      }),
    ],
    name: 'test',
    nodes: [EditorReadingTextNode],
  });
  onTestFinished(() => editor.dispose());
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append(
            $create(EditorReadingTextNode).setTextContent('ab'),
          ),
        );
    },
    {discrete: true},
  );
  return editor;
}

function undoDepth(editor: LexicalEditor): number {
  return getExtensionDependencyFromEditor(
    editor,
    HistoryExtension,
  ).output.historyState.peek().undoStack.length;
}

function $markTextDirty() {
  $getRoot().getAllTextNodes()[0].markDirty();
}

describe('HistoryExtension serializes nodes with the active editor', () => {
  test('when an unchanged TextNode is the only dirty leaf', () => {
    const editor = createEditor();
    const depth = undoDepth(editor);
    editor.update($markTextDirty, {discrete: true});
    // Unchanged, so merged into the current entry rather than pushed.
    expect(undoDepth(editor)).toBe(depth);
    expect(editor.read(() => $getRoot().getTextContent())).toBe('ab');
  });

  test('when a composition ends without changing its nodes', () => {
    const editor = createEditor();
    const depth = undoDepth(editor);
    editor.update($markTextDirty, {
      discrete: true,
      tag: COMPOSITION_START_TAG,
    });
    editor.update($markTextDirty, {discrete: true, tag: COMPOSITION_END_TAG});
    expect(undoDepth(editor)).toBe(depth);
    expect(editor.read(() => $getRoot().getTextContent())).toBe('ab');
  });
});
