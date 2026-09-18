/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  KeyboardShortcut,
  KeyboardShortcutMatch,
  KeyboardShortcutsConfig,
  NamedKeyboardShortcuts,
} from '@lexical/extension';

import {
  buildEditorFromExtensions,
  compileKeyboardShortcuts,
  formatKeyboardShortcut,
  getExtensionDependencyFromEditor,
  KeyboardShortcutsExtension,
  NestedEditorExtension,
} from '@lexical/extension';
import {
  COMMAND_PRIORITY_BEFORE_EDITOR,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_NORMAL,
  configExtension,
  CONTROL_OR_ALT,
  CONTROL_OR_META,
  createCommand,
  defineExtension,
  isExactShortcutMatch,
  KEY_DOWN_COMMAND,
  type KeyboardEventModifierMask,
  type KeyboardEventModifiers,
  type LexicalCommand,
  type LexicalEditor,
  mergeRegister,
  safeCast,
} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

function makeEvent(
  key: string,
  code: string,
  bits: number,
): KeyboardEventModifiers {
  return {
    altKey: Boolean(bits & 1),
    code,
    ctrlKey: Boolean(bits & 2),
    key,
    metaKey: Boolean(bits & 4),
    shiftKey: Boolean(bits & 8),
  };
}

function keyboardEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', {cancelable: true, ...init});
}

describe('compileKeyboardShortcuts', () => {
  // Every (key, code) pair crossed with all 16 modifier states, covering
  // exact key matches, case-insensitivity, and the event.code fallback for
  // non-Latin layouts (Cyrillic letter, Arabic-Indic digit)
  const EVENT_KEYS: [string, string][] = [
    ['b', 'KeyB'],
    ['B', 'KeyB'],
    ['б', 'KeyB'],
    ['1', 'Digit1'],
    ['!', 'Digit1'],
    ['١', 'Digit1'],
    ['Enter', 'Enter'],
    [',', 'Comma'],
    ['[', 'BracketLeft'],
    ['z', 'KeyZ'],
  ];
  const SHORTCUTS: [string, KeyboardEventModifierMask][] = [
    ['b', {ctrlKey: true}],
    ['B', {metaKey: true}],
    ['1', {altKey: true, ctrlKey: true}],
    ['Enter', {shiftKey: 'any'}],
    [',', {ctrlKey: true}],
    ['[', {}],
    ['z', {ctrlKey: true, shiftKey: 'any'}],
  ];

  test('matches exactly the events that isExactShortcutMatch matches', () => {
    for (const [key, modifiers] of SHORTCUTS) {
      const compiled = compileKeyboardShortcuts([{key, modifiers}]);
      for (const [eventKey, eventCode] of EVENT_KEYS) {
        for (let bits = 0; bits < 16; bits++) {
          const event = makeEvent(eventKey, eventCode, bits);
          expect(
            compiled.match(event) !== undefined,
            `key=${key} modifiers=${JSON.stringify(
              modifiers,
            )} event=${JSON.stringify(event)}`,
          ).toBe(isExactShortcutMatch(event, key, modifiers));
        }
      }
    }
  });

  test('matches returns all matching shortcuts in insertion order', () => {
    const first = {key: 'k', modifiers: {ctrlKey: true}, name: 'first'};
    const second = {
      key: 'K',
      modifiers: {ctrlKey: true, shiftKey: 'any'},
      name: 'second',
    } as const;
    const other = {key: 'j', modifiers: {ctrlKey: true}, name: 'other'};
    const compiled = compileKeyboardShortcuts([first, second, other]);
    expect(compiled.matches(makeEvent('k', 'KeyK', 2))).toEqual([
      first,
      second,
    ]);
    expect(compiled.matches(makeEvent('K', 'KeyK', 2 | 8))).toEqual([second]);
    expect(compiled.matches(makeEvent('k', 'KeyK', 0))).toEqual([]);
  });
});

