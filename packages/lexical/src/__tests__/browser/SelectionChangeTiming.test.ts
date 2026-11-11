/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
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
  COMMAND_PRIORITY_LOW,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import {assert, expect, onTestFinished, test, vi} from 'vitest';

test.each(['native', 'range', 'node'])(
  '%s notifications expose pending state and defer DOM measurements until commit',
  async origin => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    const editor = buildEditorFromExtensions();
    editor.setRootElement(root);
    onTestFinished(() => {
      editor.dispose();
      root.remove();
    });
    editor.update(
      () => {
        $getRoot().clear();
        for (const text of ['line one', 'line two', 'line three']) {
          $getRoot().append(
            $createParagraphNode().append($createTextNode(text)),
          );
        }
        $getRoot().getAllTextNodes()[0].select(0, 4);
      },
      {discrete: true},
    );
    await new Promise(resolve => setTimeout(resolve, 75));
    const native = window.getSelection()!;
    const oldTop = native.getRangeAt(0).getBoundingClientRect().top;
    const previous = editor.getEditorState();
    const committed = vi.fn();
    const listener = vi.fn(() => {
      expect(editor.getEditorState()).toBe(previous);
      expect($getPreviousSelection()).toBe(previous._selection);
      expect(root.textContent).toBe('line oneline twoline three');
      $onUpdate(() =>
        editor.read('latest', () => {
          expect(root.textContent).toBe('CHANGEDline twoline three');
          const selection = $getSelection();
          assert(selection !== null);
          const selected = $isRangeSelection(selection)
            ? selection.anchor.getNode()
            : selection.getNodes()[0];
          const element = editor.getElementByKey(selected.getKey());
          assert(element !== null);
          const top =
            origin === 'node'
              ? element.getBoundingClientRect().top
              : native.getRangeAt(0).getBoundingClientRect().top;
          expect(top).toBeGreaterThan(oldTop + 20);
          committed();
        }),
      );
      return false;
    });
    const unregister = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      listener,
      COMMAND_PRIORITY_LOW,
    );
    const updates = vi.fn();
    editor.registerUpdateListener(updates);
    if (origin === 'native') {
      const thirdText = root.lastElementChild!.firstChild!.firstChild!;
      native.setBaseAndExtent(thirdText, 0, thirdText, 4);
    }
    editor.update(
      () => {
        const texts = $getRoot().getAllTextNodes();
        texts[0].setTextContent('CHANGED');
        if (origin === 'native') {
          document.dispatchEvent(new Event('selectionchange'));
        } else if (origin === 'range') {
          texts[2].select(0, 4);
        } else {
          const selection = $createNodeSelection();
          selection.add(texts[2].getKey());
          $setSelection(selection);
        }
      },
      {discrete: true},
    );
    unregister();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(updates).toHaveBeenCalledTimes(1);
  },
);
