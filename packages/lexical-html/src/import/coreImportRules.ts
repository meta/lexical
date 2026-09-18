/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  $createHorizontalRuleNode,
  HorizontalRuleNode,
} from '@lexical/extension';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $generateNodesFromRawText,
  $getEditor,
  $isTextNode,
  $setDirectionFromDOM,
  $setFormatFromDOM,
  type ElementFormatType,
  IS_BOLD,
  IS_CODE,
  IS_HIGHLIGHT,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_SUBSCRIPT,
  IS_SUPERSCRIPT,
  IS_UNDERLINE,
  isBlockDomNode,
  isDOMTextNode,
  isLastChildInBlockNode,
  isOnlyChildInBlockNode,
  type LexicalNode,
  setNodeIndentFromDOM,
  TEXT_TYPE_TO_FORMAT,
} from 'lexical';

import {contextValue} from '../ContextRecord';
import {defineImportRule} from './defineImportRule';
import {
  ImportTextFormat,
  ImportTextStyle,
  ImportWhitespaceConfig,
  type WhitespaceImportConfig,
} from './ImportContext';
import {$propagateTextAlignToBlockChildren, BlockSchema} from './schemas';
import {selBase} from './sel';

const sel = selBase;

const ALIGNMENT_VALUES: ReadonlySet<string> = new Set<ElementFormatType>([
  'center',
  'end',
  'justify',
  'left',
  'right',
  'start',
]);

/**
 * True if `value` is a non-empty {@link ElementFormatType} (matches one of
 * the supported `text-align` / legacy `align`-attribute values).
 *
 * @internal
 */
export function isAlignmentValue(value: string): value is ElementFormatType {
  return ALIGNMENT_VALUES.has(value);
}

/**
 * A pair of bitmasks describing which {@link TextFormatType} bits to set
 * and which to clear when descending into an element. The clear pass
 * matters for cases the legacy OR-merge mishandled, e.g. `<b
 * style="font-weight: normal">` clearing an inherited bold, or `<sub>` /
 * `<sup>` clearing each other.
 */
interface FormatOverride {
  readonly set: number;
  readonly clear: number;
}

/**
 * The small subset of inline-style properties that affect text formatting
 * during import. Modeled as a plain object so tag-implicit defaults and
 * the element's own inline `style` can be merged with `{...defaults,
 * ...override-if-set}` semantics rather than relying on CSSStyleDeclaration.
 */
interface FormatStyle {
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
  verticalAlign?: string;
  textTransform?: string;
}

/**
 * Default style implied by each inline format tag. `<b>`/`<strong>` set
 * font-weight, `<sub>` sets vertical-align, etc. Any of these can be
 * overridden by the element's own inline `style` (so `<b
 * style="font-weight: normal">` ends up with `fontWeight: 'normal'` in
 * the effective style).
 */
const TAG_DEFAULT_STYLE: Record<string, FormatStyle> = {
  B: {fontWeight: 'bold'},
  EM: {fontStyle: 'italic'},
  I: {fontStyle: 'italic'},
  S: {textDecoration: 'line-through'},
  STRONG: {fontWeight: 'bold'},
  SUB: {verticalAlign: 'sub'},
  SUP: {verticalAlign: 'super'},
  U: {textDecoration: 'underline'},
};

/**
 * Tags whose effect on TextFormat has no CSS analog (so the style-merge
 * path can't reach them). Applied as a pure "set" override.
 */
const TAG_ONLY_SET: Record<string, number> = {
  CODE: IS_CODE,
  MARK: IS_HIGHLIGHT,
};

function readElementFormatStyle(el: HTMLElement): FormatStyle {
  return {
    fontStyle: el.style.fontStyle,
    fontWeight: el.style.fontWeight,
    textDecoration: el.style.textDecoration,
    textTransform: el.style.textTransform,
    verticalAlign: el.style.verticalAlign,
  };
}

function mergeStyles(
  defaults: FormatStyle,
  override: FormatStyle,
): FormatStyle {
  return {
    fontStyle: override.fontStyle || defaults.fontStyle,
    fontWeight: override.fontWeight || defaults.fontWeight,
    textDecoration: override.textDecoration || defaults.textDecoration,
    textTransform: override.textTransform || defaults.textTransform,
    verticalAlign: override.verticalAlign || defaults.verticalAlign,
  };
}

