/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {TextFormatTransformersIndex} from './MarkdownImport';
import type {TextMatchTransformer} from './MarkdownTransformers';

import {$isTextNode, type LexicalNode, type TextNode} from 'lexical';

import {
  findOutermostTextFormatTransformer,
  importTextFormatTransformer,
} from './importTextFormatTransformer';
import {
  findOutermostTextMatchTransformer,
  importFoundTextMatchTransformer,
} from './importTextMatchTransformer';
import {unescapeText} from './utils';

/**
 * Returns true if the node can contain transformable markdown.
 * Code nodes cannot contain transformable markdown.
 * For example, `code **bold**` should not be transformed to
 * <code>code <strong>bold</strong></code>.
 */
export function canContainTransformableMarkdown(
  node: LexicalNode | undefined,
): node is TextNode {
  return $isTextNode(node) && !node.hasFormat('code');
}

/**
 * Handles applying both text format and text match transformers.
 * It finds the outermost text format or text match and applies it,
 * then recursively calls itself to apply the next outermost transformer,
 * until there are no more transformers to apply.
 */
export function importTextTransformers(
  textNode: TextNode,
  textFormatTransformersIndex: TextFormatTransformersIndex,
  textMatchTransformers: TextMatchTransformer[],
) {
  let foundTextFormat = findOutermostTextFormatTransformer(
    textNode,
    textFormatTransformersIndex,
  );

  let foundTextMatch = findOutermostTextMatchTransformer(
    textNode,
    textMatchTransformers,
  );

  if (foundTextFormat && foundTextMatch) {
    if (foundTextFormat.isCodeSpan) {
      // Code spans bind tighter than text-match transformers (e.g. equations
      // or links). A code span must never be partially consumed by a text
      // match, so prefer the code format unless the text match fully wraps it
      // (in which case the code span is part of the match's raw content).
      // https://github.com/meta/lexical/issues/8687
      if (
        foundTextMatch.startIndex <= foundTextFormat.startIndex &&
        foundTextMatch.endIndex >= foundTextFormat.endIndex
      ) {
        // foundTextMatch wraps the code span - apply foundTextMatch
        foundTextFormat = null;
      } else {
        // Apply the code span
        foundTextMatch = null;
      }
    } else if (
      // Find the outermost transformer
      (foundTextFormat.startIndex <= foundTextMatch.startIndex &&
        foundTextFormat.endIndex >= foundTextMatch.endIndex) ||
      // foundTextMatch is not contained within foundTextFormat
      foundTextMatch.startIndex > foundTextFormat.endIndex
    ) {
      // foundTextFormat wraps foundTextMatch - apply foundTextFormat by setting foundTextMatch to null
      foundTextMatch = null;
    } else {
      // foundTextMatch wraps foundTextFormat - apply foundTextMatch by setting foundTextFormat to null
      foundTextFormat = null;
    }
  }

  if (foundTextFormat) {
    const result = importTextFormatTransformer(
      textNode,
      foundTextFormat.startIndex,
      foundTextFormat.endIndex,
      foundTextFormat.transformer,
      foundTextFormat.match,
    );

    if (canContainTransformableMarkdown(result.nodeAfter)) {
      importTextTransformers(
        result.nodeAfter,
        textFormatTransformersIndex,
        textMatchTransformers,
      );
    }
    if (canContainTransformableMarkdown(result.nodeBefore)) {
      importTextTransformers(
        result.nodeBefore,
        textFormatTransformersIndex,
        textMatchTransformers,
      );
    }
    if (canContainTransformableMarkdown(result.transformedNode)) {
      importTextTransformers(
        result.transformedNode,
        textFormatTransformersIndex,
        textMatchTransformers,
      );
    }
  } else if (foundTextMatch) {
    const result = importFoundTextMatchTransformer(
      textNode,
      foundTextMatch.startIndex,
      foundTextMatch.endIndex,
      foundTextMatch.transformer,
      foundTextMatch.match,
    );
    if (!result) {
      return;
    }

    if (canContainTransformableMarkdown(result.nodeAfter)) {
      importTextTransformers(
        result.nodeAfter,
        textFormatTransformersIndex,
        textMatchTransformers,
      );
    }
    if (canContainTransformableMarkdown(result.nodeBefore)) {
      importTextTransformers(
        result.nodeBefore,
        textFormatTransformersIndex,
        textMatchTransformers,
      );
    }
    if (canContainTransformableMarkdown(result.transformedNode)) {
      importTextTransformers(
        result.transformedNode,
        textFormatTransformersIndex,
        textMatchTransformers,
      );
    } else if (
      result.transformedNode === undefined &&
      canContainTransformableMarkdown(result.matchedNode) &&
      result.matchedNode.getParent() !== null
    ) {
      // A void return may leave the matched node in place or move it into a
      // new parent. Read its escapes once without trying the same match again.
      // A parent also exists when importing into a detached tree.
      result.matchedNode.setTextContent(
        unescapeText(result.matchedNode.getTextContent()),
      );
    }
  }

  // Handle escape characters. Only a node that no transformer matched is
  // unescaped here: retained non-code results above have already had their
  // escapes read, and code spans must keep their backslashes.
  if (!foundTextFormat && !foundTextMatch) {
    const textContent = textNode.getTextContent();
    const unescapedText = unescapeText(textContent);
    textNode.setTextContent(unescapedText);
  }
}
