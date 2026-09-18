/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Shared harness that asserts the compiled keydown shortcut table in
 * LexicalEvents dispatches exactly the same commands as the predicate
 * chain it replaced. The reference implementation below is a transcription
 * of the old `$handleKeyDown` if/else chain (and the `is*` predicates it
 * called), evaluated over an exhaustive grid of keys and modifier states.
 *
 * Import this from a test file that mocks `lexical/src/environment` for the
 * platform under test and call {@link runKeyDownDispatchParityTests}.
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  type AnyLexicalCommand,
  COMMAND_PRIORITY_CRITICAL,
  CONTROL_OR_ALT,
  CONTROL_OR_META,
  COPY_COMMAND,
  CUT_COMMAND,
  defineExtension,
  DELETE_CHARACTER_COMMAND,
  DELETE_LINE_COMMAND,
  DELETE_WORD_COMMAND,
  FORMAT_TEXT_COMMAND,
  INSERT_LINE_BREAK_COMMAND,
  isExactShortcutMatch,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_MODIFIER_COMMAND,
  KEY_SPACE_COMMAND,
  KEY_TAB_COMMAND,
  type KeyboardEventModifierMask,
  MOVE_TO_END,
  MOVE_TO_START,
  REDO_COMMAND,
  SELECT_ALL_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, test} from 'vitest';

interface ExpectedDispatch {
  command: AnyLexicalCommand;
  payload?: unknown;
  preventsDefault: boolean;
}

/**
 * A transcription of the old `$handleKeyDown` predicate chain, in the
 * original order. `payload: EVENT` marks commands whose payload is the
 * KeyboardEvent itself.
 */
const EVENT = Symbol('EVENT');

function referenceKeyDown(
  event: KeyboardEvent,
  isApple: boolean,
): ExpectedDispatch | null {
  const m = (key: string, mask: KeyboardEventModifierMask) =>
    isExactShortcutMatch(event, key, mask);
  const dispatched = (
    command: AnyLexicalCommand,
    payload: unknown,
    preventsDefault = false,
  ) => ({command, payload, preventsDefault});

  if (m('ArrowRight', {shiftKey: 'any'})) {
    return dispatched(KEY_ARROW_RIGHT_COMMAND, EVENT);
  } else if (
    isApple
      ? m('ArrowRight', {metaKey: true, shiftKey: 'any'})
      : m('End', {shiftKey: 'any'})
  ) {
    return dispatched(MOVE_TO_END, EVENT);
  } else if (m('ArrowLeft', {shiftKey: 'any'})) {
    return dispatched(KEY_ARROW_LEFT_COMMAND, EVENT);
  } else if (
    isApple
      ? m('ArrowLeft', {metaKey: true, shiftKey: 'any'})
      : m('Home', {shiftKey: 'any'})
  ) {
    return dispatched(MOVE_TO_START, EVENT);
  } else if (m('ArrowUp', {altKey: 'any', shiftKey: 'any'})) {
    return dispatched(KEY_ARROW_UP_COMMAND, EVENT);
  } else if (m('ArrowDown', {altKey: 'any', shiftKey: 'any'})) {
    return dispatched(KEY_ARROW_DOWN_COMMAND, EVENT);
  } else if (
    m('Enter', {altKey: 'any', ctrlKey: 'any', metaKey: 'any', shiftKey: true})
  ) {
    return dispatched(KEY_ENTER_COMMAND, EVENT);
  } else if (event.key === ' ') {
    return dispatched(KEY_SPACE_COMMAND, EVENT);
  } else if (isApple && m('o', {ctrlKey: true})) {
    return dispatched(INSERT_LINE_BREAK_COMMAND, true, true);
  } else if (m('Enter', {altKey: 'any', ctrlKey: 'any', metaKey: 'any'})) {
    return dispatched(KEY_ENTER_COMMAND, EVENT);
  } else if (
    m('Backspace', {shiftKey: 'any'}) ||
    (isApple && m('h', {ctrlKey: true}))
  ) {
    return event.key === 'Backspace'
      ? dispatched(KEY_BACKSPACE_COMMAND, EVENT)
      : dispatched(DELETE_CHARACTER_COMMAND, true, true);
  } else if (event.key === 'Escape') {
    return dispatched(KEY_ESCAPE_COMMAND, EVENT);
  } else if (m('Delete', {}) || (isApple && m('d', {ctrlKey: true}))) {
    return event.key === 'Delete'
      ? dispatched(KEY_DELETE_COMMAND, EVENT)
      : dispatched(DELETE_CHARACTER_COMMAND, false, true);
  } else if (m('Backspace', CONTROL_OR_ALT)) {
    return dispatched(DELETE_WORD_COMMAND, true, true);
  } else if (m('Delete', CONTROL_OR_ALT)) {
    return dispatched(DELETE_WORD_COMMAND, false, true);
  } else if (isApple && m('Backspace', {metaKey: true})) {
    return dispatched(DELETE_LINE_COMMAND, true, true);
  } else if (
    isApple &&
    (m('Delete', {metaKey: true}) || m('k', {ctrlKey: true}))
  ) {
    return dispatched(DELETE_LINE_COMMAND, false, true);
  } else if (m('b', CONTROL_OR_META)) {
    return dispatched(FORMAT_TEXT_COMMAND, 'bold', true);
  } else if (m('u', CONTROL_OR_META)) {
    return dispatched(FORMAT_TEXT_COMMAND, 'underline', true);
  } else if (m('i', CONTROL_OR_META)) {
    return dispatched(FORMAT_TEXT_COMMAND, 'italic', true);
  } else if (m('Tab', {shiftKey: 'any'})) {
    return dispatched(KEY_TAB_COMMAND, EVENT);
  } else if (m('z', CONTROL_OR_META)) {
    return dispatched(UNDO_COMMAND, undefined, true);
  } else if (
    isApple
      ? m('z', {metaKey: true, shiftKey: true})
      : m('y', {ctrlKey: true}) || m('z', {ctrlKey: true, shiftKey: true})
  ) {
    return dispatched(REDO_COMMAND, undefined, true);
  } else if (m('a', CONTROL_OR_META)) {
    return dispatched(SELECT_ALL_COMMAND, EVENT, true);
  }
  // isCopy / isCut are gated on the previous selection being a non-null,
  // non-range selection; with no selection they dispatch nothing.
  return null;
}

