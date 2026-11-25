/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {CompiledMdast, MdastExportContext, MdastNode} from './types';
import type {BaseSelection, ElementNode, LexicalNode} from 'lexical';
import type {
  BlockContent,
  Break,
  Code,
  Heading,
  Link,
  List,
  Nodes,
  PhrasingContent,
  Root,
  RootContent,
  Text,
  ThematicBreak,
} from 'mdast';
import type {
  Handle,
  Options as ToMarkdownExtension,
  State,
} from 'mdast-util-to-markdown';
import type {
  Event,
  Extension as MicromarkExtension,
} from 'micromark-util-types';

import {
  $withRenderContext,
  contextValue,
  createRenderState,
} from '@lexical/html';
import {$sliceSelectedTextNodeContent} from '@lexical/selection';
import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getSlot,
  $getSlotNames,
  $getState,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isRootNode,
  $isSlotHost,
  $isTextNode,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
} from 'lexical';
import {fromMarkdown} from 'mdast-util-from-markdown';
import {gfmStrikethroughToMarkdown} from 'mdast-util-gfm-strikethrough';
import {defaultHandlers, toMarkdown} from 'mdast-util-to-markdown';
import {toString as mdastToString} from 'mdast-util-to-string';

import {
  classifyCode,
  getRunFlanking,
  isCjkClass,
  isSelector,
  parseEvents,
  PUNCTUATION,
  WHITESPACE,
} from './cjkFriendly';
import {getStrictMicromarkExtensions, isReferenceAgnostic} from './compile';
import {
  $exportLineBreak,
  $isBlockLevelNode,
  exportText,
  phrasingFromTextRuns,
  TEXT_FORMAT_MASK,
  type TextRun,
} from './handlers';
import {
  emphasisMarkerState,
  paragraphBreakState,
  strongMarkerState,
} from './state';

/**
 * Runs `fn` with `state.options` temporarily overridden, restoring the
 * previous values afterwards so a per-node override never leaks into the rest
 * of the serialization.
 */
function withOptions<T>(
  state: State,
  overrides: State['options'],
  fn: () => T,
): T {
  const {options} = state;
  const saved: State['options'] = {};
  for (const key of Object.keys(overrides) as (keyof State['options'])[]) {
    saved[key] = options[key] as never;
    options[key] = overrides[key] as never;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved) as (keyof State['options'])[]) {
      options[key] = saved[key] as never;
    }
  }
}

/**
 * Collects the breaks that must be written as a backslash hard break, whatever
 * syntax they were imported with. A plain newline, or a trailing-space marker,
 * leaves an empty line (which ends the paragraph) when the break comes first in
 * its paragraph or next to another break, and the leading spaces are trimmed
 * away. Links and other inline parents are read through, so a paragraph is
 * judged as a whole. Breaks with only breaks after them are left alone:
 * neither form survives at the end of a paragraph, and a hard break there
 * would read back as a literal backslash. Each node is visited once.
 */
function collectHardBreaks(tree: Root): Set<Nodes> {
  const hard = new Set<Nodes>();
  const visit = (node: Nodes): void => {
    const leaves: Nodes[] = [];
    const flatten = (parent: Nodes): void => {
      if ('children' in parent) {
        for (const child of parent.children as Nodes[]) {
          if (
            /^(?:delete|emphasis|link|linkReference|strong)$/.test(child.type)
          ) {
            flatten(child);
          } else {
            leaves.push(child);
            visit(child);
          }
        }
      }
    };
    flatten(node);
    let end = leaves.length;
    while (end > 0 && leaves[end - 1].type === 'break') {
      end--;
    }
    for (let i = 0; i < end; i++) {
      if (
        leaves[i].type === 'break' &&
        (i === 0 ||
          leaves[i - 1].type === 'break' ||
          leaves[i + 1].type === 'break')
      ) {
        hard.add(leaves[i]);
      }
    }
  };
  visit(tree);
  return hard;
}

// A link as the container check compares it: its text, without the line
// endings by which a written break and a soft break read back differ, and
// its destination, with NUL as it reads back.
const linkKey = (link: Link): string =>
  (mdastToString(link).replace(/[\r\n]/g, '') + '\n' + link.url).replace(
    /\0/g,
    '\uFFFD',
  );

function collectLinks(node: Nodes, links: Link[] = []): Link[] {
  if (node.type === 'link') {
    links.push(node);
  } else if ('children' in node) {
    for (const child of node.children) {
      collectLinks(child, links);
    }
  }
  return links;
}

/**
 * The text each bare literal link is written as (null for a link written in
 * another form), and the `root` handler that checks it in context.
 */
interface LiteralCheck {
  bareText: (node: Link) => string | null;
  root: Handle;
}

/**
 * Checks literal links in context, with a `root` handler that delegates to
 * `root`. A literal goes out bare while its text alone parses as the same
 * link, but its neighbours can extend it or end it (`www.example.com**y**`,
 * `xwww.example.com`), and the writer can escape or encode a character beside
 * it. So each outermost phrasing container (a paragraph, a heading, a table
 * cell) is read back once it is written. When its links do not come back as
 * written, every literal in it is written again in resource or autolink form,
 * neither of which runs into its neighbours; writing the container again runs
 * its handlers again.
 */
function checkLiterals(
  getLiteralUrl: (text: string) => string | null,
  getLinkKeys: (markdown: string) => readonly string[],
  root: Handle,
): LiteralCheck {
  const demoted = new Set<Link>();
  const bareText = (node: Link): string | null => {
    const child = node.children[0];
    return !demoted.has(node) &&
      node.data != null &&
      node.data.mdastLinkStyle === 'literal' &&
      node.title == null &&
      node.children.length === 1 &&
      child.type === 'text' &&
      getLiteralUrl(child.value) === node.url
      ? child.value
      : null;
  };
  // Whether each literal written in `markdown` stands between ASCII
  // whitespace or the edges, with only GFM's trailing punctuation after it,
  // and so reads back as its text alone does, which bareText checked. GFM's
  // transform runs across other whitespace (U+3000). The writer changes a
  // literal only by encoding its first or last character beside attention
  // (`co&#x6D;*(*`), so a token that holds a reference and the rest of a
  // literal's text sends the container to the parse, as does any other token
  // that holds a literal's text.
  const isIsolated = (markdown: string, texts: Set<string>): boolean => {
    const isolated = new Set<string>();
    for (const token of markdown.split(/[ \t\n\r]+/)) {
      const isEncoded = token.includes('&#');
      if (!isEncoded && !/www\.|:\/\/|@/i.test(token)) {
        continue;
      }
      const text = token.replace(/[?!.,:]*$/, '');
      if (!isEncoded && texts.has(text)) {
        isolated.add(text);
      } else if (
        [...texts].some(key =>
          token.includes(isEncoded ? key.slice(1, -1) : key),
        )
      ) {
        return false;
      }
    }
    // A literal whose kind has none of those markers is never counted, and
    // goes to the parse.
    return isolated.size === texts.size;
  };
  return {
    bareText,
    root(node, parent, state, info) {
      // The state lives for one serialization, which starts here.
      const containerPhrasing = state.containerPhrasing;
      state.containerPhrasing = (container, containerInfo) => {
        const value = containerPhrasing.call(state, container, containerInfo);
        const links = collectLinks(container);
        const texts = new Set<string>();
        for (const link of links) {
          const text = bareText(link);
          if (text !== null) {
            texts.add(text);
          }
        }
        if (texts.size === 0) {
          return value;
        }
        // Read as the export puts its stand-ins back, and as a heading or a
        // table cell encodes a space or tab at its edges once its content is
        // written.
        const markdown = (
          standInRestore ? standInRestore(value) : value
        ).replace(/^[\t ]|[\t ]$/g, space =>
          space === ' ' ? '&#x20;' : '&#x9;',
        );
        if (isIsolated(markdown, texts)) {
          return value;
        }
        // Links read back after the last one written come from plain text,
        // which the literals do not change.
        const keys = getLinkKeys(markdown);
        if (links.every((link, i) => keys[i] === linkKey(link))) {
          return value;
        }
        for (const link of links) {
          demoted.add(link);
        }
        return containerPhrasing.call(state, container, containerInfo);
      };
      return root.call(this, node, parent, state, info);
    },
  };
}

/**
 * A to-markdown extension whose handlers reproduce the literal Markdown syntax
 * captured on import (and stored on the Lexical nodes), by temporarily
 * steering the default handlers with per-node options. Delegating to the
 * defaults keeps all the indentation / nesting / disambiguation behavior
 * intact while still honoring each node's original marker/fence. Nodes without
 * captured syntax fall straight through to the defaults, so document-level
 * options (and contributed `toMarkdownExtensions`) still apply to them.
 */
const syntaxToMarkdown = (
  hardBreaks: ReadonlySet<Nodes>,
  literals: LiteralCheck,
): ToMarkdownExtension => ({
  handlers: {
    break(node: Break, parent, state, info) {
      // Delegate first: the default handler substitutes a space when a real
      // EOL is unsafe in the current construct (headings; the table writer
      // writes a break in a cell as `<br>` before it gets here). Only
      // when it chose the hard-break form does the preserved marker apply:
      // trailing-space markers are reproduced, and the empty marker means the
      // break is SOFT (a source newline or editor line break) and serializes
      // as a plain newline rather than being upgraded to a hard break. A
      // break in `hardBreaks` keeps the hard form whatever its marker.
      const result = defaultHandlers.break(node, parent, state, info);
      if (result !== '\\\n' || hardBreaks.has(node)) {
        return result;
      }
      const marker = node.data && node.data.mdastBreak;
      if (!marker) {
        return '\n';
      }
      return /^ {2,}$/.test(marker) ? `${marker}\n` : result;
    },
    code(node: Code, parent, state, info) {
      const fence = node.data && node.data.mdastFence;
      if (!fence) {
        return defaultHandlers.code(node, parent, state, info);
      }
      return withOptions(
        state,
        {fence: fence[0] === '~' ? '~' : '`', fences: true},
        () => defaultHandlers.code(node, parent, state, info),
      );
    },
    heading(node: Heading, parent, state, info) {
      // `data.mdastSetext` is only present (true) for imported setext
      // headings; everything else defers to the document-level option.
      if (!(node.data && node.data.mdastSetext === true)) {
        return defaultHandlers.heading(node, parent, state, info);
      }
      return withOptions(state, {setext: true}, () =>
        defaultHandlers.heading(node, parent, state, info),
      );
    },
    link(node: Link, parent, state, info) {
      // `data.mdastLinkStyle` preserves the syntax the link was written in.
      // A title can't be expressed in autolink/literal form, so links with a
      // title always fall through to the default (resource form).
      const style = node.data && node.data.mdastLinkStyle;
      const text = literals.bareText(node);
      if (text !== null) {
        return text;
      }
      if (style === 'inline') {
        // Force `[text](url)` even when the text equals the URL (the
        // default handler would normalize that to an autolink).
        return withOptions(state, {resourceLink: true}, () =>
          defaultHandlers.link(node, parent, state, info),
        );
      }
      return defaultHandlers.link(node, parent, state, info);
    },
    list(node: List, parent, state, info) {
      if (node.ordered) {
        const ordered = node.data && node.data.mdastBulletOrdered;
        if (ordered == null) {
          return defaultHandlers.list(node, parent, state, info);
        }
        return withOptions(state, {bulletOrdered: ordered}, () =>
          defaultHandlers.list(node, parent, state, info),
        );
      }
      const bullet = node.data && node.data.mdastBullet;
      if (bullet == null) {
        return defaultHandlers.list(node, parent, state, info);
      }
      return withOptions(
        state,
        {bullet, bulletOther: bullet === '-' ? '*' : '-'},
        () => defaultHandlers.list(node, parent, state, info),
      );
    },
    root: literals.root,
    thematicBreak(node: ThematicBreak, parent, state) {
      const marker = node.data && node.data.mdastRule;
      if (marker !== '-' && marker !== '*' && marker !== '_') {
        return defaultHandlers.thematicBreak(node, parent, state);
      }
      return withOptions(state, {rule: marker}, () =>
        defaultHandlers.thematicBreak(node, parent, state),
      );
    },
  },
});

/**
 * Collects plain formatted text from middleware output, leaving custom
 * structure and metadata intact when the output cannot be represented as runs.
 */
function collectExportedTextRuns(
  node: MdastNode,
  format: number,
  runs: TextRun[],
): boolean {
  // Preserve annotated/custom output verbatim instead of discarding metadata
  // when rebuilding the formatting containers. Count the keys a copy with
  // `...` keeps: enumerable ones, symbol keys too, which Object.keys leaves
  // out. Later steps copy a node that way when they join its text, so a
  // non-enumerable key could not be kept reliably anyway.
  if (
    Reflect.ownKeys(node).some(
      key =>
        key !== 'type' &&
        key !== 'value' &&
        key !== 'children' &&
        Object.prototype.propertyIsEnumerable.call(node, key),
    )
  ) {
    return false;
  }
  if (node.type === 'text' || node.type === 'inlineCode') {
    runs.push({
      format: format | (node.type === 'inlineCode' ? IS_CODE : 0),
      value: node.value,
    });
    return true;
  }
  const bit =
    node.type === 'strong'
      ? IS_BOLD
      : node.type === 'emphasis'
        ? IS_ITALIC
        : node.type === 'delete'
          ? IS_STRIKETHROUGH
          : 0;
  return (
    bit !== 0 &&
    'children' in node &&
    node.children.every(child =>
      collectExportedTextRuns(child, format | bit, runs),
    )
  );
}

/**
 * Accumulates adjacent text so shared and overlapping formats serialize
 * together and re-parse correctly. Shared by the inline and block walks.
 */
class TextRunAccumulator {
  private runs: TextRun[] = [];

  /**
   * Returns `true` when `child` was absorbed. The caller decides *which* text
   * nodes are eligible (plain text with no export rule of its own); this only
   * guards the node kind.
   */
  push(child: LexicalNode): boolean {
    if (!$isTextNode(child)) {
      return false;
    }
    this.pushRun(child.getTextContent(), child.getFormat() & TEXT_FORMAT_MASK);
    return true;
  }

