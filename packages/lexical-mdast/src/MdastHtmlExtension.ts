/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {MdastExportHandler, MdastImportHandler} from './types';
import type {
  BlockContent,
  HtmlBlock,
  HtmlInline,
  Nodes,
  Parent,
  PhrasingContent,
  Root,
  RootContent,
} from 'mdast';
import type {
  Handle,
  Options as ToMarkdownExtension,
} from 'mdast-util-to-markdown';

import {$getExtensionOutput} from '@lexical/extension';
import {
  $generateNodesFromDOMViaExtension,
  $getSessionDOMRenderConfig,
  $withRenderContext,
  contextValue,
  CoreImportExtension,
  createImportState,
  createRenderState,
  defineImportRule,
  DOMImportExtension,
  ImportTextFormat,
  ImportTextStyle,
  RenderContextExport,
  sel,
} from '@lexical/html';
import {getCSSFromStyleObject} from '@lexical/selection';
import {
  $getDocument,
  $getEditor,
  $getSlot,
  $isDecoratorNode,
  $isElementNode,
  $isTextNode,
  configExtension,
  defineExtension,
  type ElementNode,
  isDocumentFragment,
  isHTMLElement,
  type LexicalNode,
} from 'lexical';
import {fromMarkdown} from 'mdast-util-from-markdown';

import {MdastImportExtension} from './MdastImportExtension';

// The mdast nodes raw HTML is normalized into — one for a block-level tag
// sequence, one for an inline (phrasing) tag run. Declared through interface
// merging — mdast's sanctioned extension point — so both participate in the
// `Nodes` / content unions.
declare module 'mdast' {
  interface HtmlBlock extends Parent {
    type: 'htmlBlock';
    /**
     * The reassembled raw HTML, with a `data-mdast-child="i"` placeholder
     * element standing in for each embedded Markdown segment
     * (`children[i]`).
     */
    value: string;
    children: BlockContent[];
  }
  interface HtmlInline extends Parent {
    type: 'htmlInline';
    /**
     * The reassembled raw tag run, with a `data-mdast-child="i"`
     * placeholder element standing in for each interleaved phrasing child
     * (`children[i]`).
     */
    value: string;
    children: PhrasingContent[];
  }
  interface BlockContentMap {
    htmlBlock: HtmlBlock;
  }
  interface PhrasingContentMap {
    htmlInline: HtmlInline;
  }
  interface RootContentMap {
    htmlBlock: HtmlBlock;
    htmlInline: HtmlInline;
  }
}

/* -------------------------------------------------------------------------- *
 * mdast tree transform: raw html block sequences -> `htmlBlock` nodes        *
 * -------------------------------------------------------------------------- */

// CommonMark parses raw HTML blocks by blank lines, not by tag structure, so
// a wrapper element with Markdown content inside (the GitHub `<details>`
// idiom) arrives as a *sequence* of mdast nodes:
//
//   html('<details><summary>…</summary>')   <- runs until the blank line
//   paragraph(…)                             <- ordinary markdown blocks
//   html('</details>')                       <- interrupts the paragraph
//
// This from-markdown transform reassembles each sequence into a single
// `htmlBlock` node by counting tag balance across the raw fragments,
// keeping the interleaved Markdown blocks as children referenced by
// placeholder elements in the HTML string.

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const COMMENT_RE = /<!--[\s\S]*?-->/g;
// A tag token: closing slash, name, attributes (quote-aware so a `>` inside
// a quoted attribute value doesn't end the tag), self-closing slash.
const TAG_RE =
  /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^"'>]|"[^"]*"|'[^']*')*?)(\/?)>/g;

/** Net element nesting change across one raw html value. */
function tagBalanceDelta(value: string): number {
  let delta = 0;
  for (const match of value.replace(COMMENT_RE, '').matchAll(TAG_RE)) {
    const [, closing, rawName, , selfClosing] = match;
    if (VOID_TAGS.has(rawName.toLowerCase())) {
      continue;
    }
    if (closing) {
      delta -= 1;
    } else if (!selfClosing) {
      delta += 1;
    }
  }
  return delta;
}

/**
 * Whether an html node's value is worth handing to the DOM importer: it
 * contains at least one complete tag, or is nothing but comments (which
 * import to nothing, like GitHub renders them). CommonMark opens an html
 * *block* for a bare unclosed tag prefix — a mid-typing `<p` or `<details`
 * is already an html node — but such a value has no structure for the DOM
 * rules to work with, and treating its text as an embedded-Markdown segment
 * would re-parse it into the same html node forever. It stays literal text
 * instead.
 */
