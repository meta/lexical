/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from 'lexical';

import {$isRootTextContentEmptyCurry} from '@lexical/text';
import {useState} from 'react';

import useLayoutEffect from './shared/useLayoutEffect';

/**
 * Tracks whether the editor's text content is empty, updating as the editor
 * changes. Pass `trim` to ignore leading and trailing whitespace when deciding
 * emptiness.
 *
 * @returns `true` while the editor's text content is empty.
 */
export function useLexicalIsTextContentEmpty(
  editor: LexicalEditor,
  trim?: boolean,
): boolean {
  const [isEmpty, setIsEmpty] = useState(() =>
    editor.read(
      'latest',
      $isRootTextContentEmptyCurry(editor.isComposing(), trim),
    ),
  );

  useLayoutEffect(() => {
    function resetIsEmpty() {
      setIsEmpty(
        editor.read(
          'latest',
          $isRootTextContentEmptyCurry(editor.isComposing(), trim),
        ),
      );
    }
    // The state was seeded on the first render only, so re-derive it whenever
    // the inputs the effect depends on change -- otherwise a new editor or a
    // new trim keeps reporting the previous answer until the next update.
    resetIsEmpty();
    return editor.registerUpdateListener(({editorState}) => {
      const isComposing = editor.isComposing();
      const currentIsEmpty = editorState.read(
        $isRootTextContentEmptyCurry(isComposing, trim),
      );
      setIsEmpty(currentIsEmpty);
    });
  }, [editor, trim]);

  return isEmpty;
}
