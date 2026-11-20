/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
} from '@lexical/mdast';
import {
  $createRangeSelection,
  $getRoot,
  $setSelection,
  defineExtension,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

import {MdastEditorExtension} from '../../extensions/MdastEditorExtension';
import {applyTableAction} from '../../plugins/tableActions';

function $selectText(text: string, offset = 0) {
  $getRoot()
    .getAllTextNodes()
    .find(node => node.getTextContent() === text)!
    .select(offset, offset);
}

function mountEditor(markdown: string) {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [MdastEditorExtension],
      name: '[root]',
      theme: {tableScrollableWrapper: 'table-wrapper'},
    }),
  );
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  editor.update(() => $convertFromMarkdownString(markdown), {discrete: true});
  return editor;
}

test.each(['{Enter}', '{Shift>}{Enter}{/Shift}'])(
  '%s in a table cell writes a <br> line break',
  async keys => {
    const editor = mountEditor('| a | b |\n| - | - |\n| 1 | 2 |');
    // editor.focus() only sets the DOM selection, which focuses the root in
    // Chromium but not in Firefox, where the typed keys were then dropped.
    window.focus();
    editor.getRootElement()!.focus();
    editor.update(() => $selectText('1', 1), {discrete: true});
    await userEvent.keyboard(`${keys}x`);
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      '| a      | b |\n| ------ | - |\n| 1<br>x | 2 |',
    );
  },
);

test('Table > Align center in a header cell aligns the column', () => {
  const editor = mountEditor('| a | b |\n| - | - |\n| 1 | 2 |');
  editor.update(() => $selectText('a'), {discrete: true});
  applyTableAction(editor, 'center');
  expect(editor.read(() => $convertToMarkdownString())).toBe(
    '|  a  | b |\n| :-: | - |\n|  1  | 2 |',
  );
});

test('Table menu actions need a selection within one table', () => {
  const markdown = '| a |\n| - |\n| 1 |\n\n| b |\n| - |\n| 2 |';
  const editor = mountEditor(markdown);
  editor.update(
    () => {
      const selection = $createRangeSelection();
      const texts = $getRoot().getAllTextNodes();
      const a = texts.find(node => node.getTextContent() === 'a')!;
      const b = texts.find(node => node.getTextContent() === 'b')!;
      selection.anchor.set(a.getKey(), 0, 'text');
      selection.focus.set(b.getKey(), 1, 'text');
      $setSelection(selection);
    },
    {discrete: true},
  );
  applyTableAction(editor, 'center');
  applyTableAction(editor, 'rowBelow');
  expect(editor.read(() => $convertToMarkdownString())).toBe(markdown);
});
