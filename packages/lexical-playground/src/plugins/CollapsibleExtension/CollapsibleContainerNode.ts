/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getDocument,
  $getSiblingCaret,
  $isElementNode,
  $rewindSiblingCaret,
  type DOMExportOutput,
  type EditorConfig,
  ElementNode,
  IS_CHROME,
  IS_FIREFOX,
  isHTMLElement,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type RangeSelection,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

import {setDomHiddenUntilFound} from './CollapsibleUtils';

type SerializedCollapsibleContainerNode = Spread<
  {
    open: boolean;
  },
  SerializedElementNode
>;

export class CollapsibleContainerNode extends ElementNode {
  __open: boolean;

  constructor(open: boolean, key?: NodeKey) {
    super(key);
    this.__open = open;
  }

  $config() {
    return this.config('collapsible-container', {extends: ElementNode});
  }

  static clone(node: CollapsibleContainerNode): CollapsibleContainerNode {
    return new CollapsibleContainerNode(node.__open, node.__key);
  }

  isShadowRoot(): boolean {
    return true;
  }

  collapseAtStart(selection: RangeSelection): boolean {
    // Unwrap the CollapsibleContainerNode by replacing it with the children
    // of its children (CollapsibleTitleNode, CollapsibleContentNode)
    const nodesToInsert: LexicalNode[] = [];
    for (const child of this.getChildren()) {
      if ($isElementNode(child)) {
        nodesToInsert.push(...child.getChildren());
      }
    }
    const caret = $rewindSiblingCaret($getSiblingCaret(this, 'previous'));
    caret.splice(1, nodesToInsert);
    // Merge the first child of the CollapsibleTitleNode with the
    // previous sibling of the CollapsibleContainerNode
    const [firstChild] = nodesToInsert;
    if (firstChild) {
      firstChild.selectStart().deleteCharacter(true);
    }
    return true;
  }

  createDOM(config: EditorConfig, editor: LexicalEditor): HTMLElement {
    // details is not well supported in Chrome #5582 and Firefox #8348
    let dom: HTMLElement;
    if (IS_CHROME || IS_FIREFOX) {
      dom = $getDocument().createElement('div');
      dom.setAttribute('open', '');
    } else {
      const detailsDom = $getDocument().createElement('details');
      detailsDom.open = this.__open;
      detailsDom.addEventListener('toggle', () => {
        const open = editor.read('latest', () => this.getOpen());
        if (open !== detailsDom.open) {
          editor.update(() => this.toggleOpen());
        }
      });
      dom = detailsDom;
    }
    dom.classList.add('Collapsible__container');

    return dom;
  }

  updateDOM(prevNode: this, dom: HTMLDetailsElement): boolean {
    const currentOpen = this.__open;
    if (prevNode.__open !== currentOpen) {
      // details is not well supported in Chrome #5582 and Firefox #8348
      if (IS_CHROME || IS_FIREFOX) {
        // Look up the content element by class rather than positional index.
        // The shape `Title + Content` is invariant per the structure-enforcing
        // transformer; if a slot-aware extension prepends a leading
        // decoration (via `slot.after`) the content child would no longer sit
        // at `children[1]`. Scoped `:scope >` avoids matching content of a
        // nested CollapsibleContainer.
        const contentDom = dom.querySelector(':scope > .Collapsible__content');
        if (!isHTMLElement(contentDom)) {
          throw new Error('Expected contentDom to be an HTMLElement');
        }
        if (currentOpen) {
          dom.setAttribute('open', '');
          contentDom.hidden = false;
        } else {
          dom.removeAttribute('open');
          setDomHiddenUntilFound(contentDom);
        }
      } else {
        dom.open = this.__open;
      }
    }

    return false;
  }

  static importJSON(
    serializedNode: SerializedCollapsibleContainerNode,
  ): CollapsibleContainerNode {
    return $createCollapsibleContainerNode(serializedNode.open).updateFromJSON(
      serializedNode,
    );
  }

  exportDOM(): DOMExportOutput {
    const element = $getDocument().createElement('details');
    element.classList.add('Collapsible__container');
    // `open` is an HTML boolean attribute — its presence is what makes the
    // <details> open, whatever its value. Writing `open="false"` on a closed
    // container reads back (and renders) as open, so omit it instead. This
    // matches createDOM/updateDOM, which already set '' / removeAttribute.
    if (this.__open) {
      element.setAttribute('open', '');
    }
    return {element};
  }

  exportJSON(): SerializedCollapsibleContainerNode {
    return {
      ...super.exportJSON(),
      open: this.__open,
    };
  }

  setOpen(open: boolean): this {
    const writable = this.getWritable();
    writable.__open = open;
    return writable;
  }

  getOpen(): boolean {
    return this.getLatest().__open;
  }

  toggleOpen(): this {
    return this.setOpen(!this.getOpen());
  }
}

export function $createCollapsibleContainerNode(
  isOpen: boolean,
): CollapsibleContainerNode {
  return new CollapsibleContainerNode(isOpen);
}

export function $isCollapsibleContainerNode(
  node: LexicalNode | null | undefined,
): node is CollapsibleContainerNode {
  return node instanceof CollapsibleContainerNode;
}
