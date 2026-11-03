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
  getDelimiterRunEdge,
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

interface FormatMatch {
  startIndex: number;
  endIndex: number;
  tag: string;
  content: string;
}

/**
 * The code spans and outermost emphasis of a text, found once and read again
 * for what is left of the text after each match, at `offset`. A match there
 * starts with the code span at `nextCodeSpan` or the emphasis at
 * `nextEmphasis`.
 */
export interface FormatScan {
  text: string;
  /** The characters that start an emphasis tag. */
  delimiters: Set<string>;
  codeSpans: FormatMatch[];
  emphasis: FormatMatch[];
  offset: number;
  nextCodeSpan: number;
  nextEmphasis: number;
  /** An emphasis that starts at `offset`, found after the scan. */
  pending: FormatMatch | undefined;
}

export function scanTextFormats(
  text: string,
  textFormatTransformersIndex: TextFormatTransformersIndex,
  before: string | undefined,
  after: string | undefined,
): FormatScan {
  // Find code spans first. Emphasis delimiters inside inline elements (e.g., code spans)
  // should not be processed. Currently only code spans are handled; other inline elements
  // (e.g., links, raw HTML) may need similar treatment in the future.
  const codeSpans = textFormatTransformersIndex.transformersByTag['`']
    ? scanCodeSpans(text).map(span => ({...span, tag: '`'}))
    : [];
  const delimiterChars = new Set(
    Object.keys(textFormatTransformersIndex.transformersByTag)
      .filter(tag => tag[0] !== '`')
      .map(tag => tag[0]),
  );
  const delimiters = scanDelimiters(
    text,
    delimiterChars,
    codeSpans,
    before,
    after,
  );
  return {
    codeSpans,
    delimiters: delimiterChars,
    emphasis:
      delimiters.length > 0
        ? processEmphasis(text, delimiters, textFormatTransformersIndex)
        : [],
    nextCodeSpan: 0,
    nextEmphasis: 0,
    offset: 0,
    pending: undefined,
    text,
  };
}

/**
 * Moves `scan` on to the text after `offset`, where a match ends. What it
 * found there holds for that text on its own as long as no code span or
 * emphasis runs on from before `offset` (a pair cannot reach past the end of
 * the outermost one), no backslash before it escapes it, and no run of a
 * delimiter or backtick goes on across it; returns false otherwise. A
 * closing run that the end of a format match cuts is the exception: the scan
 * measured it by what was left of it, as a scan of the rest does.
 */
export function advanceFormatScan(
  scan: FormatScan,
  offset: number,
  isFormatEnd: boolean,
): boolean {
  const {codeSpans, emphasis, pending, text} = scan;
  scan.offset = offset;
  scan.pending = undefined;
  if (pending !== undefined && pending.endIndex > offset) {
    return false;
  }
  while (
    scan.nextCodeSpan < codeSpans.length &&
    codeSpans[scan.nextCodeSpan].startIndex < offset
  ) {
    if (codeSpans[scan.nextCodeSpan++].endIndex > offset) {
      return false;
    }
  }
  while (
    scan.nextEmphasis < emphasis.length &&
    emphasis[scan.nextEmphasis].startIndex < offset
  ) {
    if (emphasis[scan.nextEmphasis++].endIndex > offset) {
      return false;
    }
  }
  const cut = text[offset - 1];
  return (
    cut !== '\\' &&
    // A pair found after the scan cut a run that the scan measured whole.
    ((isFormatEnd && pending === undefined) ||
      cut !== text[offset] ||
      (cut !== '`' && !scan.delimiters.has(cut)))
  );
}

/**
 * Lets `scan`, moved on to `rest` by {@link advanceFormatScan}, read the
 * delimiter run that starts `rest` beside the edge of a line rather than
 * beside what came before, where it opened or closed otherwise. Nothing in
 * `rest` comes before the run, so the rest reads the same either way but for
 * the pair the run opens, which nothing in `rest` can hold, and whatever
 * pairs across its end, which `advanceFormatScan` turns down there. The pair
 * ends before a code span that the scan found next, which is imported first
 * as it is with the match before it, and it is found in ever longer prefixes
 * of `rest`, so that finding it costs about as much as the text it holds.
 * Returns false when the rest has to be scanned again.
 */
export function findPairAtEdge(
  scan: FormatScan,
  rest: string,
  textFormatTransformersIndex: TextFormatTransformersIndex,
): boolean {
  const {codeSpans, offset} = scan;
  let span = scan.nextCodeSpan;
  const next = scan.emphasis[scan.nextEmphasis];
  const end =
    span < codeSpans.length &&
    (!next || codeSpans[span].startIndex < next.startIndex)
      ? codeSpans[span].startIndex - offset
      : rest.length;
  for (let length = 64; ; length *= 2) {
    // Cut neither a code span nor a run of a delimiter or backtick.
    while (
      span < codeSpans.length &&
      codeSpans[span].endIndex <= offset + length
    ) {
      span++;
    }
    if (
      span < codeSpans.length &&
      codeSpans[span].startIndex < offset + length
    ) {
      length = codeSpans[span].endIndex - offset;
    }
    if (
      length < end &&
      (rest[length - 1] === '`' || scan.delimiters.has(rest[length - 1]))
    ) {
      length = getDelimiterRunEdge(rest, length, 1);
    }
    if (length >= end) {
      if (end === rest.length) {
        return false;
      }
      length = end;
    }
    const pair = scanTextFormats(
      rest.slice(0, length),
      textFormatTransformersIndex,
      undefined,
      characterAt(rest, length),
    ).emphasis[0];
    if (pair !== undefined && pair.startIndex === 0) {
      scan.pending = {
        ...pair,
        endIndex: pair.endIndex + offset,
        startIndex: offset,
      };
      return true;
    }
    if (length === end) {
      return true;
    }
  }
}

