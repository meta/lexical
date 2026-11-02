/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {TextMatchTransformer} from './MarkdownTransformers';
import type {TextNode} from 'lexical';

import {scanCodeSpans} from './importTextFormatTransformer';
import {getLinkLabelOpener, LINK} from './MarkdownTransformers';
import {isEscaped} from './utils';

/**
 * The first link in `text`, starting at the `[` that really opens its text,
 * with none of its syntax inside a code span.
 * The import pattern's lazy label runs from the first `[` to the first `](`,
 * so a literal `[` before the link (`[1] *see* [here](url)`) would otherwise
 * start the match and leave the text between them unparsed. Matching again
 * from the real opener lets that text go through the other transformers.
 */
function matchLink(text: string, regExp: RegExp): RegExpExecArray | null {
  const search = new RegExp(
    regExp.source,
    regExp.flags.replace(/[gy]/g, '') + 'g',
  );
  // Code spans bind tighter than link brackets
  // (https://spec.commonmark.org/0.31.2/#code-spans), so a link whose syntax
  // falls inside one is not a link.
  const codeSpans = text.includes('`') ? scanCodeSpans(text) : [];
  // The spans come in order, so a binary search finds the one that could hold
  // `index`. Returns the end of that span, or -1 outside every span.
  const codeSpanEnd = (index: number) => {
    let low = 0;
    let high = codeSpans.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const {startIndex, endIndex} = codeSpans[middle];
      if (index < startIndex) {
        high = middle - 1;
      } else if (index >= endIndex) {
        low = middle + 1;
      } else {
        return endIndex;
      }
    }
    return -1;
  };
  let match;
  while ((match = search.exec(text)) !== null) {
    const labelEnd =
      match.index + 1 + (match[1] !== undefined ? match[1].length : 0);
    const openerCodeEnd = codeSpanEnd(match.index);
    if (openerCodeEnd !== -1) {
      // No link can open inside this code span.
      search.lastIndex = openerCodeEnd;
      continue;
    }
    if (
      isEscaped(text, match.index) ||
      codeSpanEnd(labelEnd) !== -1 ||
      codeSpanEnd(match.index + match[0].length - 1) !== -1
    ) {
      search.lastIndex = match.index + 1;
      continue;
    }
    const opener = match[1] !== undefined ? getLinkLabelOpener(match[1]) : -1;
    if (opener === null || opener === -1) {
      return match;
    }
    search.lastIndex = match.index + 1 + opener;
  }
  return null;
}

export function findOutermostTextMatchTransformer(
  textNode_: TextNode,
  textMatchTransformers: TextMatchTransformer[],
): {
  startIndex: number;
  endIndex: number;
  transformer: TextMatchTransformer;
  match: RegExpMatchArray;
} | null {
  const textNode = textNode_;

  let foundMatchStartIndex: number | undefined = undefined;
  let foundMatchEndIndex: number | undefined = undefined;
  let foundMatchTransformer: TextMatchTransformer | undefined = undefined;
  let foundMatch: RegExpMatchArray | undefined = undefined;

  for (const transformer of textMatchTransformers) {
    if (!transformer.replace || !transformer.importRegExp) {
      continue;
    }
    const text = textNode.getTextContent();
    // Transformers sharing the built-in link syntax need the same candidate rules.
    const match =
      LINK.importRegExp !== undefined &&
      transformer.importRegExp.source === LINK.importRegExp.source
        ? matchLink(text, transformer.importRegExp)
        : text.match(transformer.importRegExp);

    if (!match) {
      continue;
    }

    const startIndex = match.index || 0;
    const endIndex = transformer.getEndIndex
      ? transformer.getEndIndex(textNode, match)
      : startIndex + match[0].length;

    if (endIndex === false) {
      continue;
    }

    if (
      foundMatchStartIndex === undefined ||
      foundMatchEndIndex === undefined ||
      // Wraps previous match or is strictly before it.
      (startIndex < foundMatchStartIndex &&
        (endIndex > foundMatchEndIndex || endIndex <= foundMatchStartIndex))
    ) {
      foundMatchStartIndex = startIndex;
      foundMatchEndIndex = endIndex;
      foundMatchTransformer = transformer;
      foundMatch = match;
    }
  }

  if (
    foundMatchStartIndex === undefined ||
    foundMatchEndIndex === undefined ||
    foundMatchTransformer === undefined ||
    foundMatch === undefined
  ) {
    return null;
  }

  return {
    endIndex: foundMatchEndIndex,
    match: foundMatch,
    startIndex: foundMatchStartIndex,
    transformer: foundMatchTransformer,
  };
}

export function importFoundTextMatchTransformer(
  textNode: TextNode,
  startIndex: number,
  endIndex: number,
  transformer: TextMatchTransformer,
  match: RegExpMatchArray,
): {
  matchedNode: TextNode;
  transformedNode?: TextNode;
  nodeBefore: TextNode | undefined; // If split
  nodeAfter: TextNode | undefined; // If split
} | null {
  let transformedNode, nodeAfter, nodeBefore;

  if (startIndex === 0) {
    [transformedNode, nodeAfter] = textNode.splitText(endIndex);
  } else {
    [nodeBefore, transformedNode, nodeAfter] = textNode.splitText(
      startIndex,
      endIndex,
    );
  }

  if (!transformer.replace) {
    return null;
  }
  const potentialTransformedNode = transformer.replace(transformedNode, match);

  return {
    matchedNode: transformedNode,
    nodeAfter,
    nodeBefore,
    transformedNode: potentialTransformedNode || undefined,
  };
}
