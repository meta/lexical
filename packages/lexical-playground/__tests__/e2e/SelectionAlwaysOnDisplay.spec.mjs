/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {selectAll, selectCharacters} from '../keyboardShortcuts/index.mjs';
import {
  evaluate,
  expect,
  focusEditor,
  initialize,
  locate,
  test,
} from '../utils/index.mjs';

/* eslint-disable sort-keys-fix/sort-keys-fix */
test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('SelectionAlwaysOnDisplay', () => {
  test.beforeEach(({isCollab, page}) =>
    initialize({isCollab, page, selectionAlwaysOnDisplay: true}),
  );
  test(`retain selection works`, async ({page}) => {
    // Fixed in #6873
    await focusEditor(page);
    await page.keyboard.type('Lexical');
    await selectAll(page);
    await locate(page, 'body').click();
    const {distance, widthDifference, heightDifference} = await evaluate(
      page,
      () => {
        function compareNodeAlignment(node1, node2, tolerance = 0) {
          const rect1 = node1.getBoundingClientRect();
          const rect2 = node2.getBoundingClientRect();
          const distance_ = Math.sqrt(
            Math.pow(rect1.left - rect2.left, 2) +
              Math.pow(rect1.top - rect2.top, 2),
          );
          const widthDifference_ = Math.abs(rect1.width - rect2.width);
          const heightDifference_ = Math.abs(rect1.height - rect2.height);
          return {
            distance: distance_,
            widthDifference: widthDifference_,
            heightDifference: heightDifference_,
          };
        }
        const editorSpan = document.querySelector(
          '[contenteditable="true"] span',
        );
        const fakeSelection = document.querySelector(
          '[style*="background: highlight"]',
        );
        return compareNodeAlignment(editorSpan, fakeSelection, 5);
      },
    );
    await expect(distance).toBeLessThanOrEqual(5);
    await expect(widthDifference).toBeLessThanOrEqual(5);
    await expect(heightDifference).toBeLessThanOrEqual(5);
  });

  test(`retain selection works with reverse selection`, async ({page}) => {
    // Fixed in #6873
    await focusEditor(page);
    await page.keyboard.type('Lexical');

    // Position cursor at the end, then create a reverse selection by selecting all text to the left
    await selectCharacters(page, 'left', 'Lexical'.length);

    // Click outside to lose focus
    await locate(page, 'body').click();

    const {distance, widthDifference, heightDifference} = await evaluate(
      page,
      () => {
        function compareNodeAlignment(node1, node2, tolerance = 0) {
          const rect1 = node1.getBoundingClientRect();
          const rect2 = node2.getBoundingClientRect();
          const distance_ = Math.sqrt(
            Math.pow(rect1.left - rect2.left, 2) +
              Math.pow(rect1.top - rect2.top, 2),
          );
          const widthDifference_ = Math.abs(rect1.width - rect2.width);
          const heightDifference_ = Math.abs(rect1.height - rect2.height);
          return {
            distance: distance_,
            widthDifference: widthDifference_,
            heightDifference: heightDifference_,
          };
        }
        const editorSpan = document.querySelector(
          '[contenteditable="true"] span',
        );
        const fakeSelection = document.querySelector(
          '[style*="background: highlight"]',
        );
        return compareNodeAlignment(editorSpan, fakeSelection, 5);
      },
    );
    await expect(distance).toBeLessThanOrEqual(5);
    await expect(widthDifference).toBeLessThanOrEqual(5);
    await expect(heightDifference).toBeLessThanOrEqual(5);
  });
});
/* eslint-enable sort-keys-fix/sort-keys-fix */
