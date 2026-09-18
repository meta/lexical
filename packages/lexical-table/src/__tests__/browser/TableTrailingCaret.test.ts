/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {$createTableNodeWithDimensions, TableExtension} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

// Regression tests for #7999.
//
// With a table as the last node of the document, the caret used to cycle
// around it: right arrow out of the last cell reached the block cursor
// beneath the table, the next right arrow jumped back to the root offset
// *before* the table (where Enter inserts a paragraph above it), and the one
// after that dropped back into the last cell.
//
// Nothing in the Lexical model moves on that second key press - the native
// caret walks around the block cursor element and the selectionchange
// listener imports the result - so this only reproduces in a real browser.
// See the `browser` project in vitest.config.mts.

function mount($initialEditorState: () => void): {
  editor: LexicalEditor;
  contentEditable: HTMLElement;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const contentEditable = document.createElement('div');
  contentEditable.contentEditable = 'true';
  container.appendChild(contentEditable);
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState,
      dependencies: [RichTextExtension, TableExtension],
      name: 'issue-7999',
      onError: (error: Error) => {
        throw error;
      },
    }),
  );
  editor.setRootElement(contentEditable);
  onTestFinished(() => {
    editor.setRootElement(null);
    document.body.removeChild(container);
  });
  contentEditable.focus();
  return {contentEditable, editor};
}

function expectCaretAfterTable(editor: LexicalEditor): void {
  editor.read(() => {
    const selection = $getSelection();
    assert($isRangeSelection(selection), 'Expected RangeSelection');
    expect(selection.isCollapsed()).toBe(true);
    expect(selection.anchor.type).toBe('element');
    expect(selection.anchor.key).toBe($getRoot().getKey());
    expect(selection.anchor.offset).toBe($getRoot().getChildrenSize());
  });
}

test('the caret stops beneath a trailing table instead of cycling around it', async () => {
  const {editor} = mount(() => {
    $getRoot()
      .clear()
      .append($createTableNodeWithDimensions(2, 2, false));
  });
  editor.update(() => $getRoot().getLastChildOrThrow().selectEnd(), {
    discrete: true,
  });

  // Leaves the last cell and lands on the block cursor beneath the table.
  await userEvent.keyboard('{ArrowRight}');
  expectCaretAfterTable(editor);

  // Further presses have nowhere to go and must leave the caret alone.
  await userEvent.keyboard('{ArrowRight}');
  expectCaretAfterTable(editor);
  await userEvent.keyboard('{ArrowRight}');
  expectCaretAfterTable(editor);

  // Enter at that caret adds the paragraph after the table, not before it.
  await userEvent.keyboard('{Enter}');
  expect(
    editor.read(() =>
      $getRoot()
        .getChildren()
        .map(node => node.getType()),
    ),
  ).toEqual(['table', 'paragraph']);
});

test('the caret still moves past a table that is followed by a paragraph', async () => {
  const {editor} = mount(() => {
    $getRoot()
      .clear()
      .append(
        $createTableNodeWithDimensions(2, 2, false),
        $createParagraphNode().append($createTextNode('after')),
      );
  });
  editor.update(() => $getRoot().getFirstChildOrThrow().selectEnd(), {
    discrete: true,
  });

  await userEvent.keyboard('{ArrowRight}');
  await userEvent.keyboard('{ArrowRight}');

  editor.read(() => {
    const selection = $getSelection();
    assert($isRangeSelection(selection), 'Expected RangeSelection');
    expect(selection.anchor.getNode().getTextContent()).toBe('after');
  });
});
