/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getPreviousSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $onUpdate,
  $setSelection,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  configExtension,
  createCommand,
  IS_BOLD,
  type LexicalEditor,
  SELECTION_CHANGE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';

function mountEditor(editor: LexicalEditor): void {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  onTestFinished(() => root.remove());
  editor.setRootElement(root);
}

describe('SELECTION_CHANGE_COMMAND', () => {
  test.each([
    ['replace', false],
    ['replace', true],
    ['reorder', false],
    ['reorder', true],
  ] as const)(
    'reconciles a same-size child %s across selection notifications (normalize: %s)',
    (operation, normalize) => {
      using editor = buildEditorFromExtensions();
      mountEditor(editor);
      editor.update(
        () => {
          const root = $getRoot().clear();
          for (const text of ['first', 'second', 'third', 'fourth']) {
            root.append($createParagraphNode().append($createTextNode(text)));
          }
          root.selectStart();
        },
        {discrete: true},
      );
      const previous = editor.getEditorState();
      const listener = vi.fn(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        if (!selection.hasFormat('bold')) selection.toggleFormat('bold');
        return false;
      });
      if (normalize) {
        editor.registerCommand(
          SELECTION_CHANGE_COMMAND,
          listener,
          COMMAND_PRIORITY_LOW,
        );
      }
      editor.update(
        () => {
          const root = $getRoot();
          const third = root.getChildAtIndex(2)!;
          if (operation === 'replace') {
            third.replace(
              $createParagraphNode().append($createTextNode('replacement')),
            );
          } else {
            third.insertBefore(root.getLastChildOrThrow());
          }
          root.selectEnd();
        },
        {discrete: true},
      );
      const expected =
        operation === 'replace'
          ? ['first', 'second', 'replacement', 'fourth']
          : ['first', 'second', 'fourth', 'third'];
      expect(
        [...editor.getRootElement()!.children].map(node => node.textContent),
      ).toEqual(expected);
      expect(
        editor.read(() =>
          $getRoot()
            .getChildren()
            .map(node => node.getTextContent()),
        ),
      ).toEqual(expected);
      expect(
        previous.read(() =>
          $getRoot()
            .getChildren()
            .map(node => node.getTextContent()),
        ),
      ).toEqual(['first', 'second', 'third', 'fourth']);
      if (normalize) expect(listener).toHaveBeenCalledTimes(2);
    },
  );

  test('explicit selection commands retain a fresh update-cascade budget', async () => {
    using editor = buildEditorFromExtensions();
    const onWarn = vi.spyOn(editor, '_onWarn').mockImplementation(() => {});
    const onError = vi.spyOn(editor, '_onError').mockImplementation(() => {});
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        editor.update(() => $getRoot().markDirty());
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const unregister = editor.registerUpdateListener(() => {
      editor.update(() => {});
    });
    for (let i = 0; i < 150; i++) {
      editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
      // Flush commits without allowing the macrotask budget reset to run.
      for (let j = 0; j < 4; j++) {
        await Promise.resolve();
      }
    }
    unregister();
    expect(onWarn).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test('does not warn when the last allowed notification clears a rootless selection', () => {
    using editor = buildEditorFromExtensions();
    const onWarn = vi.spyOn(editor, '_onWarn');
    let calls = 0;
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        if (++calls === 100) {
          $setSelection(null);
        } else {
          const root = $getRoot();
          const selection = $createNodeSelection();
          selection.add(
            (calls % 2
              ? root.getLastChildOrThrow()
              : root.getFirstChildOrThrow()
            ).getKey(),
          );
          $setSelection(selection);
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    editor.update(
      () => {
        const first = $createParagraphNode();
        $getRoot().clear().append(first, $createParagraphNode());
        const selection = $createNodeSelection();
        selection.add(first.getKey());
        $setSelection(selection);
      },
      {discrete: true},
    );
    expect(calls).toBe(100);
    expect(onWarn).not.toHaveBeenCalled();
    expect(editor.read(() => $getSelection())).toBe(null);
  });

  test.each([false, true])(
    'counts explicit dispatches before commit (outside update: %s)',
    outside => {
      using editor = buildEditorFromExtensions();
      mountEditor(editor);
      editor.update(
        () => {
          const text = $createTextNode('original');
          $getRoot().clear().append($createParagraphNode().append(text));
          text.select(1, 1);
        },
        {discrete: true},
      );
      const listener = vi.fn(() => false);
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        listener,
        COMMAND_PRIORITY_LOW,
      );
      editor.update(() => {
        $getRoot().getAllTextNodes()[0].select(3, 3);
        if (!outside) editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
      });
      if (outside) editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
      editor.read(() => {});
      expect(listener).toHaveBeenCalledTimes(1);
      // Explicit commands still run even when the selection is unchanged.
      editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
      editor.read(() => {});
      expect(listener).toHaveBeenCalledTimes(2);
    },
  );

  test.each([false, true])(
    'aborts the update when a selection listener throws (explicit dispatch: %s)',
    explicit => {
      using editor = buildEditorFromExtensions();
      mountEditor(editor);
      editor.update(
        () => {
          const text = $createTextNode('original');
          $getRoot().clear().append($createParagraphNode().append(text));
          text.select(1, 1);
        },
        {discrete: true},
      );
      const failure = new Error('selection listener failed');
      const onError = vi.spyOn(editor, '_onError').mockImplementation(() => {});
      const onWarn = vi.spyOn(editor, '_onWarn');
      const unregister = editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          const text = $getRoot().getAllTextNodes()[0];
          if (text.getTextContent() === 'edited!') {
            text.setTextContent('listener change');
            $getRoot().append(
              $createParagraphNode().append($createTextNode('discard')),
            );
            $getRoot().selectEnd();
            throw failure;
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      );
      editor.update(
        () => {
          const text = $getRoot().getAllTextNodes()[0];
          text.setTextContent('edited!');
          text.select(3, 3);
          if (explicit) editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
        },
        {discrete: true},
      );
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(onWarn).not.toHaveBeenCalled();
      expect(editor.getRootElement()!.textContent).toBe('original');
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('original');
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(selection.anchor.offset).toBe(1);
      });
      unregister();
      editor.update(() => $getRoot().getAllTextNodes()[0].select(4, 4), {
        discrete: true,
      });
      expect(onError).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'restores the notification baseline after rollback (explicit: %s, retry selection: %s)',
    (explicit, retrySelection) => {
      using editor = buildEditorFromExtensions();
      mountEditor(editor);
      editor.update(
        () => {
          const text = $createTextNode('original');
          $getRoot().clear().append($createParagraphNode().append(text));
          text.select(1, 1);
        },
        {discrete: true},
      );
      const failure = new Error('selection listener failed');
      const onError = vi.spyOn(editor, '_onError').mockImplementation(() => {});
      const listener = vi
        .fn(() => false)
        .mockImplementationOnce(() => {
          throw failure;
        });
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        listener,
        COMMAND_PRIORITY_LOW,
      );
      editor.update(
        () => {
          $getRoot().getAllTextNodes()[0].select(3, 3);
          if (explicit) editor.dispatchCommand(SELECTION_CHANGE_COMMAND);
        },
        {discrete: true},
      );
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(listener).toHaveBeenCalledTimes(1);
      listener.mockClear();
      editor.update(
        () => {
          if (retrySelection) $getRoot().getAllTextNodes()[0].select(3, 3);
        },
        {discrete: true, onUpdate: () => {}},
      );
      expect(listener).toHaveBeenCalledTimes(retrySelection ? 1 : 0);
    },
  );

  test.each(['transform', 'nested update'])(
    'aborts the update when listener work fails in a %s',
    origin => {
      using editor = buildEditorFromExtensions();
      mountEditor(editor);
      editor.update(
        () => {
          const text = $createTextNode('original');
          $getRoot().clear().append($createParagraphNode().append(text));
          text.select(1, 1);
        },
        {discrete: true},
      );
      const failure = new Error('listener work failed');
      const onError = vi.spyOn(editor, '_onError').mockImplementation(() => {});
      editor.registerNodeTransform(TextNode, node => {
        if (node.getTextContent() === 'transform failure') {
          node.setTextContent('must be discarded');
          throw failure;
        }
      });
      editor.read(() => {});
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          const text = $getRoot().getAllTextNodes()[0];
          text.setTextContent('transform failure');
          if (origin === 'nested update') {
            editor.update(() => {
              text.remove();
              throw failure;
            });
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      );
      editor.update(
        () => {
          const text = $getRoot().getAllTextNodes()[0];
          text.setTextContent('edited!');
          text.select(3, 3);
        },
        {discrete: true},
      );
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(editor.read(() => $getRoot().getTextContent())).toBe('original');
      expect(editor.getRootElement()!.textContent).toBe('original');
    },
  );

  test('does not replay skipped range changes when a detached root reconnects', () => {
    using editor = buildEditorFromExtensions();
    mountEditor(editor);
    editor.update(
      () => {
        const text = $createTextNode('original');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(1, 1);
      },
      {discrete: true},
    );
    const root = editor.getRootElement()!;
    root.remove();
    const listener = vi.fn(() => false);
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      listener,
      COMMAND_PRIORITY_LOW,
    );
    editor.update(() => $getRoot().getAllTextNodes()[0].select(3, 3), {
      discrete: true,
    });
    expect(listener).not.toHaveBeenCalled();
    document.body.append(root);
    editor.update(() => $getRoot().append($createParagraphNode()), {
      discrete: true,
      tag: SKIP_DOM_SELECTION_TAG,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'caps notifications without discarding edits (throwing warning: %s)',
    throws => {
      using editor = buildEditorFromExtensions();
      mountEditor(editor);
      editor.update(
        () => {
          const text = $createTextNode('original');
          $getRoot().clear().append($createParagraphNode().append(text));
          text.select(1, 1);
        },
        {discrete: true},
      );
      const onError = vi.spyOn(editor, '_onError').mockImplementation(() => {});
      const onWarn = vi.spyOn(editor, '_onWarn').mockImplementation(error => {
        if (throws) throw error;
      });
      const updates = vi.fn();
      editor.registerUpdateListener(updates);
      const onUpdate = vi.fn();
      const listener = vi.fn(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        const offset = selection.anchor.offset === 1 ? 2 : 1;
        $getRoot().getAllTextNodes()[0].select(offset, offset);
        return false;
      });
      const unregister = editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        listener,
        COMMAND_PRIORITY_LOW,
      );
      // A discrete commit lets this test catch a throwing onWarn at the call
      // site. With an asynchronous commit it escapes from the commit microtask,
      // as it does for the existing update-listener cascade warning.
      const update = () =>
        editor.update(
          () => {
            const text = $getRoot().getAllTextNodes()[0];
            text.setTextContent('TYPED original');
            text.select(2, 2);
          },
          {discrete: true, onUpdate},
        );
      if (throws) {
        expect(update).toThrow(
          'Selection change listeners are endlessly changing the selection.',
        );
      } else {
        update();
      }
      expect(listener).toHaveBeenCalledTimes(100);
      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(editor.read(() => $getRoot().getTextContent())).toBe(
        'TYPED original',
      );
      expect(editor.getRootElement()!.textContent).toBe('TYPED original');
      expect(updates).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledTimes(1);
      unregister();
      editor.update(() => $getRoot().getAllTextNodes()[0].select(3, 3), {
        discrete: true,
      });
      editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(selection.anchor.offset).toBe(3);
      });
    },
  );

  test.each(['mounted', 'rootless', 'detached'])(
    'node selections notify before commit in a %s editor',
    kind => {
      using editor = buildEditorFromExtensions();
      if (kind === 'mounted') mountEditor(editor);
      else if (kind === 'detached')
        editor.setRootElement(document.createElement('div'));
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('original')));
        },
        {discrete: true},
      );
      const previous = editor.getEditorState();
      const listener = vi.fn(() => {
        expect(editor.getEditorState()).toBe(previous);
        expect($getPreviousSelection()).toBe(previous._selection);
        expect($getRoot().getTextContent()).toBe('CHANGED');
        if (kind === 'mounted')
          expect(editor.getRootElement()!.textContent).toBe('original');
        return false;
      });
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        listener,
        COMMAND_PRIORITY_LOW,
      );
      editor.update(
        () => {
          const text = $getRoot().getAllTextNodes()[0];
          text.setTextContent('CHANGED');
          const selection = $createNodeSelection();
          selection.add(text.getKey());
          $setSelection(selection);
        },
        {discrete: true},
      );
      expect(listener).toHaveBeenCalledTimes(1);
    },
  );

  test('listener edits and transforms are reconciled in the original commit', () => {
    using editor = buildEditorFromExtensions();
    mountEditor(editor);
    editor.update(
      () => {
        const text = $createTextNode('Hello');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(1, 1);
      },
      {discrete: true},
    );
    const updates = vi.fn();
    editor.registerUpdateListener(updates);
    editor.registerNodeTransform(TextNode, node => {
      if (node.getTextContent() === 'Changed') {
        node.setTextContent('Transformed');
      }
    });
    editor.read(() => {});
    updates.mockClear();
    const previousState = editor.getEditorState();
    const unregister = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        expect(editor.getEditorState()).toBe(previousState);
        expect(editor.getRootElement()!.textContent).toBe('Hello');
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect($getPreviousSelection()).toBe(previousState._selection);
        $getRoot().getAllTextNodes()[0].setTextContent('Changed');
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    editor.update(() => $getRoot().getAllTextNodes()[0].select(2, 2), {
      discrete: true,
    });
    unregister();
    expect(editor.read(() => $getRoot().getTextContent())).toBe('Transformed');
    expect(editor.getRootElement()!.textContent).toBe('Transformed');
    expect(updates).toHaveBeenCalledTimes(1);
  });

  test.each(['onUpdate', '$onUpdate', 'selection listener', 'none'])(
    'preserves typing undo merging with %s callbacks',
    async callback => {
      using editor = buildEditorFromExtensions(
        configExtension(HistoryExtension, {delay: 1000, now: () => 0}),
      );
      mountEditor(editor);
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          $getRoot().clear().append(paragraph);
          paragraph.selectEnd();
        },
        {discrete: true},
      );
      await Promise.resolve();
      const onUpdate = vi.fn();
      const updates = vi.fn();
      // Toolbars listen to history availability during the commit, while
      // callbacks from selection listeners are still waiting to run.
      editor.registerCommand(
        CAN_UNDO_COMMAND,
        () => false,
        COMMAND_PRIORITY_LOW,
      );
      const unregisterSelection = editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          if (callback === 'selection listener') {
            $onUpdate(onUpdate);
          }
          return false;
        },
        COMMAND_PRIORITY_LOW,
      );
      const unregister = editor.registerUpdateListener(updates);
      for (const character of 'abcd') {
        editor.update(
          () => {
            const selection = $getSelection();
            assert($isRangeSelection(selection));
            selection.insertText(character);
            if (callback === '$onUpdate') {
              $onUpdate(onUpdate);
            }
          },
          {
            discrete: true,
            onUpdate: callback === 'onUpdate' ? onUpdate : undefined,
          },
        );
        await Promise.resolve();
      }
      expect(editor.read(() => $getRoot().getTextContent())).toBe('abcd');
      unregister();
      unregisterSelection();
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      expect(editor.read(() => $getRoot().getTextContent())).toBe('');
      expect(updates).toHaveBeenCalledTimes(4);
      expect(onUpdate).toHaveBeenCalledTimes(callback === 'none' ? 0 : 4);
    },
  );

  test('preserves callbacks added by a command during commit listeners', async () => {
    using editor = buildEditorFromExtensions();
    mountEditor(editor);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('initial')));
      },
      {discrete: true},
    );
    const command = createCommand<void>();
    const callbacks: string[] = [];
    editor.registerCommand(
      command,
      () => {
        $getRoot().getAllTextNodes()[0].setTextContent('second');
        $onUpdate(() =>
          callbacks.push(`second: ${editor.getRootElement()!.textContent}`),
        );
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
    const unregister = editor.registerUpdateListener(() => {
      unregister();
      editor.dispatchCommand(command);
    });
    editor.update(
      () => {
        $getRoot().getAllTextNodes()[0].setTextContent('first');
        $onUpdate(() =>
          callbacks.push(`first: ${editor.getRootElement()!.textContent}`),
        );
      },
      {discrete: true},
    );
    await Promise.resolve();
    expect(callbacks).toEqual(['first: first', 'second: second']);
  });

  test('focus produces one tagged commit and one callback', async () => {
    using editor = buildEditorFromExtensions();
    mountEditor(editor);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('Hello')));
        $setSelection(null);
      },
      {discrete: true},
    );
    await Promise.resolve();
    const tags: string[][] = [];
    const states = new Set();
    editor.registerUpdateListener(({editorState, tags: updateTags}) => {
      tags.push([...updateTags]);
      states.add(editorState);
    });
    const onFocus = vi.fn();
    editor.focus(onFocus);
    editor.read(() => {});
    await Promise.resolve();
    expect(tags).toEqual([['focus']]);
    expect(states.size).toBe(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  test.each(['rootless', 'detached'])(
    'preserves existing notification behavior for a %s editor',
    rootKind => {
      using editor = buildEditorFromExtensions();
      if (rootKind === 'detached') {
        const root = document.createElement('div');
        root.contentEditable = 'true';
        editor.setRootElement(root);
        expect(root.isConnected).toBe(false);
      }
      const listener = vi.fn(() => false);
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        listener,
        COMMAND_PRIORITY_LOW,
      );
      editor.update(
        () => {
          const text = $createTextNode('Hello world');
          $getRoot().clear().append($createParagraphNode().append(text));
          text.select(2, 5);
        },
        {discrete: true},
      );
      editor.update(() => $setSelection(null), {discrete: true});
      expect(listener).not.toHaveBeenCalled();

      // Non-range selection notifications already work without a connected root.
      editor.update(
        () => {
          const selection = $createNodeSelection();
          selection.add($getRoot().getFirstChildOrThrow().getKey());
          $setSelection(selection);
        },
        {discrete: true},
      );
      expect(listener).toHaveBeenCalledTimes(1);
    },
  );

  test('tracks non-range notifications while the root is detached', () => {
    using editor = buildEditorFromExtensions();
    mountEditor(editor);
    const root = editor.getRootElement()!;
    editor.update(
      () => {
        const text = $createTextNode('Hello world');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(2, 5);
      },
      {discrete: true},
    );
    const listener = vi.fn(() => false);
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      listener,
      COMMAND_PRIORITY_LOW,
    );
    root.remove();
    editor.update(
      () => {
        const selection = $createNodeSelection();
        selection.add($getRoot().getFirstChildOrThrow().getKey());
        $setSelection(selection);
      },
      {discrete: true},
    );
    expect(listener).toHaveBeenCalledTimes(1);
    document.body.appendChild(root);
    editor.update(() => $getRoot().getAllTextNodes()[0].select(2, 5), {
      discrete: true,
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test.each(
    [false, true].flatMap(discrete =>
      ['move', 'clear', 'replace', 'content only'].map(change => ({
        change,
        discrete,
      })),
    ),
  )(
    'preserves mutation-listener updates: $change (discrete: $discrete)',
    ({change, discrete}) => {
      const root = document.createElement('div');
      root.contentEditable = 'true';
      document.body.appendChild(root);
      onTestFinished(() => root.remove());
      using editor = buildEditorFromExtensions();
      editor.setRootElement(root);
      editor.update(
        () => {
          const text = $createTextNode('Hello world');
          $getRoot().clear().append($createParagraphNode().append(text));
          text.select(1, 1);
        },
        {discrete: true},
      );

      const selections: ReturnType<typeof $getSelection>[] = [];
      const unregisterCommand = editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          selections.push($getSelection()?.clone() ?? null);
          return false;
        },
        COMMAND_PRIORITY_LOW,
      );
      const unregisterMutation = editor.registerMutationListener(
        TextNode,
        () => {
          unregisterMutation();
          editor.update(
            () => {
              if (change === 'clear') {
                $setSelection(null);
              } else if (change === 'replace') {
                const text = $createTextNode('Replacement');
                $getRoot().clear().append($createParagraphNode().append(text));
                text.select(7, 7);
              } else if (change === 'move') {
                $getRoot().getAllTextNodes()[0].select(7, 7);
              } else {
                $getRoot().getAllTextNodes()[0].setTextContent('Hello world!?');
              }
            },
            discrete ? {discrete: true} : undefined,
          );
        },
        {skipInitialization: true},
      );

      editor.update(
        () => {
          const text = $getRoot().getAllTextNodes()[0];
          text.setTextContent('Hello world!');
          text.select(2, 2);
        },
        {discrete: true},
      );
      editor.read(() => {
        const selection = $getSelection();
        if (change === 'clear') {
          expect(selection).toBe(null);
        } else {
          assert($isRangeSelection(selection));
          const offset = change === 'content only' ? 2 : 7;
          expect([selection.anchor.offset, selection.focus.offset]).toEqual([
            offset,
            offset,
          ]);
        }
        expect($getRoot().getTextContent()).toBe(
          change === 'replace'
            ? 'Replacement'
            : change === 'content only'
              ? 'Hello world!?'
              : 'Hello world!',
        );
        // Mutation listeners run after the first selection has committed.
        // Their changes belong to a second update and notify before its commit.
        expect(selections).toHaveLength(change === 'content only' ? 1 : 2);
        expect(
          selection === null
            ? selections.at(-1) === null
            : selection.is(selections.at(-1)!),
        ).toBe(true);
      });
      unregisterCommand();
    },
  );

  test('reports committed selection changes without requiring DOM events', () => {
    using editor = buildEditorFromExtensions();
    mountEditor(editor);
    editor.update(
      () => {
        const text = $createTextNode('Hello world');
        $getRoot().append($createParagraphNode().append(text));
        text.select(2, 9);
      },
      {discrete: true},
    );

    const onSelectionChange = vi.fn(() => false);
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      onSelectionChange,
      COMMAND_PRIORITY_LOW,
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        selection.removeText();
      },
      {discrete: true},
    );
    expect(onSelectionChange).toHaveBeenCalledTimes(1);

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        selection.insertText('y');
      },
      {discrete: true},
    );
    expect(onSelectionChange).toHaveBeenCalledTimes(2);

    editor.update(() => $getRoot().selectEnd(), {discrete: true});
    expect(onSelectionChange).toHaveBeenCalledTimes(3);

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        selection.toggleFormat('bold');
      },
      {discrete: true},
    );
    expect(onSelectionChange).toHaveBeenCalledTimes(4);

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        selection.setStyle('color: red');
      },
      {discrete: true},
    );
    expect(onSelectionChange).toHaveBeenCalledTimes(5);

    // Dirtying the same selection or changing content without moving it is
    // not a selection change.
    editor.update(() => $setSelection($getSelection()!.clone()), {
      discrete: true,
    });
    editor.update(() => $getRoot().append($createParagraphNode()), {
      discrete: true,
    });
    expect(onSelectionChange).toHaveBeenCalledTimes(5);

    editor.update(
      () => {
        const selection = $createNodeSelection();
        selection.add($getRoot().getFirstChildOrThrow().getKey());
        $setSelection(selection);
      },
      {discrete: true},
    );
    expect(onSelectionChange).toHaveBeenCalledTimes(6);

    editor.update(() => $setSelection(null), {discrete: true});
    expect(onSelectionChange).toHaveBeenCalledTimes(7);
    editor.update(() => $setSelection(null), {discrete: true});
    expect(onSelectionChange).toHaveBeenCalledTimes(7);
  });

  test('reports selection changes from setEditorState', () => {
    using editor = buildEditorFromExtensions();
    mountEditor(editor);
    editor.update(
      () => {
        const text = $createTextNode('Hello world');
        $getRoot().append($createParagraphNode().append(text));
        text.select(2, 9);
      },
      {discrete: true},
    );
    const previousState = editor.getEditorState();
    editor.update(() => $getRoot().selectEnd(), {discrete: true});

    const onSelectionChange = vi.fn(() => false);
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      onSelectionChange,
      COMMAND_PRIORITY_LOW,
    );
    editor.setEditorState(previousState);
    editor.read(() => {});
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
  });

  test('listeners see the committed selection when DOM synchronization is skipped', () => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    onTestFinished(() => root.remove());
    using editor = buildEditorFromExtensions();
    editor.setRootElement(root);
    editor.update(
      () => {
        const text = $createTextNode('Hello world');
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(1, 1);
      },
      {discrete: true},
    );

    const onSelectionChange = vi.fn(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect([selection.anchor.offset, selection.focus.offset]).toEqual([3, 7]);
      const previous = $getPreviousSelection();
      assert($isRangeSelection(previous));
      expect([previous.anchor.offset, previous.focus.offset]).toEqual([1, 1]);
      return false;
    });
    const unregister = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      onSelectionChange,
      COMMAND_PRIORITY_LOW,
    );
    editor.update(() => $getRoot().getAllTextNodes()[0].select(3, 7), {
      discrete: true,
      tag: SKIP_DOM_SELECTION_TAG,
    });
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    unregister();
  });

  test('notifies a selection change made by a command listener', () => {
    using editor = buildEditorFromExtensions();
    mountEditor(editor);
    editor.update(
      () => {
        const text = $createTextNode('Hello world');
        $getRoot().append($createParagraphNode().append(text));
        text.select(1, 1);
      },
      {discrete: true},
    );
    const offsets: number[][] = [];
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        const previous = $getPreviousSelection();
        assert($isRangeSelection(previous));
        offsets.push([previous.anchor.offset, selection.anchor.offset]);
        if (selection.anchor.offset === 3) {
          $getRoot().getAllTextNodes()[0].select(4, 4);
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    editor.update(() => $getRoot().getAllTextNodes()[0].select(3, 3), {
      discrete: true,
    });
    editor.read(() => {});
    expect(offsets).toEqual([
      [1, 3],
      [1, 4],
    ]);
    editor.read(() =>
      expect($getSelection()?.is($getPreviousSelection())).toBe(true),
    );
  });

  test('notifies once for batched changes and skips a batch with no net change', () => {
    using editor = buildEditorFromExtensions();
    mountEditor(editor);
    editor.update(
      () => {
        const text = $createTextNode('Hello world');
        $getRoot().append($createParagraphNode().append(text));
        text.select(1, 1);
      },
      {discrete: true},
    );
    const onSelectionChange = vi.fn(() => false);
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      onSelectionChange,
      COMMAND_PRIORITY_LOW,
    );
    editor.update(() => $getRoot().getAllTextNodes()[0].select(2, 2));
    editor.update(() => $getRoot().getAllTextNodes()[0].select(3, 3));
    editor.read(() => {});
    expect(onSelectionChange).toHaveBeenCalledTimes(1);

    editor.update(() => $getRoot().getAllTextNodes()[0].select(4, 4));
    editor.update(() => $getRoot().getAllTextNodes()[0].select(3, 3));
    editor.read(() => {});
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
  });

  test('a dropped no-op update does not suppress the next notification', async () => {
    using editor = buildEditorFromExtensions();
    mountEditor(editor);
    // Restates every range as bold, the way a toolbar might restate the format
    // of only the text the reader can see.
    editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection) && !selection.isCollapsed()) {
          selection.format = IS_BOLD;
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    editor.update(
      () => {
        const text = $createTextNode('Hello');
        $getRoot().append($createParagraphNode().append(text));
        text.select(0, 5);
      },
      {discrete: true},
    );
    const committedFormat = () =>
      editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        return selection.format;
      });
    expect(committedFormat()).toBe(IS_BOLD);
    // Each selectionchange recomputes the range's format from its text (0)
    // and announces it; the listener restates bold, which matches the
    // committed selection, so the update is dropped. That dropped update must
    // not leave its pre-listener selection recorded as notified.
    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(new Event('selectionchange'));
      await Promise.resolve();
      expect(committedFormat()).toBe(IS_BOLD);
    }
  });
});
