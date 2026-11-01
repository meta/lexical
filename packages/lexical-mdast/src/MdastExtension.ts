/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  CompiledMdast,
  FromMarkdownExtension,
  MdastExportHandler,
  MdastExportRule,
  MdastImportHandler,
  MdastImportRule,
  MicromarkExtension,
  ToMarkdownExtension,
} from './types';
import type {BaseSelection, ElementNode, LexicalNode} from 'lexical';
import type {Root, ThematicBreak} from 'mdast';

import {CodeNode} from '@lexical/code-core';
import {
  $createHorizontalRuleNode,
  $getExtensionOutput,
  $isHorizontalRuleNode,
  effect,
  getExtensionDependencyFromEditor,
  HorizontalRuleExtension,
  HorizontalRuleNode,
  namedSignals,
} from '@lexical/extension';
import {LinkNode} from '@lexical/link';
import {ListItemNode, ListNode} from '@lexical/list';
import {HeadingNode, QuoteNode} from '@lexical/rich-text';
import {
  $getState,
  $setState,
  configExtension,
  defineExtension,
  LineBreakNode,
  ParagraphNode,
  safeCast,
  shallowMergeConfig,
  TextNode,
} from 'lexical';
import {
  gfmAutolinkLiteralFromMarkdown,
  gfmAutolinkLiteralToMarkdown,
} from 'mdast-util-gfm-autolink-literal';
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from 'mdast-util-gfm-strikethrough';
import {
  gfmTaskListItemFromMarkdown,
  gfmTaskListItemToMarkdown,
} from 'mdast-util-gfm-task-list-item';
import {gfmAutolinkLiteral} from 'micromark-extension-gfm-autolink-literal';
import {gfmStrikethrough} from 'micromark-extension-gfm-strikethrough';
import {gfmTaskListItem} from 'micromark-extension-gfm-task-list-item';

import {compileMdast} from './compile';
import {
  $exportCode,
  $exportHeading,
  $exportLineBreak,
  $exportLink,
  $exportList,
  $importBlockquote,
  $importBreak,
  $importCode,
  $importEmphasis,
  $importHeading,
  $importLink,
  $importLinkReference,
  $importList,
  $importListItem,
  $importParagraph,
  $importShadowRootBlockquote,
  $importStrong,
  exportParagraph,
  exportQuote,
  exportText,
  importDefinition,
  importDelete,
  importHtml,
  importInlineCode,
  importText,
} from './handlers';
import {createMdastExport} from './MdastExport';
import {createMdastImport} from './MdastImport';
import {registerMarkdownShortcuts} from './MdastShortcuts';
import {hrMarkerState} from './state';

/**
 * Configuration for the core {@link MdastExtension} registry. Feature
 * extensions contribute to these arrays via `configExtension(MdastExtension,
 * …)`; you rarely need to set them by hand. The shape mirrors
 * `@lexical/html`'s `DOMImportExtension` config: raw contribution arrays that
 * `mergeConfig` concatenates and `build` compiles.
 * @experimental
 */
export interface MdastConfig {
  /** mdast `type` -> Lexical mapping rules used while importing. */
  readonly importRules: readonly MdastImportRule[];
  /** Lexical `getType()` -> mdast mapping rules used while exporting. */
  readonly exportRules: readonly MdastExportRule[];
  /** micromark syntax extensions (the tokenizer layer). */
  readonly micromarkExtensions: readonly MicromarkExtension[];
  /** `mdast-util-from-markdown` extensions (tokens -> mdast). */
  readonly mdastExtensions: readonly FromMarkdownExtension[];
  /** `mdast-util-to-markdown` extensions (mdast -> Markdown string). */
  readonly toMarkdownExtensions: readonly ToMarkdownExtension[];
  /**
   * mdast inline `type`s that the streaming shortcuts may materialize when
   * their closing delimiter is typed. Extensions that contribute a new inline
   * construct add its type here (with a matching import rule) so shortcuts
   * stay in lock-step with the parser.
   */
  readonly inlineShortcutTypes: readonly string[];
  /**
   * Characters that can close an inline construct; typing one triggers an
   * inline re-scan. Extensions add their construct's closing character here
   * (e.g. `'='` for `==highlight==`).
   */
  readonly inlineShortcutTriggers: readonly string[];
}

