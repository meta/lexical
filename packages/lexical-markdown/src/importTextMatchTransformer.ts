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
 * A copy of `match` for `text`, which is what is left of the text it was
 * found in after `distance` characters.
 */
function moveMatch(
  match: RegExpExecArray,
  text: string,
  distance: number,
): RegExpExecArray {
  const moved = [...match] as RegExpExecArray;
  moved.index = match.index - distance;
  moved.input = text;
  moved.groups = match.groups;
  if (match.indices) {
    const indices = match.indices.map(
      range => range && [range[0] - distance, range[1] - distance],
    ) as RegExpIndicesArray;
    const {groups} = match.indices;
    if (groups) {
      // Each named group's range is the one of its numbered group.
      const ranges: Record<string, [number, number] | undefined> =
        Object.create(null);
      for (const name in groups) {
        const range = groups[name];
        ranges[name] = range && indices[match.indices.indexOf(range)];
      }
      indices.groups = ranges as typeof groups;
    }
    moved.indices = indices;
  }
  return moved;
}

/** Code spans, in order, from where they start to where they end. */
export type CodeSpans = readonly {startIndex: number; endIndex: number}[];

/**
 * The first link in `text`, starting at the `[` that really opens its text,
 * with none of its syntax inside a code span. `codeSpans` are those of the
 * text that `text` is what is left of after `offset`, when they are known.
 */
function matchLink(
  text: string,
  regExp: RegExp,
  codeSpans: CodeSpans | undefined,
  offset: number,
): RegExpExecArray | null {
  const search = new RegExp(
    regExp.source,
    regExp.flags.replace(/[gy]/g, '') + 'g',
  );
  // Code spans bind tighter than link brackets
  // (https://spec.commonmark.org/0.31.2/#code-spans), so a link whose syntax
  // falls inside one is not a link.
  let spans = codeSpans;
  let spanOffset = offset;
  if (spans === undefined) {
    spans = text.includes('`') ? scanCodeSpans(text) : [];
    spanOffset = 0;
  }
  // The spans come in order, so a binary search finds the one that could
  // hold `index`, or -1 outside every span.
  const codeSpanAt = (index: number) => {
    let low = 0;
    let high = spans.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const {startIndex, endIndex} = spans[middle];
      if (index + spanOffset < startIndex) {
        high = middle - 1;
      } else if (index + spanOffset >= endIndex) {
        low = middle + 1;
      } else {
        return middle;
      }
    }
    return -1;
  };
  // No link starts after the last `](`, and searching from each `[` there
  // would walk on to the end of the text.
  const lastCloser = text.lastIndexOf('](');
  let match;
  while (
    search.lastIndex < lastCloser &&
    (match = search.exec(text)) !== null
  ) {
    const openerSpan = codeSpanAt(match.index);
    if (openerSpan !== -1) {
      // No link can open inside this code span.
      search.lastIndex = spans[openerSpan].endIndex - spanOffset;
      continue;
    }
    const labelEnd = match.index + 1 + match[1].length;
    if (
      codeSpanAt(labelEnd) !== -1 ||
      codeSpanAt(match.index + match[0].length - 1) !== -1
    ) {
      // A search from any `[` before the last character of the label ends
      // at the same `](` and `)`, so it is not a link either.
      search.lastIndex = labelEnd - 1;
      continue;
    }
    // A `[` that the label holds outside a code span is the link's real
    // opener, and what comes before it is ordinary text, so the search goes
    // on from there, where it finds the same link. A link with an empty
    // label, as in `x[[](u)`, stays text, as `[](u)` does.
    const opener = getLinkLabelOpener(match[1]);
    if (opener !== null && opener >= 0) {
      search.lastIndex = match.index + 1 + opener;
      continue;
    }
    if (!isEscaped(text, match.index)) {
      return match;
    }
    // The label of an escaped `[` holds no opener, so each escaped `[` up to
    // the next one written as is finds what the last of them finds: that
    // opener or nothing.
    let next = match.index;
    do {
      next = text.indexOf('[', next + 1);
    } while (next !== -1 && isEscaped(text, next));
    if (next === -1) {
      break;
    }
    const last = text.lastIndexOf('[', next - 1);
    search.lastIndex = last > match.index ? last : next;
  }
  return null;
}

const lookless = new WeakMap<RegExp, boolean>();

/**
 * Whether a match of `regExp` depends only on the text from where it starts
 * on: it has no `^`, word boundary or lookbehind outside a character class,
 * and no flag that makes it keep state. Its first match in what is left of a
 * text after a cut is then the first one found at or after the cut.
 */
function looksOnlyAhead(regExp: RegExp): boolean {
  let result = lookless.get(regExp);
  if (result === undefined) {
    const {source} = regExp;
    result = !/[gyv]/.test(regExp.flags);
    for (let i = 0, inClass = false; result && i < source.length; i++) {
      const character = source[i];
      if (character === '\\') {
        result = inClass || !/[bB]/.test(source[++i]);
      } else if (inClass) {
        inClass = character !== ']';
      } else if (character === '[') {
        inClass = true;
      } else {
        result =
          (character !== '^' && !source.startsWith('(?<', i)) ||
          /^\(\?<[^=!]/.test(source.slice(i, i + 4));
      }
    }
    lookless.set(regExp, result);
  }
  return result;
}

/**
 * The match each text-match transformer found in a text and the offset of
 * the text it was found in, or `null` when there is none. Kept for the built-in link syntax and for patterns that only look
 * ahead, for which it is still the first match in what is left of the text
 * after any offset up to where it was found.
 */
export type TextMatches = Map<
  TextMatchTransformer,
  {match: RegExpExecArray; offset: number} | null
>;

export function findOutermostTextMatchTransformer(
  textNode_: TextNode,
  textMatchTransformers: TextMatchTransformer[],
  // The matches found earlier in the text that `textNode_` is what is left
  // of from `offset`.
  matches: TextMatches = new Map(),
  offset = 0,
  // The code spans of that text, when they are known.
  codeSpans?: CodeSpans,
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
    const {importRegExp} = transformer;
    // Transformers sharing the built-in link syntax need the same candidate
    // rules.
    const isLink =
      LINK.importRegExp !== undefined &&
      importRegExp.source === LINK.importRegExp.source;
    let match: RegExpMatchArray | null;
    if (isLink || looksOnlyAhead(importRegExp)) {
      const found = matches.get(transformer);
      if (
        found === undefined ||
        (found !== null && found.offset + found.match.index < offset)
      ) {
        const result = isLink
          ? matchLink(text, importRegExp, codeSpans, offset)
          : importRegExp.exec(text);
        matches.set(transformer, result && {match: result, offset});
        match = result;
      } else {
        match = found && moveMatch(found.match, text, offset - found.offset);
      }
    } else {
      match = text.match(importRegExp);
    }

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
  // The text of `nodeAfter` before the transformer ran, which may change it.
  textAfter: string | undefined;
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
  const textAfter = nodeAfter && nodeAfter.getTextContent();
  const potentialTransformedNode = transformer.replace(transformedNode, match);

  return {
    matchedNode: transformedNode,
    nodeAfter,
    nodeBefore,
    textAfter,
    transformedNode: potentialTransformedNode || undefined,
  };
}
