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
import {TreeViewExtension} from '@lexical/react/TreeViewExtension';
import {RichTextExtension} from '@lexical/rich-text';
import {defineExtension} from 'lexical';

import ExampleTheme from './ExampleTheme';
import {CustomParagraphExtension} from './nodes/CustomParagraphNode';
import {ToolbarExtension, ToolbarPlugin} from './plugins/ToolbarPlugin';

const placeholder = 'Enter some rich text...';

const appExtension = defineExtension({
  dependencies: [
    RichTextExtension,
    HistoryExtension,
    AutoFocusExtension,
    TreeViewExtension,
    CustomParagraphExtension,
    ToolbarExtension,
  ],
  name: '@lexical/examples/node-replacement',
  namespace: 'Node Replacement Demo',
  theme: ExampleTheme,
});

export default function App() {
  return (
    <LexicalExtensionComposer extension={appExtension} contentEditable={null}>
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
          <ExtensionComponent
            lexical:extension={TreeViewExtension}
            viewClassName="tree-view-output"
            treeTypeButtonClassName="debug-treetype-button"
            timeTravelPanelClassName="debug-timetravel-panel"
            timeTravelButtonClassName="debug-timetravel-button"
            timeTravelPanelSliderClassName="debug-timetravel-panel-slider"
            timeTravelPanelButtonClassName="debug-timetravel-panel-button"
          />
        </div>
      </div>
    </LexicalExtensionComposer>
  );
}
