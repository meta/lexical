/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {type LexicalEditor} from 'lexical';
import {useMemo, useSyncExternalStore} from 'react';

export function useRootElement(editor: LexicalEditor) {
  const [subscribe, getSnapshot] = useMemo(
    () => [
      editor.registerRootListener.bind(editor),
      editor.getRootElement.bind(editor),
    ],
    [editor],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
