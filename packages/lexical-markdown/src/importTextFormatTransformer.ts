/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {TextFormatTransformersIndex} from './MarkdownImport';
import type {TextFormatTransformer} from './MarkdownTransformers';
import type {TextNode} from 'lexical';

import {
  characterAt,
  characterBefore,
  getEmphasisSides,
  isEscaped,
} from './utils';

interface Delimiter {
  index: number;
  char: string;
  length: number;
  canOpen: boolean;
  canClose: boolean;
  active: boolean;
}

export function findOutermostTextFormatTransformer(
  textNode: TextNode,
  textFormatTransformersIndex: TextFormatTransformersIndex,
  before?: string,
  after?: string,
): {
  startIndex: number;
  endIndex: number;
  transformer: TextFormatTransformer;
  match: RegExpMatchArray;
  // True when the outermost format is a code span. Code spans are atomic: their
  // content is never reprocessed and they bind tighter than text-match
  // transformers, so this is tagged here rather than re-derived by callers.
  isCodeSpan: boolean;
  // The code spans, which a text-match transformer must not take part of
  // even when an emphasis match around or before them is applied first.
  codeSpans: {startIndex: number; endIndex: number}[];
} | null {
  const textContent = textNode.getTextContent();

  // Find code spans first. Emphasis delimiters inside inline elements (e.g., code spans)
  // should not be processed. Currently only code spans are handled; other inline elements
  // (e.g., links, raw HTML) may need similar treatment in the future.
  const codeTransformer = textFormatTransformersIndex.transformersByTag['`'];

  const codeSpans = codeTransformer ? scanCodeSpans(textContent) : [];
  const codeMatch = codeSpans.length > 0 ? {...codeSpans[0], tag: '`'} : null;

  const delimiters = scanDelimiters(
    textContent,
    textFormatTransformersIndex,
    codeSpans,
    before,
    after,
  );
  const emphasisMatch =
    delimiters.length > 0
      ? processEmphasis(textContent, delimiters, textFormatTransformersIndex)
      : null;

  let resultMatch = null;
  let resultTransformer = null;

  if (codeMatch && emphasisMatch) {
    // Delimiters inside the code span were excluded, so an emphasis match
    // that starts first either holds the whole span or ends before it, and
    // either way it is applied first.
    if (emphasisMatch.startIndex <= codeMatch.startIndex) {
      resultMatch = emphasisMatch;
      resultTransformer =
        textFormatTransformersIndex.transformersByTag[emphasisMatch.tag];
    } else {
      resultMatch = codeMatch;
      resultTransformer = codeTransformer;
    }
  } else if (codeMatch) {
    resultMatch = codeMatch;
    resultTransformer = codeTransformer;
  } else if (emphasisMatch) {
    resultMatch = emphasisMatch;
    resultTransformer =
      textFormatTransformersIndex.transformersByTag[emphasisMatch.tag];
  }

  if (!resultMatch || !resultTransformer) {
    return null;
  }

  const regexMatch: RegExpMatchArray = [
    textContent.slice(resultMatch.startIndex, resultMatch.endIndex),
    resultMatch.tag,
    resultMatch.content,
  ];
  regexMatch.index = resultMatch.startIndex;
  regexMatch.input = textContent;

  return {
    codeSpans,
    endIndex: resultMatch.endIndex,
    // resultTransformer is the registered code transformer (by identity)
    // exactly when the chosen match is the code span.
    isCodeSpan: resultTransformer === codeTransformer,
    match: regexMatch,
    startIndex: resultMatch.startIndex,
    transformer: resultTransformer,
  };
}

