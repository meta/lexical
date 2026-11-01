/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// [docs:app-extension] Read directly by the Adding Data to Nodes guide.
import {ClipboardDOMImportExtension} from '@lexical/clipboard';
import {HistoryExtension} from '@lexical/history';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
} from '@lexical/html';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  mergeRegister,
  registerEventListener,
  registerEventListeners,
} from 'lexical';

import {ReviewExtension, SET_REVIEWED_COMMAND} from './ReviewExtension';

export const AppExtension = defineExtension({
  $initialEditorState() {
    $getRoot().append(
      $createParagraphNode().append(
        $createTextNode(
          'Review this paragraph without creating a custom node.',
        ),
      ),
      $createParagraphNode().append(
        $createTextNode(
          'Export HTML and import it again to keep the review status.',
        ),
      ),
    );
  },
  dependencies: [
    ReviewExtension,
    HistoryExtension,
    ClipboardDOMImportExtension,
  ],
  name: '@lexical/examples/node-state-review',
  namespace: 'Paragraph Review',
  register(editor) {
    const html = document.querySelector<HTMLTextAreaElement>('#html')!;
    const json = document.querySelector<HTMLTextAreaElement>('#json')!;
    const toggle = document.getElementById('toggle-reviewed')!;

    return mergeRegister(
      editor.registerUpdateListener(({editorState}) => {
        json.value = JSON.stringify(editorState.toJSON(true), null, 2);
      }),
      registerEventListeners(toggle, {
        click: () =>
          editor.dispatchCommand(SET_REVIEWED_COMMAND, reviewed => !reviewed),
        // Keep the editor selection when clicking the toolbar with a pointer.
        mousedown: event => event.preventDefault(),
      }),
      registerEventListener(
        document.getElementById('export-html')!,
        'click',
        () => {
          html.value = editor.read('latest', () =>
            $generateHtmlFromNodes(editor),
          );
        },
      ),
      registerEventListener(
        document.getElementById('import-html')!,
        'click',
        () => {
          const dom = new DOMParser().parseFromString(html.value, 'text/html');
          editor.update(() => {
            const nodes = $generateNodesFromDOMViaExtension(dom);
            $getRoot()
              .clear()
              .append(...nodes);
          });
        },
      ),
    );
  },
});
// [/docs:app-extension]
