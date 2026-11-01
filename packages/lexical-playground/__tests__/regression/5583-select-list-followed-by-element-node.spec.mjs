/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  click,
  dragMouse,
  focusEditor,
  initialize,
  mouseMoveToSelector,
  selectFromInsertDropdown,
  selectorBoundingBox,
  test,
  waitForSelector,
} from '../utils/index.mjs';

async function toggleBulletList(page) {
  await click(page, '.block-controls');
  await click(page, '.dropdown .icon.bullet-list');
}
test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('Regression test #5251', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test(`Element node in the middle of a bullet list and selecting doesn't crash`, async ({
    page,
  }) => {
    await focusEditor(page);

    page.on('console', msg => {
      if (msg.type() === 'error') {
        if (
          msg.text().includes('error #68') ||
          msg.text().includes('getNodesBetween: ancestor is null')
        ) {
          test.fail();
        }
      }
    });

    await toggleBulletList(page);
    await page.keyboard.type('one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await page.keyboard.press('Enter');
    await selectFromInsertDropdown(page, '.horizontal-rule');
    await waitForSelector(page, 'hr');
    await page.keyboard.type('three');
    await page.keyboard.press('Enter');
    await mouseMoveToSelector(page, 'li:has-text("one")');
    await page.mouse.down();
    await dragMouse(
      page,
      await selectorBoundingBox(page, 'li:has-text("one")'),
      await selectorBoundingBox(page, 'li:has-text("three")'),
      {positionEnd: 'end', positionStart: 'middle'},
    );
  });
});
