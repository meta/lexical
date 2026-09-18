/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {ClipboardDOMImportExtension} from '@lexical/clipboard';
import {
  CoreImportExtension,
  defineImportRule,
  DOMImportExtension,
  sel,
} from '@lexical/html';
import {LinkExtension} from '@lexical/link';
import {
  $isElementNode,
  $isTextNode,
  configExtension,
  defineExtension,
  type LexicalNode,
} from 'lexical';

import {parseAllowedFontSize} from '../plugins/ToolbarPlugin/fontSize';
import {parseAllowedColor} from '../ui/ColorPicker';

function getPlaygroundExtraStyles(element: HTMLElement): string {
  // Parse styles from pasted input, but only if they match exactly the
  // sort of styles that would be produced by exportDOM
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
}

function $appendStyleToTextDescendants(
  node: LexicalNode,
  extraStyle: string,
): void {
  if ($isTextNode(node)) {
    node.setStyle(node.getStyle() + extraStyle);
  } else if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      $appendStyleToTextDescendants(child, extraStyle);
    }
  }
}

/**
 * Mirrors the legacy `buildHTMLConfig`-time wrapping of TextNode importers:
 * for any inline-format element (b/code/em/i/mark/s/span/strong/sub/sup/u),
 * if the element carries playground-allowed inline styles
 * (`font-size`, `background-color`, `color`), append those to the inline
 * style of every TextNode descendant produced by the lower-priority
 * `InlineFormatRule`.
 */
const PlaygroundInlineStyleRule = defineImportRule({
  $import: (_ctx, el, $next) => {
    const extraStyle = getPlaygroundExtraStyles(el);
    const result = $next();
    if (extraStyle) {
      for (const node of result) {
        $appendStyleToTextDescendants(node, extraStyle);
      }
    }
    return result;
  },
  match: sel.tag(
    'b',
    'code',
    'em',
    'i',
    'mark',
    's',
    'span',
    'strong',
    'sub',
    'sup',
    'u',
  ),
  name: '@lexical/playground/inline-extra-styles',
});

/**
 * Mode-independent playground DOM import rules — currently just the inline
 * extra-styles overlay. The block-host rules (Card, PullQuote, Review) are
 * registered by their own node extensions, so they ride the same mode gate as
 * the rest of the rich-text node set rather than living here.
 */
export const PlaygroundImportRules = [PlaygroundInlineStyleRule];

/**
 * Plain-text-safe DOM-import baseline, added in `AppExtension` so it applies in
 * every editor mode:
 *
 *  - {@link CoreImportExtension} (paragraphs, text, line breaks, generic
 *    block/inline handling, plus the registration-gated core rules such as the
 *    `<hr>` rule)
 *  - {@link LinkExtension} (always in the playground; registers its own
 *    `<a>` import rule)
 *  - {@link ClipboardDOMImportExtension} so pastes flow through the pipeline
 *  - the playground-specific {@link PlaygroundImportRules} overlay
 *
 * Every other import rule rides its node extension — the rich-text framework
 * nodes (rich-text, list, table, code) each register their own rules, and the
 * playground block hosts (Card, PullQuote, Review) do the same in
 * `PlaygroundRichTextExtension`. So the importer set automatically matches the
 * node set per mode, and plain-text mode never pulls in `RichTextExtension`
 * (which *conflicts* with `PlainTextExtension`).
 */
export const PlaygroundImportExtension = defineExtension({
  dependencies: [
    CoreImportExtension,
    LinkExtension,
    ClipboardDOMImportExtension,
    configExtension(DOMImportExtension, {
      rules: PlaygroundImportRules,
    }),
  ],
  name: '@lexical/playground/Import',
});
