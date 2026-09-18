/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $computeTableMapSkipCellCheck,
  $createTableNodeWithDimensions,
  $createTableSelectionFrom,
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
  $isTableNode,
  $isTableSelection,
  TableExtension,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function deleteWholeTable(kind: 'row' | 'column'): {
  selectionType: string;
  staleTableSelection: boolean;
  rootChildren: number;
} {
  using editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [TableExtension],
      name: `delete-all-${kind}-host`,
      theme: {tableScrollableWrapper: ''},
    }),
  );

  editor.update(
    () => {
      const root = $getRoot().clear();
      root.append($createParagraphNode().append($createTextNode('before')));
      root.append($createTableNodeWithDimensions(2, 2, false));
      const table = root.getChildAtIndex(1);
      assert($isTableNode(table), 'expected a TableNode');
      const [map] = $computeTableMapSkipCellCheck(table, null, null);
      // Every cell selected, so deleting rows/columns empties the table.
      $setSelection(
        $createTableSelectionFrom(table, map[0][0].cell, map[1][1].cell),
      );
    },
    {discrete: true},
  );

  editor.update(
    () => {
      if (kind === 'row') {
        $deleteTableRowAtSelection();
      } else {
        $deleteTableColumnAtSelection();
      }
    },
    {discrete: true},
  );

  return editor.read(() => {
    const selection = $getSelection();
    return {
      rootChildren: $getRoot().getChildrenSize(),

      selectionType: $isRangeSelection(selection)
        ? 'range'
        : $isTableSelection(selection)
          ? 'table'
          : String(selection),
      // A TableSelection left behind by the removed table reports isValid()
      // false, because the cells it points at are gone.
      staleTableSelection: $isTableSelection(selection) && !selection.isValid(),
    };
  });
}

describe('deleting every row of a table', () => {
  test('leaves the selection outside the removed table', () => {
    expect(deleteWholeTable('row')).toEqual({
      rootChildren: 1,
      selectionType: 'range',
      staleTableSelection: false,
    });
  });

  test('matches what deleting every column already does', () => {
    expect(deleteWholeTable('column')).toEqual({
      rootChildren: 1,
      selectionType: 'range',
      staleTableSelection: false,
    });
  });
});