function isImportableHtml(value: string): boolean {
  const stripped = value.replace(COMMENT_RE, '');
  return !stripped.matchAll(TAG_RE).next().done || stripped.trim() === '';
}

/**
 * Attempts to reassemble an `htmlBlock` from the html node at
 * `parent.children[index]`, consuming siblings until the tag balance closes.
 * Returns the spliced-in node, or null (leaving the tree untouched) when the
 * opening fragment's elements are never closed — that content keeps the
 * default literal-text import.
 */
function tryBuildHtmlBlock(parent: Parent, index: number): HtmlBlock | null {
  const opener = parent.children[index];
  if (opener.type !== 'html' || !isImportableHtml(opener.value)) {
    return null;
  }
  let value = opener.value;
  const children: RootContent[] = [];
  let deleteCount = 1;
  let balance = tagBalanceDelta(opener.value);
  if (balance > 0) {
    let pending: RootContent[] = [];
    let closed = false;
    for (let j = index + 1; j < parent.children.length; j++) {
      const sibling = parent.children[j];
      if (sibling.type === 'html') {
        // Splice the Markdown blocks since the previous fragment in as
        // placeholders, then continue the raw stream.
        for (const child of pending) {
          value += `<template data-mdast-child="${children.length}"></template>`;
          children.push(child);
        }
        pending = [];
        value += '\n' + sibling.value;
        balance += tagBalanceDelta(sibling.value);
        if (balance <= 0) {
          closed = true;
          deleteCount = j - index + 1;
          break;
        }
      } else {
        pending.push(sibling);
      }
    }
    if (!closed) {
      return null;
    }
  }
  const htmlBlock: HtmlBlock = {
    children: children as BlockContent[],
    type: 'htmlBlock',
    value,
  };
  parent.children.splice(index, deleteCount, htmlBlock);
  return htmlBlock;
}

/**
 * The inline counterpart of {@link tryBuildHtmlBlock}: reassembles a run of
 * phrasing html tokens (`html('<u>')`, `text('x')`, `html('</u>')` inside a
 * paragraph) into one `htmlInline` node. Unlike the block case there is no
 * embedded raw text to re-parse — micromark already parsed the content
 * between the tags as Markdown phrasing — so the interleaved children ride
 * as inline placeholders directly.
 */
function tryBuildHtmlInline(parent: Parent, index: number): HtmlInline | null {
  const opener = parent.children[index];
  if (opener.type !== 'html' || !isImportableHtml(opener.value)) {
    return null;
  }
  let value = opener.value;
  const children: PhrasingContent[] = [];
  let deleteCount = 1;
  let balance = tagBalanceDelta(opener.value);
  if (balance > 0) {
    let pending: RootContent[] = [];
    let closed = false;
    for (let j = index + 1; j < parent.children.length; j++) {
      const sibling = parent.children[j];
      if (sibling.type === 'html') {
        for (const child of pending) {
          // Inline placeholders are non-empty inline elements so the
          // whitespace collapser treats them like the text they stand for.
          value += `<span data-mdast-child="${children.length}">&#8203;</span>`;
          children.push(child as PhrasingContent);
        }
        pending = [];
        value += sibling.value;
        balance += tagBalanceDelta(sibling.value);
        if (balance <= 0) {
          closed = true;
          deleteCount = j - index + 1;
          break;
        }
      } else {
        pending.push(sibling);
      }
    }
    if (!closed) {
      // An unclosed inline tag (`a <u>oops`) keeps the literal-text import.
      return null;
    }
  }
  const htmlInline: HtmlInline = {
    children,
    type: 'htmlInline',
    value,
  };
  parent.children.splice(index, deleteCount, htmlInline);
  return htmlInline;
}

// The parents whose children are *flow* content, where an html node is a
// block-level tag sequence. Everywhere else (a paragraph, a heading, a
// table cell, emphasis, …) an html node is an inline tag token and gets the
// inline reassembly instead.
const FLOW_PARENTS = new Set([
  'blockquote',
  'footnoteDefinition',
  'htmlBlock',
  'listItem',
  'root',
]);

