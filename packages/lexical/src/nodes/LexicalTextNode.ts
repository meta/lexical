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
  TextNodeThemeClasses,
} from '../LexicalEditor';
import type {ElementNode} from './LexicalElementNode';

import invariant from '@lexical/internal/invariant';

import {IS_FIREFOX} from '../environment';
import {
  COMPOSITION_SUFFIX,
  DETAIL_TYPE_TO_DETAIL,
  IS_BOLD,
  IS_CODE,
  IS_DIRECTIONLESS,
  IS_HIGHLIGHT,
  IS_ITALIC,
  IS_SEGMENTED,
  IS_STRIKETHROUGH,
  IS_SUBSCRIPT,
  IS_SUPERSCRIPT,
  IS_TOKEN,
  IS_UNDERLINE,
  IS_UNMERGEABLE,
  TEXT_MODE_TO_TYPE,
  TEXT_TYPE_TO_FORMAT,
  TEXT_TYPE_TO_MODE,
} from '../LexicalConstants';
import {
  type DOMConversionOutput,
  type DOMExportOutput,
  LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type SerializedLexicalNode,
} from '../LexicalNode';
import {$cloneNodeState} from '../LexicalNodeState';
import {
  $generateNodesFromRawText,
  $getSelection,
  $internalMakeRangeSelection,
  $isRangeSelection,
  $updateElementSelectionOnCreateDeleteNode,
  adjustPointOffsetForMergedSibling,
  type BaseSelection,
  type RangeSelection,
  type TextPointType,
} from '../LexicalSelection';
import {errorOnReadOnly} from '../LexicalUpdates';
import {
  $applyNodeReplacement,
  $getCompositionKey,
  $getDocument,
  $getEditor,
  $getEditorDOMRenderConfig,
  $setCompositionKey,
  getCachedClassNameArray,
  internalMarkSiblingsAsDirty,
  isDOMTextNode,
  isHTMLElement,
  isInlineDomNode,
  removeEmptyDOMAttribute,
  toggleTextFormatType,
} from '../LexicalUtils';
import {setDOMStyleFromCSS} from '../utils/setDOMStyle';

export type SerializedTextNode = Spread<
  {
    detail: number;
    format: number;
    mode: TextModeType;
    style: string;
    text: string;
  },
  SerializedLexicalNode
>;

export type TextDetailType = 'directionless' | 'unmergable';

export type TextFormatType =
  | 'bold'
  | 'underline'
  | 'strikethrough'
  | 'italic'
  | 'highlight'
  | 'code'
  | 'subscript'
  | 'superscript'
  | 'lowercase'
  | 'uppercase'
  | 'capitalize';

export type TextModeType = 'normal' | 'token' | 'segmented';

export type TextMark = {end: null | number; id: string; start: null | number};

export type TextMarks = TextMark[];

function getElementOuterTag(node: TextNode, format: number): string | null {
  if (format & IS_CODE) {
    return 'code';
  }
  if (format & IS_HIGHLIGHT) {
    return 'mark';
  }
  if (format & IS_SUBSCRIPT) {
    return 'sub';
  }
  if (format & IS_SUPERSCRIPT) {
    return 'sup';
  }
  return null;
}

function getElementInnerTag(node: TextNode, format: number): string {
  if (format & IS_BOLD) {
    return 'strong';
  }
  if (format & IS_ITALIC) {
    return 'em';
  }
  return 'span';
}

function setTextThemeClassNames(
  tag: string,
  prevFormat: number,
  nextFormat: number,
  dom: HTMLElement,
  textClassNames: TextNodeThemeClasses,
): void {
  const domClassList = dom.classList;
  // Firstly we handle the base theme.
  let classNames = getCachedClassNameArray(textClassNames, 'base');
  if (classNames !== undefined) {
    domClassList.add(...classNames);
  }
  // Secondly we handle the special case: underline + strikethrough.
  // We have to do this as we need a way to compose the fact that
  // the same CSS property will need to be used: text-decoration.
  // In an ideal world we shouldn't have to do this, but there's no
  // easy workaround for many atomic CSS systems today.
  classNames = getCachedClassNameArray(
    textClassNames,
    'underlineStrikethrough',
  );
  let hasUnderlineStrikethrough = false;
  const prevUnderlineStrikethrough =
    prevFormat & IS_UNDERLINE && prevFormat & IS_STRIKETHROUGH;
  const nextUnderlineStrikethrough =
    nextFormat & IS_UNDERLINE && nextFormat & IS_STRIKETHROUGH;

  if (classNames !== undefined) {
    if (nextUnderlineStrikethrough) {
      hasUnderlineStrikethrough = true;
      if (!prevUnderlineStrikethrough) {
        domClassList.add(...classNames);
      }
    } else if (prevUnderlineStrikethrough) {
      domClassList.remove(...classNames);
    }
  }

  for (const key in TEXT_TYPE_TO_FORMAT) {
    const format = key;
    const flag = TEXT_TYPE_TO_FORMAT[format];
    classNames = getCachedClassNameArray(textClassNames, key);
    if (classNames !== undefined) {
      if (nextFormat & flag) {
        if (
          hasUnderlineStrikethrough &&
          (key === 'underline' || key === 'strikethrough')
        ) {
          if (prevFormat & flag) {
            domClassList.remove(...classNames);
          }
          continue;
        }
        if (
          (prevFormat & flag) === 0 ||
          (prevUnderlineStrikethrough && key === 'underline') ||
          key === 'strikethrough'
        ) {
          domClassList.add(...classNames);
        }
      } else if (prevFormat & flag) {
        domClassList.remove(...classNames);
      }
    }
  }
  removeEmptyDOMAttribute(dom, 'class');
}

