/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveToLineBeginning,
  pressBackspace,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  html,
  initialize,
  test,
} from '../utils/index.mjs';

function testSuite(charset) {
  test('displays overflow on text', async ({page}) => {
    await page.focus('div[contenteditable="true"]');

    await page.keyboard.type('12345');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">12345</span>
        </p>
      `,
    );

    await page.keyboard.type('6789');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">12345</span>
          <span class="PlaygroundEditorTheme__characterLimit">
            <span data-lexical-text="true">6789</span>
          </span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 4,
      anchorPath: [0, 1, 0, 0],
      focusOffset: 4,
      focusPath: [0, 1, 0, 0],
    });

    await moveToLineBeginning(page);
    await page.keyboard.type('0');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">01234</span>
          <span class="PlaygroundEditorTheme__characterLimit">
            <span data-lexical-text="true">56789</span>
          </span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [0, 0, 0],
      focusOffset: 1,
      focusPath: [0, 0, 0],
    });
  });

  test('handles auto link nodes', async ({page}) => {
    await page.focus('div[contenteditable="true"]');

    await page.keyboard.type('1234:)56 www.example.com');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">1234</span>
          <span class="PlaygroundEditorTheme__characterLimit">
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true">56</span>
            <a
              class="PlaygroundEditorTheme__link"
              href="https://www.example.com">
              <span data-lexical-text="true">www.example.com</span>
            </a>
          </span>
        </p>
      `,
    );

    await pressBackspace(page, 3);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">1234</span>
          <span class="PlaygroundEditorTheme__characterLimit">
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true">56 www.example.</span>
          </span>
        </p>
      `,
    );
  });

  test('displays overflow on token nodes', async ({page}) => {
    // The smile emoji (S) is length 2, so for 1234S56:
    // - 1234 is non-overflow text
    // - S takes characters 5 and 6, since it's a token and can't be split we count the whole
    //   node as overflowed
    // - 56 is overflowed

    await page.focus('div[contenteditable="true"]');

    await page.keyboard.type('1234:)56');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">1234</span>
          <span class="PlaygroundEditorTheme__characterLimit">
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true">56</span>
          </span>
        </p>
      `,
    );

    await pressBackspace(page, 3);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">1234</span>
        </p>
      `,
    );
  });

  test('can delete text in front and overflow is recomputed (token nodes)', async ({
    page,
  }) => {
    // See 'displays overflow on token nodes'
    await page.focus('div[contenteditable="true"]');

    await page.keyboard.type('1234:)56');
    await moveToLineBeginning(page);

    await page.keyboard.press('Delete');
    if (charset === 'UTF-16') {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">234</span>
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span class="PlaygroundEditorTheme__characterLimit">
              <span data-lexical-text="true">56</span>
            </span>
          </p>
        `,
      );
    } else if (charset === 'UTF-8') {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">234</span>
            <span class="PlaygroundEditorTheme__characterLimit">
              <span class="emoji happysmile" data-lexical-text="true">
                <span class="emoji-inner">🙂</span>
              </span>
              <span data-lexical-text="true">56</span>
            </span>
          </p>
        `,
      );
    }
  });

  test.describe(() => {
    test.skip(({isPlainText}) => isPlainText);
    test('can overflow in lists', async ({page}) => {
      await page.focus('div[contenteditable="true"]');

      await page.keyboard.type('- 1234');
      await page.keyboard.press('Enter');
      await page.keyboard.type('56');
      await page.keyboard.press('Enter');
      await page.keyboard.type('7');
      await assertHTML(
        page,
        '<ul class="PlaygroundEditorTheme__ul" dir="auto"><li value="1" class="PlaygroundEditorTheme__listItem"><span data-lexical-text="true">1234</span></li><li value="2" class="PlaygroundEditorTheme__listItem"><span class="PlaygroundEditorTheme__characterLimit"><span data-lexical-text="true">56</span></span></li><li value="3" class="PlaygroundEditorTheme__listItem"><span class="PlaygroundEditorTheme__characterLimit"><span data-lexical-text="true">7</span></span></li></ul>',
      );

      await pressBackspace(page, 4);
      await assertHTML(
        page,
        '<ul class="PlaygroundEditorTheme__ul" dir="auto"><li value="1" class="PlaygroundEditorTheme__listItem"><span data-lexical-text="true">1234</span></li><li value="2" class="PlaygroundEditorTheme__listItem"><span class="PlaygroundEditorTheme__characterLimit"><span data-lexical-text="true">5</span></span></li></ul>',
      );
    });

    test('can delete an overflowed paragraph', async ({page}) => {
      await page.focus('div[contenteditable="true"]');

      await page.keyboard.type('12345');
      await page.keyboard.press('Enter');
      await page.keyboard.type('6');
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">12345</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span class="PlaygroundEditorTheme__characterLimit">
              <span data-lexical-text="true">6</span>
            </span>
          </p>
        `,
      );

      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('Backspace');
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">12345</span>
            <span class="PlaygroundEditorTheme__characterLimit">
              <span data-lexical-text="true">6</span>
            </span>
          </p>
        `,
      );
    });
  });
}

test.skip(({isCollab}) => isCollab, 'Requires non-collaborative editing');

test.describe('CharacterLimit', () => {
  test.describe('UTF-16', () => {
    test.use({isCharLimit: true});
    test.beforeEach(({isCollab, page, isCharLimit, isCharLimitUtf8}) =>
      initialize({isCharLimit, isCharLimitUtf8, isCollab, page}),
    );
    testSuite('UTF-16');
  });

  test.describe('UTF-8', () => {
    test.use({isCharLimitUtf8: true});
    test.beforeEach(({isCollab, page, isCharLimit, isCharLimitUtf8}) =>
      initialize({isCharLimit, isCharLimitUtf8, isCollab, page}),
    );
    testSuite('UTF-8');
  });
});
