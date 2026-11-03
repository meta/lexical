/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  ArtificialNode__DO_NOT_USE,
  type BaseSelection,
  type ElementNode,
  type LexicalNode,
} from 'lexical';

import {
  createMarkdownExport,
  createSelectionMarkdownExport,
} from './MarkdownExport';
import {$importMarkdownNodes} from './MarkdownImport';
import {registerMarkdownShortcuts} from './MarkdownShortcuts';
import {
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  CHECK_LIST,
  CODE,
  ELEMENT_TRANSFORMERS,
  type ElementTransformer,
  HEADING,
  HIGHLIGHT,
  INLINE_CODE,
  isTableRowDivider,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  MULTILINE_ELEMENT_TRANSFORMERS,
  type MultilineElementTransformer,
  normalizeMarkdown,
  ORDERED_LIST,
  QUOTE,
  STRIKETHROUGH,
  TEXT_FORMAT_TRANSFORMERS,
  TEXT_MATCH_TRANSFORMERS,
  type TextFormatTransformer,
  type TextMatchTransformer,
  type Transformer,
  TRANSFORMERS,
  UNORDERED_LIST,
} from './MarkdownTransformers';
import {
  type PunctuationMode,
  withExportPunctuation,
  withImportPunctuation,
} from './utils';

/**
 * Options for Markdown import.
 */
export interface MarkdownImportOptions {
  /**
   * Preserve new lines between conversions. Defaults to false.
   */
  shouldPreserveNewLines?: boolean;
  /**
   * Merge adjacent non-empty lines into one paragraph, as CommonMark does
   * (https://spec.commonmark.org/0.31.2/#paragraphs). Not applicable with
   * `shouldPreserveNewLines`. Defaults to false.
   */
  shouldMergeAdjacentLines?: boolean;
  /**
   * How emphasis markers beside punctuation are read. Defaults to
   * `'cjk-friendly'`, which reads Markdown such as `**你好。**世界` as its CJK
   * writer meant and everything else as CommonMark does.
   */
  punctuation?: PunctuationMode;
}

/**
 * Options for Markdown export.
 */
export interface MarkdownExportOptions {
  /**
   * Preserve new lines between conversions. Defaults to false.
   */
  shouldPreserveNewLines?: boolean;
  /**
   * Which readers the emphasis markers are written for. Defaults to
   * `'strict-commonmark'`, which writes a character reference where a marker
   * beside punctuation would otherwise not open or close (`**你好。**&#19990;界`),
   * so that every CommonMark, GFM and CJK-friendly reader reads it the same
   * way. `'cjk-friendly'` writes such CJK text as typed (`**你好。**世界`), for
   * readers that follow the CJK-friendly amendment, such as import here.
   */
  punctuation?: PunctuationMode;
}

function toImportOptions(
  options: boolean | MarkdownImportOptions,
  shouldMergeAdjacentLines: boolean,
): MarkdownImportOptions {
  return typeof options === 'boolean'
    ? {shouldMergeAdjacentLines, shouldPreserveNewLines: options}
    : options;
}

function $importMarkdown(
  markdown: string,
  container: ElementNode,
  transformers: Transformer[],
  {
    shouldPreserveNewLines = false,
    shouldMergeAdjacentLines = false,
    punctuation,
  }: MarkdownImportOptions,
): void {
  withImportPunctuation(punctuation, () =>
    $importMarkdownNodes(
      shouldPreserveNewLines
        ? markdown
        : normalizeMarkdown(markdown, shouldMergeAdjacentLines),
      container,
      transformers,
      shouldPreserveNewLines,
    ),
  );
}

/**
 * Renders markdown from a string. The selection is moved to the start after the operation.
 *
 *  @param {boolean | MarkdownImportOptions} [shouldPreserveNewLines] By setting this to true, new lines will be preserved between conversions. {@link MarkdownImportOptions} can be passed here instead, in place of this and `shouldMergeAdjacentLines`.
 *  @param {boolean} [shouldMergeAdjacentLines] By setting this to true, adjacent non empty lines will be merged according to commonmark spec: https://spec.commonmark.org/0.24/#example-177. Not applicable if shouldPreserveNewLines = true.
 */
