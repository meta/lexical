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
  type ElementFormatType,
  enumValue,
  type LexicalNode,
  type LexicalParseJSON,
  type NodeKey,
  nodeSchema,
  type SerializedLexicalNode,
  type SerializedPartial,
  type Spread,
  withField,
} from 'lexical';

import {GENERATED_DECORATORBLOCK} from './shared/LexicalReactGeneratedJSON';

/**
 * The serialized form of a {@link DecoratorBlockNode}: the base serialized node
 * data plus the block's element `format` (alignment).
 */
export type SerializedDecoratorBlockNode = Spread<
  {
    format: ElementFormatType;
  },
  SerializedLexicalNode
>;

// Single source of truth for parsing the node-specific properties of a
// SerializedDecoratorBlockNode. DecoratorBlockNode is an abstract base (it has
// no concrete node type) so it publishes its schema on `$config` under the
// well-known `Symbol.for('DecoratorBlockNode')` key; concrete subclasses
// compose it with their own.
const decoratorBlockNodeSchema = nodeSchema<DecoratorBlockNode>()({
  format: withField(
    enumValue(['', 'left', 'start', 'center', 'right', 'end', 'justify']),
    {field: '__format'},
  ),
});

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface DecoratorBlockNode {
  exportJSON(compact?: false): SerializedDecoratorBlockNode;
  exportJSON(compact: boolean): SerializedPartial<SerializedDecoratorBlockNode>;
  updateFromJSON(
    serializedNode: LexicalParseJSON<SerializedDecoratorBlockNode>,
  ): this;
}

/**
 * A base class for block-level {@link DecoratorNode}s (decorator nodes rendered
 * on their own line rather than inline). It stores an {@link ElementFormatType}
 * alignment, is not indentable, and renders into a `<div>`. Extend it for custom
 * block embeds such as images, videos, or tweets, typically pairing it with
 * {@link BlockWithAlignableContents} to handle selection and alignment.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class DecoratorBlockNode extends DecoratorNode<JSX.Element> {
  __format: ElementFormatType;

  constructor(format?: ElementFormatType, key?: NodeKey) {
    super(key);
    this.__format = format || '';
  }

  $config() {
    return this.config(Symbol.for('DecoratorBlockNode'), {
      // Named explicitly, as every abstract config in the tree is: this class
      // carries the only declaration of `format` that its concrete subclasses
      // inherit, and composeSchema honors an explicit `extends` where a
      // severed static prototype chain (Babel's loose class transform) would
      // otherwise stop the walk here and drop the property from both
      // directions.
      extends: DecoratorNode,
      generated: GENERATED_DECORATORBLOCK,
      json: decoratorBlockNodeSchema,
    });
  }

  canIndent(): false {
    return false;
  }

  createDOM(): HTMLElement {
    return $getDocument().createElement('div');
  }

  updateDOM(): false {
    return false;
  }

  setFormat(format: ElementFormatType): this {
    const self = this.getWritable();
    self.__format = format;
    return self;
  }

  getFormat(): ElementFormatType {
    return this.getLatest().__format;
  }

  isInline(): false {
    return false;
  }
}

/**
 * @returns `true` if `node` is a {@link DecoratorBlockNode}, narrowing its type.
 */
export function $isDecoratorBlockNode(
  node: LexicalNode | null | undefined,
): node is DecoratorBlockNode {
  return node instanceof DecoratorBlockNode;
}
