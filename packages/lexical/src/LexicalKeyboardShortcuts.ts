/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalCommand, LexicalEditor} from './LexicalEditor';
import type {BaseSelection} from './LexicalSelection';
import type {
  KeyboardEventControlOrOther,
  KeyboardEventModifierMask,
  KeyboardEventModifiers,
} from './LexicalUtils';

import invariant from '@lexical/internal/invariant';

import {IS_APPLE} from './environment';
import {CONTROL_OR_OTHER_KEY} from './LexicalConstants';

/**
 * @experimental
 *
 * The data that describes which keyboard events a shortcut matches: an
 * `event.key` value (case-insensitive) plus a
 * {@link KeyboardEventModifierMask}. The matching semantics are identical to
 * {@link isExactShortcutMatch}, including the `event.code` fallback for
 * single-character keys on non-Latin keyboard layouts.
 */
export interface KeyboardShortcutMatch {
  /**
   * The `KeyboardEvent.key` to match, case-insensitive
   * (e.g. `'b'`, `'1'`, `'Enter'`, `'ArrowLeft'`)
   */
  key: string;
  /**
   * The expected state of the modifier keys. A modifier that is omitted or
   * `false` must not be pressed, `true` must be pressed, and `'any'` is
   * ignored. The default of `{}` matches only events with no modifiers.
   */
  modifiers?: KeyboardEventModifierMask;
  /**
   * The unshifted key to display to the user, only relevant when the shift
   * modifier is true on non-Apple environments.
   */
  unshiftedKey?: string;
}

/**
 * @experimental
 *
 * A keyboard shortcut is pure data: the key and modifiers to match, and the
 * command to dispatch (with the matched KeyboardEvent as its payload) when
 * it does. Keeping the action to a command keeps the mapping declarative —
 * a shortcut table can be rendered as a menu (see
 * `formatKeyboardShortcut` in `@lexical/extension`), remapped, or
 * serialized, and the behavior lives in command listeners where any other
 * UI can share it.
 */
export interface KeyboardShortcut extends KeyboardShortcutMatch {
  /**
   * The command dispatched with the matched KeyboardEvent as its payload.
   * The event is considered handled when the dispatch is handled; an
   * unhandled dispatch falls through to any other shortcut on the same key
   * and modifiers. Listeners are responsible for calling
   * `event.preventDefault()` if the default action must be suppressed.
   */
  command: LexicalCommand<KeyboardEvent>;
  /**
   * A human readable description of what the shortcut does, for building
   * menus or help dialogs from a shortcut table
   */
  description?: string;
  /**
   * Called with the current selection before the command is dispatched;
   * returning true skips this shortcut (falling through to any other
   * shortcut on the same key and modifiers). Menu builders may use the
   * same predicate to render an item as disabled.
   *
   * @param selection - The current editor selection, or null if none exists.
   * @param editor - The editor where KEY_DOWN_COMMAND originated (may
   *   differ from the registration editor in nested-editor setups).
   * @returns `true` to skip this shortcut, `false` to allow it.
   */
  $disabled?: (
    selection: null | BaseSelection,
    editor: LexicalEditor,
  ) => boolean;
  /**
   * Optional middleware around the command dispatch, for shortcuts that
   * must run additional code (e.g. setting some state) without defining a
   * wrapper command. It is responsible for calling `$next()` — which
   * dispatches the command on the originating editor — and returning
   * whether the event was handled (an unhandled event falls through to
   * any other shortcut on the same key and modifiers).
   *
   * @param command - The shortcut's command.
   * @param event - The matched KeyboardEvent.
   * @param $next - Dispatches the shortcut's command on the originating
   *   editor and returns whether the dispatch was handled.
   * @param editor - The editor where KEY_DOWN_COMMAND originated (may
   *   differ from the registration editor in nested-editor setups).
   */
  $dispatch?: (
    command: LexicalCommand<KeyboardEvent>,
    event: KeyboardEvent,
    $next: () => boolean,
    editor: LexicalEditor,
  ) => boolean;
  /**
   * By default, shortcut keypresses that originate in nested editors
   * but were not handled by that editor are ignored. Set to `true`
   * when you want matching events to bubble up to this handler.
   *
   * This only has an effect when the shortcut listener is registered at a
   * priority above `COMMAND_PRIORITY_EDITOR`: the nested editor registers
   * the core key-down handler at that priority and it always reports the
   * event as handled, which ends the dispatch before it reaches the outer
   * editor's editor-priority queue.
   */
  bubbleFromNestedEditors?: boolean;
}

/**
 * The modifier mask for the primary shortcut modifier:
 * ⌘ (metaKey) on Apple platforms and Ctrl elsewhere.
 */
export const CONTROL_OR_META: KeyboardEventModifierMask &
  KeyboardEventControlOrOther = {
  [CONTROL_OR_OTHER_KEY]: 'metaKey',
  ctrlKey: !IS_APPLE,
  metaKey: IS_APPLE,
};

