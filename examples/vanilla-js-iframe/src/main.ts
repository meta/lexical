/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import './styles.css';

import {DragonExtension} from '@lexical/dragon';
import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {RichTextExtension} from '@lexical/rich-text';
import {defineExtension} from 'lexical';

import $prepopulatedRichText from './prepopulatedRichText';

const template = document.querySelector<HTMLTemplateElement>('#app-template')!;
const iframe = document.querySelector<HTMLIFrameElement>('#app-iframe')!;
const iframeDoc = iframe.contentDocument!;
// The page's stylesheets don't apply inside the iframe, so copy them in.
for (const style of document.querySelectorAll(
  'style, link[rel="stylesheet"]',
)) {
  iframeDoc.head.appendChild(iframeDoc.importNode(style, true));
}
iframeDoc.body.replaceChildren(iframeDoc.importNode(template.content, true));
const editorRef = iframeDoc.querySelector<HTMLDivElement>('#lexical-editor')!;
const stateRef =
  iframeDoc.querySelector<HTMLTextAreaElement>('#lexical-state')!;

const editor = buildEditorFromExtensions(
  defineExtension({
    $initialEditorState: $prepopulatedRichText,
    // RichTextExtension registers HeadingNode and QuoteNode
    dependencies: [RichTextExtension, HistoryExtension, DragonExtension],
    name: '@lexical/examples/vanilla-js-iframe',
    namespace: 'Vanilla JS iframe Demo',
    register: ed =>
      ed.registerUpdateListener(({editorState}) => {
        stateRef.value = JSON.stringify(editorState.toJSON(true), undefined, 2);
      }),
    theme: {
      // Adding styling to Quote node, see styles.css
      quote: 'PlaygroundEditorTheme__quote',
    },
  }),
);
// The root element lives in the iframe's document, so the editor reads the
// selection and focus from the iframe's window.
editor.setRootElement(editorRef);
