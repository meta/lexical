/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Import the editor CSS as a raw string so it can be injected *inside* the
// shadow root (shadow trees do not inherit the document's stylesheets).
import type {JSX} from 'react';

import {AutoFocusExtension, TabIndentationExtension} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {LinkExtension} from '@lexical/link';
import {ListExtension} from '@lexical/list';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  DecoratorNode,
  defineExtension,
} from 'lexical';

import editorStyleSheet from './editor.css?raw';
import ExampleTheme from './ExampleTheme';
import ShadowRoot from './ShadowRoot';
import Toolbar from './Toolbar';

const innerPlaceholder =
  'Inner editor (shadow root) — type here. The outer editor lives in the light DOM.';

function $prepopulateInner(): void {
  const root = $getRoot();
  if (root.getFirstChild() !== null) {
    return;
  }
  root.append(
    $createParagraphNode().append(
      $createTextNode(
        'Inner editor lives inside a shadow root, nested in the outer editor.',
      ),
    ),
  );
}

const innerExtension = defineExtension({
  $initialEditorState: $prepopulateInner,
  dependencies: [
    RichTextExtension,
    ListExtension,
    LinkExtension,
    HistoryExtension,
    AutoFocusExtension,
    TabIndentationExtension,
  ],
  name: '@lexical/examples/shadow-dom-inner',
  namespace: 'Shadow DOM Demo Inner',
  theme: ExampleTheme,
});

function NestedEditorView(): JSX.Element {
  return (
    <LexicalExtensionComposer extension={innerExtension} contentEditable={null}>
      <ShadowRoot styleSheet={editorStyleSheet}>
        <div className="editor-inner">
          <ContentEditable
            className="editor-input"
            aria-placeholder={innerPlaceholder}
            placeholder={
              <div className="editor-placeholder">{innerPlaceholder}</div>
            }
          />
        </div>
      </ShadowRoot>
    </LexicalExtensionComposer>
  );
}

// A DecoratorNode that hosts the inner shadow-mounted editor as its React
// subtree. Mounting through a decorator gives the inner editor a real
// place in the outer editor's Lexical tree — exercising the nested
// attribution path in `onDocumentSelectionChange`.
export class NestedEditorNode extends DecoratorNode<JSX.Element> {
  $config() {
    return this.config('nested-editor', {extends: DecoratorNode});
  }

  createDOM(): HTMLElement {
    const dom = $getDocument().createElement('div');
    dom.className = 'nested-editor-host';
    return dom;
  }

  updateDOM(): boolean {
    return false;
  }

  decorate(): JSX.Element {
    return <NestedEditorView />;
  }
}

function $createNestedEditorNode(): NestedEditorNode {
  return $create(NestedEditorNode);
}

const outerPlaceholder =
  'Outer editor (light DOM) — type here. The inner editor below lives inside a shadow root.';

function $prepopulateOuter(): void {
  const root = $getRoot();
  if (root.getFirstChild() !== null) {
    return;
  }
  root.append(
    $createParagraphNode().append(
      $createTextNode(
        'Outer editor lives in the light DOM. The inner editor below sits inside a shadow root, nested in this outer tree.',
      ),
    ),
  );
  root.append($createNestedEditorNode());
  root.append(
    $createParagraphNode().append(
      $createTextNode('Type here too — selections should attribute correctly.'),
    ),
  );
}

const outerExtension = defineExtension({
  $initialEditorState: $prepopulateOuter,
  dependencies: [
    RichTextExtension,
    HistoryExtension,
    AutoFocusExtension,
    TabIndentationExtension,
  ],
  name: '@lexical/examples/shadow-dom-outer',
  namespace: 'Shadow DOM Demo Outer',
  nodes: () => [NestedEditorNode],
  theme: ExampleTheme,
});

export default function App(): JSX.Element {
  return (
    <LexicalExtensionComposer extension={outerExtension} contentEditable={null}>
      <div className="editor-container">
        <Toolbar />
        <div className="editor-inner">
          <ContentEditable
            className="editor-input"
            aria-placeholder={outerPlaceholder}
            placeholder={
              <div className="editor-placeholder">{outerPlaceholder}</div>
            }
          />
        </div>
      </div>
    </LexicalExtensionComposer>
  );
}