function transformRawHtml(parent: Parent): void {
  const children = parent.children;
  const flow = FLOW_PARENTS.has(parent.type);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'html') {
      const built = flow
        ? tryBuildHtmlBlock(parent, i)
        : tryBuildHtmlInline(parent, i);
      if (built !== null) {
        // The interleaved children may hold raw HTML of their own (e.g. a
        // blockquote middle wrapping tags, emphasis around an inline run).
        transformRawHtml(built);
        continue;
      }
    }
    if ('children' in child) {
      transformRawHtml(child);
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Markdown text inside the raw HTML                                          *
 * -------------------------------------------------------------------------- */

// GitHub's `<details>` idiom embeds Markdown *text* directly between the raw
// tags — most visibly the `<summary>` line — and expects it to render:
//
//   <details><summary>
//   This is the *summary* that shows when collapsed
//   </summary>
//
// So text segments between tags are parsed as Markdown too (with the same
// grammar the registry compiled for the document) and spliced in through the
// same placeholder mechanism as the interleaved blocks. Two exceptions keep
// HTML semantics intact: raw-content elements (`<pre>`, `<code>`, `<script>`,
// …) never hold Markdown, and text directly inside an *inline* element
// (`<strong>raw</strong>`) stays raw DOM text so the DOM rules' formatting
// context applies to it.

const RAW_TEXT_TAGS = new Set([
  'code',
  'pre',
  'script',
  'style',
  'textarea',
  'title',
]);

const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
]);

/**
 * Rewrites the Markdown-eligible text segments of `value` via `replace`,
 * leaving the tags (and raw/inline-element text) untouched. Comments are
 * dropped, matching how GitHub renders them. Leading/trailing whitespace of
 * each segment stays in place so spacing against adjacent inline tags
 * survives the round trip through a placeholder.
 */
function replaceMarkdownTextSegments(
  value: string,
  replace: (markdown: string) => string,
): string {
  const source = value.replace(COMMENT_RE, '');
  const stack: string[] = [];
  let out = '';
  let lastIndex = 0;
  const emitText = (text: string) => {
    const rawContext =
      stack.some(name => RAW_TEXT_TAGS.has(name)) ||
      (stack.length > 0 && INLINE_TAGS.has(stack[stack.length - 1]));
    if (rawContext || text.trim() === '') {
      out += text;
      return;
    }
    const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(
      text,
    ) as RegExpExecArray;
    out += lead + replace(body) + trail;
  };
  for (const match of source.matchAll(TAG_RE)) {
    emitText(source.slice(lastIndex, match.index));
    out += match[0];
    lastIndex = match.index + match[0].length;
    const [, closing, rawName, , selfClosing] = match;
    const name = rawName.toLowerCase();
    if (VOID_TAGS.has(name) || selfClosing) {
      continue;
    }
    if (closing) {
      // Tolerate mismatched markup: close back to the nearest matching open.
      const openIndex = stack.lastIndexOf(name);
      if (openIndex !== -1) {
        stack.length = openIndex;
      }
    } else {
      stack.push(name);
    }
  }
  emitText(source.slice(lastIndex));
  return out;
}

// Positions on the re-parsed segments would point into the wrong source, so
// they are stripped — the importer skips source-based syntax recovery for
// position-less nodes and uses its defaults.
function stripPositions<T extends Nodes>(node: T): T {
  delete node.position;
  if ('children' in node) {
    for (const child of node.children) {
      stripPositions(child);
    }
  }
  return node;
}

/* -------------------------------------------------------------------------- *
 * Import: `htmlBlock`/`htmlInline` -> DOMParser -> the DOM import rules      *
 * -------------------------------------------------------------------------- */

/**
 * Render context state that is true while {@link $exportViaDOM} renders a
 * node's `exportDOM` shell for Markdown serialization — the Markdown analog
 * of `RenderContextExport` from `@lexical/html` (which is set as well).
 * `exportDOM` implementations read it with `$getRenderContextValue` to
 * diverge, e.g. to leave a `data-lexical-slot` wrapper empty rather than
 * serializing slot HTML that the Markdown embedding replaces anyway.
 * @experimental
 */
export const RenderContextMarkdownExport = createRenderState(
  'isMarkdownExport',
  Boolean,
);

// Carries the pre-imported Markdown children of the raw HTML being imported
// into the DOM walk, so the placeholder rule can splice them back in
// wherever the HTML structure put their placeholder stand-ins.
const htmlChildBatches = createImportState<readonly (readonly LexicalNode[])[]>(
  'mdastHtmlChildBatches',
  () => [],
);

