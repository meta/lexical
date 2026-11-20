/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from 'lexical';

import {useEffect} from 'react';

import {useSettings} from '../context/SettingsContext';

export const COLLAB_Y_NESTED_EDITOR_NOTICE =
  'Collab Y does not sync nested editors, so this text is read only';

/**
 * Collab Y (`@lexical/y`) does not sync nested editors (image
 * captions, sticky notes): only the snapshot taken when their node is written
 * reaches other clients. Rather than let edits diverge silently, the nested
 * editor is read only in that mode. Returns whether it is.
 */
export function useCollabYNestedEditor(nestedEditor: LexicalEditor): boolean {
  const {
    settings: {isCollab, isRichText, useCollabY},
  } = useSettings();
  const isCollabY = isCollab && isRichText && useCollabY;
  useEffect(() => {
    if (isCollabY) {
      nestedEditor.setEditable(false);
    }
  }, [isCollabY, nestedEditor]);
  return isCollabY;
}
