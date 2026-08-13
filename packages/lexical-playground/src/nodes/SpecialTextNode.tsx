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
  TextNode,
} from 'lexical';

/** @noInheritDoc */
export class SpecialTextNode extends TextNode {
  $config() {
    return this.config('specialText', {extends: TextNode});
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = $getDocument().createElement('span');
    addClassNamesToElement(dom, config.theme.specialText);
    dom.textContent = this.getTextContent();
    return dom;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    if (prevNode.__text !== this.__text) {
      // Write the text the same way createDOM does. Returning false promises
      // the reconciler that every difference is already in the DOM, so the
      // text has to be re-synced here or the element keeps the text it was
      // created with.
      dom.textContent = this.getTextContent();
    }

    addClassNamesToElement(dom, config.theme.specialText);

    return false;
  }

  isTextEntity(): true {
    return true;
  }
  canInsertTextAfter(): boolean {
    return false; // Prevents appending text to this node
  }
}

/**
 * Creates a SpecialTextNode with the given text.
 * @param text - Text content for the SpecialTextNode.
 * @returns A new SpecialTextNode instance.
 */
export function $createSpecialTextNode(text = ''): SpecialTextNode {
  return $applyNodeReplacement(new SpecialTextNode(text));
}

/**
 * Checks if a node is a SpecialTextNode.
 * @param node - Node to check.
 * @returns True if the node is a SpecialTextNode.
 */
export function $isSpecialTextNode(
  node: LexicalNode | null | undefined,
): node is SpecialTextNode {
  return node instanceof SpecialTextNode;
}
