/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getEditor,
  defineExtension,
  type LexicalEditor,
  safeCast,
} from 'lexical';

import {LexicalBuilder} from './LexicalBuilder';
import {namedSignals} from './namedSignals';
import {effect} from './signals';

export interface NestedEditorConfig {
  $getParentEditor: () => LexicalEditor;
  inheritEditableFromParent: boolean;
}

function $defaultGetParentEditor() {
  const editor = $getEditor();
  LexicalBuilder.fromEditor(editor);
  return editor;
}

export const NestedEditorExtension = defineExtension({
  build: (editor, config) =>
    namedSignals({inheritEditableFromParent: config.inheritEditableFromParent}),
  config: safeCast<NestedEditorConfig>({
    $getParentEditor: $defaultGetParentEditor,
    inheritEditableFromParent: false,
  }),
  init: (editorConfig, config, state) => {
    const parentEditor = config.$getParentEditor();
    editorConfig.parentEditor = parentEditor;
    editorConfig.theme = editorConfig.theme || parentEditor._config.theme;
  },
  name: '@lexical/extension/NestedEditor',
  register: (editor, config, state) =>
    effect(() => {
      const parentEditor = editor._parentEditor;
      if (parentEditor) {
        if (state.getOutput().inheritEditableFromParent.value) {
          editor.setEditable(parentEditor.isEditable());
          return parentEditor.registerEditableListener(
            editor.setEditable.bind(editor),
          );
        }
      }
    }),
});
