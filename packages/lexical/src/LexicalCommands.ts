/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalCommand} from './LexicalEditor';
import type {LexicalNode} from './LexicalNode';
import type {BaseSelection} from './LexicalSelection';
import type {ElementFormatType} from './nodes/LexicalElementNode';
import type {TextFormatType} from './nodes/LexicalTextNode';

export type PasteCommandType = ClipboardEvent | InputEvent | KeyboardEvent;

/**
 * Crete a command that can be used with `editor.dispatchCommand` and
 * `editor.registerCommand`. Commands are used by unique reference, not by
 * name.
 *
 * @param type A string to identify the command, very helpful for debugging
 * @returns A new LexicalCommand
 *
 * @__NO_SIDE_EFFECTS__
 */
export function createCommand<T>(type?: string): LexicalCommand<T> {
  return {type};
}

/** Dispatched whenever the editor selection changes. */
export const SELECTION_CHANGE_COMMAND: LexicalCommand<void> =
  /* @__PURE__ */ createCommand('SELECTION_CHANGE_COMMAND');
/** Dispatched to insert clipboard nodes at the current selection. */
export const SELECTION_INSERT_CLIPBOARD_NODES_COMMAND: LexicalCommand<{
  nodes: LexicalNode[];
  selection: BaseSelection;
}> = /* @__PURE__ */ createCommand('SELECTION_INSERT_CLIPBOARD_NODES_COMMAND');
/** Dispatched on a mouse click event in the editor. */
export const CLICK_COMMAND: LexicalCommand<MouseEvent> =
  /* @__PURE__ */ createCommand('CLICK_COMMAND');
/** Dispatched on a beforeinput event. */
export const BEFORE_INPUT_COMMAND: LexicalCommand<InputEvent> =
  /* @__PURE__ */ createCommand('BEFORE_INPUT_COMMAND');
/** Dispatched on an input event. */
export const INPUT_COMMAND: LexicalCommand<InputEvent> =
  /* @__PURE__ */ createCommand('INPUT_COMMAND');
/** Dispatched when an IME composition session starts. */
export const COMPOSITION_START_COMMAND: LexicalCommand<CompositionEvent> =
  /* @__PURE__ */ createCommand('COMPOSITION_START_COMMAND');
/** Dispatched when an IME composition session ends. */
export const COMPOSITION_END_COMMAND: LexicalCommand<CompositionEvent> =
  /* @__PURE__ */ createCommand('COMPOSITION_END_COMMAND');
/**
 * Dispatched to delete a character, the payload will be `true` if the deletion
 * is backwards (backspace or delete on macOS) and `false` if forwards
 * (delete or Fn+Delete on macOS).
 */
export const DELETE_CHARACTER_COMMAND: LexicalCommand<boolean> =
  /* @__PURE__ */ createCommand('DELETE_CHARACTER_COMMAND');
/**
 * Dispatched to insert a line break. With a false payload the
 * cursor moves to the new line (Shift+Enter), with a true payload the cursor
 * does not move (Ctrl+O on macOS).
 */
export const INSERT_LINE_BREAK_COMMAND: LexicalCommand<boolean> =
  /* @__PURE__ */ createCommand('INSERT_LINE_BREAK_COMMAND');
/** Dispatched to insert a new paragraph (Enter key). */
export const INSERT_PARAGRAPH_COMMAND: LexicalCommand<void> =
  /* @__PURE__ */ createCommand('INSERT_PARAGRAPH_COMMAND');
/** Dispatched to insert text from an InputEvent or a string. */
export const CONTROLLED_TEXT_INSERTION_COMMAND: LexicalCommand<
  InputEvent | string
> = /* @__PURE__ */ createCommand('CONTROLLED_TEXT_INSERTION_COMMAND');
/** Dispatched on a paste event. */
export const PASTE_COMMAND: LexicalCommand<PasteCommandType> =
  /* @__PURE__ */ createCommand('PASTE_COMMAND');
/** Dispatched to remove the currently selected text. */
export const REMOVE_TEXT_COMMAND: LexicalCommand<InputEvent | null> =
  /* @__PURE__ */ createCommand('REMOVE_TEXT_COMMAND');
/**
 * Dispatched to delete a word, the payload will be `true` if the deletion is
 * backwards (Ctrl+Backspace or Opt+Delete on macOS), and `false` if
 * forwards (Ctrl+Delete or Fn+Opt+Delete on macOS).
 */
export const DELETE_WORD_COMMAND: LexicalCommand<boolean> =
  /* @__PURE__ */ createCommand('DELETE_WORD_COMMAND');
