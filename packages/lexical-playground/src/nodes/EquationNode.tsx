/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';

import katex from 'katex';
import {
  $applyNodeReplacement,
  $getDocument,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import * as React from 'react';

const EquationComponent = React.lazy(() => import('./EquationComponent'));

export type SerializedEquationNode = Spread<
  {
    equation: string;
    inline: boolean;
  },
  SerializedLexicalNode
>;

/**
 * btoa/atob only handle Latin-1, so go through the UTF-8 bytes -- the same way
 * docSerialization does. An equation is free-form LaTeX and routinely holds
 * code points above U+00FF (`\text{α}`, CJK, an emoji), which btoa throws on.
 * Pure ASCII encodes byte for byte, so previously exported HTML still decodes.
 */
export function encodeEquation(equation: string): string {
  const bytes = new TextEncoder().encode(equation);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Inverse of {@link encodeEquation}. */
export function decodeEquation(encoded: string): string {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export class EquationNode extends DecoratorNode<JSX.Element> {
  __equation: string;
  __inline: boolean;

  $config() {
    return this.config('equation', {extends: DecoratorNode});
  }

  constructor(equation: string = '', inline?: boolean, key?: NodeKey) {
    super(key);
    this.__equation = equation;
    this.__inline = inline ?? false;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__equation = prevNode.__equation;
    this.__inline = prevNode.__inline;
  }

  static importJSON(serializedNode: SerializedEquationNode): EquationNode {
    return $createEquationNode(
      serializedNode.equation,
      serializedNode.inline,
    ).updateFromJSON(serializedNode);
  }

  exportJSON(): SerializedEquationNode {
    return {
      ...super.exportJSON(),
      equation: this.getEquation(),
      inline: this.isInline(),
    };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = $getDocument().createElement(
      this.__inline ? 'span' : 'div',
    );
    // EquationNodes should implement `user-action:none` in their CSS to avoid issues with deletion on Android.
    element.className = 'editor-equation';
    element.setAttribute('role', 'math');
    element.setAttribute('aria-label', `Equation: ${this.getEquation()}`);
    return element;
  }

  exportDOM(): DOMExportOutput {
    const element = $getDocument().createElement(
      this.__inline ? 'span' : 'div',
    );
    // Encode the equation as base64 to avoid issues with special characters
    const equation = encodeEquation(this.__equation);
    element.setAttribute('data-lexical-equation', equation);
    element.setAttribute('data-lexical-inline', `${this.__inline}`);
    katex.render(this.__equation, element, {
      displayMode: !this.__inline, // true === block display //
      errorColor: '#cc0000',
      output: 'html',
      strict: 'warn',
      throwOnError: false,
      trust: false,
    });
    element.setAttribute('role', 'math');
    element.setAttribute('aria-label', `Equation: ${this.__equation}`);
    return {element};
  }

  updateDOM(prevNode: this, dom: HTMLElement): boolean {
    // If the inline property changes, replace the element
    if (this.__inline !== prevNode.__inline) {
      return true;
    }
    if (this.__equation !== prevNode.__equation) {
      dom.setAttribute('aria-label', `Equation: ${this.getEquation()}`);
    }
    return false;
  }

  getTextContent(): string {
    return this.getEquation();
  }

  isInline(): boolean {
    return this.getLatest().__inline;
  }

  getEquation(): string {
    return this.getLatest().__equation;
  }

  setEquation(equation: string): this {
    const writable = this.getWritable();
    writable.__equation = equation;
    return writable;
  }

  decorate(): JSX.Element {
    return (
      <EquationComponent
        equation={this.__equation}
        inline={this.__inline}
        nodeKey={this.__key}
      />
    );
  }
}

export function $createEquationNode(
  equation = '',
  inline = false,
): EquationNode {
  const equationNode = new EquationNode(equation, inline);
  return $applyNodeReplacement(equationNode);
}

export function $isEquationNode(
  node: LexicalNode | null | undefined,
): node is EquationNode {
  return node instanceof EquationNode;
}
