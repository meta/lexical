/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {ClipboardDOMImportExtension} from '@lexical/clipboard';
import {CodeShikiExtension} from '@lexical/code-shiki';
import {
  AutoFocusExtension,
  configExtension,
  HorizontalRuleExtension,
  TabIndentationExtension,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {LinkExtension} from '@lexical/link';
import {
  CheckListExtension,
  ListExtension,
  WordListImportExtension,
} from '@lexical/list';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {TableExtension} from '@lexical/table';
import {defineExtension} from 'lexical';

import ExampleTheme from './ExampleTheme';
import {ImportHtmlButton} from './ImportHtmlDialog';
import {MarkdownShortcutsExtension} from './MarkdownShortcutsExtension';
import {Toolbar, ToolbarExtension} from './ToolbarExtension';

const placeholder =
  'Try pasting from Word, GitHub, a webpage, or click "Import HTML"…';

const editorExtension = defineExtension({
  dependencies: [
    RichTextExtension,
    ListExtension,
    CheckListExtension,
    // Disable hasHorizontalScroll: the demo theme doesn't define the
    // scrollable-wrapper class, and tables here aren't wide enough to
    // need it.
    configExtension(TableExtension, {hasHorizontalScroll: false}),
    LinkExtension,
    HorizontalRuleExtension,
    HistoryExtension,
    AutoFocusExtension,
    // Tab / Shift-Tab indent at the cursor (nests/un-nests list items,
    // indents paragraphs). Pairs with ListItemNode.canIndent.
    TabIndentationExtension,
    // Registers CodeNode + CodeHighlightNode and wires Shiki up as the
    // syntax-highlighting tokenizer for code blocks in the editor.
    CodeShikiExtension,
    MarkdownShortcutsExtension,
    ToolbarExtension,
    // Word list handling is opt-in: the preprocess installs the
    // overlay only when the paste carries Word's Generator meta tag.
    WordListImportExtension,
    // Route real `text/html` pastes through the DOMImportExtension
    // pipeline so the rules / overlays above actually fire on pastes,
    // not just on the "Import HTML" dialog.
    ClipboardDOMImportExtension,
  ],
  name: '@lexical/examples/dom-import',
  namespace: 'DOM Import Demo',
  theme: ExampleTheme,
});

export default function App() {
  return (
    <LexicalExtensionComposer
      extension={editorExtension}
      contentEditable={null}>
      <div className="editor-container">
        <Toolbar>
          <ImportHtmlButton />
        </Toolbar>
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