function diffComposedText(a: string, b: string): [number, number, string] {
  const aLength = a.length;
  const bLength = b.length;
  let left = 0;
  let right = 0;

  while (left < aLength && left < bLength && a[left] === b[left]) {
    left++;
  }
  while (
    right + left < aLength &&
    right + left < bLength &&
    a[aLength - right - 1] === b[bLength - right - 1]
  ) {
    right++;
  }

  return [left, aLength - left - right, b.slice(left, bLength - right)];
}

function $setTextContent(
  nextText: string,
  dom: HTMLElement,
  node: TextNode,
): void {
  const isComposing = node.isComposing();
  // Always add a suffix if we're composing a node
  const suffix = isComposing ? COMPOSITION_SUFFIX : '';
  const text: string = nextText + suffix;

  // Route through the editor-level `$getDOMSlot` hook so that
  // `DOMRenderExtension` overrides targeting TextNode (e.g. extensions
  // injecting `contentEditable=false` siblings around the text) can
  // intercept. The default impl delegates to `node.getDOMSlot(dom)`.
  //
  // Practical contract for extensions that append non-lexical siblings to a
  // vanilla TextNode's DOM (e.g. an autocomplete ghost rendered into the
  // same `<span>`): append-only is safe because the default
  // `DOMSlot.getFirstChild()` returns the first DOM child (the text node)
  // and `insertChild` puts new content before `slot.before` (defaulting to
  // append). Prepending a sibling, or wrapping the text node, requires
  // either a TextNode subclass with its own `getDOMSlot` override, an
  // extension that returns a slot with a managed `slot.before` / `slot.after`
  // boundary, or both.
  const editor = $getEditor();
  const slot = $getEditorDOMRenderConfig(editor).$getDOMSlot(node, dom, editor);
  const firstChild = slot.getFirstChild();

  if (firstChild === null || firstChild.nodeType !== Node.TEXT_NODE) {
    slot.insertChild($getDocument().createTextNode(text));
    return;
  }

  const textChild = firstChild as Text;
  const nodeValue = textChild.nodeValue;
  if (nodeValue === text) {
    return;
  }
  if (isComposing || IS_FIREFOX) {
    // We also use the diff composed text for general text in FF to avoid
    // the spellcheck red line from flickering.
    const [index, remove, insert] = diffComposedText(nodeValue as string, text);
    if (remove !== 0) {
      textChild.deleteData(index, remove);
    }
    textChild.insertData(index, insert);
  } else {
    textChild.nodeValue = text;
  }
}

function $createTextInnerDOM(
  innerDOM: HTMLElement,
  node: TextNode,
  innerTag: string,
  format: number,
  text: string,
  config: EditorConfig,
): void {
  $setTextContent(text, innerDOM, node);
  const theme = config.theme;
  // Apply theme class names
  const textClassNames = theme.text;

  if (textClassNames !== undefined) {
    setTextThemeClassNames(innerTag, 0, format, innerDOM, textClassNames);
  }
}