/**
 * The CSS property names {@link styleFormatOverride} reads — these are
 * "owned" by {@link ImportTextFormat} (the bit mask). When the
 * {@link ImportTextStyle} record is materialized onto a TextNode's
 * inline style by {@link styleObjectToCSS}, these are skipped so the
 * bit-mask side is the single source of truth and the same property
 * doesn't end up in both places (where the inline-style version would
 * shadow the format's themed CSS).
 */
const FORMAT_BIT_STYLE_PROPS: ReadonlySet<string> = new Set([
  'font-weight',
  'font-style',
  'text-decoration',
  'text-transform',
  'vertical-align',
]);

/**
 * Translate a {@link FormatStyle} into a {@link FormatOverride}. Explicit
 * "non-decorating" values (`font-weight: normal`, `text-decoration: none`,
 * `vertical-align: baseline`) produce `clear` bits, so an inner element
 * can remove a format inherited from its ancestors.
 */
function styleFormatOverride(style: FormatStyle): FormatOverride {
  let set = 0;
  let clear = 0;

  const {fontWeight, fontStyle, textDecoration, textTransform, verticalAlign} =
    style;

  if (fontWeight === '700' || fontWeight === 'bold') {
    set |= IS_BOLD;
  } else if (fontWeight === 'normal' || fontWeight === '400') {
    clear |= IS_BOLD;
  }

  if (fontStyle === 'italic') {
    set |= IS_ITALIC;
  } else if (fontStyle === 'normal') {
    clear |= IS_ITALIC;
  }

  if (textDecoration) {
    const parts = textDecoration.split(' ');
    if (parts.includes('underline')) {
      set |= IS_UNDERLINE;
    }
    if (parts.includes('line-through')) {
      set |= IS_STRIKETHROUGH;
    }
    if (parts.includes('none')) {
      clear |= IS_UNDERLINE | IS_STRIKETHROUGH;
    }
  }

  // TextNode.exportDOM writes exactly one of these three for the
  // capitalization formats, and they are mutually exclusive (#8915).
  if (textTransform === 'lowercase') {
    set |= TEXT_TYPE_TO_FORMAT.lowercase;
    clear |= TEXT_TYPE_TO_FORMAT.uppercase | TEXT_TYPE_TO_FORMAT.capitalize;
  } else if (textTransform === 'uppercase') {
    set |= TEXT_TYPE_TO_FORMAT.uppercase;
    clear |= TEXT_TYPE_TO_FORMAT.lowercase | TEXT_TYPE_TO_FORMAT.capitalize;
  } else if (textTransform === 'capitalize') {
    set |= TEXT_TYPE_TO_FORMAT.capitalize;
    clear |= TEXT_TYPE_TO_FORMAT.lowercase | TEXT_TYPE_TO_FORMAT.uppercase;
  } else if (textTransform === 'none') {
    clear |=
      TEXT_TYPE_TO_FORMAT.lowercase |
      TEXT_TYPE_TO_FORMAT.uppercase |
      TEXT_TYPE_TO_FORMAT.capitalize;
  }

  if (verticalAlign === 'sub') {
    set |= IS_SUBSCRIPT;
    clear |= IS_SUPERSCRIPT;
  } else if (verticalAlign === 'super') {
    set |= IS_SUPERSCRIPT;
    clear |= IS_SUBSCRIPT;
  } else if (verticalAlign === 'baseline') {
    clear |= IS_SUBSCRIPT | IS_SUPERSCRIPT;
  }

  return {clear, set};
}

function applyFormatOverride(format: number, ov: FormatOverride): number {
  return (format & ~ov.clear) | ov.set;
}

