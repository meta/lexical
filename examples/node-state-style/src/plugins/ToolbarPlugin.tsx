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
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
} from 'lexical';

import {
  $selectionHasStyle,
  NO_STYLE,
  PATCH_TEXT_STYLE_COMMAND,
} from '../styleState';

function Divider() {
  return <div className="divider" />;
}

/**
 * Owns the toolbar's reactive state as a handful of signals and keeps
 * them in sync with the editor. The React `ToolbarPlugin` reads via
 * {@link useExtensionSignalValue} — no local React state. `canUndo` /
 * `canRedo` come straight from `HistoryExtension` so this extension
 * only owns the format / style flags.
 */
export const ToolbarExtension = defineExtension({
  build() {
    return {
      isBold: signal(false),
      isItalic: signal(false),
      isStrikethrough: signal(false),
      isStyled: signal(false),
      isUnderline: signal(false),
    };
  },
  dependencies: [HistoryExtension],
  name: '@lexical/examples/node-state-style/Toolbar',
  register(editor, _config, state) {
    const out = state.getOutput();
    const $sync = () => {
      const selection = $getSelection();
      batch(() => {
        out.isStyled.value = $selectionHasStyle();
        if ($isRangeSelection(selection)) {
          out.isBold.value = selection.hasFormat('bold');
          out.isItalic.value = selection.hasFormat('italic');
          out.isUnderline.value = selection.hasFormat('underline');
          out.isStrikethrough.value = selection.hasFormat('strikethrough');
        }
      });
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
  const isStyled = useExtensionSignalValue(ToolbarExtension, 'isStyled');

  return (
    <div className="toolbar">
      <button
        type="button"
        disabled={!canUndo}
        onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
        className="toolbar-item spaced"
        aria-label="Undo">
        <i className="format undo" />
      </button>
      <button
        type="button"
        disabled={!canRedo}
        onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}
        className="toolbar-item"
        aria-label="Redo">
        <i className="format redo" />
      </button>
      <Divider />
      <button
        type="button"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}
        className={'toolbar-item spaced ' + (isBold ? 'active' : '')}
        aria-label="Format Bold">
        <i className="format bold" />
      </button>
      <button
        type="button"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}
        className={'toolbar-item spaced ' + (isItalic ? 'active' : '')}
        aria-label="Format Italics">
        <i className="format italic" />
      </button>
      <button
        type="button"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline')}
        className={'toolbar-item spaced ' + (isUnderline ? 'active' : '')}
        aria-label="Format Underline">
        <i className="format underline" />
      </button>
      <button
        type="button"
        onClick={() =>
          editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough')
        }
        className={'toolbar-item spaced ' + (isStrikethrough ? 'active' : '')}
        aria-label="Format Strikethrough">
        <i className="format strikethrough" />
      </button>
      <Divider />
      <button
        type="button"
        onClick={() =>
          editor.dispatchCommand(
            PATCH_TEXT_STYLE_COMMAND,
            isStyled
              ? () => NO_STYLE
              : {
                  'text-shadow':
                    '1px 1px 2px red, 0 0 1em blue, 0 0 0.2em blue',
                },
          )
        }
        className="toolbar-item spaced"
        aria-label="Toggle Text Style">
        <i className={'text-shadow ' + (isStyled ? 'active' : '')} />
      </button>
    </div>
  );
}
