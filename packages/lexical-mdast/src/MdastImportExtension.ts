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
import type {ElementNode, LexicalNode} from 'lexical';
import type {Root, ThematicBreak} from 'mdast';

import {CodeNode} from '@lexical/code-core';
import {
  $createHorizontalRuleNode,
  $getExtensionOutput,
  $isHorizontalRuleNode,
  effect,
  getExtensionDependencyFromEditor,
  HorizontalRuleExtension,
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
  safeCast,
  shallowMergeConfig,
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
  exportTab,
  exportText,
  importDefinition,
  importDelete,
  importHtml,
  importInlineCode,
  importText,
} from './handlers';
import {createMdastImport} from './MdastImport';
import {registerMarkdownShortcuts} from './MdastShortcuts';
import {hrMarkerState} from './state';

/**
 * Configuration for the core {@link MdastImportExtension} registry. Feature
 * extensions contribute to these arrays via `configExtension(MdastImportExtension,
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
 * The runtime API exposed by {@link MdastImportExtension}. Obtain it inside a
 * read/update with `$getExtensionOutput(MdastImportExtension)`, or use the
 * {@link $convertFromMarkdownString} shorthand. Serialization lives in
 * `MdastExportExtension` so import-only editors don't bundle the
 * serializer (`mdast-util-to-markdown`).
 * @experimental
 */
export interface MdastImportExtensionOutput {
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
   * {@link MdastImportExtensionOutput.$convertFromMdast}, source-based
   * syntax preservation does not apply.
   */
  $generateNodesFromMdast(tree: Root): LexicalNode[];
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
  {$export: exportParagraph, type: 'paragraph'},
  {$export: exportText, type: 'text'},
  {$export: $exportLineBreak, type: 'linebreak'},
  {$export: exportTab, type: 'tab'},
];

/**
 * The core Markdown registry for `@lexical/mdast`, modeled on
 * `@lexical/html`'s `DOMImportExtension`. It assembles the import/export rules
 * and micromark/mdast extensions contributed by feature extensions into a
 * compiled registry, and exposes Markdown import through its
 * {@link MdastImportExtensionOutput}. Markdown export is provided separately by
 * `MdastExportExtension`, so editors that never serialize back to Markdown
 * don't bundle the serializer.
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
export const MdastImportExtension = defineExtension<
  MdastConfig,
  '@lexical/mdast/Import',
  MdastImportExtensionOutput,
  void
>({
  build(editor, config): MdastImportExtensionOutput {
    const registry = compileMdast(config);
    const {
      $generateNodesFromMarkdown,
      $generateNodesFromMdast: $generateNodesFromTree,
      $importMarkdown,
      $importMdast,
    } = createMdastImport(registry);
    return {
      $convertFromMarkdownString: $importMarkdown,
      $convertFromMdast: $importMdast,
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
  name: '@lexical/mdast/Import',
});

/**
 * ATX (`# …`) and setext headings, shipping {@link HeadingNode}.
 * @experimental
 */
export const MdastHeadingExtension = defineExtension({
  dependencies: [
    configExtension(MdastImportExtension, {
      exportRules: [{$export: $exportHeading, type: 'heading'}],
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
    configExtension(MdastImportExtension, {
      exportRules: [{$export: exportQuote, type: 'quote'}],
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
    configExtension(MdastImportExtension, {
      exportRules: [{$export: $exportList, type: 'list'}],
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
    configExtension(MdastImportExtension, {
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
    configExtension(MdastImportExtension, {
      exportRules: [{$export: $exportCode, type: 'code'}],
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
    configExtension(MdastImportExtension, {
      exportRules: [{$export: $exportLink, type: 'link'}],
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
    configExtension(MdastImportExtension, {
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
    configExtension(MdastImportExtension, {
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
    configExtension(MdastImportExtension, {
      exportRules: [{$export: $exportThematicBreak, type: 'horizontalrule'}],
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
    configExtension(MdastImportExtension, {
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
 * separately as `MdastGfmExtension`, and `MdastExportExtension` (or the
 * `MdastExtension` bundle) adds serialization back to Markdown.
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
  dependencies: [MdastImportExtension],
  name: '@lexical/mdast/Shortcuts',
  register: (editor, config, state) => {
    const {disabled} = state.getOutput();
    return effect(() => {
      if (disabled.value) {
        return undefined;
      }
      const {registry} = getExtensionDependencyFromEditor(
        editor,
        MdastImportExtension,
      ).output;
      return registerMarkdownShortcuts(editor, registry);
    });
  },
});

/**
 * Shorthand for `$getExtensionOutput(MdastImportExtension).$convertFromMarkdownString`.
 * Must be called inside an `editor.update()`. Throws if the editor was not
 * built with {@link MdastImportExtension} (or an extension that depends on it).
 * @experimental
 */
export function $convertFromMarkdownString(
  markdown: string,
  node?: ElementNode,
): void {
  $getExtensionOutput(MdastImportExtension).$convertFromMarkdownString(
    markdown,
    node,
  );
}

/**
 * Shorthand for `$getExtensionOutput(MdastImportExtension).$convertFromMdast`.
 * Must be called inside an `editor.update()`. Throws if the editor was not
 * built with {@link MdastImportExtension} (or an extension that depends on
 * it).
 * @experimental
 */
export function $convertFromMdast(tree: Root, node?: ElementNode): void {
  $getExtensionOutput(MdastImportExtension).$convertFromMdast(tree, node);
}

/**
 * Shorthand for
 * `$getExtensionOutput(MdastImportExtension).$generateNodesFromMarkdownString`.
 * Parses `markdown` and returns the resulting block-level nodes as a
 * detached array, without modifying the document or the selection. Must be
 * called inside an `editor.update()`. Throws if the editor was not built
 * with {@link MdastImportExtension} (or an extension that depends on it).
 * @experimental
 */
export function $generateNodesFromMarkdownString(
  markdown: string,
): LexicalNode[] {
  return $getExtensionOutput(
    MdastImportExtension,
  ).$generateNodesFromMarkdownString(markdown);
}

/**
 * Shorthand for
 * `$getExtensionOutput(MdastImportExtension).$generateNodesFromMdast`.
 * Walks an already-parsed mdast `Root` tree and returns the resulting
 * block-level nodes as a detached array, without modifying the document or
 * the selection. Must be called inside an `editor.update()`. Throws if the
 * editor was not built with {@link MdastImportExtension} (or an extension
 * that depends on it).
 * @experimental
 */
export function $generateNodesFromMdast(tree: Root): LexicalNode[] {
  return $getExtensionOutput(MdastImportExtension).$generateNodesFromMdast(
    tree,
  );
}