function $wrapElementWith(
  element: HTMLElement | Text,
  tag: string,
): HTMLElement {
  const el = $getDocument().createElement(tag);
  el.appendChild(element);
  return el;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface TextNode {
  getTopLevelElement(): ElementNode | null;
  getTopLevelElementOrThrow(): ElementNode;
}

export interface InlineFormattableNode {
  /** @internal */
  readonly __isInlineFormattable: true;
  getFormat(): number;
  getFormatFlags(type: TextFormatType, alignWithFormat: null | number): number;
  hasFormat(type: TextFormatType): boolean;
  setFormat(format: number): unknown;
  toggleFormat(type: TextFormatType): unknown;
}

/** Returns true if the given node supports inline text formatting. */
export function $isInlineFormattable(
  node: (LexicalNode & {__isInlineFormattable?: unknown}) | null | undefined,
): node is LexicalNode & InlineFormattableNode {
  return node != null && node.__isInlineFormattable === true;
}

/** @noInheritDoc */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class TextNode extends LexicalNode implements InlineFormattableNode {
  /** @internal */
  declare ['constructor']: KlassConstructor<typeof TextNode>;
  __text: string;
  /** @internal */
  __format: number;
  /** @internal */
  __style: string;
  /** @internal */
  __mode: 0 | 1 | 2 | 3;
  /** @internal */
  __detail: number;

  /** @internal */
  get __isInlineFormattable(): true {
    return true;
  }

  $config() {
    return this.config('text', {
      importDOM: {
        '#text': () => ({
          conversion: $convertTextDOMNode,
          priority: 0,
        }),
        b: () => ({
          conversion: convertBringAttentionToElement,
          priority: 0,
        }),
        code: () => ({
          conversion: convertTextFormatElement,
          priority: 0,
        }),
        em: () => ({
          conversion: convertTextFormatElement,
          priority: 0,
        }),
        i: () => ({
          conversion: convertTextFormatElement,
          priority: 0,
        }),
        mark: () => ({
          conversion: convertTextFormatElement,
          priority: 0,
        }),
        s: () => ({
          conversion: convertTextFormatElement,
          priority: 0,
        }),
        span: () => ({
          conversion: convertSpanElement,
          priority: 0,
        }),
        strong: () => ({
          conversion: convertTextFormatElement,
          priority: 0,
        }),
        sub: () => ({
          conversion: convertTextFormatElement,
          priority: 0,
        }),
        sup: () => ({
          conversion: convertTextFormatElement,
          priority: 0,
        }),
        u: () => ({
          conversion: convertTextFormatElement,
          priority: 0,
        }),
      },
    });
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__text = prevNode.__text;
    this.__format = prevNode.__format;
    this.__style = prevNode.__style;
    this.__mode = prevNode.__mode;
    this.__detail = prevNode.__detail;
  }

  constructor(text: string = '', key?: NodeKey) {
    super(key);
    this.__text = text;
    this.__format = 0;
    this.__style = '';
    this.__mode = 0;
    this.__detail = 0;
  }

  /**
   * Returns a 32-bit integer that represents the TextFormatTypes currently applied to the
   * TextNode. You probably don't want to use this method directly - consider using TextNode.hasFormat instead.
   *
   * @returns a number representing the format of the text node.
   */
  getFormat(): number {
    const self = this.getLatest();
    return self.__format;
  }

  /**
   * Returns a 32-bit integer that represents the TextDetailTypes currently applied to the
   * TextNode. You probably don't want to use this method directly - consider using TextNode.isDirectionless
   * or TextNode.isUnmergeable instead.
   *
   * @returns a number representing the detail of the text node.
   */
  getDetail(): number {
    const self = this.getLatest();
    return self.__detail;
  }

  /**
   * Returns the mode (TextModeType) of the TextNode, which may be "normal", "token", or "segmented"
   *
   * @returns TextModeType.
   */
  getMode(): TextModeType {
    const self = this.getLatest();
    return TEXT_TYPE_TO_MODE[self.__mode];
  }

  /**
   * Returns the styles currently applied to the node. This is analogous to CSSText in the DOM.
   *
   * @returns CSSText-like string of styles applied to the underlying DOM node.
   */
  getStyle(): string {
    const self = this.getLatest();
    return self.__style;
  }

  /**
   * Returns whether or not the node is in "token" mode. TextNodes in token mode can be navigated through character-by-character
   * with a RangeSelection, but are deleted as a single entity (not individually by character).
   *
   * @returns true if the node is in token mode, false otherwise.
   */
  isToken(): boolean {
    const self = this.getLatest();
    return self.__mode === IS_TOKEN;
  }

  /**
   *
   * @returns true if Lexical detects that an IME or other 3rd-party script is attempting to
   * mutate the TextNode, false otherwise.
   */
  isComposing(): boolean {
    return this.__key === $getCompositionKey();
  }

  /**
   * Returns whether or not the node is in "segmented" mode. TextNodes in segmented mode can be navigated through character-by-character
   * with a RangeSelection, but are deleted in space-delimited "segments".
   *
   * @returns true if the node is in segmented mode, false otherwise.
   */
  isSegmented(): boolean {
    const self = this.getLatest();
    return self.__mode === IS_SEGMENTED;
  }
  /**
   * Returns whether or not the node is "directionless". Directionless nodes don't respect changes between RTL and LTR modes.
   *
   * @returns true if the node is directionless, false otherwise.
   */
  isDirectionless(): boolean {
    const self = this.getLatest();
    return (self.__detail & IS_DIRECTIONLESS) !== 0;
  }
  /**
   * Returns whether or not the node is unmergeable. In some scenarios, Lexical tries to merge
   * adjacent TextNodes into a single TextNode. If a TextNode is unmergeable, this won't happen.
   *
   * @returns true if the node is unmergeable, false otherwise.
   */
  isUnmergeable(): boolean {
    const self = this.getLatest();
    return (self.__detail & IS_UNMERGEABLE) !== 0;
  }

  /**
   * Returns whether or not the node has the provided format applied. Use this with the human-readable TextFormatType
   * string values to get the format of a TextNode.
   *
   * @param type - the TextFormatType to check for.
   *
   * @returns true if the node has the provided format, false otherwise.
   */
  hasFormat(type: TextFormatType): boolean {
    const formatFlag = TEXT_TYPE_TO_FORMAT[type];
    return (this.getFormat() & formatFlag) !== 0;
  }

  /**
   * Returns whether or not the node is simple text. Simple text is defined as a TextNode that has the string type "text"
   * (i.e., not a subclass) and has no mode applied to it (i.e., not segmented or token).
   *
   * @returns true if the node is simple text, false otherwise.
   */
  isSimpleText(): boolean {
    return this.__type === 'text' && this.__mode === 0;
  }

  /**
   * Returns the text content of the node as a string.
   *
   * @returns a string representing the text content of the node.
   */
  getTextContent(): string {
    const self = this.getLatest();
    return self.__text;
  }

  /**
   * Returns the format flags applied to the node as a 32-bit integer.
   *
   * @returns a number representing the TextFormatTypes applied to the node.
   */
  getFormatFlags(type: TextFormatType, alignWithFormat: null | number): number {
    const self = this.getLatest();
    const format = self.__format;
    return toggleTextFormatType(format, type, alignWithFormat);
  }

  /**
   *
   * @returns true if the text node supports font styling, false otherwise.
   */
  canHaveFormat(): boolean {
    return true;
  }

  /**
   * @returns true if the text node is inline, false otherwise.
   */
  isInline(): true {
    return true;
  }

  // View

  createDOM(config: EditorConfig, editor?: LexicalEditor): HTMLElement {
    const format = this.__format;
    const outerTag = getElementOuterTag(this, format);
    const innerTag = getElementInnerTag(this, format);
    const tag = outerTag === null ? innerTag : outerTag;
    const dom = $getDocument().createElement(tag);
    let innerDOM = dom;
    if (this.hasFormat('code')) {
      dom.setAttribute('spellcheck', 'false');
    }
    if (outerTag !== null) {
      innerDOM = $getDocument().createElement(innerTag);
      dom.appendChild(innerDOM);
    }
    const text = this.__text;
    $createTextInnerDOM(innerDOM, this, innerTag, format, text, config);
    const style = this.__style;
    if (style !== '') {
      setDOMStyleFromCSS(dom.style, style);
    }
    return dom;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    const nextText = this.__text;
    const prevFormat = prevNode.__format;
    const nextFormat = this.__format;
    const prevOuterTag = getElementOuterTag(this, prevFormat);
    const nextOuterTag = getElementOuterTag(this, nextFormat);
    const prevInnerTag = getElementInnerTag(this, prevFormat);
    const nextInnerTag = getElementInnerTag(this, nextFormat);
    const prevTag = prevOuterTag === null ? prevInnerTag : prevOuterTag;
    const nextTag = nextOuterTag === null ? nextInnerTag : nextOuterTag;

    if (prevTag !== nextTag) {
      return true;
    }
    if (prevOuterTag === nextOuterTag && prevInnerTag !== nextInnerTag) {
      // should always be an element
      const prevInnerDOM: HTMLElement = dom.firstChild as HTMLElement;
      if (prevInnerDOM == null) {
        invariant(false, 'updateDOM: prevInnerDOM is null or undefined');
      }
      const nextInnerDOM = $getDocument().createElement(nextInnerTag);
      $createTextInnerDOM(
        nextInnerDOM,
        this,
        nextInnerTag,
        nextFormat,
        nextText,
        config,
      );
      dom.replaceChild(nextInnerDOM, prevInnerDOM);
      return false;
    }
    let innerDOM = dom;
    if (nextOuterTag !== null) {
      if (prevOuterTag !== null) {
        innerDOM = dom.firstChild as HTMLElement;
        if (innerDOM == null) {
          invariant(false, 'updateDOM: innerDOM is null or undefined');
        }
      }
    }
    $setTextContent(nextText, innerDOM, this);
    const theme = config.theme;
    // Apply theme class names
    const textClassNames = theme.text;

    if (textClassNames !== undefined && prevFormat !== nextFormat) {
      setTextThemeClassNames(
        nextInnerTag,
        prevFormat,
        nextFormat,
        innerDOM,
        textClassNames,
      );
    }
    const prevStyle = prevNode.__style;
    const nextStyle = this.__style;
    if (prevStyle !== nextStyle) {
      setDOMStyleFromCSS(dom.style, nextStyle, prevStyle);
      removeEmptyDOMAttribute(dom, 'style');
    }
    return false;
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedTextNode>): this {
    return super
      .updateFromJSON(serializedNode)
      .setTextContent(serializedNode.text)
      .setFormat(serializedNode.format)
      .setDetail(serializedNode.detail)
      .setMode(serializedNode.mode)
      .setStyle(serializedNode.style);
  }

  // This improves Lexical's basic text output in copy+paste plus
  // for headless mode where people might use Lexical to generate
  // HTML content and not have the ability to use CSS classes.
  exportDOM(editor: LexicalEditor): DOMExportOutput {
    let {element} = super.exportDOM(editor);
    invariant(
      isHTMLElement(element),
      'Expected TextNode createDOM to always return a HTMLElement',
    );
    element.style.whiteSpace = 'pre-wrap';

    // Add text-transform styles for capitalization formats
    if (this.hasFormat('lowercase')) {
      element.style.textTransform = 'lowercase';
    } else if (this.hasFormat('uppercase')) {
      element.style.textTransform = 'uppercase';
    } else if (this.hasFormat('capitalize')) {
      element.style.textTransform = 'capitalize';
    }

    // This is the only way to properly add support for most clients,
    // even if it's semantically incorrect to have to resort to using
    // <b>, <u>, <s>, <i> elements.
    if (this.hasFormat('bold')) {
      element = $wrapElementWith(element, 'b');
    }
    if (this.hasFormat('italic')) {
      element = $wrapElementWith(element, 'i');
    }
    if (this.hasFormat('strikethrough')) {
      element = $wrapElementWith(element, 's');
    }
    if (this.hasFormat('underline')) {
      element = $wrapElementWith(element, 'u');
    }

    return {
      element,
    };
  }

  exportJSON(): SerializedTextNode {
    return {
      detail: this.getDetail(),
      format: this.getFormat(),
      mode: this.getMode(),
      style: this.getStyle(),
      text: this.getTextContent(),
      // As an exception here we invoke super at the end for historical reasons.
      // Namely, to preserve the order of the properties and not to break the tests
      // that use the serialized string representation.
      ...super.exportJSON(),
    };
  }

  // Mutators
  selectionTransform(
    prevSelection: null | BaseSelection,
    nextSelection: RangeSelection,
  ): void {
    return;
  }

  /**
   * Sets the node format to the provided TextFormatType or 32-bit integer. Note that the TextFormatType
   * version of the argument can only specify one format and doing so will remove all other formats that
   * may be applied to the node. For toggling behavior, consider using {@link TextNode.toggleFormat}
   *
   * @param format - TextFormatType or 32-bit integer representing the node format.
   *
   * @returns this TextNode.
   * // TODO 0.12 This should just be a `string`.
   */
  setFormat(format: TextFormatType | number): this {
    const self = this.getWritable();
    self.__format =
      typeof format === 'string' ? TEXT_TYPE_TO_FORMAT[format] : format;
    return self;
  }

  /**
   * Sets the node detail to the provided TextDetailType or 32-bit integer. Note that the TextDetailType
   * version of the argument can only specify one detail value and doing so will remove all other detail values that
   * may be applied to the node. For toggling behavior, consider using {@link TextNode.toggleDirectionless}
   * or {@link TextNode.toggleUnmergeable}
   *
   * @param detail - TextDetailType or 32-bit integer representing the node detail.
   *
   * @returns this TextNode.
   * // TODO 0.12 This should just be a `string`.
   */
  setDetail(detail: TextDetailType | number): this {
    const self = this.getWritable();
    self.__detail =
      typeof detail === 'string' ? DETAIL_TYPE_TO_DETAIL[detail] : detail;
    return self;
  }

  /**
   * Sets the node style to the provided CSSText-like string. Set this property as you
   * would an HTMLElement style attribute to apply inline styles to the underlying DOM Element.
   *
   * @param style - CSSText to be applied to the underlying HTMLElement.
   *
   * @returns this TextNode.
   */
  setStyle(style: string): this {
    const self = this.getWritable();
    self.__style = style;
    return self;
  }

  /**
   * Applies the provided format to this TextNode if it's not present. Removes it if it's present.
   * The subscript and superscript formats are mutually exclusive.
   * Prefer using this method to turn specific formats on and off.
   *
   * @param type - TextFormatType to toggle.
   *
   * @returns this TextNode.
   */
  toggleFormat(type: TextFormatType): this {
    const format = this.getFormat();
    const newFormat = toggleTextFormatType(format, type, null);
    return this.setFormat(newFormat);
  }

  /**
   * Toggles the directionless detail value of the node. Prefer using this method over setDetail.
   *
   * @returns this TextNode.
   */
  toggleDirectionless(): this {
    const self = this.getWritable();
    self.__detail ^= IS_DIRECTIONLESS;
    return self;
  }

  /**
   * Toggles the unmergeable detail value of the node. Prefer using this method over setDetail.
   *
   * @returns this TextNode.
   */
  toggleUnmergeable(): this {
    const self = this.getWritable();
    self.__detail ^= IS_UNMERGEABLE;
    return self;
  }

  /**
   * Sets the mode of the node.
   *
   * Note: during IME composition, a segmented TextNode may be temporarily
   * switched to normal mode to preserve the DOM element that the browser's
   * composition tracker is bound to. Subclass transforms or method overrides
   * that assume the node is always in segmented mode should account for this
   * transient state.
   *
   * @returns this TextNode.
   */
  setMode(type: TextModeType): this {
    const mode = TEXT_MODE_TO_TYPE[type];
    if (this.__mode === mode) {
      return this;
    }
    const self = this.getWritable();
    self.__mode = mode;
    return self;
  }

  /**
   * Sets the text content of the node.
   *
   * @param text - the string to set as the text value of the node.
   *
   * @returns this TextNode.
   */
  setTextContent(text: string): this {
    if (this.__text === text) {
      return this;
    }
    const self = this.getWritable();
    self.__text = text;
    return self;
  }

  /**
   * Sets the current Lexical selection to be a RangeSelection with anchor and focus on this TextNode at the provided offsets.
   *
   * @param _anchorOffset - the offset at which the Selection anchor will be placed.
   * @param _focusOffset - the offset at which the Selection focus will be placed.
   *
   * @returns the new RangeSelection.
   */
  select(_anchorOffset?: number, _focusOffset?: number): RangeSelection {
    errorOnReadOnly();
    let anchorOffset = _anchorOffset;
    let focusOffset = _focusOffset;
    const selection = $getSelection();
    const text = this.getTextContent();
    const key = this.__key;
    if (typeof text === 'string') {
      const lastOffset = text.length;
      if (anchorOffset === undefined) {
        anchorOffset = lastOffset;
      }
      if (focusOffset === undefined) {
        focusOffset = lastOffset;
      }
    } else {
      anchorOffset = 0;
      focusOffset = 0;
    }
    if (!$isRangeSelection(selection)) {
      return $internalMakeRangeSelection(
        key,
        anchorOffset,
        key,
        focusOffset,
        'text',
        'text',
      );
    } else {
      const compositionKey = $getCompositionKey();
      if (
        compositionKey === selection.anchor.key ||
        compositionKey === selection.focus.key
      ) {
        $setCompositionKey(key);
      }
      selection.setTextNodeRange(this, anchorOffset, this, focusOffset);
    }
    return selection;
  }

  selectStart(): RangeSelection {
    return this.select(0, 0);
  }

  selectEnd(): RangeSelection {
    const size = this.getTextContentSize();
    return this.select(size, size);
  }

  /**
   * Inserts the provided text into this TextNode at the provided offset, deleting the number of characters
   * specified. Can optionally calculate a new selection after the operation is complete.
   *
   * @param offset - the offset at which the splice operation should begin.
   * @param delCount - the number of characters to delete, starting from the offset.
   * @param newText - the text to insert into the TextNode at the offset.
   * @param moveSelection - optional, whether or not to move selection to the end of the inserted substring.
   *
   * @returns this TextNode.
   */
  spliceText(
    offset: number,
    delCount: number,
    newText: string,
    moveSelection?: boolean,
  ): TextNode {
    const writableSelf = this.getWritable();
    const text = writableSelf.__text;
    const handledTextLength = newText.length;
    let index = offset;
    if (index < 0) {
      index = handledTextLength + index;
      if (index < 0) {
        index = 0;
      }
    }
    const selection = $getSelection();
    if (moveSelection && $isRangeSelection(selection)) {
      const newOffset = offset + handledTextLength;
      selection.setTextNodeRange(
        writableSelf,
        newOffset,
        writableSelf,
        newOffset,
      );
    }

    const updatedText =
      text.slice(0, index) + newText + text.slice(index + delCount);

    writableSelf.__text = updatedText;
    return writableSelf;
  }

  /**
   * This method is meant to be overridden by TextNode subclasses to control the behavior of those nodes
   * when a user event would cause text to be inserted before them in the editor. If true, Lexical will attempt
   * to insert text into this node. If false, it will insert the text in a new sibling node.
   *
   * @returns true if text can be inserted before the node, false otherwise.
   */
  canInsertTextBefore(): boolean {
    return true;
  }

  /**
   * This method is meant to be overridden by TextNode subclasses to control the behavior of those nodes
   * when a user event would cause text to be inserted after them in the editor. If true, Lexical will attempt
   * to insert text into this node. If false, it will insert the text in a new sibling node.
   *
   * @returns true if text can be inserted after the node, false otherwise.
   */
  canInsertTextAfter(): boolean {
    return true;
  }

  /**
   * Splits this TextNode at the provided character offsets, forming new TextNodes from the substrings
   * formed by the split, and inserting those new TextNodes into the editor, replacing the one that was split.
   *
   * @param splitOffsets - rest param of the text content character offsets at which this node should be split.
   *
   * @returns an Array containing the newly-created TextNodes.
   */
  splitText(...splitOffsets: number[]): TextNode[] {
    errorOnReadOnly();
    const self = this.getLatest();
    const textContent = self.getTextContent();
    if (textContent === '') {
      return [];
    }
    const key = self.__key;
    const compositionKey = $getCompositionKey();
    const textLength = textContent.length;
    splitOffsets.sort((a, b) => a - b);
    splitOffsets.push(textLength);
    const parts = [];
    const splitOffsetsLength = splitOffsets.length;
    for (
      let start = 0, offsetIndex = 0;
      start < textLength && offsetIndex <= splitOffsetsLength;
      offsetIndex++
    ) {
      const end = splitOffsets[offsetIndex];
      if (end > start) {
        parts.push(textContent.slice(start, end));
        start = end;
      }
    }
    const partsLength = parts.length;
    if (partsLength === 1) {
      return [self];
    }
    const firstPart = parts[0];
    const parent = self.getParent();
    let writableNode;
    const format = self.getFormat();
    const style = self.getStyle();
    const detail = self.__detail;
    let hasReplacedSelf = false;

    // Prepare to handle selection
    let startTextPoint: TextPointType | null = null;
    let endTextPoint: TextPointType | null = null;
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      const [startPoint, endPoint] = selection.isBackward()
        ? [selection.focus, selection.anchor]
        : [selection.anchor, selection.focus];
      if (startPoint.type === 'text' && startPoint.key === key) {
        startTextPoint = startPoint;
      }
      if (endPoint.type === 'text' && endPoint.key === key) {
        endTextPoint = endPoint;
      }
    }

    if (self.isSegmented()) {
      // Create a new TextNode
      writableNode = $createTextNode(firstPart);
      writableNode.__format = format;
      writableNode.__style = style;
      writableNode.__detail = detail;
      writableNode.__state = $cloneNodeState(self, writableNode);
      hasReplacedSelf = true;
    } else {
      // For the first part, update the existing node
      writableNode = self.setTextContent(firstPart);
    }

    // Then handle all other parts
    const splitNodes: TextNode[] = [writableNode];
    let textSize = firstPart.length;

    for (let i = 1; i < partsLength; i++) {
      const part = parts[i];
      const partSize = part.length;
      const sibling = $createTextNode(part);
      sibling.__format = format;
      sibling.__style = style;
      sibling.__detail = detail;
      sibling.__state = $cloneNodeState(self, sibling);
      const siblingKey = sibling.__key;
      const nextTextSize = textSize + partSize;
      if (compositionKey === key) {
        $setCompositionKey(siblingKey);
      }
      textSize = nextTextSize;
      splitNodes.push(sibling);
    }

    // Move the selection to the best location in the split string.
    // The end point is always left-biased, and the start point is
    // generally left biased unless the end point would land on a
    // later node in the split in which case it will prefer the start
    // of that node so they will tend to be on the same node.
    const originalStartOffset = startTextPoint ? startTextPoint.offset : null;
    const originalEndOffset = endTextPoint ? endTextPoint.offset : null;
    let startOffset = 0;
    for (const node of splitNodes) {
      if (!(startTextPoint || endTextPoint)) {
        break;
      }
      const endOffset = startOffset + node.getTextContentSize();
      if (
        startTextPoint !== null &&
        originalStartOffset !== null &&
        originalStartOffset <= endOffset &&
        originalStartOffset >= startOffset
      ) {
        // Set the start point to the first valid node
        startTextPoint.set(
          node.getKey(),
          originalStartOffset - startOffset,
          'text',
        );
        if (originalStartOffset < endOffset) {
          // The start isn't on a border so we can stop checking
          startTextPoint = null;
        }
      }
      if (
        endTextPoint !== null &&
        originalEndOffset !== null &&
        originalEndOffset <= endOffset &&
        originalEndOffset >= startOffset
      ) {
        endTextPoint.set(
          node.getKey(),
          originalEndOffset - startOffset,
          'text',
        );
        break;
      }
      startOffset = endOffset;
    }

    // Insert the nodes into the parent's children
    if (parent !== null) {
      internalMarkSiblingsAsDirty(this);
      const writableParent = parent.getWritable();
      const insertionIndex = this.getIndexWithinParent();
      if (hasReplacedSelf) {
        writableParent.splice(insertionIndex, 0, splitNodes);
        this.remove();
      } else {
        writableParent.splice(insertionIndex, 1, splitNodes);
      }

      if ($isRangeSelection(selection)) {
        $updateElementSelectionOnCreateDeleteNode(
          selection,
          parent,
          insertionIndex,
          partsLength - 1,
        );
      }
    }

    return splitNodes;
  }

  /**
   * Merges the target TextNode into this TextNode, removing the target node.
   *
   * @param target - the TextNode to merge into this one.
   *
   * @returns this TextNode.
   */
  mergeWithSibling(target: TextNode): TextNode {
    const isBefore = target === this.getPreviousSibling();
    if (!isBefore && target !== this.getNextSibling()) {
      invariant(
        false,
        'mergeWithSibling: sibling must be a previous or next sibling',
      );
    }
    const key = this.__key;
    const targetKey = target.__key;
    const text = this.__text;
    const textLength = text.length;
    const compositionKey = $getCompositionKey();

    if (compositionKey === targetKey) {
      $setCompositionKey(key);
    }
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      const anchor = selection.anchor;
      const focus = selection.focus;
      if (anchor !== null && anchor.key === targetKey) {
        adjustPointOffsetForMergedSibling(
          anchor,
          isBefore,
          key,
          target,
          textLength,
        );
      }
      if (focus !== null && focus.key === targetKey) {
        adjustPointOffsetForMergedSibling(
          focus,
          isBefore,
          key,
          target,
          textLength,
        );
      }
    }
    const targetText = target.__text;
    const newText = isBefore ? targetText + text : text + targetText;
    this.setTextContent(newText);
    const writableSelf = this.getWritable();
    target.remove();
    return writableSelf;
  }

  /**
   * This method is meant to be overridden by TextNode subclasses to control the behavior of those nodes
   * when used with the registerLexicalTextEntity function. If you're using registerLexicalTextEntity, the
   * node class that you create and replace matched text with should return true from this method.
   *
   * @returns true if the node is to be treated as a "text entity", false otherwise.
   */
  isTextEntity(): boolean {
    return false;
  }
}

