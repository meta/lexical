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
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  getDOMSelection,
  IS_APPLE,
  isDOMTextNode,
  KEY_DOWN_COMMAND,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

// A keydown whose handler acts at the caret must see the caret where the
// browser has it. The browser reports a selection change in a later task
// (Chromium also coalesces them), so after a native caret move on a busy main
// thread, the editor's selection can still be the old one when the next
// keydown arrives. On macOS, Control+H after a run of ArrowLeft deleted the
// character the caret had already moved past.

const SHORTCUT_MODIFIER = IS_APPLE ? 'metaKey' : 'ctrlKey';

function mount() {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions({
    dependencies: [RichTextExtension],
    name: '[keydown-dom-selection]',
  });
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  root.focus();
  editor.update(
    () => {
      const text = $createTextNode('abc');
      $getRoot().clear().append($createParagraphNode().append(text));
      text.select(0, 1);
    },
    {discrete: true},
  );
  const textDOM = root.querySelector('[data-lexical-text]')?.firstChild;
  assert(isDOMTextNode(textDOM), 'Expected the text node of "abc"');
  const domSelection = getDOMSelection(window);
  assert(domSelection !== null, 'Expected a DOM selection');
  /**
   * Select [start, end) of "abc" in the DOM and dispatch a keydown right
   * away, before the browser reports the selection change.
   */
  const keyDownAfterUnreportedSelect = (
    start: number,
    end: number,
    init: KeyboardEventInit,
  ) => {
    domSelection.setBaseAndExtent(textDOM, start, textDOM, end);
    expect(readSelectionOffsets()).toEqual([0, 1]);
    root.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init}),
    );
  };
  const readSelectionOffsets = () =>
    editor.read('latest', () => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected a RangeSelection');
      return [selection.anchor.offset, selection.focus.offset];
    });
  return {editor, keyDownAfterUnreportedSelect, root};
}

test.each<KeyboardEventInit>([
  {key: ' '},
  {key: 'End'},
  {key: 'Home'},
  {ctrlKey: true, key: 'h'},
  {key: 'k', metaKey: true},
  {[SHORTCUT_MODIFIER]: true, key: 'z'},
])('a %o keydown sees a caret move not yet reported', init => {
  const {editor, keyDownAfterUnreportedSelect} = mount();
  const seen: number[][] = [];
  onTestFinished(
    editor.registerCommand(
      KEY_DOWN_COMMAND,
      event => {
        // Only record: the browser must not act on the synthetic event.
        event.preventDefault();
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected a RangeSelection');
        seen.push([selection.anchor.offset, selection.focus.offset]);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
  );
  keyDownAfterUnreportedSelect(2, 2, init);
  expect(seen).toEqual([[2, 2]]);
});

test('a format shortcut formats the selection the browser has', () => {
  const {editor, keyDownAfterUnreportedSelect} = mount();
  keyDownAfterUnreportedSelect(1, 3, {[SHORTCUT_MODIFIER]: true, key: 'b'});
  expect(
    editor.read('force-commit', () =>
      $getRoot()
        .getAllTextNodes()
        .map(node => [node.getTextContent(), node.hasFormat('bold')]),
    ),
  ).toEqual([
    ['a', false],
    ['bc', true],
  ]);
});

test('format shortcuts at a caret still combine for the next text typed', async () => {
  const {editor, root} = mount();
  editor.update(() => $getRoot().selectEnd(), {discrete: true});
  const modifier = IS_APPLE ? 'Meta' : 'Control';
  await userEvent.keyboard(
    `{${modifier}>}b{/${modifier}}{${modifier}>}i{/${modifier}}x`,
  );
  await expect
    .poll(() =>
      editor.read('latest', () =>
        $getRoot()
          .getAllTextNodes()
          .map(node => [
            node.getTextContent(),
            node.hasFormat('bold'),
            node.hasFormat('italic'),
          ]),
      ),
    )
    .toEqual([
      ['abc', false, false],
      ['x', true, true],
    ]);
  expect(root.textContent).toBe('abcx');
});
