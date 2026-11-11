/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {EditorState, LexicalEditor} from 'lexical';

import './ShikiViewPlugin.css';

import {EditorStateExtension} from '@lexical/extension';
import {$generateHtmlFromNodes} from '@lexical/html';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useExtensionDependency} from '@lexical/react/useExtensionComponent';
import {useSignalValue} from '@lexical/react/useExtensionSignalValue';
import * as prettier from 'prettier';
import {useEffect, useMemo, useState} from 'react';
import {createHighlighterCore} from 'shiki/core';
import {createJavaScriptRegexEngine} from 'shiki/engine/javascript';

const jsEngine = createJavaScriptRegexEngine({target: 'ES2024'});

const shikiPromise = createHighlighterCore({
  engine: jsEngine,
  langs: [import('@shikijs/langs/html'), import('@shikijs/langs/json')],
  themes: [import('@shikijs/themes/nord')],
});
const prettierPlugins = [
  import('prettier/plugins/babel'),
  import('prettier/plugins/estree'),
  import('prettier/plugins/html'),
];

function editorHTML(editor: LexicalEditor, editorState: EditorState): string {
  return editorState.read(() => $generateHtmlFromNodes(editor, null), {editor});
}

function editorJSON(_editor: LexicalEditor, editorState: EditorState): string {
  return JSON.stringify(editorState.toJSON(true), null, 2);
}

const langs = {
  html: editorHTML,
  json: editorJSON,
} as const;

export interface ShikiViewPluginProps {
  lang: keyof typeof langs;
}

export function ShikiViewPlugin({lang}: ShikiViewPluginProps) {
  const [editor] = useLexicalComposerContext();
  const editorState = useSignalValue(
    useExtensionDependency(EditorStateExtension).output,
  );
  const rawCode = useMemo(
    () => langs[lang](editor, editorState),
    [lang, editor, editorState],
  );
  const htmlPromise = useMemo(
    () =>
      (async () => {
        const prettified = await prettier.format(rawCode, {
          parser: lang,
          plugins: (await Promise.all(prettierPlugins)).map(mod => mod.default),
        });
        return (await shikiPromise).codeToHtml(prettified, {
          lang,
          theme: 'nord',
        });
      })(),
    [lang, rawCode],
  );
  const [html, setHtml] = useState('');
  useEffect(() => {
    let canceled = false;
    htmlPromise.then(formatted => canceled || setHtml(formatted));
    return () => {
      canceled = true;
    };
  }, [htmlPromise]);
  return (
    <div
      className="shiki-view-plugin"
      dangerouslySetInnerHTML={{__html: html}}
    />
  );
}