// Finds all inline code spans, left to right and non-overlapping, per CommonMark
// rules: https://spec.commonmark.org/#code-spans. A run opens a span and the
// next run of equal length closes it. An escaped backtick (`\``) cannot open a
// span, but backslashes are otherwise literal and don't prevent closing.
export function scanCodeSpans(text: string): {
  startIndex: number;
  endIndex: number;
  content: string;
}[] {
  // Collect maximal backtick runs.
  const runs: {index: number; length: number}[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      let length = 1;
      while (i + length < text.length && text[i + length] === '`') {
        length++;
      }
      runs.push({index: i, length});
      i += length;
    } else {
      i++;
    }
  }

  const spans: {content: string; endIndex: number; startIndex: number}[] = [];
  let openIdx = 0;
  while (openIdx < runs.length) {
    const opener = runs[openIdx];

    // An escaped backtick run is a literal backtick and cannot open a span.
    if (isEscaped(text, opener.index)) {
      openIdx++;
      continue;
    }

    let closeIdx = -1;
    for (let c = openIdx + 1; c < runs.length; c++) {
      if (runs[c].length === opener.length) {
        closeIdx = c;
        break;
      }
    }

    if (closeIdx === -1) {
      // No matching closer; treat this run as literal and try the next one.
      openIdx++;
      continue;
    }

    const closer = runs[closeIdx];
    let content = text.slice(opener.index + opener.length, closer.index);
    if (
      content.length >= 2 &&
      content.startsWith(' ') &&
      content.endsWith(' ') &&
      /[^ ]/.test(content)
    ) {
      content = content.slice(1, -1);
    }

    spans.push({
      content,
      endIndex: closer.index + closer.length,
      startIndex: opener.index,
    });
    openIdx = closeIdx + 1;
  }

  return spans;
}

function scanDelimiters(
  text: string,
  transformersIndex: TextFormatTransformersIndex,
  codeSpans: {startIndex: number; endIndex: number}[],
  // What a run at the start (or end) of the text sees beyond it; the edge of
  // the line when undefined.
  before: string | undefined,
  after: string | undefined,
): Delimiter[] {
  const delimiters: Delimiter[] = [];
  const delimiterChars = new Set(
    Object.keys(transformersIndex.transformersByTag)
      .filter(tag => tag[0] !== '`')
      .map(tag => tag[0]),
  );

  // The spans are in order and the scan only moves forward.
  let span = 0;
  const isInCodeSpan = (index: number): boolean => {
    while (span < codeSpans.length && codeSpans[span].endIndex <= index) {
      span++;
    }
    return span < codeSpans.length && index >= codeSpans[span].startIndex;
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i];

    if (!delimiterChars.has(char) || isEscaped(text, i) || isInCodeSpan(i)) {
      i++;
      continue;
    }

    let len = 1;
    while (i + len < text.length && text[i + len] === char) {
      len++;
    }

    const {canOpen, canClose} = getEmphasisSides(
      char,
      i === 0 ? before : characterBefore(text, i),
      i + len === text.length ? after : characterAt(text, i + len),
    );

    if (canOpen || canClose) {
      delimiters.push({
        active: true,
        canClose,
        canOpen,
        char,
        index: i,
        length: len,
      });
    }

    i += len;
  }

  return delimiters;
}

