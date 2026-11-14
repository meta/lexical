/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  BlockSchema,
  defineImportRule,
  type DOMImportContext,
  sel,
} from '@lexical/html';
import {
  $setDirectionFromDOM,
  $setFormatFromDOM,
  isHTMLElement,
  setNodeIndentFromDOM,
} from 'lexical';

import {
  $createHeadingNode,
  $createQuoteContainerNode,
  $createQuoteNode,
  type HeadingTagType,
  type QuoteNode,
} from './index';

/**
 * Heuristic copied (in spirit) from the legacy `isGoogleDocsTitle`:
 * Google Docs serializes the document title as a `<span style="font-size:
 * 26pt">` (sometimes wrapped in a `<p>`). The presence of a 26pt span at
 * the start of a `<p>` is treated as a heading-1 marker.
 */
function isGoogleDocsTitleSpan(node: Node): boolean {
  return (
    isHTMLElement(node) &&
    node.nodeName === 'SPAN' &&
    node.style.fontSize === '26pt'
  );
}

const HeadingRule = defineImportRule({
  $import: (ctx, el) => {
    const tag = el.nodeName.toLowerCase() as HeadingTagType;
    const node = $createHeadingNode(tag);
    setNodeIndentFromDOM(el, node);
    $setFormatFromDOM(node, el);
    $setDirectionFromDOM(node, el);
    return [node.splice(0, 0, ctx.$importChildren(el))];
  },
  match: sel.tag('h1', 'h2', 'h3', 'h4', 'h5', 'h6'),
  name: '@lexical/rich-text/heading',
});

/**
 * Fills `node` from a `<blockquote>`. A quote that is a shadow root (a
 * {@link QuoteContainerNode}, or a `QuoteNode` with the `shadowRoot` state)
 * holds blocks, so its children are imported as blocks (`BlockSchema`: runs
 * of inline content are wrapped in paragraphs); any other quote holds the
 * inline content.
 */
function $importQuote(
  ctx: DOMImportContext,
  el: HTMLElement,
  node: QuoteNode,
): QuoteNode[] {
  $setFormatFromDOM(node, el);
  setNodeIndentFromDOM(el, node);
  $setDirectionFromDOM(node, el);
  return [
    node.splice(
      0,
      0,
      ctx.$importChildren(
        el,
        node.isShadowRoot() ? {schema: BlockSchema} : undefined,
      ),
    ),
  ];
}

const QuoteRule = defineImportRule({
  // With a node replacement of QuoteNode by QuoteContainerNode, the quote
  // made here is a container, and is filled with blocks.
  $import: (ctx, el) => $importQuote(ctx, el, $createQuoteNode()),
  match: sel.tag('blockquote'),
  name: '@lexical/rich-text/blockquote',
});

/**
 * Opt-in replacement for the default `<blockquote>` rule that imports the
 * quote as a shadow root {@link QuoteNode} (see `quoteShadowRootState`).
 * Block-level children such as `<p>` are preserved as blocks and runs of
 * inline content are wrapped in paragraphs (`BlockSchema`), so structured
 * blockquote HTML round-trips faithfully instead of being flattened to
 * inline content.
 *
 * Not part of {@link RichTextImportRules}; without it `<blockquote>`
 * import behavior is unchanged. To opt in, contribute it from somewhere
 * that outranks {@link RichTextImportRules} in the compiled rule list —
 * either directly to the editor builder:
 * ```ts
 * buildEditorFromExtensions(
 *   MyExtension,
 *   configExtension(DOMImportExtension, {rules: [ShadowRootQuoteRule]}),
 * )
 * ```
 * or from an extension that depends on {@link RichTextExtension}:
 * ```ts
 * defineExtension({
 *   dependencies: [
 *     RichTextExtension,
 *     configExtension(DOMImportExtension, {rules: [ShadowRootQuoteRule]}),
 *   ],
 *   name: '@app/quotes',
 * })
 * ```
 * Either way the contribution is merged after rich-text's and therefore
 * prepended in front of it, so this rule is reached first and shadows the
 * default `@lexical/rich-text/blockquote` rule.
 *
 * @experimental
 */
export const ShadowRootQuoteRule = defineImportRule({
  $import: (ctx, el) =>
    $importQuote(ctx, el, $createQuoteNode({shadowRoot: true})),
  match: sel.tag('blockquote'),
  name: '@lexical/rich-text/blockquote-shadow-root',
});

/**
 * Opt-in replacement for the default `<blockquote>` rule that imports the
 * quote as a {@link QuoteContainerNode}: block-level children such as `<p>`,
 * lists and nested `<blockquote>`s are kept as blocks, and runs of inline
 * content are wrapped in paragraphs (`BlockSchema`).
 *
 * Not part of {@link RichTextImportRules}. The editor must register
 * `QuoteContainerNode` (`QuoteContainerExtension`), and the rule must outrank
 * the default one, as described for {@link ShadowRootQuoteRule}:
 * ```ts
 * defineExtension({
 *   dependencies: [
 *     QuoteContainerExtension,
 *     configExtension(DOMImportExtension, {rules: [QuoteContainerRule]}),
 *   ],
 *   name: '@app/quotes',
 * })
 * ```
 * An editor that replaces `QuoteNode` with `QuoteContainerNode`
 * (`QuoteContainerReplacementExtension`) does not need it: there the default
 * rule builds a container already.
 *
 * @experimental
 */
export const QuoteContainerRule = defineImportRule({
  $import: (ctx, el) => $importQuote(ctx, el, $createQuoteContainerNode()),
  match: sel.tag('blockquote'),
  name: '@lexical/rich-text/blockquote-container',
});

/**
 * Google-Docs paragraph wrapper around a title span: drop the paragraph,
 * let the span rule below promote to a heading. The body deliberately
 * returns the children unwrapped (no schema, no own node) so the
 * descendant rules — including {@link GoogleDocsTitleSpanRule} — fire and
 * produce the heading at this level.
 */
const GoogleDocsTitleParagraphRule = defineImportRule({
  $import: (ctx, el, $next) => {
    const first = el.firstChild;
    if (first && isGoogleDocsTitleSpan(first)) {
      return ctx.$importChildren(el);
    }
    return $next();
  },
  match: sel.tag('p'),
  name: '@lexical/rich-text/google-docs-title-p',
});

const GoogleDocsTitleSpanRule = defineImportRule({
  $import: (ctx, el, $next) =>
    el.style.fontSize !== '26pt'
      ? $next()
      : [$createHeadingNode('h1').splice(0, 0, ctx.$importChildren(el))],
  match: sel.tag('span'),
  name: '@lexical/rich-text/google-docs-title-span',
});

/**
 * Import rules for {@link HeadingNode} and {@link QuoteNode}, including
 * the Google Docs title heuristic that the legacy `HeadingNode.importDOM`
 * declared. This whole array is contributed by {@link RichTextExtension},
 * which depends on `CoreImportExtension`, so it is prepended in front of
 * {@link CoreImportRules}: the Google-Docs `<p>` / `<span>` rules here are
 * reached before the generic `<p>` and `<span>` rules from core, and defer
 * to them via `$next()` when the Google-Docs heuristic doesn't match.
 *
 * Registered by {@link RichTextExtension} itself (together with
 * `CoreImportExtension`), so any editor that uses the rich-text
 * extension can import these tags through the `DOMImportExtension`
 * pipeline without further configuration.
 *
 * @experimental
 */
export const RichTextImportRules = [
  HeadingRule,
  QuoteRule,
  GoogleDocsTitleParagraphRule,
  GoogleDocsTitleSpanRule,
];
