/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  COMMAND_PRIORITY_EDITOR,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ESCAPE_COMMAND,
  type LexicalCommand,
  type LexicalEditor,
} from 'lexical';
import {createTestEditor} from 'lexical/src/__tests__/utils';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  LexicalMenu,
  MenuOption,
  type MenuRenderFn,
  type MenuResolution,
} from '../../shared/LexicalMenu';

vi.mock('@lexical/react/LexicalComposerContext', () => ({
  useLexicalComposerContext: () => [createTestEditor()],
}));

class TestOption extends MenuOption {
  title: string;
  constructor(title: string) {
    super(title);
    this.title = title;
  }
}

function createTestResolution(): MenuResolution {
  return {
    getRect: () =>
      ({
        bottom: 100,
        height: 20,
        left: 10,
        right: 110,
        top: 80,
        width: 100,
        x: 10,
        y: 80,
      }) as DOMRect,
    match: {leadOffset: 0, matchingString: 'zz', replaceableString: 'zz'},
  };
}

describe('LexicalMenu arrow keys with no options', () => {
  let container: HTMLDivElement;
  let anchorElement: HTMLDivElement;
  let rootElement: HTMLDivElement;
  let reactRoot: Root;
  let editor: LexicalEditor;

  beforeEach(() => {
    container = document.createElement('div');
    anchorElement = document.createElement('div');
    rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    document.body.append(container, anchorElement, rootElement);
    reactRoot = createRoot(container);
    editor = createTestEditor();
    editor.setRootElement(rootElement);
  });

  afterEach(async () => {
    await act(async () => {
      reactRoot.unmount();
    });
    container.remove();
    anchorElement.remove();
    rootElement.remove();
    vi.restoreAllMocks();
  });

  async function renderMenu(
    options: TestOption[],
    menuRenderFn?: MenuRenderFn<TestOption>,
  ): Promise<void> {
    await act(async () => {
      reactRoot.render(
        <LexicalMenu<TestOption>
          close={vi.fn()}
          editor={editor}
          anchorElementRef={{current: anchorElement}}
          resolution={createTestResolution()}
          options={options}
          onSelectOption={vi.fn()}
          menuRenderFn={menuRenderFn}
        />,
      );
    });
  }

  function pressKey(command: LexicalCommand<KeyboardEvent>): {
    handled: boolean;
    defaultPrevented: boolean;
    reachedEditor: boolean;
  } {
    let reachedEditor = false;
    const removeFallback = editor.registerCommand(
      command,
      () => {
        reachedEditor = true;
        return false;
      },
      COMMAND_PRIORITY_EDITOR,
    );
    const event = new KeyboardEvent('keydown', {cancelable: true});
    let handled: boolean = false;
    try {
      act(() => {
        handled = editor.dispatchCommand(command, event);
      });
      return {defaultPrevented: event.defaultPrevented, handled, reachedEditor};
    } finally {
      removeFallback();
    }
  }

  for (const [name, command] of [
    ['ArrowDown', KEY_ARROW_DOWN_COMMAND],
    ['ArrowUp', KEY_ARROW_UP_COMMAND],
    ['Escape', KEY_ESCAPE_COMMAND],
  ] as const) {
    it(`lets ${name} through when there are no options`, async () => {
      // An empty option list renders no menu at all, so the key must still
      // reach whatever would otherwise move the caret.
      await renderMenu([]);

      const result = pressKey(command);
      expect(result.handled).toBe(false);
      expect(result.defaultPrevented).toBe(false);
      expect(result.reachedEditor).toBe(true);
    });

    it(`still consumes ${name} when there are options`, async () => {
      await renderMenu([new TestOption('a'), new TestOption('b')]);

      const result = pressKey(command);
      expect(result.handled).toBe(true);
      expect(result.defaultPrevented).toBe(true);
      expect(result.reachedEditor).toBe(false);
    });

    it(`still consumes ${name} when a custom renderer draws an empty menu`, async () => {
      // Only the default renderer draws nothing for an empty list. A
      // menuRenderFn is called whatever the options look like and may put a
      // "no results" panel on screen, which the user still has to be able to
      // move through and dismiss.
      await renderMenu([], () => <div>No results</div>);

      const result = pressKey(command);
      expect(result.handled).toBe(true);
      expect(result.defaultPrevented).toBe(true);
      expect(result.reachedEditor).toBe(false);
    });
  }
});