describe('formatKeyboardShortcut', () => {
  test('CONTROL_OR_META', () => {
    expect(
      formatKeyboardShortcut(
        {key: ' ', modifiers: CONTROL_OR_META},
        {isApple: true},
      ),
    ).toEqual(['\u2318', 'Space']);
    expect(
      formatKeyboardShortcut(
        {key: ' ', modifiers: CONTROL_OR_META},
        {isApple: false},
      ),
    ).toEqual(['Ctrl', 'Space']);
  });
  test('CONTROL_OR_ALT', () => {
    expect(
      formatKeyboardShortcut(
        {key: ' ', modifiers: CONTROL_OR_ALT},
        {isApple: true},
      ),
    ).toEqual(['\u2325', 'Space']);
    expect(
      formatKeyboardShortcut(
        {key: ' ', modifiers: CONTROL_OR_ALT},
        {isApple: false},
      ),
    ).toEqual(['Ctrl', 'Space']);
  });
  test.for(
    safeCast<[KeyboardShortcutMatch, string, string][]>([
      [
        {key: 'k', modifiers: {metaKey: true, shiftKey: true}},
        '⇧+⌘+K',
        'Shift+Meta+K',
      ],
      [
        {key: 'q', modifiers: {ctrlKey: true, shiftKey: true}},
        '\u2303+⇧+Q',
        'Ctrl+Shift+Q',
      ],
      [
        {key: 'q', modifiers: {...CONTROL_OR_META, shiftKey: true}},
        '⇧+⌘+Q',
        'Ctrl+Shift+Q',
      ],
      [
        {key: 'Backspace', modifiers: {...CONTROL_OR_ALT}},
        '\u2325+\u232B',
        'Ctrl+Backspace',
      ],
      [{key: ' '}, 'Space', 'Space'],
      [{key: 'ArrowLeft', modifiers: {shiftKey: 'any'}}, '\u2190', 'ArrowLeft'],
    ]),
  )(
    'formatKeyboardShortcut(%o) -> apple: %s other: %s',
    ([shortcut, apple, other]) => {
      expect(
        [true, false].map(isApple =>
          formatKeyboardShortcut(shortcut, {isApple}).join('+'),
        ),
      ).toEqual([apple, other]);
    },
  );
  test('formats platform conventions', () => {
    const shortcut = {key: 'k', modifiers: {metaKey: true, shiftKey: true}};
    expect(formatKeyboardShortcut(shortcut, {isApple: true}).join('+')).toBe(
      '⇧+⌘+K',
    );
    expect(formatKeyboardShortcut(shortcut, {isApple: false}).join('+')).toBe(
      'Shift+Meta+K',
    );
    expect(
      formatKeyboardShortcut(
        {key: 'q', modifiers: {ctrlKey: true, shiftKey: true}},
        {isApple: true},
      ).join('+'),
    ).toBe('⌃+⇧+Q');
    expect(
      formatKeyboardShortcut(
        {key: '0', modifiers: {altKey: true, ctrlKey: true}},
        {isApple: false},
      ).join('+'),
    ).toBe('Ctrl+Alt+0');
    expect(formatKeyboardShortcut({key: ' '}, {isApple: false}).join('+')).toBe(
      'Space',
    );
    expect(
      formatKeyboardShortcut(
        {key: 'ArrowLeft', modifiers: {shiftKey: 'any'}},
        {isApple: false},
      ).join('+'),
    ).toBe('ArrowLeft');
  });
});

/**
 * Build an editor with the given shortcuts registered plus a recording
 * listener for each distinct command (returning `handled` for it).
 */
function buildTestEditor(
  shortcuts: NamedKeyboardShortcuts,
  listeners: [
    LexicalCommand<KeyboardEvent>,
    (event: KeyboardEvent) => boolean,
  ][],
) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [configExtension(KeyboardShortcutsExtension, {shortcuts})],
      name: 'keyboard-shortcuts-test',
      register: editor =>
        mergeRegister(
          ...listeners.map(([command, listener]) =>
            editor.registerCommand(command, listener, COMMAND_PRIORITY_EDITOR),
          ),
        ),
    }),
  );
}

/**
 * Build an editor whose KeyboardShortcutsExtension is configured by each of
 * `layers` in order, so that later layers are merged over earlier ones the
 * way an app config is merged over the extensions it depends on.
 */
function buildLayeredEditor(
  layers: Partial<KeyboardShortcutsConfig>[],
  listeners: [
    LexicalCommand<KeyboardEvent>,
    (event: KeyboardEvent) => boolean,
  ][],
) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: layers.map(layer =>
        configExtension(KeyboardShortcutsExtension, layer),
      ),
      name: 'layered-test',
      register: editor =>
        mergeRegister(
          ...listeners.map(([command, listener]) =>
            editor.registerCommand(command, listener, COMMAND_PRIORITY_EDITOR),
          ),
        ),
    }),
  );
}

