/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import './styles.css';

import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $copyNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  REDO_COMMAND,
  UNDO_COMMAND,
} from 'lexical';

import {loadApplicationDocument, registerApplicationIdentity} from './identity';

function allocateId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

const editor = buildEditorFromExtensions({
  $initialEditorState: () => {
    $getRoot().append(
      $createParagraphNode().append(
        $createTextNode('Copy me, then inspect the IDs below.'),
      ),
    );
  },
  dependencies: [RichTextExtension, HistoryExtension],
  name: '[node-state-identity]',
  namespace: 'node-state-identity',
  register: current => registerApplicationIdentity(current, allocateId),
});
editor.setRootElement(document.getElementById('editor'));
const output = document.getElementById('json')!;
const status = document.getElementById('status')!;
const load = document.getElementById('load') as HTMLButtonElement;
let saved = '';
const renderJSON = () => {
  output.textContent = JSON.stringify(editor.getEditorState(), null, 2);
};
const unregister = editor.registerUpdateListener(renderJSON);
renderJSON();

document.getElementById('add')!.onclick = () =>
  editor.update(() => {
    $getRoot().append(
      $createParagraphNode().append($createTextNode('New paragraph')),
    );
  });
document.getElementById('duplicate')!.onclick = () =>
  editor.update(() => {
    const first = $getRoot().getFirstChild();
    if (first && $isElementNode(first)) {
      // $copyNode is shallow: attach a new text child for this demonstration.
      $getRoot().append(
        $copyNode(first).append($createTextNode(first.getTextContent())),
      );
    }
  });
document.getElementById('undo')!.onclick = () =>
  editor.dispatchCommand(UNDO_COMMAND);
document.getElementById('redo')!.onclick = () =>
  editor.dispatchCommand(REDO_COMMAND);
document.getElementById('save')!.onclick = () => {
  saved = JSON.stringify(editor.getEditorState());
  load.disabled = false;
  status.textContent = 'Snapshot saved in memory. Load restores its IDs.';
};
load.onclick = () => {
  loadApplicationDocument(editor, saved);
  status.textContent = 'Saved snapshot loaded.';
};
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unregister();
    editor.dispose();
  });
}
