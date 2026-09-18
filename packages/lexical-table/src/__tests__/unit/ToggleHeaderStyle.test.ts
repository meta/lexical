/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createTableCellNode,
  type TableCellHeaderState,
  TableCellHeaderStates,
  TableExtension,
} from '@lexical/table';
import {defineExtension} from 'lexical';
import {describe, expect, test} from 'vitest';

const {BOTH, COLUMN, NO_STATUS, ROW} = TableCellHeaderStates;

function toggle(
  from: TableCellHeaderState,
  toToggle: TableCellHeaderState,
): TableCellHeaderState {
  using editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [TableExtension],
      name: 'toggle-host',
      theme: {tableScrollableWrapper: 'table-scrollable-wrapper'},
    }),
  );
  let result: TableCellHeaderState = NO_STATUS;
  editor.update(
    () => {
      const cell = $createTableCellNode(from);
      result = cell.toggleHeaderStyle(toToggle).getHeaderStyles();
    },
    {discrete: true},
  );
  return result;
}

describe('TableCellNode.toggleHeaderStyle', () => {
  test('stays inside the enum when toggling BOTH', () => {
    // Toggling a state the cell does not already have in full adds it; a cell
    // that has all of it loses it.
    expect(toggle(ROW, BOTH)).toBe(BOTH);
    expect(toggle(COLUMN, BOTH)).toBe(BOTH);
    expect(toggle(NO_STATUS, BOTH)).toBe(BOTH);
    expect(toggle(BOTH, BOTH)).toBe(NO_STATUS);
  });

  test('single-bit toggles are unchanged', () => {
    expect(toggle(NO_STATUS, ROW)).toBe(ROW);
    expect(toggle(ROW, ROW)).toBe(NO_STATUS);
    expect(toggle(COLUMN, ROW)).toBe(BOTH);
    expect(toggle(BOTH, ROW)).toBe(COLUMN);
    expect(toggle(NO_STATUS, COLUMN)).toBe(COLUMN);
    expect(toggle(COLUMN, COLUMN)).toBe(NO_STATUS);
    expect(toggle(ROW, COLUMN)).toBe(BOTH);
    expect(toggle(BOTH, COLUMN)).toBe(ROW);
  });
});
