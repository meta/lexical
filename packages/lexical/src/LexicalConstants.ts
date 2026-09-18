/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ElementFormatType} from './nodes/LexicalElementNode';
import type {
  TextDetailType,
  TextFormatType,
  TextModeType,
} from './nodes/LexicalTextNode';

import {IS_APPLE_WEBKIT, IS_FIREFOX, IS_IOS, IS_SAFARI} from './environment';

// DOM
export const DOM_ELEMENT_TYPE = 1;
export const DOM_TEXT_TYPE = 3;
export const DOM_DOCUMENT_TYPE = 9;
export const DOM_DOCUMENT_FRAGMENT_TYPE = 11;

// Reconciling
export const NO_DIRTY_NODES = 0;
export const HAS_DIRTY_NODES = 1;
export const FULL_RECONCILE = 2;

// Text node modes
export const IS_NORMAL = 0;
export const IS_TOKEN = 1;
export const IS_SEGMENTED = 2;
// IS_INERT = 3

/** Bitmask for bold text formatting. */
export const IS_BOLD = 1;
/** Bitmask for italic text formatting. */
export const IS_ITALIC = 1 << 1;
/** Bitmask for strikethrough text formatting. */
export const IS_STRIKETHROUGH = 1 << 2;
/** Bitmask for underline text formatting. */
export const IS_UNDERLINE = 1 << 3;
/** Bitmask for code (monospace) text formatting. */
export const IS_CODE = 1 << 4;
/** Bitmask for subscript text formatting. */
export const IS_SUBSCRIPT = 1 << 5;
/** Bitmask for superscript text formatting. */
export const IS_SUPERSCRIPT = 1 << 6;
/** Bitmask for highlighted text formatting. */
export const IS_HIGHLIGHT = 1 << 7;
export const IS_LOWERCASE = 1 << 8;
export const IS_UPPERCASE = 1 << 9;
export const IS_CAPITALIZE = 1 << 10;

/** Bitmask combining all text format flags. */
export const IS_ALL_FORMATTING =
  IS_BOLD |
  IS_ITALIC |
  IS_STRIKETHROUGH |
  IS_UNDERLINE |
  IS_CODE |
  IS_SUBSCRIPT |
  IS_SUPERSCRIPT |
  IS_HIGHLIGHT |
  IS_LOWERCASE |
  IS_UPPERCASE |
  IS_CAPITALIZE;

// Text node details
export const IS_DIRECTIONLESS = 1;
export const IS_UNMERGEABLE = 1 << 1;

// Element node formatting
export const IS_ALIGN_LEFT = 1;
export const IS_ALIGN_CENTER = 2;
export const IS_ALIGN_RIGHT = 3;
export const IS_ALIGN_JUSTIFY = 4;
export const IS_ALIGN_START = 5;
export const IS_ALIGN_END = 6;

// Reconciliation
export const NON_BREAKING_SPACE = '\u00A0';
const ZERO_WIDTH_SPACE = '\u200b';

// For iOS/Safari we use a non breaking space, otherwise the cursor appears
// overlapping the composed text.
export const COMPOSITION_SUFFIX: string =
  IS_SAFARI || IS_IOS || IS_APPLE_WEBKIT
    ? NON_BREAKING_SPACE
    : ZERO_WIDTH_SPACE;
export const DOUBLE_LINE_BREAK = '\n\n';

// For FF, we need to use a non-breaking space, or it gets composition
// in a stuck state.
export const COMPOSITION_START_CHAR: string = IS_FIREFOX
  ? NON_BREAKING_SPACE
  : COMPOSITION_SUFFIX;
const RTL = '\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC';
const LTR =
  'A-Za-z\u00C0-\u00D6\u00D8-\u00F6' +
  '\u00F8-\u02B8\u0300-\u0590\u0800-\u1FFF\u200E\u2C00-\uFB1C' +
  '\uFE00-\uFE6F\uFEFD-\uFFFF';

// eslint-disable-next-line no-misleading-character-class
export const RTL_REGEX = new RegExp('^[^' + LTR + ']*[' + RTL + ']');
// eslint-disable-next-line no-misleading-character-class
export const LTR_REGEX = new RegExp('^[^' + RTL + ']*[' + LTR + ']');

/** Maps {@link TextFormatType} string names to their bitmask values. */
export const TEXT_TYPE_TO_FORMAT: Record<TextFormatType | string, number> = {
  bold: IS_BOLD,
  capitalize: IS_CAPITALIZE,
  code: IS_CODE,
  highlight: IS_HIGHLIGHT,
  italic: IS_ITALIC,
  lowercase: IS_LOWERCASE,
  strikethrough: IS_STRIKETHROUGH,
  subscript: IS_SUBSCRIPT,
  superscript: IS_SUPERSCRIPT,
  underline: IS_UNDERLINE,
  uppercase: IS_UPPERCASE,
};

export const DETAIL_TYPE_TO_DETAIL: Record<TextDetailType | string, number> = {
  directionless: IS_DIRECTIONLESS,
  unmergeable: IS_UNMERGEABLE,
};

export const ELEMENT_TYPE_TO_FORMAT: Record<
  Exclude<ElementFormatType, ''>,
  number
> = {
  center: IS_ALIGN_CENTER,
  end: IS_ALIGN_END,
  justify: IS_ALIGN_JUSTIFY,
  left: IS_ALIGN_LEFT,
  right: IS_ALIGN_RIGHT,
  start: IS_ALIGN_START,
};

export const ELEMENT_FORMAT_TO_TYPE: Record<number, ElementFormatType> = {
  [IS_ALIGN_CENTER]: 'center',
  [IS_ALIGN_END]: 'end',
  [IS_ALIGN_JUSTIFY]: 'justify',
  [IS_ALIGN_LEFT]: 'left',
  [IS_ALIGN_RIGHT]: 'right',
  [IS_ALIGN_START]: 'start',
};

export const TEXT_MODE_TO_TYPE: Record<TextModeType, 0 | 1 | 2> = {
  normal: IS_NORMAL,
  segmented: IS_SEGMENTED,
  token: IS_TOKEN,
};

export const TEXT_TYPE_TO_MODE: Record<number, TextModeType> = {
  [IS_NORMAL]: 'normal',
  [IS_SEGMENTED]: 'segmented',
  [IS_TOKEN]: 'token',
};

/** The property key used to store node state on serialized node JSON. */
export const NODE_STATE_KEY = '$';

/**
 * @internal
 *
 * The property key on a {@link KeyboardEventModifierMask} that names the
 * Apple-platform counterpart of ctrlKey.
 */
export const CONTROL_OR_OTHER_KEY = Symbol.for('@lexical/ctrlOrOtherKey');
export const PROTOTYPE_CONFIG_METHOD = '$config';
