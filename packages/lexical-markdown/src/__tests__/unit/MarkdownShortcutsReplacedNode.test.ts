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
import {$isHeadingNode} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {MarkdownTestExtension} from '../utils';

/**
 * An editor with the markdown shortcuts and, ahead of their listener, one
 * that can read the document again once (every node anew, under a new key),
 * the way a collaboration binding that rebuilds the editor state does.
 */
function editorReadingAgainOnce() {
  const errors: unknown[] = [];
  const state = {readAgainNext: false};
  const ReadAgainExtension = defineExtension({
    name: 'test/read-again',
    register: editor =>
      editor.registerUpdateListener(({editorState}) => {
        if (!state.readAgainNext) {
          return;
        }
        state.readAgainNext = false;
        editor.setEditorState(
          editor.parseEditorState(JSON.stringify(editorState.toJSON())),
        );
      }),
  });
  const editor = buildEditorFromExtensions(
    defineExtension({
      // A dependency registers first, so its listener runs ahead of the
      // shortcut listener, which then reads a node the editor no longer has.
      dependencies: [MarkdownTestExtension, ReadAgainExtension],
      name: 'test/markdown-shortcuts-read-again',
      onError: error => {
        errors.push(error);
      },
      register: target => registerMarkdownShortcuts(target),
    }),
  );
  return {editor, errors, state};
}

function startWith(editor: LexicalEditor, text: string): void {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const node = $createTextNode(text);
      root.append($createParagraphNode().append(node));
      node.select(text.length, text.length);
    },
    {discrete: true},
  );
}

function type(editor: LexicalEditor, character: string): void {
  editor.update(
    () => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.insertText(character);
      }
    },
    {discrete: true},
  );
}

describe('registerMarkdownShortcuts', () => {
  it('skips the shortcut, with no error, when the editor read the document again before its update ran', () => {
    const {editor, errors, state} = editorReadingAgainOnce();
    using _editor = editor;
    startWith(editor, '#');
    state.readAgainNext = true;
    type(editor, ' ');
    expect(errors).toEqual([]);
    expect(
      editor.read(() =>
        $getRoot()
          .getChildren()
          .map(node => [node.getType(), node.getTextContent()]),
      ),
    ).toEqual([['paragraph', '# ']]);
  });

  it('transforms on the next keystroke in the node the editor read again', () => {
    const {editor, errors, state} = editorReadingAgainOnce();
    using _editor = editor;
    startWith(editor, '#');
    state.readAgainNext = true;
    type(editor, ' ');
    // Back in the text node read again (the new editor state has no
    // selection): delete the space and type it again.
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChild();
        const node = $isElementNode(paragraph)
          ? paragraph.getFirstChild()
          : null;
        if ($isTextNode(node)) {
          node.select(1, 2);
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.removeText();
          }
        }
      },
      {discrete: true},
    );
    type(editor, ' ');
    expect(errors).toEqual([]);
    expect(editor.read(() => $isHeadingNode($getRoot().getFirstChild()))).toBe(
      true,
    );
  });
});