/**
 * A set of distinct commands whose listeners append their name to `calls` as
 * they are dispatched, for asserting the order in which a keypress is offered
 * to the shortcuts that match it.
 */
function commandRecorder() {
  const calls: string[] = [];
  const listeners: [
    LexicalCommand<KeyboardEvent>,
    (event: KeyboardEvent) => boolean,
  ][] = [];
  /** A Ctrl+K shortcut for a fresh command that records `name` when handled */
  function ctrlKShortcut(name: string, handled = true): KeyboardShortcut {
    const command = createCommand<KeyboardEvent>(`recorder/${name}`);
    listeners.push([
      command,
      () => {
        calls.push(name);
        return handled;
      },
    ]);
    return {command, key: 'k', modifiers: {ctrlKey: true}};
  }
  return {calls, ctrlKShortcut, listeners};
}

const ctrlK = () => keyboardEvent({ctrlKey: true, key: 'k'});

describe('registerKeyboardShortcuts', () => {
  test('dispatches the matched shortcut command with the event as payload', () => {
    const BOLD_COMMAND = createCommand<KeyboardEvent>('test/BOLD');
    const ITALIC_COMMAND = createCommand<KeyboardEvent>('test/ITALIC');
    const bold = vi.fn().mockReturnValue(true);
    const italic = vi.fn().mockReturnValue(true);
    const editor = buildTestEditor(
      {
        BOLD: {command: BOLD_COMMAND, key: 'b', modifiers: {ctrlKey: true}},
        ITALIC: {command: ITALIC_COMMAND, key: 'i', modifiers: {ctrlKey: true}},
      },
      [
        [BOLD_COMMAND, bold],
        [ITALIC_COMMAND, italic],
      ],
    );
    const event = keyboardEvent({ctrlKey: true, key: 'b'});
    expect(editor.dispatchCommand(KEY_DOWN_COMMAND, event)).toBe(true);
    expect(bold).toHaveBeenCalledTimes(1);
    expect(bold.mock.calls[0][0]).toBe(event);
    expect(italic).not.toHaveBeenCalled();
    // No modifier match -> no dispatch (the event may still be handled by
    // the core $handleKeyDown listener at COMMAND_PRIORITY_EDITOR)
    editor.dispatchCommand(KEY_DOWN_COMMAND, keyboardEvent({key: 'b'}));
    expect(bold).toHaveBeenCalledTimes(1);
    editor.dispose();
  });

  test('falls through to the next matching shortcut when a dispatch is unhandled', () => {
    const SKIPPED_COMMAND = createCommand<KeyboardEvent>('test/SKIPPED');
    const HANDLED_COMMAND = createCommand<KeyboardEvent>('test/HANDLED');
    const skipped = vi.fn().mockReturnValue(false);
    const handled = vi.fn().mockReturnValue(true);
    const editor = buildTestEditor(
      {
        SKIPPED: {
          command: SKIPPED_COMMAND,
          key: 'k',
          modifiers: {ctrlKey: true},
        },
        // eslint-disable-next-line sort-keys-fix/sort-keys-fix -- intentionally after SKIPPED
        HANDLED: {
          command: HANDLED_COMMAND,
          key: 'k',
          modifiers: {ctrlKey: true},
        },
      },
      [
        [SKIPPED_COMMAND, skipped],
        [HANDLED_COMMAND, handled],
      ],
    );
    const event = keyboardEvent({ctrlKey: true, key: 'k'});
    expect(editor.dispatchCommand(KEY_DOWN_COMMAND, event)).toBe(true);
    expect(skipped).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledTimes(1);
    editor.dispose();
  });

  test('skips shortcuts whose $disabled predicate returns true', () => {
    const DISABLED_COMMAND = createCommand<KeyboardEvent>('test/DISABLED');
    const ENABLED_COMMAND = createCommand<KeyboardEvent>('test/ENABLED');
    const disabled = vi.fn().mockReturnValue(true);
    const enabled = vi.fn().mockReturnValue(true);
    const $disabled = vi.fn().mockReturnValue(true);
    const editor = buildTestEditor(
      {
        DISABLED: {
          $disabled,
          command: DISABLED_COMMAND,
          key: 'k',
          modifiers: {ctrlKey: true},
        },
        ENABLED: {
          command: ENABLED_COMMAND,
          key: 'k',
          modifiers: {ctrlKey: true},
        },
      },
      [
        [DISABLED_COMMAND, disabled],
        [ENABLED_COMMAND, enabled],
      ],
    );
    const event = keyboardEvent({ctrlKey: true, key: 'k'});
    expect(editor.dispatchCommand(KEY_DOWN_COMMAND, event)).toBe(true);
    expect($disabled).toHaveBeenCalledTimes(1);
    expect(disabled).not.toHaveBeenCalled();
    expect(enabled).toHaveBeenCalledTimes(1);
    editor.dispose();
  });

  test('falls through when $dispatch returns false', () => {
    const SKIPPED_COMMAND = createCommand<KeyboardEvent>('test/DISPATCH_SKIP');
    const HANDLED_COMMAND = createCommand<KeyboardEvent>(
      'test/DISPATCH_HANDLED',
    );
    const handled = vi.fn().mockReturnValue(true);
    const editor = buildTestEditor(
      {
        SKIPPED: {
          $dispatch: (_command, _event, _$next) => false,
          command: SKIPPED_COMMAND,
          key: 'k',
          modifiers: {ctrlKey: true},
        },
        // eslint-disable-next-line sort-keys-fix/sort-keys-fix -- intentionally after SKIPPED
        HANDLED: {
          command: HANDLED_COMMAND,
          key: 'k',
          modifiers: {ctrlKey: true},
        },
      },
      [[HANDLED_COMMAND, handled]],
    );
    const event = keyboardEvent({ctrlKey: true, key: 'k'});
    expect(editor.dispatchCommand(KEY_DOWN_COMMAND, event)).toBe(true);
    expect(handled).toHaveBeenCalledTimes(1);
    editor.dispose();
  });

  test('$dispatch middleware wraps the command dispatch', () => {
    const WRAPPED_COMMAND = createCommand<KeyboardEvent>('test/WRAPPED');
    const listener = vi.fn().mockReturnValue(true);
    const order: string[] = [];
    const editor = buildTestEditor(
      {
        WRAPPED: {
          $dispatch: (command, event, $next, editor2) => {
            expect(command).toBe(WRAPPED_COMMAND);
            expect(editor2).toBe(editor);
            order.push('before');
            const handled = $next();
            order.push('after');
            return handled;
          },
          command: WRAPPED_COMMAND,
          key: 'k',
          modifiers: {ctrlKey: true},
        },
      },
      [
        [
          WRAPPED_COMMAND,
          event => {
            order.push('listener');
            return listener(event);
          },
        ],
      ],
    );
    const event = keyboardEvent({ctrlKey: true, key: 'k'});
    expect(editor.dispatchCommand(KEY_DOWN_COMMAND, event)).toBe(true);
    expect(order).toEqual(['before', 'listener', 'after']);
    editor.dispose();
  });
});

