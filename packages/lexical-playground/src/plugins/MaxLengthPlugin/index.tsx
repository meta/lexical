/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {effect, namedSignals} from '@lexical/extension';
import {$trimTextContentFromAnchor} from '@lexical/selection';
import {$restoreEditorState} from '@lexical/utils';
import {
  $getSelection,
  $isRangeSelection,
  defineExtension,
  type EditorState,
  RootNode,
  safeCast,
} from 'lexical';

export interface MaxLengthConfig {
  disabled: boolean;
  maxLength: number;
}

export const MaxLengthExtension = defineExtension({
  build: (editor, config) => namedSignals(config),
  config: safeCast<MaxLengthConfig>({
    disabled: true,
    maxLength: 30,
  }),
  name: '@lexical/playground/MaxLength',
  register: (editor, config, state) =>
    effect(() => {
      const output = state.getOutput();
      if (output.disabled.value) {
        return;
      }
      const maxLength = output.maxLength.value;
      let lastRestoredEditorState: EditorState | null = null;
      return editor.registerNodeTransform(RootNode, (rootNode: RootNode) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return;
        }
        const prevEditorState = editor.getEditorState();
        const prevTextContentSize = prevEditorState.read(() =>
          rootNode.getTextContentSize(),
        );
        const textContentSize = rootNode.getTextContentSize();
        if (prevTextContentSize !== textContentSize) {
          const delCount = textContentSize - maxLength;
          const anchor = selection.anchor;

          if (delCount > 0) {
            // Restore the old editor state instead if the last
            // text content was already at the limit.
            if (
              prevTextContentSize === maxLength &&
              lastRestoredEditorState !== prevEditorState
            ) {
              lastRestoredEditorState = prevEditorState;
              $restoreEditorState(editor, prevEditorState);
            } else {
              $trimTextContentFromAnchor(editor, anchor, delCount);
            }
          }
        }
      });
    }),
});