/**
 * Unified rule for inline-format-bearing tags and `<span>`. The element's
 * effective style is its tag's {@link TAG_DEFAULT_STYLE} merged with its
 * inline `style` (element's own style wins for any property it sets), and
 * the resulting style is translated into a {@link FormatOverride}. Tags
 * with no CSS analog (`<code>`, `<mark>`) contribute their bit as a pure
 * `set` override.
 *
 * This shape lets:
 * - `<b style="font-weight: normal">` clear an inherited IS_BOLD.
 * - `<sub><sup>x</sup></sub>` resolve to IS_SUPERSCRIPT only (sub/sup
 *   mutex via the vertical-align clear logic).
 * - `<span style="text-decoration: none">` strip inherited underline /
 *   line-through.
 */
const InlineFormatRule = defineImportRule({
  $import: (ctx, el) => {
    const inherited = ctx.get(ImportTextFormat);
    const tagDefault = TAG_DEFAULT_STYLE[el.nodeName];
    const elStyle = readElementFormatStyle(el);
    const effective = tagDefault ? mergeStyles(tagDefault, elStyle) : elStyle;
    let merged = applyFormatOverride(inherited, styleFormatOverride(effective));
    const tagOnly = TAG_ONLY_SET[el.nodeName];
    if (tagOnly) {
      merged |= tagOnly;
    }
    if (merged === inherited) {
      return ctx.$importChildren(el);
    }
    return ctx.$importChildren(el, {
      context: [contextValue(ImportTextFormat, merged)],
    });
  },
  match: sel.tag(
    'b',
    'strong',
    'em',
    'i',
    'code',
    'mark',
    's',
    'sub',
    'sup',
    'u',
    'span',
  ),
  name: '@lexical/html/inline-format',
});

/**
 * Walk up the DOM ancestor chain to determine whether `node` is inside an
 * element whose whitespace should be preserved, per the supplied
 * {@link WhitespaceImportConfig.preservesWhitespace} predicate. Pure
 * ancestor walk, no caching.
 */
