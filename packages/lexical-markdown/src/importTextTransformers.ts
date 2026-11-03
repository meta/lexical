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
  advanceFormatScan,
  findOutermostTextFormatTransformer,
  findPairAtEdge,
  type FormatScan,
  importTextFormatTransformer,
  partlyHoldsCodeSpan,
  scanTextFormats,
} from './importTextFormatTransformer';
import {
  findOutermostTextMatchTransformer,
  importFoundTextMatchTransformer,
  type TextMatches,
} from './importTextMatchTransformer';
import {
  characterAt,
  characterBefore,
  getDelimiterRunEdge,
  getEmphasisSides,
  unescapeText,
} from './utils';

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
 * Whether the delimiter run that starts `text` can open or close otherwise
 * beside the edge of a line than beside `before`. Whether it can close
 * matters even with nothing before it, through the rule of 3.
 */
function readsOtherwiseBesideEdge(
  text: string,
  before: string | undefined,
  outside: string | undefined,
): boolean {
  const edge = getDelimiterRunEdge(text, 1, 1);
  const after = edge < text.length ? characterAt(text, edge) : outside;
  const atEdge = getEmphasisSides(text[0], undefined, after);
  const besideBefore = getEmphasisSides(text[0], before, after);
  return (
    atEdge.canOpen !== besideBefore.canOpen ||
    atEdge.canClose !== besideBefore.canClose
  );
}

/** The markers whose runs CommonMark and GFM define. */
const SPEC_MARKERS = '*_~';

/**
 * What a delimiter run cut at `index` of `text` sees beyond its far end once
 * the text is split there: before the run that starts at `index` when `step`
 * is -1, after the run that ends there when it is 1. `outside` is what lies
 * beyond the text. Beside a text match, which is written in a syntax of its
 * own, a run that the cut does not go through sees the edge of a line.
 */
function characterBeyondRun(
  text: string,
  index: number,
  step: 1 | -1,
  outside: string | undefined,
  delimiters: Set<string>,
  isBesideTextMatch = false,
): string | undefined {
  // Only a delimiter's run is walked: beside anything else, what lies beyond
  // is never read, and a long run of it would be walked at every cut.
  const beside = text[step === 1 ? index - 1 : index];
  const edge =
    beside === '`' || delimiters.has(beside)
      ? getDelimiterRunEdge(text, index, step)
      : index;
  if (isBesideTextMatch && edge === index) {
    return undefined;
  }
  return step === 1
    ? edge < text.length
      ? characterAt(text, edge)
      : outside
    : edge > 0
      ? characterBefore(text, edge)
      : outside;
}

/**
 * Handles applying both text format and text match transformers. It finds
 * the outermost text format or text match and applies it, goes on with the
 * text after it the same way, and then, from the last match back to the
 * first, imports the text before each match and then the text inside it,
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
  // The text after each match is imported in this loop rather than by
  // recursion, so that a long paragraph does not nest a call per match, and
  // with what was found in the whole text, which still holds for the rest of
  // it as long as no match there reached into what came before.
  const deferred: Deferred[] = [];
  let rest: TextRest | null = {after, before, node: textNode, scan: null};
  while (rest !== null) {
    rest = importOutermost(
      rest,
      textFormatTransformersIndex,
      textMatchTransformers,
      deferred,
    );
  }
  for (let i = deferred.length - 1; i >= 0; i--) {
    const {outside, inside, matched} = deferred[i];
    importTextPart(outside, textFormatTransformersIndex, textMatchTransformers);
    importTextPart(inside, textFormatTransformersIndex, textMatchTransformers);
    if (
      !canContainTransformableMarkdown(inside.node) &&
      canContainTransformableMarkdown(matched) &&
      matched.getParent() !== null
    ) {
      // A text match transformer that returned no node may leave the matched
      // node in place or move it into a new parent. Read its escapes once
      // without trying the same match again. A parent also exists when
      // importing into a detached tree.
      matched.setTextContent(unescapeText(matched.getTextContent()));
    }
  }
}

/** Text to import, with the characters around it in the text it was cut from. */
interface TextPart {
  node: LexicalNode | undefined;
  before: string | undefined;
  after: string | undefined;
}

function importTextPart(
  {node, before, after}: TextPart,
  textFormatTransformersIndex: TextFormatTransformersIndex,
  textMatchTransformers: TextMatchTransformer[],
) {
  if (canContainTransformableMarkdown(node)) {
    importTextTransformers(
      node,
      textFormatTransformersIndex,
      textMatchTransformers,
      before,
      after,
    );
  }
}

/**
 * What a match leaves to import once the text after it is done: the text
 * before it, then the text inside it, or the escapes of the matched node of
 * a text match that returned no node.
 */
interface Deferred {
  outside: TextPart;
  inside: TextPart;
  matched: LexicalNode | undefined;
}

/**
 * The formats and text matches found in a text, for what is left of it, which is
 * `rest`.
 */
interface TextScan {
  formats: FormatScan;
  matches: TextMatches;
  rest: string;
}

/** The text after a match, and the scan of the text it was cut from. */
interface TextRest {
  node: TextNode;
  before: string | undefined;
  after: string | undefined;
  scan: TextScan | null;
}

/**
 * Applies the outermost transformer in `textNode`, adds the import of the
 * text before and inside its match to `deferred`, and returns the text after
 * it, for the caller to import next.
 */