// Style properties owned by the ImportTextFormat bit mask (mirrors the core
// `#text` rule) — excluded when materializing an inherited style record so
// the format bits stay the single source of truth.
const FORMAT_BIT_STYLE_PROPS: ReadonlySet<string> = new Set([
  'font-weight',
  'font-style',
  'text-decoration',
  'vertical-align',
]);

// A placeholder's content was imported through the *mdast* pipeline before
// the DOM walk reached its position, so the formatting context accumulated
// from enclosing inline elements (`<strong>`, `<span style="color: red">`)
// never touched it. Apply that context here, the way the core `#text` rule
// would have applied it to raw text.
function $applyImportContext(
  node: LexicalNode,
  format: number,
  css: string,
): void {
  if ($isTextNode(node)) {
    if (format !== 0) {
      node.setFormat(node.getFormat() | format);
    }
    if (css !== '') {
      const own = node.getStyle();
      // The node's own style wins: later declarations override earlier ones
      // (the inherited css carries its trailing semicolon).
      node.setStyle(own === '' ? css : css + own);
    }
  } else if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      $applyImportContext(child, format, css);
    }
  }
}

const HtmlChildPlaceholderRule = defineImportRule({
  $import: (ctx, el) => {
    const batch =
      ctx.get(htmlChildBatches)[Number(el.getAttribute('data-mdast-child'))];
    if (!batch) {
      return [];
    }
    const format = ctx.get(ImportTextFormat);
    const style = ctx.get(ImportTextStyle);
    const inherited: Record<string, string> = {};
    for (const prop in style) {
      if (!FORMAT_BIT_STYLE_PROPS.has(prop)) {
        inherited[prop] = style[prop];
      }
    }
    const css = getCSSFromStyleObject(inherited);
    if (format !== 0 || css !== '') {
      for (const node of batch) {
        $applyImportContext(node, format, css);
      }
    }
    return [...batch];
  },
  match: sel.tag('template', 'span').attr('data-mdast-child', true),
  name: '@lexical/mdast/html-child-placeholder',
});

// The transform's identity, so the segment re-parse below can exclude it:
// a text segment contains no complete tag by construction, so the transform
// could never fire usefully there — and excluding it makes the reassembly
// structurally non-reentrant (an html node in a segment parse stays `html`
// and imports as literal text, rather than looping back through this file).
const rawHtmlFromMarkdown = {
  transforms: [
    (tree: Root) => {
      transformRawHtml(tree);
    },
  ],
};

const $importHtmlBlock: MdastImportHandler<HtmlBlock> = (node, ctx) => {
  // The interleaved Markdown blocks import through the mdast pipeline (so
  // Markdown constructs inside a wrapper element keep full fidelity)...
  const batches = node.children.map(child => ctx.importNode(child));
  // ...and so does the Markdown text embedded between the raw tags, parsed
  // with the registry's own grammar so it supports exactly the constructs
  // the document does.
  const {registry} = $getExtensionOutput(MdastImportExtension);
  const segmentMdastExtensions = registry.mdastExtensions.filter(
    extension => extension !== rawHtmlFromMarkdown,
  );
  const value = replaceMarkdownTextSegments(node.value, markdown => {
    const parsed = stripPositions(
      fromMarkdown(markdown, {
        extensions: registry.micromarkExtensions,
        mdastExtensions: segmentMdastExtensions,
      }),
    );
    const index = batches.length;
    const first = parsed.children[0];
    // A segment that is a single paragraph imports as *inline* content so it
    // reassembles with its neighbors (`x <strong>z</strong> w` stays one
    // line); the block wrapping, if any, belongs to the surrounding HTML
    // context. Anything else (a heading, a list, …) imports as blocks.
    batches.push(
      parsed.children.length === 1 && first.type === 'paragraph'
        ? ctx.importChildren(first)
        : parsed.children.flatMap(child => ctx.importNode(child)),
    );
    // Text segments get an *inline, non-empty* placeholder (the zero-width
    // space is never imported — the placeholder rule doesn't descend) so the
    // whitespace collapser treats it like the text it stands for and spacing
    // against adjacent inline tags survives (`*a* <strong>b</strong>`). The
    // block placeholders from the transform stay empty `<template>`s so the
    // formatting newlines around them collapse away instead.
    return `<span data-mdast-child="${index}">&#8203;</span>`;
  });
  // The raw HTML itself imports through the DOM rule registry. The session
  // inherits the surrounding import context, so ImportContextMarkdown (set
  // by the mdast walk) and anything a handler layered stay readable.
  const dom = new DOMParser().parseFromString(value, 'text/html');
  return $generateNodesFromDOMViaExtension(dom, {
    context: [contextValue(htmlChildBatches, batches)],
  });
};

