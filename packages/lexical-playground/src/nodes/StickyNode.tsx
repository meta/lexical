/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';

import {
  buildEditorFromExtensions,
  NestedEditorExtension,
} from '@lexical/extension';
import {SharedHistoryExtension} from '@lexical/history';
import {PlainTextExtension} from '@lexical/plain-text';
import {ReactExtension} from '@lexical/react/ReactExtension';
import {ReactProviderExtension} from '@lexical/react/ReactProviderExtension';
import {
  $getDocument,
  $setSelection,
  configExtension,
  DecoratorNode,
  defineExtension,
  type EditorConfig,
  type LexicalEditor,
  type LexicalEditorWithDispose,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type SerializedEditor,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import * as React from 'react';
import {createPortal} from 'react-dom';

import StickyEditorTheme from '../themes/StickyEditorTheme';
import ContentEditable from '../ui/ContentEditable';

const StickyComponent = React.lazy(() => import('./StickyComponent'));

type StickyNoteColor = 'pink' | 'yellow';

export type SerializedStickyNode = Spread<
  {
    xOffset: number;
    yOffset: number;
    color: StickyNoteColor;
    caption: SerializedEditor;
  },
  SerializedLexicalNode
>;

const StickyEditorExtension = defineExtension({
  dependencies: [
    SharedHistoryExtension,
    PlainTextExtension,
    ReactProviderExtension,
    NestedEditorExtension,
    configExtension(ReactExtension, {
      contentEditable: (
        <ContentEditable
          placeholder="What's up?"
          placeholderClassName="StickyNode__placeholder"
          className="StickyNode__contentEditable"
        />
      ),
    }),
  ],
  name: '@lexical/playground/StickyEditor',
  namespace: '@lexical/playground/StickyEditor',
  theme: StickyEditorTheme,
});

export class StickyNode extends DecoratorNode<JSX.Element> {
  __x: number;
  __y: number;
  __color: StickyNoteColor;
  __caption: LexicalEditorWithDispose;

  $config() {
    return this.config('sticky', {extends: DecoratorNode});
  }

  static clone(node: StickyNode): StickyNode {
    return new StickyNode(
      node.__x,
      node.__y,
      node.__color,
      node.__caption,
      node.__key,
    );
  }
  static importJSON(serializedNode: SerializedStickyNode): StickyNode {
    return new StickyNode(
      serializedNode.xOffset,
      serializedNode.yOffset,
      serializedNode.color,
    ).updateFromJSON(serializedNode);
  }

  updateFromJSON(
    serializedNode: LexicalUpdateJSON<SerializedStickyNode>,
  ): this {
    const stickyNode = super.updateFromJSON(serializedNode);
    const caption = serializedNode.caption;
    const nestedEditor = stickyNode.__caption;
    const editorState = nestedEditor.parseEditorState(caption.editorState);
    if (!editorState.isEmpty()) {
      nestedEditor.setEditorState(editorState);
    }
    return stickyNode;
  }

  constructor(
    x: number,
    y: number,
    color: 'pink' | 'yellow',
    caption?: LexicalEditorWithDispose,
    key?: NodeKey,
  ) {
    super(key);
    this.__x = x;
    this.__y = y;
    this.__caption =
      caption || buildEditorFromExtensions(StickyEditorExtension);
    this.__color = color;
  }

  exportJSON(): SerializedStickyNode {
    return {
      ...super.exportJSON(),
      caption: this.__caption.toJSON(),
      color: this.__color,
      xOffset: this.__x,
      yOffset: this.__y,
    };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const div = $getDocument().createElement('div');
    div.style.display = 'contents';
    return div;
  }

  updateDOM(): false {
    return false;
  }

  setPosition(x: number, y: number): this {
    const writable = this.getWritable();
    writable.__x = x;
    writable.__y = y;
    $setSelection(null);
    return writable;
  }

  toggleColor(): this {
    const writable = this.getWritable();
    writable.__color = writable.__color === 'pink' ? 'yellow' : 'pink';
    return writable;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element {
    return createPortal(
      <StickyComponent
        color={this.__color}
        x={this.__x}
        y={this.__y}
        nodeKey={this.getKey()}
        caption={this.__caption}
      />,
      editor.getRootElement()?.ownerDocument?.body ?? document.body,
    );
  }

  isIsolated(): true {
    return true;
  }
}

export function $isStickyNode(
  node: LexicalNode | null | undefined,
): node is StickyNode {
  return node instanceof StickyNode;
}

export function $createStickyNode(
  xOffset: number,
  yOffset: number,
): StickyNode {
  return new StickyNode(xOffset, yOffset, 'yellow');
}
