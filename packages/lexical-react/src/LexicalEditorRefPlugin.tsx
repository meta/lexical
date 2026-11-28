/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from 'lexical';
import type {RefObject} from 'react';

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import * as React from 'react';

/**
 *
 * Use this plugin to access the editor instance outside of the
 * LexicalComposer. This can help with things like buttons or other
 * UI components that need to update or read EditorState but need to
 * be positioned outside the LexicalComposer in the React tree.
 */
export function EditorRefPlugin({
  editorRef,
}: {
  editorRef:
    | React.RefCallback<LexicalEditor>
    | RefObject<LexicalEditor | null | undefined>;
}): null {
  const [editor] = useLexicalComposerContext();

  React.useLayoutEffect(() => {
    if (typeof editorRef === 'function') {
      editorRef(editor);
    } else if (typeof editorRef === 'object' && editorRef !== null) {
      // eslint-disable-next-line react-hooks/immutability
      editorRef.current = editor;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return null;
}