/** Every (key, code) pair exercised against all 16 modifier states */
const GRID_KEYS: [string, string][] = [
  ['ArrowRight', 'ArrowRight'],
  ['ArrowLeft', 'ArrowLeft'],
  ['ArrowUp', 'ArrowUp'],
  ['ArrowDown', 'ArrowDown'],
  ['Enter', 'Enter'],
  [' ', 'Space'],
  ['Backspace', 'Backspace'],
  ['Delete', 'Delete'],
  ['Escape', 'Escape'],
  ['Tab', 'Tab'],
  ['a', 'KeyA'],
  ['b', 'KeyB'],
  ['c', 'KeyC'],
  ['d', 'KeyD'],
  ['h', 'KeyH'],
  ['i', 'KeyI'],
  ['k', 'KeyK'],
  ['o', 'KeyO'],
  ['q', 'KeyQ'],
  ['u', 'KeyU'],
  ['x', 'KeyX'],
  ['y', 'KeyY'],
  ['z', 'KeyZ'],
  // Non-Latin layouts: event.key is non-ASCII, matching falls back to code
  ['и', 'KeyB'],
  ['я', 'KeyZ'],
];

const OBSERVED_COMMANDS: [string, AnyLexicalCommand][] = [
  ['KEY_ARROW_RIGHT_COMMAND', KEY_ARROW_RIGHT_COMMAND],
  ['KEY_ARROW_LEFT_COMMAND', KEY_ARROW_LEFT_COMMAND],
  ['KEY_ARROW_UP_COMMAND', KEY_ARROW_UP_COMMAND],
  ['KEY_ARROW_DOWN_COMMAND', KEY_ARROW_DOWN_COMMAND],
  ['MOVE_TO_END', MOVE_TO_END],
  ['MOVE_TO_START', MOVE_TO_START],
  ['KEY_ENTER_COMMAND', KEY_ENTER_COMMAND],
  ['KEY_SPACE_COMMAND', KEY_SPACE_COMMAND],
  ['INSERT_LINE_BREAK_COMMAND', INSERT_LINE_BREAK_COMMAND],
  ['KEY_BACKSPACE_COMMAND', KEY_BACKSPACE_COMMAND],
  ['KEY_DELETE_COMMAND', KEY_DELETE_COMMAND],
  ['KEY_ESCAPE_COMMAND', KEY_ESCAPE_COMMAND],
  ['KEY_TAB_COMMAND', KEY_TAB_COMMAND],
  ['DELETE_CHARACTER_COMMAND', DELETE_CHARACTER_COMMAND],
  ['DELETE_WORD_COMMAND', DELETE_WORD_COMMAND],
  ['DELETE_LINE_COMMAND', DELETE_LINE_COMMAND],
  ['FORMAT_TEXT_COMMAND', FORMAT_TEXT_COMMAND],
  ['UNDO_COMMAND', UNDO_COMMAND],
  ['REDO_COMMAND', REDO_COMMAND],
  ['SELECT_ALL_COMMAND', SELECT_ALL_COMMAND],
  ['COPY_COMMAND', COPY_COMMAND],
  ['CUT_COMMAND', CUT_COMMAND],
  ['KEY_MODIFIER_COMMAND', KEY_MODIFIER_COMMAND],
];

