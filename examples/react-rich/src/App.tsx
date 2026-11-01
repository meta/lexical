/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// [docs:react-app] Read directly by the Getting Started with React guide.
import {ClipboardDOMImportExtension} from '@lexical/clipboard';
import {
  AutoFocusExtension,
  EditorStateExtension,
  HMRExtension,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {ExtensionComponent} from '@lexical/react/ExtensionComponent';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {TreeViewExtension} from '@lexical/react/TreeViewExtension';
import {RichTextExtension} from '@lexical/rich-text';
import {configExtension, defineExtension} from 'lexical';

import ExampleTheme from './ExampleTheme';
import {StyleImportExportExtension} from './StyleImportExportExtension';
import Toolbar from './Toolbar';

const placeholder = 'Enter some rich text...';

const isEmbedded = new URLSearchParams(window.location.search).has('embed');

const appExtension = defineExtension({
  dependencies: [
    configExtension(HMRExtension, {hot: import.meta.hot ?? null}),
    RichTextExtension,
    ClipboardDOMImportExtension,
    StyleImportExportExtension,
    EditorStateExtension,
    HistoryExtension,
    // Let the documentation page keep focus when this example is embedded.
    configExtension(AutoFocusExtension, {
      disabled: isEmbedded,
    }),
    TreeViewExtension,
  ],
  name: '@lexical/examples/react-rich',
  namespace: 'react-rich',
  theme: ExampleTheme,
});

export default function App() {
  return (
    <LexicalExtensionComposer extension={appExtension} contentEditable={null}>
      <div className="editor-container">
        <Toolbar />
        <div className="editor-inner">
          <ContentEditable
            className="editor-input"
            aria-label="Rich text editor"
            aria-placeholder={placeholder}
            placeholder={
              <div className="editor-placeholder">{placeholder}</div>
            }
          />
          <ExtensionComponent lexical:extension={TreeViewExtension} />
        </div>
      </div>
    </LexicalExtensionComposer>
  );
}
// [/docs:react-app]
