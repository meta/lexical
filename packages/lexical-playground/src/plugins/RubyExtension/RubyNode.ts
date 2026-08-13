/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {addClassNamesToElement} from '@lexical/utils';
import {
  $create,
  $createTextNode,
  $getDocument,
  $getSelection,
  $getState,
  $getStateChange,
  $isRangeSelection,
  $isTextNode,
  $setState,
  createState,
  type DOMExportOutput,
  type DOMSlot,
  type EditorConfig,
  isHTMLElement,
  type LexicalNode,
  type NodeStateVersion,
  type StateConfigValue,
  type StateValueOrUpdater,
  TextNode,
} from 'lexical';

const annotationState = /* @__PURE__ */ createState('annotation', {
  parse: v => (typeof v === 'string' ? v : ''),
});

/** @noInheritDoc */
export class RubyNode extends TextNode {
  $config() {
    return this.config('ruby', {
      extends: TextNode,
      stateConfigs: [{flat: true, stateConfig: annotationState}],
    });
  }

  createDOM(config: EditorConfig): HTMLElement {
    const inner = super.createDOM(config);
    inner.dataset.rubyAnnotation = this.getAnnotation();
    addClassNamesToElement(
      inner,
      config.theme.ruby || 'PlaygroundEditorTheme__ruby',
    );
    const wrapper = $getDocument().createElement('span');
    wrapper.setAttribute('role', 'group');
    wrapper.setAttribute(
      'aria-label',
      `${this.getTextContent()} (${this.getAnnotation()})`,
    );
    wrapper.appendChild(inner);
    return wrapper;
  }

  getDOMSlot(dom: HTMLElement): DOMSlot<HTMLElement> {
    const inner = dom.firstElementChild;
    if (isHTMLElement(inner)) {
      return super.getDOMSlot(dom).withElement(inner);
    }
    return super.getDOMSlot(dom);
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    // `dom` is the wrapper, but createDOM applies the text format classes and
    // the node style to the inner element, so super has to be handed the same
    // element or the two disagree about where those live.
    const inner = dom.firstElementChild;
    if (!isHTMLElement(inner)) {
      return true;
    }
    const updated = super.updateDOM(prevNode, inner, config);
    const annotationChange = $getStateChange(this, prevNode, annotationState);
    if (annotationChange || prevNode.__text !== this.__text) {
      inner.dataset.rubyAnnotation = this.getAnnotation();
      dom.setAttribute(
        'aria-label',
        `${this.__text} (${this.getAnnotation()})`,
      );
    }
    return updated;
  }

  exportDOM(): DOMExportOutput {
    const ruby = $getDocument().createElement('ruby');
    ruby.textContent = this.getTextContent();
    const rpOpen = $getDocument().createElement('rp');
    rpOpen.textContent = '(';
    ruby.appendChild(rpOpen);
    const rt = $getDocument().createElement('rt');
    rt.textContent = this.getAnnotation();
    ruby.appendChild(rt);
    const rpClose = $getDocument().createElement('rp');
    rpClose.textContent = ')';
    ruby.appendChild(rpClose);
    return {element: ruby};
  }

  getAnnotation(
    version?: NodeStateVersion,
  ): StateConfigValue<typeof annotationState> {
    return $getState(this, annotationState, version);
  }

  setAnnotation(
    valueOrUpdater: StateValueOrUpdater<typeof annotationState>,
  ): this {
    return $setState(this, annotationState, valueOrUpdater);
  }

  isInline(): true {
    return true;
  }

  canInsertTextBefore(): false {
    return false;
  }

  canInsertTextAfter(): false {
    return false;
  }
}

export function $createRubyNode(text: string, annotation: string): RubyNode {
  return $create(RubyNode)
    .setTextContent(text)
    .setMode('token')
    .setAnnotation(annotation);
}

export function $isRubyNode(
  node: LexicalNode | null | undefined,
): node is RubyNode {
  return node instanceof RubyNode;
}

/**
 * Replace a RubyNode with a plain TextNode containing the same text,
 * preserving format and style.
 */
export function $unwrapRubyNode(node: RubyNode): TextNode {
  const text = $createTextNode(node.getTextContent());
  text.setFormat(node.getFormat());
  text.setStyle(node.getStyle());
  node.replace(text);
  return text;
}

export function $toggleRuby(annotation: string | null): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return;
  }

  if (annotation === null) {
    for (const node of selection.getNodes()) {
      if ($isRubyNode(node)) {
        $unwrapRubyNode(node);
      }
    }
    return;
  }

  if (selection.isCollapsed()) {
    return;
  }

  const nodes = selection.getNodes();
  const firstTextNode = nodes.find($isTextNode);
  const text = selection.getTextContent();
  const rubyNode = $createRubyNode(text, annotation);
  if (firstTextNode) {
    rubyNode.setFormat(firstTextNode.getFormat());
    rubyNode.setStyle(firstTextNode.getStyle());
  }
  selection.insertNodes([rubyNode]);
}