function isInsidePreserveWhitespace(
  node: Node,
  wsConfig: WhitespaceImportConfig,
): boolean {
  let current: Node | null = node.parentNode;
  while (current !== null) {
    if (wsConfig.preservesWhitespace(current)) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

function findAdjacentTextOnLine(
  text: Text,
  forward: boolean,
  wsConfig: WhitespaceImportConfig,
): Text | null {
  let node: Node = text;
  while (true) {
    let sibling: Node | null = null;
    while (
      (sibling = forward ? node.nextSibling : node.previousSibling) === null
    ) {
      const parent: Node | null = node.parentNode;
      if (parent === null) {
        return null;
      }
      node = parent;
    }
    node = sibling;
    if (!wsConfig.isInline(node)) {
      return null;
    }
    let descendant: Node | null = node;
    while ((descendant = forward ? node.firstChild : node.lastChild) !== null) {
      node = descendant;
    }
    if (isDOMTextNode(node)) {
      return node;
    }
    if (node.nodeName === 'BR') {
      return null;
    }
  }
}

function collapseWhitespace(
  textNode: Text,
  wsConfig: WhitespaceImportConfig,
): string {
  let textContent = (textNode.textContent || '')
    .replace(/\r/g, '')
    .replace(/[ \t\n]+/g, ' ');
  if (textContent.length === 0) {
    return '';
  }
  if (textContent[0] === ' ') {
    let neighbor: Text | null = textNode;
    let isStartOfLine = true;
    while (
      neighbor !== null &&
      (neighbor = findAdjacentTextOnLine(neighbor, false, wsConfig)) !== null
    ) {
      const neighborContent = neighbor.textContent || '';
      if (neighborContent.length > 0) {
        if (/[ \t\n]$/.test(neighborContent)) {
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
  if (textContent.length > 0 && textContent[textContent.length - 1] === ' ') {
    let neighbor: Text | null = textNode;
    let isEndOfLine = true;
    while (
      neighbor !== null &&
      (neighbor = findAdjacentTextOnLine(neighbor, true, wsConfig)) !== null
    ) {
      const neighborContent = (neighbor.textContent || '').replace(
        /^( |\t|\r?\n)+/,
        '',
      );
      if (neighborContent.length > 0) {
        isEndOfLine = false;
        break;
      }
    }
    if (isEndOfLine) {
      textContent = textContent.slice(0, -1);
    }
  }
  return textContent;
}

function $applyFormat(node: LexicalNode, format: number): LexicalNode {
  return format !== 0 && $isTextNode(node) ? node.setFormat(format) : node;
}

/**
 * Inverse of {@link getStyleObjectFromCSS}: serialize a parsed style
 * record back into a CSS declaration string suitable for
 * `TextNode.setStyle`. Returns the empty string for an empty record.
 */
function styleObjectToCSS(style: Readonly<Record<string, string>>): string {
  let css = '';
  for (const prop in style) {
    if (FORMAT_BIT_STYLE_PROPS.has(prop)) {
      // Owned by ImportTextFormat (bit mask) — skip so the format-bit
      // CSS is the single source of truth on the rendered TextNode.
      continue;
    }
    css += `${prop}: ${style[prop]}; `;
  }
  return css.trimEnd();
}

function $applyTextStyle(
  node: LexicalNode,
  style: Readonly<Record<string, string>>,
): LexicalNode {
  if ($isTextNode(node)) {
    const css = styleObjectToCSS(style);
    if (css !== '') {
      node.setStyle(css);
    }
  }
  return node;
}

/**
 * `#text` rule. Inside a `<pre>` ancestor, preserve whitespace and split
 * on `\n` and `\t` into `LineBreakNode`/`TabNode` siblings. Otherwise
 * collapse whitespace using the same neighbor-aware rules as the legacy
 * `$convertTextDOMNode`.
 */
const TextRule = defineImportRule({
  $import: (ctx, el) => {
    const format = ctx.get(ImportTextFormat);
    const style = ctx.get(ImportTextStyle);
    const wsConfig = ctx.get(ImportWhitespaceConfig);
    if (isInsidePreserveWhitespace(el, wsConfig)) {
      const out = $generateNodesFromRawText(el.textContent || '');
      for (const node of out) {
        $applyFormat(node, format);
        $applyTextStyle(node, style);
      }
      return out;
    }
    const collapsed = collapseWhitespace(el, wsConfig);
    if (collapsed === '') {
      return [];
    }
    const text = $createTextNode(collapsed);
    $applyFormat(text, format);
    $applyTextStyle(text, style);
    return [text];
  },
  match: sel.text(),
  name: '@lexical/html/#text',
});

/**
 * Drop `<style>` and `<script>` and skip descending into them — matches
 * the legacy `IGNORE_TAGS` set, but as a regular rule so apps can register
 * a higher-priority `<style>` rule to capture stylesheet text into the
 * import session for later use.
 */
const IgnoreScriptStyleRule = defineImportRule({
  $import: () => [],
  match: sel.tag('script', 'style'),
  name: '@lexical/html/script-style-ignore',
});

const LineBreakRule = defineImportRule({
  // Mirror the legacy LineBreakNode.importDOM filter: stray `<br>` that
  // are the sole or trailing child of a block parent (e.g. Apple's
  // `<br class="Apple-interchange-newline">` clipboard sentinel, or the
  // trailing `<br>` browsers insert after the last text in a `<div>`)
  // would otherwise survive as a LineBreakNode and tack an extra blank
  // line onto the imported content.
  $import: (_ctx, el) =>
    isOnlyChildInBlockNode(el) || isLastChildInBlockNode(el)
      ? []
      : [$createLineBreakNode()],
  match: sel.tag('br'),
  name: '@lexical/html/br',
});

/**
 * `<p>` rule. Re-applies format, indent, direction, and the legacy
 * `align` attribute fallback.
 */
const ParagraphRule = defineImportRule({
  $import: (ctx, el) => {
    const p = $createParagraphNode();
    $setFormatFromDOM(p, el);
    setNodeIndentFromDOM(el, p);
    if (p.getFormatType() === '') {
      const align = el.getAttribute('align');
      if (align && isAlignmentValue(align)) {
        p.setFormat(align);
      }
    }
    $setDirectionFromDOM(p, el);
    // We deliberately pass no schema: paragraphs accept any inline run as-is.
    // The enclosing context (root / block) is responsible for ensuring the
    // paragraph itself is a valid block child.
    return [p.splice(0, 0, ctx.$importChildren(el))];
  },
  match: sel.tag('p'),
  name: '@lexical/html/p',
});

/**
 * `<hr>` rule, gated on {@link HorizontalRuleNode} registration so it
 * mirrors the legacy `importDOM` contract (a node's conversions are only
 * active when the node itself is registered). It lives here rather than
 * next to `HorizontalRuleExtension` because `@lexical/extension`
 * is upstream of `@lexical/html` in the package graph and cannot define
 * import rules — this is the one node-providing extension whose import
 * support cannot be implied by depending on it.
 *
 * Registered ahead of {@link TransparentBlockRule}: `<hr>` matches
 * `isBlockDomNode`, so the wildcard block rule would otherwise consume
 * it. When `HorizontalRuleNode` is not registered, `$next()` restores
 * the old behavior (the childless element vanishes).
 *
 * @internal
 */
export const HorizontalRuleRule = defineImportRule({
  $import: (_ctx, _el, $next) =>
    $getEditor().hasNode(HorizontalRuleNode)
      ? [$createHorizontalRuleNode()]
      : $next(),
  match: sel.tag('hr'),
  name: '@lexical/html/hr',
});

/**
 * Transparent block-container rule for any unconverted block-level DOM
 * element — `<div>`, but also `<section>`, `<article>`, `<header>`,
 * `<figure>`, … (everything {@link isBlockDomNode} recognizes via the
 * legacy `BLOCK_TAG_RE`). Without it these would fall through to the
 * dispatcher's `$hoistChildrenOf` / `DefaultHoistRule` fallback, which
 * transparently lifts children up to the enclosing context. That works
 * structurally, but (a) two sibling `<section>`s collapse into a single
 * paragraph instead of two, and (b) any `text-align` set on the element
 * is lost because the synthesized paragraph (built by the enclosing
 * schema) sees the *grandparent* as `domParent`.
 *
 * The rule is registered as a `sel.any()` wildcard and defers (via
 * `$next()`) for non-block elements so inline tags still reach the inline
 * rules. Higher-priority tag rules (`<p>`, `<li>`, `<td>`, headings, …)
 * are dispatched first and never reach here.
 *
 * The element's children run through {@link BlockSchema} so each inline
 * run becomes its own `ParagraphNode` (with the element's `text-align`
 * picked up via {@link $paragraphPackageRun}'s `domParent`), and any
 * pre-existing block children get the same alignment applied via
 * {@link $propagateTextAlignToBlockChildren}. The resulting block-level
 * nodes are what the enclosing context sees — at the root a sibling
 * paragraph is the natural shape; inside a block lexical container the
 * container rule (e.g. {@link ListItemRule}) collapses paragraph
 * children back into inline-with-line-break form. That way both `<p>`
 * and transparent blocks (`<div>`, `<section>`, …) project to the same
 * `ParagraphNode` intermediate, and there is no need for a marker node
 * to distinguish them.
 */
const TransparentBlockRule = defineImportRule({
  $import: (ctx, el, $next) => {
    if (!isBlockDomNode(el)) {
      // Inline element with no dedicated rule — let the inline rules (or
      // the default hoist) handle it.
      return $next();
    }
    return $propagateTextAlignToBlockChildren(
      ctx.$importChildren(el, {schema: BlockSchema}),
      el,
    );
  },
  match: sel.any(),
  name: '@lexical/html/transparent-block',
});

/**
 * Rules covering the {@link ParagraphNode}, {@link TextNode},
 * {@link LineBreakNode}, and {@link TabNode} cases that the legacy
 * `importDOM` machinery in `@lexical/lexical` handled, plus the
 * registration-gated `<hr>` rule for {@link HorizontalRuleNode} (see
 * {@link HorizontalRuleRule}). Intended to be registered as a dependency
 * of every editor that uses {@link DOMImportExtension}.
 *
 * @experimental
 */
export const CoreImportRules = [
  IgnoreScriptStyleRule,
  ParagraphRule,
  HorizontalRuleRule,
  TransparentBlockRule,
  TextRule,
  LineBreakRule,
  InlineFormatRule,
];