function $convertFromMarkdownString(
  markdown: string,
  transformers?: Transformer[],
  node?: ElementNode,
  options?: MarkdownImportOptions,
): void;
function $convertFromMarkdownString(
  markdown: string,
  transformers?: Transformer[],
  node?: ElementNode,
  shouldPreserveNewLines?: boolean,
  shouldMergeAdjacentLines?: boolean,
): void;
function $convertFromMarkdownString(
  markdown: string,
  transformers: Transformer[] = TRANSFORMERS,
  node?: ElementNode,
  shouldPreserveNewLines: boolean | MarkdownImportOptions = false,
  shouldMergeAdjacentLines = false,
): void {
  const root = node || $getRoot();
  root.clear();
  $importMarkdown(
    markdown,
    root,
    transformers,
    toImportOptions(shouldPreserveNewLines, shouldMergeAdjacentLines),
  );
  if ($getSelection() !== null) {
    root.selectStart();
  }
}

/**
 * Parses a markdown string and returns the resulting nodes as an array,
 * without modifying the document tree or selection. The returned nodes can be
 * inserted at an arbitrary position via `selection.insertNodes()`.
 *
 *  @param {boolean | MarkdownImportOptions} [shouldPreserveNewLines] By setting this to true, new lines will be preserved between conversions. {@link MarkdownImportOptions} can be passed here instead, in place of this and `shouldMergeAdjacentLines`.
 *  @param {boolean} [shouldMergeAdjacentLines] By setting this to true, adjacent non empty lines will be merged according to commonmark spec: https://spec.commonmark.org/0.24/#example-177. Not applicable if shouldPreserveNewLines = true.
 */
function $generateNodesFromMarkdownString(
  markdown: string,
  transformers?: Transformer[],
  options?: MarkdownImportOptions,
): LexicalNode[];
function $generateNodesFromMarkdownString(
  markdown: string,
  transformers?: Transformer[],
  shouldPreserveNewLines?: boolean,
  shouldMergeAdjacentLines?: boolean,
): LexicalNode[];
function $generateNodesFromMarkdownString(
  markdown: string,
  transformers: Transformer[] = TRANSFORMERS,
  shouldPreserveNewLines: boolean | MarkdownImportOptions = false,
  shouldMergeAdjacentLines = false,
): LexicalNode[] {
  const container = new ArtificialNode__DO_NOT_USE();
  $importMarkdown(
    markdown,
    container,
    transformers,
    toImportOptions(shouldPreserveNewLines, shouldMergeAdjacentLines),
  );
  return container.getChildren();
}

function toExportOptions(
  options: boolean | MarkdownExportOptions,
): MarkdownExportOptions {
  return typeof options === 'boolean'
    ? {shouldPreserveNewLines: options}
    : options;
}

/**
 * Renders string from markdown. The selection is moved to the start after the operation.
 *
 *  @param {boolean | MarkdownExportOptions} [shouldPreserveNewLines] By setting this to true, new lines will be preserved between conversions; or {@link MarkdownExportOptions}.
 */
function $convertToMarkdownString(
  transformers: Transformer[] = TRANSFORMERS,
  node?: ElementNode,
  shouldPreserveNewLines: boolean | MarkdownExportOptions = false,
): string {
  const options = toExportOptions(shouldPreserveNewLines);
  return withExportPunctuation(options.punctuation, () =>
    createMarkdownExport(transformers, options.shouldPreserveNewLines)(node),
  );
}

/**
 * Converts the selected content to a markdown string.
 *
 *  @param {boolean | MarkdownExportOptions} [shouldPreserveNewLines] By setting this to true, new lines will be preserved between conversions; or {@link MarkdownExportOptions}.
 */
function $convertSelectionToMarkdownString(
  transformers: Transformer[] = TRANSFORMERS,
  selection: BaseSelection | null,
  shouldPreserveNewLines: boolean | MarkdownExportOptions = false,
): string {
  if (!selection || ($isRangeSelection(selection) && selection.isCollapsed())) {
    return '';
  }
  const options = toExportOptions(shouldPreserveNewLines);
  return withExportPunctuation(options.punctuation, () =>
    createSelectionMarkdownExport(
      transformers,
      options.shouldPreserveNewLines,
    )(selection),
  );
}

export {
  $convertFromMarkdownString,
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  $generateNodesFromMarkdownString,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  CHECK_LIST,
  CODE,
  ELEMENT_TRANSFORMERS,
  type ElementTransformer,
  HEADING,
  HIGHLIGHT,
  INLINE_CODE,
  isTableRowDivider,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  MULTILINE_ELEMENT_TRANSFORMERS,
  type MultilineElementTransformer,
  ORDERED_LIST,
  type PunctuationMode,
  QUOTE,
  registerMarkdownShortcuts,
  STRIKETHROUGH,
  TEXT_FORMAT_TRANSFORMERS,
  TEXT_MATCH_TRANSFORMERS,
  type TextFormatTransformer,
  type TextMatchTransformer,
  type Transformer,
  TRANSFORMERS,
  UNORDERED_LIST,
};
