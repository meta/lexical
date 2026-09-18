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
import {HashtagExtension} from '@lexical/hashtag';
import {HistoryExtension} from '@lexical/history';
import {$generateHtmlFromNodes} from '@lexical/html';
import {LinkExtension} from '@lexical/link';
import {ReactExtension} from '@lexical/react/ReactExtension';
import {ReactProviderExtension} from '@lexical/react/ReactProviderExtension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $applyNodeReplacement,
  $createRangeSelection,
  $extendCaretToRange,
  $getChildCaret,
  $getDocument,
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  configExtension,
  DecoratorNode,
  defineExtension,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditorWithDispose,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type RangeSelection,
  type SerializedEditor,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import * as React from 'react';

import {EmojisExtension} from '../plugins/EmojisExtension';
import {MentionsPlugin} from '../plugins/MentionsExtension';
import ContentEditable from '../ui/ContentEditable';
import {EmojiNode} from './EmojiNode';
import {KeywordsExtension} from './KeywordNode';

const ImageComponent = React.lazy(() => import('./ImageComponent'));

const CaptionEditorExtension = defineExtension({
  // Skip the default empty-paragraph initializer. In collab mode
  // CollaborationPlugin's bootstrap only runs `initializeEditor` when
  // the Lexical root is empty, so a pre-seeded paragraph would prevent
  // the caption editor from ever exporting its state to Yjs. In
  // non-collab mode RichText's normalization adds a paragraph as soon
  // as the editor mounts.
  $initialEditorState: null,
  dependencies: [
    // FIXME - The current playground has tests that assume that image captions don't have shared history
    // SharedHistoryExtension,
    HistoryExtension,
    NestedEditorExtension,
    ReactProviderExtension,
    RichTextExtension,
    HashtagExtension,
    LinkExtension,
    KeywordsExtension,
    EmojisExtension,
    configExtension(ReactExtension, {
      contentEditable: (
        <ContentEditable
          placeholder="Enter a caption..."
          placeholderClassName="ImageNode__placeholder"
          className="ImageNode__contentEditable"
        />
      ),
      decorators: [<MentionsPlugin key="mentions" />],
    }),
  ],
  name: '@lexical/playground/ImageNodeCaption',
  namespace: 'Playground/ImageNodeCaption',
  nodes: [EmojiNode],
});

export interface ImagePayload {
  altText: string;
  caption?: LexicalEditorWithDispose;
  height?: number;
  key?: NodeKey;
  maxWidth?: number;
  showCaption?: boolean;
  src: string;
  width?: number;
  captionsEnabled?: boolean;
}

export function $isCaptionEditorEmpty(): boolean {
  // Search the document for any non-element node
  // to determine if it's empty or not
  for (const {origin} of $extendCaretToRange(
    $getChildCaret($getRoot(), 'next'),
  )) {
    if (!$isElementNode(origin)) {
      return false;
    }
  }
  return true;
}

export type SerializedImageNode = Spread<
  {
    altText: string;
    caption: SerializedEditor;
    height?: number;
    maxWidth: number;
    showCaption: boolean;
    src: string;
    width?: number;
  },
  SerializedLexicalNode
>;

