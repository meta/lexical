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
  $isTableCellNode,
  $isTableNode,
  $mergeCells,
  TableExtension,
} from '@lexical/table';
import {
  $getRoot,
  $getSelection,
  $setSelection,
  defineExtension,
  FORMAT_ELEMENT_COMMAND,
  type InitialEditorStateType,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test} from 'vitest';

function buildTestEditor($initialEditorState?: InitialEditorStateType) {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState,
      afterRegistration(editor, config, state) {
        // The FORMAT_ELEMENT_COMMAND handler is registered by the table selection
        // observer, which needs the editor to have a root element.
        const container = document.createElement('div');
        document.body.appendChild(container);
        editor.setRootElement(container);
        return () => document.body.removeChild(container);
      },
      dependencies: [TableExtension],
      name: 'format-element-rect-host',
    }),
  );
}

describe('FORMAT_ELEMENT_COMMAND over a table selection', () => {
  test('formats every cell the selection contains, including one pulled in by a merge', () => {
    using editor = buildTestEditor(() => {
      const table = $createTableNodeWithDimensions(3, 3, false);
      $getRoot().append(table);
      const [map] = $computeTableMapSkipCellCheck(table, null, null);
      // Merge grid columns 0 and 1 of row 1. The merged cell straddles the
      // left edge of the rect the next selection describes, so the rect has
      // to grow to column 0 to contain it.
      const merged = $mergeCells([map[1][0].cell, map[1][1].cell]);
      assert(merged !== null, 'expected the cells to merge');
    });

    editor.update(
      () => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        const [map] = $computeTableMapSkipCellCheck(table, null, null);
        // Anchor at (row 0, column 1), focus at (row 1, column 2).
        $setSelection(
          $createTableSelectionFrom(table, map[0][1].cell, map[1][2].cell),
        );
      },
      {discrete: true},
    );

    editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center');

    editor.read('force-commit', () => {
      const selection = $getSelection();
      assert(selection !== null, 'expected a selection');
      const selectedCells = selection.getNodes().filter($isTableCellNode);
      expect(selectedCells.length).toBeGreaterThan(0);
      expect(selectedCells.map(cell => cell.getFormatType())).toEqual(
        selectedCells.map(() => 'center'),
      );
    });
  });
});
