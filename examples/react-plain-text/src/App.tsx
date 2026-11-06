/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {AutoFocusExtension, HMRExtension} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {PlainTextExtension} from '@lexical/plain-text';
import {ExtensionComponent} from '@lexical/react/ExtensionComponent';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {TreeViewExtension} from '@lexical/react/TreeViewExtension';
import {configExtension, defineExtension} from 'lexical';

import ExampleTheme from './ExampleTheme';

const placeholder = 'Enter some plain text...';

const isEmbedded = new URLSearchParams(window.location.search).has('embed');

const appExtension = defineExtension({
  dependencies: [
    configExtension(HMRExtension, {hot: import.meta.hot ?? null}),
    PlainTextExtension,
    HistoryExtension,
    // Let the documentation page keep focus when this example is embedded.
    configExtension(AutoFocusExtension, {
      disabled: isEmbedded,
    }),
    TreeViewExtension,
  ],
  name: '@lexical/examples/react-plain-text',
  namespace: 'react-plain-text',
  theme: ExampleTheme,
});

export default function App() {
  return (
    <LexicalExtensionComposer extension={appExtension} contentEditable={null}>
      <div className="editor-container">
        <div className="editor-inner">
          <ContentEditable
            className="editor-input"
            aria-label="Plain text editor"
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
