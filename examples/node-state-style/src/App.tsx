/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {Tabs} from '@ark-ui/react/tabs';
import {AutoFocusExtension, EditorStateExtension} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {defineExtension} from 'lexical';

import ExampleTheme from './ExampleTheme';
import {ShikiViewPlugin} from './plugins/ShikiViewPlugin';
import {StyleViewPlugin} from './plugins/StyleViewPlugin';
import {ToolbarExtension, ToolbarPlugin} from './plugins/ToolbarPlugin';
import {StyleStateExtension} from './styleState';

const placeholder = 'Enter some rich text...';

const editorExtension = defineExtension({
  dependencies: [
    RichTextExtension,
    HistoryExtension,
    AutoFocusExtension,
    EditorStateExtension,
    StyleStateExtension,
    ToolbarExtension,
  ],
  name: '@lexical/examples/node-state-style',
  namespace: 'NodeState Demo',
  theme: ExampleTheme,
});

export default function App() {
  return (
    <LexicalExtensionComposer
      extension={editorExtension}
      contentEditable={null}>
      <div className="editor-container">
        <ToolbarPlugin />
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
      <Tabs.Root
        lazyMount={true}
        unmountOnExit={true}
        defaultValue="style"
        style={{margin: '0 10px'}}>
        <Tabs.List
          style={{display: 'flex', justifyContent: 'center', margin: '10px 0'}}>
          <Tabs.Trigger value="style">Style Tree</Tabs.Trigger>
          <Tabs.Trigger value="html">HTML</Tabs.Trigger>
          <Tabs.Trigger value="json">JSON</Tabs.Trigger>
          <Tabs.Indicator />
        </Tabs.List>
        <Tabs.Content value="style">
          <StyleViewPlugin />
        </Tabs.Content>
        <Tabs.Content value="html">
          <ShikiViewPlugin lang="html" />
        </Tabs.Content>
        <Tabs.Content value="json">
          <ShikiViewPlugin lang="json" />
        </Tabs.Content>
      </Tabs.Root>
    </LexicalExtensionComposer>
  );
}
