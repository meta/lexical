/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {moveLeft, selectAll, toggleBold} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  focusEditor,
  html,
  initialize,
  selectFromInsertDropdown,
  test,
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
});
