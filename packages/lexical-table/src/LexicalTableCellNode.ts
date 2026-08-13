/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $applyNodeReplacement,
  $createParagraphNode,
  $getDocument,
  $isInlineElementOrDecoratorNode,
  $isLineBreakNode,
  $isTextNode,
  $setDirectionFromDOM,
  addClassNamesToElement,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  ElementNode,
  isHTMLElement,
  type LexicalEditor,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type ParagraphNode,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

import {COLUMN_WIDTH, PIXEL_VALUE_REG_EXP} from './constants';

export const TableCellHeaderStates = {
  BOTH: 3,
  COLUMN: 2,
  NO_STATUS: 0,
  ROW: 1,
};

export type TableCellHeaderState =
  (typeof TableCellHeaderStates)[keyof typeof TableCellHeaderStates];

export type SerializedTableCellNode = Spread<
  {
    colSpan?: number;
    rowSpan?: number;
    headerState: TableCellHeaderState;
    width?: number;
    backgroundColor?: null | string;
    verticalAlign?: string;
  },
  SerializedElementNode
>;

/** @noInheritDoc */
export class TableCellNode extends ElementNode {
  /** @internal */
  __colSpan: number;
  /** @internal */
  __rowSpan: number;
  /** @internal */
  __headerState: TableCellHeaderState;
  /** @internal */
  __width?: number | undefined;
  /** @internal */
  __backgroundColor: null | string;
  /** @internal */
  __verticalAlign?: undefined | string;

  $config() {
    return this.config('tablecell', {
      extends: ElementNode,
      importDOM: {
        td: () => ({
          conversion: $convertTableCellNodeElement,
          priority: 0,
        }),
        th: () => ({
          conversion: $convertTableCellNodeElement,
          priority: 0,
        }),
      },
    });
  }

  afterCloneFrom(node: this): void {
    super.afterCloneFrom(node);
    this.__rowSpan = node.__rowSpan;
    this.__backgroundColor = node.__backgroundColor;
    this.__verticalAlign = node.__verticalAlign;
    this.__colSpan = node.__colSpan;
    this.__headerState = node.__headerState;
    this.__width = node.__width;
  }

  updateFromJSON(
    serializedNode: LexicalUpdateJSON<SerializedTableCellNode>,
  ): this {
    return super
      .updateFromJSON(serializedNode)
      .setHeaderStyles(serializedNode.headerState)
      .setColSpan(serializedNode.colSpan || 1)
      .setRowSpan(serializedNode.rowSpan || 1)
      .setWidth(serializedNode.width || undefined)
      .setBackgroundColor(serializedNode.backgroundColor || null)
      .setVerticalAlign(serializedNode.verticalAlign || undefined);
  }

  constructor(
    headerState = TableCellHeaderStates.NO_STATUS,
    colSpan = 1,
    width?: number,
    key?: NodeKey,
  ) {
    super(key);
    this.__colSpan = colSpan;
    this.__rowSpan = 1;
    this.__headerState = headerState;
    this.__width = width;
    this.__backgroundColor = null;
    this.__verticalAlign = undefined;
  }

  createDOM(config: EditorConfig): HTMLTableCellElement {
    const element = $getDocument().createElement(this.getTag());

    if (this.__width) {
      element.style.width = `${this.__width}px`;
    }
    if (this.__colSpan > 1) {
      element.colSpan = this.__colSpan;
    }
    if (this.__rowSpan > 1) {
      element.rowSpan = this.__rowSpan;
    }
    if (this.__backgroundColor !== null) {
      element.style.backgroundColor = this.__backgroundColor;
    }
    if (isValidVerticalAlign(this.__verticalAlign)) {
      element.style.verticalAlign = this.__verticalAlign;
    }

    addClassNamesToElement(
      element,
      config.theme.tableCell,
      this.hasHeader() && config.theme.tableCellHeader,
    );

    return element;
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const output = super.exportDOM(editor);

    if (isHTMLElement(output.element)) {
      const element = output.element as HTMLTableCellElement;
      element.setAttribute(
        'data-temporary-table-cell-lexical-key',
        this.getKey(),
      );
      element.style.border = '1px solid black';
      if (this.__colSpan > 1) {
        element.colSpan = this.__colSpan;
      }
      if (this.__rowSpan > 1) {
        element.rowSpan = this.__rowSpan;
      }
      element.style.width = `${this.getWidth() || COLUMN_WIDTH}px`;

      element.style.verticalAlign = this.getVerticalAlign() || 'top';
      element.style.textAlign = 'start';
      if (this.__backgroundColor === null && this.hasHeader()) {
        element.style.backgroundColor = '#f2f3f5';
      }
    }

    return output;
  }

