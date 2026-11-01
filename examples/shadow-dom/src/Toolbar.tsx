/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX, MouseEvent} from 'react';

import {HistoryExtension} from '@lexical/history';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useExtensionSignalValue} from '@lexical/react/useExtensionSignalValue';
import {
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  type TextFormatType,
  UNDO_COMMAND,
} from 'lexical';

/**
 * A toolbar that lives in the *light DOM*, outside the shadow root that hosts
 * the editor. Its buttons dispatch commands that operate on the editor's
 * selection — which lives inside the shadow tree — demonstrating that
 * selection-driven editing works across the shadow boundary.
 */
export default function Toolbar(): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const canUndo = useExtensionSignalValue(HistoryExtension, 'canUndo');
  const canRedo = useExtensionSignalValue(HistoryExtension, 'canRedo');

  // Prevent the button from stealing focus (and clearing the editor selection)
  // when it is clicked.
  const keepEditorFocus = (event: MouseEvent) => event.preventDefault();

  const format = (formatType: TextFormatType) => () =>
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, formatType);

  return (
    <div className="toolbar">
      <button
        type="button"
        onMouseDown={keepEditorFocus}
        onClick={format('bold')}
        aria-label="Bold">
        <b>B</b>
      </button>
      <button
        type="button"
        onMouseDown={keepEditorFocus}
        onClick={format('italic')}
        aria-label="Italic">
        <i>I</i>
      </button>
      <button
        type="button"
        onMouseDown={keepEditorFocus}
        onClick={format('underline')}
        aria-label="Underline">
        <u>U</u>
      </button>
      <span className="toolbar-divider" />
      <button
        type="button"
        disabled={!canUndo}
        onMouseDown={keepEditorFocus}
        onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}>
        Undo
      </button>
      <button
        type="button"
        disabled={!canRedo}
        onMouseDown={keepEditorFocus}
        onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}>
        Redo
      </button>
    </div>
  );
}