  private pushRun(value: string, format: number): void {
    const last = this.runs[this.runs.length - 1];
    if (last !== undefined && last.format === format) {
      last.value += value;
    } else {
      this.runs.push({format, value});
    }
  }

  /** Run middleware first, then group its plain formatted text output. */
  appendExported(nodes: MdastNode[], out: PhrasingContent[]): void {
    const runs: TextRun[] = [];
    if (nodes.every(node => collectExportedTextRuns(node, 0, runs))) {
      for (const run of runs) {
        this.pushRun(run.value, run.format);
      }
    } else {
      this.flushInto(out);
      out.push(...(nodes as PhrasingContent[]));
    }
  }

  flushInto(out: PhrasingContent[]): void {
    if (this.runs.length > 0) {
      out.push(...phrasingFromTextRuns(this.runs));
      this.runs = [];
    }
  }
}

function createNodeExporter(
  compiled: CompiledMdast,
  selection: BaseSelection | null = null,
) {
  const {exportHandlers} = compiled;
  // Incremented whenever a selected leaf contributes output. Parents compare
  // it before/after recursing to keep an element that is not itself selected
  // but hosts selected content (the markdown analogue of extractWithChild).
  let selectionHits = 0;

  /**
   * Whether the run accumulator may absorb `child`: a text node whose only
   * export behavior would be the core text fallback. A node whose type has
   * its own registered rule (or the core `'text'` rule, which the
   * accumulator supersedes to merge adjacent runs) must not be swallowed —
   * this keeps replaced/custom text nodes dispatching to their handlers.
   */
  function mayAccumulate(child: LexicalNode): boolean {
    const handlers = exportHandlers.get(child.getType());
    const handler = handlers && handlers[0];
    return handler === undefined || handler === exportText;
  }

  /**
   * Selection filter for one child. With no selection every child passes
   * through unchanged. Leaves (text, line break, decorator) pass only when
   * selected, a partially selected text node as a detached clone sliced to
   * the selected range; `null` means skip. Elements always pass — they are
   * judged after recursion by {@link $dispatchElement}.
   */
  function $filterChild(child: LexicalNode): LexicalNode | null {
    if (selection === null || $isElementNode(child)) {
      return child;
    }
    if (!child.isSelected(selection)) {
      return null;
    }
    selectionHits++;
    return $isTextNode(child)
      ? $sliceSelectedTextNodeContent(selection, child, 'clone')
      : child;
  }

  /**
   * Whether `node` or any descendant (named slots included) is selected. See
   * {@link MdastExportContext.isIncluded}.
   */
  function $isIncluded(node: LexicalNode): boolean {
    return (
      selection === null ||
      node.isSelected(selection) ||
      ($isElementNode(node) && node.getChildren().some($isIncluded)) ||
      ($isSlotHost(node) &&
        $getSlotNames(node).some(name => {
          const slot = $getSlot(node, name);
          return slot !== null && $isIncluded(slot);
        }))
    );
  }

  /**
   * Dispatches an element child, appending its output to `out` unless a
   * selection is active and neither the element nor any descendant is
   * selected.
   */
  function $dispatchElement(child: LexicalNode, out: MdastNode[]): void {
    const selfSelected = selection !== null && child.isSelected(selection);
    if (selfSelected) {
      selectionHits++;
    }
    const before = selectionHits;
    const result = $dispatch(child);
    if (selection === null || selfSelected || selectionHits > before) {
      out.push(...result);
    }
  }

  /**
   * The children a context method exports: an element's `getChildren()`, or
   * the explicit list the caller supplied (e.g. a
   * `DOMExportOutput.$getChildNodes()` override, which replaces
   * `node.getChildren()` for export by contract).
   */
  function $childrenOf(
    source: ElementNode | readonly LexicalNode[],
  ): readonly LexicalNode[] {
    // Array.isArray does not narrow readonly-array unions in the else branch.
    return Array.isArray(source)
      ? source
      : (source as ElementNode).getChildren();
  }

  const context: Omit<MdastExportContext, 'next'> = {
    exportBlocks: source => $exportBlocks(source),
    exportChildren: source => {
      const out: MdastNode[] = [];
      for (const child of $childrenOf(source)) {
        const target = $filterChild(child);
        if (target === null) {
          continue;
        }
        if ($isElementNode(target)) {
          $dispatchElement(target, out);
        } else {
          out.push(...$dispatch(target));
        }
      }
      return out;
    },
    exportInline: source => $exportInline(source),
    isIncluded: $isIncluded,
    selection,
  };

  function $dispatch(
    node: LexicalNode,
    handlers = exportHandlers.get(node.getType()),
    index = 0,
  ): MdastNode[] {
    const handler = handlers && handlers[index];
    if (handler) {
      const result = handler(node, {
        ...context,
        next: () => $dispatch(node, handlers, index + 1),
      });
      if (result != null) {
        return Array.isArray(result) ? result : [result];
      }
    }
    // Fallbacks keep unknown nodes from disappearing entirely; text and line
    // breaks reuse the core handlers so their behavior can't drift.
    const asText = exportText(node);
    if (asText !== null) {
      return [asText];
    }
    const asBreak = $exportLineBreak(node);
    if (asBreak !== null) {
      return [asBreak];
    }
    if ($isElementNode(node)) {
      return context.exportChildren(node);
    }
    const text = node.getTextContent();
    return text ? [{type: 'text', value: text}] : [];
  }

  /**
   * Converts the inline children of `source` into phrasing content.
   */
  function $exportInline(
    source: ElementNode | readonly LexicalNode[],
  ): PhrasingContent[] {
    const result: PhrasingContent[] = [];
    const runs = new TextRunAccumulator();
    for (const child of $childrenOf(source)) {
      const target = $filterChild(child);
      if (target === null) {
        continue;
      }
      if (!(mayAccumulate(target) && runs.push(target))) {
        if ($isTextNode(target)) {
          runs.appendExported($dispatch(target), result);
          continue;
        }
        runs.flushInto(result);
        if ($isElementNode(target)) {
          // The registry erases types; phrasing output is the dispatch
          // contract for inline children.
          $dispatchElement(target, result as MdastNode[]);
        } else {
          result.push(...($dispatch(target) as PhrasingContent[]));
        }
      }
    }
    runs.flushInto(result);
    return result;
  }

  /**
   * Converts a container whose Lexical children are inline (block quote, list
   * item) into mdast block content. A LineBreakNode marked as a paragraph
   * boundary (set by the import handlers when joining sibling paragraphs)
   * splits the content; any other LineBreakNode stays an inline `break`
   * (hard or soft according to its marker). Nested block children pass
   * through directly.
   */
  function $exportBlocks(
    source: ElementNode | readonly LexicalNode[],
  ): BlockContent[] {
    const blocks: BlockContent[] = [];
    let inline: PhrasingContent[] = [];
    const runs = new TextRunAccumulator();
    const flushParagraph = () => {
      runs.flushInto(inline);
      if (inline.length > 0) {
        blocks.push({children: inline, type: 'paragraph'});
        inline = [];
      }
    };
    for (const child of $childrenOf(source)) {
      const target = $filterChild(child);
      if (target === null) {
        continue;
      }
      if ($isLineBreakNode(target)) {
        const asBreak = $exportLineBreak(target);
        if ($getState(target, paragraphBreakState) || asBreak === null) {
          flushParagraph();
        } else {
          runs.flushInto(inline);
          inline.push(asBreak);
        }
      } else if (mayAccumulate(target) && runs.push(target)) {
        continue;
      } else if ($isTextNode(target)) {
        runs.appendExported($dispatch(target), inline);
      } else if ($isBlockLevelNode(target)) {
        flushParagraph();
        if ($isElementNode(target)) {
          // The registry erases types; block-level output is the dispatch
          // contract for block children.
          $dispatchElement(target, blocks as MdastNode[]);
        } else {
          blocks.push(...($dispatch(target) as BlockContent[]));
        }
      } else if ($isElementNode(target)) {
        runs.flushInto(inline);
        $dispatchElement(target, inline as MdastNode[]);
      } else {
        runs.flushInto(inline);
        inline.push(...($dispatch(target) as PhrasingContent[]));
      }
    }
    flushParagraph();
    if (blocks.length === 0) {
      blocks.push({children: [], type: 'paragraph'});
    }
    return blocks;
  }

  return {exportChildren: context.exportChildren};
}

// The markers of attention, with `~` where strikethrough is written.
const ATTENTION_MARKERS = /[*_]/;
const ATTENTION_AND_STRIKETHROUGH_MARKERS = /[*_~]/;
// What export serializes with a stand-in: a character outside the Basic
// Multilingual Plane that CommonMark reads as punctuation, such as an emoji,
// and a general-use variation selector other than the emoji one, which the
// CJK-friendly amendment reads before a marker as the character it varies.
// It also stands in for the characters micromark reads as whitespace and
// CommonMark as letters, but `\v`, which no reference can stand for, and
// for U+0000, which readers read as the U+FFFD that replaces it.
const STOOD_IN =
  /(?![\0-\uffff])[\p{P}\p{S}]|[\ufe00-\ufe0e]|[\u2028\u2029\ufeff]|\0/gu;
const MICROMARK_ONLY_WHITESPACE = /^[\u2028\u2029\ufeff]$/;

// Stand-ins come from Supplemental Punctuation (U+2E00 to U+2E7F) first,
// then from the symbols from U+2600: characters a handler is unlikely to
// write on its own.
const STAND_IN_START = 0x2600;
const STAND_IN_END = 0x2e80;
const STAND_IN_FIRST = 0x2e00;

/** Adds each character of `value` in the stand-in range to `used`. */
function collectUsed(value: string, used: Set<number>): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= STAND_IN_START && code < STAND_IN_END) {
      used.add(code);
    }
  }
}

/**
 * How often each character of {@link STOOD_IN} occurs in the text of
 * `tree`; when there is any, adds what the strings of its nodes (not their
 * `data`) hold of the stand-in range to `used`.
 */
function countStoodIn(tree: Root, used: Set<number>): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (node: Nodes) => {
    if (node.type === 'text') {
      for (const [character] of node.value.matchAll(STOOD_IN)) {
        counts.set(character, (counts.get(character) || 0) + 1);
      }
    }
    if ('children' in node) {
      node.children.forEach(visit);
    }
  };
  visit(tree);
  // Most documents have none, and skip this second walk.
  if (counts.size > 0) {
    const collect = (node: Nodes) => {
      for (const key in node) {
        const value = (node as unknown as Record<string, unknown>)[key];
        if (typeof value === 'string') {
          collectUsed(value, used);
        }
      }
      if ('children' in node) {
        node.children.forEach(collect);
      }
    };
    collect(tree);
  }
  return counts;
}

// How `mdast-util-to-markdown` reads a UTF-16 unit beside a marker, in the
// classes of `classifyCode`: whitespace, punctuation or a letter.
const LETTER = 0;
function classifyUnit(code: number): number {
  return classifyCode(code) & (WHITESPACE | PUNCTUATION);
}

/**
 * A stand-in for each of `characters`: a punctuation character of the Basic
 * Multilingual Plane that is not in `used`. A document that uses the
 * range's hundreds of punctuation characters leaves the rest without one,
 * and they go out as they are.
 */
function pickStandIns(
  characters: Iterable<string>,
  used: Set<number>,
): Map<string, string> {
  const standIns = new Map<string, string>();
  const size = STAND_IN_END - STAND_IN_START;
  let next = STAND_IN_FIRST - STAND_IN_START;
  let left = size;
  for (const character of characters) {
    while (left > 0) {
      const code = STAND_IN_START + next;
      next = (next + 1) % size;
      left--;
      if (classifyUnit(code) === PUNCTUATION && !used.has(code)) {
        standIns.set(character, String.fromCharCode(code));
        break;
      }
    }
  }
  return standIns;
}

/**
 * Wraps the `text` handler of `handlers` so that it serializes the text with
 * the characters of {@link pickStandIns} standing in, counting in `written`
 * how often it writes each stand-in. A look at a node ahead counts nothing:
 * every other handler gets a `peek`, which to-markdown calls for the look,
 * whose text is not written.
 */
function standInText(
  handlers: Record<string, Handle>,
  standIns: Map<string, string>,
  written: Map<string, number>,
): ToMarkdownExtension {
  const handle = handlers.text;
  const lookAhead = (handle as Handle & {peek?: Handle}).peek || handle;
  let peeking = 0;
  const wrapped: Record<string, Handle> = {};
  for (const type in handlers) {
    const own = handlers[type];
    const look = (own as Handle & {peek?: Handle}).peek || own;
    // With what else the handler holds, such as how it marks attention.
    wrapped[type] = Object.assign(
      function (this: unknown, ...args: Parameters<Handle>) {
        return own.apply(this, args);
      },
      own,
      {
        peek(this: unknown, ...args: Parameters<Handle>) {
          peeking++;
          try {
            return look.apply(this, args);
          } finally {
            peeking--;
          }
        },
      },
    );
  }
  const serialize = (
    self: unknown,
    isCounted: boolean,
    ...[node, parent, state, info]: Parameters<Handle>
  ): string => {
    // An autolink writes its text as is, with no emphasis around it.
    const own = isCounted ? handle : lookAhead;
    if (state.stack.includes('autolink')) {
      return own.call(self, node, parent, state, info);
    }
    const {value} = node as Text;
    const standIn = (character: string): string => {
      const found = standIns.get(character);
      if (found === undefined) {
        return character;
      }
      if (isCounted && peeking === 0) {
        written.set(found, (written.get(found) || 0) + 1);
      }
      return found;
    };
    // Set on the node itself, which the handler finds among its siblings.
    (node as Text).value = value.replace(STOOD_IN, standIn);
    try {
      return own.call(self, node, parent, state, info);
    } finally {
      (node as Text).value = value;
    }
  };
  wrapped.text = Object.assign(
    function (this: unknown, ...args: Parameters<Handle>) {
      return serialize(this, true, ...args);
    },
    {
      peek(this: unknown, ...args: Parameters<Handle>) {
        return serialize(this, false, ...args);
      },
    },
  );
  return {handlers: wrapped};
}