describe('KeyboardShortcutsExtension', () => {
  const shortcutWith = (
    command: LexicalCommand<KeyboardEvent>,
    key: string,
    modifiers: KeyboardEventModifierMask,
  ): KeyboardShortcut => ({command, key, modifiers});

  function buildExtensionEditor(
    shortcuts: NamedKeyboardShortcuts,
    listeners: [
      LexicalCommand<KeyboardEvent>,
      (event: KeyboardEvent) => boolean,
    ][],
    overlay?: NamedKeyboardShortcuts,
  ) {
    return buildLayeredEditor(
      overlay ? [{shortcuts}, {shortcuts: overlay}] : [{shortcuts}],
      listeners,
    );
  }

  test('dispatches configured shortcuts', () => {
    const BOLD_COMMAND = createCommand<KeyboardEvent>('ext/BOLD');
    const bold = vi.fn().mockReturnValue(true);
    const editor = buildExtensionEditor(
      {bold: shortcutWith(BOLD_COMMAND, 'b', {ctrlKey: true})},
      [[BOLD_COMMAND, bold]],
    );
    editor.dispatchCommand(
      KEY_DOWN_COMMAND,
      keyboardEvent({ctrlKey: true, key: 'b'}),
    );
    expect(bold).toHaveBeenCalledTimes(1);
    editor.dispose();
  });

  test('overlays merge by name: add, remap, and disable', () => {
    const BOLD_COMMAND = createCommand<KeyboardEvent>('overlay/BOLD');
    const ITALIC_COMMAND = createCommand<KeyboardEvent>('overlay/ITALIC');
    const CUSTOM_COMMAND = createCommand<KeyboardEvent>('overlay/CUSTOM');
    const bold = vi.fn().mockReturnValue(true);
    const italic = vi.fn().mockReturnValue(true);
    const custom = vi.fn().mockReturnValue(true);
    const editor = buildExtensionEditor(
      {
        bold: shortcutWith(BOLD_COMMAND, 'b', {ctrlKey: true}),
        italic: shortcutWith(ITALIC_COMMAND, 'i', {ctrlKey: true}),
      },
      [
        [BOLD_COMMAND, bold],
        [ITALIC_COMMAND, italic],
        [CUSTOM_COMMAND, custom],
      ],
      {
        // remap bold to a different key
        bold: shortcutWith(BOLD_COMMAND, 'b', {ctrlKey: true, shiftKey: true}),
        // add a new shortcut
        custom: shortcutWith(CUSTOM_COMMAND, 'm', {altKey: true}),
        // disable italic
        italic: null,
      },
    );
    editor.dispatchCommand(
      KEY_DOWN_COMMAND,
      keyboardEvent({ctrlKey: true, key: 'b'}),
    );
    expect(bold).not.toHaveBeenCalled();
    editor.dispatchCommand(
      KEY_DOWN_COMMAND,
      keyboardEvent({ctrlKey: true, key: 'b', shiftKey: true}),
    );
    expect(bold).toHaveBeenCalledTimes(1);
    editor.dispatchCommand(
      KEY_DOWN_COMMAND,
      keyboardEvent({ctrlKey: true, key: 'i'}),
    );
    expect(italic).not.toHaveBeenCalled();
    editor.dispatchCommand(
      KEY_DOWN_COMMAND,
      keyboardEvent({altKey: true, key: 'm'}),
    );
    expect(custom).toHaveBeenCalledTimes(1);
    editor.dispose();
  });

  test('shortcuts can be remapped and disabled at runtime through the output signals', () => {
    const BOLD_COMMAND = createCommand<KeyboardEvent>('runtime/BOLD');
    const bold = vi.fn().mockReturnValue(true);
    const editor = buildExtensionEditor(
      {bold: shortcutWith(BOLD_COMMAND, 'b', {ctrlKey: true})},
      [[BOLD_COMMAND, bold]],
    );
    const {output} = getExtensionDependencyFromEditor(
      editor,
      KeyboardShortcutsExtension,
    );
    output.shortcuts.value = {
      ...output.shortcuts.value,
      bold: shortcutWith(BOLD_COMMAND, 'b', {metaKey: true}),
    };
    editor.dispatchCommand(
      KEY_DOWN_COMMAND,
      keyboardEvent({ctrlKey: true, key: 'b'}),
    );
    expect(bold).not.toHaveBeenCalled();
    editor.dispatchCommand(
      KEY_DOWN_COMMAND,
      keyboardEvent({key: 'b', metaKey: true}),
    );
    expect(bold).toHaveBeenCalledTimes(1);

    output.disabled.value = true;
    editor.dispatchCommand(
      KEY_DOWN_COMMAND,
      keyboardEvent({key: 'b', metaKey: true}),
    );
    expect(bold).toHaveBeenCalledTimes(1);
    editor.dispose();
  });
});