/**
 * The runtime API exposed by {@link MdastExtension}. Obtain it inside a
 * read/update with `$getExtensionOutput(MdastExtension)`, or use the
 * {@link $convertFromMarkdownString} and {@link $convertToMarkdownString}
 * shorthands.
 * @experimental
 */
export interface MdastExtensionOutput {
  /**
   * Parses `markdown` with micromark/mdast and replaces the contents of the
   * editor root (or `node`). Must be called inside an `editor.update()`.
   */
  $convertFromMarkdownString(markdown: string, node?: ElementNode): void;
  /**
   * Imports an already-parsed mdast `Root` tree (e.g. produced or
   * transformed by unified/remark tooling) and replaces the contents of the
   * editor root (or `node`). Must be called inside an `editor.update()`.
   * Source-based syntax preservation does not apply (there is no source
   * text to recover literal markers from).
   */
  $convertFromMdast(tree: Root, node?: ElementNode): void;
  /**
   * Parses `markdown` and returns the resulting block-level nodes as a
   * detached array, without modifying the document or the selection — e.g.
   * for insertion at an arbitrary position via `selection.insertNodes()`.
   * Must be called inside an `editor.update()`.
   */
  $generateNodesFromMarkdownString(markdown: string): LexicalNode[];
  /**
   * Walks an already-parsed mdast `Root` tree and returns the resulting
   * block-level nodes as a detached array, without modifying the document
   * or the selection. Must be called inside an `editor.update()`. As with
   * {@link MdastExtensionOutput.$convertFromMdast}, source-based
   * syntax preservation does not apply.
   */
  $generateNodesFromMdast(tree: Root): LexicalNode[];
  /**
   * Serializes the editor root (or `node`) to a Markdown string. Must be
   * called inside an `editor.read()` or `editor.update()`.
   */
  $convertToMarkdownString(node?: ElementNode): string;
  /**
   * Exports the editor root (or `node`) to an mdast `Root` tree without
   * serializing it, for interop with the unified/remark ecosystem (remark
   * plugins, `remark-rehype`, tree diffing, ...). Must be called inside an
   * `editor.read()` or `editor.update()`. Syntax preserved from import
   * rides along as `data` fields on the nodes, mdast's sanctioned
   * extension point.
   */
  $convertToMdast(node?: ElementNode): Root;
  /**
   * Serializes only the selected content (defaulting to the current selection)
   * to a Markdown string: leaves outside the selection are skipped, partially
   * selected text nodes are sliced to the selected range, and elements are
   * kept when they or any descendant are selected (export rules may write
   * less: a GFM table writes a text or node selection within one of its cells
   * as that cell's blocks, as copying in a cell does). Returns `''` for a null
   * or collapsed selection. Must be called inside an `editor.read()` or
   * `editor.update()`. The export runs under
   * {@link RenderContextMarkdownSelection} carrying the selection, so
   * contributed export rules and to-markdown handlers can scope their output
   * to a selection export.
   */
  $convertSelectionToMarkdownString(selection?: BaseSelection | null): string;
  /**
   * The compiled registry assembled from every contributing extension.
   *
   * @internal consumed by {@link MdastShortcutsExtension}.
   */
  readonly registry: CompiledMdast;
}

// The baseline rules that need no node packages: paragraphs and inline text
// formatting (CommonMark handles these without any micromark extension).
const CORE_IMPORT_RULES: readonly MdastImportRule[] = [
  {$import: $importParagraph, type: 'paragraph'},
  {$import: importText, type: 'text'},
  {$import: importHtml, type: 'html'},
  {$import: importInlineCode, type: 'inlineCode'},
  {$import: $importEmphasis, type: 'emphasis'},
  {$import: $importStrong, type: 'strong'},
  {$import: $importBreak, type: 'break'},
];
const CORE_EXPORT_RULES: readonly MdastExportRule[] = [
  {$export: exportParagraph, type: ParagraphNode},
  {$export: exportText, type: TextNode},
  {$export: $exportLineBreak, type: LineBreakNode},
];

