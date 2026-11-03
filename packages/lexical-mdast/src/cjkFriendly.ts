/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  Code,
  Construct,
  Extension,
  State,
  TokenizeContext,
} from 'micromark-util-types';

import isCjkCharacter from '@lexical/internal/isCjkCharacter';
import {attention} from 'micromark-core-commonmark';

// How the CommonMark CJK-friendly amendment
// (https://github.com/tats-u/markdown-cjk-friendly) reads the characters
// beside a marker, as classes of bits. The constructs below read runs as
// `micromark-extension-cjk-friendly` does, and also read a variation
// selector before a closing `~~` as the character it varies.
const WHITESPACE = 1;
const PUNCTUATION = 2;
const CJK = 4;
// An ideographic variation selector, which counts as CJK before a marker.
const IVS = 8;
// A general-use variation selector other than the emoji one, which before a
// marker reads as the character it varies.
const VARIATION_SELECTOR = 16;

const ASTERISK = 42;
const UNDERSCORE = 95;
const TILDE = 126;

/**
 * The class of `code`, a code point or one of micromark's codes, which reads
 * the end of the input and its whitespace codes as whitespace.
 *
 * @internal
 */
export function classifyCode(code: Code): number {
  if (code === null || code < 0) {
    return WHITESPACE;
  }
  if (code >= 0xfe00 && code <= 0xfe0e) {
    return VARIATION_SELECTOR;
  }
  const character = String.fromCodePoint(code);
  return /\s/.test(character)
    ? WHITESPACE
    : (/[\p{P}\p{S}]/u.test(character) ? PUNCTUATION : 0) |
        (code < 0x1100
          ? 0
          : isCjkCharacter(character)
            ? CJK
            : code >= 0xe0100 && code <= 0xe01ef
              ? IVS
              : 0);
}

/** Whether `characterClass` is CJK. @internal */
export function isCjkClass(characterClass: number): boolean {
  return (characterClass & CJK) !== 0;
}

/** Whether `characterClass` is a selector that varies the character before. @internal */
export function isVariationSelectorClass(characterClass: number): boolean {
  return characterClass === VARIATION_SELECTOR;
}

/**
 * The code before the tokenizer's position and the class the amendment
 * reads for it: for a variation selector, that of the character it varies,
 * with quotation marks that U+FE01 shows full width as CJK punctuation.
 */
function readBefore(context: TokenizeContext): [Code, number] {
  const now = context.now();
  // Enough of the current chunk for two characters outside the BMP.
  const text = context.sliceSerialize({
    end: now,
    start: {...now, _bufferIndex: Math.max(0, now._bufferIndex - 4)},
  });
  const last = text.codePointAt(text.length - 2);
  const previous =
    last !== undefined && last > 0xffff ? last : context.previous;
  const before = classifyCode(previous);
  if (before !== VARIATION_SELECTOR) {
    return [previous, before];
  }
  const rest = text.slice(0, -1);
  if (rest === '') {
    return [previous, before];
  }
  const two =
    rest.length > 1 && rest.codePointAt(rest.length - 2)! > 0xffff
      ? rest.codePointAt(rest.length - 2)!
      : rest.charCodeAt(rest.length - 1);
  const twoBefore = classifyCode(two);
  return [
    previous,
    twoBefore & WHITESPACE
      ? before
      : previous === 0xfe01 && [0x2018, 0x2019, 0x201c, 0x201d].includes(two)
        ? CJK | PUNCTUATION
        : twoBefore & ~IVS,
  ];
}

/** The class of the code point at the tokenizer's position, `code` or the pair it starts. */
function classifyAfter(context: TokenizeContext, code: Code): number {
  if (code !== null && code >= 0xd800 && code <= 0xdbff) {
    const now = context.now();
    code = context
      .sliceSerialize({
        end: {...now, _bufferIndex: now._bufferIndex + 2},
        start: now,
      })
      .codePointAt(0)!;
  }
  return classifyCode(code);
}

/**
 * Whether a run between characters of these classes opens and whether it
 * closes, as the amendment reads it, with `markerBefore` and `markerAfter`
 * for whether another marker that does not join the run is beside it.
 */
function getFlanking(
  before: number,
  after: number,
  markerBefore: boolean,
  markerAfter: boolean,
): [open: boolean, close: boolean] {
  const punctuationBefore = before === PUNCTUATION;
  const punctuationAfter = after === PUNCTUATION;
  const spaceBefore = punctuationBefore || (before & WHITESPACE) !== 0;
  const spaceAfter = punctuationAfter || (after & WHITESPACE) !== 0;
  return [
    !spaceAfter ||
      (punctuationAfter && (spaceBefore || (before & (CJK | IVS)) !== 0)) ||
      markerAfter,
    !spaceBefore ||
      (punctuationBefore && (spaceAfter || (after & CJK) !== 0)) ||
      markerBefore,
  ];
}

/**
 * micromark's CJK-friendly emphasis, which reads `*` and `_` runs as the
 * amendment does.
 *
 * @internal
 */
export function cjkFriendlyEmphasis(): Extension {
  // micromark's emphasis, read as the amendment reads it.
  const construct: Construct = {
    ...attention,
    tokenize(effects, ok) {
      const markers = this.parser.constructs.attentionMarkers.null || [];
      const [previous, before] = readBefore(this);
      const isCoreMarker = (code: Code) =>
        code === ASTERISK || code === UNDERSCORE;
      let marker: Code;
      const inside: State = code => {
        if (code === marker) {
          effects.consume(code);
          return inside;
        }
        const token = effects.exit('attentionSequence');
        const after = classifyAfter(this, code);
        // Another marker beside the run, such as `~`, flanks as space.
        const [open, close] = getFlanking(
          before,
          after,
          markers.includes(previous!) && !isCoreMarker(previous),
          markers.includes(code!) && !isCoreMarker(code),
        );
        token._open =
          marker === ASTERISK
            ? open
            : open && ((before & (WHITESPACE | PUNCTUATION)) !== 0 || !close);
        token._close =
          marker === ASTERISK
            ? close
            : close && ((after & (WHITESPACE | PUNCTUATION)) !== 0 || !open);
        return ok(code);
      };
      return code => {
        marker = code;
        effects.enter('attentionSequence');
        return inside(code);
      };
    },
  };
  return {
    insideSpan: {null: [construct]},
    text: {
      [ASTERISK]: construct,
      [UNDERSCORE]: construct,
    },
  };
}

/**
 * The CJK-friendly form of `syntax`, from `gfmStrikethrough()` with its
 * default single tilde: its `~` and `~~` runs read as the amendment reads
 * emphasis.
 *
 * @internal
 */
export function cjkFriendlyStrikethrough(syntax: Extension): Extension {
  const construct: Construct = {
    ...(syntax.text![TILDE] as Construct),
    tokenize(effects, ok, nok) {
      const [previous, before] = readBefore(this);
      const {events} = this;
      let size = 0;
      const more: State = code => {
        if (code === TILDE) {
          if (size > 1) {
            return nok(code);
          }
          effects.consume(code);
          size++;
          return more;
        }
        const token = effects.exit('strikethroughSequenceTemporary');
        [token._open, token._close] = getFlanking(
          before,
          classifyAfter(this, code),
          false,
          false,
        );
        return ok(code);
      };
      return code => {
        if (
          previous === TILDE &&
          events[events.length - 1][1].type !== 'characterEscape'
        ) {
          return nok(code);
        }
        effects.enter('strikethroughSequenceTemporary');
        return more(code);
      };
    },
  };
  return {
    ...syntax,
    insideSpan: {null: [construct]},
    text: {[TILDE]: construct},
  };
}
