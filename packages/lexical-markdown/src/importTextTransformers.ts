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
import {characterAt, characterBefore, isEscaped, unescapeText} from './utils';

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
 * What a delimiter run cut at `index` of `text` sees beyond its far end once
 * the text is split there: before the run that starts at `index` when `step`
 * is -1, after the run that ends there when it is 1. `outside` is what lies
 * beyond the text.
 */
function characterBeyondRun(
  text: string,
  index: number,
  step: 1 | -1,
  outside: string | undefined,
): string | undefined {
  const isInside = (edge: number) =>
    step === 1 ? edge < text.length : edge > 0;
  const delimiter = text[step === 1 ? index - 1 : index];
  let edge = index;
  // An escaped delimiter before the run is not part of it.
  while (
    isInside(edge) &&
    text[step === 1 ? edge : edge - 1] === delimiter &&
    (step === 1 || !isEscaped(text, edge - 1))
  ) {
    edge += step;
  }
  return !isInside(edge)
    ? outside
    : step === 1
      ? characterAt(text, edge)
      : characterBefore(text, edge);
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
  // The characters around this text in the text it was split from, so that
  // a delimiter run at its edge reads as it did there.
  before?: string,
  after?: string,
) {
  const text = textNode.getTextContent();
  let foundTextFormat = findOutermostTextFormatTransformer(
    textNode,
    textFormatTransformersIndex,
    before,
    after,
  );

  let foundTextMatch = findOutermostTextMatchTransformer(
    textNode,
    textMatchTransformers,
  );

  if (foundTextFormat && foundTextMatch) {
    // Code spans bind tighter than text-match transformers (e.g. equations
    // or links). A code span must never be partially consumed by a text
    // match, so the match goes only when it fully wraps the span (in which
    // case the span is part of the match's raw content).
    // https://github.com/meta/lexical/issues/8687
    const {startIndex, endIndex} = foundTextMatch;
    const wraps = (span: {startIndex: number; endIndex: number}) =>
      startIndex <= span.startIndex && endIndex >= span.endIndex;
    if (
      foundTextFormat.codeSpans.some(
        span =>
          startIndex < span.endIndex &&
          endIndex > span.startIndex &&
          !wraps(span),
      )
    ) {
      // Apply the code span, or the emphasis before it, and not the text
      // match, which would take part of the span.
      foundTextMatch = null;
    } else if (foundTextFormat.isCodeSpan) {
      // The text match goes first when it wraps the code span or ends before
      // it; one after it waits for the span.
      if (wraps(foundTextFormat) || endIndex <= foundTextFormat.startIndex) {
        foundTextFormat = null;
      } else {
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

  // Imports the text left on either side of a match from `startIndex` to
  // `endIndex`, each with what lies beyond the run cut at its edge.
  const importAround = (
    nodeBefore: LexicalNode | undefined,
    nodeAfter: LexicalNode | undefined,
    startIndex: number,
    endIndex: number,
  ) => {
    if (canContainTransformableMarkdown(nodeAfter)) {
      importTextTransformers(
        nodeAfter,
        textFormatTransformersIndex,
        textMatchTransformers,
        characterBeyondRun(text, endIndex, -1, before),
        after,
      );
    }
    if (canContainTransformableMarkdown(nodeBefore)) {
      importTextTransformers(
        nodeBefore,
        textFormatTransformersIndex,
        textMatchTransformers,
        before,
        characterBeyondRun(text, startIndex, 1, after),
      );
    }
  };

  if (foundTextFormat) {
    const result = importTextFormatTransformer(
      textNode,
      foundTextFormat.startIndex,
      foundTextFormat.endIndex,
      foundTextFormat.transformer,
      foundTextFormat.match,
    );
    const {startIndex, endIndex} = foundTextFormat;
    const tagLength = foundTextFormat.match[1].length;
    importAround(result.nodeBefore, result.nodeAfter, startIndex, endIndex);
    if (canContainTransformableMarkdown(result.transformedNode)) {
      // A code span's fence is not its tag's length, and its content is not
      // read for emphasis against what lies outside it.
      const {isCodeSpan} = foundTextFormat;
      importTextTransformers(
        result.transformedNode,
        textFormatTransformersIndex,
        textMatchTransformers,
        isCodeSpan
          ? undefined
          : characterBeyondRun(text, startIndex + tagLength, -1, before),
        isCodeSpan
          ? undefined
          : characterBeyondRun(text, endIndex - tagLength, 1, after),
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
    importAround(
      result.nodeBefore,
      result.nodeAfter,
      foundTextMatch.startIndex,
      foundTextMatch.endIndex,
    );
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
    textNode.setTextContent(unescapeText(text));
  }
}