function convertSpanElement(domNode: HTMLSpanElement): DOMConversionOutput {
  // domNode is a <span> since we matched it by nodeName
  const span = domNode;
  const style = span.style;

  return {
    forChild: applyTextFormatFromStyle(style),
    node: null,
  };
}

function convertBringAttentionToElement(
  domNode: HTMLElement,
): DOMConversionOutput {
  // domNode is a <b> since we matched it by nodeName
  const b = domNode;
  // Google Docs wraps all copied HTML in a <b> with font-weight normal
  const hasNormalFontWeight = b.style.fontWeight === 'normal';

  return {
    forChild: applyTextFormatFromStyle(
      b.style,
      hasNormalFontWeight ? undefined : 'bold',
    ),
    node: null,
  };
}

const preParentCache = new WeakMap<Node, null | Node>();

function isNodePre(node: Node): boolean {
  if (!isHTMLElement(node)) {
    return false;
  } else if (node.nodeName === 'PRE') {
    return true;
  }
  const whiteSpace = node.style.whiteSpace;
  return typeof whiteSpace === 'string' && whiteSpace.startsWith('pre');
}

export function findParentPreDOMNode(node: Node) {
  let cached;
  let parent = node.parentNode;
  const visited = [node];
  while (
    parent !== null &&
    (cached = preParentCache.get(parent)) === undefined &&
    !isNodePre(parent)
  ) {
    visited.push(parent);
    parent = parent.parentNode;
  }
  const resultNode = cached === undefined ? parent : cached;
  for (let i = 0; i < visited.length; i++) {
    preParentCache.set(visited[i], resultNode);
  }
  return resultNode;
}

