/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { CodeHighlightNode, CodeNode } from "@lexical/code";
import { getCodeLanguages, registerCodeHighlighting } from "@lexical/code-prism";

// import * as React from 'react';

import ExampleTheme from "./ExampleTheme";
import ToolbarPlugin from "./plugins/ToolbarPlugin";
import TreeViewPlugin from "./plugins/TreeViewPlugin";
import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot } from "lexical";

const placeholder = 'Enter some rich text...';

const editorConfig = {
  namespace: "React.js Demo",
  nodes: [CodeNode, CodeHighlightNode],
  // Handling of errors during update
  onError(error: Error) {
    throw error;
  },
  // The editor theme
  theme: ExampleTheme,
};

function CodeHighlightingPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    registerCodeHighlighting(editor);
    editor.update(() => {
      $getRoot()
        .clear()
        .selectEnd()
        .insertRawText(["Registered:", ...getCodeLanguages()].join("\n"));
    });
  }, [editor]);
  return null;
}

export default function App() {
  return (
    <LexicalComposer initialConfig={editorConfig}>
      <div className="editor-container">
        <ToolbarPlugin />
        <div className="editor-inner">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                className="editor-input"
                aria-placeholder={placeholder}
                placeholder={
                  <div className="editor-placeholder">{placeholder}</div>
                }
              />
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <AutoFocusPlugin />
          <TreeViewPlugin />
          <CodeHighlightingPlugin />
        </div>
      </div>
    </LexicalComposer>
  );
}
