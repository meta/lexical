/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {AutoFocusExtension} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {ExtensionComponent} from '@lexical/react/ExtensionComponent';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
} from 'lexical';

import {MathTypeExtension} from './MathTypeExtension';

const placeholder = 'Write a math note...';

const theme = {
  paragraph: 'editor-paragraph',
};

const appExtension = defineExtension({
  $initialEditorState: () => {
    $getRoot().append(
      $createParagraphNode().append(
        $createTextNode('Use the MathType toolbar to insert a formula. '),
      ),
    );
  },
  dependencies: [
    RichTextExtension,
    HistoryExtension,
    AutoFocusExtension,
    MathTypeExtension,
  ],
  name: '@lexical/react-mathtype-example/App',
  namespace: '@lexical/react-mathtype-example',
  theme,
});

export default function App() {
  return (
    <LexicalExtensionComposer extension={appExtension} contentEditable={null}>
      <div className="editor-shell">
        <ExtensionComponent lexical:extension={MathTypeExtension} />
        <div className="editor-inner">
          <ContentEditable
            className="editor-input"
            aria-placeholder={placeholder}
            placeholder={
              <div className="editor-placeholder">{placeholder}</div>
            }
          />
        </div>
      </div>
    </LexicalExtensionComposer>
  );
}
