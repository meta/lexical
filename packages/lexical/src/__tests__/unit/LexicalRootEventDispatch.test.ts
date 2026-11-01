/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  type AnyLexicalCommand,
  BLUR_COMMAND,
  CLICK_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  type CommandListener,
  COPY_COMMAND,
  CUT_COMMAND,
  DRAGEND_COMMAND,
  DRAGOVER_COMMAND,
  DRAGSTART_COMMAND,
  DROP_COMMAND,
  FOCUS_COMMAND,
  KEY_DOWN_COMMAND,
  type LexicalEditor,
  PASTE_COMMAND,
} from 'lexical';
import {expect, onTestFinished, test, vi} from 'vitest';

function mount(editor: LexicalEditor): HTMLElement {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  onTestFinished(() => root.remove());
  editor.setRootElement(root);
  return root;
}

function dispatchRootEvent(root: HTMLElement, type: string): Event {
  const init = {bubbles: true, cancelable: true};
  // A plain Event for every type: Chrome's keydown for an accepted autofill
  // suggestion is not a KeyboardEvent either.
  const event = new Event(type, init);
  root.dispatchEvent(event);
  return event;
}

// The commands that the root element's events reach, with the event as the
// payload. A read-only editor dispatches only clicks and copies; the editable
// dispatch shows that the read-only one would have reached the listener.
test.each<[string, boolean, AnyLexicalCommand]>([
  ['blur', false, BLUR_COMMAND],
  ['click', true, CLICK_COMMAND],
  ['copy', true, COPY_COMMAND],
  ['cut', false, CUT_COMMAND],
  ['dragend', false, DRAGEND_COMMAND],
  ['dragover', false, DRAGOVER_COMMAND],
  ['dragstart', false, DRAGSTART_COMMAND],
  ['drop', false, DROP_COMMAND],
  ['focus', false, FOCUS_COMMAND],
  ['keydown', false, KEY_DOWN_COMMAND],
  ['paste', false, PASTE_COMMAND],
])(
  'a %s event dispatches its command, also while read-only: %s',
  (type, isReadOnlyDispatched, command) => {
    using editor = buildEditorFromExtensions();
    const root = mount(editor);
    const listener = vi.fn<CommandListener<unknown>>(() => true);
    editor.registerCommand(command, listener, COMMAND_PRIORITY_CRITICAL);
    editor.setEditable(false);
    const readOnlyEvent = dispatchRootEvent(root, type);
    editor.setEditable(true);
    const editableEvent = dispatchRootEvent(root, type);
    const events = isReadOnlyDispatched
      ? [readOnlyEvent, editableEvent]
      : [editableEvent];
    expect(listener).toHaveBeenCalledTimes(events.length);
    events.forEach((event, i) => {
      const [payload, listenerEditor] = listener.mock.calls[i];
      expect(payload).toBe(event);
      expect(listenerEditor).toBe(editor);
    });
  },
);

test.each<[string, AnyLexicalCommand]>([
  ['copy', COPY_COMMAND],
  ['keydown', KEY_DOWN_COMMAND],
])(
  'a %s event in a nested root element reaches only the nested editor',
  (type, command) => {
    using outer = buildEditorFromExtensions();
    using inner = buildEditorFromExtensions();
    const innerRoot = mount(inner);
    mount(outer).appendChild(innerRoot);
    const outerListener = vi.fn(() => false);
    const innerListener = vi.fn(() => false);
    outer.registerCommand(command, outerListener, COMMAND_PRIORITY_CRITICAL);
    inner.registerCommand(command, innerListener, COMMAND_PRIORITY_CRITICAL);
    dispatchRootEvent(innerRoot, type);
    expect(innerListener).toHaveBeenCalledOnce();
    expect(outerListener).not.toHaveBeenCalled();
  },
);
