/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$isCodeNode} from '@lexical/code-core';
import {buildEditorFromExtensions} from '@lexical/extension';
import {registerMarkdownShortcuts} from '@lexical/markdown';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {MarkdownTestExtension} from '../utils';

const CodeBlockShortcutTestExtension = defineExtension({
  dependencies: [MarkdownTestExtension],
  name: 'CodeBlockShortcutTest',
  register: editor => registerMarkdownShortcuts(editor),
});

/** Types each character in its own discrete update, firing the shortcut listener. */
function type(editor: LexicalEditor, text: string): void {
  for (const character of text) {
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
}

function typeBefore(
  existing: string,
  shortcut: string,
): {language: string | null | undefined; text: string} | null {
  using editor = buildEditorFromExtensions([CodeBlockShortcutTestExtension]);
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      const text = $createTextNode(existing);
      paragraph.append(text);
      root.append(paragraph);
      text.select(0, 0);
    },
    {discrete: true},
  );

  type(editor, shortcut);

  return editor.read(() => {
    const first = $getRoot().getFirstChild();
    return $isCodeNode(first)
      ? {language: first.getLanguage(), text: first.getTextContent()}
      : null;
  });
}

describe('code block shortcut', () => {
  it('transforms with "``` " typed before existing text', () => {
    expect(typeBefore('const x = 1;', '``` ')).toEqual({
      language: undefined,
      text: 'const x = 1;',
    });
  });

  it('transforms with "```js " typed before existing text', () => {
    expect(typeBefore('const x = 1;', '```js ')).toEqual({
      language: 'js',
      text: 'const x = 1;',
    });
  });

  it('transforms with "``` " typed in an empty paragraph', () => {
    expect(typeBefore('', '``` ')).toEqual({
      language: undefined,
      text: '',
    });
  });
});
