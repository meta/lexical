/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  $getRoot,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  type LexicalEditor,
} from 'lexical';

const LAZY_LOADED_LOWERCASE_COMMAND = createCommand<undefined>(
  'LAZY_LOADED_LOWERCASE_COMMAND',
);

export function registerLazyLoaded(editor: LexicalEditor): () => void {
  const button = document.createElement('button');
  button.textContent = 'LAZY_LOADED_LOWERCASE_COMMAND';
  button.className = 'cursor-pointer bg-blue-500 text-white px-4 py-2 rounded';
  button.onclick = () =>
    editor.dispatchCommand(LAZY_LOADED_LOWERCASE_COMMAND, undefined);
  const el = document.getElementById('lazy-loaded');
  if (el) {
    el.appendChild(button);
  }
  const unregisterCommand = editor.registerCommand(
    LAZY_LOADED_LOWERCASE_COMMAND,
    () => {
      for (const node of $getRoot().getAllTextNodes()) {
        const text = node.getTextContent();
        const lower = text.toLowerCase();
        if (text !== lower) {
          node.setTextContent(lower);
        }
      }
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  );
  return () => {
    button.remove();
    unregisterCommand();
  };
}
