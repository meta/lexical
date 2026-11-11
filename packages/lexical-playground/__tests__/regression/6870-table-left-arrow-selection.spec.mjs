/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {moveToEditorEnd} from '../keyboardShortcuts/index.mjs';
import {
  assertSelection,
  focusEditor,
  initialize,
  insertSampleImage,
  insertTable,
  IS_TABLE_HORIZONTAL_SCROLL,
  test,
} from '../utils/index.mjs';

const WRAPPER = IS_TABLE_HORIZONTAL_SCROLL ? [0, 0] : [];

test.skip(
  ({isCollab, isPlainText}) => isCollab || isPlainText,
  'Requires rich text without collaboration',
);

test.describe('Regression test #6870', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test('left arrow moves selection around decorators near tables', async ({
    page,
  }) => {
    await focusEditor(page);

    await insertTable(page, 2, 1);
    await moveToEditorEnd(page);
    await insertSampleImage(page);

    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [2],
      focusOffset: 1,
      focusPath: [2],
    });

    // First ArrowLeft moves inside the image
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2],
      focusOffset: 0,
      focusPath: [2],
    });

    await page.keyboard.press('ArrowLeft');

    // Moves into the last cell of the table
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [1, ...WRAPPER, 2, 0, 0],
      focusOffset: 0,
      focusPath: [1, ...WRAPPER, 2, 0, 0],
    });
  });
  test('left arrow expands selection around decorators near tables', async ({
    page,
  }) => {
    await focusEditor(page);

    await insertTable(page, 2, 1);
    await moveToEditorEnd(page);
    await insertSampleImage(page);

    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [2],
      focusOffset: 1,
      focusPath: [2],
    });

    await page.keyboard.down('Shift');
    // Only one press is needed here, it won't move into the node
    await page.keyboard.press('ArrowLeft');

    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [2],
      focusOffset: 0,
      focusPath: [2],
    });

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');

    // Include the whole table
    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [2],
      focusOffset: 1,
      focusPath: [],
    });
  });
});
