/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';

import {
  $getDocument,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  enumValue,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  nodeSchema,
  numberValue,
  type SerializedLexicalNode,
  type Spread,
  stringValue,
  unionValue,
  withAccessors,
  withField,
} from 'lexical';
import * as React from 'react';

type Dimension = number | 'inherit';

const ExcalidrawComponent = React.lazy(() => import('./ExcalidrawComponent'));

/**
 * `Dimension` is `number | 'inherit'`, so width/height are described with
 * {@link unionValue}. This also closes a hole in the previous
 * `serializedNode.width ?? 'inherit'` parsing, which stored any non-nullish
 * value (including a string like `'banana'`) verbatim.
 *
 * Left uninferred rather than annotated `SerializationSchema<Dimension>`: what
 * it *accepts* is wider than what it parses to, since `numberValue` also reads
 * a stringified number, and annotating the output type alone would claim
 * otherwise.
 */
const dimensionSchema = unionValue(
  [numberValue(), enumValue(['inherit'])],
  'inherit',
);

const excalidrawNodeSchema = nodeSchema<ExcalidrawNode>()({
  // '[]' is the empty-scene default the constructor uses; an absent or
  // out-of-domain `data` must not become '' (JSON.parse('') throws).
  // `setData` is a bare field write, so this property *is* `__data` in both
  // directions; naming the setter keeps a subclass that overrides it in
  // charge. `width`/`height` below cannot be declared this way — see there.
  data: withField(stringValue('[]'), {field: '__data', setter: 'setData'}),
  // Not `withField`: the field holds the `'inherit'` sentinel, which has
  // never been serialized (`width?: Dimension` is optional), so the getter
  // maps it to `undefined` to omit the property. Reading the field directly
  // would start writing `"width":"inherit"`. A `decode` table cannot express
  // it either — the stored domain is open, so a table miss would omit every
  // real width along with the sentinel.
  height: withAccessors(dimensionSchema, {getter: 'getSerializedHeight'}),
  width: withAccessors(dimensionSchema, {getter: 'getSerializedWidth'}),
});

export type SerializedExcalidrawNode = Spread<
  {
    data: string;
    width?: Dimension;
    height?: Dimension;
  },
  SerializedLexicalNode
>;

export class ExcalidrawNode extends DecoratorNode<JSX.Element> {
  __data: string;
  __width: Dimension;
  __height: Dimension;

  $config() {
    return this.config('excalidraw', {
      extends: DecoratorNode,
      json: excalidrawNodeSchema,
    });
  }

  // Every constructor argument has a default, so `$config` synthesizes the
  // static `clone` as `new ExcalidrawNode()` — the drawing and its dimensions
  // have to be carried over here or every `getWritable()` resets them.
  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__data = prevNode.__data;
    this.__width = prevNode.__width;
    this.__height = prevNode.__height;
  }

  constructor(
    data = '[]',
    width: Dimension = 'inherit',
    height: Dimension = 'inherit',
    key?: NodeKey,
  ) {
    super(key);
    this.__data = data;
    this.__width = width;
    this.__height = height;
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

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const element = $getDocument().createElement('span');

    element.style.display = 'inline-block';

    const content = editor.getElementByKey(this.getKey());
    if (content !== null) {
      const svg = content.querySelector('svg');
      if (svg !== null) {
        element.innerHTML = svg.outerHTML;
      }
    }

    element.style.width =
      this.__width === 'inherit' ? 'inherit' : `${this.__width}px`;
    element.style.height =
      this.__height === 'inherit' ? 'inherit' : `${this.__height}px`;

    element.setAttribute('data-lexical-excalidraw-json', this.__data);
    return {element};
  }

  /** @internal The 'inherit' sentinel is omitted from the JSON. */
  getSerializedWidth(): number | undefined {
    const width = this.getWidth();
    return width === 'inherit' ? undefined : width;
  }

  /** @internal */
  getSerializedHeight(): number | undefined {
    const height = this.getHeight();
    return height === 'inherit' ? undefined : height;
  }

  setData(data: string): this {
    const self = this.getWritable();
    self.__data = data;
    return self;
  }

  getWidth(): Dimension {
    return this.getLatest().__width;
  }

  setWidth(width: Dimension): this {
    const self = this.getWritable();
    self.__width = width;
    return self;
  }

  getHeight(): Dimension {
    return this.getLatest().__height;
  }

  setHeight(height: Dimension): this {
    const self = this.getWritable();
    self.__height = height;
    return self;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element {
    return (
      <ExcalidrawComponent
        nodeKey={this.getKey()}
        data={this.__data}
        width={this.__width}
        height={this.__height}
      />
    );
  }
}

export function $createExcalidrawNode(
  data: string = '[]',
  width: Dimension = 'inherit',
  height: Dimension = 'inherit',
): ExcalidrawNode {
  return new ExcalidrawNode(data, width, height);
}

export function $isExcalidrawNode(
  node: LexicalNode | null | undefined,
): node is ExcalidrawNode {
  return node instanceof ExcalidrawNode;
}
