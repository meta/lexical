/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$descendantsMatching} from '@lexical/utils';
import {
  $applyNodeReplacement,
  $getDocument,
  $setDirectionFromDOM,
  addClassNamesToElement,
  type BaseSelection,
  type DOMConversionOutput,
  type EditorConfig,
  ElementNode,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

import {PIXEL_VALUE_REG_EXP} from './constants';
import {$isTableCellNode} from './LexicalTableCellNode';

export type SerializedTableRowNode = Spread<
  {
    height?: number;
  },
  SerializedElementNode
>;

/** @noInheritDoc */
export class TableRowNode extends ElementNode {
  /** @internal */
  __height?: number;

  $config() {
    return this.config('tablerow', {
      extends: ElementNode,
      importDOM: {
        tr: () => ({
          conversion: $convertTableRowElement,
          priority: 0,
        }),
      },
    });
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__height = prevNode.__height;
  }

  updateFromJSON(
    serializedNode: LexicalUpdateJSON<SerializedTableRowNode>,
  ): this {
    return super
      .updateFromJSON(serializedNode)
      .setHeight(serializedNode.height);
  }

  // `height` carries an explicit `undefined` default so the constructor reports
  // zero required arguments and `$config` can synthesize the static `clone`.
  constructor(height: number | undefined = undefined, key?: NodeKey) {
    super(key);
    this.__height = height;
  }

  exportJSON(): SerializedTableRowNode {
    const height = this.getHeight();
    return {
      ...super.exportJSON(),
      ...(height === undefined ? undefined : {height}),
    };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = $getDocument().createElement('tr');

    if (this.__height) {
      element.style.height = `${this.__height}px`;
    }

    addClassNamesToElement(element, config.theme.tableRow);

    return element;
  }

  extractWithChild(
    child: LexicalNode,
    selection: BaseSelection | null,
    destination: 'clone' | 'html',
  ): boolean {
    return destination === 'html';
  }

  isShadowRoot(): boolean {
    return true;
  }

  setHeight(height?: number | undefined): this {
    const self = this.getWritable();
    self.__height = height;
    return self;
  }

  getHeight(): number | undefined {
    return this.getLatest().__height;
  }

  updateDOM(prevNode: this): boolean {
    return prevNode.__height !== this.__height;
  }

  canBeEmpty(): false {
    return false;
  }

  canIndent(): false {
    return false;
  }
}

export function $convertTableRowElement(domNode: Node): DOMConversionOutput {
  const domNode_ = domNode as HTMLTableCellElement;
  let height: number | undefined = undefined;

  if (PIXEL_VALUE_REG_EXP.test(domNode_.style.height)) {
    height = parseFloat(domNode_.style.height);
  }

  return {
    after: children => $descendantsMatching(children, $isTableCellNode),
    node: $setDirectionFromDOM($createTableRowNode(height), domNode_),
  };
}

export function $createTableRowNode(height?: number): TableRowNode {
  return $applyNodeReplacement(new TableRowNode(height));
}

export function $isTableRowNode(
  node: LexicalNode | null | undefined,
): node is TableRowNode {
  return node instanceof TableRowNode;
}
