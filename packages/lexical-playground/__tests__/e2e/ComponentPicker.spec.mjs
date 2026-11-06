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
  waitForSelector,
} from '../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('ComponentPicker', () => {
  test('Can insert a heading using the component picker slash command', async ({
    page,
    isCollab,
  }) => {
    await initialize({isCollab, page});
    await focusEditor(page);

    // Type slash to trigger the component picker
    await page.keyboard.type('/');

    // Wait for the typeahead popover to appear
    await waitForSelector(page, '.typeahead-popover');

    // Type to filter for heading
    await page.keyboard.type('heading');

    // Click on the heading option (h1)
    await click(page, '.typeahead-popover .icon.h1');

    // Type some text in the heading
    await page.keyboard.type('My Heading');

    await assertHTML(
      page,
      html`
        <h1 class="PlaygroundEditorTheme__h1" dir="auto">
          <span data-lexical-text="true">My Heading</span>
        </h1>
      `,
    );
  });

  test('Can insert a 2x2 table using the component picker slash command', async ({
    page,
    isCollab,
  }) => {
    await initialize({isCollab, page});
    await focusEditor(page);

    // Type slash to trigger the component picker
    await page.keyboard.type('/');

    // Wait for the typeahead popover to appear
    await waitForSelector(page, '.typeahead-popover');

    // Type to filter for table
    await page.keyboard.type('2x2');

    // Click on the table option
    await click(page, '.typeahead-popover .icon.table');

    // Verify the table was inserted
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <div dir="auto">
          <div class="PlaygroundEditorTheme__tableScrollableWrapper">
            <table class="PlaygroundEditorTheme__table">
              <colgroup>
                <col style="width: 92px" />
                <col style="width: 92px" />
              </colgroup>
              <tr dir="auto">
                <th
                  class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
                  dir="auto">
                  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                    <br data-lexical-managed-linebreak="true" />
                  </p>
                </th>
                <th
                  class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
                  dir="auto">
                  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                    <br data-lexical-managed-linebreak="true" />
                  </p>
                </th>
              </tr>
              <tr dir="auto">
                <th
                  class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
                  dir="auto">
                  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                    <br data-lexical-managed-linebreak="true" />
                  </p>
                </th>
                <td class="PlaygroundEditorTheme__tableCell" dir="auto">
                  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                    <br data-lexical-managed-linebreak="true" />
                  </p>
                </td>
              </tr>
            </table>
          </div>
        </div>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });
});