/** The handlers that `extensions` set, over to-markdown's own. */
function getHandlers(
  extensions: ToMarkdownExtension[],
  handlers: Record<string, Handle> = {...defaultHandlers} as Record<
    string,
    Handle
  >,
): Record<string, Handle> {
  for (const extension of extensions) {
    if (extension.extensions) {
      getHandlers(extension.extensions, handlers);
    }
    Object.assign(handlers, extension.handlers);
  }
  return handlers;
}

// How the export in progress puts its stand-ins back, for measuring. Any
// serialization while it is written measures so, as the export puts back
// what it embeds of that too.
let measuredRestore: ((values: string[]) => string[]) | null = null;
// How the export in progress puts its stand-ins back in what it writes.
let standInRestore: ((value: string) => string) | null = null;

/**
 * The lengths of `values`, parts of the Markdown being exported that are
 * each one line of inline content, once their stand-ins are put back: a
 * table measures its cells with it to align them, all at once.
 *
 * @internal
 */
export function getExportedLengths(values: string[]): number[] {
  return (measuredRestore ? measuredRestore(values) : values).map(
    value => value.length,
  );
}

/**
 * Serializes `tree` with `extensions`. `mdast-util-to-markdown` reads a
 * character outside the Basic Multilingual Plane one UTF-16 unit at a time,
 * so as a letter, where CommonMark and the CJK-friendly amendment read an
 * emoji or another such symbol as punctuation: a run between it and a letter
 * does not open or close for them (`Hello**🎉 launch**`). It reads a
 * variation selector as a letter too, where the amendment reads one before a
 * marker as the character it varies, mostly a symbol (`**©\ufe0e**2024`). So that
 * the export writes the references and picks the markers those readers need,
 * each such character in text stands in, while the text is serialized, as a
 * punctuation character of the Basic Multilingual Plane that the tree does
 * not hold, and {@link restoreStoodIn} puts it back.
 *
 * `mdast-util-to-markdown` 2.2.2 and earlier serialize many touching runs of attention,
 * or attention without content, in quadratic time
 * (https://github.com/syntax-tree/mdast-util-to-markdown/issues/96). Check
 * again when its version changes, and vendor the fix if no release has it.
 */
function toMarkdownWithStandIns(
  tree: Root,
  extensions: ToMarkdownExtension[],
  isCjkFriendly: boolean,
  measure?: (values: string[]) => string[],
): string {
  const used = new Set<number>();
  const counts = countStoodIn(tree, used);
  if (counts.size > 0) {
    const handlers = getHandlers(extensions);
    // A handler that writes a stand-in of its own, or that writes some text
    // twice, leaves more of it than the text has: pick again, avoiding what
    // the output holds, and failing that serialize without stand-ins.
    for (let attempt = 0; attempt < 2; attempt++) {
      const standIns = pickStandIns(counts.keys(), used);
      const characters = new Map<string, string>();
      for (const [character, standIn] of standIns) {
        characters.set(standIn, character);
      }
      const written = new Map<string, number>();
      const restore = getRestore(
        characters,
        isCjkFriendly,
        'delete' in handlers
          ? ATTENTION_AND_STRIKETHROUGH_MARKERS
          : ATTENTION_MARKERS,
      );
      const out = measuring(
        values => {
          const restored = values.map(value => restore(value));
          return measure ? measure(restored) : restored;
        },
        () =>
          toMarkdown(tree, {
            extensions: [
              ...extensions,
              standInText(handlers, standIns, written),
            ],
          }),
        value => restore(value),
      );
      const found = new Map<string, number>();
      for (let i = 0; i < out.length; i++) {
        if (characters.has(out[i])) {
          found.set(out[i], (found.get(out[i]) || 0) + 1);
        }
      }
      let isClean = true;
      for (const [standIn, count] of found) {
        isClean &&= count <= (written.get(standIn) || 0);
      }
      if (isClean) {
        return restore(out, true);
      }
      // Only new characters to avoid make another attempt worth writing.
      const {size} = used;
      collectUsed(out, used);
      if (used.size === size) {
        break;
      }
    }
  }
  return measuring(measure, () => toMarkdown(tree, {extensions}));
}

/**
 * How {@link joinAdjacentDeletes} joins, by the handlers that write what it
 * joins.
 */
interface DeleteJoin {
  /**
   * Whether a plain empty text between two deletes leaves them touching, as
   * the stock `text` handler writes nothing for it.
   */
  readonly crossesEmptyText: boolean;
  /**
   * Whether touching inline code in a joined delete is joined too, as the
   * stock `inlineCode` handler, or the one a table cell uses, writes it.
   */
  readonly joinsCode: boolean;
}

// The inline code handlers that MdastTableExtension builds for table cells
// from mdast-util-gfm-table: each writes code as the stock handler does and
// escapes `|`.
let tableCellCodeHandlers: WeakSet<Handle> | undefined;

/**
 * Records `handler`, an inline code handler that MdastTableExtension builds
 * for table cells, so that {@link getDeleteJoin} lets the export join
 * touching code that it writes, as it does for the stock handler.
 *
 * @internal
 */
export function registerTableCellCodeHandler(handler: Handle): void {
  if (tableCellCodeHandlers === undefined) {
    tableCellCodeHandlers = new WeakSet();
  }
  tableCellCodeHandlers.add(handler);
}

/**
 * How the export joins touching deletes that `extensions` write, or `null`
 * when a handler other than the stock one of mdast-util-gfm-strikethrough
 * writes them, as what that handler writes for each node is its own.
 */
function getDeleteJoin(extensions: ToMarkdownExtension[]): DeleteJoin | null {
  const handlers = getHandlers(extensions);
  const stock = gfmStrikethroughToMarkdown().handlers;
  if (!stock || handlers.delete !== stock.delete) {
    return null;
  }
  return {
    crossesEmptyText: handlers.text === defaultHandlers.text,
    joinsCode:
      handlers.inlineCode === defaultHandlers.inlineCode ||
      (tableCellCodeHandlers !== undefined &&
        tableCellCodeHandlers.has(handlers.inlineCode)),
  };
}

/**
 * `node` as the export writes it: touching deletes joined as `join` says,
 * when it does (see {@link joinAdjacentDeletes}), then adjacent texts (see
 * {@link joinAdjacentText}). The tree itself is not changed.
 */
function joinForMarkdown<T extends Nodes>(node: T, join: DeleteJoin | null): T {
  return joinAdjacentText(
    join === null ? node : joinAdjacentDeletes(node, join),
  );
}

/**
 * `node` with each run of touching `delete` siblings joined into one, which
 * keeps the first one's fields and holds the children of all of them. Output
 * kept as an export rule returned it, for its `data` or its own shape, can
 * put deletes side by side, and no run of tildes reads back as two touching
 * strikethroughs: `~~a~~~~b~~` is one, of `a~~~~b`. The stock handler reads
 * neither `data` nor `position`, so what it writes is that of one delete.
 * The tree itself is not changed.
 */
function joinAdjacentDeletes<T extends Nodes>(node: T, join: DeleteJoin): T {
  if (!('children' in node)) {
    return node;
  }
  const source = node.children as Nodes[];
  // Copied on the first change only, so a tree with nothing to join is kept.
  let children: Nodes[] | null = null;
  for (let i = 0; i < source.length; i++) {
    const child = source[i];
    // One past the last delete of the run that starts at `child`.
    let end = i + 1;
    if (child.type === 'delete') {
      for (let next = end; next < source.length; next++) {
        const sibling = source[next];
        if (sibling.type === 'delete') {
          end = next + 1;
        } else if (!(join.crossesEmptyText && isPlainEmptyText(sibling))) {
          break;
        }
      }
    }
    let joined: Nodes;
    if (end > i + 1 && child.type === 'delete') {
      let runChildren: PhrasingContent[] = [];
      for (let j = i; j < end; j++) {
        const sibling = source[j];
        if (sibling.type === 'delete') {
          for (const grandchild of sibling.children) {
            runChildren.push(grandchild);
          }
        }
      }
      if (join.joinsCode) {
        runChildren = joinAdjacentCode(runChildren, join.crossesEmptyText);
      }
      joined = joinAdjacentDeletes({...child, children: runChildren}, join);
    } else {
      joined = joinAdjacentDeletes(child, join);
    }
    if (children === null && joined !== child) {
      children = source.slice(0, i);
    }
    if (children !== null) {
      children.push(joined);
    }
    i = end - 1;
  }
  return children === null ? node : {...node, children};
}

/**
 * `children` with each run of touching inline code joined into one, which
 * keeps the first one's fields. Written apart they read back as one code
 * span with the graves between them in it (`` `a``b` ``). Plain empty texts
 * between two of them are dropped when `crossesEmptyText` says they are
 * written as nothing. Used for the children of a joined delete, which the
 * join put side by side.
 */
function joinAdjacentCode(
  children: PhrasingContent[],
  crossesEmptyText: boolean,
): PhrasingContent[] {
  const joined: PhrasingContent[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const last = joined[joined.length - 1];
    if (
      child.type === 'inlineCode' &&
      last !== undefined &&
      last.type === 'inlineCode'
    ) {
      joined[joined.length - 1] = {...last, value: last.value + child.value};
      continue;
    }
    if (
      crossesEmptyText &&
      last !== undefined &&
      last.type === 'inlineCode' &&
      isPlainEmptyText(child)
    ) {
      let next = i + 1;
      while (next < children.length && isPlainEmptyText(children[next])) {
        next++;
      }
      if (next < children.length && children[next].type === 'inlineCode') {
        i = next - 1;
        continue;
      }
    }
    joined.push(child);
  }
  return joined;
}

/** Whether `node` is a text with nothing but an empty value. */
function isPlainEmptyText(node: Nodes): boolean {
  return isPlainText(node) && node.value === '';
}

/**
 * `node` with each run of adjacent text siblings joined into one text, as an
 * inline element with no export rule of its own (a MarkNode) leaves its text
 * beside the text around it. mdast-util-to-markdown gives a text only the
 * last character of the one before it to decide its escapes, so a `www.`
 * split over two texts would go out unescaped. A text with anything but its
 * value, such as `data` or a `position` that an export rule set for a handler
 * to read, is kept apart. The tree itself is not changed.
 */
function joinAdjacentText<T extends Nodes>(node: T): T {
  if (!('children' in node)) {
    return node;
  }
  const source = node.children as Nodes[];
  // Copied on the first change only, so a tree with nothing to join is kept.
  let children: Nodes[] | null = null;
  for (let i = 0; i < source.length; i++) {
    const child = source[i];
    const last = children ? children[children.length - 1] : source[i - 1];
    if (i > 0 && isPlainText(child) && isPlainText(last)) {
      if (children === null) {
        children = source.slice(0, i);
      }
      children[children.length - 1] = {
        type: 'text',
        value: last.value + child.value,
      };
    } else {
      const joined = joinAdjacentText(child);
      if (children === null && joined !== child) {
        children = source.slice(0, i);
      }
      if (children !== null) {
        children.push(joined);
      }
    }
  }
  return children === null ? node : {...node, children};
}

/**
 * Whether `node` is a text with nothing but its value: no `data`, no
 * `position`, nor anything else set.
 */
function isPlainText(node: Nodes | undefined): node is Text {
  return (
    node !== undefined &&
    node.type === 'text' &&
    // Symbol keys too, which Object.entries leaves out.
    Reflect.ownKeys(node).every(
      key =>
        key === 'type' ||
        key === 'value' ||
        (node as unknown as Record<PropertyKey, unknown>)[key] === undefined,
    )
  );
}

/** Runs `serialize` with `measure` as how {@link getExportedLengths} measures. */
function measuring(
  measure: ((values: string[]) => string[]) | undefined,
  serialize: () => string,
  restore: ((value: string) => string) | null = null,
): string {
  // A handler may export another document while this one is written.
  const outer = measuredRestore;
  const outerRestore = standInRestore;
  measuredRestore = measure || null;
  standInRestore = restore;
  try {
    return serialize();
  } finally {
    measuredRestore = outer;
    standInRestore = outerRestore;
  }
}

/**
 * Puts back the characters {@link toMarkdownWithStandIns} stood in for, which
 * `pattern` finds; {@link getRestore} builds it once for an export. The
 * export reads as intended for every reader that reads them as punctuation.
 * micromark without the CJK-friendly extension reads an emoji one UTF-16
 * unit at a time, so as a letter; every reader reads a variation selector as
 * one, but CJK-friendly readers before a marker, which read the character it
 * varies; micromark reads U+FEFF, U+2028 and U+2029 as whitespace,
 * other readers as letters. Where a run beside such a character would flank
 * otherwise for some reader, the character goes out as a reference, which
 * every reader reads as punctuation; an export only for CJK-friendly readers
 * needs that for the characters of the Basic Multilingual Plane alone.
 */
function getRestore(
  characters: Map<string, string>,
  isCjkFriendly: boolean,
  markers: RegExp,
): (markdown: string, isDocument?: boolean) => string {
  const pattern = new RegExp(`[${[...characters.keys()].join('')}]`, 'g');
  return (markdown, isDocument = false) =>
    restoreStoodIn(
      markdown,
      characters,
      pattern,
      isCjkFriendly,
      markers,
      isDocument,
    );
}

