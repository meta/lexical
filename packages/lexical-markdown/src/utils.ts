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

import isCjkCharacter from '@lexical/internal/isCjkCharacter';
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
// form feed and carriage return. A vertical tab, which Office writes for a
// soft line break, counts too, as every common reader (commonmark.js,
// markdown-it and micromark) reads it; JavaScript's `\s` adds others, such
// as U+FEFF. Delimiter flanking depends on both. Readers read U+0000 as the
// U+FFFD that replaces it, a symbol.
// https://spec.commonmark.org/0.31.2/#unicode-punctuation-character
// https://spec.commonmark.org/0.31.2/#unicode-whitespace-character
// https://spec.commonmark.org/0.31.2/#insecure-characters
const PUNCTUATION = /[\0\p{P}\p{S}]/u;
const WHITESPACE = /[\p{Zs}\t\n\v\f\r]/u;

/**
 * How emphasis markers read the punctuation beside them.
 *
 * - `'strict-commonmark'` follows CommonMark 0.31.2 and GFM: a marker between
 *   a letter and punctuation, such as the closing `**` of `**你好。**世界`,
 *   does not open or close, so CJK text needs a space or a character
 *   reference there.
 * - `'cjk-friendly'` follows the CommonMark CJK-friendly amendment
 *   (https://github.com/tats-u/markdown-cjk-friendly), as
 *   `markdown-it-cjk-friendly` and `micromark-extension-cjk-friendly` do: it
 *   reads such a marker as CommonMark does everywhere except beside Chinese,
 *   Japanese and Korean characters and punctuation, where it opens and closes
 *   as a writer of those languages expects. A variation selector before a
 *   marker reads as the character it follows, but after whitespace as
 *   itself, as `micromark-extension-cjk-friendly` reads it, and after a
 *   U+0000 as the U+FFFD that readers put in its place, as
 *   `markdown-it-cjk-friendly` reads it.
 *
 * Both read a vertical tab beside a marker as whitespace, as commonmark.js,
 * markdown-it and micromark do, though cmark and cmark-gfm don't.
 */
export type PunctuationMode = 'cjk-friendly' | 'strict-commonmark';

// Flanking classes as bits. CJK readers alone set the CJK and IVS bits.
const OTHER_CLASS = 0;
const PUNCTUATION_CLASS = 1;
const CJK_CLASS = 2;
const WHITESPACE_CLASS = 4;
const IVS_CLASS = 8;

// Ideographic variation selectors; before a marker, one counts as CJK.
const IVS = /[\u{e0100}-\u{e01ef}]/u;
// The general-use variation selectors other than the emoji one: before a
// marker, the character it varies is read instead.
const VARIATION_SELECTOR = /[\ufe00-\ufe0e]/;
// Quotation marks that U+FE01 asks to show full width, as CJK punctuation.
const CJK_QUOTE = /[‘’“”]/;

/**
 * How flanking sees `character`; the edge of the line is whitespace. A
 * character followed by a variation selector, from {@link flankingBefore},
 * reads as the character for CJK readers and as the selector otherwise.
 */
function classify(character: string | undefined, cjk: boolean): number {
  if (character === undefined) {
    return WHITESPACE_CLASS;
  }
  const last = character[character.length - 1];
  if (character.length > 1 && VARIATION_SELECTOR.test(last)) {
    const base = character.slice(0, -1);
    const baseClass = classify(base, cjk);
    return !cjk || baseClass === WHITESPACE_CLASS
      ? OTHER_CLASS
      : last === '\ufe01' && CJK_QUOTE.test(base)
        ? CJK_CLASS | PUNCTUATION_CLASS
        : baseClass & ~IVS_CLASS;
  }
  if (WHITESPACE.test(character)) {
    return WHITESPACE_CLASS;
  }
  const base = PUNCTUATION.test(character) ? PUNCTUATION_CLASS : OTHER_CLASS;
  // Nothing below U+1100 is CJK or an ideographic variation selector.
  return cjk && character.codePointAt(0)! >= 0x1100
    ? base |
        (isCjkCharacter(character) ? CJK_CLASS : 0) |
        (IVS.test(character) ? IVS_CLASS : 0)
    : base;
}

/**
 * Whether `character` is a variation selector that flanking reads as the
 * character before it.
 */
export function isVariationSelector(character: string | undefined): boolean {
  return character !== undefined && VARIATION_SELECTOR.test(character);
}

/** Whitespace or punctuation that is not CJK. */
function isSpaceOrPunctuationClass(characterClass: number): boolean {
  return (
    characterClass === WHITESPACE_CLASS ||
    (characterClass & (PUNCTUATION_CLASS | CJK_CLASS)) === PUNCTUATION_CLASS
  );
}

