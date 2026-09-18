/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  EditorConfig,
  KlassConstructor,
  LexicalEditor,
  Spread,
} from '../LexicalEditor';
import type {
  DOMConversionOutput,
  DOMExportOutput,
  LexicalNode,
} from '../LexicalNode';
import type {BaseSelection, RangeSelection} from '../LexicalSelection';

import {$isBlockFullySelected} from '../caret/LexicalCaretUtils';
import {ELEMENT_TYPE_TO_FORMAT} from '../LexicalConstants';
import {$isRangeSelection} from '../LexicalSelection';
import {
  $applyNodeReplacement,
  $getDocument,
  $setDirectionFromDOM,
  $setFormatFromDOM,
  getCachedClassNameArray,
  isHTMLElement,
  setNodeIndentFromDOM,
} from '../LexicalUtils';
import {
  type ElementFormatType,
  ElementNode,
  type SerializedElementNode,
} from './LexicalElementNode';
import {$isTextNode} from './LexicalTextNode';

export type SerializedParagraphNode = Spread<
  {
    textFormat: number;
    textStyle: string;
  },
  SerializedElementNode
>;

/** @noInheritDoc */
export class ParagraphNode extends ElementNode {
  /** @internal */
  declare ['constructor']: KlassConstructor<typeof ParagraphNode>;

  $config() {
    return this.config('paragraph', {
      extends: ElementNode,
      importDOM: {
        p: () => ({
          conversion: $convertParagraphElement,
          priority: 0,
        }),
      },
    });
  }

  // View

  createDOM(config: EditorConfig): HTMLElement {
    const dom = $getDocument().createElement('p');
    const classNames = getCachedClassNameArray(config.theme, 'paragraph');
    if (classNames !== undefined) {
      const domClassList = dom.classList;
      domClassList.add(...classNames);
    }
    return dom;
  }
  updateDOM(
    prevNode: ParagraphNode,
    dom: HTMLElement,
    config: EditorConfig,
  ): boolean {
    return false;
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const {element} = super.exportDOM(editor);

    if (isHTMLElement(element)) {
      if (this.isEmpty()) {
        element.append($getDocument().createElement('br'));
      }

      const formatType = this.getFormatType();
      if (formatType) {
        element.style.textAlign = formatType;
      }
    }

    return {
      element,
    };
  }

  exportJSON(): SerializedParagraphNode {
    const json = super.exportJSON();
    // Provide backwards compatible values, see #7971
    if (json.textFormat === undefined || json.textStyle === undefined) {
      // Compute the same value that the reconciler would
      const firstTextNode = this.getChildren().find($isTextNode);
      if (firstTextNode) {
        json.textFormat = firstTextNode.getFormat();
        json.textStyle = firstTextNode.getStyle();
      } else {
        json.textFormat = this.getTextFormat();
        json.textStyle = this.getTextStyle();
      }
    }
    return json as SerializedParagraphNode;
  }

  extractWithChild(
    child: LexicalNode,
    selection: BaseSelection | null,
    destination: 'clone' | 'html',
  ): boolean {
    if (!$isRangeSelection(selection)) {
      return false;
    }
    // Alignment, indent and inline style live on the paragraph element and
    // nowhere else. Splicing the children up into the payload drops them
    // silently (#8101), so a paragraph carrying any of that has to travel as a
    // block. A paragraph carrying none of it serializes identically either
    // way, so it is left alone and keeps producing inline-only content — the
    // long-standing shape that clipboard consumers expect.
    if (
      this.getFormatType() === '' &&
      this.getIndent() === 0 &&
      this.getStyle() === ''
    ) {
      return false;
    }
    // A partial selection is a fragment of a line rather than a block: that
    // fragment must merge into the paste target instead of imposing its source
    // block on it.
    if ($isBlockFullySelected(this, selection)) {
      const textContent = this.getTextContent();
      return textContent !== '' && selection.getTextContent() === textContent;
    }
    return false;
  }

  // Mutation

  insertNewAfter(
    rangeSelection: RangeSelection,
    restoreSelection: boolean,
  ): ParagraphNode {
    const newElement = $createParagraphNode();
    newElement.setTextFormat(rangeSelection.format);
    newElement.setTextStyle(rangeSelection.style);
    const direction = this.getDirection();
    newElement.setDirection(direction);
    newElement.setFormat(this.getFormatType());
    newElement.setStyle(this.getStyle());
    this.insertAfter(newElement, restoreSelection);
    return newElement;
  }

  collapseAtStart(): boolean {
    // If we have an empty (trimmed) first paragraph and try and remove it,
    // delete the paragraph as long as we have another sibling to go to.
    // Every child has to be blank text: a paragraph that merely starts with
    // blank text still has content to lose, and a non-text child (an inline
    // decorator, a line break) is content even when it contributes no text.
    if (
      this.getChildren().every(
        node => $isTextNode(node) && !/\S/.test(node.getTextContent()),
      )
    ) {
      const nextSibling = this.getNextSibling();
      if (nextSibling !== null) {
        this.selectNext();
        this.remove();
        return true;
      }
      const prevSibling = this.getPreviousSibling();
      if (prevSibling !== null) {
        this.selectPrevious();
        this.remove();
        return true;
      }
    }
    return false;
  }
}

function $convertParagraphElement(element: HTMLElement): DOMConversionOutput {
  const node = $createParagraphNode();
  $setFormatFromDOM(node, element);
  setNodeIndentFromDOM(element, node);

  // Check legacy 'align' attribute
  // Only use this if no format was set by CSS
  if (node.getFormatType() === '') {
    const align = element.getAttribute('align');
    if (align) {
      if (align && align in ELEMENT_TYPE_TO_FORMAT) {
        node.setFormat(align as ElementFormatType);
      }
    }
  }
  $setDirectionFromDOM(node, element);
  return {node};
}

/** Creates a ParagraphNode, the default block-level container for text. */
export function $createParagraphNode(): ParagraphNode {
  return $applyNodeReplacement(new ParagraphNode());
}

/** Returns true if the given node is a ParagraphNode. */
export function $isParagraphNode(
  node: LexicalNode | null | undefined,
): node is ParagraphNode {
  return node instanceof ParagraphNode;
}