// An inline run must produce inline nodes; block output from a DOM rule
// (e.g. a misused block tag mid-paragraph) contributes its children instead
// so the surrounding paragraph stays valid.
function $flattenToInline(nodes: LexicalNode[]): LexicalNode[] {
  const out: LexicalNode[] = [];
  for (const node of nodes) {
    if ($isElementNode(node) && !node.isInline()) {
      out.push(...$flattenToInline(node.getChildren()));
    } else {
      out.push(node);
    }
  }
  return out;
}

// Per-call holder the synthetic inline-root rule hands its children back
// through. A top-level rule's output would otherwise be normalized by the
// root schema — which wraps stray inline runs in paragraphs and drops
// boundary line breaks, correct for a document but wrong for a fragment
// that re-enters the middle of a paragraph.
const htmlInlineResult = createImportState<{
  nodes: LexicalNode[] | null;
}>('mdastHtmlInlineResult', () => ({nodes: null}));

const HtmlInlineRootRule = defineImportRule({
  $import: (ctx, el) => {
    // No schema: the children come back exactly as the rules produced them.
    ctx.get(htmlInlineResult).nodes = ctx.$importChildren(el);
    return [];
  },
  match: sel.tag('span').attr('data-mdast-inline-root', true),
  name: '@lexical/mdast/html-inline-root',
});

const $importHtmlInline: MdastImportHandler<HtmlInline> = (node, ctx) => {
  // The interleaved children are already-parsed Markdown phrasing (micromark
  // keeps parsing between inline tags), so unlike the block case there is no
  // embedded raw text to re-parse — pre-import them and let the placeholder
  // rule splice them back in with the surrounding formatting context.
  const batches = node.children.map(child => ctx.importNode(child));
  const holder: {nodes: LexicalNode[] | null} = {nodes: null};
  const dom = new DOMParser().parseFromString(
    `<span data-mdast-inline-root="true">${node.value}</span>`,
    'text/html',
  );
  $generateNodesFromDOMViaExtension(dom, {
    context: [
      contextValue(htmlChildBatches, batches),
      contextValue(htmlInlineResult, holder),
    ],
  });
  return holder.nodes === null ? [] : $flattenToInline(holder.nodes);
};

/* -------------------------------------------------------------------------- *
 * Export: raw block tags around embedded Markdown                            *
 * -------------------------------------------------------------------------- */

/**
 * One piece of a {@link rawHtmlBlock}:
 *
 * - a `string` is raw HTML, emitted verbatim,
 * - a `PhrasingContent[]` is Markdown phrasing embedded in the raw stream
 *   (a `<summary>` line),
 * - `{flow}` is a run of Markdown blocks, joined with blank lines.
 * @experimental
 */
export type RawHtmlBlockPart =
  | string
  | PhrasingContent[]
  | {flow: BlockContent[]};

/**
 * Builds an mdast node that serializes as raw HTML with Markdown embedded
 * between the tags — the export counterpart of this extension's import
 * side, so what it produces re-imports through the same rules. An export
 * handler for an HTML-encoded construct is just a template:
 *
 * ```ts
 * const $exportCollapsible: MdastExportHandler = (node, ctx) =>
 *   $isCollapsibleNode(node)
 *     ? rawHtmlBlock(
 *         '<details><summary>\n',
 *         ctx.exportInline($getSlot(node, 'summary')),
 *         '\n</summary>\n\n',
 *         {flow: ctx.exportChildren(node) as BlockContent[]},
 *         '\n</details>',
 *       )
 *     : null;
 * ```
 *
 * The embedded Markdown goes through the regular to-markdown machinery
 * (escaping, nested constructs); only the strings are emitted raw. Requires
 * {@link MdastHtmlExtension}, which registers the serializer.
 * @experimental
 */