function isFlankedByClass(
  primary: number,
  secondary: number,
  isLeft: boolean,
): boolean {
  return (
    !isSpaceOrPunctuationClass(primary) ||
    (primary !== WHITESPACE_CLASS &&
      (isSpaceOrPunctuationClass(secondary) ||
        (secondary & (isLeft ? CJK_CLASS | IVS_CLASS : CJK_CLASS)) !== 0))
  );
}

function getSides(
  marker: string,
  beforeClass: number,
  afterClass: number,
): {canOpen: boolean; canClose: boolean} {
  const isLeft = isFlankedByClass(afterClass, beforeClass, true);
  const isRight = isFlankedByClass(beforeClass, afterClass, false);
  return marker === '_'
    ? {
        canClose: isRight && (!isLeft || (afterClass & PUNCTUATION_CLASS) > 0),
        canOpen: isLeft && (!isRight || (beforeClass & PUNCTUATION_CLASS) > 0),
      }
    : {canClose: isRight, canOpen: isLeft};
}

let isCjkFriendlyImport = true;

/**
 * Runs `fn` with import reading emphasis markers in `mode`, or as the import
 * it runs within does (by default `'cjk-friendly'`) when `mode` is undefined.
 *
 * @internal
 */
export function withImportPunctuation<T>(
  mode: PunctuationMode | undefined,
  fn: () => T,
): T {
  if (mode === undefined) {
    return fn();
  }
  const previous = isCjkFriendlyImport;
  isCjkFriendlyImport = mode === 'cjk-friendly';
  try {
    return fn();
  } finally {
    isCjkFriendlyImport = previous;
  }
}

/**
 * Whether a delimiter run of `marker` between `before` and `after` can open
 * and close emphasis, as import reads it; `_` opens or closes inside a word
 * only beside punctuation. `undefined` is the edge of the line.
 * https://spec.commonmark.org/0.31.2/#can-open-emphasis
 */
export function getEmphasisSides(
  marker: string,
  before: string | undefined,
  after: string | undefined,
): {canOpen: boolean; canClose: boolean} {
  return getSides(
    marker,
    classify(before, isCjkFriendlyImport),
    classify(after, isCjkFriendlyImport),
  );
}

export function isPunctuationOrSpace(character: string): boolean {
  return classify(character, false) !== OTHER_CLASS;
}

// Readers built on micromark, such as `@lexical/mdast`, count JavaScript's
// whitespace, U+FEFF among it, as whitespace, and without the CJK-friendly
// extension read a character outside the Basic Multilingual Plane one UTF-16
// unit at a time, so as a letter. micromark-extension-cjk-friendly reads a
// variation selector after a U+0000, which micromark keeps apart as a U+FFFD,
// as the selector itself, where markdown-it-cjk-friendly reads the U+FFFD.
// That whitespace, or a U+0000 and one of the selectors of VARIATION_SELECTOR.
const READ_OTHERWISE_BY_MICROMARK =
  /^(?:[\u2028\u2029\ufeff]|\0[\ufe00-\ufe0e])$/;
const isReadOtherwiseByMicromark = (character: string) =>
  READ_OTHERWISE_BY_MICROMARK.test(character);
type Reader = (character: string | undefined) => number;
const asMicromarkReads = (character: string | undefined) =>
  character === undefined || !isReadOtherwiseByMicromark(character)
    ? character
    : character[0] === '\0'
      ? // The selector after the U+0000.
        character.slice(1)
      : ' ';
const readCjkFriendly: Reader = character => classify(character, true);
const readMicromarkCjkFriendly: Reader = character =>
  classify(asMicromarkReads(character), true);
// CJK-friendly readers read whatever strict readers read the same way, but
// for corner cases, so an export for strict readers is checked with both.
// readCjkFriendly reads as markdown-it-cjk-friendly does but for a selector
// after whitespace, which it reads as the selector itself, as
// micromark-extension-cjk-friendly does, where markdown-it-cjk-friendly reads
// a tab, a line ending, a vertical tab or a form feed before it as that
// whitespace, and a U+3000 before it as a CJK character. Both let a run after
// the selector open, where export writes a reference for the other readers
// anyway. The first also stops a run that the selector ends from closing,
// which no reference beside the run helps (an exception the docs of export
// list). Each list leaves out the micromark CJK-friendly reader, which reads
// as readCjkFriendly does but for READ_OTHERWISE_BY_MICROMARK.
const CJK_FRIENDLY_READERS: Reader[] = [readCjkFriendly];
const readStrict: Reader = character => classify(character, false);
const readMicromarkStrict: Reader = character =>
  classify(
    character !== undefined && character.length > 1
      ? 'a'
      : asMicromarkReads(character),
    false,
  );
