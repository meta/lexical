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
  enableCompositionKeyEvents,
  focusEditor,
  html,
  initialize,
  keyDownCtrlOrMeta,
  test,
} from '../utils/index.mjs';

/* eslint-disable sort-keys-fix/sort-keys-fix */
test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('Tab', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test.describe(() => {
    test.skip(
      ({browserName}) => browserName === 'firefox' || browserName === 'webkit',
    );
    test(`can tab + IME`, async ({page}) => {
      // CDP session is only available in Chromium

      const client = await page.context().newCDPSession(page);
      async function imeType() {
        // await page.keyboard.imeSetComposition('ｓ', 1, 1);
        await client.send('Input.imeSetComposition', {
          selectionStart: 1,
          selectionEnd: 1,
          text: 'ｓ',
        });
        // await page.keyboard.imeSetComposition('す', 1, 1);
        await client.send('Input.imeSetComposition', {
          selectionStart: 1,
          selectionEnd: 1,
          text: 'す',
        });
        // await page.keyboard.imeSetComposition('すｓ', 2, 2);
        await client.send('Input.imeSetComposition', {
          selectionStart: 2,
          selectionEnd: 2,
          text: 'すｓ',
        });
        // await page.keyboard.imeSetComposition('すｓｈ', 3, 3);
        await client.send('Input.imeSetComposition', {
          selectionStart: 3,
          selectionEnd: 3,
          text: 'すｓｈ',
        });
        // await page.keyboard.imeSetComposition('すし', 2, 2);
        await client.send('Input.imeSetComposition', {
          selectionStart: 2,
          selectionEnd: 2,
          text: 'すし',
        });
        // await page.keyboard.insertText('すし');
        await client.send('Input.insertText', {
          text: 'すし',
        });
        await page.keyboard.type(' ');
      }
      await focusEditor(page);
      await enableCompositionKeyEvents(page);
      // Indent
      await page.keyboard.press('Tab');
      await imeType();
      await page.keyboard.press('Tab');
      await imeType();

      await assertHTML(
        page,
        html`
          <p
            class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
            dir="auto"
            style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
            <span data-lexical-text="true">すし</span>
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span data-lexical-text="true">すし</span>
          </p>
        `,
      );
    });
  });

  test('can tab inside code block #4399', async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('``` ');
    await page.keyboard.press('Tab');
    await page.keyboard.type('function');
    await assertHTML(
      page,
      html`
        <code
          class="PlaygroundEditorTheme__code"
          dir="auto"
          spellcheck="false"
          data-gutter="1">
          <span
            class="PlaygroundEditorTheme__tabNode"
            data-lexical-text="true"></span>
          <span data-lexical-text="true">function</span>
        </code>
      `,
    );
  });

  test('can go to start of line after a tab character', async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('Foo');
    await page.keyboard.press('Tab');

    page.on('pageerror', error => {
      throw new Error(`Uncaught exception: ${error.message}`);
    });

    // Press ctrl + left arrow key to go to start of line
    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('ArrowLeft');

    // ensure cursor is now at beginning of line
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 0, 0],
      focusOffset: 0,
      focusPath: [0, 0, 0],
    });
  });
});
/* eslint-enable sort-keys-fix/sort-keys-fix */
