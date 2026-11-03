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
 *   marker reads as the character it follows.
 */
export type PunctuationMode = 'cjk-friendly' | 'strict-commonmark';

// Flanking classes as bits. CJK readers alone set the CJK and IVS bits.
const OTHER_CLASS = 0;
const PUNCTUATION_CLASS = 1;
const CJK_CLASS = 2;
const WHITESPACE_CLASS = 4;
const IVS_CLASS = 8;

// The amendment's CJK characters: East Asian Width F, H and W, without the
// characters shown as emoji, and the Hangul script, from the Unicode 17 data
// of `get-east-asian-width` 1.7 that `micromark-extension-cjk-friendly` reads.
// The MdastCjkTable test compares it with that package: regenerate it when
// a dependency update makes that test fail.
const CJK =
  // A range that starts at a combining mark is still a range of code points.
  // eslint-disable-next-line no-misleading-character-class
  /[\u1100-\u11ff\u20a9\u2329\u232a\u2630-\u2637\u268a-\u268f\u2e80-\u2e99\u2e9b-\u2ef3\u2f00-\u2fd5\u2ff0-\u303e\u3041-\u3096\u3099-\u30ff\u3105-\u312f\u3131-\u318e\u3190-\u31e5\u31ef-\u321e\u3220-\u3247\u3250-\ua48c\ua490-\ua4c6\ua960-\ua97c\uac00-\ud7a3\ud7b0-\ud7c6\ud7cb-\ud7fb\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe52\ufe54-\ufe66\ufe68-\ufe6b\uff01-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc\uffe0-\uffe6\uffe8-\uffee\u{16fe0}-\u{16fe4}\u{16ff0}-\u{16ff6}\u{17000}-\u{18cda}\u{18cff}-\u{18d20}\u{18d80}-\u{18df2}\u{18e00}-\u{19191}\u{191a0}-\u{191d2}\u{1aff0}-\u{1aff3}\u{1aff5}-\u{1affb}\u{1affd}\u{1affe}\u{1b000}-\u{1b128}\u{1b132}\u{1b150}-\u{1b152}\u{1b155}\u{1b164}-\u{1b168}\u{1b170}-\u{1b2fb}\u{1d300}-\u{1d356}\u{1d360}-\u{1d376}\u{1f1ae}\u{1f200}\u{1f202}\u{1f210}-\u{1f219}\u{1f21b}-\u{1f22e}\u{1f230}\u{1f231}\u{1f237}\u{1f23b}\u{1f240}-\u{1f248}\u{1f260}-\u{1f265}\u{1f7da}\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}]/u;
// Wide characters that Unicode 17 made emoji. An engine with older Unicode
// data does not read them as emoji, so it reads them as CJK, as
// `micromark-extension-cjk-friendly` then does.
const NEW_EMOJI =
  /[\u{1f6d9}\u{1fa8b}-\u{1fa8d}\u{1facc}\u{1fadd}\u{1faeb}\u{1faf9}\u{1fafa}]/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
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
  return WHITESPACE.test(character)
    ? WHITESPACE_CLASS
    : (PUNCTUATION.test(character) ? PUNCTUATION_CLASS : OTHER_CLASS) |
        // Nothing below U+1100 is CJK or an ideographic variation selector.
        (cjk &&
        character.codePointAt(0)! >= 0x1100 &&
        (CJK.test(character) ||
          (NEW_EMOJI.test(character) && !EMOJI_PRESENTATION.test(character)))
          ? CJK_CLASS
          : 0) |
        (cjk && character.codePointAt(0)! >= 0x1100 && IVS.test(character)
          ? IVS_CLASS
          : 0);
}

/**
 * Whether `character` is a variation selector that flanking reads as the
 * character before it.
 */
export function isVariationSelector(character: string | undefined): boolean {
  return character !== undefined && VARIATION_SELECTOR.test(character);
}

/**
 * Whether the CJK-friendly amendment reads `character` as CJK.
 *
 * @internal
 */
export function isCjkCharacter(character: string): boolean {
  return (classify(character, true) & CJK_CLASS) !== 0;
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
// unit at a time, so as a letter.
const MICROMARK_ONLY_WHITESPACE = /^[\v\u2028\u2029\ufeff]$/;
type Reader = (character: string | undefined) => number;
const asMicromarkReads = (character: string | undefined) =>
  character !== undefined && MICROMARK_ONLY_WHITESPACE.test(character)
    ? ' '
    : character;
const readCjkFriendly: Reader = character => classify(character, true);
const readMicromarkCjkFriendly: Reader = character =>
  classify(asMicromarkReads(character), true);
// CJK-friendly readers read whatever strict readers read the same way, but
// for corner cases, so an export for strict readers is checked with both.
// Each list leaves out the micromark CJK-friendly reader, which reads as the
// other CJK-friendly one does but for MICROMARK_ONLY_WHITESPACE.
const CJK_FRIENDLY_READERS: Reader[] = [readCjkFriendly];
const STRICT_READERS: Reader[] = [
  character => classify(character, false),
  character =>
    classify(
      character !== undefined && character.length > 1
        ? 'a'
        : asMicromarkReads(character),
      false,
    ),
  readCjkFriendly,
];

let exportReaders = STRICT_READERS;

/** The readers export writes for that can read `a` and `b` differently. */
function getReaders(a: string | undefined, b?: string): Reader[] {
  return (a !== undefined && MICROMARK_ONLY_WHITESPACE.test(a)) ||
    (b !== undefined && MICROMARK_ONLY_WHITESPACE.test(b))
    ? exportReaders.concat(readMicromarkCjkFriendly)
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