const STRICT_READERS: Reader[] = [
  readStrict,
  readMicromarkStrict,
  readCjkFriendly,
];
// Each list with the micromark CJK-friendly reader.
const CJK_FRIENDLY_AND_MICROMARK_READERS: Reader[] = [
  readCjkFriendly,
  readMicromarkCjkFriendly,
];
const STRICT_AND_MICROMARK_READERS: Reader[] = [
  readStrict,
  readMicromarkStrict,
  readCjkFriendly,
  readMicromarkCjkFriendly,
];

let exportReaders = STRICT_READERS;

/** The readers export writes for that can read `a` and `b` differently. */
function getReaders(a: string | undefined, b?: string): Reader[] {
  return (a !== undefined && isReadOtherwiseByMicromark(a)) ||
    (b !== undefined && isReadOtherwiseByMicromark(b))
    ? exportReaders === CJK_FRIENDLY_READERS
      ? CJK_FRIENDLY_AND_MICROMARK_READERS
      : STRICT_AND_MICROMARK_READERS
    : exportReaders;
}

/**
 * Runs `fn` with export writing emphasis markers for readers in `mode`, or as
 * the export it runs within does (by default `'strict-commonmark'`) when
 * `mode` is undefined.
 *
 * @internal
 */
export function withExportPunctuation<T>(
  mode: PunctuationMode | undefined,
  fn: () => T,
): T {
  if (mode === undefined) {
    return fn();
  }
  const previous = exportReaders;
  exportReaders =
    mode === 'cjk-friendly' ? CJK_FRIENDLY_READERS : STRICT_READERS;
  try {
    return fn();
  } finally {
    exportReaders = previous;
  }
}

/**
 * Whether a delimiter run with `primary` on the side it faces (after it for
 * left-flanking, before it for right-flanking) and `secondary` on the other
 * side is flanking for every reader export writes for.
 * https://spec.commonmark.org/0.31.2/#left-flanking-delimiter-run
 */
export function isPortablyFlankedBy(
  primary: string | undefined,
  secondary: string | undefined,
  isLeft: boolean,
): boolean {
  return getReaders(primary, secondary).every(read =>
    isFlankedByClass(read(primary), read(secondary), isLeft),
  );
}

/** {@link getEmphasisSides}, for every reader export writes for. */
export function getPortableEmphasisSides(
  marker: string,
  before: string | undefined,
  after: string | undefined,
): {canOpen: boolean; canClose: boolean} {
  let canOpen = true;
  let canClose = true;
  for (const read of getReaders(before, after)) {
    const sides = getSides(marker, read(before), read(after));
    canOpen &&= sides.canOpen;
    canClose &&= sides.canClose;
  }
  return {canClose, canOpen};
}

/** Whether some reader export writes for reads `character` as a letter. */
export function isLetterForSomeReader(character: string): boolean {
  return getReaders(character).some(
    read => !isSpaceOrPunctuationClass(read(character)),
  );
}

/**
 * The character (code point) that ends just before `index`, as flanking reads
 * it: with the character before it when it is a variation selector, which is
 * the last character of `outside`, what lies before the text, when the
 * selector starts it.
 */
export function flankingBefore(
  text: string,
  index: number,
  outside?: string,
): string | undefined {
  const character = characterBefore(text, index);
  if (character === undefined || !VARIATION_SELECTOR.test(character)) {
    return character;
  }
  const base =
    index > 1
      ? characterBefore(text, index - 1)
      : outside && characterBefore(outside, outside.length);
  return base === undefined ? character : base + character;
}

/** The character (code point) that starts at `index`, if any. */
export function characterAt(text: string, index: number): string | undefined {
  const code = text.codePointAt(index);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

/** The character (code point) that ends just before `index`, if any. */
export function characterBefore(
  text: string,
  index: number,
): string | undefined {
  const pair = characterAt(text, index - 2);
  return pair !== undefined && pair.length === 2 ? pair : text[index - 1];
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

/**
 * Where the delimiter run that `text` is cut in at `index` ends: walking from
 * `index` by `step` over the delimiter beside the cut, the first edge with
 * something else beyond it. Walking back, an escaped delimiter is not part of
 * the run.
 */
export function getDelimiterRunEdge(
  text: string,
  index: number,
  step: 1 | -1,
): number {
  const delimiter = text[step === 1 ? index - 1 : index];
  let edge = index;
  while (
    step === 1
      ? edge < text.length && text[edge] === delimiter
      : edge > 0 && text[edge - 1] === delimiter && !isEscaped(text, edge - 1)
  ) {
    edge += step;
  }
  return edge;
}