export function rawHtmlBlock(...parts: RawHtmlBlockPart[]): HtmlBlock {
  let value = '';
  const children: BlockContent[] = [];
  const placeholder = () =>
    `<template data-mdast-child="${children.length}"></template>`;
  for (const part of parts) {
    if (typeof part === 'string') {
      value += part;
    } else if (Array.isArray(part)) {
      // Phrasing rides as a paragraph child; the serializer emits it as
      // bare phrasing (a paragraph's serialization) in place.
      value += placeholder();
      children.push({children: part, type: 'paragraph'});
    } else {
      let first = true;
      for (const block of part.flow) {
        if (!first) {
          value += '\n\n';
        }
        first = false;
        value += placeholder();
        children.push(block);
      }
    }
  }
  return {children, type: 'htmlBlock', value};
}

// Intermediate marker used by $exportViaDOM while the shell DOM is being
// assembled (distinct from the serialized `data-mdast-child` placeholders,
// which rawHtmlBlock assigns when the parts are put together).
const EXPORT_MARK_ATTR = 'data-mdast-part';
const EXPORT_MARK_SPLIT_RE = new RegExp(
  `<template ${EXPORT_MARK_ATTR}="(\\d+)"></template>`,
);

// CommonMark's html block condition 6 tag names. A tag with any other name
// (a custom element) only opens an html block via condition 7, which
// requires the tag to stand ALONE on its line — so the serialized shell
// must line-break around such tags to be re-importable.
const HTML_BLOCK_TAGS = new Set(
  (
    'address article aside base basefont blockquote body caption center col ' +
    'colgroup dd details dialog dir div dl dt fieldset figcaption figure ' +
    'footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html ' +
    'iframe legend li link main menu menuitem nav noframes ol optgroup ' +
    'option p param search section summary table tbody td tfoot th thead ' +
    'title tr track ul'
  ).split(' '),
);

// Breaks the line after a segment's leading tag when that tag is a custom
// element immediately followed by another tag: `<x-callout open><header>`
// would neither match condition 6 (unknown name) nor condition 7 (not
// alone on the line), so it re-parses as a paragraph instead of raw HTML.
function breakAfterLeadingCustomTag(segment: string): string {
  return segment.replace(
    /^(<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>)(?=<)/,
    (match, tag: string, name: string) =>
      HTML_BLOCK_TAGS.has(name.toLowerCase()) ? match : `${tag}\n`,
  );
}

// The closing counterpart: `</header></x-callout>` at the end of the shell
// leaves the custom close tag mid-line; give it its own line so the closer
// fragment re-parses.
function breakBeforeTrailingCustomTag(segment: string): string {
  return segment.replace(
    /(>)(<\/([a-zA-Z][a-zA-Z0-9-]*)>)$/,
    (match, prev: string, tag: string, name: string) =>
      HTML_BLOCK_TAGS.has(name.toLowerCase()) ? match : `${prev}\n${tag}`,
  );
}

// Whether a raw segment leads with a custom-element tag. Its fragment then
// re-parses via condition 7, which cannot interrupt a paragraph — so after
// flow content it must be set off by a blank line, where a known tag (a
// `</details>` closer) interrupts fine on the very next line.
function leadsWithCustomTag(segment: string): boolean {
  const match = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(segment);
  return match !== null && !HTML_BLOCK_TAGS.has(match[1].toLowerCase());
}

/**
 * A fully generic Markdown export for an HTML-encoded construct: renders the
 * node's own `exportDOM` shell through the editor's `@lexical/html` render
 * config, substitutes the node's children (at the shell's children position)
 * and its named slots (at their `data-lexical-slot` wrappers — the same
 * convention `exportDOM` implementations already use for HTML) with embedded
 * Markdown, and serializes via {@link rawHtmlBlock}. Register it directly:
 *
 * ```ts
 * configExtension(MdastImportExtension, {
 *   exportRules: [{$export: $exportViaDOM, type: 'collapsible'}],
 * })
 * ```
 *
 * `exportDOM` is then the single source of truth for the HTML encoding —
 * whatever slot content the shell serialized for the HTML clipboard is
 * replaced with Markdown here, and the `data-lexical-slot` markers are
 * removed. Children and shadow-root slot values embed as flow blocks
 * (blank-line separated); inline children and bare-block slot values embed
 * as phrasing on their own line, the GitHub `<summary>` idiom.
 * @experimental
 */
