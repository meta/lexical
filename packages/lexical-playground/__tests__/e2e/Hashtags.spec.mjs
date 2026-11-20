/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {moveLeft, toggleBold} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  click,
  expect,
  focusEditor,
  getPageOrFrame,
  html,
  initialize,
  pasteFromClipboard,
  test,
  waitForSelector,
} from '../utils/index.mjs';

test.describe('Hashtags', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test(`Can handle a single hashtag`, async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('#yolo');

    await waitForSelector(page, '.PlaygroundEditorTheme__hashtag');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #yolo
          </span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 5,
      anchorPath: [0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('Backspace');
    await page.keyboard.type('once');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #yolonce
          </span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 8,
      anchorPath: [0, 0, 0],
      focusOffset: 8,
      focusPath: [0, 0, 0],
    });

    await moveLeft(page, 10);
    await page.keyboard.press('Delete');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">yolonce</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 0, 0],
      focusOffset: 0,
      focusPath: [0, 0, 0],
    });
  });

  test.describe(() => {
    test.skip(({isPlainText}) => isPlainText);

    test('Typing hashtags between bold text settles', async ({page}) => {
      // Hashtags next to bold text: "#foo" touches the bold "a" before it, so
      // it is no hashtag, and "#bar" after a space is one. Typing a space
      // inside "#foobar", between bold "a" and a hashtag before bold "!",
      // keeps it that way. This settled before #9637's fix too (text after a
      // hashtag only extends it); the keyword test below reproduces #9637.
      await focusEditor(page);
      await toggleBold(page);
      await page.keyboard.type('a');
      await toggleBold(page);
      await page.keyboard.type('#foo #bar');
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              a
            </strong>
            <span data-lexical-text="true">#foo</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #bar
            </span>
          </p>
        `,
      );

      await expect(
        getPageOrFrame(page).locator('div[contenteditable="true"] p').first(),
      ).toHaveText('a#foo #bar');

      await page.keyboard.press('Enter');
      await toggleBold(page);
      await page.keyboard.type('a');
      await toggleBold(page);
      await page.keyboard.type('#foobar #baz');
      await toggleBold(page);
      await page.keyboard.type('!');
      await moveLeft(page, 9);
      await page.keyboard.type(' ');
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              a
            </strong>
            <span data-lexical-text="true">#foo</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #bar
            </span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              a
            </strong>
            <span data-lexical-text="true">#foo bar</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #baz
            </span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              !
            </strong>
          </p>
        `,
      );
      await expect(
        getPageOrFrame(page).locator('div[contenteditable="true"] p').nth(1),
      ).toHaveText('a#foo bar #baz!');
    });
    test('Typing a space between two keywords between bold text settles', async ({
      page,
    }) => {
      // #9637: neither "congrats" is a keyword, as each touches a bold
      // letter. Before, the space was dropped with "One or more transforms
      // are endlessly triggering additional transforms".
      await focusEditor(page);
      await toggleBold(page);
      await page.keyboard.type('x');
      await toggleBold(page);
      await page.keyboard.type('congratscongrats');
      await toggleBold(page);
      await page.keyboard.type('y');
      await moveLeft(page, 9);
      await page.keyboard.type(' ');
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              x
            </strong>
            <span data-lexical-text="true">congrats congrats</span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              y
            </strong>
          </p>
        `,
      );
      await expect(
        getPageOrFrame(page).locator('div[contenteditable="true"] p').first(),
      ).toHaveText('xcongrats congratsy');
    });

    test('Should not break when pasting multiple matches', async ({page}) => {
      await focusEditor(page);

      const clipboard = {'text/html': '#hello#world'};
      await pasteFromClipboard(page, clipboard);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #hello
            </span>
            <span data-lexical-text="true">#world</span>
          </p>
        `,
      );
    });

    test('Should not break while importing and exporting multiple matches', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('```markdown #hello#invalid #a #b');

      await click(page, '.action-button .markdown');
      await click(page, '.action-button .markdown');
      await click(page, '.action-button .markdown');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #hello
            </span>
            <span data-lexical-text="true">#invalid</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #a
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #b
            </span>
          </p>
        `,
      );
    });
  });
});
