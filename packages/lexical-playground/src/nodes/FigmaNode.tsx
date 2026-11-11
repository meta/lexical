/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  EditorConfig,
  ElementFormatType,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  Spread,
} from 'lexical';
import type {JSX} from 'react';

import {BlockWithAlignableContents} from '@lexical/react/LexicalBlockWithAlignableContents';
import {
  DecoratorBlockNode,
  type SerializedDecoratorBlockNode,
} from '@lexical/react/LexicalDecoratorBlockNode';
import {nodeSchema, stringValue, withAccessors} from 'lexical';
import * as React from 'react';

const figmaNodeSchema = nodeSchema<FigmaNode>()({
  documentID: withAccessors(stringValue(), {
    getter: {
      field: '__id',
    },
  }),
});

type FigmaComponentProps = Readonly<{
  className: Readonly<{
    base: string;
    focus: string;
  }>;
  format: ElementFormatType | null;
  nodeKey: NodeKey;
  documentID: string;
}>;

function FigmaComponent({
  className,
  format,
  nodeKey,
  documentID,
}: FigmaComponentProps) {
  return (
    <BlockWithAlignableContents
      className={className}
      format={format}
      nodeKey={nodeKey}>
      <iframe
        width="560"
        height="315"
        src={`https://www.figma.com/embed?embed_host=lexical&url=\
        https://www.figma.com/file/${documentID}`}
        allowFullScreen={true}
      />
    </BlockWithAlignableContents>
  );
}

export type SerializedFigmaNode = Spread<
  {
    documentID: string;
  },
  SerializedDecoratorBlockNode
>;

export class FigmaNode extends DecoratorBlockNode {
  __id: string;

  $config() {
    return this.config('figma', {
      extends: DecoratorBlockNode,
      json: figmaNodeSchema,
    });
  }

  static clone(node: FigmaNode): FigmaNode {
    return new FigmaNode(node.__id, node.__format, node.__key);
  }

  setDocumentID(documentID: string): this {
    const self = this.getWritable();
    self.__id = documentID;
    return self;
  }

  constructor(id: string = '', format?: ElementFormatType, key?: NodeKey) {
    super(format, key);
    this.__id = id;
  }

  updateDOM(): false {
    return false;
  }

  getId(): string {
    return this.getLatest().__id;
  }

  getTextContent(
    _includeInert?: boolean | undefined,
    _includeDirectionless?: false | undefined,
  ): string {
    return `https://www.figma.com/file/${this.__id}`;
  }

  decorate(_editor: LexicalEditor, config: EditorConfig): JSX.Element {
    const embedBlockTheme = config.theme.embedBlock || {};
    const className = {
      base: embedBlockTheme.base || '',
      focus: embedBlockTheme.focus || '',
    };
    return (
      <FigmaComponent
        className={className}
        format={this.__format}
        nodeKey={this.getKey()}
        documentID={this.__id}
      />
    );
  }
}

export function $createFigmaNode(documentID: string): FigmaNode {
  return new FigmaNode(documentID);
}

export function $isFigmaNode(
  node: FigmaNode | LexicalNode | null | undefined,
): node is FigmaNode {
  return node instanceof FigmaNode;
}