function $convertTextDOMNode(domNode: Node): DOMConversionOutput {
  const domNode_ = domNode as Text;
  const parentDom = domNode.parentElement;
  invariant(
    parentDom !== null,
    'Expected parentElement of Text not to be null',
  );
  let textContent = domNode_.textContent || '';
  // No collapse and preserve segment break for pre, pre-wrap and pre-line
  if (findParentPreDOMNode(domNode_) !== null) {
    return {node: $generateNodesFromRawText(textContent)};
  }
  textContent = textContent.replace(/\r/g, '').replace(/[ \t\n]+/g, ' ');
  if (textContent === '') {
    return {node: null};
  }
  if (textContent[0] === ' ') {
    // Traverse backward while in the same line. If content contains new line or tab -> potential
    // delete, other elements can borrow from this one. Deletion depends on whether it's also the
    // last space (see next condition: textContent[textContent.length - 1] === ' '))
    let previousText: null | Text = domNode_;
    let isStartOfLine = true;
    while (
      previousText !== null &&
      (previousText = findTextInLine(previousText, false)) !== null
    ) {
      const previousTextContent = previousText.textContent || '';
      if (previousTextContent.length > 0) {
        if (/[ \t\n]$/.test(previousTextContent)) {
          textContent = textContent.slice(1);
        }
        isStartOfLine = false;
        break;
      }
    }
    if (isStartOfLine) {
      textContent = textContent.slice(1);
    }
  }
  if (textContent[textContent.length - 1] === ' ') {
    // Traverse forward while in the same line, preserve if next inline will require a space
    let nextText: null | Text = domNode_;
    let isEndOfLine = true;
    while (
      nextText !== null &&
      (nextText = findTextInLine(nextText, true)) !== null
    ) {
      const nextTextContent = (nextText.textContent || '').replace(
        /^( |\t|\r?\n)+/,
        '',
      );
      if (nextTextContent.length > 0) {
        isEndOfLine = false;
        break;
      }
    }
    if (isEndOfLine) {
      textContent = textContent.slice(0, textContent.length - 1);
    }
  }
  if (textContent === '') {
    return {node: null};
  }
  return {node: $createTextNode(textContent)};
}

