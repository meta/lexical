/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {expect} from '@playwright/test';

import {moveLeft, selectAll, toggleBold} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  focusEditor,
  getLocalDateValue,
  html,
  initialize,
  locate,
  selectFromInsertDropdown,
  test,
  waitForTypeaheadMenuOption,
} from '../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('DateTime', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('can insert a DateTime node via the Insert dropdown', async ({page}) => {
    await focusEditor(page);
    // Insert DateTime using the Insert dropdown
    await selectFromInsertDropdown(page, '.item .calendar');

    // The DateTime node will render as a span with a class and the date text (today's date at midnight)
    // We'll match the output using a regex for the date string (YYYY-MM-DD or locale string)
    // For robustness, just check that a span with the DateTime class exists
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="PlaygroundEditorTheme__dateTime"
            contenteditable="false"
            data-lexical-datetime="*"
            data-lexical-decorator="true">
            <div class="dateTimePill">*</div>
          </span>
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
      undefined,
      {ignoreClasses: true, ignoreInlineStyles: true},
      // Custom modification: replace the date text and data-lexical-datetime value with wildcards for matching
      actualHtml =>
        actualHtml
          .replace(/(<div[^>]*>)(.*?)(<\/div>)/, '$1*$3')
          .replace(
            /data-lexical-datetime="[^"]*"/,
            'data-lexical-datetime="*"',
          ),
    );
  });

  test('Datetime should be inserted into the link', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('Hello world');
    await selectAll(page);

    // link
    await click(page, '.link');
    await click(page, '.link-confirm');
    // Move caret to end of link
    await page.keyboard.press('ArrowRight');
    // Move care to 'Hello '
    await moveLeft(page, 5);
    // Insert DateTime using the Insert dropdown
    await selectFromInsertDropdown(page, '.item .calendar');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">Hello</span>
            <span
              class="PlaygroundEditorTheme__dateTime"
              contenteditable="false"
              data-lexical-datetime="*"
              data-lexical-decorator="true">
              <div class="dateTimePill">*</div>
            </span>
            <span data-lexical-text="true">world</span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: true, ignoreInlineStyles: true},
      // Custom modification: replace the date text and data-lexical-datetime value with wildcards for matching
      actualHtml =>
        actualHtml
          .replace(/(<div[^>]*>)(.*?)(<\/div>)/, '$1*$3')
          .replace(
            /data-lexical-datetime="[^"]*"/,
            'data-lexical-datetime="*"',
          ),
    );
  });

  test('Datetime should apply the current selection format', async ({page}) => {
    await focusEditor(page);
    await toggleBold(page);

    // Insert DateTime using the Insert dropdown
    await selectFromInsertDropdown(page, '.item .calendar');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="PlaygroundEditorTheme__dateTime"
            contenteditable="false"
            data-lexical-datetime="*"
            data-lexical-decorator="true">
            <div class="dateTimePill bold">*</div>
          </span>
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
      undefined,
      {ignoreClasses: true, ignoreInlineStyles: true},
      // Custom modification: replace the date text and data-lexical-datetime value with wildcards for matching
      actualHtml =>
        actualHtml
          .replace(/(<div[^>]*>)(.*?)(<\/div>)/, '$1*$3')
          .replace(
            /data-lexical-datetime="[^"]*"/,
            'data-lexical-datetime="*"',
          ),
    );
  });

  for (const [option, dayOffset] of [
    ['Date', 0],
    ['Today', 0],
    ['Tomorrow', 1],
    ['Yesterday', -1],
  ]) {
    test(`inserts an all-day date from the ${option} option`, async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type(`/${option.toLowerCase()}`);
      await waitForTypeaheadMenuOption(page, option);
      await page.keyboard.press('Enter');

      const expected = new Date();
      expected.setDate(expected.getDate() + dayOffset);
      await expect(locate(page, '[data-lexical-datetime]')).toHaveAttribute(
        'data-lexical-datetime',
        getLocalDateValue(expected),
      );
    });
  }

  test('keeps a day picked by click or keyboard all-day', async ({page}) => {
    await focusEditor(page);
    await selectFromInsertDropdown(page, '.item .calendar');
    const chip = locate(page, '[data-lexical-datetime]');
    const otherDay = locate(
      page,
      // Days outside the month keep data-day but have no button
      '.dateTimePicker [data-day]:has(button):not([aria-selected="true"])',
    );

    await click(page, '.dateTimePill');
    const clickedDay = await otherDay.first().getAttribute('data-day');
    await otherDay.first().locator('button').click();
    await expect(chip).toHaveAttribute('data-lexical-datetime', clickedDay);

    const enteredDay = await otherDay.last().getAttribute('data-day');
    await otherDay.last().locator('button').focus();
    await page.keyboard.press('Enter');
    await expect(chip).toHaveAttribute('data-lexical-datetime', enteredDay);
  });
});
