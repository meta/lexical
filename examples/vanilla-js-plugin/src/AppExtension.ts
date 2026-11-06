/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// [docs:app-extension] Read directly by the Creating an Extension guide.
import {ClipboardDOMImportExtension} from '@lexical/clipboard';
import {HistoryExtension} from '@lexical/history';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
} from '@lexical/html';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $getRoot,
  configExtension,
  defineExtension,
  mergeRegister,
  registerEventListener,
} from 'lexical';

import {EmojiExtension} from './emoji-plugin/EmojiExtension';
import $prepopulatedRichText from './prepopulatedRichText';

export const AppExtension = defineExtension({
  $initialEditorState: $prepopulatedRichText,
  dependencies: [
    RichTextExtension,
    ClipboardDOMImportExtension,
    configExtension(HistoryExtension, {delay: 300}),
    EmojiExtension,
  ],
  name: '@lexical/examples/vanilla-js-plugin',
  namespace: 'Vanilla JS Emoji Demo',
  register(editor) {
    const stateRef =
      document.querySelector<HTMLTextAreaElement>('#lexical-state')!;
    const html = document.querySelector<HTMLTextAreaElement>('#html')!;
    return mergeRegister(
      editor.registerUpdateListener(({editorState}) => {
        stateRef.value = JSON.stringify(editorState.toJSON(true), null, 2);
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