describe('KeyboardShortcutsExtension shortcut table merge', () => {
  test('a later layer replaces the mapping it overrides', () => {
    const rec = commandRecorder();
    const editor = buildLayeredEditor(
      [
        {shortcuts: {bold: rec.ctrlKShortcut('base', false)}},
        {shortcuts: {bold: rec.ctrlKShortcut('override', false)}},
      ],
      rec.listeners,
    );
    // The override left the event unhandled, and the mapping it replaced is
    // gone rather than being a fallback for it
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual(['override']);
    editor.dispose();
  });

  test('only the last layer to configure a name survives', () => {
    const rec = commandRecorder();
    const editor = buildLayeredEditor(
      [
        {shortcuts: {bold: rec.ctrlKShortcut('first', false)}},
        {shortcuts: {bold: rec.ctrlKShortcut('second', false)}},
        {shortcuts: {bold: rec.ctrlKShortcut('third', false)}},
      ],
      rec.listeners,
    );
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual(['third']);
    editor.dispose();
  });

  test('null disables the name', () => {
    const rec = commandRecorder();
    const editor = buildLayeredEditor(
      [
        {shortcuts: {bold: rec.ctrlKShortcut('base', false)}},
        {shortcuts: {bold: null}},
      ],
      rec.listeners,
    );
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual([]);
    editor.dispose();
  });

  test('an array replaces the mapping with several bindings', () => {
    const rec = commandRecorder();
    const replaced = rec.ctrlKShortcut('replaced', false);
    const editor = buildLayeredEditor(
      [
        {shortcuts: {bold: rec.ctrlKShortcut('base', false)}},
        {shortcuts: {bold: [replaced]}},
      ],
      rec.listeners,
    );
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual(['replaced']);
    editor.dispose();
  });

  test('an empty array disables the name like null does', () => {
    const rec = commandRecorder();
    const editor = buildLayeredEditor(
      [
        {shortcuts: {bold: rec.ctrlKShortcut('base', false)}},
        {shortcuts: {bold: []}},
      ],
      rec.listeners,
    );
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual([]);
    editor.dispose();
  });

  test('a name mapped to an array registers every entry in order', () => {
    const rec = commandRecorder();
    const editor = buildLayeredEditor(
      [
        {
          shortcuts: {
            bold: [
              rec.ctrlKShortcut('first', false),
              rec.ctrlKShortcut('second', false),
            ],
          },
        },
      ],
      rec.listeners,
    );
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual(['first', 'second']);
    editor.dispose();
  });

  test('names added by a later layer are matched before existing names', () => {
    const rec = commandRecorder();
    // 'zzz' sorts after 'aaa', so only the layer order can put it first
    const editor = buildLayeredEditor(
      [
        {shortcuts: {aaa: rec.ctrlKShortcut('aaa', false)}},
        {shortcuts: {zzz: rec.ctrlKShortcut('zzz', false)}},
      ],
      rec.listeners,
    );
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual(['zzz', 'aaa']);
    editor.dispose();
  });

  test('a layer that configures no shortcuts leaves the table alone', () => {
    const rec = commandRecorder();
    const editor = buildLayeredEditor(
      [
        {shortcuts: {bold: rec.ctrlKShortcut('base')}},
        {priority: COMMAND_PRIORITY_CRITICAL},
      ],
      rec.listeners,
    );
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual(['base']);
    editor.dispose();
  });

  test('arrays assigned to the runtime signal are flattened too', () => {
    const rec = commandRecorder();
    // All commands must exist before the editor is built so their listeners
    // are registered, even the ones only used after the signal is assigned
    const base = rec.ctrlKShortcut('base', false);
    const runtimeFirst = rec.ctrlKShortcut('runtimeFirst', false);
    const runtimeSecond = rec.ctrlKShortcut('runtimeSecond', false);
    const editor = buildLayeredEditor(
      [{shortcuts: {bold: base}}],
      rec.listeners,
    );
    const {output} = getExtensionDependencyFromEditor(
      editor,
      KeyboardShortcutsExtension,
    );
    output.shortcuts.value = {bold: [runtimeFirst, runtimeSecond]};
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual(['runtimeFirst', 'runtimeSecond']);
    editor.dispose();
  });
});