function findTextInLine(text: Text, forward: boolean): null | Text {
  let node: Node = text;

  while (true) {
    let sibling: null | Node;
    while (
      (sibling = forward ? node.nextSibling : node.previousSibling) === null
    ) {
      const parentElement = node.parentElement;
      if (parentElement === null) {
        return null;
      }
      node = parentElement;
    }
    node = sibling;
    if (isHTMLElement(node)) {
      const display = node.style.display;
      if (
        (display === '' && !isInlineDomNode(node)) ||
        (display !== '' && !display.startsWith('inline'))
      ) {
        return null;
      }
    }
    let descendant: null | Node = node;
    while ((descendant = forward ? node.firstChild : node.lastChild) !== null) {
      node = descendant;
    }
    if (isDOMTextNode(node)) {
      return node;
    } else if (node.nodeName === 'BR') {
      return null;
    }
  }
}

const nodeNameToTextFormat: Record<string, TextFormatType> = {
  code: 'code',
  em: 'italic',
  i: 'italic',
  mark: 'highlight',
  s: 'strikethrough',
  strong: 'bold',
  sub: 'subscript',
  sup: 'superscript',
  u: 'underline',
};

function convertTextFormatElement(domNode: HTMLElement): DOMConversionOutput {
  const format = nodeNameToTextFormat[domNode.nodeName.toLowerCase()];
  if (format === undefined) {
    return {node: null};
  }
  return {
    forChild: applyTextFormatFromStyle(domNode.style, format),
    node: null,
  };
}

