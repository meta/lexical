/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  ElementTransformer,
  MultilineElementTransformer,
  TextFormatTransformer,
  TextMatchTransformer,
  Transformer,
} from './MarkdownTransformers';

import {$isParagraphNode, $isTextNode, type LexicalNode} from 'lexical';

export function indexBy<T>(
  list: T[],
  callback: (arg0: T) => string | undefined,
): Readonly<Record<string, T[]>> {
  const index: Record<string, T[]> = {};

  for (const item of list) {
    const key = callback(item);

    if (!key) {
      continue;
    }

    if (index[key]) {
      index[key].push(item);
    } else {
      index[key] = [item];
    }
  }

  return index;
}

export function transformersByType(transformers: Transformer[]): Readonly<{
  element: ElementTransformer[];
  multilineElement: MultilineElementTransformer[];
  textFormat: TextFormatTransformer[];
  textMatch: TextMatchTransformer[];
}> {
  const byType = indexBy(transformers, t => t.type);

  return {
    element: (byType.element || []) as ElementTransformer[],
    multilineElement: (byType['multiline-element'] ||
      []) as MultilineElementTransformer[],
    textFormat: (byType['text-format'] || []) as TextFormatTransformer[],
    textMatch: (byType['text-match'] || []) as TextMatchTransformer[],
  };
}

// CommonMark counts every character in the Unicode P (punctuation) and S
// (symbol) general categories as punctuation, which includes all of the ASCII
// punctuation characters. Its Unicode whitespace is Zs plus tab, line feed,
// form feed and carriage return; JavaScript's `\s` adds others, such as
// U+FEFF. Delimiter flanking depends on both.
// https://spec.commonmark.org/0.31.2/#unicode-punctuation-character
// https://spec.commonmark.org/0.31.2/#unicode-whitespace-character
const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /[\p{Zs}\t\n\f\r]/u;

const WHITESPACE_CLASS = 0;
const PUNCTUATION_CLASS = 1;
const OTHER_CLASS = 2;

function classifyByCategory(character: string): number {
  return WHITESPACE.test(character)
    ? WHITESPACE_CLASS
    : PUNCTUATION.test(character)
      ? PUNCTUATION_CLASS
      : OTHER_CLASS;
}

// ASCII classes, filled from the categories on first use so that the common
// case needs no regular expression.
let asciiClasses: Uint8Array | undefined;

/** How flanking sees `character`; the edge of the line is whitespace. */
function classify(character: string | undefined): number {
  if (character === undefined) {
    return WHITESPACE_CLASS;
  }
  const code = character.charCodeAt(0);
  if (code >= 0x80) {
    return classifyByCategory(character);
  }
  if (asciiClasses === undefined) {
    asciiClasses = new Uint8Array(0x80);
    for (let c = 0; c < 0x80; c++) {
      asciiClasses[c] = classifyByCategory(String.fromCharCode(c));
    }
  }
  return asciiClasses[code];
}

/**
 * Whether a delimiter run with `primary` on the side it faces (after it for
 * left-flanking, before it for right-flanking) and `secondary` on the other
 * side is flanking. `undefined` is the edge of the line.
 * https://spec.commonmark.org/0.31.2/#left-flanking-delimiter-run
 */
export function isFlankedBy(
  primary: string | undefined,
  secondary: string | undefined,
): boolean {
  return isFlankedByClass(classify(primary), classify(secondary));
}

function isFlankedByClass(primary: number, secondary: number): boolean {
  return (
    primary === OTHER_CLASS ||
    (primary === PUNCTUATION_CLASS && secondary !== OTHER_CLASS)
  );
}

/**
 * Whether a delimiter run of `marker` between `before` and `after` can open
 * and close emphasis; `_` opens or closes inside a word only beside
 * punctuation.
 * https://spec.commonmark.org/0.31.2/#can-open-emphasis
 */
export function getEmphasisSides(
  marker: string,
  before: string | undefined,
  after: string | undefined,
): {canOpen: boolean; canClose: boolean} {
  const beforeClass = classify(before);
  const afterClass = classify(after);
  const isLeft = isFlankedByClass(afterClass, beforeClass);
  const isRight = isFlankedByClass(beforeClass, afterClass);
  return marker === '_'
    ? {
        canClose: isRight && (!isLeft || afterClass === PUNCTUATION_CLASS),
        canOpen: isLeft && (!isRight || beforeClass === PUNCTUATION_CLASS),
      }
    : {canClose: isRight, canOpen: isLeft};
}

