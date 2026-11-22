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
import {isReferenceAgnostic} from './compile';
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
  // when rebuilding the formatting containers.
  if (
    Object.keys(node).some(
      key => key !== 'type' && key !== 'value' && key !== 'children',
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
  exported: Root,
  extensions: ToMarkdownExtension[],
  isCjkFriendly: boolean,
  measure?: (values: string[]) => string[],
): string {
  const tree = joinAdjacentText(exported);
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
    if (
      isCjk ||
      (characterClass === LETTER &&
        code > 31 &&
        (code < 127 || code > 159) &&
        (code < 0xd800 || code > 0xdfff) &&
        (code < 0xfdd0 || code > 0xfdef) &&
        (code & 0xfffe) !== 0xfffe)
    ) {
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
    const children: RootContent[] = [];
    for (const child of root.getChildren()) {
      const isBlock = $isBlockLevelNode(child);
      for (const node of exporter.exportChildren([child]) as RootContent[]) {
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
    extensions.push(
      syntaxToMarkdown(
        collectHardBreaks(tree),
        checkLiterals(getLiteralUrl, getLinkKeys, writeRoot),
      ),
    );
    // toMarkdown always appends a trailing newline; drop it so callers get the
    // same shape as `@lexical/markdown`'s `$convertToMarkdownString`.
    // A CJK-friendly export writes some references as their characters after
    // a table is aligned, so it measures each cell as such.
    const markdown = toMarkdownWithStandIns(
      tree,
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
        : undefined,
    ).replace(/\n$/, '');
    if (isDocumentExport) {
      parsedLinks = nextParsedLinks;
    }
    return isCjkFriendly ? toCjkFriendly(markdown, compiled) : markdown;
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
