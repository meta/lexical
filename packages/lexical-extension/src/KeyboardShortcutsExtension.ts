/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getSelection,
  type BaseSelection,
  COMMAND_PRIORITY_NORMAL,
  type CommandListenerPriority,
  type CommandListenerPriorityBefore,
  compileKeyboardShortcuts,
  defineExtension,
  IS_APPLE,
  KEY_DOWN_COMMAND,
  keyboardEventMaskForPlatform,
  type KeyboardShortcut,
  type KeyboardShortcutMatch,
  type LexicalEditor,
  safeCast,
  shallowMergeConfig,
} from 'lexical';

import {namedSignals} from './namedSignals';
import {effect} from './signals';

export interface FormatKeyboardShortcutOptions {
  /** Override the platform convention (defaults to the runtime platform) */
  isApple?: boolean;
  /** The separator between segments (default `'+'`) */
  separator?: string;
}

const MODIFIERS = [
  ['ctrlKey', 'Ctrl'],
  ['altKey', 'Alt'],
  ['shiftKey', 'Shift'],
  ['metaKey', 'Meta'],
] as const;

const UNIVERSAL_KEYS: Record<string, string | undefined> = {
  ' ': 'Space',
};

const APPLE_KEYS: Record<string, string | undefined> = {
  ...UNIVERSAL_KEYS,
  Alt: '\u2325',
  ArrowDown: '\u2193',
  ArrowLeft: '\u2190',
  ArrowRight: '\u2192',
  ArrowUp: '\u2191',
  Backspace: '\u232B',
  CapsLock: '\u21EA',
  Ctrl: '\u2303',
  Delete: '\u2326',
  End: '\u2198',
  Enter: '\u21A9',
  Escape: '\u238B',
  Home: '\u2196',
  Meta: '\u2318',
  PageDown: '\u21DF',
  PageUp: '\u21DE',
  Shift: '\u21E7',
  Tab: '\u21E5',
};
const SHIFT_APPLE_KEYS: Record<string, string | undefined> = {
  ...APPLE_KEYS,
  Tab: '\u21E4',
};

/**
 * Format the key binding of a shortcut as a human readable string for
 * menus, tooltips, and help dialogs (e.g. `'⌘+Shift+K'` on Apple platforms
 * and `'Ctrl+Shift+K'` elsewhere). Modifiers with an `'any'` mask are not
 * displayed.
 */
export function formatKeyboardShortcut(
  shortcut: KeyboardShortcutMatch,
  options: FormatKeyboardShortcutOptions = {},
): string[] {
  const {isApple = IS_APPLE} = options;
  const {unshiftedKey, key} = shortcut;
  const modifiers = keyboardEventMaskForPlatform(
    shortcut.modifiers || {},
    isApple,
  );
  const segments: string[] = [];
  const keyNames = isApple
    ? modifiers.shiftKey === true
      ? SHIFT_APPLE_KEYS
      : APPLE_KEYS
    : UNIVERSAL_KEYS;
  for (const [k, name] of MODIFIERS) {
    if (modifiers[k] === true) {
      // Apple omits the shift modifier in cases where unshifted key
      // differs from the key, e.g. 'shift+/', is displayed as '?'
      if (isApple && k === 'shiftKey' && unshiftedKey && key.length === 1) {
        continue;
      }
      segments.push(keyNames[name] || name);
    }
  }
  segments.push(
    keyNames[key] ||
      (!isApple && modifiers.shiftKey === true && unshiftedKey) ||
      (key.length === 1 && key.toUpperCase()) ||
      key,
  );
  return segments;
}

/**
 * Keyboard shortcuts by name. The names exist so that other extensions and
 * applications can overlay the table: configuring an existing name remaps
 * that shortcut, configuring it to null disables it, and new names add new
 * shortcuts.
 * @experimental
 */
export type NamedKeyboardShortcuts = Record<
  string,
  KeyboardShortcut | readonly KeyboardShortcut[] | null
>;

/**
 * Configuration for {@link KeyboardShortcutsExtension}.
 * @experiemental
 */
export interface KeyboardShortcutsConfig {
  /** When `true`, the shortcut listener is not registered */
  disabled: boolean;
  /**
   * The `KEY_DOWN_COMMAND` priority (default {@link COMMAND_PRIORITY_NORMAL}).
   *
   * This must be a priority *above* {@link COMMAND_PRIORITY_EDITOR}. Every
   * editor registers the core `$handleKeyDown` at
   * {@link COMMAND_PRIORITY_EDITOR} and it unconditionally reports the event
   * as handled, so a shortcut listener at that priority or later is never
   * reached. That also rules out
   * {@link COMMAND_PRIORITY_BEFORE_EDITOR}: command dispatch walks priorities
   * from {@link COMMAND_PRIORITY_CRITICAL} down to
   * {@link COMMAND_PRIORITY_EDITOR} on the *outside* and the nested editor
   * chain on the inside, so a nested editor's own `$handleKeyDown` ends the
   * dispatch before any listener the parent has in the editor-priority queue —
   * which would make {@link KeyboardShortcut.bubbleFromNestedEditors}
   * impossible to satisfy.
   */
  priority: CommandListenerPriority | CommandListenerPriorityBefore;
  /** The named shortcut table, merged by name across the extension graph */
  shortcuts: NamedKeyboardShortcuts;
}