export const $exportViaDOM: MdastExportHandler = (node, ctx) => {
  const editor = $getEditor();
  const markKinds: ('flow' | 'phrasing')[] = [];
  const substitutions: (PhrasingContent[] | {flow: BlockContent[]})[] = [];
  const mark = (kind: 'flow' | 'phrasing'): HTMLTemplateElement => {
    const marker = $getDocument().createElement('template');
    marker.setAttribute(EXPORT_MARK_ATTR, String(markKinds.length));
    markKinds.push(kind);
    return marker;
  };
  // The shell renders under both export flags: this IS an export operation,
  // and RenderContextMarkdownExport lets exportDOM diverge for Markdown
  // (any context the caller layered on with $withRenderContext composes).
  const element = $withRenderContext(
    [
      contextValue(RenderContextExport, true),
      contextValue(RenderContextMarkdownExport, true),
    ],
    editor,
  )(() => {
    const output = $getSessionDOMRenderConfig(editor).$exportDOM(node, editor);
    let shell = output.element;
    if (!shell) {
      return null;
    }
    // The children channel renders where the exporter would have put it.
    const children = Array.from(
      output.$getChildNodes
        ? output.$getChildNodes()
        : $isElementNode(node)
          ? node.getChildren()
          : [],
    );
    if (children.length > 0) {
      const flow = children.some(
        child =>
          ($isElementNode(child) || $isDecoratorNode(child)) &&
          !child.isInline(),
      );
      const marker = mark(flow ? 'flow' : 'phrasing');
      // Serialize the resolved list, not node.getChildren(): a
      // $getChildNodes override replaces the children for export by
      // contract, so the Markdown embedding must follow it like the HTML
      // exporter does.
      substitutions.push(
        flow
          ? {flow: ctx.exportChildren(children) as BlockContent[]}
          : ctx.exportInline(children),
      );
      if (output.append) {
        output.append(marker);
      } else if (isHTMLElement(shell)) {
        shell.append(marker);
      }
    }
    if (output.after) {
      shell = output.after.call(node, shell) ?? shell;
    }
    return shell;
  });
  if (!element) {
    return null;
  }
  // Named slots render into their marked wrappers; whatever HTML the shell
  // serialized into them (for the HTML clipboard) is replaced with Markdown,
  // and the internal marker attribute does not leak into the document.
  // Document order + isConnected skips wrappers nested inside content that
  // an earlier substitution already cleared.
  if (isHTMLElement(element) || isDocumentFragment(element)) {
    for (const wrapper of Array.from(
      element.querySelectorAll(`[data-lexical-slot]`),
    )) {
      if (!element.contains(wrapper)) {
        continue;
      }
      const name = wrapper.getAttribute('data-lexical-slot');
      const slot = name === null ? null : $getSlot(node, name);
      if (slot === null) {
        continue;
      }
      wrapper.removeAttribute('data-lexical-slot');
      const flow = $isElementNode(slot) && slot.isShadowRoot();
      const marker = mark(flow ? 'flow' : 'phrasing');
      substitutions.push(
        flow
          ? {flow: ctx.exportChildren(slot) as BlockContent[]}
          : ctx.exportInline(slot as ElementNode),
      );
      wrapper.replaceChildren(marker);
    }
  }
  let html: string;
  if (isHTMLElement(element)) {
    html = element.outerHTML;
  } else {
    const container = $getDocument().createElement('div');
    container.append(element);
    html = container.innerHTML;
  }
  // Boolean-style attributes serialize as `open=""`; the bare form is
  // equivalent HTML and the idiomatic Markdown encoding.
  html = html.replace(/ ([a-zA-Z-]+)=""/g, ' $1');
  // Reassemble as a rawHtmlBlock template: raw segments verbatim, each
  // marker as its embedded Markdown — flow set off by a blank line, phrasing
  // on its own line (the GitHub `<summary>` idiom). Segment boundaries that
  // begin a new raw fragment on re-import (the opener, and everything after
  // a blank line) get custom-element tags broken onto their own lines so
  // CommonMark re-parses them as raw HTML.
  const segments = html.split(EXPORT_MARK_SPLIT_RE);
  const parts: RawHtmlBlockPart[] = [];
  let fragmentStart = true;
  let afterFlow = false;
  for (let i = 0; i < segments.length; i++) {
    if (i % 2 === 0) {
      let segment = segments[i];
      if (fragmentStart) {
        segment = breakAfterLeadingCustomTag(segment);
      }
      if (i === segments.length - 1) {
        segment = breakBeforeTrailingCustomTag(segment);
      }
      if (afterFlow) {
        // Close the flow run: a custom-tag fragment needs a blank line
        // (condition 7 can't interrupt the paragraph before it).
        parts.push(leadsWithCustomTag(segment) ? '\n\n' : '\n');
        afterFlow = false;
      }
      parts.push(segment);
      continue;
    }
    const index = Number(segments[i]);
    const flow = markKinds[index] === 'flow';
    fragmentStart = flow;
    if (flow) {
      parts.push('\n\n', substitutions[index]);
      afterFlow = true;
    } else {
      parts.push('\n', substitutions[index], '\n');
    }
  }
  return rawHtmlBlock(...parts);
};

