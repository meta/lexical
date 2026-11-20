/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  assertTableSelectionCoordinates,
  click,
  focusEditor,
  initialize,
  insertTable,
  mergeTableCells,
  selectCellsFromTableCords,
  test,
} from '../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('Regression test #4872', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test('merging two full rows does not break table selection', async ({
    page,
  }) => {
    await focusEditor(page);

    await insertTable(page, 5, 5);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 1},
      {x: 4, y: 2},
      true,
      false,
    );

    await mergeTableCells(page);

    await selectCellsFromTableCords(
      page,
      {x: 1, y: 4},
      {x: 2, y: 4},
      false,
      false,
    );

    await assertTableSelectionCoordinates(page, {
      anchor: {x: 1, y: 4},
      focus: {x: 2, y: 4},
    });
  });
});