/**
 * Dispatched to delete a line, the payload will be `true` if the deletion is
 * backwards (Cmd+Delete on macOS), and `false` if forwards
 * (Fn+Cmd+Delete on macOS).
 */
export const DELETE_LINE_COMMAND: LexicalCommand<boolean> =
  /* @__PURE__ */ createCommand('DELETE_LINE_COMMAND');
/**
 * Dispatched to format the selected text.
 */
export const FORMAT_TEXT_COMMAND: LexicalCommand<TextFormatType> =
  /* @__PURE__ */ createCommand('FORMAT_TEXT_COMMAND');
/**
 * Dispatched to explicitly set or unset text formats on the selection.
 * Unlike FORMAT_TEXT_COMMAND which toggles, this command sets each specified
 * format to the exact boolean value provided.
 */
export const SET_TEXT_FORMAT_COMMAND: LexicalCommand<
  Partial<Record<TextFormatType, boolean>>
> = /* @__PURE__ */ createCommand('SET_TEXT_FORMAT_COMMAND');
/**
 * Dispatched on undo (Cmd+Z on macOS, Ctrl+Z elsewhere).
 */
export const UNDO_COMMAND: LexicalCommand<void> =
  /* @__PURE__ */ createCommand('UNDO_COMMAND');
/**
 * Dispatched on redo (Shift+Cmd+Z on macOS, Shift+Ctrl+Z or Ctrl+Y elsewhere).
 */
export const REDO_COMMAND: LexicalCommand<void> =
  /* @__PURE__ */ createCommand('REDO_COMMAND');
/**
 * Dispatched when any key is pressed.
 */
export const KEY_DOWN_COMMAND: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('KEYDOWN_COMMAND');
/**
 * Dispatched when the `'ArrowRight'` key is pressed.
 * The shift modifier key may also be down.
 */
export const KEY_ARROW_RIGHT_COMMAND: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('KEY_ARROW_RIGHT_COMMAND');
/**
 * Dispatched when the move to end keyboard shortcut is pressed,
 * (Cmd+Right on macOS; Ctrl+Right elsewhere).
 */
export const MOVE_TO_END: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('MOVE_TO_END');
/**
 * Dispatched when the `'ArrowLeft'` key is pressed.
 * The shift modifier key may also be down.
 */
export const KEY_ARROW_LEFT_COMMAND: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('KEY_ARROW_LEFT_COMMAND');
/**
 * Dispatched when the move to start keyboard shortcut is pressed,
 * (Cmd+Left on macOS; Ctrl+Left elsewhere).
 */
export const MOVE_TO_START: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('MOVE_TO_START');
/**
 * Dispatched when the `'ArrowUp'` key is pressed.
 * The shift and/or alt (option) modifier keys may also be down.
 */
export const KEY_ARROW_UP_COMMAND: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('KEY_ARROW_UP_COMMAND');
/**
 * Dispatched when the `'ArrowDown'` key is pressed.
 * The shift and/or alt (option) modifier keys may also be down.
 */
export const KEY_ARROW_DOWN_COMMAND: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('KEY_ARROW_DOWN_COMMAND');
/**
 * Dispatched when the enter key is pressed, may also be called with a null
 * payload when the intent is to insert a newline. The shift modifier key
 * must be down, any other modifier keys may also be down.
 */
export const KEY_ENTER_COMMAND: LexicalCommand<KeyboardEvent | null> =
  /* @__PURE__ */ createCommand('KEY_ENTER_COMMAND');
/**
 * Dispatched whenever the space (`' '`) key is pressed, any modifier
 * keys may be down.
 */
export const KEY_SPACE_COMMAND: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('KEY_SPACE_COMMAND');
/**
 * Dispatched whenever the `'Backspace'` key is pressed, the shift
 * modifier key may be down.
 */
export const KEY_BACKSPACE_COMMAND: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('KEY_BACKSPACE_COMMAND');
/**
 * Dispatched whenever the `'Escape'` key is pressed, any modifier
 * keys may be down.
 */
export const KEY_ESCAPE_COMMAND: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('KEY_ESCAPE_COMMAND');
/**
 * Dispatched whenever the `'Delete'` key is pressed (Fn+Delete on macOS).
 */
export const KEY_DELETE_COMMAND: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('KEY_DELETE_COMMAND');
/**
 * Dispatched whenever the `'Tab'` key is pressed. The shift modifier key
 * may be down.
 */
export const KEY_TAB_COMMAND: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('KEY_TAB_COMMAND');
/** Dispatched to insert a tab character. */
export const INSERT_TAB_COMMAND: LexicalCommand<void> =
  /* @__PURE__ */ createCommand('INSERT_TAB_COMMAND');
