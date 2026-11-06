/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {InjectedTabState} from './InjectedTabState';
import type {LexicalEditor} from 'lexical';

import {
  type LexicalCommandLog,
  registerLexicalCommandLogger,
} from '@lexical/devtools-core';

import {serializeEditorState} from '../../serializeEditorState';
import queryLexicalNodes from './utils/queryLexicalNodes';

/**
 * Find the Lexical editors on this page and keep reporting them.
 *
 * Everything collected here describes this page alone and is held by this
 * page's `InjectedTabState`, which sends content onward only while the
 * DevTools panel for this tab is open.
 */
export default function scanAndListenForEditors(
  tabState: InjectedTabState,
  commandLog: WeakMap<LexicalEditor, LexicalCommandLog>,
) {
  const editors = queryLexicalNodes().map(node => node.__lexicalEditor);

  tabState.replaceStates(
    Object.fromEntries(
      editors.map(e => [e._key, serializeEditorState(e.getEditorState())]),
    ),
  );

  editors.forEach(editor => {
    if (tabState.isListening(editor._key)) {
      return;
    }
    tabState.markListening(editor._key);

    editor.registerUpdateListener(event => {
      tabState.setState(
        editor._key,
        serializeEditorState(event.editorState, {
          // The panel attached to this page is the only destination, and the
          // state is only sent while it is open -- the tree the user asked
          // to look at. Masked otherwise, belt and braces.
          obfuscateText: !tabState.isPanelOpen(),
        }),
      );
    });
    // TODO: validate that this will be garbage collected when the editor node is destroyed
    registerLexicalCommandLogger(editor, setter => {
      const oldVal = commandLog.get(editor) ?? [];
      commandLog.set(editor, setter(oldVal));
    });
  });
}