// Split on the placeholder elements, capturing the child index: even
// segments are raw HTML, odd segments are indices.
const PLACEHOLDER_SPLIT_RE = /<template data-mdast-child="(\d+)"><\/template>/;

// Serializes an `htmlBlock`: raw segments verbatim, each placeholder through
// the regular handler for its child so the embedded Markdown gets correct
// escaping and syntax.
const htmlBlockToMarkdown: ToMarkdownExtension = {
  handlers: {
    htmlBlock: ((node: HtmlBlock, _parent, state, info) => {
      const tracker = state.createTracker(info);
      const segments = node.value.split(PLACEHOLDER_SPLIT_RE);
      let value = '';
      for (let i = 0; i < segments.length; i++) {
        if (i % 2 === 0) {
          if (segments[i] !== '') {
            value += tracker.move(segments[i]);
          }
          continue;
        }
        const child = node.children[Number(segments[i])];
        if (child !== undefined) {
          // The before/after characters drive the escaping of the embedded
          // Markdown's edges; they are whatever raw HTML surrounds it.
          value += tracker.move(
            state.handle(child, node, state, {
              ...tracker.current(),
              after: (segments[i + 1] || '\n')[0],
              before: value === '' ? '\n' : value[value.length - 1],
            }),
          );
        }
      }
      return value;
    }) as Handle,
  },
};

/**
 * Opt-in: connects raw HTML in Markdown to the editor's `@lexical/html`
 * machinery in both directions, instead of treating it as literal text.
 *
 * Import routes through the {@link DOMImportExtension} rule registry:
 *
 * - a from-markdown transform reassembles raw HTML into single nodes —
 *   block tag sequences (CommonMark splits them on blank lines) become
 *   `htmlBlock`, inline tag runs inside a paragraph (`a <u>b</u> c`)
 *   become `htmlInline` — tag-balance counting so nesting and interleaved
 *   Markdown work, and unclosed tags stay literal text,
 * - the import rules parse the HTML with `DOMParser` and hand it to
 *   `$generateNodesFromDOM`, substituting the pre-imported Markdown —
 *   including the Markdown text embedded between block tags, GitHub-style —
 *   back in via placeholder elements that inherit the surrounding
 *   formatting context (`<strong>`, `style="color: …"`).
 *
 * Export handlers build the same shape with {@link rawHtmlBlock}: raw tags
 * around embedded Markdown phrasing and blocks, serialized by the handler
 * this extension registers.
 *
 * Anything with a registered DOM import rule then works from Markdown with
 * no separate mdast importer — a custom node contributes its DOM rule
 * (serving Markdown import and HTML paste alike) and a one-template export.
 *
 * Not part of {@link MdastCommonMarkExtension} because it pulls in the
 * `@lexical/html` import machinery (and `DOMParser`, so it requires a DOM);
 * add it alongside to opt in:
 * ```ts
 * dependencies: [MdastCommonMarkExtension, MdastHtmlExtension]
 * ```
 * @experimental
 */
export const MdastHtmlExtension = defineExtension({
  dependencies: [
    CoreImportExtension,
    configExtension(DOMImportExtension, {
      rules: [HtmlChildPlaceholderRule, HtmlInlineRootRule],
    }),
    configExtension(MdastImportExtension, {
      importRules: [
        {$import: $importHtmlBlock, type: 'htmlBlock'},
        {$import: $importHtmlInline, type: 'htmlInline'},
      ],
      mdastExtensions: [rawHtmlFromMarkdown],
      toMarkdownExtensions: [htmlBlockToMarkdown],
    }),
  ],
  name: '@lexical/mdast/Html',
});
