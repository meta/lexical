/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {PlainTextExtension} from '@lexical/plain-text';
import {DRAG_DROP_PASTE, RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';

import {DragDropPasteExtension} from '../../../../lexical-playground/src/plugins/DragDropPasteExtension';

vi.mock('lexical/src/environment', async importOriginal => ({
  ...(await importOriginal<typeof import('lexical/src/environment')>()),
  IS_IOS: true,
}));

function mountEditor(plainText = false, withPlayground = false) {
  const rootElement = document.createElement('div');
  rootElement.contentEditable = 'true';
  document.body.append(rootElement);
  const editor = buildEditorFromExtensions({
    $initialEditorState: () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('before after')),
      );
    },
    dependencies: [
      plainText ? PlainTextExtension : RichTextExtension,
      ...(withPlayground ? [DragDropPasteExtension] : []),
    ],
    name: '[ios-text-drop]',
  });
  editor.setRootElement(rootElement);
  editor.update(() => $getRoot().selectEnd(), {discrete: true});
  const onFiles = vi.fn(() => false);
  editor.registerCommand(DRAG_DROP_PASTE, onFiles, COMMAND_PRIORITY_LOW);
  onTestFinished(() => {
    editor.dispose();
    rootElement.remove();
  });
  return {editor, onFiles, rootElement};
}

function createDrop(files: File[], position: MouseEventInit = {}): DragEvent {
  const dataTransfer = new DataTransfer();
  for (const file of files) {
    dataTransfer.items.add(file);
  }
  return new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    dataTransfer,
    ...position,
  });
}

describe.each([false, true])('iOS text drops (plain text: %s)', plainText => {
  test.each(['😀', '👍🏽', '👩🏽‍💻'])(
    'inserts an unhandled %s text file at the native drop caret',
    emoji => {
      const {editor, onFiles, rootElement} = mountEditor(plainText);
      const textDOM = rootElement.querySelector('span')!.firstChild!;
      const offset = 7;
      const range = document.createRange();
      range.setStart(textDOM, offset);
      range.collapse(true);
      const rect = range.getBoundingClientRect();

      // Native iOS text drags can expose only a file to the drop listener.
      // WebKit resolves the text for the subsequent insertFromDrop event.
      const drop = createDrop(
        [new File([emoji], 'emoji.txt', {type: 'text/plain'})],
        {clientX: Math.round(rect.x), clientY: rect.y + rect.height / 2},
      );
      expect(drop.dataTransfer!.types).toEqual(['Files']);
      expect(drop.dataTransfer!.getData('text/plain')).toBe('');
      rootElement.dispatchEvent(drop);
      expect(drop.defaultPrevented).toBe(false);
      expect(onFiles).toHaveBeenCalledTimes(plainText ? 0 : 1);

      // Synthetic drop events do not run the native default action. Model
      // WebKit moving its caret and dispatching beforeinput at the drop point,
      // away from the editor's original selection at the end of the text.
      document.getSelection()!.collapse(textDOM, offset);
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', emoji);
      const beforeInput = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertFromDrop',
        targetRanges: [
          new StaticRange({
            endContainer: textDOM,
            endOffset: offset,
            startContainer: textDOM,
            startOffset: offset,
          }),
        ],
      });
      // WebKit does not initialize dataTransfer on synthetic InputEvents.
      Object.defineProperty(beforeInput, 'dataTransfer', {value: dataTransfer});
      rootElement.dispatchEvent(beforeInput);

      expect(beforeInput.defaultPrevented).toBe(true);
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe(`before ${emoji}after`);
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(selection.isCollapsed()).toBe(true);
        expect(selection.anchor.offset).toBe(offset + emoji.length);
      });
      expect(rootElement.textContent).toBe(`before ${emoji}after`);
      expect(onFiles).toHaveBeenCalledTimes(plainText ? 0 : 1);
    },
  );
});

test('lets an application handle text files on iOS', () => {
  const {editor, onFiles, rootElement} = mountEditor();
  onFiles.mockReturnValue(true);
  const files = [new File(['😀'], 'emoji.txt', {type: 'text/plain'})];
  const drop = createDrop(files);
  rootElement.dispatchEvent(drop);
  expect(drop.defaultPrevented).toBe(true);
  expect(onFiles).toHaveBeenCalledExactlyOnceWith(files, editor);
});

test('the playground image handler leaves iOS text drops to the browser', () => {
  const {rootElement} = mountEditor(false, true);
  const drop = createDrop([
    new File(['😀'], 'emoji.txt', {type: 'text/plain'}),
  ]);
  rootElement.dispatchEvent(drop);
  expect(drop.defaultPrevented).toBe(false);
});

test.each([
  {types: ['image/png']},
  {types: ['text/rtf']},
  {types: ['text/plain', 'image/png']},
])('preserves file handling for $types on iOS', ({types}) => {
  const {editor, onFiles, rootElement} = mountEditor();
  const files = types.map(type => new File(['content'], 'file', {type}));
  const drop = createDrop(files);
  rootElement.dispatchEvent(drop);
  expect(drop.defaultPrevented).toBe(true);
  expect(onFiles).toHaveBeenCalledExactlyOnceWith(files, editor);
});