function processEmphasis(
  text: string,
  delimiters: Delimiter[],
  transformersIndex: TextFormatTransformersIndex,
): {
  startIndex: number;
  endIndex: number;
  tag: string;
  content: string;
} | null {
  const openersBottom: Record<string, number> = {};
  let currentPos = 0;
  let result = null;

  while (currentPos < delimiters.length) {
    const closer = delimiters[currentPos];

    if (!closer.active || !closer.canClose || closer.length === 0) {
      currentPos++;
      continue;
    }

    // The "no opener below this point" shortcut must be keyed by everything
    // the opener search outcome depends on: the marker, whether the closer
    // can also open (toggles the rule of 3), and the closer's length mod 3
    // (the rule of 3 blocks different openers per class — CommonMark's
    // openers_bottom is likewise per length-mod-3). The length key uses the
    // *current* length: a partially consumed closer switches class and must
    // rescan openers a shorter closer already gave up on (#4895).
    const bottomKey = `${closer.char}${closer.canOpen}${closer.length % 3}`;
    const bottom = openersBottom[bottomKey] ?? -1;
    let foundOpener = false;

    for (let openIdx = currentPos - 1; openIdx > bottom; openIdx--) {
      const opener = delimiters[openIdx];

      if (
        !opener.active ||
        !opener.canOpen ||
        opener.length === 0 ||
        opener.char !== closer.char
      ) {
        continue;
      }

      // Rule of 3, on the *remaining* lengths: a delimiter run partially
      // consumed by an earlier pairing is re-measured, matching micromark
      // (the CommonMark reference this models). Using the original lengths
      // instead would refuse pairings like the `**` opener with the two
      // markers left of a `****` run in `**llo*wor****`, so the exporter's
      // own output for overlapping formats would not re-import (#4895).
      if (opener.canClose || closer.canOpen) {
        const sum = opener.length + closer.length;
        if (
          sum % 3 === 0 &&
          opener.length % 3 !== 0 &&
          closer.length % 3 !== 0
        ) {
          continue;
        }
      }

      const maxLen = Math.min(opener.length, closer.length);
      const matchedTag = Object.keys(transformersIndex.transformersByTag)
        .filter(t => t[0] === opener.char && t.length <= maxLen)
        .sort((a, b) => b.length - a.length)[0];

      if (!matchedTag) {
        continue;
      }

      foundOpener = true;
      const matchLen = matchedTag.length;
      const match = {
        content: text.slice(opener.index + opener.length, closer.index),
        endIndex: closer.index + matchLen,
        startIndex: opener.index + (opener.length - matchLen),
        tag: matchedTag,
      };

      if (
        !result ||
        match.startIndex < result.startIndex ||
        (match.startIndex === result.startIndex &&
          match.endIndex > result.endIndex)
      ) {
        result = match;
      }

      for (let j = openIdx + 1; j < currentPos; j++) {
        delimiters[j].active = false;
      }

      opener.length -= matchLen;
      closer.length -= matchLen;
      opener.active = opener.length > 0;

      if (closer.length > 0) {
        closer.index += matchLen;
      } else {
        closer.active = false;
        currentPos++;
      }

      break;
    }

    if (!foundOpener) {
      openersBottom[bottomKey] = currentPos - 1;
      if (!closer.canOpen) {
        closer.active = false;
      }
      currentPos++;
    }
  }

  return result;
}

export function importTextFormatTransformer(
  textNode: TextNode,
  startIndex: number,
  endIndex: number,
  transformer: TextFormatTransformer,
  match: RegExpMatchArray,
): {
  transformedNode: TextNode;
  nodeBefore: TextNode | undefined; // If split
  nodeAfter: TextNode | undefined; // If split
} {
  const textContent = textNode.getTextContent();

  // No text matches - we can safely process the text format match
  let transformedNode, nodeAfter, nodeBefore;

  // If matching full content there's no need to run splitText and can reuse existing textNode
  // to update its content and apply format. E.g. for **_Hello_** string after applying bold
  // format (**) it will reuse the same text node to apply italic (_)
  if (match[0] === textContent) {
    transformedNode = textNode;
  } else {
    if (startIndex === 0) {
      [transformedNode, nodeAfter] = textNode.splitText(endIndex);
    } else {
      [nodeBefore, transformedNode, nodeAfter] = textNode.splitText(
        startIndex,
        endIndex,
      );
    }
  }

  transformedNode.setTextContent(match[2]);

  if (transformer) {
    for (const format of transformer.format) {
      if (!transformedNode.hasFormat(format)) {
        transformedNode.toggleFormat(format);
      }
    }
  }

  return {
    nodeAfter: nodeAfter,
    nodeBefore: nodeBefore,
    transformedNode: transformedNode,
  };
}
