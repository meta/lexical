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
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
  type TextFormatType,
  TextNode,
} from 'lexical';

// The element TextNode.exportDOM wraps its output with, one per text format,
// innermost first.
const FORMAT_WRAPPER_TAGS: readonly (readonly [TextFormatType, string])[] = [
  ['bold', 'b'],
  ['italic', 'i'],
  ['strikethrough', 's'],
  ['underline', 'u'],
];

export type SerializedMentionNode = Spread<
  {
    mentionName: string;
  },
  SerializedTextNode
>;

const mentionBackgroundColor = 'rgba(24, 119, 232, 0.2)';
export class MentionNode extends TextNode {
  __mention: string;

  $config() {
    return this.config('mention', {extends: TextNode});
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__mention, node.__text, node.__key);
  }
  static importJSON(serializedNode: SerializedMentionNode): MentionNode {
    return $createMentionNode(serializedNode.mentionName).updateFromJSON(
      serializedNode,
    );
  }

  constructor(mentionName: string, text?: string, key?: NodeKey) {
    super(text ?? mentionName, key);
    this.__mention = mentionName;
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      mentionName: this.__mention,
    };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.style.backgroundColor = mentionBackgroundColor;
    dom.className = 'mention';
    dom.spellcheck = false;

    return dom;
  }

  exportDOM(): DOMExportOutput {
    const document = $getDocument();
    const element = document.createElement('span');
    element.setAttribute('data-lexical-mention', 'true');
    if (this.__text !== this.__mention) {
      element.setAttribute('data-lexical-mention-name', this.__mention);
    }
    element.textContent = this.__text;
    // Carry the inline style (e.g. a font-size applied from the toolbar) and
    // the text formats onto the exported markup the way TextNode.exportDOM
    // does, otherwise they are silently dropped from the HTML. The mention
    // itself stays a <span> so the `span[data-lexical-mention]` import rule
    // keeps matching it.
    if (this.__style !== '') {
      element.style.cssText = this.__style;
    }
    let wrapped: HTMLElement = element;
    for (const [format, tag] of FORMAT_WRAPPER_TAGS) {
      if (this.hasFormat(format)) {
        const wrapper = document.createElement(tag);
        wrapper.appendChild(wrapped);
        wrapped = wrapper;
      }
    }
    return {element: wrapped};
  }

  isTextEntity(): true {
    return true;
  }

  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }
}

export function $createMentionNode(
  mentionName: string,
  textContent?: string,
): MentionNode {
  const mentionNode = new MentionNode(mentionName, textContent);
  mentionNode.setMode('segmented').toggleDirectionless();
  return $applyNodeReplacement(mentionNode);
}

export function $isMentionNode(
  node: LexicalNode | null | undefined,
): node is MentionNode {
  return node instanceof MentionNode;
}
