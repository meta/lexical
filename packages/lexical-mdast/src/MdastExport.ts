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
  PhrasingContent,
  Root,
  RootContent,
  ThematicBreak,
} from 'mdast';
import type {
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
  $getRoot,
  $getSelection,
  $getState,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
} from 'lexical';
import {defaultHandlers, toMarkdown} from 'mdast-util-to-markdown';
import {toString as mdastToString} from 'mdast-util-to-string';

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
 * A to-markdown extension whose handlers reproduce the literal Markdown syntax
 * captured on import (and stored on the Lexical nodes), by temporarily
 * steering the default handlers with per-node options. Delegating to the
 * defaults keeps all the indentation / nesting / disambiguation behavior
 * intact while still honoring each node's original marker/fence. Nodes without
 * captured syntax fall straight through to the defaults, so document-level
 * options (and contributed `toMarkdownExtensions`) still apply to them.
 */
const SYNTAX_TO_MARKDOWN: ToMarkdownExtension = {
  handlers: {
    break(node: Break, parent, state, info) {
      // Delegate first: the default handler substitutes a space when a real
      // EOL is unsafe in the current construct (headings, table cells). Only
      // when it chose the hard-break form does the preserved marker apply:
      // trailing-space markers are reproduced, and the empty marker means the
      // break is SOFT (a source newline or editor line break) and serializes
      // as a plain newline rather than being upgraded to a hard break.
      const result = defaultHandlers.break(node, parent, state, info);
      if (result !== '\\\n') {
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
      if (style === 'literal' && node.title == null) {
        // A bare GFM autolink literal: emit the visible text as-is. The
        // gfm-autolink-literal to-markdown extension keeps surrounding
        // escaping consistent so it re-parses as the same literal.
        return mdastToString(node);
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
};

/**
 * Accumulates adjacent plain text nodes so a whole stretch of formatted text
 * serializes together: nodes sharing a format merge into a single delimiter
 * pair (`**ab**` rather than `**a****b**`), and nodes whose formats *overlap*
 * (bold, bold+italic, italic) nest inside shared containers so the emitted
 * delimiters re-parse to the same formatting. Shared by the inline and block
 * export walks.
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
    const format = child.getFormat() & TEXT_FORMAT_MASK;
    const last = this.runs[this.runs.length - 1];
    if (last !== undefined && last.format === format) {
      last.value += child.getTextContent();
    } else {
      this.runs.push({format, value: child.getTextContent()});
    }
    return true;
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
    const handler = exportHandlers.get(child.getType());
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
   * Whether `node` or any descendant is selected. See
   * {@link MdastExportContext.isIncluded}.
   */
  function $isIncluded(node: LexicalNode): boolean {
    if (selection === null || node.isSelected(selection)) {
      return true;
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        if ($isIncluded(child)) {
          return true;
        }
      }
    }
    return false;
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

  const context: MdastExportContext = {
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
  };

  function $dispatch(node: LexicalNode): MdastNode[] {
    const handler = exportHandlers.get(node.getType());
    if (handler) {
      const result = handler(node, context);
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

/**
 * Picks the document-level emphasis and strong delimiters from the first
 * italic / bold text node that recorded a known delimiter on import, scanning
 * the tree rooted at `node`. Mixing delimiters within one document is not
 * supported by to-markdown's escaping, so a single choice is made per
 * document; nodes with no recorded delimiter (created in the editor) are
 * skipped so they cannot mask the document's authored style.
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
 * Creates a reusable exporter that converts the Lexical tree rooted at the
 * supplied element (or the editor root) — or just the selected content —
 * into a Markdown string.
 */
/**
 * Render context state carrying the {@link BaseSelection} being serialized
 * during a selection export (`$convertSelectionToMarkdownString`); `null`
 * during whole-document exports. The export runs synchronously inside the
 * editor read, so registered export rules and contributed to-markdown
 * handlers can read it with `$getRenderContextValue` — e.g. a `root`
 * handler that appends end-of-document data (footnote definitions,
 * comments) can emit everything for a document export but only the
 * selection-referenced subset for a clipboard copy.
 */
export const RenderContextMarkdownSelection = createRenderState(
  'markdownSelection',
  (): BaseSelection | null => null,
);

export function createMdastExport(compiled: CompiledMdast): {
  $exportToMdast: (node?: ElementNode) => Root;
  $exportToMarkdown: (node?: ElementNode) => string;
  $exportSelectionToMarkdown: (selection?: BaseSelection | null) => string;
} {
  // The unfiltered exporter has no per-call state and is shared by every
  // whole-document export; selection exports build a fresh one per call.
  const documentExporter = createNodeExporter(compiled);

  const $toMdast = (
    root: ElementNode,
    exporter: ReturnType<typeof createNodeExporter>,
  ): Root => ({
    // The registry erases types; root-level output is the dispatch contract
    // for top-level children.
    children: exporter.exportChildren(root) as RootContent[],
    type: 'root',
  });

  const $serialize = (tree: Root, root: ElementNode): string => {
    // Emphasis/strong delimiters are document-level; the delimiter recorded on
    // import wins, otherwise contributed toMarkdownExtensions (and the '-'
    // bullet baseline) decide. Defaults ride as the FIRST extension so that
    // contributed extensions can override them; SYNTAX_TO_MARKDOWN runs last
    // so its handlers reproduce the per-node syntax captured on import.
    const {emphasis, strong} = $dominantInlineMarkers(root);
    const defaults: ToMarkdownExtension = {bullet: '-'};
    if (emphasis) {
      defaults.emphasis = emphasis;
    }
    if (strong) {
      defaults.strong = strong;
    }
    const out = toMarkdown(tree, {
      extensions: [
        defaults,
        ...compiled.toMarkdownExtensions,
        SYNTAX_TO_MARKDOWN,
      ],
    });
    // toMarkdown always appends a trailing newline; drop it so callers get the
    // same shape as `@lexical/markdown`'s `$convertToMarkdownString`.
    return out.replace(/\n$/, '');
  };

  const $exportToMdast = (node?: ElementNode): Root =>
    $toMdast(node || $getRoot(), documentExporter);

  const $exportToMarkdown = (node?: ElementNode): string => {
    const root = node || $getRoot();
    return $serialize($toMdast(root, documentExporter), root);
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
      $serialize($toMdast(root, createNodeExporter(compiled, selection)), root),
    );
  };

  return {$exportSelectionToMarkdown, $exportToMarkdown, $exportToMdast};
}