/**
 * The core Markdown registry for `@lexical/mdast`, modeled on
 * `@lexical/html`'s `DOMImportExtension`. It assembles the import/export rules
 * and micromark/mdast extensions contributed by feature extensions into a
 * compiled registry, and exposes Markdown import and export through its
 * {@link MdastExtensionOutput}.
 *
 * You normally do not depend on this directly — depend on a feature extension
 * (e.g. {@link MdastCommonMarkExtension}) which contributes its rules here and
 * ships the nodes those rules need.
 *
 * @example
 * ```ts
 * import {$convertFromMarkdownString, MdastCommonMarkExtension}
 *   from '@lexical/mdast';
 * import {buildEditorFromExtensions} from '@lexical/extension';
 * import {defineExtension} from 'lexical';
 *
 * const editor = buildEditorFromExtensions(
 *   defineExtension({dependencies: [MdastCommonMarkExtension], name: '[root]'}),
 * );
 * editor.update(() => $convertFromMarkdownString('# Hi'));
 * ```
 * @experimental
 */
export const MdastExtension = defineExtension<
  MdastConfig,
  '@lexical/mdast/Mdast',
  MdastExtensionOutput,
  void
>({
  build(editor, config): MdastExtensionOutput {
    const registry = compileMdast(editor, config);
    const {$exportSelectionToMarkdown, $exportToMdast, $exportToMarkdown} =
      createMdastExport(registry);
    const {
      $generateNodesFromMarkdown,
      $generateNodesFromMdast: $generateNodesFromTree,
      $importMarkdown,
      $importMdast,
    } = createMdastImport(registry);
    return {
      $convertFromMarkdownString: $importMarkdown,
      $convertFromMdast: $importMdast,
      $convertSelectionToMarkdownString: $exportSelectionToMarkdown,
      $convertToMarkdownString: $exportToMarkdown,
      $convertToMdast: $exportToMdast,
      $generateNodesFromMarkdownString: $generateNodesFromMarkdown,
      $generateNodesFromMdast: $generateNodesFromTree,
      registry,
    };
  },
  config: safeCast<MdastConfig>({
    exportRules: CORE_EXPORT_RULES,
    importRules: CORE_IMPORT_RULES,
    // Core CommonMark inline formatting; feature extensions contribute
    // their own types/triggers (links add 'link'/')', strikethrough adds
    // 'delete'/'~').
    inlineShortcutTriggers: ['*', '_', '`'],
    inlineShortcutTypes: ['emphasis', 'inlineCode', 'strong'],
    mdastExtensions: [],
    micromarkExtensions: [],
    toMarkdownExtensions: [],
  }),
  mergeConfig(config, partial) {
    // Prepend contributed rules so extensions merged later (closer to the
    // editor root) take priority, matching DOMImportExtension's convention.
    // Every key is set explicitly so an explicitly-undefined key in `partial`
    // (allowed by Partial<MdastConfig>) can never clobber the merged arrays.
    function mergeArray<T>(
      contributed: readonly T[] | undefined,
      existing: readonly T[],
    ): readonly T[] {
      return contributed ? [...contributed, ...existing] : existing;
    }
    return shallowMergeConfig(config, {
      exportRules: mergeArray(partial.exportRules, config.exportRules),
      importRules: mergeArray(partial.importRules, config.importRules),
      inlineShortcutTriggers: mergeArray(
        partial.inlineShortcutTriggers,
        config.inlineShortcutTriggers,
      ),
      inlineShortcutTypes: mergeArray(
        partial.inlineShortcutTypes,
        config.inlineShortcutTypes,
      ),
      mdastExtensions: mergeArray(
        partial.mdastExtensions,
        config.mdastExtensions,
      ),
      micromarkExtensions: mergeArray(
        partial.micromarkExtensions,
        config.micromarkExtensions,
      ),
      toMarkdownExtensions: mergeArray(
        partial.toMarkdownExtensions,
        config.toMarkdownExtensions,
      ),
    });
  },
  name: '@lexical/mdast/Mdast',
});

/**
 * ATX (`# …`) and setext headings, shipping {@link HeadingNode}.
 * @experimental
 */
