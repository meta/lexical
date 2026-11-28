/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$createHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {
  $computeTableMapSkipCellCheck,
  $createTableNodeWithDimensions,
  $isTableNode,
  TableExtension,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $selectAll,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  CUT_COMMAND,
  CUT_TAG,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, onTestFinished, test, vi} from 'vitest';

const TableTestThemeExtension = defineExtension({
  dependencies: [TableExtension],
  name: 'CutOutsideTableTestThemeExtension',
  theme: {tableScrollableWrapper: ''},
});

function setup() {
  const editor = buildEditorFromExtensions(TableTestThemeExtension);
  onTestFinished(() => editor[Symbol.dispose]());
  const root = document.createElement('div');
  document.body.append(root);
  onTestFinished(() => root.remove());
  editor.setRootElement(root);
  let lowPriorityCuts = 0;
  editor.registerCommand(
    CUT_COMMAND,
    () => {
      lowPriorityCuts++;
      return false;
    },
    COMMAND_PRIORITY_LOW,
  );
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append($createTextNode('before')),
          $createTableNodeWithDimensions(1, 2, false),
          $createParagraphNode().append($createTextNode('x y')),
        );
    },
    {discrete: true},
  );
  return {editor, getLowPriorityCuts: () => lowPriorityCuts};
}

function cut(editor: LexicalEditor, select: () => void) {
  editor.update(select, {discrete: true});
  editor.dispatchCommand(CUT_COMMAND, new ClipboardEvent('cut'));
}

describe('CUT_COMMAND in a document that holds a table', () => {
  test('a range outside the table is left to the listeners below the table', () => {
    const {editor, getLowPriorityCuts} = setup();
    cut(editor, () => {
      const last = $assertNodeType($getRoot().getLastChild(), $isElementNode);
      const text = last.getFirstChildOrThrow();
      const selection = $createRangeSelection();
      selection.anchor.set(text.getKey(), 0, 'text');
      selection.focus.set(text.getKey(), 1, 'text');
      $setSelection(selection);
    });
    expect(getLowPriorityCuts()).toBe(1);
  });

  test('a range in a cell is answered by the table', () => {
    const {editor, getLowPriorityCuts} = setup();
    cut(editor, () => {
      const table = $assertNodeType(
        $getRoot().getChildAtIndex(1),
        $isTableNode,
      );
      const [map] = $computeTableMapSkipCellCheck(table, null, null);
      const paragraph = $assertNodeType(
        map[0][0].cell.getFirstChild(),
        $isElementNode,
      );
      paragraph.append($createTextNode('abc'));
      const text = paragraph.getFirstChildOrThrow();
      const selection = $createRangeSelection();
      selection.anchor.set(text.getKey(), 0, 'text');
      selection.focus.set(text.getKey(), 2, 'text');
      $setSelection(selection);
    });
    expect(getLowPriorityCuts()).toBe(0);
  });
});

describe('CUT_COMMAND with rich text in a document that holds tables', () => {
  function setupRichText() {
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RichTextExtension, TableTestThemeExtension],
        name: 'CutOutsideTableRichText',
      }),
    );
    onTestFinished(() => editor[Symbol.dispose]());
    const root = document.createElement('div');
    document.body.append(root);
    onTestFinished(() => root.remove());
    editor.setRootElement(root);
    const tags: ReadonlySet<string>[] = [];
    editor.registerUpdateListener(({tags: updateTags}) => {
      tags.push(updateTags);
    });
    return {editor, tags};
  }

  const rootTypes = (editor: LexicalEditor) =>
    editor.read(() =>
      $getRoot()
        .getChildren()
        .map(node => node.getType()),
    );

  test('a whole-document cut leaves one paragraph, in updates tagged CUT_TAG', async () => {
    const {editor, tags} = setupRichText();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createHeadingNode('h1').append($createTextNode('Title')),
            $createTableNodeWithDimensions(1, 2, false),
            $createParagraphNode().append($createTextNode('x y')),
          );
        $selectAll();
      },
      {discrete: true},
    );
    editor.dispatchCommand(CUT_COMMAND, new ClipboardEvent('cut'));
    await vi.waitFor(() => expect(rootTypes(editor)).toEqual(['paragraph']));
    expect(tags.some(updateTags => updateTags.has(CUT_TAG))).toBe(true);
  });

  test('the table a range ends in cuts it whole when the document holds another table', async () => {
    const {editor} = setupRichText();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createTableNodeWithDimensions(1, 1, false),
            $createTableNodeWithDimensions(2, 2, false),
            $createParagraphNode().append($createTextNode('tail')),
          );
        const second = $assertNodeType(
          $getRoot().getChildAtIndex(1),
          $isTableNode,
        );
        const [map] = $computeTableMapSkipCellCheck(second, null, null);
        const paragraph = $assertNodeType(
          map[0][0].cell.getFirstChild(),
          $isElementNode,
        );
        paragraph.append($createTextNode('cell'));
        const tailParagraph = $assertNodeType(
          $getRoot().getLastChild(),
          $isElementNode,
        );
        const tail = tailParagraph.getFirstChildOrThrow();
        const selection = $createRangeSelection();
        selection.anchor.set(
          paragraph.getFirstChildOrThrow().getKey(),
          1,
          'text',
        );
        selection.focus.set(tail.getKey(), 2, 'text');
        $setSelection(selection);
      },
      {discrete: true},
    );
    editor.dispatchCommand(CUT_COMMAND, new ClipboardEvent('cut'));
    await vi.waitFor(() =>
      expect(rootTypes(editor)).toEqual(['table', 'paragraph']),
    );
  });
});
