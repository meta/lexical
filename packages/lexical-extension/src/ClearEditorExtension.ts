/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  CLEAR_EDITOR_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  defineExtension,
  type LexicalEditor,
  safeCast,
} from 'lexical';

import {namedSignals} from './namedSignals';
import {effect} from './signals';

function $defaultOnClear() {
  const root = $getRoot();
  const selection = $getSelection();
  const paragraph = $createParagraphNode();
  root.clear();
  root.append(paragraph);

  if (selection !== null) {
    paragraph.select();
  }
  if ($isRangeSelection(selection)) {
    selection.format = 0;
  }
}

export interface ClearEditorConfig {
  $onClear: () => void;
}

export function registerClearEditor(
  editor: LexicalEditor,
  $onClear: () => void = $defaultOnClear,
): () => void {
  return editor.registerCommand(
    CLEAR_EDITOR_COMMAND,
    () => {
      // Command listeners already run in an update context. Wrapping
      // $onClear in editor.update() would queue it as a nested update when
      // the command is dispatched from inside another update, running it
      // after the rest of that update's callback instead of inline here.
      $onClear();
      return true;
    },
    COMMAND_PRIORITY_EDITOR,
  );
}

/**
 * An extension to provide an implementation of {@link CLEAR_EDITOR_COMMAND}
 */
export const ClearEditorExtension = defineExtension({
  build(editor, config, state) {
    return namedSignals(config);
  },
  config: safeCast<ClearEditorConfig>({
    $onClear: $defaultOnClear,
  }),
  name: '@lexical/extension/ClearEditor',
  register(editor, config, state) {
    const {$onClear} = state.getOutput();
    return effect(() => registerClearEditor(editor, $onClear.value));
  },
});
