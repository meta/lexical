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
  $isTableSelection,
  $mergeCells,
  TableExtension,
} from '@lexical/table';
import {
  $getRoot,
  $getSelection,
  $setSelection,
  defineExtension,
  KEY_ARROW_DOWN_COMMAND,
  type LexicalEditorWithDispose,
} from 'lexical';
import {afterEach, assert, beforeEach, describe, expect, test} from 'vitest';

let container: HTMLDivElement;
let editor: LexicalEditorWithDispose;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [TableExtension],
      name: 'shift-arrow-corner-host',
      theme: {tableScrollableWrapper: ''},
    }),
  );
  // The arrow key handlers come from the table selection observer, which needs
  // the editor to have a root element.
  editor.setRootElement(container);
});

afterEach(() => {
  editor.dispose();
  document.body.removeChild(container);
});

function $table() {
  const table = $getRoot().getFirstChild();
  assert($isTableNode(table), 'expected a TableNode at the root');
  return table;
}

/**
 * The current TableSelection, described by the grid coordinates its anchor and
 * focus cells start at plus how many cells it covers, so an assertion names the
 * rect rather than only that nothing threw.
 */
function $selectionRect() {
  const selection = $getSelection();
  assert($isTableSelection(selection), 'expected a TableSelection');
  const [map] = $computeTableMapSkipCellCheck($table(), null, null);
  const startOf = (key: string) => {
    for (const row of map) {
      for (const {cell, startRow, startColumn} of row) {
        if (cell.getKey() === key) {
          return `${startRow},${startColumn}`;
        }
      }
    }
    return `${key} is not in the table`;
  };
  return {
    anchor: startOf(selection.anchor.key),
    cellCount: selection.getNodes().filter($isTableCellNode).length,
    focus: startOf(selection.focus.key),
    isValid: selection.isValid(),
  };
}

describe('Shift+Arrow with an anchor that is not on a rect corner', () => {
  test('extends the selection instead of throwing', () => {
    editor.update(
      () => {
        const table = $createTableNodeWithDimensions(3, 3, false);
        $getRoot().clear().append(table);
        const [map] = $computeTableMapSkipCellCheck(table, null, null);
        // Merge grid columns 0 and 1 of row 1. This cell straddles the left
        // edge of the rect selected below, so $computeTableCellRectBoundary
        // grows the rect out to column 0 — past the anchor, which then sits on
        // no corner of it.
        const merged = $mergeCells([map[1][0].cell, map[1][1].cell]);
        assert(merged !== null, 'expected the cells to merge');
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const table = $table();
        const [map] = $computeTableMapSkipCellCheck(table, null, null);
        // Anchor at (row 0, column 1), focus at (row 1, column 2).
        $setSelection(
          $createTableSelectionFrom(table, map[0][1].cell, map[1][2].cell),
        );
      },
      {discrete: true},
    );

    expect(() =>
      editor.update(
        () => {
          editor.dispatchCommand(
            KEY_ARROW_DOWN_COMMAND,
            new KeyboardEvent('keydown', {key: 'ArrowDown', shiftKey: true}),
          );
        },
        {discrete: true},
      ),
    ).not.toThrow();

    editor.read('latest', () => {
      // The anchor was not on a corner, so getAnchorCorner falls back to the
      // corner opposite the focus — top-left — and ArrowDown grows the rect
      // down to the last row. The merged cell keeps the rect out at column 0,
      // so the result is the whole table: 9 grid positions, 8 distinct cells.
      expect($selectionRect()).toEqual({
        anchor: '0,0',
        cellCount: 8,
        focus: '2,2',
        isValid: true,
      });
    });
  });
});