  exportJSON(): SerializedTableCellNode {
    return {
      ...super.exportJSON(),
      ...(isValidVerticalAlign(this.__verticalAlign) && {
        verticalAlign: this.__verticalAlign,
      }),
      backgroundColor: this.getBackgroundColor(),
      colSpan: this.__colSpan,
      headerState: this.__headerState,
      rowSpan: this.__rowSpan,
      width: this.getWidth(),
    };
  }

  getColSpan(): number {
    return this.getLatest().__colSpan;
  }

  setColSpan(colSpan: number): this {
    const self = this.getWritable();
    self.__colSpan = colSpan;
    return self;
  }

  getRowSpan(): number {
    return this.getLatest().__rowSpan;
  }

  setRowSpan(rowSpan: number): this {
    const self = this.getWritable();
    self.__rowSpan = rowSpan;
    return self;
  }

  getTag(): 'th' | 'td' {
    return this.hasHeader() ? 'th' : 'td';
  }

  setHeaderStyles(
    headerState: TableCellHeaderState,
    mask: TableCellHeaderState = TableCellHeaderStates.BOTH,
  ): this {
    const self = this.getWritable();
    self.__headerState = (headerState & mask) | (self.__headerState & ~mask);
    return self;
  }

  getHeaderStyles(): TableCellHeaderState {
    return this.getLatest().__headerState;
  }

  setWidth(width: number | undefined): this {
    const self = this.getWritable();
    self.__width = width;
    return self;
  }

  getWidth(): number | undefined {
    return this.getLatest().__width;
  }

  getBackgroundColor(): null | string {
    return this.getLatest().__backgroundColor;
  }

  setBackgroundColor(newBackgroundColor: null | string): this {
    const self = this.getWritable();
    self.__backgroundColor = newBackgroundColor;
    return self;
  }

  getVerticalAlign(): undefined | string {
    return this.getLatest().__verticalAlign;
  }

  setVerticalAlign(newVerticalAlign: null | undefined | string): this {
    const self = this.getWritable();
    self.__verticalAlign = newVerticalAlign || undefined;
    return self;
  }

  toggleHeaderStyle(headerStateToToggle: TableCellHeaderState): this {
    const self = this.getWritable();

    // The test is bitwise ("does it already have all of these bits") so the
    // mutation has to be too. `+=`/`-=` happen to agree for a single-bit
    // argument, but for BOTH they overflow the enum: toggling BOTH on a cell
    // that only has ROW produced __headerState 4, which is neither ROW, COLUMN,
    // BOTH nor NO_STATUS.
    if ((self.__headerState & headerStateToToggle) === headerStateToToggle) {
      self.__headerState &= ~headerStateToToggle;
    } else {
      self.__headerState |= headerStateToToggle;
    }

    return self;
  }

  hasHeaderState(headerState: TableCellHeaderState): boolean {
    return (this.getHeaderStyles() & headerState) === headerState;
  }

  hasHeader(): boolean {
    return this.getLatest().__headerState !== TableCellHeaderStates.NO_STATUS;
  }

  updateDOM(prevNode: this): boolean {
    return (
      prevNode.__headerState !== this.__headerState ||
      prevNode.__width !== this.__width ||
      prevNode.__colSpan !== this.__colSpan ||
      prevNode.__rowSpan !== this.__rowSpan ||
      prevNode.__backgroundColor !== this.__backgroundColor ||
      prevNode.__verticalAlign !== this.__verticalAlign
    );
  }

  isShadowRoot(): boolean {
    return true;
  }

  collapseAtStart(): true {
    return true;
  }

  canBeEmpty(): false {
    return false;
  }

  canIndent(): false {
    return false;
  }
}

function isValidVerticalAlign(
  verticalAlign?: null | string,
): verticalAlign is 'middle' | 'bottom' {
  return verticalAlign === 'middle' || verticalAlign === 'bottom';
}

