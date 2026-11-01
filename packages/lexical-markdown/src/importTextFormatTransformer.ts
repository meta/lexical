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

import {PUNCTUATION, WHITESPACE} from './utils';

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
): {
  startIndex: number;
  endIndex: number;
  transformer: TextFormatTransformer;
  match: RegExpMatchArray;
  // True when the outermost format is a code span. Code spans are atomic: their
  // content is never reprocessed and they bind tighter than text-match
  // transformers, so this is tagged here rather than re-derived by callers.
  isCodeSpan: boolean;
} | null {
  const textContent = textNode.getTextContent();

  // Find code spans first. Emphasis delimiters inside inline elements (e.g., code spans)
  // should not be processed. Currently only code spans are handled; other inline elements
  // (e.g., links, raw HTML) may need similar treatment in the future.
  const codeTransformer = textFormatTransformersIndex.transformersByTag['`'];

  const excludeRanges: {start: number; end: number}[] = [];
  let codeMatch = null;
  if (codeTransformer) {
    const codeSpans = scanCodeSpans(textContent);

    for (const span of codeSpans) {
      if (!codeMatch) {
        codeMatch = {
          content: span.content,
          endIndex: span.endIndex,
          startIndex: span.startIndex,
          tag: '`',
        };
      }

      excludeRanges.push({
        end: span.endIndex,
        start: span.startIndex,
      });
    }
  }

  const delimiters = scanDelimiters(
    textContent,
    textFormatTransformersIndex,
    excludeRanges,
  );
  const emphasisMatch =
    delimiters.length > 0
      ? processEmphasis(textContent, delimiters, textFormatTransformersIndex)
      : null;

  let resultMatch = null;
  let resultTransformer = null;

  if (codeMatch && emphasisMatch) {
    if (
      emphasisMatch.startIndex <= codeMatch.startIndex &&
      emphasisMatch.endIndex >= codeMatch.endIndex
    ) {
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
  const isEscaped = (index: number): boolean => {
    let count = 0;
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
      count++;
    }
    return count % 2 === 1;
  };

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
    if (isEscaped(opener.index)) {
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
  excludeRanges: {start: number; end: number}[] = [],
): Delimiter[] {
  const delimiters: Delimiter[] = [];
  const delimiterChars = new Set(
    Object.keys(transformersIndex.transformersByTag)
      .filter(tag => tag[0] !== '`')
      .map(tag => tag[0]),
  );

  const isEscaped = (index: number): boolean => {
    let count = 0;
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
      count++;
    }
    return count % 2 === 1;
  };

  const isInExcludedRange = (index: number): boolean => {
    return excludeRanges.some(
      range => index >= range.start && index < range.end,
    );
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i];

    if (!delimiterChars.has(char) || isEscaped(i) || isInExcludedRange(i)) {
      i++;
      continue;
    }

    let len = 1;
    while (i + len < text.length && text[i + len] === char) {
      len++;
    }

    const canOpen = canEmphasis(char, text, i, len, true);
    const canClose = canEmphasis(char, text, i, len, false);

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

function canEmphasis(
  char: string,
  text: string,
  index: number,
  length: number,
  isOpen: boolean,
): boolean {
  if (!isFlanking(text, index, length, isOpen)) {
    return false;
  }
  if (char === '*') {
    return true;
  }
  if (char === '_') {
    if (!isFlanking(text, index, length, !isOpen)) {
      return true;
    }
    const adjacentChar = isOpen ? text[index - 1] : text[index + length];
    return adjacentChar !== undefined && PUNCTUATION.test(adjacentChar);
  }
  return true;
}

function isFlanking(
  text: string,
  index: number,
  length: number,
  isLeft: boolean,
): boolean {
  const charBefore = text[index - 1];
  const charAfter = text[index + length];

  const [primary, secondary] = isLeft
    ? [charAfter, charBefore]
    : [charBefore, charAfter];

  if (primary === undefined || WHITESPACE.test(primary)) {
    return false;
  }
  if (!PUNCTUATION.test(primary)) {
    return true;
  }
  return (
    secondary === undefined ||
    WHITESPACE.test(secondary) ||
    PUNCTUATION.test(secondary)
  );
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