export function isPunctuationOrSpace(character: string): boolean {
  return classify(character) !== OTHER_CLASS;
}

// Readers built on micromark, such as `@lexical/mdast`, read a character
// outside the Basic Multilingual Plane one UTF-16 unit at a time, so as a
// letter, and count JavaScript's whitespace, U+FEFF among it, as whitespace.
// Export has to open and close for those readers as well.
const MICROMARK_ONLY_WHITESPACE = /[\v\u2028\u2029\ufeff]/;
function asMicromarkReads(character: string | undefined): string | undefined {
  return character === undefined
    ? character
    : character.length > 1
      ? 'a'
      : MICROMARK_ONLY_WHITESPACE.test(character)
        ? ' '
        : character;
}

/** {@link isFlankedBy}, both for CommonMark and for micromark. */
export function isPortablyFlankedBy(
  primary: string | undefined,
  secondary: string | undefined,
): boolean {
  return (
    isFlankedBy(primary, secondary) &&
    isFlankedBy(asMicromarkReads(primary), asMicromarkReads(secondary))
  );
}

/** {@link getEmphasisSides}, both for CommonMark and for micromark. */
export function getPortableEmphasisSides(
  marker: string,
  before: string | undefined,
  after: string | undefined,
): {canOpen: boolean; canClose: boolean} {
  const sides = getEmphasisSides(marker, before, after);
  const micromark = getEmphasisSides(
    marker,
    asMicromarkReads(before),
    asMicromarkReads(after),
  );
  return {
    canClose: sides.canClose && micromark.canClose,
    canOpen: sides.canOpen && micromark.canOpen,
  };
}

/** Whether CommonMark or micromark reads `character` as a letter. */
export function isLetterForSomeReader(character: string): boolean {
  return (
    !isPunctuationOrSpace(character) ||
    !isPunctuationOrSpace(asMicromarkReads(character)!)
  );
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The character (code point) that starts at `index`, if any. */
export function characterAt(text: string, index: number): string | undefined {
  return isHighSurrogate(text.charCodeAt(index)) &&
    isLowSurrogate(text.charCodeAt(index + 1))
    ? text.slice(index, index + 2)
    : text[index];
}

/** The character (code point) that ends just before `index`, if any. */
export function characterBefore(
  text: string,
  index: number,
): string | undefined {
  return isLowSurrogate(text.charCodeAt(index - 1)) &&
    isHighSurrogate(text.charCodeAt(index - 2))
    ? text.slice(index - 2, index)
    : text[index - 1];
}

export function toCharacterReference(character: string): string {
  return `&#${character.codePointAt(0)};`;
}

const MARKDOWN_EMPTY_LINE_REG_EXP = /^\s{0,3}$/;

export function isEmptyParagraph(node: LexicalNode): boolean {
  if (!$isParagraphNode(node)) {
    return false;
  }

  const firstChild = node.getFirstChild();
  return (
    firstChild == null ||
    (node.getChildrenSize() === 1 &&
      $isTextNode(firstChild) &&
      MARKDOWN_EMPTY_LINE_REG_EXP.test(firstChild.getTextContent()))
  );
}

// Numeric references have one to seven decimal or one to six hexadecimal digits.
// A reference that names
// U+0000, a surrogate or a number past U+10FFFF reads as U+FFFD instead of
// making `String.fromCodePoint` throw.
// https://spec.commonmark.org/0.31.2/#decimal-numeric-character
function decodeCharacterReference(
  digits: string | undefined,
  hex: string | undefined,
): string {
  const codePoint = digits !== undefined ? Number(digits) : parseInt(hex!, 16);
  return codePoint === 0 ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    codePoint > 0x10ffff
    ? '\uFFFD'
    : String.fromCodePoint(codePoint);
}

export function unescapeText(value: string): string {
  // Do not decode an escaped ampersand or revisit a decoded reference.
  return value.replace(
    /\\([!-/:-@[-`{-~])|&#(?:(\d{1,7})|[xX]([\da-fA-F]{1,6}));/g,
    (
      _match,
      escaped: string | undefined,
      digits: string | undefined,
      hex: string | undefined,
    ) => escaped ?? decodeCharacterReference(digits, hex),
  );
}

export function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}
