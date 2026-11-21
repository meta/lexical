/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  CLEAR_EDITOR_COMMAND,
  COMMAND_PRIORITY_LOW,
  type EditorState,
  KEY_ENTER_COMMAND,
} from 'lexical';
import {useEffect} from 'react';

interface SubmitOnEnterPluginProps {
  onSubmit: (editorState: EditorState) => void;
}

export function SubmitOnEnterPlugin({onSubmit}: SubmitOnEnterPluginProps) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      event => {
        if (event !== null && event.shiftKey) {
          return false;
        }
        if (event !== null) {
          event.preventDefault();
        }
        // The committed state, which is also what onSubmit receives.
        const hasContent = editor.read(
          'latest',
          () => $getRoot().getTextContent().trim() !== '',
        );
        if (hasContent) {
          onSubmit(editor.getEditorState());
          editor.dispatchCommand(CLEAR_EDITOR_COMMAND, undefined);
        }
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, onSubmit]);

  return null;
}
