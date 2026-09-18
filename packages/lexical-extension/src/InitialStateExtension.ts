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
  $isEditorState,
  defineExtension,
  type EditorSetOptions,
  type EditorUpdateOptions,
  HISTORY_MERGE_TAG,
  LineBreakNode,
  ParagraphNode,
  RootNode,
  safeCast,
  type SerializedEditorState,
  TabNode,
  TextNode,
} from 'lexical';

const HISTORY_MERGE_OPTIONS = {tag: HISTORY_MERGE_TAG};

function $defaultInitializer() {
  const root = $getRoot();
  if (root.isEmpty()) {
    root.append($createParagraphNode());
  }
}

export interface InitialStateConfig {
  updateOptions: EditorUpdateOptions;
  setOptions: EditorSetOptions;
}

/**
 * An extension to set the initial state of the editor from
 * a function or serialized JSON EditorState. This is
 * implicitly included with all editors built with
 * Lexical Extension. This happens in the `afterRegistration`
 * phase so your initial state may depend on registered commands,
 * but you should not call `editor.setRootElement` earlier than
 * this phase to avoid rendering an empty editor first.
 */
export const InitialStateExtension = defineExtension({
  config: safeCast<InitialStateConfig>({
    setOptions: HISTORY_MERGE_OPTIONS,
    updateOptions: HISTORY_MERGE_OPTIONS,
  }),

  init({$initialEditorState = $defaultInitializer}) {
    return {$initialEditorState, initialized: false};
  },

  // eslint-disable-next-line sort-keys-fix/sort-keys-fix -- typescript inference is order dependent here for some reason
  afterRegistration(editor, {updateOptions, setOptions}, state) {
    const initResult = state.getInitResult();
    if (!initResult.initialized) {
      initResult.initialized = true;
      const {$initialEditorState} = initResult;
      if ($isEditorState($initialEditorState)) {
        editor.setEditorState($initialEditorState, setOptions);
      } else if (typeof $initialEditorState === 'function') {
        editor.update(() => {
          $initialEditorState(editor);
        }, updateOptions);
      } else if (
        $initialEditorState &&
        (typeof $initialEditorState === 'string' ||
          typeof $initialEditorState === 'object')
      ) {
        const parsedEditorState = editor.parseEditorState(
          $initialEditorState as string | SerializedEditorState,
        );
        editor.setEditorState(parsedEditorState, setOptions);
      }
    }
    return () => {};
  },

  name: '@lexical/extension/InitialState',
  // These are automatically added by createEditor, we add them here so they are
  // visible during extensionRep.init so extensions can see all known types before the
  // editor is created.
  // (excluding ArtificialNode__DO_NOT_USE because it isn't really public API
  // and shouldn't change anything)
  nodes: [RootNode, TextNode, LineBreakNode, TabNode, ParagraphNode],
});
