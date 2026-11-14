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
  type ElementDOMSlot,
  ElementNode,
  enumValue,
  isHTMLElement,
  type LexicalEditor,
  type LexicalNode,
  type LexicalParseJSON,
  type NodeKey,
  nodeSchema,
  nullable,
  numberValue,
  optional,
  type ParagraphNode,
  type SerializedElementNode,
  type SerializedPartial,
  type Spread,
  stringValue,
  withAccessors,
  withField,
} from 'lexical';

import {COLUMN_WIDTH, PIXEL_VALUE_REG_EXP} from './constants';
import {GENERATED_TABLECELL} from './LexicalTableGeneratedJSON';

/** @internal */
export const EMPTY_CELL_OVERLAY_ATTRIBUTE =
  'data-lexical-table-empty-cell-overlay';

// Declared as bindings and collected into the exported object, rather than
// written as literals inside it, so that the schema below can name one without
// a module-scope property read. Such a read is a side effect to esbuild and
// webpack — it cannot see that the object has no getter — and it retains the
// whole statement plus everything the statement references, which here is the
// entire schema (#9120).
const NO_STATUS = 0;
const ROW = 1;
const COLUMN = 2;
const BOTH = 3;

export const TableCellHeaderStates = {
  BOTH,
  COLUMN,
  NO_STATUS,
  ROW,
};

export type TableCellHeaderState =
  (typeof TableCellHeaderStates)[keyof typeof TableCellHeaderStates];

const tableCellNodeSchema = nodeSchema<TableCellNode>()({
  // defaultAsNull preserves the legacy `backgroundColor || null` semantics:
  // an empty string means "no background", which exportDOM checks for.
  backgroundColor: withField(nullable(stringValue(), {defaultAsNull: true}), {
    field: '__backgroundColor',
  }),
  // A span is a positive integer; 0 (the historical `|| 1` case), a negative,
  // or a fractional span is out of domain and falls back to 1.
  colSpan: withField(numberValue(1, {integer: true, min: 1}), {
    field: '__colSpan',
  }),
  // Neither accessor is the conventional get<Prop>/set<Prop>: headerState is
  // read through getHeaderStyles and applied through setHeaderStyles (with its
  // default BOTH mask). The read is still the field, standing in for the
  // getter so a subclass that overrides it reclaims the property; the write
  // goes through the method, which supplies that mask.
  headerState: withAccessors(numberValue(NO_STATUS), {
    getter: {field: '__headerState', method: 'getHeaderStyles'},
    setter: 'setHeaderStyles',
  }),
  rowSpan: withField(numberValue(1, {integer: true, min: 1}), {
    field: '__rowSpan',
  }),
  // The domain exportJSON already enforces via isValidVerticalAlign; anything
  // else (including the historical falsy `|| undefined` case) is absent.
  // `undefined` leads the list, so it is the default.
  // The setter is the field it writes rather than setVerticalAlign, whose
  // `|| undefined` is a no-op over this enum: every value the parse yields is
  // already `undefined`, 'middle' or 'bottom'. Naming it is what tells the
  // clone where `verticalAlign` lives.
  verticalAlign: withAccessors(enumValue([undefined, 'middle', 'bottom']), {
    getter: 'getSerializedVerticalAlign',
    setter: {field: '__verticalAlign'},
  }),
  // A width of 0 is not a real width, matching the historical
  // `serializedNode.width || undefined`.
  width: withField(optional(numberValue(), {omitDefault: true}), {
    field: '__width',
  }),
});

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

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface TableCellNode {
  exportJSON(compact?: false): SerializedTableCellNode;
  exportJSON(compact: boolean): SerializedPartial<SerializedTableCellNode>;
  updateFromJSON(
    serializedNode: LexicalParseJSON<SerializedTableCellNode>,
  ): this;
}

/** @noInheritDoc */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
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
      children: 'block',
      extends: ElementNode,
      generated: GENERATED_TABLECELL,
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
      json: tableCellNodeSchema,
    });
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

  getDOMSlot(element: HTMLElement): ElementDOMSlot<HTMLElement> {
    const slot = super.getDOMSlot(element);
    // Keep the cell's children before the iOS empty cell overlay, so DOM child
    // offsets still match the node's children.
    const last = element.lastElementChild;
    return last !== null && last.hasAttribute(EMPTY_CELL_OVERLAY_ATTRIBUTE)
      ? slot.withBefore(last)
      : slot;
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

  /** @internal Serialized `verticalAlign`, or undefined to omit it. */
  getSerializedVerticalAlign(): 'bottom' | 'middle' | undefined {
    const verticalAlign = this.getLatest().__verticalAlign;
    return isValidVerticalAlign(verticalAlign) ? verticalAlign : undefined;
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