/** Creates a TextNode initialized with the given text, defaulting to empty. */
export function $createTextNode(text = ''): TextNode {
  return $applyNodeReplacement(new TextNode(text));
}

/** Returns true if the given node is a TextNode. */
export function $isTextNode(
  node: LexicalNode | null | undefined,
): node is TextNode {
  return node instanceof TextNode;
}

function applyTextFormatFromStyle(
  style: CSSStyleDeclaration,
  shouldApply?: TextFormatType,
) {
  const fontWeight = style.fontWeight;
  const textDecoration = style.textDecoration.split(' ');
  // Google Docs uses span tags + font-weight for bold text
  const hasBoldFontWeight = fontWeight === '700' || fontWeight === 'bold';
  // Google Docs uses span tags + text-decoration: line-through for strikethrough text
  const hasLinethroughTextDecoration = textDecoration.includes('line-through');
  // Google Docs uses span tags + font-style for italic text
  const hasItalicFontStyle = style.fontStyle === 'italic';
  // Google Docs uses span tags + text-decoration: underline for underline text
  const hasUnderlineTextDecoration = textDecoration.includes('underline');
  // Google Docs uses span tags + vertical-align to specify subscript and superscript
  const verticalAlign = style.verticalAlign;
  // TextNode.exportDOM writes text-transform for the capitalization formats,
  // so read it back here or they are lost on every HTML round trip (#8915).
  const textTransform = style.textTransform;

  return (lexicalNode: LexicalNode) => {
    if (!$isTextNode(lexicalNode) && !$isInlineFormattable(lexicalNode)) {
      return lexicalNode;
    }
    if (hasBoldFontWeight && !lexicalNode.hasFormat('bold')) {
      lexicalNode.toggleFormat('bold');
    }
    if (
      hasLinethroughTextDecoration &&
      !lexicalNode.hasFormat('strikethrough')
    ) {
      lexicalNode.toggleFormat('strikethrough');
    }
    if (hasItalicFontStyle && !lexicalNode.hasFormat('italic')) {
      lexicalNode.toggleFormat('italic');
    }
    if (hasUnderlineTextDecoration && !lexicalNode.hasFormat('underline')) {
      lexicalNode.toggleFormat('underline');
    }
    if (verticalAlign === 'sub' && !lexicalNode.hasFormat('subscript')) {
      lexicalNode.toggleFormat('subscript');
    }
    if (verticalAlign === 'super' && !lexicalNode.hasFormat('superscript')) {
      lexicalNode.toggleFormat('superscript');
    }
    if (
      (textTransform === 'lowercase' ||
        textTransform === 'uppercase' ||
        textTransform === 'capitalize') &&
      !lexicalNode.hasFormat(textTransform)
    ) {
      lexicalNode.toggleFormat(textTransform);
    }

    if (shouldApply && !lexicalNode.hasFormat(shouldApply)) {
      lexicalNode.toggleFormat(shouldApply);
    }

    return lexicalNode;
  };
}
