/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {CompiledMdast, MdastNode} from './types';
import type {LexicalNode} from 'lexical';
import type {Blockquote, Code, Heading, List, PhrasingContent} from 'mdast';

import {fromMarkdown} from 'mdast-util-from-markdown';

import {createNodeImporter} from './MdastImport';

export type MdastBlockMatch =
  | {kind: 'heading'; node: Heading; markerLength: number}
  | {kind: 'blockquote'; node: Blockquote; markerLength: number}
  | {kind: 'list'; node: List; markerLength: number}
  | {kind: 'code'; node: Code; markerLength: number};

/**
 * Returns the offset of the first content character inside a block construct,
 * i.e. the length of the leading block marker (`"## "`, `"- "`, `"> "`, ...).
 * When the construct has no content yet (the user has only typed the marker)
 * the whole `line` is the marker.
 *
 * The walk descends through *container* levels only (blockquote -> paragraph,
 * list -> listItem -> paragraph) and stops at the first inline child of a
 * paragraph or heading — descending further would treat inline delimiters
 * (`**`, `[`, `` ` ``) as part of the block marker.
 */
function contentStartOffset(node: MdastNode, line: string): number {
  let current: MdastNode = node;
  for (;;) {
    if (current.type === 'heading' || current.type === 'paragraph') {
      const first = current.children[0];
      return first && first.position && first.position.start.offset != null
        ? first.position.start.offset
        : line.length;
    }
    if (!('children' in current) || current.children.length === 0) {
      return line.length;
    }
    current = current.children[0];
  }
}

/**
 * `MarkdownStreamScanner` is the streaming heart of the shortcut engine. Each
 * keystroke feeds the growing line/inline buffer back through micromark (via
 * `mdast-util-from-markdown`), so shortcut recognition uses the *exact* same
 * grammar — and the same enabled extensions — as full-document import. There
 * is no second, divergent set of regular expressions to keep in sync.
 *
 * It is constructed from the {@link CompiledMdast} registry assembled by
 * {@link MdastExtension}, so it stays in lock-step with whatever feature
 * extensions are enabled — including the inline construct types and trigger
 * characters contributed via `inlineShortcutTypes` / `inlineShortcutTriggers`.
 */
export class MarkdownStreamScanner {
  private readonly compiled: CompiledMdast;
  private readonly importNode: (
    node: MdastNode,
    format: number,
  ) => LexicalNode[];
  /**
   * Whether the registry's grammar recognizes GFM task-list items (i.e.
   * `MdastTaskListExtension` contributed `gfmTaskListItem`). Probed by
   * parsing rather than configured, so it can never drift from the grammar.
   */
  readonly supportsTaskListItems: boolean;

  constructor(compiled: CompiledMdast) {
    this.compiled = compiled;
    this.importNode = createNodeImporter(compiled, '').$importNode;
    const probe = this.parse('- [x] a').children[0];
    this.supportsTaskListItems =
      probe != null &&
      probe.type === 'list' &&
      probe.children[0].checked === true;
  }

  /** Characters that can close an inline construct for this registry. */
  get inlineTriggers(): ReadonlySet<string> {
    return this.compiled.inlineShortcutTriggers;
  }

  private parse(value: string) {
    return fromMarkdown(value, {
      extensions: this.compiled.micromarkExtensions,
      mdastExtensions: this.compiled.mdastExtensions,
    });
  }

  /**
   * Materializes an mdast inline node into Lexical nodes using the same
   * import handlers as the full-document importer.
   */
  importInline(node: MdastNode): LexicalNode[] {
    return this.importNode(node, 0);
  }

  /**
   * Recognizes a block-level construct at the start of `line`. Returns the
   * matched construct together with the marker length, or `null`.
   */
  scanBlock(line: string): MdastBlockMatch | null {
    if (line.trim() === '') {
      return null;
    }
    const first = this.parse(line).children[0];
    // Only offer shortcuts for constructs the registry can actually import:
    // in a granular setup (e.g. no blockquote extension) the syntax should
    // stay literal rather than materialize an unregistered node.
    if (!first || !this.compiled.importHandlers.has(first.type)) {
      return null;
    }
    switch (first.type) {
      case 'heading':
        return {
          kind: 'heading',
          markerLength: contentStartOffset(first, line),
          node: first,
        };
      case 'blockquote':
        return {
          kind: 'blockquote',
          markerLength: contentStartOffset(first, line),
          node: first,
        };
      case 'list':
        return {
          kind: 'list',
          markerLength: contentStartOffset(first, line),
          node: first,
        };
      case 'code':
        // A code construct recognized from a single line is just the opening
        // fence (possibly with a language); the entire line is the marker.
        return {kind: 'code', markerLength: line.length, node: first};
      default:
        return null;
    }
  }

  /**
   * Recognizes an inline construct (emphasis, strong, strikethrough, inline
   * code, link, plus any registered `inlineShortcutTypes`) whose closing
   * delimiter falls exactly at the end of `value` (the text up to the caret).
   * Returns the mdast node, or `null`.
   */
  scanInline(value: string): PhrasingContent | null {
    if (value.length === 0) {
      return null;
    }
    const tree = this.parse(value);
    const lastBlock = tree.children[tree.children.length - 1];
    if (!lastBlock || lastBlock.type !== 'paragraph') {
      return null;
    }
    const last = lastBlock.children[lastBlock.children.length - 1];
    if (
      !last ||
      !last.position ||
      last.position.end.offset !== value.length ||
      !this.compiled.inlineShortcutTypes.has(last.type)
    ) {
      return null;
    }
    // Guard against firing mid-delimiter: while typing `**bold*` the parser
    // briefly sees emphasis (`*bold*`) closing at the caret with a stray `*`
    // in front. If the opening delimiter is immediately preceded by the same
    // delimiter character, defer until the user finishes the longer run.
    const start = last.position.start.offset ?? 0;
    const openChar = value[start];
    if (
      start > 0 &&
      value[start - 1] === openChar &&
      this.compiled.inlineShortcutTriggers.has(openChar)
    ) {
      return null;
    }
    return last;
  }
}
