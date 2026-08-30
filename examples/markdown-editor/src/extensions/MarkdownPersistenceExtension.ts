/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {effect, getExtensionDependencyFromEditor} from '@lexical/extension';
import {mergeRegister} from '@lexical/utils';
import {
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  defineExtension,
  type LexicalEditor,
  safeCast,
} from 'lexical';

import {MarkdownExtension} from './MarkdownExtension';

export interface MarkdownPersistenceConfig {
  /** localStorage key the markdown document is stored under. */
  storageKey: string;
  /** Markdown to seed the editor with when nothing is stored, and the
   * value the {@link RESET_MARKDOWN_COMMAND} restores. */
  defaultMarkdown: string;
}

/**
 * Resets the document back to the configured default markdown and
 * removes the persisted copy from localStorage.
 */
export const RESET_MARKDOWN_COMMAND = createCommand<void>(
  'RESET_MARKDOWN_COMMAND',
);

function readStoredMarkdown(storageKey: string): string | null {
  if (typeof window === 'undefined' || storageKey === '') {
    return null;
  }
  return window.localStorage.getItem(storageKey);
}

function $loadMarkdown(editor: LexicalEditor): void {
  const persistence = getExtensionDependencyFromEditor(
    editor,
    MarkdownPersistenceExtension,
  ).config;
  const {$fromString} = getExtensionDependencyFromEditor(
    editor,
    MarkdownExtension,
  ).output;
  const stored = readStoredMarkdown(persistence.storageKey);
  $fromString(stored ?? persistence.defaultMarkdown);
}

/**
 * Owns the localStorage <-> editor markdown sync:
 *
 * - Provides the editor's `$initialEditorState` so the document is
 *   seeded from `localStorage[storageKey]` (falling back to
 *   `defaultMarkdown`) without needing a bootstrap update in
 *   `register`.
 * - Persists the markdown output signal back to localStorage on every
 *   change.
 * - Registers {@link RESET_MARKDOWN_COMMAND} which clears the storage
 *   entry and re-imports the default markdown.
 */
export const MarkdownPersistenceExtension = defineExtension({
  $initialEditorState: $loadMarkdown,
  config: safeCast<MarkdownPersistenceConfig>({
    defaultMarkdown: '',
    storageKey: '',
  }),
  dependencies: [MarkdownExtension],
  name: '@lexical/markdown-editor-example/MarkdownPersistence',
  register(editor, {storageKey, defaultMarkdown}, state) {
    const {markdown, $fromString} =
      state.getDependency(MarkdownExtension).output;
    const hasStorage = typeof window !== 'undefined' && storageKey !== '';

    let initial = true;
    return mergeRegister(
      effect(() => {
        const value = markdown.value;
        if (initial) {
          initial = false;
          return;
        }
        if (hasStorage) {
          window.localStorage.setItem(storageKey, value);
        }
      }),
      editor.registerCommand(
        RESET_MARKDOWN_COMMAND,
        () => {
          if (hasStorage) {
            window.localStorage.removeItem(storageKey);
          }
          $fromString(defaultMarkdown);
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
  },
});