export const MdastHeadingExtension = defineExtension({
  dependencies: [
    configExtension(MdastExtension, {
      exportRules: [{$export: $exportHeading, type: HeadingNode}],
      importRules: [{$import: $importHeading, type: 'heading'}],
    }),
  ],
  name: '@lexical/mdast/Heading',
  nodes: [HeadingNode],
});

/**
 * Block quotes (`> …`), shipping {@link QuoteNode}. For blockquotes that hold
 * block-level children (nested lists, code, quotes) with full fidelity, add
 * {@link MdastShadowRootQuoteExtension}.
 * @experimental
 */
export const MdastBlockquoteExtension = defineExtension({
  dependencies: [
    configExtension(MdastExtension, {
      exportRules: [{$export: exportQuote, type: QuoteNode}],
      importRules: [{$import: $importBlockquote, type: 'blockquote'}],
    }),
  ],
  name: '@lexical/mdast/Blockquote',
  nodes: [QuoteNode],
});

/**
 * Convenience bundle of {@link MdastHeadingExtension} and
 * {@link MdastBlockquoteExtension} — the constructs backed by
 * `@lexical/rich-text` nodes.
 * @experimental
 */
export const MdastRichTextExtension = defineExtension({
  dependencies: [MdastHeadingExtension, MdastBlockquoteExtension],
  name: '@lexical/mdast/RichText',
});

/**
 * Ordered and unordered lists, shipping {@link ListNode} and
 * {@link ListItemNode}. For GFM task lists (`- [x] …`) add
 * {@link MdastTaskListExtension}.
 * @experimental
 */
export const MdastListExtension = defineExtension({
  dependencies: [
    configExtension(MdastExtension, {
      exportRules: [{$export: $exportList, type: ListNode}],
      importRules: [
        {$import: $importList, type: 'list'},
        {$import: $importListItem, type: 'listItem'},
      ],
    }),
  ],
  name: '@lexical/mdast/List',
  nodes: [ListNode, ListItemNode],
});

/**
 * Opt-in: GFM task lists (`- [x] done`), layered on
 * {@link MdastListExtension}. Contributes the `gfmTaskListItem` grammar; the
 * list import/export handlers already understand `checked`, and the typing
 * shortcut (`[ ] ` / `[x] ` in a list item) is enabled by the grammar's
 * presence in the registry.
 * @experimental
 */
export const MdastTaskListExtension = defineExtension({
  dependencies: [
    MdastListExtension,
    configExtension(MdastExtension, {
      mdastExtensions: [/* @__PURE__ */ gfmTaskListItemFromMarkdown()],
      micromarkExtensions: [/* @__PURE__ */ gfmTaskListItem()],
      toMarkdownExtensions: [/* @__PURE__ */ gfmTaskListItemToMarkdown()],
    }),
  ],
  name: '@lexical/mdast/TaskList',
});

/**
 * Fenced and indented code blocks, shipping {@link CodeNode}.
 * @experimental
 */
export const MdastCodeExtension = defineExtension({
  dependencies: [
    configExtension(MdastExtension, {
      exportRules: [{$export: $exportCode, type: CodeNode}],
      importRules: [{$import: $importCode, type: 'code'}],
    }),
  ],
  name: '@lexical/mdast/Code',
  nodes: [CodeNode],
});

/**
 * Inline links, CommonMark autolinks (`<https://…>`), and CommonMark
 * reference links (`[text][id]` resolved against `[id]: url` definitions),
 * shipping {@link LinkNode}. Reference links are resolved to their target on
 * import and serialize back as inline links. For GFM *literal* autolinks
 * (bare `https://…` in prose) add {@link MdastAutolinkLiteralExtension}.
 * @experimental
 */
export const MdastLinkExtension = defineExtension({
  dependencies: [
    configExtension(MdastExtension, {
      exportRules: [{$export: $exportLink, type: LinkNode}],
      importRules: [
        {$import: $importLink, type: 'link'},
        {$import: $importLinkReference, type: 'linkReference'},
        {$import: importDefinition, type: 'definition'},
      ],
      inlineShortcutTriggers: [')'],
      inlineShortcutTypes: ['link'],
    }),
  ],
  name: '@lexical/mdast/Link',
  nodes: [LinkNode],
});

