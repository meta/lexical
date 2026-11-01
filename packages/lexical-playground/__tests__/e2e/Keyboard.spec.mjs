/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  assertHTML,
  E2E_BROWSER,
  focusEditor,
  html,
  initialize,
  IS_MAC,
  test,
} from '../utils/index.mjs';

const supportsTranspose = IS_MAC && E2E_BROWSER !== 'firefox';

test.skip(!supportsTranspose, 'Requires native transpose support');

test.describe('Keyboard shortcuts', () => {
  test.beforeEach(
    ({isCollab, page}) => supportsTranspose && initialize({isCollab, page}),
  );

  test('handles "insertTranspose" event from Control+T on MAC', async ({
    page,
    context,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('abc');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.down('Control');
    await page.keyboard.press('T');
    await page.keyboard.press('T');
    await page.keyboard.up('Control');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">bca</span>
        </p>
      `,
    );
  });
});
