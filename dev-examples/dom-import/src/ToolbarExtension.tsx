/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ReactNode} from 'react';

import {batch, signal} from '@lexical/extension';
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from '@lexical/list';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useExtensionSignalValue} from '@lexical/react/useExtensionSignalValue';
import {INSERT_TABLE_COMMAND} from '@lexical/table';
import {mergeRegister} from '@lexical/utils';
import {
  $getSelection,
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  defineExtension,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
} from 'lexical';

/**
 * Owns the toolbar's reactive state as a small set of signals and
 * keeps them in sync with the editor. The React `Toolbar` component
 * reads from these signals via {@link useExtensionSignalValue}, so the
 * editor-side and view-side responsibilities stay separated and the
 * component itself holds no local state.
 */
export const ToolbarExtension = defineExtension({
  build() {
    return {
      canRedo: signal(false),
      canUndo: signal(false),
      isBold: signal(false),
      isItalic: signal(false),
      isStrikethrough: signal(false),
      isUnderline: signal(false),
    };
  },
  name: '@lexical/examples/dom-import/Toolbar',
  register(editor, _config, state) {
    const out = state.getOutput();
    const $sync = () => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        // `batch` coalesces the four writes into a single signal-system
        // notification so subscribers re-render once per sync instead
        // of once per format flip.
        batch(() => {
          out.isBold.value = selection.hasFormat('bold');
          out.isItalic.value = selection.hasFormat('italic');
          out.isUnderline.value = selection.hasFormat('underline');
          out.isStrikethrough.value = selection.hasFormat('strikethrough');
        });
      }
    };
    return mergeRegister(
      editor.registerUpdateListener(({editorState}) =>
        editor.read(editorState, $sync),
      ),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          $sync();
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        CAN_UNDO_COMMAND,
        payload => {
          out.canUndo.value = payload;
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        CAN_REDO_COMMAND,
        payload => {
          out.canRedo.value = payload;
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  },
});

function Divider() {
  return <div className="divider" />;
}

interface ToolbarProps {
  children?: ReactNode;
}

export function Toolbar({children}: ToolbarProps) {
  const [editor] = useLexicalComposerContext();
  const canUndo = useExtensionSignalValue(ToolbarExtension, 'canUndo');
  const canRedo = useExtensionSignalValue(ToolbarExtension, 'canRedo');
  const isBold = useExtensionSignalValue(ToolbarExtension, 'isBold');
  const isItalic = useExtensionSignalValue(ToolbarExtension, 'isItalic');
  const isUnderline = useExtensionSignalValue(ToolbarExtension, 'isUnderline');
  const isStrikethrough = useExtensionSignalValue(
    ToolbarExtension,
    'isStrikethrough',
  );

  return (
    <div className="toolbar">
      <button
        type="button"
        disabled={!canUndo}
        onClick={() => editor.dispatchCommand(UNDO_COMMAND)}
        className="toolbar-item spaced"
        aria-label="Undo">
        ↶
      </button>
      <button
        type="button"
        disabled={!canRedo}
        onClick={() => editor.dispatchCommand(REDO_COMMAND)}
        className="toolbar-item spaced"
        aria-label="Redo">
        ↷
      </button>
      <Divider />
      <button
        type="button"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}
        className={'toolbar-item spaced ' + (isBold ? 'active' : '')}
        aria-label="Bold">
        <b>B</b>
      </button>
      <button
        type="button"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}
        className={'toolbar-item spaced ' + (isItalic ? 'active' : '')}
        aria-label="Italic">
        <i>I</i>
      </button>
      <button
        type="button"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline')}
        className={'toolbar-item spaced ' + (isUnderline ? 'active' : '')}
        aria-label="Underline">
        <u>U</u>
      </button>
      <button
        type="button"
        onClick={() =>
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough')
        }
        className={'toolbar-item spaced ' + (isStrikethrough ? 'active' : '')}
        aria-label="Strikethrough">
        <s>S</s>
      </button>
      <Divider />
      <button
        type="button"
        onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND)}
        className="toolbar-item spaced"
        aria-label="Bullet list">
        •
      </button>
      <button
        type="button"
        onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND)}
        className="toolbar-item spaced"
        aria-label="Numbered list">
        1.
      </button>
      <button
        type="button"
        onClick={() => editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND)}
        className="toolbar-item spaced"
        aria-label="Check list">
        ☑
      </button>
      <button
        type="button"
        onClick={() =>
          editor.dispatchCommand(INSERT_TABLE_COMMAND, {
            columns: '3',
            rows: '3',
          })
        }
        className="toolbar-item spaced"
        aria-label="Insert table">
        ⊞
      </button>
      <Divider />
      {children}
    </div>
  );
}
