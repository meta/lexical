/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// [docs:main] Read directly by the Creating an Extension guide.
import './styles.css';

import {buildEditorFromExtensions, HMRExtension} from '@lexical/extension';
import {configExtension} from 'lexical';

import {AppExtension} from './AppExtension';

const editor = buildEditorFromExtensions(
  AppExtension,
  configExtension(HMRExtension, {hot: import.meta.hot ?? null}),
);
editor.setRootElement(document.getElementById('lexical-editor'));

// Accept Vite updates; HMRExtension preserves editor state.
// In an application, also call dispose() when removing the editor permanently.
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => editor.dispose());
}
// [/docs:main]