/**
 * Opt-in: GFM literal autolinks — bare `https://…` / `www.…` URLs and email
 * addresses in prose become links, the way GitHub renders them. This is a GFM
 * extension rather than CommonMark, so it is not part of
 * {@link MdastCommonMarkExtension}; add it alongside to opt in:
 * ```ts
 * dependencies: [MdastCommonMarkExtension, MdastAutolinkLiteralExtension]
 * ```
 * @experimental
 */
export const MdastAutolinkLiteralExtension = defineExtension({
  dependencies: [
    MdastLinkExtension,
    configExtension(MdastExtension, {
      mdastExtensions: [/* @__PURE__ */ gfmAutolinkLiteralFromMarkdown()],
      micromarkExtensions: [/* @__PURE__ */ gfmAutolinkLiteral()],
      toMarkdownExtensions: [/* @__PURE__ */ gfmAutolinkLiteralToMarkdown()],
    }),
  ],
  name: '@lexical/mdast/AutolinkLiteral',
});

/**
 * Opt-in: import Markdown blockquotes as *shadow root* {@link QuoteNode}s
 * (`$createQuoteNode({shadowRoot: true})`), which hold block-level children
 * like a table cell. Structured blockquotes — multiple paragraphs, nested
 * lists, code blocks, nested quotes — then round-trip with full fidelity
 * instead of being reassembled from inline content.
 *
 * Not part of {@link MdastCommonMarkExtension}; add it alongside to opt in:
 * ```ts
 * dependencies: [MdastCommonMarkExtension, MdastShadowRootQuoteExtension]
 * ```
 * The quote *export* handler supports both forms per node, so legacy quotes
 * (e.g. created by the `> ` shortcut) and shadow root quotes can coexist.
 * @experimental
 */
export const MdastShadowRootQuoteExtension = defineExtension({
  dependencies: [
    MdastBlockquoteExtension,
    // Declared after (and depending on) MdastBlockquoteExtension so this
    // blockquote rule merges later and takes priority over the default.
    configExtension(MdastExtension, {
      importRules: [{$import: $importShadowRootBlockquote, type: 'blockquote'}],
    }),
  ],
  name: '@lexical/mdast/ShadowRootQuote',
});

const $importThematicBreak: MdastImportHandler<ThematicBreak> = (node, ctx) => {
  const hr = $createHorizontalRuleNode();
  // Preserve the marker character (`---` vs `***` vs `___`).
  if (ctx.source && node.position && node.position.start.offset != null) {
    const marker = ctx.source
      .slice(node.position.start.offset, node.position.start.offset + 4)
      .trimStart()[0];
    if (marker === '-' || marker === '*' || marker === '_') {
      $setState(hr, hrMarkerState, marker);
    }
  }
  return hr;
};

const $exportThematicBreak: MdastExportHandler = node => {
  if (!$isHorizontalRuleNode(node)) {
    return null;
  }
  const rule: ThematicBreak = {type: 'thematicBreak'};
  const marker = $getState(node, hrMarkerState);
  if (marker) {
    rule.data = {mdastRule: marker};
  }
  return rule;
};

/**
 * Thematic breaks (`---`, `***`, `___`), mapped to
 * {@link HorizontalRuleExtension}'s `HorizontalRuleNode`. The original marker
 * character is preserved on round-trip.
 * @experimental
 */
export const MdastHorizontalRuleExtension = defineExtension({
  dependencies: [
    HorizontalRuleExtension,
    configExtension(MdastExtension, {
      exportRules: [{$export: $exportThematicBreak, type: HorizontalRuleNode}],
      importRules: [{$import: $importThematicBreak, type: 'thematicBreak'}],
    }),
  ],
  name: '@lexical/mdast/HorizontalRule',
});

/**
 * GFM `~~strikethrough~~`, mapped to the Lexical `strikethrough` text format.
 * Needs no extra nodes (the core text handlers carry the format bit).
 * @experimental
 */
export const MdastStrikethroughExtension = defineExtension({
  dependencies: [
    configExtension(MdastExtension, {
      importRules: [{$import: importDelete, type: 'delete'}],
      inlineShortcutTriggers: ['~'],
      inlineShortcutTypes: ['delete'],
      mdastExtensions: [/* @__PURE__ */ gfmStrikethroughFromMarkdown()],
      micromarkExtensions: [/* @__PURE__ */ gfmStrikethrough()],
      toMarkdownExtensions: [/* @__PURE__ */ gfmStrikethroughToMarkdown()],
    }),
  ],
  name: '@lexical/mdast/Strikethrough',
});