export function $convertTableCellNodeElement(
  domNode: Node,
): DOMConversionOutput {
  const domNode_ = domNode as HTMLTableCellElement;
  const nodeName = domNode.nodeName.toLowerCase();

  let width: number | undefined = undefined;

  if (PIXEL_VALUE_REG_EXP.test(domNode_.style.width)) {
    width = parseFloat(domNode_.style.width);
  }

  // Determine header state based on the 'scope' attribute
  let headerState = TableCellHeaderStates.NO_STATUS;

  if (nodeName === 'th') {
    const scope = domNode_.getAttribute('scope');
    if (scope === 'col') {
      headerState = TableCellHeaderStates.COLUMN;
    } else if (scope === 'row') {
      headerState = TableCellHeaderStates.ROW;
    } else {
      const parentRow = domNode_.parentElement;
      const isInHeaderRow =
        isHTMLElement(parentRow) &&
        parentRow.nodeName.toLowerCase() === 'tr' &&
        isHTMLElement(parentRow.parentElement) &&
        (parentRow.parentElement.nodeName.toLowerCase() === 'thead' ||
          (parentRow as HTMLTableRowElement).rowIndex === 0);
      const isFirstColumn = domNode_.cellIndex === 0;

      if (isInHeaderRow) {
        headerState |= TableCellHeaderStates.ROW;
      }
      if (isFirstColumn) {
        headerState |= TableCellHeaderStates.COLUMN;
      }
      if (headerState === TableCellHeaderStates.NO_STATUS) {
        headerState = TableCellHeaderStates.ROW;
      }
    }
  }

  const tableCellNode = $createTableCellNode(
    headerState,
    domNode_.colSpan,
    width,
  );

  tableCellNode.__rowSpan = domNode_.rowSpan;
  const backgroundColor = domNode_.style.backgroundColor;
  if (backgroundColor !== '') {
    tableCellNode.__backgroundColor = backgroundColor;
  }
  const verticalAlign = domNode_.style.verticalAlign;
  if (isValidVerticalAlign(verticalAlign)) {
    tableCellNode.__verticalAlign = verticalAlign;
  }
  $setDirectionFromDOM(tableCellNode, domNode_);

  const style = domNode_.style;
  const textDecoration = ((style && style.textDecoration) || '').split(' ');
  const hasBoldFontWeight =
    style.fontWeight === '700' || style.fontWeight === 'bold';
  const hasLinethroughTextDecoration = textDecoration.includes('line-through');
  const hasItalicFontStyle = style.fontStyle === 'italic';
  const hasUnderlineTextDecoration = textDecoration.includes('underline');
  const color = style.color;
  return {
    after: childLexicalNodes => {
      const result: LexicalNode[] = [];
      let paragraphNode: ParagraphNode | null = null;

      const removeSingleLineBreakNode = () => {
        if (paragraphNode) {
          const firstChild = paragraphNode.getFirstChild();
          if (
            $isLineBreakNode(firstChild) &&
            paragraphNode.getChildrenSize() === 1
          ) {
            firstChild.remove();
          }
        }
      };

      for (const child of childLexicalNodes) {
        if (
          $isInlineElementOrDecoratorNode(child) ||
          $isTextNode(child) ||
          $isLineBreakNode(child)
        ) {
          if ($isTextNode(child)) {
            if (hasBoldFontWeight) {
              child.toggleFormat('bold');
            }
            if (hasLinethroughTextDecoration) {
              child.toggleFormat('strikethrough');
            }
            if (hasItalicFontStyle) {
              child.toggleFormat('italic');
            }
            if (hasUnderlineTextDecoration) {
              child.toggleFormat('underline');
            }
            if (color) {
              const existingStyle = child.getStyle();
              if (!existingStyle.includes('color:')) {
                child.setStyle(existingStyle + `color: ${color};`);
              }
            }
          }

          if (paragraphNode) {
            paragraphNode.append(child);
          } else {
            paragraphNode = $createParagraphNode().append(child);
            result.push(paragraphNode);
          }
        } else {
          result.push(child);
          removeSingleLineBreakNode();
          paragraphNode = null;
        }
      }

      removeSingleLineBreakNode();

      if (result.length === 0) {
        result.push($createParagraphNode());
      }
      return result;
    },
    node: tableCellNode,
  };
}

export function $createTableCellNode(
  headerState: TableCellHeaderState = TableCellHeaderStates.NO_STATUS,
  colSpan = 1,
  width?: number,
): TableCellNode {
  return $applyNodeReplacement(new TableCellNode(headerState, colSpan, width));
}

export function $isTableCellNode(
  node: LexicalNode | null | undefined,
): node is TableCellNode {
  return node instanceof TableCellNode;
}
