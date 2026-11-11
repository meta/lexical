/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getDocument,
  $getState,
  $setState,
  createState,
  DecoratorNode,
  defineExtension,
  type EditorConfig,
  type InlineFormattableNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeStateVersion,
  numberValue,
  type SerializedLexicalNode,
  type Spread,
  type StateConfigValue,
  type StateValueOrUpdater,
  TEXT_TYPE_TO_FORMAT,
  type TextFormatType,
  toggleTextFormatType,
} from 'lexical';

export type SerializedDecoratorTextNode = Spread<
  {
    format: number;
  },
  SerializedLexicalNode
>;

const formatState = createState('format', {
  parse: numberValue(),
});

export class DecoratorTextNode
  extends DecoratorNode<unknown>
  implements InlineFormattableNode
{
  /** @internal */
  get __isInlineFormattable(): true {
    return true;
  }

  $config() {
    return this.config('decorator-text', {
      extends: DecoratorNode,
      stateConfigs: [{flat: true, stateConfig: formatState}],
    });
  }

  getFormat(version?: NodeStateVersion): StateConfigValue<typeof formatState> {
    return $getState(this, formatState, version);
  }

  getFormatFlags(type: TextFormatType, alignWithFormat: null | number): number {
    return toggleTextFormatType(this.getFormat(), type, alignWithFormat);
  }

  hasFormat(type: TextFormatType): boolean {
    const formatFlag = TEXT_TYPE_TO_FORMAT[type];
    return (this.getFormat() & formatFlag) !== 0;
  }

  setFormat(type: StateValueOrUpdater<typeof formatState>): this {
    return $setState(this, formatState, type);
  }

  toggleFormat(type: TextFormatType): this {
    const format = this.getFormat();
    const newFormat = toggleTextFormatType(format, type, null);
    return this.setFormat(newFormat);
  }

  isInline(): true {
    return true;
  }

  createDOM(config: EditorConfig, editor: LexicalEditor): HTMLElement {
    return $getDocument().createElement('span');
  }
}

export function $isDecoratorTextNode(
  node: LexicalNode | null | undefined,
): node is DecoratorTextNode {
  return node instanceof DecoratorTextNode;
}

/**
 * Applies formatting to the node based on the properties in the passed style object.
 * By default, properties are checked according to the values set
 * when importing content from Google Docs.
 * This algorithm is identical to the TextNode import.

 * @param lexicalNode The node to which the format will apply
 * @param style CSS style object
 * @param shouldApply format to apply if it is not in style
 * @returns lexicalNode
 */
export function applyFormatFromStyle(
  lexicalNode: DecoratorTextNode,
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

  if (hasBoldFontWeight && !lexicalNode.hasFormat('bold')) {
    lexicalNode.toggleFormat('bold');
  }
  if (hasLinethroughTextDecoration && !lexicalNode.hasFormat('strikethrough')) {
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
  if (shouldApply && !lexicalNode.hasFormat(shouldApply)) {
    lexicalNode.toggleFormat(shouldApply);
  }

  return lexicalNode;
}

/**
 * The function wraps the passed DOM node in semantic tags depending on the node format.
 *
 * @param lexicalNode The node where the format is checked
 * @param domNode DOM that will be wrapped in tags
 * @param tagNameToFormat Tag name and format mapping
 * @returns domNode
 */
export function applyFormatToDom<T extends Text | HTMLElement>(
  lexicalNode: DecoratorTextNode,
  domNode: T,
  tagNameToFormat = DEFAULT_TAG_NAME_TO_FORMAT,
): T | HTMLElement {
  let rval: T | HTMLElement = domNode;
  for (const [tag, format] of Object.entries(tagNameToFormat)) {
    if (lexicalNode.hasFormat(format)) {
      rval = wrapElementWith(rval, tag);
    }
  }
  return rval;
}

/**
 * @deprecated Use {@link applyFormatToDom} instead. The `$` prefix was a
 * mistake in the 0.47 release: the implementation does not read any editor
 * state, so the dollar convention does not apply. This alias is kept for
 * compatibility with 0.47.
 */
export const $applyFormatToDom = applyFormatToDom;

function wrapElementWith(
  element: HTMLElement | Text,
  tag: string,
): HTMLElement {
  const el = element.ownerDocument.createElement(tag);
  el.appendChild(element);
  return el;
}

const DEFAULT_TAG_NAME_TO_FORMAT: {[key: string]: TextFormatType} = {
  b: 'bold',
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

/**
 * An extension that registers DecoratorTextNode with the editor.
 */
export const DecoratorTextExtension = defineExtension({
  name: '@lexical/extension/DecoratorText',
  nodes: () => [DecoratorTextNode],
});
