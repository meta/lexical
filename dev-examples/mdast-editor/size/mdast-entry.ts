/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Bundle-size probe: the @lexical/mdast markdown stack. Functionally
 * equivalent surface to ./legacy-entry.ts — an editor with the markdown
 * node set, streaming typing shortcuts, and markdown import/export.
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  MdastCommonMarkExtension,
  MdastExtension,
  MdastShortcutsExtension,
  MdastStrikethroughExtension,
  MdastTaskListExtension,
} from '@lexical/mdast';
import {defineExtension, type LexicalEditor} from 'lexical';

export function createMarkdownEditor(): LexicalEditor {
  return buildEditorFromExtensions(
    defineExtension({
      // Feature parity with the legacy TRANSFORMERS set: CommonMark plus
      // strikethrough and task lists (no tables, no literal autolinks).
      dependencies: [
        MdastCommonMarkExtension,
        MdastStrikethroughExtension,
        MdastTaskListExtension,
        MdastShortcutsExtension,
        MdastExtension,
      ],
      name: '[root]',
    }),
  );
}

export function markdownToEditor(
  editor: LexicalEditor,
  markdown: string,
): void {
  editor.update(() => $convertFromMarkdownString(markdown));
}

export function editorToMarkdown(editor: LexicalEditor): string {
  return editor.read(() => $convertToMarkdownString());
}
