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
  $isTextNode,
  FORMAT_TEXT_COMMAND,
  getDOMSelection,
  isDOMTextNode,
  registerEventListener,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';

// An update made during a keydown sent to the editor reads the DOM selection,
// because the browser may not have reported a caret move yet. A shortcut
// handled outside the editor (a toolbar, a global hotkey) that updates the
// editor must act at the editor's selection instead, not at a DOM selection
// the browser left behind in the blurred root.
test.each<[string, KeyboardEventInit]>([
  ['Control+B', {ctrlKey: true, key: 'b'}],
  ['Meta+B', {key: 'b', metaKey: true}],
  ['Enter', {key: 'Enter'}],
  ['ArrowDown', {key: 'ArrowDown'}],
])('%s pressed outside the editor acts at its selection', (_name, init) => {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  const button = document.createElement('button');
  document.body.append(root, button);
  const editor = buildEditorFromExtensions({
    dependencies: [RichTextExtension],
    name: '[keydown-outside-editor]',
  });
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
    button.remove();
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
  button.focus();
  // jsdom moves the selection to the focused button; browsers leave it in the
  // contenteditable, which is what this restores.
  domSelection.setBaseAndExtent(textDOM, 0, textDOM, 1);
  editor.update(
    () => {
      const text = $getRoot().getFirstDescendant();
      assert($isTextNode(text), 'Expected a TextNode');
      text.select(2, 3);
    },
    {discrete: true, tag: SKIP_DOM_SELECTION_TAG},
  );
  onTestFinished(
    registerEventListener(document, 'keydown', event => {
      event.preventDefault();
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
    }),
  );
  button.dispatchEvent(
    new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init}),
  );
  expect(
    editor.read('pending', () =>
      $getRoot()
        .getAllTextNodes()
        .map(node => [node.getTextContent(), node.hasFormat('bold')]),
    ),
  ).toEqual([
    ['ab', false],
    ['c', true],
  ]);
});