/**
 * Convenience bundle of every CommonMark construct: headings, block quotes,
 * lists, code blocks, links, and thematic breaks. GFM features
 * (strikethrough, task lists, literal autolinks, tables) are bundled
 * separately as `MdastGfmExtension`.
 * @experimental
 */
export const MdastCommonMarkExtension = defineExtension({
  dependencies: [
    MdastRichTextExtension,
    MdastListExtension,
    MdastCodeExtension,
    MdastLinkExtension,
    MdastHorizontalRuleExtension,
  ],
  name: '@lexical/mdast/CommonMark',
});

export interface MdastShortcutsConfig {
  /** Disable the streaming shortcuts without removing the extension. */
  disabled: boolean;
}

/**
 * Streaming Markdown shortcuts (block markers convert on space, fenced code on
 * Enter, inline constructs on their closing delimiter). Each keystroke is fed
 * back through micromark, so shortcut recognition uses the same grammar and
 * the same enabled extensions as import: shortcuts exist for exactly the
 * feature extensions in the editor and no others. Combine with
 * {@link MdastCommonMarkExtension} (and `MdastGfmExtension`) — this extension
 * only wires up the behavior, it does not pull in any grammar of its own.
 * @experimental
 */
export const MdastShortcutsExtension = defineExtension({
  build: (editor, config) => namedSignals(config),
  config: safeCast<MdastShortcutsConfig>({disabled: false}),
  dependencies: [MdastExtension],
  name: '@lexical/mdast/Shortcuts',
  register: (editor, config, state) => {
    const {disabled} = state.getOutput();
    return effect(() => {
      if (disabled.value) {
        return undefined;
      }
      const {registry} = getExtensionDependencyFromEditor(
        editor,
        MdastExtension,
      ).output;
      return registerMarkdownShortcuts(editor, registry);
    });
  },
});

/**
 * Shorthand for `$getExtensionOutput(MdastExtension).$convertFromMarkdownString`.
 * Must be called inside an `editor.update()`. Throws if the editor was not
 * built with {@link MdastExtension} (or an extension that depends on it).
 * @experimental
 */
export function $convertFromMarkdownString(
  markdown: string,
  node?: ElementNode,
): void {
  $getExtensionOutput(MdastExtension).$convertFromMarkdownString(
    markdown,
    node,
  );
}

/**
 * Shorthand for `$getExtensionOutput(MdastExtension).$convertFromMdast`.
 * Must be called inside an `editor.update()`. Throws if the editor was not
 * built with {@link MdastExtension} (or an extension that depends on
 * it).
 * @experimental
 */
export function $convertFromMdast(tree: Root, node?: ElementNode): void {
  $getExtensionOutput(MdastExtension).$convertFromMdast(tree, node);
}

/**
 * Shorthand for
 * `$getExtensionOutput(MdastExtension).$generateNodesFromMarkdownString`.
 * Parses `markdown` and returns the resulting block-level nodes as a
 * detached array, without modifying the document or the selection. Must be
 * called inside an `editor.update()`. Throws if the editor was not built
 * with {@link MdastExtension} (or an extension that depends on it).
 * @experimental
 */
export function $generateNodesFromMarkdownString(
  markdown: string,
): LexicalNode[] {
  return $getExtensionOutput(MdastExtension).$generateNodesFromMarkdownString(
    markdown,
  );
}

/**
 * Shorthand for
 * `$getExtensionOutput(MdastExtension).$generateNodesFromMdast`.
 * Walks an already-parsed mdast `Root` tree and returns the resulting
 * block-level nodes as a detached array, without modifying the document or
 * the selection. Must be called inside an `editor.update()`. Throws if the
 * editor was not built with {@link MdastExtension} (or an extension
 * that depends on it).
 * @experimental
 */
export function $generateNodesFromMdast(tree: Root): LexicalNode[] {
  return $getExtensionOutput(MdastExtension).$generateNodesFromMdast(tree);
}
