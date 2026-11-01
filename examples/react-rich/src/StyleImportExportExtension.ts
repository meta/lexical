/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  defineImportRule,
  DOMImportExtension,
  domOverride,
  DOMRenderExtension,
  sel,
} from '@lexical/html';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $isTextNode,
  configExtension,
  defineExtension,
  isHTMLElement,
  ParagraphNode,
  TextNode,
} from 'lexical';

import {parseAllowedColor, parseAllowedFontSize} from './styleConfig';

const RemoveStylesOverride = domOverride<ParagraphNode | TextNode>(
  [ParagraphNode, TextNode],
  {
    $exportDOM(_node, $next) {
      const output = $next();
      if (isHTMLElement(output.element)) {
        // TextNode may wrap its text in nested formatting elements.
        for (const el of [
          output.element,
          ...output.element.querySelectorAll('[style],[class]'),
        ]) {
          el.removeAttribute('class');
          el.removeAttribute('style');
        }
      }
      return output;
    },
  },
);

const getExtraStyles = (element: HTMLElement): string => {
  // Keep only supported font sizes and colors from pasted input.
  let extraStyles = '';
  const fontSize = parseAllowedFontSize(element.style.fontSize);
  const backgroundColor = parseAllowedColor(element.style.backgroundColor);
  const color = parseAllowedColor(element.style.color);
  if (fontSize !== '' && fontSize !== '15px') {
    extraStyles += `font-size: ${fontSize};`;
  }
  if (backgroundColor !== '' && backgroundColor !== 'rgb(255, 255, 255)') {
    extraStyles += `background-color: ${backgroundColor};`;
  }
  if (color !== '' && color !== 'rgb(0, 0, 0)') {
    extraStyles += `color: ${color};`;
  }
  return extraStyles;
};

const AllowedStylesRule = defineImportRule({
  $import(_context, element, $next) {
    const nodes = $next();
    const extraStyles = getExtraStyles(element);
    if (extraStyles) {
      for (const node of nodes) {
        if ($isTextNode(node)) {
          node.setStyle(node.getStyle() + extraStyles);
        }
      }
    }
    return nodes;
  },
  match: sel.tag(
    'span',
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'sub',
    'sup',
    'code',
    'mark',
  ),
  name: '@lexical/examples/allowed-styles',
});

export const StyleImportExportExtension = defineExtension({
  dependencies: [
    RichTextExtension,
    configExtension(DOMImportExtension, {rules: [AllowedStylesRule]}),
    configExtension(DOMRenderExtension, {overrides: [RemoveStylesOverride]}),
  ],
  name: '@lexical/examples/StyleImportExport',
});
