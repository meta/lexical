/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {RichTextExtension} from '@lexical/rich-text';
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {expect, onTestFinished, test, vi} from 'vitest';

import {
  FIND_NEXT_COMMAND,
  FindReplaceExtension,
  REPLACE_CURRENT_COMMAND,
  SET_REPLACE_TERM_COMMAND,
  SET_SEARCH_TERM_COMMAND,
  TOGGLE_FIND_REPLACE_COMMAND,
} from '../../plugins/FindReplaceExtension';
import {press, setupEditor, typeText} from './utils';

function setupSearch() {
  const {editor} = setupEditor([RichTextExtension, FindReplaceExtension]);
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append($createTextNode('needle one')),
          $createParagraphNode().append($createTextNode('needle two')),
          $createParagraphNode().append($createTextNode('end')),
        )
        .selectEnd();
    },
    {discrete: true},
  );
  editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
  editor.dispatchCommand(SET_SEARCH_TERM_COMMAND, 'needle');
  const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
  onTestFinished(() => scrollIntoView.mockRestore());
  const scrolledTo = () =>
    scrollIntoView.mock.contexts.map(
      element => (element as Element).textContent,
    );
  return {editor, scrolledTo};
}

test('typing with the find panel open keeps the scroll position', async () => {
  const {scrolledTo} = setupSearch();

  await typeText('x');
  await press('Enter');

  expect(scrolledTo()).toEqual([]);
});

test('a new search scrolls to its first match', () => {
  const {editor, scrolledTo} = setupSearch();

  editor.dispatchCommand(SET_SEARCH_TERM_COMMAND, 'two');

  expect(scrolledTo()).toEqual(['needle two']);
});

test('reopening the find panel scrolls to the current match', () => {
  const {editor, scrolledTo} = setupSearch();

  editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);
  editor.dispatchCommand(TOGGLE_FIND_REPLACE_COMMAND);

  expect(scrolledTo()).toEqual(['needle one']);
});

test('finding the next match scrolls it into view', () => {
  const {editor, scrolledTo} = setupSearch();

  editor.dispatchCommand(FIND_NEXT_COMMAND);

  expect(scrolledTo()).toEqual(['needle two']);
});

test('replacing the current match scrolls the next one into view', () => {
  const {editor, scrolledTo} = setupSearch();

  editor.dispatchCommand(SET_REPLACE_TERM_COMMAND, 'pin');
  editor.dispatchCommand(REPLACE_CURRENT_COMMAND);

  expect(scrolledTo()).toEqual(['needle two']);
});
