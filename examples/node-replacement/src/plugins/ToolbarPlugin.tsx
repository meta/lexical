/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {batch, signal} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useExtensionSignalValue} from '@lexical/react/useExtensionSignalValue';
import {mergeRegister} from '@lexical/utils';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  defineExtension,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
} from 'lexical';

function Divider() {
  return <div className="divider" />;
}

/**
 * Keeps the toolbar's text format flags in signals that the React
 * `ToolbarPlugin` reads with {@link useExtensionSignalValue}. `canUndo` and
 * `canRedo` come straight from `HistoryExtension`.
 */
export const ToolbarExtension = defineExtension({
  build() {
    return {
      isBold: signal(false),
      isItalic: signal(false),
      isStrikethrough: signal(false),
      isUnderline: signal(false),
    };
  },
  dependencies: [HistoryExtension],
  name: '@lexical/examples/node-replacement/Toolbar',
  register(editor, _config, state) {
    const out = state.getOutput();
    const $sync = () => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
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
        editorState.read($sync, {editor}),
      ),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          $sync();
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  },
});

export function ToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const canUndo = useExtensionSignalValue(HistoryExtension, 'canUndo');
  const canRedo = useExtensionSignalValue(HistoryExtension, 'canRedo');
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
        disabled={!canUndo}
        onClick={() => {
          editor.dispatchCommand(UNDO_COMMAND, undefined);
        }}
        className="toolbar-item spaced"
        aria-label="Undo">
        <i className="format undo" />
      </button>
      <button
        disabled={!canRedo}
        onClick={() => {
          editor.dispatchCommand(REDO_COMMAND, undefined);
        }}
        className="toolbar-item"
        aria-label="Redo">
        <i className="format redo" />
      </button>
      <Divider />
      <button
        onClick={() => {
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
        }}
        className={'toolbar-item spaced ' + (isBold ? 'active' : '')}
        aria-label="Format Bold">
        <i className="format bold" />
      </button>
      <button
        onClick={() => {
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic');
        }}
        className={'toolbar-item spaced ' + (isItalic ? 'active' : '')}
        aria-label="Format Italics">
        <i className="format italic" />
      </button>
      <button
        onClick={() => {
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline');
        }}
        className={'toolbar-item spaced ' + (isUnderline ? 'active' : '')}
        aria-label="Format Underline">
        <i className="format underline" />
      </button>
      <button
        onClick={() => {
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough');
        }}
        className={'toolbar-item spaced ' + (isStrikethrough ? 'active' : '')}
        aria-label="Format Strikethrough">
        <i className="format strikethrough" />
      </button>
      <Divider />
      <button
        onClick={() => {
          editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'left');
        }}
        className="toolbar-item spaced"
        aria-label="Left Align">
        <i className="format left-align" />
      </button>
      <button
        onClick={() => {
          editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center');
        }}
        className="toolbar-item spaced"
        aria-label="Center Align">
        <i className="format center-align" />
      </button>
      <button
        onClick={() => {
          editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'right');
        }}
        className="toolbar-item spaced"
        aria-label="Right Align">
        <i className="format right-align" />
      </button>
      <button
        onClick={() => {
          editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'justify');
        }}
        className="toolbar-item"
        aria-label="Justify Align">
        <i className="format justify-align" />
      </button>
    </div>
  );
}
