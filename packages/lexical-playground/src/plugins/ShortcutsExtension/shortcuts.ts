/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {KeyboardShortcutMatch} from 'lexical';

import {formatKeyboardShortcut} from '@lexical/extension';
import {CONTROL_OR_META, IS_APPLE} from 'lexical';

/* eslint-disable sort-keys-fix/sort-keys-fix */

const CONTROL_OR_META_ALT = {...CONTROL_OR_META, altKey: true};
const CONTROL_OR_META_SHIFT = {...CONTROL_OR_META, shiftKey: true};
const CONTROL_SHIFT = {ctrlKey: true, shiftKey: true};

/**
 * The key bindings for the shortcuts that ShortcutsExtension handles (a
 * subset of the {@link SHORTCUTS} display strings below; the rest are
 * handled by the rich-text and history extensions). Each binding is paired
 * with its command in the ShortcutsExtension and contributed to the
 * KeyboardShortcutsExtension table, which compiles them down to an O(1)
 * dispatch by key and modifiers.
 */
export const SHORTCUT_BINDINGS = Object.freeze({
  NORMAL: {key: '0', modifiers: CONTROL_OR_META_ALT},
  HEADING1: {key: '1', modifiers: CONTROL_OR_META_ALT},
  HEADING2: {key: '2', modifiers: CONTROL_OR_META_ALT},
  HEADING3: {key: '3', modifiers: CONTROL_OR_META_ALT},
  NUMBERED_LIST: {key: '7', modifiers: CONTROL_OR_META_SHIFT},
  BULLET_LIST: {key: '8', modifiers: CONTROL_OR_META_SHIFT},
  CHECK_LIST: {key: '9', modifiers: CONTROL_OR_META_SHIFT},
  CODE_BLOCK: {key: 'c', modifiers: CONTROL_OR_META_ALT},
  QUOTE: {key: 'q', modifiers: CONTROL_SHIFT},
  ADD_COMMENT: {key: 'm', modifiers: CONTROL_OR_META_ALT},

  INCREASE_FONT_SIZE: {
    key: '>',
    modifiers: CONTROL_OR_META_SHIFT,
    unshiftedKey: '.',
  },
  DECREASE_FONT_SIZE: {
    key: '<',
    modifiers: CONTROL_OR_META_SHIFT,
    unshiftedKey: ',',
  },
  INSERT_CODE_BLOCK: {key: 'c', modifiers: CONTROL_OR_META_SHIFT},
  STRIKETHROUGH: {key: 'x', modifiers: CONTROL_OR_META_SHIFT},
  LOWERCASE: {key: '1', modifiers: CONTROL_SHIFT},
  UPPERCASE: {key: '2', modifiers: CONTROL_SHIFT},
  CAPITALIZE: {key: '3', modifiers: CONTROL_SHIFT},
  CENTER_ALIGN: {key: 'e', modifiers: CONTROL_OR_META_SHIFT},
  JUSTIFY_ALIGN: {key: 'j', modifiers: CONTROL_OR_META_SHIFT},
  LEFT_ALIGN: {key: 'l', modifiers: CONTROL_OR_META_SHIFT},
  RIGHT_ALIGN: {key: 'r', modifiers: CONTROL_OR_META_SHIFT},

  SUBSCRIPT: {key: ',', modifiers: CONTROL_OR_META},
  SUPERSCRIPT: {key: '.', modifiers: CONTROL_OR_META},
  INDENT: {key: ']', modifiers: CONTROL_OR_META},
  OUTDENT: {key: '[', modifiers: CONTROL_OR_META},
  CLEAR_FORMATTING: {key: '\\', modifiers: CONTROL_OR_META},
  INSERT_LINK: {key: 'k', modifiers: CONTROL_OR_META},
}) satisfies Record<string, KeyboardShortcutMatch>;

const BUILTIN_SHORTCUT_BINDINGS = Object.freeze({
  // Core shortcuts handled by the editor, not by ShortcutsExtension
  BOLD: {key: 'b', modifiers: CONTROL_OR_META},
  ITALIC: {key: 'i', modifiers: CONTROL_OR_META},
  UNDERLINE: {key: 'u', modifiers: CONTROL_OR_META},
  UNDO: {key: 'z', modifiers: CONTROL_OR_META},
  REDO: {key: 'z', modifiers: {...CONTROL_OR_META, shiftKey: true}},
}) satisfies Record<string, KeyboardShortcutMatch>;
const BUILTIN_SHORTCUT_BINDINGS_APPLE = Object.freeze({}) satisfies Record<
  string,
  KeyboardShortcutMatch
>;
const BUILTIN_SHORTCUT_BINDINGS_OTHER = Object.freeze({
  REDO: {
    key: 'y',
    modifiers: {ctrlKey: true},
  },
}) satisfies Record<string, KeyboardShortcutMatch>;

type TypedEntries<T> = {[K in keyof T]: [K, T[K]]}[keyof T][];
function typedEntries<T extends object>(o: T): TypedEntries<T> {
  return Object.entries(o) as TypedEntries<T>;
}

type ShortcutKey =
  | keyof typeof SHORTCUT_BINDINGS
  | keyof typeof BUILTIN_SHORTCUT_BINDINGS
  | keyof typeof BUILTIN_SHORTCUT_BINDINGS_APPLE
  | keyof typeof BUILTIN_SHORTCUT_BINDINGS_OTHER;

function _getShortcuts(isApple: boolean) {
  const entries: [ShortcutKey, KeyboardShortcutMatch][] = [
    ...typedEntries(SHORTCUT_BINDINGS),
    ...typedEntries(BUILTIN_SHORTCUT_BINDINGS),
    ...typedEntries(
      isApple
        ? BUILTIN_SHORTCUT_BINDINGS_APPLE
        : BUILTIN_SHORTCUT_BINDINGS_OTHER,
    ),
  ];
  return Object.freeze({
    ...(Object.fromEntries(
      entries.map(([k, v]) => [k, formatKeyboardShortcut(v, {isApple})]),
    ) as Record<ShortcutKey, string[]>),
  });
}

/**
 * Human-readable display string segments derived from {@link SHORTCUT_BINDINGS},
 * used for button tooltips, aria-labels, and menu hints.
 */
export const SHORTCUTS = _getShortcuts(IS_APPLE);
/**
 * {@link SHORTCUTS} formatted for the other platform (!IS_APPLE)
 */
export const ALTERNATE_SHORTCUTS = _getShortcuts(!IS_APPLE);

export function getShortcuts(isApple: boolean) {
  return IS_APPLE === isApple ? SHORTCUTS : ALTERNATE_SHORTCUTS;
}

const SEPARATOR = IS_APPLE ? '' : '+';

/**
 * Return the human-readable flat string for a key of {@link SHORTCUT_BINDINGS}
 */
export function shortcut(k: keyof typeof SHORTCUTS) {
  return SHORTCUTS[k].join(SEPARATOR);
}
