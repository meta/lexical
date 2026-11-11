/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $applyNodeReplacement,
  addClassNamesToElement,
  type EditorConfig,
  type EditorThemeClasses,
  type ElementNode,
  type LexicalNode,
  type LexicalParseJSON,
  type NodeKey,
  nodeSchema,
  nullable,
  optional,
  removeClassNamesFromElement,
  type SerializedPartial,
  type SerializedTextNode,
  type Spread,
  stringValue,
  TextNode,
  withAccessors,
} from 'lexical';

import {$createCodeNode} from './CodeNode';
import {GENERATED_CODEHIGHLIGHT} from './LexicalCodeCoreGeneratedJSON';

type SerializedCodeHighlightNode = Spread<
  {
    highlightType: string | null | undefined;
  },
  SerializedTextNode
>;

// Single source of truth for parsing the node-specific properties of a
// SerializedCodeHighlightNode (those it adds over a SerializedTextNode).
const codeHighlightNodeSchema = nodeSchema<CodeHighlightNode>()({
  // Read straight off the field; applied through setHighlightType, which
  // normalizes a falsy value to undefined. Naming the field is also what
  // tells the clone where this property lives, so the class needs no
  // `afterCloneFrom` of its own. The same shape CodeNode's `language` uses.
  highlightType: withAccessors(optional(nullable(stringValue())), {
    getter: {field: '__highlightType'},
  }),
});

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface CodeHighlightNode {
  exportJSON(compact?: false): SerializedCodeHighlightNode;
  exportJSON(compact: boolean): SerializedPartial<SerializedCodeHighlightNode>;
  updateFromJSON(
    serializedNode: LexicalParseJSON<SerializedCodeHighlightNode>,
  ): this;
}

/** @noInheritDoc */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class CodeHighlightNode extends TextNode {
  /** @internal */
  __highlightType: string | null | undefined;

  constructor(
    text: string = '',
    highlightType?: string | null | undefined,
    key?: NodeKey,
  ) {
    super(text, key);
    this.__highlightType = highlightType;
  }

  $config() {
    return this.config('code-highlight', {
      extends: TextNode,
      generated: GENERATED_CODEHIGHLIGHT,
      json: codeHighlightNodeSchema,
    });
  }

  getHighlightType(): string | null | undefined {
    const self = this.getLatest();
    return self.__highlightType;
  }

  setHighlightType(highlightType?: string | null | undefined): this {
    const self = this.getWritable();
    self.__highlightType = highlightType || undefined;
    return self;
  }

  canHaveFormat(): boolean {
    return false;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);
    const className = getHighlightThemeClass(
      config.theme,
      this.__highlightType,
    );
    addClassNamesToElement(element, className);
    return element;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    const update = super.updateDOM(prevNode, dom, config);
    const prevClassName = getHighlightThemeClass(
      config.theme,
      prevNode.__highlightType,
    );
    const nextClassName = getHighlightThemeClass(
      config.theme,
      this.__highlightType,
    );
    if (prevClassName !== nextClassName) {
      if (prevClassName) {
        removeClassNamesFromElement(dom, prevClassName);
      }
      if (nextClassName) {
        addClassNamesToElement(dom, nextClassName);
      }
    }
    return update;
  }

  // Prevent formatting (bold, underline, etc)
  setFormat(format: number): this {
    return this;
  }

  isParentRequired(): true {
    return true;
  }

  createParentElementNode(): ElementNode {
    return $createCodeNode();
  }
}

function getHighlightThemeClass(
  theme: EditorThemeClasses,
  highlightType: string | null | undefined,
): string | null | undefined {
  return (
    highlightType &&
    theme &&
    theme.codeHighlight &&
    theme.codeHighlight[highlightType]
  );
}

export function $createCodeHighlightNode(
  text: string = '',
  highlightType?: string | null | undefined,
): CodeHighlightNode {
  return $applyNodeReplacement(new CodeHighlightNode(text, highlightType));
}

export function $isCodeHighlightNode(
  node: LexicalNode | CodeHighlightNode | null | undefined,
): node is CodeHighlightNode {
  return node instanceof CodeHighlightNode;
}
