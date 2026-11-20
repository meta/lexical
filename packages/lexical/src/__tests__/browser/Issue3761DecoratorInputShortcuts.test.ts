/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type AnyLexicalCommand,
  COMMAND_PRIORITY_CRITICAL,
  DecoratorNode,
  DELETE_LINE_COMMAND,
  DELETE_WORD_COMMAND,
  type EditorConfig,
  FORMAT_TEXT_COMMAND,
  IS_APPLE,
  isHTMLElement,
  type LexicalCommand,
  type LexicalEditor,
  SELECT_ALL_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';
import {userEvent} from 'vitest/browser';

// https://github.com/facebook/lexical/issues/3761
// Shortcuts pressed in a decorator's own input must do what the input does,
// not run (and preventDefault) the editor's command.

class InputDecoratorNode extends DecoratorNode<unknown> {
  $config() {
    return this.config('input-decorator-3761', {extends: DecoratorNode});
  }
  isInline() {
    return false;
  }
  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const div = document.createElement('div');
    div.appendChild(document.createElement('input'));
    return div;
  }
}

function createEditor(): {
  editor: LexicalEditor;
  input: HTMLInputElement;
  root: HTMLElement;
} {
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('editor text')),
        $create(InputDecoratorNode),
      );
    },
    dependencies: [RichTextExtension],
    name: 'test',
    nodes: [InputDecoratorNode],
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.setRootElement(null);
    root.remove();
    editor.dispose();
  });
  const input = root.querySelector<HTMLInputElement>(
    '[data-lexical-decorator] input',
  );
  assert(isHTMLElement(input));
  return {editor, input, root};
}

function spyOn<T>(editor: LexicalEditor, command: LexicalCommand<T>) {
  const spy = vi.fn((_payload: unknown) => false);
  onTestFinished(
    editor.registerCommand(command, spy, COMMAND_PRIORITY_CRITICAL),
  );
  return spy;
}

const MOD = IS_APPLE ? 'metaKey' : 'ctrlKey';
const WORD = IS_APPLE ? 'altKey' : 'ctrlKey';

const SHORTCUTS: [string, KeyboardEventInit, AnyLexicalCommand][] = [
  // Ctrl on Windows/Linux, Alt (Option) on Apple platforms
  ['Word+Backspace', {[WORD]: true, key: 'Backspace'}, DELETE_WORD_COMMAND],
  ['Word+Delete', {[WORD]: true, key: 'Delete'}, DELETE_WORD_COMMAND],
  ['Mod+A', {[MOD]: true, key: 'a'}, SELECT_ALL_COMMAND],
  ['Mod+B', {[MOD]: true, key: 'b'}, FORMAT_TEXT_COMMAND],
  ['Mod+Z', {[MOD]: true, key: 'z'}, UNDO_COMMAND],
  ...(IS_APPLE
    ? ([
        [
          'Cmd+Backspace',
          {key: 'Backspace', metaKey: true},
          DELETE_LINE_COMMAND,
        ],
      ] as [string, KeyboardEventInit, AnyLexicalCommand][])
    : []),
];

function keyDown(target: HTMLElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe('Shortcuts in a decorator input (#3761)', () => {
  for (const [name, init, command] of SHORTCUTS) {
    test(`${name} in the input is left to the input`, () => {
      const {editor, input} = createEditor();
      input.focus();
      const spy = spyOn(editor, command);
      const event = keyDown(input, init);
      expect(event.defaultPrevented).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    test(`${name} in the editor still runs the command (control)`, () => {
      const {editor, root} = createEditor();
      root.focus();
      editor.update(
        () => {
          $getRoot().selectStart();
        },
        {discrete: true},
      );
      const spy = spyOn(editor, command);
      const event = keyDown(root, init);
      expect(event.defaultPrevented).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  }

  // Only a text input takes the shortcut: a button or a checkbox has no
  // action of its own for it.
  for (const control of ['button', 'checkbox'] as const) {
    test(`Mod+Z on a ${control} in the decorator still runs the command`, () => {
      const {editor, input} = createEditor();
      const element = document.createElement(
        control === 'button' ? 'button' : 'input',
      );
      if (control === 'checkbox') {
        element.setAttribute('type', 'checkbox');
      }
      input.after(element);
      element.focus();
      const spy = spyOn(editor, UNDO_COMMAND);
      const event = keyDown(element, {[MOD]: true, key: 'z'});
      expect(event.defaultPrevented).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  }

  test('a real Ctrl/Alt+Backspace deletes a word in the input', async () => {
    const {editor, input} = createEditor();
    const editorText = editor.read(() => $getRoot().getTextContent());
    await userEvent.click(input);
    await userEvent.keyboard('hello world');
    await userEvent.keyboard(
      IS_APPLE ? '{Alt>}{Backspace}{/Alt}' : '{Control>}{Backspace}{/Control}',
    );
    expect(input.value).toBe('hello ');
    expect(editor.read(() => $getRoot().getTextContent())).toBe(editorText);
  });

  test('a real select all selects only the input', async () => {
    const {editor, input} = createEditor();
    const editorText = editor.read(() => $getRoot().getTextContent());
    await userEvent.click(input);
    await userEvent.keyboard('hello world');
    await userEvent.keyboard(
      IS_APPLE ? '{Meta>}a{/Meta}' : '{Control>}a{/Control}',
    );
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 11]);
    await userEvent.keyboard('new');
    expect(input.value).toBe('new');
    expect(editor.read(() => $getRoot().getTextContent())).toBe(editorText);
  });
});
