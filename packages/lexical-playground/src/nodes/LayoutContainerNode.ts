/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getDocument,
  addClassNamesToElement,
  type DOMExportOutput,
  type EditorConfig,
  ElementNode,
  type LexicalNode,
  type NodeKey,
  nodeSchema,
  type SerializedElementNode,
  type Spread,
  stringValue,
} from 'lexical';

export type SerializedLayoutContainerNode = Spread<
  {
    templateColumns: string;
  },
  SerializedElementNode
>;

const layoutContainerNodeSchema = nodeSchema<LayoutContainerNode>()({
  templateColumns: stringValue(),
});

export class LayoutContainerNode extends ElementNode {
  __templateColumns: string;

  constructor(templateColumns: string = '', key?: NodeKey) {
    super(key);
    this.__templateColumns = templateColumns;
  }

  $config() {
    return this.config('layout-container', {
      extends: ElementNode,
      json: layoutContainerNodeSchema,
    });
  }

  static clone(node: LayoutContainerNode): LayoutContainerNode {
    return new LayoutContainerNode(node.__templateColumns, node.__key);
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = $getDocument().createElement('div');
    dom.style.gridTemplateColumns = this.__templateColumns;
    if (typeof config.theme.layoutContainer === 'string') {
      addClassNamesToElement(dom, config.theme.layoutContainer);
    }
    return dom;
  }

  exportDOM(): DOMExportOutput {
    const element = $getDocument().createElement('div');
    element.style.gridTemplateColumns = this.__templateColumns;
    element.setAttribute('data-lexical-layout-container', 'true');
    return {element};
  }

  updateDOM(prevNode: this, dom: HTMLElement): boolean {
    if (prevNode.__templateColumns !== this.__templateColumns) {
      dom.style.gridTemplateColumns = this.__templateColumns;
    }
    return false;
  }

  isShadowRoot(): boolean {
    return true;
  }

  canBeEmpty(): boolean {
    return false;
  }

  getTemplateColumns(): string {
    return this.getLatest().__templateColumns;
  }

  setTemplateColumns(templateColumns: string): this {
    const self = this.getWritable();
    self.__templateColumns = templateColumns;
    return self;
  }
}

export function $createLayoutContainerNode(
  templateColumns: string = '',
): LayoutContainerNode {
  return new LayoutContainerNode(templateColumns);
}

export function $isLayoutContainerNode(
  node: LexicalNode | null | undefined,
): node is LayoutContainerNode {
  return node instanceof LayoutContainerNode;
}