/**
 * Whether the text from `startIndex` to `endIndex` after `scan`'s offset
 * holds part of a code span but not all of it.
 */
export function partlyHoldsCodeSpan(
  scan: FormatScan,
  startIndex: number,
  endIndex: number,
): boolean {
  const {codeSpans, offset} = scan;
  for (let i = scan.nextCodeSpan; i < codeSpans.length; i++) {
    const spanStart = codeSpans[i].startIndex - offset;
    const spanEnd = codeSpans[i].endIndex - offset;
    if (spanStart >= endIndex) {
      break;
    }
    if (
      spanEnd > startIndex &&
      (spanStart < startIndex || spanEnd > endIndex)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The outermost format match in `text`, what is left after `scan`'s offset of
 * the text it scanned.
 */
export function findOutermostTextFormatTransformer(
  text: string,
  textFormatTransformersIndex: TextFormatTransformersIndex,
  scan: FormatScan,
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
  const codeMatch: FormatMatch | undefined = scan.codeSpans[scan.nextCodeSpan];
  const emphasisMatch: FormatMatch | undefined =
    scan.pending ?? scan.emphasis[scan.nextEmphasis];
  // Delimiters inside a code span were excluded, so an emphasis match that
  // starts first either holds the whole span or ends before it, and either
  // way it is applied first.
  const resultMatch =
    emphasisMatch !== undefined &&
    (codeMatch === undefined ||
      emphasisMatch.startIndex <= codeMatch.startIndex)
      ? emphasisMatch
      : codeMatch;
  if (resultMatch === undefined) {
    return null;
  }
  const isCodeSpan = resultMatch === codeMatch;
  const transformer =
    textFormatTransformersIndex.transformersByTag[resultMatch.tag];
  if (!transformer) {
    return null;
  }
  const {offset} = scan;
  const startIndex = resultMatch.startIndex - offset;
  const endIndex = resultMatch.endIndex - offset;
  const regexMatch: RegExpMatchArray = [
    text.slice(startIndex, endIndex),
    resultMatch.tag,
    resultMatch.content,
  ];
  regexMatch.index = startIndex;
  regexMatch.input = text;

  return {
    endIndex,
    isCodeSpan,
    match: regexMatch,
    startIndex,
    transformer,
  };
}

// Finds all inline code spans, left to right and non-overlapping, per CommonMark
// rules: https://spec.commonmark.org/#code-spans. A run opens a span and the
// next run of equal length closes it. An escaped backtick (`\``) is literal,
// and the rest of its run may open a span, but backslashes are otherwise
// literal and don't prevent closing.
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

  // The runs of each length, in order, to find a closer in, and how many of
  // them the openers, which only move forward, have passed.
  const runsByLength = new Map<number, number[]>();
  runs.forEach(({length}, index) => {
    const indexes = runsByLength.get(length);
    if (indexes) {
      indexes.push(index);
    } else {
      runsByLength.set(length, [index]);
    }
  });
  const passed = new Map<number, number>();
  // The first run after `index` that is `length` long, or -1.
  const findCloser = (index: number, length: number): number => {
    const indexes = runsByLength.get(length);
    if (indexes === undefined) {
      return -1;
    }
    let next = passed.get(length) || 0;
    while (next < indexes.length && indexes[next] <= index) {
      next++;
    }
    passed.set(length, next);
    return next < indexes.length ? indexes[next] : -1;
  };

  const spans: {content: string; endIndex: number; startIndex: number}[] = [];
  let openIdx = 0;
  while (openIdx < runs.length) {
    let opener = runs[openIdx];

    // An escaped backtick is a literal backtick, and the rest of its run is
    // a run of its own that can open a span. Inside a span a backslash is
    // literal, so the whole run still closes one.
    if (isEscaped(text, opener.index)) {
      if (opener.length === 1) {
        openIdx++;
        continue;
      }
      opener = {index: opener.index + 1, length: opener.length - 1};
    }

    const closeIdx = findCloser(openIdx, opener.length);

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
  delimiterChars: Set<string>,
  codeSpans: {startIndex: number; endIndex: number}[],
  // What a run at the start (or end) of the text sees beyond it; the edge of
  // the line when undefined.
  before: string | undefined,
  after: string | undefined,
): Delimiter[] {
  const delimiters: Delimiter[] = [];

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

    const len = getDelimiterRunEdge(text, i + 1, 1) - i;

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

/** The outermost emphasis matches, in order. */
function processEmphasis(
  text: string,
  delimiters: Delimiter[],
  transformersIndex: TextFormatTransformersIndex,
): FormatMatch[] {
  const openersBottom: Record<string, number> = {};
  let currentPos = 0;
  const matches: FormatMatch[] = [];

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

      matches.push(match);

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

  // Pairs nest, so the outermost ones are those that no earlier one holds.
  matches.sort(
    (a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex,
  );
  const outermost: FormatMatch[] = [];
  for (const match of matches) {
    if (
      outermost.length === 0 ||
      match.startIndex >= outermost[outermost.length - 1].endIndex
    ) {
      outermost.push(match);
    }
  }
  return outermost;
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
