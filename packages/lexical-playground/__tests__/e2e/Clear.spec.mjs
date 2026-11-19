/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  assertHTML,
  click,
  focusEditor,
  html,
  initialize,
  test,
} from '../utils/index.mjs';

test.describe('Clear', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test(`can clear the editor`, async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('foo');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">foo</span>
        </p>
      `,
    );

    await click(page, '.action-button.clear');

    await click(page, 'button:has-text("Cancel")');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">foo</span>
        </p>
      `,
    );

    await click(page, '.action-button.clear');

    await click(page, 'button:has-text("Clear")');
    // Wait for the clear command to commit before typing again.
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await page.keyboard.type('bar');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">bar</span>
        </p>
      `,
    );
  });
});