/**
 * The modifier mask for the secondary shortcut modifier:
 * Option (altKey) on Apple platforms and Ctrl elsewhere, conventionally
 * used for word-level editing and block-format shortcuts.
 */
export const CONTROL_OR_ALT: KeyboardEventModifierMask &
  KeyboardEventControlOrOther = {
  [CONTROL_OR_OTHER_KEY]: 'altKey',
  altKey: IS_APPLE,
  ctrlKey: !IS_APPLE,
};

const MODIFIER_BITS = [
  ['altKey', 1],
  ['ctrlKey', 2],
  ['metaKey', 4],
  ['shiftKey', 8],
] as const;

function getEventModifierBits(event: KeyboardEventModifiers): number {
  let bits = 0;
  for (const [prop, bit] of MODIFIER_BITS) {
    if (event[prop]) {
      bits |= bit;
    }
  }
  return bits;
}

/**
 * Enumerate the modifier bitmasks that satisfy the mask, expanding each
 * `'any'` into both states (so a mask with two `'any'` yields four
 * bitmasks, and a fully concrete mask yields exactly one).
 */
function getMaskModifierBits(mask: KeyboardEventModifierMask): number[] {
  let combos = [0];
  for (const [prop, bit] of MODIFIER_BITS) {
    const expected = mask[prop] || false;
    if (expected === 'any') {
      combos = combos.concat(combos.map(bits => bits | bit));
    } else if (expected) {
      combos = combos.map(bits => bits | bit);
    }
  }
  return combos;
}

function pushEntry<S>(map: Map<string, S[]>, mapKey: string, shortcut: S) {
  const entry = map.get(mapKey);
  if (entry) {
    entry.push(shortcut);
  } else {
    map.set(mapKey, [shortcut]);
  }
}

/**
 * @experimental @internal
 *
 * A shortcut table compiled for O(1) dispatch. Look-up is by a composite of
 * the event's modifier bitmask and its `key` (with a second look-up by
 * `code` for non-Latin layouts), so the cost of {@link match} /
 * {@link matches} is independent of the number of shortcuts in the table.
 */
export class CompiledKeyboardShortcuts<
  S extends KeyboardShortcutMatch = KeyboardShortcut,
> {
  /** `${modifierBits}:${key.toLowerCase()}` -> shortcuts in insertion order */
  private byKey: Map<string, S[]> = new Map();
  /**
   * `${modifierBits}:${code}` (e.g. `Digit1`, `KeyB`) -> shortcuts, used
   * only when `event.key` is not a single ASCII character so that
   * single-character shortcuts still work on non-Latin keyboard layouts
   * (the same fallback as {@link isExactShortcutMatch})
   */
  private byCode: Map<string, S[]> = new Map();

  add(shortcut: S): this {
    const {key, modifiers = {}} = shortcut;
    invariant(key.length > 0, 'KeyboardShortcutMatch: key must be non-empty');
    const lowerKey = key.toLowerCase();
    for (const bits of getMaskModifierBits(modifiers)) {
      pushEntry(this.byKey, `${bits}:${lowerKey}`, shortcut);
      if (key.length === 1) {
        if (/[0-9]/.test(key)) {
          pushEntry(this.byCode, `${bits}:Digit${key}`, shortcut);
        } else if (/[a-z]/.test(lowerKey)) {
          pushEntry(
            this.byCode,
            `${bits}:Key${lowerKey.toUpperCase()}`,
            shortcut,
          );
        }
      }
    }
    return this;
  }

  /**
   * All shortcuts matching the event, in insertion order.
   * Matches by `key` precede matches by the `code` fallback.
   * @see {@link match} for the single-result fast path.
   */
  matches(event: KeyboardEventModifiers): S[] {
    const key = event.key;
    if (!key) {
      return [];
    }
    const bits = getEventModifierBits(event);
    const byKey = this.byKey.get(`${bits}:${key.toLowerCase()}`);
    const matches = byKey ? byKey.slice() : [];
    // The code fallback only applies when event.key is not a single ASCII
    // character, otherwise it would break remapped layouts (Dvorak, etc.)
    if (
      this.byCode.size > 0 &&
      !(key.length === 1 && key.charCodeAt(0) <= 127)
    ) {
      const byCode = this.byCode.get(`${bits}:${event.code}`);
      if (byCode) {
        matches.push(...byCode);
      }
    }
    return matches;
  }

  /**
   * The first shortcut matching the event, if any.
   * @see {@link matches} for the full list of matching shortcuts.
   */
  match(event: KeyboardEventModifiers): S | undefined {
    return this.matches(event)[0];
  }
}

/**
 * @experimental @internal
 *
 * Compile a table of keyboard shortcuts down to a form that dispatches
 * based on the pressed key and modifiers in O(1), instead of testing each
 * shortcut in sequence.
 */
export function compileKeyboardShortcuts<S extends KeyboardShortcutMatch>(
  shortcuts: Iterable<S>,
): CompiledKeyboardShortcuts<S> {
  const compiled = new CompiledKeyboardShortcuts<S>();
  for (const shortcut of shortcuts) {
    compiled.add(shortcut);
  }
  return compiled;
}