function restoreStoodIn(
  markdown: string,
  characters: Map<string, string>,
  pattern: RegExp,
  isCjkFriendly: boolean,
  markers: RegExp,
  isDocument: boolean,
): string {
  pattern.lastIndex = 0;
  if (!pattern.test(markdown)) {
    return markdown;
  }
  // Whether the character at `index` is escaped by a backslash.
  const isEscaped = (index: number): boolean => {
    let backslashes = 0;
    while (markdown[index - 1 - backslashes] === '\\') {
      backslashes++;
    }
    return backslashes % 2 === 1;
  };
  // How readers read the character a stand-in stands for.
  const readings = (standIn: string): number[] => {
    const character = characters.get(standIn)!;
    // Every reader reads U+0000 as the U+FFFD that replaces it.
    return character === '\0'
      ? [PUNCTUATION]
      : MICROMARK_ONLY_WHITESPACE.test(character)
        ? [PUNCTUATION, WHITESPACE, LETTER]
        : [PUNCTUATION, LETTER];
  };
  // Whether the run beside `index`, toward `step`, flanks the same for every
  // reading of the stand-in at `index`, whatever is read beyond the run. A
  // stand-in there whose readings flank differently goes out as a reference
  // itself, which every reader reads as punctuation.
  const isPortable = (index: number, step: 1 | -1): boolean => {
    const marker = markdown[index + step];
    let end = index + step;
    while (markdown[end] === marker && !isEscaped(end)) {
      end += step;
    }
    if (end === index + step) {
      // An escaped marker, which is punctuation like any other.
      return true;
    }
    const beyond = markdown.charCodeAt(end);
    const fars = characters.has(markdown[end])
      ? readings(markdown[end])
      : [Number.isNaN(beyond) ? WHITESPACE : classifyUnit(beyond)];
    const flanking = (near: number, far: number) => {
      const [open, close] =
        step === 1
          ? getRunFlanking(marker.charCodeAt(0), near, far)
          : getRunFlanking(marker.charCodeAt(0), far, near);
      return Number(open) | (Number(close) << 1);
    };
    const nears = readings(markdown[index]);
    return fars.every(far =>
      nears.every(near => flanking(near, far) === flanking(PUNCTUATION, far)),
    );
  };
  // Whether a `~` run right after `index` closes, as it does for the
  // stand-in there, which is punctuation.
  const closesAfter = (index: number): boolean => {
    let end = index + 1;
    while (markdown[end] === '~') {
      end++;
    }
    const beyond = markdown.charCodeAt(end);
    return (
      end > index + 1 &&
      getRunFlanking(
        126,
        PUNCTUATION,
        Number.isNaN(beyond)
          ? WHITESPACE
          : characters.has(markdown[end])
            ? PUNCTUATION
            : classifyUnit(beyond),
      )[1]
    );
  };
  // Whether the stand-in at `index`, for `character`, goes out as a
  // reference.
  const isReferenced = (index: number, character: string): boolean =>
    // micromark drops a byte order mark that starts the document.
    (isDocument && index === 0 && character === '\ufeff') ||
    ((!isCjkFriendly || character.length === 1) &&
      ((markers.test(markdown[index - 1]) && !isPortable(index, -1)) ||
        (markers.test(markdown[index + 1]) && !isPortable(index, 1)) ||
        // micromark-extension-cjk-friendly-gfm-strikethrough reads a
        // selector before `~` as a letter, not as what it varies, and so
        // never closes the run there, but reads its reference as every
        // reader does.
        (markers === ATTENTION_AND_STRIKETHROUGH_MARKERS &&
          isSelector(character.charCodeAt(0)) &&
          closesAfter(index))));
  // `mdast-util-to-markdown` writes a reference only for whitespace or a
  // letter, so never for a stand-in.
  return markdown.replace(pattern, (standIn, i: number) => {
    const character = characters.get(standIn)!;
    return isReferenced(i, character)
      ? // A backslash before the reference would escape its `&`.
        `${isEscaped(i) ? '\\' : ''}&#x${character
          .codePointAt(0)!
          .toString(16)
          .toUpperCase()};`
      : character;
  });
}

/**
 * Whether `character` is a marker of a run that a CJK-friendly reader reads
 * beside a CJK character as beside a reference.
 */
function isRunMarker(character: string | undefined): boolean {
  return character === '*' || character === '~';
}
// A character reference, which {@link toCjkFriendly} may write as its
// character, with the escaped backslash before it, which the character needs
// no longer.
const REFERENCE = /(\\\\)?&#(?:(\d+)|[xX]([\da-fA-F]+));/g;

/**
 * The CJK-friendly form of a strict export. A strict export writes a
 * character reference beside a `*` or `~` run where the run would not open or
 * close for strict readers, as in `**你好。**&#x4E16;界`: for a letter
 * outside a run whose inside is punctuation, or a reference to whitespace. A
 * CJK-friendly reader reads such a run beside a CJK character, or beside a
 * letter where a CJK character is on its other side, as it does beside the
 * `&` or `;` of the reference, so those references are written as the
 * characters they stand for. A run of `_` does not open or close between two
 * letters for any reader, so a reference beside one stays, as does one beside
 * the markers that another syntax adds, unless that syntax is marked by
 * `referenceAgnostic`.
 */