describe('KeyboardShortcutsExtension priority', () => {
  test('defaults to COMMAND_PRIORITY_NORMAL, ahead of $handleKeyDown', () => {
    const rec = commandRecorder();
    const editor = buildLayeredEditor(
      [{shortcuts: {bold: rec.ctrlKShortcut('bold')}}],
      rec.listeners,
    );
    const {output} = getExtensionDependencyFromEditor(
      editor,
      KeyboardShortcutsExtension,
    );
    expect(output.priority.value).toBe(COMMAND_PRIORITY_NORMAL);
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual(['bold']);

    // Every editor registers the core $handleKeyDown at
    // COMMAND_PRIORITY_EDITOR and it always reports the event as handled, so
    // a shortcut listener at that priority is never reached. (BEFORE_EDITOR
    // is early enough for a lone editor, but not for nested ones — see
    // 'bubbling requires a priority above COMMAND_PRIORITY_EDITOR'.)
    rec.calls.length = 0;
    output.priority.value = COMMAND_PRIORITY_EDITOR;
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual([]);
    editor.dispose();
  });

  test('a configured priority is used for the KEY_DOWN_COMMAND listener', () => {
    const rec = commandRecorder();
    const editor = buildLayeredEditor(
      [
        {
          priority: COMMAND_PRIORITY_LOW,
          shortcuts: {bold: rec.ctrlKShortcut('bold')},
        },
      ],
      rec.listeners,
    );
    const keyDown = editor.registerCommand(
      KEY_DOWN_COMMAND,
      () => {
        rec.calls.push('high');
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual(['high']);

    const {output} = getExtensionDependencyFromEditor(
      editor,
      KeyboardShortcutsExtension,
    );
    rec.calls.length = 0;
    output.priority.value = COMMAND_PRIORITY_CRITICAL;
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual(['bold']);

    keyDown();
    editor.dispose();
  });

  test('the last layer to configure a priority wins', () => {
    const editor = buildLayeredEditor(
      [{priority: COMMAND_PRIORITY_LOW}, {priority: COMMAND_PRIORITY_CRITICAL}],
      [],
    );
    const {output} = getExtensionDependencyFromEditor(
      editor,
      KeyboardShortcutsExtension,
    );
    expect(output.priority.value).toBe(COMMAND_PRIORITY_CRITICAL);
    editor.dispose();
  });

  test('disabled: true never registers the listener', () => {
    const rec = commandRecorder();
    const editor = buildLayeredEditor(
      [{disabled: true, shortcuts: {bold: rec.ctrlKShortcut('bold')}}],
      rec.listeners,
    );
    editor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(rec.calls).toEqual([]);
    editor.dispose();
  });
});

describe('KeyboardShortcutsExtension nested editors', () => {
  const BOLD_COMMAND = createCommand<KeyboardEvent>('nested/BOLD');

  /**
   * A parent editor holding the shortcut table, and a nested editor with no
   * shortcuts of its own so that its unhandled KEY_DOWN_COMMAND delegates to
   * the parent. Both record BOLD_COMMAND dispatches, tagged with the editor
   * they were dispatched on.
   */
  function buildNestedEditors(
    shortcuts: NamedKeyboardShortcuts,
    priority?: KeyboardShortcutsConfig['priority'],
  ) {
    const calls: string[] = [];
    const registerRecorder = (editorName: string) => (editor: LexicalEditor) =>
      editor.registerCommand(
        BOLD_COMMAND,
        () => {
          calls.push(`bold@${editorName}`);
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      );
    const parentEditor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          configExtension(KeyboardShortcutsExtension, {
            ...(priority === undefined ? undefined : {priority}),
            shortcuts,
          }),
        ],
        name: 'parent',
        register: registerRecorder('parent'),
      }),
    );
    const childEditor = parentEditor.read(() =>
      buildEditorFromExtensions(
        defineExtension({
          dependencies: [NestedEditorExtension],
          name: 'child',
          register: registerRecorder('child'),
        }),
      ),
    );
    const dispose = () => {
      childEditor.dispose();
      parentEditor.dispose();
    };
    return {calls, childEditor, dispose, parentEditor};
  }

  const boldShortcut = (
    overrides: Partial<KeyboardShortcut> = {},
  ): KeyboardShortcut => ({
    command: BOLD_COMMAND,
    key: 'k',
    modifiers: {ctrlKey: true},
    ...overrides,
  });

  test('events bubbled up from a nested editor are ignored by default', () => {
    const {calls, childEditor, dispose} = buildNestedEditors({
      bold: boldShortcut(),
    });
    childEditor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(calls).toEqual([]);
    dispose();
  });

  test('events from the registering editor are dispatched without the flag', () => {
    const {calls, dispose, parentEditor} = buildNestedEditors({
      bold: boldShortcut(),
    });
    parentEditor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(calls).toEqual(['bold@parent']);
    dispose();
  });

  test('bubbleFromNestedEditors dispatches on the originating editor', () => {
    const {calls, childEditor, dispose} = buildNestedEditors({
      bold: boldShortcut({bubbleFromNestedEditors: true}),
    });
    childEditor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    // Dispatched on the child, not the editor the shortcut is registered on
    expect(calls).toEqual(['bold@child']);
    dispose();
  });

  test('a non-bubbling shortcut does not shadow a bubbling one on the same key', () => {
    const IGNORED_COMMAND = createCommand<KeyboardEvent>('nested/IGNORED');
    const ignored = vi.fn().mockReturnValue(true);
    const {calls, childEditor, dispose, parentEditor} = buildNestedEditors({
      ignored: {command: IGNORED_COMMAND, key: 'k', modifiers: {ctrlKey: true}},
      // eslint-disable-next-line sort-keys-fix/sort-keys-fix -- intentionally after ignored
      bold: boldShortcut({bubbleFromNestedEditors: true}),
    });
    const cleanup = parentEditor.registerCommand(
      IGNORED_COMMAND,
      ignored,
      COMMAND_PRIORITY_EDITOR,
    );
    childEditor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(ignored).not.toHaveBeenCalled();
    expect(calls).toEqual(['bold@child']);
    cleanup();
    dispose();
  });

  test('$disabled and $dispatch receive the originating editor', () => {
    const $disabled = vi.fn().mockReturnValue(false);
    const $dispatch = vi.fn(
      (
        _command: LexicalCommand<KeyboardEvent>,
        _event: KeyboardEvent,
        $next: () => boolean,
        _editor: LexicalEditor,
      ) => $next(),
    );
    const {calls, childEditor, dispose} = buildNestedEditors({
      bold: boldShortcut({$disabled, $dispatch, bubbleFromNestedEditors: true}),
    });
    childEditor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(calls).toEqual(['bold@child']);
    expect($disabled).toHaveBeenCalledTimes(1);
    expect($disabled.mock.calls[0][1]).toBe(childEditor);
    expect($dispatch).toHaveBeenCalledTimes(1);
    expect($dispatch.mock.calls[0][3]).toBe(childEditor);
    dispose();
  });

  test('$disabled is not consulted for events that will not bubble', () => {
    const $disabled = vi.fn().mockReturnValue(false);
    const {calls, childEditor, dispose} = buildNestedEditors({
      bold: boldShortcut({$disabled}),
    });
    childEditor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
    expect(calls).toEqual([]);
    expect($disabled).not.toHaveBeenCalled();
    dispose();
  });

  test('bubbling requires a priority above COMMAND_PRIORITY_EDITOR', () => {
    // Why the default is COMMAND_PRIORITY_NORMAL rather than
    // COMMAND_PRIORITY_BEFORE_EDITOR: command dispatch walks priorities from
    // CRITICAL down to EDITOR on the outside and the nested editor chain on
    // the inside, and every editor registers the core $handleKeyDown at
    // COMMAND_PRIORITY_EDITOR, which always reports the event as handled. So
    // a nested editor's own $handleKeyDown ends the dispatch before anything
    // the parent has in the editor-priority queue, and BEFORE_EDITOR is the
    // front of exactly that queue.
    const bubbling = {bold: boldShortcut({bubbleFromNestedEditors: true})};
    for (const priority of [
      COMMAND_PRIORITY_LOW,
      COMMAND_PRIORITY_NORMAL,
      COMMAND_PRIORITY_CRITICAL,
    ] as const) {
      const {calls, childEditor, dispose} = buildNestedEditors(
        bubbling,
        priority,
      );
      childEditor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
      expect(calls, `priority ${priority}`).toEqual(['bold@child']);
      dispose();
    }
    for (const priority of [
      COMMAND_PRIORITY_BEFORE_EDITOR,
      COMMAND_PRIORITY_EDITOR,
    ] as const) {
      const {calls, childEditor, dispose} = buildNestedEditors(
        bubbling,
        priority,
      );
      childEditor.dispatchCommand(KEY_DOWN_COMMAND, ctrlK());
      expect(calls, `priority ${priority}`).toEqual([]);
      dispose();
    }
  });
});
