/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A table whose rows are ragged (collaborators' concurrent row and column
// inserts, which each author pads) and an update that changes only the
// table itself: the short row is left to its author.

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $isTableNode,
  $isTableRowNode,
  TableExtension,
} from '@lexical/table';
import {
  $createParagraphNode,
  $getRoot,
  configExtension,
  defineExtension,
} from 'lexical';
import {assert, expect, test} from 'vitest';

const $widths = () => {
  const table = $getRoot().getFirstChild();
  assert($isTableNode(table));
  return table
    .getChildren()
    .filter($isTableRowNode)
    .map(row => row.getChildrenSize());
};

test('a table-only field change leaves pre-existing short rows alone', () => {
  using editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        configExtension(TableExtension, {hasHorizontalScroll: false}),
      ],
      name: 'review-9539-table-field',
      onError: error => {
        throw error;
      },
    }),
  );
  editor.update(
    () => {
      const table = $createTableNode();
      for (const width of [3, 2, 3]) {
        const row = $createTableRowNode();
        for (let i = 0; i < width; i++) {
          row.append($createTableCellNode().append($createParagraphNode()));
        }
        table.append(row);
      }
      $getRoot().append(table);
    },
    {discrete: true, skipTransforms: true},
  );
  expect(editor.read($widths)).toEqual([3, 2, 3]);
  editor.update(
    () => {
      const table = $getRoot().getFirstChild();
      assert($isTableNode(table));
      table.setRowStriping(true);
    },
    {discrete: true},
  );
  expect(editor.read($widths)).toEqual([3, 2, 3]);
});