function toCjkFriendly(markdown: string, compiled: CompiledMdast): string {
  // Parse only when there is a reference to rewrite.
  if (!markdown.includes('&#')) {
    return markdown;
  }
  // Each reference to rewrite: where its match starts, the offset of its
  // `&`, where its match ends, and what it becomes; for a letter, where the
  // run before it ends (-1 for none), and then the `&` of each reference to
  // a CJK character beyond a run beside it, which is rewritten too, or null
  // where it is not to be rewritten. A backslash before a letter or a CJK
  // character is not an escape, so the backslash that escaped it before the
  // reference goes too.
  const rewrites: [
    start: number,
    begin: number,
    end: number,
    rewrite: string,
    before: number,
    needs: number[] | null,
  ][] = [];
  // The `&` of each reference to a CJK character to rewrite, by its offset
  // and by the offset of its `;`, where a run beside a letter may end.
  const cjk = new Map<number, number>();
  // The markers of other runs, such as `_`, which open and close beside the
  // reference other than beside its character: those that a syntax
  // extension adds, or the ASCII punctuation that starts its inline syntax,
  // but for a syntax marked by `referenceAgnostic`: its micromark tokenizers
  // match beside either alike in what the export writes, and its mdast
  // transforms read the decoded text, where the two are the same.
  const others = new Set(['_']);
  for (const extension of compiled.micromarkExtensions) {
    if (isReferenceAgnostic(extension)) {
      continue;
    }
    const {attentionMarkers, text} = extension;
    for (const code of [
      ...((attentionMarkers && attentionMarkers.null) || []),
      ...Object.keys(text || {}).map(Number),
    ]) {
      const character = String.fromCharCode(Number(code));
      if (/[!-/:-@[-`{-~]/.test(character)) {
        others.add(character);
      }
    }
  }
  for (const {
    0: match,
    1: backslashes,
    2: decimal,
    3: hex,
    index,
  } of markdown.matchAll(REFERENCE)) {
    const code = decimal ? parseInt(decimal, 10) : parseInt(hex!, 16);
    // A backslash before it is no marker, and neither is an escaped one.
    let escapes = 0;
    while (markdown[index - 2 - escapes] === '\\') {
      escapes++;
    }
    const before = backslashes || escapes % 2 ? '' : markdown[index - 1];
    const end = index + match.length;
    const after = markdown[end];
    if (
      !(isRunMarker(before) || isRunMarker(after)) ||
      (others.has(before) && !isRunMarker(before)) ||
      (others.has(after) && !isRunMarker(after))
    ) {
      continue;
    }
    // micromark reads references past the last code point too.
    const characterClass = code <= 0x10ffff ? classifyCode(code) : WHITESPACE;
    const isCjk = isCjkClass(characterClass);
    // A letter, but not one whose reference micromark reads as U+FFFD: a
    // control character, a lone surrogate or a noncharacter.
    if (isCjk || (characterClass === LETTER && hasLosslessReference(code))) {
      rewrites.push([
        index,
        backslashes ? index + 2 : index,
        end,
        (backslashes ? '\\' : '') + String.fromCodePoint(code),
        before ? index - 1 : -1,
        isCjk ? [] : null,
      ]);
      // Before a run, it is its character once rewritten; after one, only
      // without the backslash that stays before it.
      if (isCjk) {
        cjk.set(end - 1, backslashes ? index + 2 : index);
        if (!backslashes) {
          cjk.set(index, index);
        }
      }
    }
  }
  // A letter is written as such where a CJK character, or a reference to
  // one that is rewritten, is beyond each run beside it, and a CJK character
  // where no letter but a CJK one is: a run that a CJK character is on one
  // side of opens and closes beside anything on the other but whitespace,
  // and one between a letter and the reference's `&` or `;` might not.
  let isAny = false;
  for (const rewrite of rewrites) {
    const needs: number[] = [];
    const isLetter = rewrite[5] === null;
    const fits = (beyond: number) =>
      beyond < 0 ||
      isCjkClass(beyond) ||
      (!isLetter && (beyond === WHITESPACE || (beyond & PUNCTUATION) !== 0));
    rewrite[5] =
      (rewrite[4] < 0 ||
        fits(classifyBeyond(markdown, rewrite[4], -1, cjk, needs))) &&
      fits(classifyBeyond(markdown, rewrite[2], 1, cjk, needs))
        ? isLetter
          ? needs
          : []
        : null;
    isAny ||= rewrite[5] !== null;
  }
  if (!isAny) {
    return markdown;
  }
  // Only references that micromark reads as such: not escaped ones, nor
  // those in code. Its events are enough, without building a tree.
  const begins = new Set<number>();
  const events = parseEvents(markdown, compiled.micromarkExtensions);
  for (const [kind, token] of events) {
    if (kind === 'enter' && token.type === 'characterReferenceValue') {
      begins.add(markdown.lastIndexOf('&', token.start.offset));
    }
  }
  // The `&` of each reference that is rewritten, and of those that need
  // each, which are not where it is not.
  const rewritten = new Set<number>();
  const dependents = new Map<number, number[]>();
  for (const [, begin, , , , needs] of rewrites) {
    if (needs && begins.has(begin)) {
      rewritten.add(begin);
      for (const need of needs) {
        const list = dependents.get(need);
        if (list) {
          list.push(begin);
        } else {
          dependents.set(need, [begin]);
        }
      }
    }
  }
  const withdrawn = [...dependents.keys()].filter(need => !rewritten.has(need));
  for (let need = withdrawn.pop(); need !== undefined; need = withdrawn.pop()) {
    for (const begin of dependents.get(need) || []) {
      if (rewritten.delete(begin)) {
        withdrawn.push(begin);
      }
    }
  }
  let out = '';
  let last = 0;
  for (const [start, begin, end, rewrite] of rewrites) {
    if (rewritten.has(begin)) {
      out += markdown.slice(last, start) + rewrite;
      last = end;
    }
  }
  return out + markdown.slice(last);
}

/**
 * The class of the character beyond the run of `*` or `~` that starts at
 * `index` of `markdown`, toward `step`, or -1 where there is no such run. A
 * reference to a CJK character in `cjk` counts as that character, and its
 * `&` goes in `needs`, as it is rewritten too.
 */
function classifyBeyond(
  markdown: string,
  index: number,
  step: 1 | -1,
  cjk: Map<number, number>,
  needs: number[],
): number {
  const marker = markdown[index];
  if (!isRunMarker(marker)) {
    return -1;
  }
  while (markdown[index] === marker) {
    index += step;
  }
  const reference = cjk.get(index);
  if (reference !== undefined) {
    needs.push(reference);
    // As a CJK character, which is all that is asked of it.
    return classifyCode(0x4e16);
  }
  const pair = step === -1 ? markdown.codePointAt(index - 1) : undefined;
  const code =
    pair !== undefined && pair > 0xffff
      ? pair
      : (markdown.codePointAt(index) ?? null);
  // Every reader reads U+0000 as the U+FFFD that replaces it.
  return classifyCode(code === 0 ? 0xfffd : code);
}

// Where a strict export may read otherwise in cmark-gfm, which GitHub reads
// Markdown with: a `*` or `_` run beside a `~` run, which cmark-gfm skips to
// read the character beyond it, or a symbol of the Basic Multilingual Plane
// beside a marker, which cmark-gfm reads as a letter. Outside the plane,
// micromark and cmark-gfm read a symbol alike, as a letter.
const CMARK_GFM_GATE =
  /[*_]~|~[*_]|(?=[\x80-\uffff])\p{S}[*_~]|[*_~](?=[\x80-\uffff])\p{S}/u;
// What cmark-gfm reads as punctuation and as whitespace beside a marker. Its
// table of Unicode punctuation is older than the host's, so a character of
// `\p{P}` outside ASCII may read as a letter there.
const CMARK_PUNCTUATION = /[!-/:-@[-`{-~\p{P}]/u;
const COMMONMARK_PUNCTUATION = /[!-/:-@[-`{-~\p{P}\p{S}]/u;
const SPACE_SEPARATOR = /\p{Zs}/u;
const UNICODE_PUNCTUATION_ONLY = /\p{P}/u;
const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
// What linkify-it, which markdown-it reads links in text with, ends a word
// at, and the shapes of a word that it may start a link from: a scheme, a
// protocol-relative link, an email, a domain with a top-level domain of two
// letters or more, or an IPv4 address.
const WORD_BREAK = /[\p{Z}\p{Cc}]/u;
const LINK_SHAPE = /:[^\p{Z}\p{Cc}]|\/\/|@|\.\p{L}{2}|\d\.\d/u;
// What ends a bare URL in cmark-gfm, and what starts one. In
// extensions/autolink.c (0.29.0.gfm.14), `url_match` and `www_match` extend
// a link to the first byte that `cmark_isspace` reads as a space (a tab, a
// line feed, a carriage return or a space) or to a `<`, so a URL holds a
// vertical tab, a form feed and every space outside ASCII, which linkify-it
// ends a word at. A link starts at the ASCII letters that `url_match`
// rewinds before `://`, which `sd_autolink_issafe` asks to be `http`,
// `https` or `ftp` in any case, or at `www.`, which `www_match` asks to
// start the inline text or follow a space, `*`, `_`, `~` or `(`; a `>` counts
// too, as the text after a block quote marker with no space starts there.
// Not read here: the domain that `check_domain` asks for, and the
// punctuation that `autolink_delim` trims from the end, so the guard may
// leave out more than cmark-gfm links.
const CMARK_URL_BREAK = /[\t\n\r <]/;
// What may come before the start, then the start.
const CMARK_URL_START =
  /(^|[^A-Za-z])(?:[Hh][Tt][Tt][Pp][Ss]?|[Ff][Tt][Pp]):\/\/|(^|[*_~(>])www\./;
// The tokens of micromark that the pass reads: the subjects, the pairs and
// their sequences, the containers of the region check and the block syntax
// it counts as accounted for.
const SUBJECT_TYPES =
  /^(?:atxHeadingText|paragraph|setextHeadingText|tableContent)$/;
const PAIR_TYPES = /^(?:emphasis|strikethrough|strong)$/;
const SEQUENCE_TYPES =
  /^(?:emphasisSequence|strikethroughSequence|strongSequence)$/;
const CONTAINER_TYPES = /^(?:blockQuote|listOrdered|listUnordered)$/;
const PREFIX_TYPES = /^(?:blockQuotePrefix|listItemPrefix|thematicBreak)$/;
const NUMERIC_REFERENCE = /^&#(?:[xX]([\da-fA-F]+)|(\d+));$/;

// The role of a character in a run, as micromark reads it.
const NO_ROLE = 0;
const DATA = 1;
const OPENER = 2;
const CLOSER = 3;
// What a run opens and closes for, as bits.
const OPENS = 1;
const CLOSES = 2;
// The offset of a character that the region check counts as block syntax.
const BLOCK_SYNTAX = -2;

/** The offsets of the characters that a pass writes as references. */
interface Edits {
  has(offset: number): boolean;
}

// No edits.
const NO_EDITS: Edits = {has: () => false};

/** `edits` with `added` too. */
function withEdits(edits: Edits, added: readonly number[]): Edits {
  return added.length === 0
    ? edits
    : {has: offset => added.includes(offset) || edits.has(offset)};
}

/**
 * A text that cmark-gfm parses on its own, as {@link toCmarkGfmCompatible}
 * reads it: a paragraph, the text of a heading, or a table cell.
 */
interface CmarkSubject {
  readonly start: number;
  readonly end: number;
  /** Its place among the subjects of the document, in order. */
  readonly index: number;
  readonly isCell: boolean;
  /** Its runs that micromark reads as opening or closing, in order. */
  readonly runs: MarkerRun[];
  /** Whether the region check leaves it as it is. */
  hasLooseBacktick: boolean;
  /** The markers in its region that micromark does not account for. */
  readonly looseMarkers: Set<string>;
}

/** What a reader reads beside a run: a character, or the edge of a text. */
interface RunSide {
  /** Its offset, or -1 for the edge, which reads as whitespace. */
  readonly offset: number;
  /** Its class without references. */
  readonly characterClass: number;
}

/** A run of `*`, `_` or `~` in a subject. */
interface MarkerRun {
  readonly start: number;
  readonly end: number;
  readonly marker: string;
  readonly subject: CmarkSubject;
  /** Whether micromark reads it as opening or closing a pair. */
  readonly isMatched: boolean;
  /** What it opens or closes in micromark's reading, which cmark-gfm needs. */
  readonly needs: number;
  /** The pairs it opens or closes. */
  readonly pairs: readonly number[];
  /** Whether its subject holds a literal marker of its character. */
  readonly hasLiteral: boolean;
  /** What cmark-gfm reads before and after it. */
  readonly cmark: readonly [RunSide, RunSide];
  /** What CommonMark reads before and after it. */
  readonly commonMark: readonly [RunSide, RunSide];
  /**
   * The offsets of what cmark-gfm reads beside it that is punctuation
   * outside ASCII, which cmark-gfm's older table may read as a letter.
   */
  readonly uncertain: readonly number[];
}

/**
 * Whether CommonMark, and so cmark-gfm, reads the code point `code` as
 * whitespace: a tab, a line feed, a form feed, a carriage return or a space
 * separator (markdown-it also reads a vertical tab, which the README lists).
 * micromark reads more as whitespace, such as U+2028 and U+FEFF, which the
 * region check reads as letters, as the other readers do.
 */
function isCommonMarkWhitespace(code: number): boolean {
  return (
    code === 9 ||
    code === 10 ||
    code === 12 ||
    code === 13 ||
    code === 32 ||
    SPACE_SEPARATOR.test(String.fromCodePoint(code))
  );
}

/** How cmark-gfm reads the code point `code` beside a marker. */
function classifyForCmark(code: number): number {
  return isCommonMarkWhitespace(code)
    ? WHITESPACE
    : CMARK_PUNCTUATION.test(String.fromCodePoint(code))
      ? PUNCTUATION
      : LETTER;
}

/** How CommonMark reads the code point `code` beside a marker. */
function classifyForCommonMark(code: number): number {
  return isCommonMarkWhitespace(code)
    ? WHITESPACE
    : COMMONMARK_PUNCTUATION.test(String.fromCodePoint(code))
      ? PUNCTUATION
      : LETTER;
}

/**
 * Whether a character reference to `code` reads as that character, so that
 * every reader reads the text as before: not a control character, a lone
 * surrogate or a noncharacter, which micromark reads as U+FFFD or which no
 * reader keeps.
 */
function hasLosslessReference(code: number): boolean {
  return (
    code > 31 &&
    (code < 127 || code > 159) &&
    (code < 0xd800 || code > 0xdfff) &&
    (code < 0xfdd0 || code > 0xfdef) &&
    (code & 0xfffe) !== 0xfffe
  );
}

/**
 * The class of `side` of `run` with `edits`, where a reference reads as
 * punctuation. `assignment` has a bit for each of `run.uncertain`: set, it
 * reads as punctuation, and clear, as a letter; -1 reads each as the host's
 * table does.
 */
function classifySide(
  run: MarkerRun,
  side: RunSide,
  edits: Edits,
  assignment = -1,
): number {
  if (side.offset < 0) {
    return WHITESPACE;
  }
  if (edits.has(side.offset)) {
    return PUNCTUATION;
  }
  const i = assignment < 0 ? -1 : run.uncertain.indexOf(side.offset);
  return i < 0
    ? side.characterClass
    : assignment & (1 << i)
      ? PUNCTUATION
      : LETTER;
}

/** What `run` opens and closes for between `sides`, as bits. */
function getFlags(
  run: MarkerRun,
  sides: readonly [RunSide, RunSide],
  edits: Edits,
  assignment = -1,
): number {
  const [open, close] = getRunFlanking(
    run.marker.charCodeAt(0),
    classifySide(run, sides[0], edits, assignment),
    classifySide(run, sides[1], edits, assignment),
  );
  return (open ? OPENS : 0) | (close ? CLOSES : 0);
}

/** What `run` needs and does not open or close for in cmark-gfm. */
function getMissing(run: MarkerRun, edits: Edits, assignment = -1): number {
  return run.needs & ~getFlags(run, run.cmark, edits, assignment);
}

/** Whether cmark-gfm reads `run` otherwise than micromark with `edits`. */
function isFailing(run: MarkerRun, edits: Edits): boolean {
  return getMissing(run, edits) !== 0;
}

/**
 * Whether `after` takes no flag from `run` that it needed and had with
 * `before`, however cmark-gfm reads the punctuation beside it that is newer
 * than its table. Where the subject also holds a literal marker of its
 * character, which another reader might pair with it, a run that did not
 * fail keeps both of its flags then too.
 */
function keepsFlags(run: MarkerRun, before: Edits, after: Edits): boolean {
  // Without such punctuation beside it, cmark-gfm reads it as modeled, and
  // fewer failing runs is all that is asked.
  const {length} = run.uncertain;
  if (length === 0) {
    return true;
  }
  for (let assignment = 0; assignment < 1 << length; assignment++) {
    const missed = getMissing(run, before, assignment);
    if (getMissing(run, after, assignment) & ~missed) {
      return false;
    }
    if (
      run.hasLiteral &&
      missed === 0 &&
      getFlags(run, run.cmark, before, assignment) !==
        getFlags(run, run.cmark, after, assignment)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether `run` keeps every flag it had with `before` with `after`: its
 * CommonMark flags, and, unless it failed already, its cmark-gfm flags
 * however cmark-gfm reads the punctuation beside it.
 */
function keepsEveryFlag(run: MarkerRun, before: Edits, after: Edits): boolean {
  if (
    getFlags(run, run.commonMark, before) !==
    getFlags(run, run.commonMark, after)
  ) {
    return false;
  }
  if (run.isMatched && isFailing(run, before)) {
    return true;
  }
  const {length} = run.uncertain;
  for (let assignment = 0; assignment < 1 << length; assignment++) {
    if (
      getFlags(run, run.cmark, before, assignment) !==
      getFlags(run, run.cmark, after, assignment)
    ) {
      return false;
    }
  }
  return true;
}

/** The offset where the code point that ends before `offset + 1` starts. */
function getCodePointStart(markdown: string, offset: number): number {
  return offset > 0 &&
    /[\udc00-\udfff]/.test(markdown[offset]) &&
    /[\ud800-\udbff]/.test(markdown[offset - 1])
    ? offset - 1
    : offset;
}

/**
 * What micromark reads in `events` of `markdown`: the document, and the
 * text of each subject, with each character reference as its character, so
 * that a text reads the same with or without one.
 */
function readForCmarkGfm(
  markdown: string,
  events: Event[],
): {document: string; subjects: string[]} {
  const parts: string[] = [];
  const subjects: string[] = [];
  let subject: string[] | null = null;
  let inReference = 0;
  for (let i = 0; i < events.length; i++) {
    const [kind, token] = events[i];
    const type: string = token.type;
    if (SUBJECT_TYPES.test(type)) {
      if (kind === 'enter') {
        subject = [];
      } else if (subject) {
        subjects.push(subject.join(''));
        subject = null;
      }
    }
    let part = '';
    if (type === 'characterReference') {
      inReference += kind === 'enter' ? 1 : -1;
      if (kind === 'enter') {
        const raw = markdown.slice(token.start.offset, token.end.offset);
        const match = NUMERIC_REFERENCE.exec(raw);
        const code = match
          ? match[1]
            ? parseInt(match[1], 16)
            : parseInt(match[2], 10)
          : -1;
        part =
          code <= 0x10ffff && hasLosslessReference(code)
            ? String.fromCodePoint(code)
            : raw;
      }
    } else if (inReference > 0) {
      continue;
    } else if (type === 'data') {
      if (kind === 'enter') {
        part = markdown.slice(token.start.offset, token.end.offset);
      }
    } else if (kind === 'enter') {
      // A token with nothing inside it, such as code, reads as it is.
      const next = events[i + 1];
      part =
        next && next[0] === 'exit' && next[1] === token
          ? `<${type}>${markdown.slice(token.start.offset, token.end.offset)}`
          : `<${type}>`;
    } else {
      part = `</${type}>`;
    }
    parts.push(part);
    if (subject && !SUBJECT_TYPES.test(type)) {
      subject.push(part);
    }
  }
  return {document: parts.join(''), subjects};
}

/** Adds `run` to the runs of `key` in `map`. */
function appendRun(
  map: Map<number, MarkerRun[]>,
  key: number,
  run: MarkerRun,
): void {
  const list = map.get(key);
  if (list) {
    list.push(run);
  } else {
    map.set(key, [run]);
  }
}

/**
 * Whether `after` gives `run` a flag that it lacks with `before` and that
 * its role in micromark's reading does not ask for: for CommonMark, or for
 * cmark-gfm however it reads the punctuation beside the run that is newer
 * than its table. A flag the run's role asks for pairs it with its own
 * partner, which is nearer than any pair that holds it. Where CommonMark
 * reads a symbol as punctuation, cmark-gfm reads it as a letter, so either
 * may gain a flag that the other does not.
 */
function gainsFlag(run: MarkerRun, before: Edits, after: Edits): boolean {
  if (
    getFlags(run, run.commonMark, after) &
    ~getFlags(run, run.commonMark, before) &
    ~run.needs
  ) {
    return true;
  }
  const {length} = run.uncertain;
  for (let assignment = 0; assignment < 1 << length; assignment++) {
    if (
      getFlags(run, run.cmark, after, assignment) &
      ~getFlags(run, run.cmark, before, assignment) &
      ~run.needs
    ) {
      return true;
    }
  }
  return false;
}

/** What {@link analyzeForCmarkGfm} finds in a document. */
interface CmarkAnalysis {
  readonly subjects: CmarkSubject[];
  /** The role of each character. */
  readonly roles: Uint8Array;
  /**
   * The characters that are not written as references: image labels, the
   * labels of shortcut and collapsed reference links, which are their
   * identifiers.
   */
  readonly excluded: Uint8Array;
  /** The runs that cmark-gfm reads each character beside. */
  readonly runsBeside: Map<number, MarkerRun[]>;
  /** The runs that cmark-gfm or CommonMark read each character beside. */
  readonly runsNear: Map<number, MarkerRun[]>;
  /** The pair that holds each pair, or -1. */
  readonly parentPairs: number[];
}

/**
 * The subjects of `events` of `markdown`, with the runs in them, the roles
 * of their characters and what the region check finds. `areCells` reads
 * every subject as a table cell.
 */
function analyzeForCmarkGfm(
  markdown: string,
  events: Event[],
  areCells: boolean,
): CmarkAnalysis {
  const {length} = markdown;
  const roles = new Uint8Array(length);
  const pairOf = new Int32Array(length).fill(-1);
  const excluded = new Uint8Array(length);
  // Each bracket that micromark reads as text or as a link label, but for
  // the label of an inline link (`[text](url)`), which a table cell
  // measured on its own reads as a link too. A bracket before it is counted
  // on its own. The label of an image starts at its `!`, so the `[` of an
  // image stays counted.
  const brackets = new Uint8Array(length);
  // The subject that micromark reads each `~`, `*`, `_` or backtick in as
  // syntax: a sequence, code, or an escaped character; or BLOCK_SYNTAX.
  const accountedIn = new Int32Array(length).fill(-1);
  const subjects: CmarkSubject[] = [];
  // The containers that hold the token at hand, and the innermost one that
  // holds each subject.
  const containers: [start: number, end: number][] = [];
  const containerOf: [start: number, end: number][] = [];
  const pairs: {id: number; seen: number}[] = [];
  const parentPairs: number[] = [];
  const links: {
    isImage: boolean;
    label: [start: number, end: number] | null;
    isInline: boolean;
    isFull: boolean;
  }[] = [];
  let pairCount = 0;
  let current = -1;
  for (const [kind, token] of events) {
    const type: string = token.type;
    const start = token.start.offset;
    const end = token.end.offset;
    if (kind === 'exit') {
      if (SUBJECT_TYPES.test(type)) {
        current = -1;
      } else if (PAIR_TYPES.test(type)) {
        pairs.pop();
      } else if (CONTAINER_TYPES.test(type)) {
        containers.pop();
      } else if (type === 'link' || type === 'image') {
        const link = links.pop()!;
        if (link.label && (link.isImage || !(link.isInline || link.isFull))) {
          excluded.fill(1, link.label[0], link.label[1]);
        }
        if (link.label && link.isInline) {
          brackets[link.label[0]] = 0;
          brackets[link.label[1] - 1] = 0;
        }
      }
      continue;
    }
    if (SUBJECT_TYPES.test(type)) {
      current = subjects.length;
      containerOf.push(
        containers.length > 0
          ? containers[containers.length - 1]
          : [0, markdown.length],
      );
      subjects.push({
        end,
        hasLooseBacktick: false,
        index: current,
        isCell: areCells || type === 'tableContent',
        looseMarkers: new Set(),
        runs: [],
        start,
      });
    } else if (PAIR_TYPES.test(type)) {
      parentPairs.push(pairs.length > 0 ? pairs[pairs.length - 1].id : -1);
      pairs.push({id: pairCount++, seen: 0});
    } else if (SEQUENCE_TYPES.test(type)) {
      const pair = pairs[pairs.length - 1];
      roles.fill(pair.seen++ ? CLOSER : OPENER, start, end);
      pairOf.fill(pair.id, start, end);
      accountedIn.fill(current, start, end);
    } else if (type === 'data' || type === 'labelMarker') {
      for (let i = start; i < end; i++) {
        if (type === 'data' && roles[i] === NO_ROLE) {
          roles[i] = DATA;
        }
        if (markdown[i] === '[' || markdown[i] === ']') {
          brackets[i] = 1;
        }
      }
    } else if (type === 'codeText') {
      accountedIn.fill(current, start, end);
    } else if (type === 'characterEscape') {
      accountedIn[end - 1] = current;
    } else if (PREFIX_TYPES.test(type)) {
      accountedIn.fill(BLOCK_SYNTAX, start, end);
    } else if (CONTAINER_TYPES.test(type)) {
      containers.push([start, end]);
    } else if (type === 'link' || type === 'image') {
      links.push({
        isFull: false,
        isImage: type === 'image',
        isInline: false,
        label: null,
      });
    } else if (links.length > 0) {
      const link = links[links.length - 1];
      if (type === 'label' && !link.label) {
        link.label = [start, end];
      } else if (type === 'resource') {
        link.isInline = true;
      } else if (type === 'referenceString') {
        link.isFull = true;
      }
    }
  }
  const runsBeside = new Map<number, MarkerRun[]>();
  const runsNear = new Map<number, MarkerRun[]>();
  let regions: RegionIndex | null = null;
  const index = (
    map: Map<number, MarkerRun[]>,
    offset: number,
    run: MarkerRun,
  ) => {
    if (offset >= 0) {
      appendRun(map, offset, run);
    }
  };
  for (const subject of subjects) {
    // A table cell measured on its own lacks the document's definitions, so
    // it may read a bracket as a link where the table does not, or the
    // other way, and pair its runs or leave them literal otherwise: a cell
    // with a bracket outside the label of an inline link is left as it is.
    if (
      subject.isCell &&
      brackets.subarray(subject.start, subject.end).includes(1)
    ) {
      continue;
    }
    const runs = collectRuns(markdown, subject, roles, pairOf);
    for (const run of runs) {
      if (run.isMatched) {
        subject.runs.push(run);
        for (const side of run.cmark) {
          index(runsBeside, side.offset, run);
        }
      }
      for (const side of [...run.cmark, ...run.commonMark]) {
        index(runsNear, side.offset, run);
      }
    }
    // Only a subject with a run that fails proposes an edit.
    if (subject.runs.some(run => isFailing(run, NO_EDITS))) {
      regions ||= indexRegions(markdown, accountedIn);
      checkRegion(
        markdown,
        subject,
        containerOf[subject.index],
        accountedIn,
        regions,
      );
    }
  }
  return {excluded, parentPairs, roles, runsBeside, runsNear, subjects};
}

/**
 * The runs of `subject`: each run of one marker that micromark reads as
 * opening or closing, with the literal markers in it, and each run of
 * literal markers on its own.
 */
function collectRuns(
  markdown: string,
  subject: CmarkSubject,
  roles: Uint8Array,
  pairOf: Int32Array,
): MarkerRun[] {
  const {start, end} = subject;
  const literals = new Set<string>();
  for (let i = start; i < end; i++) {
    if (roles[i] === DATA && /[*_~]/.test(markdown[i])) {
      literals.add(markdown[i]);
    }
  }
  const runs: MarkerRun[] = [];
  const addRun = (from: number, to: number, isMatched: boolean) => {
    const marker = markdown[from];
    let needs = 0;
    const pairs = new Set<number>();
    for (let i = from; i < to; i++) {
      needs |= roles[i] === OPENER ? OPENS : roles[i] === CLOSER ? CLOSES : 0;
      if (pairOf[i] >= 0) {
        pairs.add(pairOf[i]);
      }
    }
    // cmark-gfm skips a `~` run beside a `*` or `_` run.
    let before = from - 1;
    let after = to;
    if (marker !== '~') {
      while (before >= start && markdown[before] === '~') {
        before--;
      }
      while (after < end && markdown[after] === '~') {
        after++;
      }
    }
    const side = (offset: number, classify: (code: number) => number) =>
      offset < start || offset >= end
        ? {characterClass: WHITESPACE, offset: -1}
        : {
            characterClass: classify(markdown.codePointAt(offset)!),
            offset,
          };
    const cmark = [
      side(getCodePointStart(markdown, before), classifyForCmark),
      side(after, classifyForCmark),
    ] as const;
    const uncertain = cmark
      .filter(
        ({offset}) =>
          offset >= 0 &&
          markdown.charCodeAt(offset) > 127 &&
          UNICODE_PUNCTUATION_ONLY.test(
            String.fromCodePoint(markdown.codePointAt(offset)!),
          ),
      )
      .map(({offset}) => offset);
    runs.push({
      cmark,
      commonMark: [
        side(getCodePointStart(markdown, from - 1), classifyForCommonMark),
        side(to, classifyForCommonMark),
      ],
      end: to,
      hasLiteral: isMatched && literals.has(marker),
      isMatched,
      marker,
      needs,
      pairs: [...pairs],
      start: from,
      subject,
      uncertain,
    });
  };
  for (const isMatched of [true, false]) {
    for (let i = start; i < end; i++) {
      const marker = markdown[i];
      if (!/[*_~]/.test(marker) || roles[i] === NO_ROLE) {
        continue;
      }
      // A matched run holds the literal markers beside it, as cmark-gfm
      // reads the run whole; a literal run holds only literal ones.
      const isPart = (j: number) =>
        markdown[j] === marker &&
        (isMatched ? roles[j] !== NO_ROLE : roles[j] === DATA);
      let to = i;
      let hasRole = false;
      while (to < end && isPart(to)) {
        hasRole ||= roles[to] === OPENER || roles[to] === CLOSER;
        to++;
      }
      if (to > i && hasRole === isMatched) {
        addRun(i, to, isMatched);
      }
      i = Math.max(i, to - 1);
    }
  }
  return runs;
}

// The characters that the region check looks for.
const REGION_CHARACTERS = '*_~`';

/** What the region check reads of a document, for each subject to query. */
interface RegionIndex {
  /** Where each line starts, and where it ends, before its line ending. */
  readonly lineStarts: Int32Array;
  readonly lineEnds: Int32Array;
  /** The nearest blank line before and after each line, or -1 and the count. */
  readonly blankBefore: Int32Array;
  readonly blankAfter: Int32Array;
  /**
   * For each of {@link REGION_CHARACTERS}, how many are before each offset
   * that micromark does not read as block syntax.
   */
  readonly counts: Int32Array[];
}

/** The lines of `markdown` and its counts of region characters, read once. */
function indexRegions(markdown: string, accountedIn: Int32Array): RegionIndex {
  const starts = [0];
  for (
    let i = markdown.indexOf('\n');
    i >= 0;
    i = markdown.indexOf('\n', i + 1)
  ) {
    starts.push(i + 1);
  }
  const lineCount = starts.length;
  const lineStarts = Int32Array.from(starts);
  const lineEnds = new Int32Array(lineCount);
  const blankBefore = new Int32Array(lineCount);
  const blankAfter = new Int32Array(lineCount);
  const isBlank = new Uint8Array(lineCount);
  for (let line = 0; line < lineCount; line++) {
    lineEnds[line] =
      line + 1 < lineCount ? lineStarts[line + 1] - 1 : markdown.length;
    isBlank[line] = Number(
      /^[ \t>]*$/.test(markdown.slice(lineStarts[line], lineEnds[line])),
    );
  }
  for (let line = 0, last = -1; line < lineCount; line++) {
    blankBefore[line] = last;
    if (isBlank[line]) {
      last = line;
    }
  }
  for (let line = lineCount - 1, next = lineCount; line >= 0; line--) {
    blankAfter[line] = next;
    if (isBlank[line]) {
      next = line;
    }
  }
  const counts = [...REGION_CHARACTERS].map(character => {
    const count = new Int32Array(markdown.length + 1);
    for (let i = 0; i < markdown.length; i++) {
      count[i + 1] =
        count[i] +
        Number(markdown[i] === character && accountedIn[i] !== BLOCK_SYNTAX);
    }
    return count;
  });
  return {blankAfter, blankBefore, counts, lineEnds, lineStarts};
}

/** The first index of `sorted` whose value is more than `value`. */
function upperBound(sorted: Int32Array, value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * The region check: other readers may read the lines of `subject`, and the
 * lines touching them in `container`, otherwise than micromark, as text
 * where micromark reads a definition, raw HTML or a link destination, so a
 * marker or a backtick there that micromark does not read as syntax inside
 * `subject` is one they might pair across. A table cell, which readers parse
 * on its own, is its own region. The list item and quote prefixes and the
 * thematic breaks that micromark reads count as syntax: CommonMark readers
 * split blocks so alike.
 */
function checkRegion(
  markdown: string,
  subject: CmarkSubject,
  [low, high]: readonly [start: number, end: number],
  accountedIn: Int32Array,
  regions: RegionIndex,
): void {
  let from = subject.start;
  let to = subject.end;
  if (!subject.isCell) {
    const {blankAfter, blankBefore, lineEnds, lineStarts} = regions;
    // The lines of the subject, and those above and below it up to a blank
    // line or the edge of its container.
    const first = upperBound(lineStarts, subject.start) - 1;
    const last =
      upperBound(lineStarts, Math.max(subject.start, subject.end - 1)) - 1;
    const top = Math.min(
      first,
      Math.max(blankBefore[first] + 1, upperBound(lineStarts, low - 1)),
    );
    const bottom = Math.max(
      last,
      Math.min(blankAfter[last] - 1, upperBound(lineEnds, high) - 1),
    );
    from = lineStarts[top];
    to = lineEnds[bottom];
  }
  // Those that micromark reads as syntax of the subject are in it.
  const own = [...REGION_CHARACTERS].map(() => 0);
  for (let i = subject.start; i < subject.end; i++) {
    if (accountedIn[i] === subject.index) {
      const kind = REGION_CHARACTERS.indexOf(markdown[i]);
      if (kind >= 0) {
        own[kind]++;
      }
    }
  }
  regions.counts.forEach((count, kind) => {
    if (count[to] - count[from] > own[kind]) {
      const character = REGION_CHARACTERS[kind];
      if (character === '`') {
        subject.hasLooseBacktick = true;
      } else {
        subject.looseMarkers.add(character);
      }
    }
  });
}

/** `markdown` with the character at each offset of `edits` as a reference. */
function writeReferences(markdown: string, edits: Iterable<number>): string {
  let out = '';
  let last = 0;
  for (const offset of [...edits].sort((a, b) => a - b)) {
    const code = markdown.codePointAt(offset)!;
    out += `${markdown.slice(last, offset)}&#x${code.toString(16).toUpperCase()};`;
    last = offset + (code > 0xffff ? 2 : 1);
  }
  return out + markdown.slice(last);
}

/** Where {@link toCmarkGfmCompatible} is in its search for a subject. */
interface SubjectSearch {
  readonly subject: CmarkSubject;
  /** The edits accepted. */
  edits: Set<number>;
  /** The edits a pair restart goes back to. */
  start: Set<number>;
  /** The pairs that are not repaired, as one member of one cannot be. */
  readonly blocked: Set<number>;
  /** The attempts left, or null to list them again. */
  attempts: number[][] | null;
  /** The groups of attempts to propose, the first next. */
  groups: number[][][];
  /** Whether a group of those was accepted. */
  hasAccepted: boolean;
  isDone: boolean;
}

/**
 * The strict export `markdown` as cmark-gfm (0.29.0.gfm.14, which GitHub
 * reads Markdown with) reads it as micromark does, where the search below
 * finds how. cmark-gfm differs from CommonMark in two ways beside a marker:
 * it skips a `~` run beside a `*` or `_` run and reads the character beyond
 * it, and it reads a symbol of the Basic Multilingual Plane as a letter
 * (``~~a~~*`b`*``, `©_a_`). Where a run would not open or close in cmark-gfm
 * as it does in micromark, a character that cmark-gfm reads beside it goes
 * out as a reference (``~~&#x61;~~*`b`*``, `&#xA9;_a_`), which every reader
 * reads as punctuation and as that character.
 *
 * The search reads `markdown` with `extensions`, the strict import's, and
 * models cmark-gfm on each run. For a run that fails, it tries, in order, a
 * character beside it, both, and one with another beside a run that the
 * first touches or makes fail, at most two references in all. It keeps an
 * attempt that leaves micromark's reading of the subject as it is, makes
 * fewer runs fail, takes no flag a run needed however cmark-gfm's older
 * Unicode table reads punctuation, and passes the region check and the word
 * guard; the opener and closer of a pair are repaired together or not at
 * all. Subjects are searched together: each proposes its edits, which one
 * parse checks, and a subject whose proposal changes its reading tries each
 * half of it later, so the parses stay few. A document that micromark reads
 * otherwise after all is returned as it is. `areCells` reads each subject
 * as a table cell, which a table measures its cells as.
 */
function toCmarkGfmCompatible(
  markdown: string,
  extensions: MicromarkExtension[],
  areCells = false,
): string {
  if (!CMARK_GFM_GATE.test(markdown)) {
    return markdown;
  }
  const events = parseEvents(markdown, extensions);
  const {excluded, parentPairs, roles, runsBeside, runsNear, subjects} =
    analyzeForCmarkGfm(markdown, events, areCells);
  const searches: SubjectSearch[] = subjects
    .filter(subject => subject.runs.some(run => isFailing(run, NO_EDITS)))
    .map(subject => ({
      attempts: null,
      blocked: new Set(),
      edits: new Set(),
      groups: [],
      hasAccepted: false,
      isDone: false,
      start: new Set(),
      subject,
    }));
  if (searches.length === 0) {
    return markdown;
  }
  const base = readForCmarkGfm(markdown, events);
  // The last text parsed and how micromark reads it as a document, which
  // the final check takes as it is when the edits it checks are those.
  let lastParsed = markdown;
  let lastDocument = base.document;
  // Whether micromark reads a subject as before with `edits`, all in one
  // parse.
  const readsAsBefore = (edits: number[]) => {
    const edited = writeReferences(markdown, edits);
    const {document, subjects: read} = readForCmarkGfm(
      edited,
      parseEvents(edited, extensions),
    );
    lastParsed = edited;
    lastDocument = document;
    return (subject: CmarkSubject) =>
      read.length === base.subjects.length &&
      read[subject.index] === base.subjects[subject.index];
  };

  // The word guard: linkify-it may start a link from the word that holds a
  // character, which a reference in it would end. A table cell bounds the
  // word, as it bounds the text another reader links in. Each run of
  // characters between word breaks is read once, with whether it has a link
  // shape; a candidate that is a break itself joins the runs beside it.
  let wordStarts: Int32Array | null = null;
  let wordEnds: Int32Array | null = null;
  const shapes = new Map<number, boolean>();
  const getWord = (subject: CmarkSubject, offset: number) => {
    wordStarts ||= new Int32Array(markdown.length).fill(-1);
    wordEnds ||= new Int32Array(markdown.length);
    if (wordStarts[offset] < 0) {
      const low = subject.isCell ? subject.start : 0;
      const high = subject.isCell ? subject.end : markdown.length;
      let from = offset;
      let to = offset + 1;
      while (from > low && !WORD_BREAK.test(markdown[from - 1])) {
        from--;
      }
      while (to < high && !WORD_BREAK.test(markdown[to])) {
        to++;
      }
      wordStarts.fill(from, from, to);
      wordEnds.fill(to, from, to);
    }
    return [wordStarts[offset], wordEnds[offset]];
  };
  const isInLinkShape = (subject: CmarkSubject, offset: number) => {
    if (!WORD_BREAK.test(markdown[offset])) {
      const [from, to] = getWord(subject, offset);
      let found = shapes.get(from);
      if (found === undefined) {
        found = LINK_SHAPE.test(markdown.slice(from, to));
        shapes.set(from, found);
      }
      return found;
    }
    const low = subject.isCell ? subject.start : 0;
    const high = subject.isCell ? subject.end : markdown.length;
    const isWord = (i: number) =>
      i >= low && i < high && !WORD_BREAK.test(markdown[i]);
    const from = isWord(offset - 1) ? getWord(subject, offset - 1)[0] : offset;
    const to = isWord(offset + 1)
      ? getWord(subject, offset + 1)[1]
      : offset + 1;
    return LINK_SHAPE.test(markdown.slice(from, to));
  };
  // cmark-gfm's bare URLs, which take a reference in them as text: each run
  // of characters between URL breaks is read once, with where the first URL
  // in it starts, which takes the rest of the run. A table cell bounds the
  // run, as cmark-gfm reads each cell on its own.
  let urlStarts: Int32Array | null = null;
  const urls = new Map<number, number>();
  const isInCmarkUrl = (subject: CmarkSubject, offset: number) => {
    if (CMARK_URL_BREAK.test(markdown[offset])) {
      return false;
    }
    urlStarts ||= new Int32Array(markdown.length).fill(-1);
    if (urlStarts[offset] < 0) {
      const low = subject.isCell ? subject.start : 0;
      const high = subject.isCell ? subject.end : markdown.length;
      let from = offset;
      let to = offset + 1;
      while (from > low && !CMARK_URL_BREAK.test(markdown[from - 1])) {
        from--;
      }
      while (to < high && !CMARK_URL_BREAK.test(markdown[to])) {
        to++;
      }
      urlStarts.fill(from, from, to);
      const first = CMARK_URL_START.exec(markdown.slice(from, to));
      urls.set(
        from,
        first ? from + first.index + (first[1] ?? first[2]).length : Infinity,
      );
    }
    return urls.get(urlStarts[offset])! <= offset;
  };
  const isEligible = (subject: CmarkSubject, offset: number, edits: Edits) => {
    if (
      offset < subject.start ||
      offset >= subject.end ||
      roles[offset] !== DATA ||
      excluded[offset] ||
      edits.has(offset)
    ) {
      return false;
    }
    const code = markdown.codePointAt(offset)!;
    return (
      hasLosslessReference(code) &&
      (ASCII_PUNCTUATION.test(String.fromCodePoint(code)) ||
        !isInLinkShape(subject, offset)) &&
      !isInCmarkUrl(subject, offset)
    );
  };

  const isBlocked = (search: SubjectSearch, run: MarkerRun) =>
    run.pairs.some(pair => search.blocked.has(pair));
  const runsAt = (
    map: Map<number, MarkerRun[]>,
    subject: CmarkSubject,
    offsets: readonly number[],
  ) => {
    const runs = new Set<MarkerRun>();
    for (const offset of offsets) {
      for (const run of map.get(offset) || []) {
        if (run.subject === subject) {
          runs.add(run);
        }
      }
    }
    return runs;
  };
  // The runs of each pair.
  const members = new Map<number, MarkerRun[]>();
  for (const {subject} of searches) {
    for (const run of subject.runs) {
      for (const pair of run.pairs) {
        appendRun(members, pair, run);
      }
    }
  }
  // Whether a matched `~` run that reads an edited character gains a flag
  // that may pair it with an enclosing `~` run of its length: micromark
  // keeps the pairs it read, but markdown-it and cmark-gfm may close the
  // enclosing run on it, or open it there (`*&*~~*~~a~~_a_* a~~` for both,
  // `*&*~~*~~©~~_©_* ©~~` for cmark-gfm alone).
  const pairsAcross = (
    subject: CmarkSubject,
    added: readonly number[],
    before: Edits,
    after: Edits,
  ) => {
    for (const run of runsAt(runsNear, subject, added)) {
      if (
        run.marker !== '~' ||
        !run.isMatched ||
        !gainsFlag(run, before, after)
      ) {
        continue;
      }
      // Pairs nest, so the pairs that hold the run are those that hold its
      // own. Which flag it gains, and which run of the enclosing pair it
      // would pair with, are not read: the two runs of a `~` pair have the
      // same length, so either run stands for the pair.
      const size = run.end - run.start;
      const seen = new Set<number>();
      for (const own of run.pairs) {
        for (
          let pair = parentPairs[own];
          pair >= 0 && !seen.has(pair);
          pair = parentPairs[pair]
        ) {
          seen.add(pair);
          const [opener] = members.get(pair)!;
          if (opener.marker === '~' && opener.end - opener.start === size) {
            return true;
          }
        }
      }
    }
    return false;
  };

  // Whether adding `added` to `before` passes the model: fewer runs that
  // read an edited character fail, no flag is lost, and the region check
  // passes.
  const passesModel = (
    search: SubjectSearch,
    before: Edits,
    added: readonly number[],
  ) => {
    const {subject} = search;
    const after = withEdits(before, added);
    const affected = runsAt(runsBeside, subject, added);
    let change = 0;
    for (const run of affected) {
      if (!isBlocked(search, run)) {
        change +=
          Number(isFailing(run, after)) - Number(isFailing(run, before));
      }
    }
    if (change >= 0) {
      return false;
    }
    for (const run of affected) {
      if (!keepsFlags(run, before, after)) {
        return false;
      }
    }
    if (subject.hasLooseBacktick) {
      return false;
    }
    if (subject.looseMarkers.size > 0) {
      for (const run of runsAt(runsNear, subject, added)) {
        if (
          subject.looseMarkers.has(run.marker) &&
          !keepsEveryFlag(run, before, after)
        ) {
          return false;
        }
      }
    }
    return !pairsAcross(subject, added, before, after);
  };
  // The pairs with a member that `edits` repairs and a member that still
  // fails, which cannot be repaired.
  const getPartialPairs = (search: SubjectSearch, edits: Edits) => {
    const partial = new Set<number>();
    for (const run of search.subject.runs) {
      if (!isFailing(run, edits)) {
        continue;
      }
      for (const pair of run.pairs) {
        if (
          !search.blocked.has(pair) &&
          members
            .get(pair)!
            .some(
              other =>
                isFailing(other, search.start) && !isFailing(other, edits),
            )
        ) {
          partial.add(pair);
        }
      }
    }
    return partial;
  };

  // First, the first character beside each failing run that repairs it,
  // for every subject, checked in one parse.
  const batches = new Map<SubjectSearch, Set<number>>();
  for (const search of searches) {
    const edits = new Set<number>();
    for (const run of search.subject.runs) {
      if (!isFailing(run, edits)) {
        continue;
      }
      for (const {offset} of run.cmark) {
        if (
          isEligible(search.subject, offset, edits) &&
          !isFailing(run, withEdits(edits, [offset])) &&
          passesModel(search, edits, [offset])
        ) {
          edits.add(offset);
          break;
        }
      }
    }
    if (edits.size > 0 && getPartialPairs(search, edits).size === 0) {
      batches.set(search, edits);
    }
  }
  if (batches.size > 0) {
    const isKept = readsAsBefore(
      [...batches.values()].flatMap(edits => [...edits]),
    );
    for (const [search, edits] of batches) {
      if (isKept(search.subject)) {
        search.edits = edits;
        search.start = new Set(edits);
      }
    }
  }

  // The attempts for the runs of `search` that still fail.
  const listAttempts = (search: SubjectSearch): number[][] => {
    const {subject, edits} = search;
    const attempts: number[][] = [];
    const runs = subject.runs.filter(
      run => !isBlocked(search, run) && isFailing(run, edits),
    );
    for (const run of runs) {
      const sides = run.cmark
        .map(({offset}) => offset)
        .filter(offset => isEligible(subject, offset, edits));
      for (const offset of sides) {
        if (passesModel(search, edits, [offset])) {
          attempts.push([offset]);
        }
      }
      if (
        sides.length === 2 &&
        sides[0] !== sides[1] &&
        passesModel(search, edits, sides)
      ) {
        attempts.push(sides);
      }
      // With a supporting reference beside a run that the first touches,
      // or that the first makes fail.
      for (const offset of sides) {
        for (const other of runsAt(runsBeside, subject, [offset])) {
          if (other === run) {
            continue;
          }
          for (const side of other.cmark) {
            if (
              side.offset !== offset &&
              isEligible(subject, side.offset, edits) &&
              passesModel(search, edits, [offset, side.offset])
            ) {
              attempts.push([offset, side.offset]);
            }
          }
        }
      }
    }
    return attempts;
  };
  // Of `attempts`, those that pass the model together on `search`'s edits.
  const group = (search: SubjectSearch, attempts: readonly number[][]) => {
    const kept: number[][] = [];
    const current = new Set(search.edits);
    for (const attempt of attempts) {
      if (
        attempt.every(offset => isEligible(search.subject, offset, current)) &&
        passesModel(search, current, attempt)
      ) {
        kept.push(attempt);
        for (const offset of attempt) {
          current.add(offset);
        }
      }
    }
    return kept;
  };

  // Then rounds: each subject that still fails proposes a group of its
  // attempts, and one parse checks every proposal.
  for (;;) {
    const proposals: [SubjectSearch, number[][]][] = [];
    let pending = searches;
    while (pending.length > 0) {
      const again: SubjectSearch[] = [];
      for (const search of pending) {
        if (search.isDone) {
          continue;
        }
        if (search.attempts === null) {
          search.attempts = listAttempts(search);
        }
        if (search.attempts.length === 0) {
          const partial = getPartialPairs(search, search.edits);
          if (partial.size === 0) {
            search.isDone = true;
            continue;
          }
          // Block the pairs and search again from the batch, which
          // repairs no member of one alone.
          for (const pair of partial) {
            search.blocked.add(pair);
          }
          search.edits = new Set(search.start);
          search.attempts = null;
          again.push(search);
          continue;
        }
        if (search.groups.length === 0) {
          search.groups = [group(search, search.attempts)];
          search.hasAccepted = false;
        }
        const proposal = group(search, search.groups[0]);
        if (proposal.length === 0) {
          search.groups.shift();
          if (search.groups.length === 0) {
            search.attempts = search.hasAccepted ? null : [];
          }
          again.push(search);
          continue;
        }
        search.groups[0] = proposal;
        proposals.push([search, proposal]);
      }
      pending = again;
    }
    if (proposals.length === 0) {
      break;
    }
    const isKept = readsAsBefore([
      ...searches.flatMap(search => [...search.edits]),
      ...proposals.flatMap(([, proposal]) => proposal.flat()),
    ]);
    for (const [search, proposal] of proposals) {
      if (isKept(search.subject)) {
        for (const offset of proposal.flat()) {
          search.edits.add(offset);
        }
        search.hasAccepted = true;
        search.groups.shift();
      } else if (proposal.length > 1) {
        const half = proposal.length >> 1;
        search.groups.splice(
          0,
          1,
          proposal.slice(0, half),
          proposal.slice(half),
        );
      } else {
        search.groups.shift();
      }
      if (search.groups.length === 0) {
        search.attempts = search.hasAccepted ? null : [];
      }
    }
  }
  const out = writeReferences(
    markdown,
    searches.flatMap(search => [...search.edits]),
  );
  if (out === markdown) {
    return markdown;
  }
  if (out !== lastParsed) {
    lastDocument = readForCmarkGfm(out, parseEvents(out, extensions)).document;
  }
  return lastDocument === base.document ? out : markdown;
}

/**
 * The cells of a table as {@link toCmarkGfmCompatible} writes them in the
 * table, for measuring: each as a paragraph of its own behind a letter and a
 * space, all in one parse, read as table cells.
 */
function toCmarkGfmCompatibleCells(
  values: string[],
  extensions: MicromarkExtension[],
): string[] {
  return values.some(value => CMARK_GFM_GATE.test(value))
    ? toCmarkGfmCompatible(
        values.map(value => `a ${value}`).join('\n\n'),
        extensions,
        true,
      )
        .split('\n\n')
        .map(value => value.slice(2))
    : values;
}

/**
 * Picks the document-level emphasis and strong delimiters, scanning the tree
 * rooted at `node`: `_` when any italic / bold text node recorded `_` on
 * import, otherwise to-markdown's default. Mixing delimiters within one
 * document is not supported by to-markdown's escaping, so a single choice is
 * made per document.
 */
function $dominantInlineMarkers(node: ElementNode): {
  emphasis: '*' | '_' | undefined;
  strong: '*' | '_' | undefined;
} {
  let emphasis: '*' | '_' | undefined;
  let strong: '*' | '_' | undefined;
  const visit = (element: ElementNode): void => {
    for (const child of element.getChildren()) {
      if ($isTextNode(child)) {
        if (emphasis === undefined && child.hasFormat('italic')) {
          const marker = $getState(child, emphasisMarkerState);
          if (marker === '_') {
            emphasis = '_';
          }
        }
        if (strong === undefined && child.hasFormat('bold')) {
          const marker = $getState(child, strongMarkerState);
          if (marker === '_') {
            strong = '_';
          }
        }
      } else if ($isElementNode(child)) {
        visit(child);
      }
      if (emphasis !== undefined && strong !== undefined) {
        return;
      }
    }
  };
  visit(node);
  return {emphasis, strong};
}

/**
 * Render context state carrying the {@link BaseSelection} being serialized
 * during a selection export (`$convertSelectionToMarkdownString`); `null`
 * outside one. It stays set for any export a handler runs inside a selection
 * export, where `context.selection` is `null`. The export runs synchronously
 * inside the editor read, so registered export rules and contributed
 * to-markdown handlers can read it with `$getRenderContextValue` — e.g. a
 * `root` handler that appends end-of-document data (footnote definitions,
 * comments) can emit everything for a document export but only the
 * selection-referenced subset for a clipboard copy.
 */
export const RenderContextMarkdownSelection = createRenderState(
  'markdownSelection',
  (): BaseSelection | null => null,
);

// A string parsed for the literal checks: the URL of the link it is when it
// is a literal alone, and the keys of the links it holds.
interface ParsedLinks {
  readonly keys: readonly string[];
  readonly url: string | null;
}

/**
 * Creates a reusable exporter that converts the Lexical tree rooted at the
 * supplied element (or the editor root) — or just the selected content —
 * into a Markdown string.
 */
export function createMdastExport(compiled: CompiledMdast): {
  $exportToMdast: (node?: ElementNode) => Root;
  $exportToMarkdown: (node?: ElementNode) => string;
  $exportSelectionToMarkdown: (selection?: BaseSelection | null) => string;
} {
  // The unfiltered exporter has no per-call state and is shared by every
  // whole-document export; selection exports build a fresh one per call.
  const documentExporter = createNodeExporter(compiled);
  // How touching deletes are joined, by the handlers that write them: the
  // same for the blocks of a subtree or selection export and for the tree
  // the serializer writes.
  const deleteJoin = getDeleteJoin(compiled.toMarkdownExtensions);
  let parsedLinks = new Map<string, ParsedLinks>();
  // The containers that subtree and selection exports read, which they do
  // not add to parsedLinks: only a document export prunes that. Each block
  // such an export writes (or its root, for a container outside them) keeps
  // the containers its latest export read, so an edited block's old versions
  // go. Removed blocks are dropped by a document export, and whenever there
  // are more than twice as many blocks as the last time they were checked.
  const partLinks = new Map<string, ParsedLinks>();
  const partBlocks = new Map<string, ReadonlySet<string>>();
  let checkBlocksAt = 0;

  const parse = (markdown: string): ParsedLinks => {
    const doc = fromMarkdown(markdown, {
      extensions: compiled.micromarkExtensions,
      mdastExtensions: compiled.mdastExtensions,
    });
    const paragraph = doc.children[0];
    const literal =
      doc.children.length === 1 &&
      paragraph.type === 'paragraph' &&
      paragraph.children.length === 1
        ? paragraph.children[0]
        : null;
    return {
      keys: collectLinks(doc).map(linkKey),
      url:
        literal !== null &&
        literal.type === 'link' &&
        mdastToString(literal) === markdown
          ? literal.url
          : null,
    };
  };

  const readPart = (markdown: string): ParsedLinks => {
    let parsed = partLinks.get(markdown) || parsedLinks.get(markdown);
    if (parsed === undefined) {
      parsed = parse(markdown);
      partLinks.set(markdown, parsed);
    }
    return parsed;
  };

  const dropContainers = (
    containers: ReadonlySet<string>,
    kept?: ReadonlySet<string>,
  ): void => {
    for (const markdown of containers) {
      if (!(kept && kept.has(markdown))) {
        partLinks.delete(markdown);
      }
    }
  };

  // A block that the state being exported lacks, or that the update which
  // exports it has detached, counts as removed.
  const $dropRemovedBlocks = (): void => {
    for (const [key, containers] of partBlocks) {
      const block = $getNodeByKey(key);
      if (block === null || !block.isAttached()) {
        partBlocks.delete(key);
        dropContainers(containers);
      }
    }
    checkBlocksAt = partBlocks.size * 2;
  };

  // The containers that the export in progress reads, by block, with any
  // it runs; the blocks it writes; and how deep in exports that is.
  const partRead = new Map<string, Set<string>>();
  const partWritten = new Set<string>();
  let depth = 0;

  // Kept once the outermost export is done, or has thrown: an export that a
  // rule or a handler runs while another is built or written must not drop
  // what the outer one read.
  const $exporting = (
    isDocumentExport: boolean,
    write: () => string,
  ): string => {
    depth++;
    try {
      return write();
    } finally {
      depth--;
      if (depth === 0) {
        const read = new Set([...partRead.values()].flatMap(set => [...set]));
        for (const key of partWritten) {
          const previous = partBlocks.get(key);
          const containers = partRead.get(key);
          if (containers) {
            partBlocks.set(key, containers);
          } else {
            partBlocks.delete(key);
          }
          if (previous) {
            dropContainers(previous, read);
          }
        }
        partRead.clear();
        partWritten.clear();
      }
      if (isDocumentExport || partBlocks.size > checkBlocksAt) {
        $dropRemovedBlocks();
      }
    }
  };

  // The key of the block child of the export root that each top-level mdast
  // node of a subtree or selection export was written for.
  const blockOf = new WeakMap<object, string>();

  const $toMdast = (
    root: ElementNode,
    exporter: ReturnType<typeof createNodeExporter>,
    isPartExport = false,
  ): Root => {
    if (!isPartExport) {
      // The registry erases types; root-level output is the dispatch
      // contract for top-level children.
      return {
        children: exporter.exportChildren(root) as RootContent[],
        type: 'root',
      };
    }
    // One child at a time, which the exporter writes on its own too, so that
    // the nodes written for each block are known. The root keeps what is
    // written outside them.
    partWritten.add(root.getKey());
    // Each block's nodes are joined here as the serializer joins them, before
    // they are marked for the block. The serializer then leaves them as they
    // are, so they stay marked, and only joins output that spans blocks into
    // a new node, which the root keeps.
    const children: RootContent[] = [];
    for (const child of root.getChildren()) {
      const isBlock = $isBlockLevelNode(child);
      const written = exporter.exportChildren([child]) as RootContent[];
      const nodes = isBlock
        ? joinForMarkdown<Root>({children: written, type: 'root'}, deleteJoin)
            .children
        : written;
      for (const node of nodes) {
        if (isBlock) {
          blockOf.set(node, child.getKey());
          partWritten.add(child.getKey());
        }
        children.push(node);
      }
    }
    return {children, type: 'root'};
  };

  const $serialize = (
    tree: Root,
    root: ElementNode,
    isDocumentExport: boolean,
  ): string => {
    const nextParsedLinks = isDocumentExport
      ? new Map<string, ParsedLinks>()
      : parsedLinks;
    // The block that a container read now is kept for: the child of the
    // tree being written, or the root outside its children.
    let block = root.getKey();
    // One parse of each string serves both checks.
    const read = (markdown: string, isContainer = false): ParsedLinks => {
      if (isContainer && !isDocumentExport) {
        const parsed = readPart(markdown);
        partRead.set(block, (partRead.get(block) || new Set()).add(markdown));
        return parsed;
      }
      let parsed = parsedLinks.get(markdown);
      if (parsed === undefined) {
        parsed = parse(markdown);
        parsedLinks.set(markdown, parsed);
      }
      nextParsedLinks.set(markdown, parsed);
      return parsed;
    };
    const getLiteralUrl = (text: string): string | null => read(text).url;
    // A container is read as the export writes it, with the references a
    // CJK-friendly export writes as their characters.
    const isCjkFriendly = compiled.exportPunctuation === 'cjk-friendly';
    // A strict export is written for cmark-gfm too, with the strict
    // import's syntax; a registry compiled elsewhere has none, and is not.
    const strictSyntax = isCjkFriendly
      ? null
      : getStrictMicromarkExtensions(compiled);
    const getLinkKeys = (markdown: string): readonly string[] =>
      read(isCjkFriendly ? toCjkFriendly(markdown, compiled) : markdown, true)
        .keys;
    // Emphasis/strong delimiters are document-level: `_` when one was
    // recorded on import, unless contributed toMarkdownExtensions set them.
    // Defaults (with the '-' bullet baseline) ride as the FIRST extension so
    // that contributed extensions can override them; the syntax extension
    // runs last so its handlers reproduce the per-node syntax captured on
    // import.
    const {emphasis, strong} = $dominantInlineMarkers(root);
    const defaults: ToMarkdownExtension = {bullet: '-'};
    if (emphasis) {
      defaults.emphasis = emphasis;
    }
    if (strong) {
      defaults.strong = strong;
    }
    const extensions = [defaults, ...compiled.toMarkdownExtensions];
    const rootHandler = getHandlers(extensions).root;
    // Each child the root writes, or that a handler writes in its place,
    // sets the block of what is read while it is written, so that a container
    // a handler or a table copies inside it is read for that block. A node
    // that is not marked for a block this export writes leaves the block as
    // it is, so a root handler that writes copies of the root's children, or
    // replaces state.handle, reads everything for the root. The wrapper keeps
    // the handlers that peeking looks up on it, and passes `this` on.
    const writeRoot: Handle = function (
      this: unknown,
      node,
      parent,
      state,
      info,
    ) {
      const handle = state.handle;
      state.handle = Object.assign(function (
        this: unknown,
        ...args: Parameters<Handle>
      ) {
        const key = blockOf.get(args[0]);
        if (key === undefined || !partWritten.has(key)) {
          return handle.apply(this, args);
        }
        const previous = block;
        block = key;
        try {
          return handle.apply(this, args);
        } finally {
          block = previous;
        }
      }, handle);
      return rootHandler.call(this, node, parent, state, info);
    };
    // Breaks are collected from the tree as it is written: joining deletes
    // can drop an empty text that stood between two breaks.
    const joined = joinForMarkdown(tree, deleteJoin);
    extensions.push(
      syntaxToMarkdown(
        collectHardBreaks(joined),
        checkLiterals(getLiteralUrl, getLinkKeys, writeRoot),
      ),
    );
    // toMarkdown always appends a trailing newline; drop it so callers get the
    // same shape as `@lexical/markdown`'s `$convertToMarkdownString`.
    // A CJK-friendly export writes some references as their characters after
    // a table is aligned, and a strict one writes some characters as
    // references for cmark-gfm, so each measures every cell as such.
    const markdown = toMarkdownWithStandIns(
      joined,
      extensions,
      isCjkFriendly,
      // Measured in one parse, each as a paragraph of its own behind a
      // letter and a space, as it stands behind `| ` in its row, so that it
      // reads as inline text there too and not as a block of its own, such
      // as an HTML block or a definition.
      isCjkFriendly
        ? values =>
            values.some(value => value.includes('&#'))
              ? toCjkFriendly(
                  values.map(value => `a ${value}`).join('\n\n'),
                  compiled,
                )
                  .split('\n\n')
                  .map(value => value.slice(2))
              : values
        : strictSyntax
          ? values => toCmarkGfmCompatibleCells(values, strictSyntax)
          : undefined,
    ).replace(/\n$/, '');
    if (isDocumentExport) {
      parsedLinks = nextParsedLinks;
    }
    return isCjkFriendly
      ? toCjkFriendly(markdown, compiled)
      : strictSyntax
        ? toCmarkGfmCompatible(markdown, strictSyntax)
        : markdown;
  };

  const $exportToMdast = (node?: ElementNode): Root =>
    $toMdast(node || $getRoot(), documentExporter);

  const $exportToMarkdown = (node?: ElementNode): string => {
    const root = node || $getRoot();
    const isDocumentExport = $isRootNode(root);
    return $exporting(isDocumentExport, () =>
      $serialize(
        $toMdast(root, documentExporter, !isDocumentExport),
        root,
        isDocumentExport,
      ),
    );
  };

  const $exportSelectionToMarkdown = (
    selection: BaseSelection | null = $getSelection(),
  ): string => {
    if (
      selection === null ||
      ($isRangeSelection(selection) && selection.isCollapsed())
    ) {
      return '';
    }
    const root = $getRoot();
    // The whole export — the tree-building walk and the toMarkdown
    // serialization — runs under a render context carrying the selection,
    // so export rules and contributed to-markdown handlers can scope their
    // output to a selection export.
    return $withRenderContext([
      contextValue(RenderContextMarkdownSelection, selection),
    ])(() =>
      $exporting(false, () =>
        $serialize(
          $toMdast(root, createNodeExporter(compiled, selection), true),
          root,
          false,
        ),
      ),
    );
  };

  return {$exportSelectionToMarkdown, $exportToMarkdown, $exportToMdast};
}