export function runKeyDownDispatchParityTests(isApple: boolean): void {
  describe(`$handleKeyDown dispatch parity (IS_APPLE=${isApple})`, () => {
    test('dispatches the same commands as the legacy predicate chain', () => {
      const recorded: {command: AnyLexicalCommand; payload: unknown}[] = [];
      const editor = buildEditorFromExtensions(
        defineExtension({
          name: 'keydown-parity-test',
          register: editor2 => {
            const cleanups = OBSERVED_COMMANDS.map(([, command]) =>
              editor2.registerCommand(
                command,
                payload => {
                  recorded.push({command, payload});
                  return true;
                },
                COMMAND_PRIORITY_CRITICAL,
              ),
            );
            return () => cleanups.forEach(cleanup => cleanup());
          },
        }),
      );

      for (const [key, code] of GRID_KEYS) {
        for (let bits = 0; bits < 16; bits++) {
          const event = new KeyboardEvent('keydown', {
            altKey: Boolean(bits & 1),
            cancelable: true,
            code,
            ctrlKey: Boolean(bits & 2),
            key,
            metaKey: Boolean(bits & 4),
            shiftKey: Boolean(bits & 8),
          });
          recorded.length = 0;
          editor.dispatchCommand(KEY_DOWN_COMMAND, event);

          const label = `key=${key} code=${code} alt=${event.altKey} ctrl=${event.ctrlKey} meta=${event.metaKey} shift=${event.shiftKey}`;
          const expected = referenceKeyDown(event, isApple);
          const modifierDispatches = recorded.filter(
            r => r.command === KEY_MODIFIER_COMMAND,
          );
          const dispatches = recorded.filter(
            r => r.command !== KEY_MODIFIER_COMMAND,
          );
          // KEY_MODIFIER_COMMAND is always dispatched (in addition to any
          // matched shortcut) when at least one modifier is pressed
          expect(modifierDispatches.length, label).toBe(bits === 0 ? 0 : 1);
          if (expected === null) {
            expect(dispatches, label).toEqual([]);
            expect(event.defaultPrevented, label).toBe(false);
          } else {
            expect(dispatches.length, label).toBe(1);
            expect(dispatches[0].command, label).toBe(expected.command);
            expect(dispatches[0].payload, label).toBe(
              expected.payload === EVENT ? event : expected.payload,
            );
            expect(event.defaultPrevented, label).toBe(
              expected.preventsDefault,
            );
          }
        }
      }
      editor.dispose();
    });
  });
}
