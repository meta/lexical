/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {defineExtension} from 'lexical';

import {watchedSignal} from './watchedSignal';

/**
 * An extension to provide the current EditorState as a signal
 */
export const EditorStateExtension = defineExtension({
  build(editor) {
    return watchedSignal(
      () => editor.getEditorState(),
      editorStateSignal =>
        editor.registerUpdateListener(payload => {
          editorStateSignal.value = payload.editorState;
        }),
    );
  },
  name: '@lexical/extension/EditorState',
});