function importOutermost(
  {node: textNode, before, after, scan: previousScan}: TextRest,
  textFormatTransformersIndex: TextFormatTransformersIndex,
  textMatchTransformers: TextMatchTransformer[],
  deferred: Deferred[],
): TextRest | null {
  const text = textNode.getTextContent();
  const scan: TextScan =
    previousScan !== null && previousScan.rest === text
      ? previousScan
      : {
          formats: scanTextFormats(
            text,
            textFormatTransformersIndex,
            before,
            after,
          ),
          matches: new Map(),
          rest: text,
        };
  const {formats} = scan;
  const {delimiters} = formats;
  let foundTextFormat = findOutermostTextFormatTransformer(
    text,
    textFormatTransformersIndex,
    formats,
  );

  let foundTextMatch = findOutermostTextMatchTransformer(
    textNode,
    textMatchTransformers,
    scan.matches,
    formats.offset,
    // The scan finds code spans only for a code transformer.
    textFormatTransformersIndex.transformersByTag['`']
      ? formats.codeSpans
      : undefined,
  );

  if (foundTextFormat && foundTextMatch) {
    // Code spans bind tighter than text-match transformers (e.g. equations
    // or links). A code span must never be partially consumed by a text
    // match, so the match goes only when it fully wraps the span (in which
    // case the span is part of the match's raw content).
    // https://github.com/meta/lexical/issues/8687
    const {startIndex, endIndex} = foundTextMatch;
    if (partlyHoldsCodeSpan(formats, startIndex, endIndex)) {
      // Apply the code span, or the emphasis before it, and not the text
      // match, which would take part of the span.
      foundTextMatch = null;
    } else if (foundTextFormat.isCodeSpan) {
      // The text match goes first when it wraps the code span or ends before
      // it; one after it waits for the span.
      if (
        (startIndex <= foundTextFormat.startIndex &&
          endIndex >= foundTextFormat.endIndex) ||
        endIndex <= foundTextFormat.startIndex
      ) {
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

  // Defers the import of the text before a match from `startIndex` to
  // `endIndex` and of the text `inside` it (or the escapes of `matched`),
  // and returns the text after it, each with what lies beyond the run cut at
  // its edge. A text match's transformer has run, and when it changed the
  // text after it, that text is imported on its own, as before it was cut
  // from the line; `textAfter` is what that text was before, and `null` for
  // a format match.
  const importAround = (
    {
      nodeBefore,
      nodeAfter,
    }: {
      nodeBefore: LexicalNode | undefined;
      nodeAfter: LexicalNode | undefined;
    },
    textAfter: string | null | undefined,
    startIndex: number,
    endIndex: number,
    inside: TextPart,
    matched: LexicalNode | undefined,
  ): TextRest | null => {
    const isTextMatch = textAfter !== null;
    deferred.push({
      inside,
      matched,
      outside: {
        after: characterBeyondRun(
          text,
          startIndex,
          1,
          after,
          delimiters,
          isTextMatch,
        ),
        before,
        node: nodeBefore,
      },
    });
    if (!canContainTransformableMarkdown(nodeAfter)) {
      return null;
    }
    const rest = nodeAfter.getTextContent();
    if (textAfter !== null && textAfter !== rest) {
      return {after: undefined, before: undefined, node: nodeAfter, scan: null};
    }
    const restBefore = characterBeyondRun(
      text,
      endIndex,
      -1,
      before,
      delimiters,
      isTextMatch,
    );
    // The scan read a run at the start of the rest beside the end of the
    // match. Read beside the edge of a line instead, it can only change the
    // pair it opens, since it has nothing before it in the rest to close.
    let isReusable = advanceFormatScan(
      formats,
      formats.offset + endIndex,
      !isTextMatch,
    );
    if (
      isReusable &&
      isTextMatch &&
      restBefore === undefined &&
      delimiters.has(rest[0]) &&
      readsOtherwiseBesideEdge(rest, characterBefore(text, endIndex), after)
    ) {
      isReusable = findPairAtEdge(formats, rest, textFormatTransformersIndex);
    }
    scan.rest = rest;
    return {
      after,
      before: restBefore,
      node: nodeAfter,
      scan: isReusable ? scan : null,
    };
  };

  if (foundTextFormat) {
    const result = importTextFormatTransformer(
      textNode,
      foundTextFormat.startIndex,
      foundTextFormat.endIndex,
      foundTextFormat.transformer,
      foundTextFormat.match,
    );
    const {startIndex, endIndex, isCodeSpan} = foundTextFormat;
    const tag = foundTextFormat.match[1];
    // The content reads a run at its edge beside the tag, so that it flanks
    // as it does in the line, when it is of a marker that CommonMark or GFM
    // define and the tag does not cut it; otherwise beside the edge of a
    // line, as the rule of 3 would measure a cut run without the part the
    // tag took. A code span's content is not read for emphasis.
    const beside = (char: string) =>
      !isCodeSpan && SPEC_MARKERS.includes(char) && char !== tag[0]
        ? tag[0]
        : undefined;
    return importAround(
      result,
      null,
      startIndex,
      endIndex,
      {
        after: beside(text[endIndex - tag.length - 1]),
        before: beside(text[startIndex + tag.length]),
        node: result.transformedNode,
      },
      undefined,
    );
  } else if (foundTextMatch) {
    const result = importFoundTextMatchTransformer(
      textNode,
      foundTextMatch.startIndex,
      foundTextMatch.endIndex,
      foundTextMatch.transformer,
      foundTextMatch.match,
    );
    if (!result) {
      return null;
    }
    return importAround(
      result,
      result.textAfter,
      foundTextMatch.startIndex,
      foundTextMatch.endIndex,
      {after: undefined, before: undefined, node: result.transformedNode},
      result.transformedNode === undefined ? result.matchedNode : undefined,
    );
  }

  // Handle escape characters. Only a node that no transformer matched gets
  // here: retained non-code results above have already had their escapes
  // read, and code spans must keep their backslashes.
  textNode.setTextContent(unescapeText(text));
  return null;
}
