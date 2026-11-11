/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$createLinkNode, LinkExtension} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getPreviousSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  isDOMTextNode,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';
import {userEvent} from 'vitest/browser';

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 50));
}

describe('selection change after deleting a range (#9179)', () => {
  test.each(
    ['plain', 'bold', 'links', 'single node'].flatMap(kind =>
      [false, true].flatMap(backward =>
        ['{Backspace}', '{Delete}', 'x'].map(input => ({
          backward,
          input,
          kind,
        })),
      ),
    ),
  )(
    'notifies once for $input in $kind text (backward: $backward)',
    async ({backward, input, kind}) => {
      const contentEditable = document.createElement('div');
      contentEditable.contentEditable = 'true';
      document.body.appendChild(contentEditable);
      const editor = buildEditorFromExtensions(
        RichTextExtension,
        LinkExtension,
      );
      editor.setRootElement(contentEditable);
      onTestFinished(() => {
        editor.dispose();
        contentEditable.remove();
      });

      let startKey = '';
      let endKey = '';
      editor.update(
        () => {
          $getRoot().clear();
          const start = $createTextNode('Hello');
          const end = $createTextNode('world');
          startKey = start.getKey();
          endKey = end.getKey();
          if (kind === 'bold') {
            start.toggleFormat('bold');
            end.toggleFormat('bold');
          }
          if (kind === 'single node') {
            start.setTextContent('Hello world');
            endKey = startKey;
            $getRoot().append($createParagraphNode().append(start));
          } else {
            $getRoot().append(
              $createParagraphNode().append(
                kind === 'links'
                  ? $createLinkNode('https://example.com/one').append(start)
                  : start,
              ),
              $createParagraphNode().append(
                kind === 'links'
                  ? $createLinkNode('https://example.com/two').append(end)
                  : end,
              ),
            );
          }
          start.select(0, 0);
        },
        {discrete: true},
      );
      contentEditable.focus();
      await settle();

      const startDOM = editor.getElementByKey(startKey)?.firstChild;
      const endDOM = editor.getElementByKey(endKey)?.firstChild;
      assert(isDOMTextNode(startDOM));
      assert(isDOMTextNode(endDOM));
      const domSelection = document.getSelection();
      assert(domSelection !== null);
      const endOffset = kind === 'single node' ? 9 : 3;
      domSelection.setBaseAndExtent(
        backward ? endDOM : startDOM,
        backward ? endOffset : 2,
        backward ? startDOM : endDOM,
        backward ? 2 : endOffset,
      );
      await vi.waitFor(() => {
        expect(editor.read(() => $getSelection()?.getTextContent())).toBe(
          kind === 'single node' ? 'llo wor' : 'llo\nwor',
        );
      });
      await settle();

      const expectedText = input === 'x' ? 'Hexld' : 'Held';
      const onSelectionChange = vi.fn(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(selection.isCollapsed()).toBe(true);
        expect($getRoot().getTextContent()).toBe(expectedText);
        return false;
      });
      onTestFinished(
        editor.registerCommand(
          SELECTION_CHANGE_COMMAND,
          onSelectionChange,
          COMMAND_PRIORITY_CRITICAL,
        ),
      );

      // Focus the test iframe as well as the editor. In Firefox, an editor can
      // remain document.activeElement while its iframe is inactive, in which
      // case Playwright's keyboard events never reach the contenteditable.
      window.focus();
      await userEvent.keyboard(input);
      await vi.waitFor(() => {
        expect(editor.read(() => $getRoot().getTextContent())).toBe(
          expectedText,
        );
        expect(onSelectionChange).toHaveBeenCalledTimes(1);
      });
      await settle();
      document.dispatchEvent(new Event('selectionchange'));
      expect(onSelectionChange).toHaveBeenCalledTimes(1);
    },
  );

  test('native changes preserve the previous selection and notify once', async () => {
    const contentEditable = document.createElement('div');
    contentEditable.contentEditable = 'true';
    document.body.appendChild(contentEditable);
    const editor = buildEditorFromExtensions(RichTextExtension);
    editor.setRootElement(contentEditable);
    onTestFinished(() => {
      editor.dispose();
      contentEditable.remove();
    });
    let textKey = '';
    editor.update(
      () => {
        const text = $createTextNode('Hello world');
        textKey = text.getKey();
        $getRoot().clear().append($createParagraphNode().append(text));
        text.select(1, 1);
      },
      {discrete: true},
    );
    contentEditable.focus();
    await settle();

    const selections: number[][] = [];
    onTestFinished(
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          const previous = $getPreviousSelection();
          const current = $getSelection();
          assert($isRangeSelection(previous));
          assert($isRangeSelection(current));
          selections.push([
            previous.anchor.offset,
            previous.focus.offset,
            current.anchor.offset,
            current.focus.offset,
          ]);
          return false;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
    );
    const textDOM = editor.getElementByKey(textKey)?.firstChild;
    assert(isDOMTextNode(textDOM));
    const domSelection = document.getSelection();
    assert(domSelection !== null);
    domSelection.setBaseAndExtent(textDOM, 2, textDOM, 8);
    await vi.waitFor(() => expect(selections).toEqual([[1, 1, 2, 8]]));
    await settle();
    document.dispatchEvent(new Event('selectionchange'));
    expect(selections).toEqual([[1, 1, 2, 8]]);
  });
});