/**
 * @experimental @internal
 *
 * Compile the given shortcuts and register a single
 * {@link KEY_DOWN_COMMAND} listener that dispatches each matched shortcut's
 * command with the KeyboardEvent as its payload (unless its `$disabled`
 * predicate returns true for the current selection). When several
 * shortcuts match the same event they are tried in the given order until
 * one command dispatch is handled.
 *
 * @returns A cleanup function that unregisters the listener.
 */
function registerKeyboardShortcuts(
  editor: LexicalEditor,
  shortcuts: Iterable<KeyboardShortcut>,
  priority: CommandListenerPriority | CommandListenerPriorityBefore,
): () => void {
  const compiled = compileKeyboardShortcuts(shortcuts);
  return editor.registerCommand(
    KEY_DOWN_COMMAND,
    (event, fromEditor) => {
      let selection: undefined | null | BaseSelection;
      for (const shortcut of compiled.matches(event)) {
        if (editor !== fromEditor && !shortcut.bubbleFromNestedEditors) {
          continue;
        }
        if (shortcut.$disabled) {
          if (selection === undefined) {
            selection = $getSelection();
          }
          if (shortcut.$disabled(selection, fromEditor)) {
            continue;
          }
        }
        const $next = fromEditor.dispatchCommand.bind(
          fromEditor,
          shortcut.command,
          event,
        );
        if (
          shortcut.$dispatch
            ? shortcut.$dispatch(shortcut.command, event, $next, fromEditor)
            : $next()
        ) {
          return true;
        }
      }
      return false;
    },
    priority,
  );
}

function isReadonlyArray<T>(x: unknown): x is readonly T[] {
  return Array.isArray(x);
}

function flattenKeyboardShortcuts(
  shortcuts: readonly KeyboardShortcut[] | KeyboardShortcut | null,
): readonly KeyboardShortcut[] {
  return isReadonlyArray(shortcuts) ? shortcuts : shortcuts ? [shortcuts] : [];
}

/**
 * Merge by name, as {@link shallowMergeConfig} would, except that the
 * overriding names come *first* in object entry iteration so that they are
 * also the first to be offered a matching keypress.
 */
function mergeNamedShortcuts(
  config: NamedKeyboardShortcuts,
  overrides: undefined | NamedKeyboardShortcuts,
) {
  if (!overrides) {
    return config;
  }
  const dest = {...overrides};
  for (const [k, v0] of Object.entries(config)) {
    if (dest[k] === undefined) {
      dest[k] = v0;
    }
  }
  return dest;
}

/**
 * @experimental
 *
 * Dispatches a table of keyboard shortcuts from a single compiled
 * `KEY_DOWN_COMMAND` listener, in O(1) per keypress.
 *
 * The table is merged across the whole extension graph by name: any
 * extension or app config can add shortcuts under new names, remap an
 * existing name to a different key or handler, or disable one by
 * configuring it to null. The output exposes the config as signals, so the
 * table can also be remapped at runtime through the `shortcuts` signal
 * (the listener is recompiled on change).
 *
 * Configuring an existing name always replaces its mapping outright, and a
 * name may be mapped to an array to give it several bindings at once. The
 * overriding names are also matched first, ahead of the names they did not
 * override, when more than one shortcut matches the same keypress.
 */
export const KeyboardShortcutsExtension = defineExtension({
  build(editor, config, state) {
    return namedSignals(config);
  },
  config: safeCast<KeyboardShortcutsConfig>({
    disabled: false,
    priority: COMMAND_PRIORITY_NORMAL,
    shortcuts: {},
  }),
  mergeConfig(config, overrides) {
    const merged = shallowMergeConfig(config, overrides);
    merged.shortcuts = mergeNamedShortcuts(
      config.shortcuts,
      overrides.shortcuts,
    );
    return merged;
  },
  name: '@lexical/extension/KeyboardShortcuts',
  register(editor, config, state) {
    const {disabled, priority, shortcuts} = state.getOutput();
    return effect(() => {
      if (!disabled.value) {
        const allShortcuts: KeyboardShortcut[] = [];
        for (const shortcutConfig of Object.values(shortcuts.value)) {
          for (const v of flattenKeyboardShortcuts(shortcutConfig)) {
            allShortcuts.push(v);
          }
        }
        return registerKeyboardShortcuts(editor, allShortcuts, priority.value);
      }
    });
  },
});
