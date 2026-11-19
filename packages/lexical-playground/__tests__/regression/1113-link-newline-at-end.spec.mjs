/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  assertHTML,
  assertSelection,
  focusEditor,
  html,
  initialize,
  test,
} from '../utils/index.mjs';

test.skip(({isRichText}) => isRichText, 'Requires plain text');

test.describe('Regression test #1113', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test(`Selects new line when inserting a new line at the end of a link`, async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('https://www.example.com');
    await page.keyboard.press('Enter');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a class="PlaygroundEditorTheme__link" href="https://www.example.com">
            <span data-lexical-text="true">https://www.example.com</span>
          </a>
          <br />
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 2,
      anchorPath: [0],
      focusOffset: 2,
      focusPath: [0],
    });
  });
});
