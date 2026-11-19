/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  pressBackspace,
  STANDARD_KEYPRESS_DELAY_MS,
} from '../keyboardShortcuts/index.mjs';
import {
  assertCaret,
  assertHTML,
  assertSelection,
  clearEditor,
  focusEditor,
  html,
  initialize,
  pasteFromClipboard,
  test,
} from '../utils/index.mjs';

test.describe('MaxLength', () => {
  test.use({isMaxLength: true});
  test.beforeEach(({isCollab, isMaxLength, page}) =>
    initialize({isCollab, isMaxLength, page}),
  );
  test(`can restrict the text to specified length`, async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type(
      'lorem ipsum dolor sit amet, consectetuer adipiscing elit',
    );

    await assertSelection(page, {
      anchorOffset: 30,
      anchorPath: [0, 0, 0],
      focusOffset: 30,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('Some more text');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">lorem ipsum dolor sit amet, co</span>
        </p>
      `,
    );
  });

  test(`can restrict pasted text to specified length`, async ({page}) => {
    await focusEditor(page);
    await pasteFromClipboard(page, {
      'text/plain': 'lorem ipsum dolor sit amet, consectetuer adipiscing elit',
    });
    await page.keyboard.type('Some more text');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">lorem ipsum dolor sit amet, co</span>
        </p>
      `,
    );
  });

  test(`can restrict emojis on boundaries`, async ({page}) => {
    await focusEditor(page);
    await pasteFromClipboard(page, {
      'text/plain': 'lorem ipsum dolor sit amet, consectetur adipiscing elit',
    });
    await pressBackspace(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">lorem ipsum dolor sit amet, c</span>
        </p>
      `,
    );

    await assertCaret(page, 'p > span', 29);
    await page.keyboard.type('💏', {delay: STANDARD_KEYPRESS_DELAY_MS});

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">lorem ipsum dolor sit amet, c</span>
        </p>
      `,
    );

    await assertCaret(page, 'p > span', 29);
    await pressBackspace(page);
    await assertCaret(page, 'p > span', 28);
    await page.keyboard.type('💏');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">lorem ipsum dolor sit amet, 💏</span>
        </p>
      `,
    );

    await clearEditor(page);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await assertCaret(page, 'p', 0);
    // Let the limit transform commit each grapheme before the next insertion.
    for (let count = 1; count <= 7; count++) {
      await page.keyboard.type('👨‍💻');
      await assertCaret(page, 'p > span', Math.min(count, 6) * '👨‍💻'.length);
    }

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">👨‍💻👨‍💻👨‍💻👨‍💻👨‍💻👨‍💻</span>
        </p>
      `,
    );
  });

  test(`paste with empty paragraph in between #3773`, async ({page}) => {
    await focusEditor(page);
    await pasteFromClipboard(page, {
      'text/plain':
        'lorem ipsum dolor sit amet, consectetuer \n\nadipiscing elit\n\n',
    });

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">lorem ipsum dolor sit amet, co</span>
        </p>
      `,
    );
  });

  test(`paste with empty paragraph at end #3773`, async ({page}) => {
    await focusEditor(page);
    await pasteFromClipboard(page, {
      'text/plain':
        'lorem ipsum dolor sit amet, consectetuer adipiscing elit\n\n',
    });

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">lorem ipsum dolor sit amet, co</span>
        </p>
      `,
    );
  });
});
