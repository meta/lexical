/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveToLineEnd,
  selectAll,
  selectCharacters,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  focusEditor,
  html,
  initialize,
  test,
} from '../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('Regression test #1083', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test(`Backspace with ElementNode at the front of the paragraph`, async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Hello');
    await selectAll(page);
    await click(page, '.link');
    await click(page, '.link-confirm');

    await moveToLineEnd(page);
    await page.keyboard.type('World');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">Hello</span>
          </a>
          <span data-lexical-text="true">World</span>
        </p>
      `,
    );

    await selectAll(page);
    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test(`Backspace with ElementNode at the front of the selection`, async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Say');

    await page.keyboard.type('Hello');
    await selectCharacters(page, 'left', 'Hello'.length);
    await click(page, '.link');
    await click(page, '.link-confirm');

    await moveToLineEnd(page);
    await page.keyboard.type('World');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Say</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">Hello</span>
          </a>
          <span data-lexical-text="true">World</span>
        </p>
      `,
    );

    await selectCharacters(page, 'left', 'HelloWorld'.length);
    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Say</span>
        </p>
      `,
    );
  });
});
