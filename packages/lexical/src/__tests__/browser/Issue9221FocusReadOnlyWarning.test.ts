/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  createCommand,
  FOCUS_COMMAND,
  isCurrentlyReadOnlyMode,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';

function mountEditor() {
  const container = document.createElement('div');
  const outside = document.createElement('button');
  const rootElement = document.createElement('div');
  rootElement.contentEditable = 'true';
  container.append(outside, rootElement);
  document.body.append(container);

  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('hello')),
      );
    },
    name: '[9221-focus-read-only-warning]',
  });
  editor.setRootElement(rootElement);
  onTestFinished(() => {
    editor.dispose();
    container.remove();
  });
  return {editor, outside, rootElement};
}

// Drain commits and the browser's asynchronous selectionchange events.
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('Issue #9221: focus commands during DOM selection updates', () => {
  for (const action of ['focus', 'select', 'refocus'] as const) {
    test.each([false, true])(
      `${action} does not warn (mutating listener: %s)`,
      async mutate => {
        const {editor, outside, rootElement} = mountEditor();
        if (action === 'refocus') {
          await new Promise<void>(resolve => editor.focus(resolve));
        }
        outside.focus();
        await settle();
        expect(document.activeElement).toBe(outside);

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        onTestFinished(() => warn.mockRestore());
        const onFocus = vi.fn(() => {
          expect(isCurrentlyReadOnlyMode()).toBe(false);
          if (mutate) {
            const text = $getRoot().getFirstDescendant();
            assert($isTextNode(text));
            text.setTextContent('hello!');
          }
          return false;
        });
        editor.registerCommand(FOCUS_COMMAND, onFocus, COMMAND_PRIORITY_LOW);

        if (action === 'select') {
          editor.update(() => $getRoot().selectEnd());
        } else {
          editor.focus();
        }
        await settle();

        expect(document.activeElement).toBe(rootElement);
        expect(onFocus).toHaveBeenCalledTimes(1);
        expect(rootElement.textContent).toBe(mutate ? 'hello!' : 'hello');
        expect(warn).not.toHaveBeenCalled();
      },
    );
  }

  test('still warns for an explicit read inside a commit-time focus event', async () => {
    const {editor, outside, rootElement} = mountEditor();
    outside.focus();
    await settle();

    const mutateCommand = createCommand<void>('MUTATE_FROM_READ');
    editor.registerCommand(
      mutateCommand,
      () => {
        const text = $getRoot().getFirstDescendant();
        assert($isTextNode(text));
        text.setTextContent('hello!');
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    rootElement.addEventListener(
      'focus',
      () => {
        // This application callback runs while the commit is synchronously
        // moving DOM focus, but its explicit read must still be diagnosed.
        editor.read('latest', () => editor.dispatchCommand(mutateCommand));
      },
      {once: true},
    );

    editor.focus();
    await settle();

    expect(document.activeElement).toBe(rootElement);
    expect(rootElement.textContent).toBe('hello!');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('read-only context');
  });
});
