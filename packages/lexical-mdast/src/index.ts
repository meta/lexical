/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Feature extensions contribute import/export rules and grammar to the
// configurable MdastExtension. Read both directions from its output or use
// the $convert* shorthands. Add MdastShortcutsExtension for typing shortcuts.

export {RenderContextMarkdownSelection} from './MdastExport';
export {
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  $convertToMdast,
} from './MdastExportExtension';
export type {
  MdastConfig,
  MdastExtensionOutput,
  MdastShortcutsConfig,
} from './MdastExtension';
export {
  $convertFromMarkdownString,
  $convertFromMdast,
  $generateNodesFromMarkdownString,
  $generateNodesFromMdast,
  MdastAutolinkLiteralExtension,
  MdastBlockquoteExtension,
  MdastCodeExtension,
  MdastCommonMarkExtension,
  MdastExtension,
  MdastHeadingExtension,
  MdastHorizontalRuleExtension,
  MdastLinkExtension,
  MdastListExtension,
  MdastRichTextExtension,
  MdastShadowRootQuoteExtension,
  MdastShortcutsExtension,
  MdastStrikethroughExtension,
  MdastTaskListExtension,
} from './MdastExtension';
export {MdastGfmExtension} from './MdastGfmExtension';
export {
  $exportViaDOM,
  MdastHtmlExtension,
  rawHtmlBlock,
  type RawHtmlBlockPart,
  RenderContextMarkdownExport,
} from './MdastHtmlExtension';
export {ImportContextMarkdown} from './MdastImport';
export {MdastTableExtension} from './MdastTableExtension';
export type {
  CompiledMdast,
  MdastExportContext,
  MdastExportHandler,
  MdastExportRule,
  MdastImportContext,
  MdastImportHandler,
  MdastImportRule,
  MdastNode,
  MdastParent,
} from './types';
// Re-exported so consumers writing import/export handlers (whose
// signatures traffic in these mdast content types, e.g.
// {@link RawHtmlBlockPart}) don't need their own dependency on the
// `mdast` type declarations.
export type {
  BlockContent,
  Blockquote,
  FootnoteDefinition,
  FootnoteReference,
  Html,
  Paragraph,
  PhrasingContent,
  RootContent,
} from 'mdast';