export class ImageNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __altText: string;
  __width: 'inherit' | number;
  __height: 'inherit' | number;
  __maxWidth: number;
  __showCaption: boolean;
  __caption: LexicalEditorWithDispose;
  // Captions cannot yet be used within editor cells
  __captionsEnabled: boolean;

  $config() {
    return this.config('image', {extends: DecoratorNode});
  }

  static clone(node: ImageNode): ImageNode {
    return new ImageNode(
      node.__src,
      node.__altText,
      node.__maxWidth,
      node.__width,
      node.__height,
      node.__showCaption,
      node.__caption,
      node.__captionsEnabled,
      node.__key,
    );
  }

  static importJSON(serializedNode: SerializedImageNode): ImageNode {
    const {altText, height, width, maxWidth, src, showCaption} = serializedNode;
    return $createImageNode({
      altText,
      height,
      maxWidth,
      showCaption,
      src,
      width,
    }).updateFromJSON(serializedNode);
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedImageNode>): this {
    const node = super.updateFromJSON(serializedNode);
    const {caption} = serializedNode;

    const nestedEditor = node.__caption;
    const editorState = nestedEditor.parseEditorState(caption.editorState);
    if (!editorState.isEmpty()) {
      nestedEditor.setEditorState(editorState);
    }
    return node;
  }

  exportDOM(): DOMExportOutput {
    const imgElement = $getDocument().createElement('img');
    imgElement.setAttribute('src', this.__src);
    imgElement.setAttribute('alt', this.__altText);
    imgElement.setAttribute('width', this.__width.toString());
    imgElement.setAttribute('height', this.__height.toString());

    if (this.__showCaption && this.__caption) {
      const captionEditor = this.__caption;
      const captionHtml = captionEditor.read(() => {
        if ($isCaptionEditorEmpty()) {
          return null;
        }
        // Don't serialize the wrapping paragraph if there is only one
        let selection: null | RangeSelection = null;
        const firstChild = $getRoot().getFirstChild();
        if (
          $isParagraphNode(firstChild) &&
          firstChild.getNextSibling() === null
        ) {
          selection = $createRangeSelection();
          selection.anchor.set(firstChild.getKey(), 0, 'element');
          selection.focus.set(
            firstChild.getKey(),
            firstChild.getChildrenSize(),
            'element',
          );
        }
        return $generateHtmlFromNodes(captionEditor, selection);
      });
      if (captionHtml) {
        const figureElement = $getDocument().createElement('figure');
        const figcaptionElement = $getDocument().createElement('figcaption');
        figcaptionElement.innerHTML = captionHtml;

        figureElement.appendChild(imgElement);
        figureElement.appendChild(figcaptionElement);

        return {element: figureElement};
      }
    }

    return {element: imgElement};
  }

  constructor(
    src: string,
    altText: string,
    maxWidth: number,
    width?: 'inherit' | number,
    height?: 'inherit' | number,
    showCaption?: boolean,
    caption?: LexicalEditorWithDispose,
    captionsEnabled?: boolean,
    key?: NodeKey,
  ) {
    super(key);
    this.__src = src;
    this.__altText = altText;
    this.__maxWidth = maxWidth;
    this.__width = width || 'inherit';
    this.__height = height || 'inherit';
    this.__showCaption = showCaption || false;
    this.__caption =
      caption || buildEditorFromExtensions(CaptionEditorExtension);
    this.__captionsEnabled = captionsEnabled !== false;
  }

  exportJSON(): SerializedImageNode {
    return {
      ...super.exportJSON(),
      altText: this.getAltText(),
      caption: this.__caption.toJSON(),
      height: this.__height === 'inherit' ? 0 : this.__height,
      maxWidth: this.__maxWidth,
      showCaption: this.__showCaption,
      src: this.getSrc(),
      width: this.__width === 'inherit' ? 0 : this.__width,
    };
  }

  setWidthAndHeight(
    width: 'inherit' | number,
    height: 'inherit' | number,
  ): this {
    const writable = this.getWritable();
    writable.__width = width;
    writable.__height = height;
    return writable;
  }

  setShowCaption(showCaption: boolean): this {
    const writable = this.getWritable();
    writable.__showCaption = showCaption;
    return writable;
  }

  // View

  createDOM(config: EditorConfig): HTMLElement {
    const span = $getDocument().createElement('span');
    const theme = config.theme;
    const className = theme.image;
    if (className !== undefined) {
      span.className = className;
    }
    return span;
  }

  updateDOM(): false {
    return false;
  }

  getSrc(): string {
    return this.getLatest().__src;
  }

  getAltText(): string {
    return this.getLatest().__altText;
  }

  decorate(): JSX.Element {
    return (
      <ImageComponent
        src={this.__src}
        altText={this.__altText}
        width={this.__width}
        height={this.__height}
        maxWidth={this.__maxWidth}
        nodeKey={this.getKey()}
        showCaption={this.__showCaption}
        caption={this.__caption}
        captionsEnabled={this.__captionsEnabled}
        resizable={true}
      />
    );
  }
}

export function $createImageNode({
  altText,
  height,
  maxWidth = 500,
  captionsEnabled,
  src,
  width,
  showCaption,
  caption,
  key,
}: ImagePayload): ImageNode {
  return $applyNodeReplacement(
    new ImageNode(
      src,
      altText,
      maxWidth,
      width,
      height,
      showCaption,
      caption,
      captionsEnabled,
      key,
    ),
  );
}

export function $isImageNode(
  node: LexicalNode | null | undefined,
): node is ImageNode {
  return node instanceof ImageNode;
}
