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
  enumValue,
  type LexicalEditor,
  type LexicalEditorWithDispose,
  type LexicalNode,
  type NodeKey,
  nodeSchema,
  numberValue,
  rawValue,
  type SerializedEditor,
  type SerializedLexicalNode,
  type Spread,
  withAccessors,
} from 'lexical';
import * as React from 'react';
import {createPortal} from 'react-dom';

import StickyEditorTheme from '../themes/StickyEditorTheme';
import ContentEditable from '../ui/ContentEditable';

const StickyComponent = React.lazy(() => import('./StickyComponent'));

type StickyNoteColor = 'pink' | 'yellow';

const stickyNodeSchema = nodeSchema<StickyNode>()({
  caption: withAccessors(rawValue<SerializedEditor>(), {
    getter: 'getSerializedCaption',
  }),
  color: withAccessors(enumValue(['yellow', 'pink']), {
    getter: {field: '__color'},
  }),
  xOffset: withAccessors(numberValue(), {
    getter: {
      field: '__x',
    },
  }),
  yOffset: withAccessors(numberValue(), {
    getter: {
      field: '__y',
    },
  }),
});

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
    return this.config('sticky', {
      extends: DecoratorNode,
      json: stickyNodeSchema,
    });
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

  /** @internal The nested caption editor's own serialized state. */
  getSerializedCaption(): SerializedEditor {
    return this.getLatest().__caption.toJSON();
  }

  /**
   * Apply a serialized nested caption editor. The nested editor's own
   * `parseEditorState` owns validation of the payload, which is why the `json`
   * schema declares the property with {@link rawValue} rather than describing
   * its shape. An empty parsed state is ignored so it does not clobber the
   * caption the node was created with.
   */
  setCaption(caption: SerializedEditor | undefined): this {
    const self = this.getWritable();
    if (caption) {
      const nestedEditor = self.__caption;
      const editorState = nestedEditor.parseEditorState(caption.editorState);
      if (!editorState.isEmpty()) {
        nestedEditor.setEditorState(editorState);
      }
    }
    return self;
  }

  setXOffset(xOffset: number): this {
    const self = this.getWritable();
    self.__x = xOffset;
    return self;
  }

  setYOffset(yOffset: number): this {
    const self = this.getWritable();
    self.__y = yOffset;
    return self;
  }

  setColor(color: 'pink' | 'yellow'): this {
    const self = this.getWritable();
    self.__color = color;
    return self;
  }

  constructor(
    x: number = 0,
    y: number = 0,
    color: 'pink' | 'yellow' = 'yellow',
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
