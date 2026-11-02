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
  type MarkdownExportOptions,
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

/**
 * Renders markdown from a string. The selection is moved to the start after the operation.
 *
 *  @param {boolean} [shouldPreserveNewLines] By setting this to true, new lines will be preserved between conversions
 *  @param {boolean} [shouldMergeAdjacentLines] By setting this to true, adjacent non empty lines will be merged according to commonmark spec: https://spec.commonmark.org/0.24/#example-177. Not applicable if shouldPreserveNewLines = true.
 */
function $convertFromMarkdownString(
  markdown: string,
  transformers: Transformer[] = TRANSFORMERS,
  node?: ElementNode,
  shouldPreserveNewLines = false,
  shouldMergeAdjacentLines = false,
): void {
  const sanitizedMarkdown = shouldPreserveNewLines
    ? markdown
    : normalizeMarkdown(markdown, shouldMergeAdjacentLines);
  const root = node || $getRoot();
  root.clear();
  $importMarkdownNodes(
    sanitizedMarkdown,
    root,
    transformers,
    shouldPreserveNewLines,
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
 *  @param {boolean} [shouldPreserveNewLines] By setting this to true, new lines will be preserved between conversions
 *  @param {boolean} [shouldMergeAdjacentLines] By setting this to true, adjacent non empty lines will be merged according to commonmark spec: https://spec.commonmark.org/0.24/#example-177. Not applicable if shouldPreserveNewLines = true.
 */
function $generateNodesFromMarkdownString(
  markdown: string,
  transformers: Transformer[] = TRANSFORMERS,
  shouldPreserveNewLines = false,
  shouldMergeAdjacentLines = false,
): LexicalNode[] {
  const sanitizedMarkdown = shouldPreserveNewLines
    ? markdown
    : normalizeMarkdown(markdown, shouldMergeAdjacentLines);
  const container = new ArtificialNode__DO_NOT_USE();
  $importMarkdownNodes(
    sanitizedMarkdown,
    container,
    transformers,
    shouldPreserveNewLines,
  );
  return container.getChildren();
}

/**
 * Renders string from markdown. The selection is moved to the start after the operation.
 */
function $convertToMarkdownString(
  transformers: Transformer[] = TRANSFORMERS,
  node?: ElementNode,
  shouldPreserveNewLines: boolean = false,
  options?: MarkdownExportOptions,
): string {
  const exportMarkdown = createMarkdownExport(
    transformers,
    shouldPreserveNewLines,
    options,
  );
  return exportMarkdown(node);
}

/**
 * Converts the selected content to a markdown string.
 */
function $convertSelectionToMarkdownString(
  transformers: Transformer[] = TRANSFORMERS,
  selection: BaseSelection | null,
  shouldPreserveNewLines: boolean = false,
  options?: MarkdownExportOptions,
): string {
  if (!selection || ($isRangeSelection(selection) && selection.isCollapsed())) {
    return '';
  }
  const exportMarkdown = createSelectionMarkdownExport(
    transformers,
    shouldPreserveNewLines,
    options,
  );
  return exportMarkdown(selection);
}

export type {MarkdownExportOptions};

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
