/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Html, MdastExportHandler, PhrasingContent} from '@lexical/mdast';

import {
  $withImportContext,
  contextValue,
  defineImportRule,
  DOMImportExtension,
  ImportTextStyle,
  sel,
} from '@lexical/html';
import {MdastExtension, MdastHtmlExtension} from '@lexical/mdast';
import {getCSSFromStyleObject} from '@lexical/selection';
import {
  $isTextNode,
  configExtension,
  defineExtension,
  getStyleObjectFromCSS,
  type TextFormatType,
  TextNode,
} from 'lexical';

// Text-level constructs that are a good case for HTML rather than Markdown:
// Markdown has no syntax for underline, highlight, sub/superscript, or text
// color, but GFM passes the corresponding inline HTML through. With
// MdastHtmlExtension routing raw HTML through the DOM import rules,
// this extension only has to close the loop:
//
// - import: `<u>`, `<mark>`, `<sub>`, `<sup>` already map to format bits via
//   the core rules; a rule here adds `<span style="color: …">` (and
//   background-color) to the ImportTextStyle context.
// - export: text carrying those formats/styles serializes as the same
//   inline HTML around ordinary Markdown, so `<u>**x**</u>` round-trips.

// The inline style properties that round-trip (an allowlist keeps pasted
// style soup out of the document).
const STYLE_PROPS = ['background-color', 'color'] as const;

/** The allowlisted subset of a parsed style record. */
function allowedStyles(
  read: (prop: string) => string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const prop of STYLE_PROPS) {
    const value = read(prop);
    if (value) {
      out[prop] = value;
    }
  }
  return out;
}

// `<span style="color: …">` contributes its allowlisted properties to the
// ImportTextStyle context — the core `#text` rule (and the raw-HTML
// placeholder rule) apply that context to the text they produce. Everything
// else about the span still goes through `$next()`, so one that also
// carries `font-weight: bold` keeps its format handling from the core
// inline-format rule.
const StyledSpanImportRule = defineImportRule({
  $import: (ctx, el, $next) => {
    // The DOM already parsed the style attribute; read it back per prop.
    const styles = allowedStyles(prop => el.style.getPropertyValue(prop));
    if (Object.keys(styles).length === 0) {
      return $next();
    }
    return $withImportContext([
      contextValue(ImportTextStyle, {...ctx.get(ImportTextStyle), ...styles}),
    ])(() => $next());
  },
  match: sel.tag('span').attr('style', true),
  name: '@lexical/dev-mdast-editor-example/styled-span',
});

// The formats Markdown can't express, and the tag each travels in.
const HTML_FORMAT_TAGS: readonly [TextFormatType, string][] = [
  ['underline', 'u'],
  ['highlight', 'mark'],
  ['subscript', 'sub'],
  ['superscript', 'sup'],
];

// Wraps text carrying html-only formats/styles in the corresponding inline
// HTML, keeping the Markdown-expressible formats as Markdown inside the
// wrapper (`<u>**x**</u>`). Plain text returns null and keeps the core
// text handling.
const $exportHtmlFormattedText: MdastExportHandler = node => {
  if (!$isTextNode(node)) {
    return null;
  }
  const tags: string[] = [];
  for (const [format, tag] of HTML_FORMAT_TAGS) {
    if (node.hasFormat(format)) {
      tags.push(tag);
    }
  }
  const parsed = getStyleObjectFromCSS(node.getStyle());
  const css = getCSSFromStyleObject(allowedStyles(prop => parsed[prop]));
  if (tags.length === 0 && css === '') {
    return null;
  }
  // Nested as the core text serialization nests (emphasis around strong).
  let content: PhrasingContent = node.hasFormat('code')
    ? {type: 'inlineCode', value: node.getTextContent()}
    : {type: 'text', value: node.getTextContent()};
  if (node.hasFormat('bold')) {
    content = {children: [content], type: 'strong'};
  }
  if (node.hasFormat('italic')) {
    content = {children: [content], type: 'emphasis'};
  }
  if (node.hasFormat('strikethrough')) {
    content = {children: [content], type: 'delete'};
  }
  const open: Html = {
    type: 'html',
    value:
      tags.map(tag => `<${tag}>`).join('') +
      (css === '' ? '' : `<span style="${css.replace(/"/g, '&quot;')}">`),
  };
  const close: Html = {
    type: 'html',
    value:
      (css === '' ? '' : '</span>') +
      tags
        .map(tag => `</${tag}>`)
        .reverse()
        .join(''),
  };
  return [open, content, close];
};

/**
 * Round-trips the text formats Markdown has no syntax for — underline,
 * highlight, sub/superscript, and (allowlisted) inline color styles — as
 * inline HTML, the way GitHub-flavored Markdown carries them. Import rides
 * {@link MdastHtmlExtension} and the core DOM format rules; this
 * extension adds the `<span style>` import context and the export side.
 */
export const HtmlTextFormatExtension = defineExtension({
  dependencies: [
    MdastHtmlExtension,
    configExtension(DOMImportExtension, {
      rules: [StyledSpanImportRule],
    }),
    configExtension(MdastExtension, {
      exportRules: [{$export: $exportHtmlFormattedText, type: TextNode}],
    }),
  ],
  name: '@lexical/dev-mdast-editor-example/HtmlTextFormat',
});