/** Dispatched to indent the selected content. */
export const INDENT_CONTENT_COMMAND: LexicalCommand<void> =
  /* @__PURE__ */ createCommand('INDENT_CONTENT_COMMAND');
/** Dispatched to outdent the selected content. */
export const OUTDENT_CONTENT_COMMAND: LexicalCommand<void> =
  /* @__PURE__ */ createCommand('OUTDENT_CONTENT_COMMAND');
/** Dispatched on a drop event. */
export const DROP_COMMAND: LexicalCommand<DragEvent> =
  /* @__PURE__ */ createCommand('DROP_COMMAND');
/** Dispatched to set the element format (alignment) of the selected block. */
export const FORMAT_ELEMENT_COMMAND: LexicalCommand<ElementFormatType> =
  /* @__PURE__ */ createCommand('FORMAT_ELEMENT_COMMAND');
/** Dispatched when a drag operation starts. */
export const DRAGSTART_COMMAND: LexicalCommand<DragEvent> =
  /* @__PURE__ */ createCommand('DRAGSTART_COMMAND');
/** Dispatched when a dragged element is over the editor. */
export const DRAGOVER_COMMAND: LexicalCommand<DragEvent> =
  /* @__PURE__ */ createCommand('DRAGOVER_COMMAND');
/** Dispatched when a drag operation ends. */
export const DRAGEND_COMMAND: LexicalCommand<DragEvent> =
  /* @__PURE__ */ createCommand('DRAGEND_COMMAND');
/**
 * Dispatched on a copy event, either via the clipboard or a KeyboardEvent
 * (Cmd+C on macOS, Ctrl+C elsewhere).
 */
export const COPY_COMMAND: LexicalCommand<
  ClipboardEvent | KeyboardEvent | null
> = /* @__PURE__ */ createCommand('COPY_COMMAND');
/**
 * Dispatched on a cut event, either via the clipboard or a KeyboardEvent
 * (Cmd+X on macOS, Ctrl+X elsewhere).
 */
export const CUT_COMMAND: LexicalCommand<
  ClipboardEvent | KeyboardEvent | null
> = /* @__PURE__ */ createCommand('CUT_COMMAND');
/**
 * Dispatched on the select all keyboard shortcut
 * (Cmd+A on macOS, Ctrl+A elsehwere).
 */
export const SELECT_ALL_COMMAND: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('SELECT_ALL_COMMAND');
/** Dispatched to clear all editor content. */
export const CLEAR_EDITOR_COMMAND: LexicalCommand<void> =
  /* @__PURE__ */ createCommand('CLEAR_EDITOR_COMMAND');
/** Dispatched to clear the undo/redo history stack. */
export const CLEAR_HISTORY_COMMAND: LexicalCommand<void> =
  /* @__PURE__ */ createCommand('CLEAR_HISTORY_COMMAND');
/**
 * @deprecated in v0.49.0, use the `canRedo` signal from `HistoryExtension`.
 *
 * A command only reports a change, so a listener registered after the editor
 * is initialized has no way to read the current value. The signal always
 * holds it.
 *
 * Dispatched when the redo availability changes. Payload is true if redo is available.
 */
export const CAN_REDO_COMMAND: LexicalCommand<boolean> =
  /* @__PURE__ */ createCommand('CAN_REDO_COMMAND');
/**
 * @deprecated in v0.49.0, use the `canUndo` signal from `HistoryExtension`.
 *
 * A command only reports a change, so a listener registered after the editor
 * is initialized has no way to read the current value. The signal always
 * holds it.
 *
 * Dispatched when the undo availability changes. Payload is true if undo is available.
 */
export const CAN_UNDO_COMMAND: LexicalCommand<boolean> =
  /* @__PURE__ */ createCommand('CAN_UNDO_COMMAND');
/** Dispatched when the editor receives focus. */
export const FOCUS_COMMAND: LexicalCommand<FocusEvent> =
  /* @__PURE__ */ createCommand('FOCUS_COMMAND');
/** Dispatched when the editor loses focus. */
export const BLUR_COMMAND: LexicalCommand<FocusEvent> =
  /* @__PURE__ */ createCommand('BLUR_COMMAND');
/**
 * @deprecated in v0.31.0, use KEY_DOWN_COMMAND and check for modifiers
 * directly.
 *
 * Dispatched after any KeyboardEvent when modifiers are pressed
 */
export const KEY_MODIFIER_COMMAND: LexicalCommand<KeyboardEvent> =
  /* @__PURE__ */ createCommand('KEY_MODIFIER_COMMAND');
