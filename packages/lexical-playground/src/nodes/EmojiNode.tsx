/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $applyNodeReplacement,
  $getDocument,
  addClassNamesToElement,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
  TextNode,
} from 'lexical';

export type SerializedEmojiNode = Spread<
  {
    className: string;
  },
  SerializedTextNode
>;

export class EmojiNode extends TextNode {
  __className: string;

  $config() {
    return this.config('emoji', {extends: TextNode});
  }

  static clone(node: EmojiNode): EmojiNode {
    return new EmojiNode(node.__className, node.__text, node.__key);
  }

  constructor(className: string, text: string, key?: NodeKey) {
    super(text, key);
    this.__className = className;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = $getDocument().createElement('span');
    const inner = super.createDOM(config);
    dom.className = this.__className;
    // Add to the class names TextNode.createDOM applied for the text formats
    // rather than replacing them, otherwise a formatted emoji renders unstyled.
    addClassNamesToElement(inner, 'emoji-inner');
    dom.appendChild(inner);
    return dom;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    const inner = dom.firstChild;
    if (inner === null) {
      return true;
    }
    // TextNode.updateDOM returns true when the format change needs a different
    // tag, in which case it has not touched the DOM at all and the element has
    // to be recreated. Returning false regardless would promise the reconciler
    // that the difference was already applied.
    return super.updateDOM(prevNode, inner as HTMLElement, config);
  }

  static importJSON(serializedNode: SerializedEmojiNode): EmojiNode {
    return $createEmojiNode(
      serializedNode.className,
      serializedNode.text,
    ).updateFromJSON(serializedNode);
  }

  exportJSON(): SerializedEmojiNode {
    return {
      ...super.exportJSON(),
      className: this.getClassName(),
    };
  }

  getClassName(): string {
    const self = this.getLatest();
    return self.__className;
  }
}

export function $isEmojiNode(
  node: LexicalNode | null | undefined,
): node is EmojiNode {
  return node instanceof EmojiNode;
}

export function $createEmojiNode(
  className: string,
  emojiText: string,
): EmojiNode {
  const node = new EmojiNode(className, emojiText).setMode('token');
  return $applyNodeReplacement(node);
}
