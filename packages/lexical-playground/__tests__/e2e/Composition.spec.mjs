/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveLeft,
  moveToLineBeginning,
  pressBackspace,
  selectAll,
  selectCharacters,
  toggleBold,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  enableCompositionKeyEvents,
  evaluate,
  expect,
  focusEditor,
  HIRAGANA_MOJIA,
  HIRAGANA_SUSHI,
  html,
  imeCompose,
  initialize,
  keyDownCtrlOrMeta,
  keyUpCtrlOrMeta,
  test,
  typeSushiMojia,
  waitForSelector,
  waitForTypeaheadMenuOption,
} from '../utils/index.mjs';

test.use({launchOptions: {slowMo: 50}});
test.describe('Composition', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test('Handles Hiragana characters', async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('も');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">も</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [0, 0, 0],
      focusOffset: 1,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0],
      focusOffset: 0,
      focusPath: [0],
    });

    await page.keyboard.type('もじ');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">もじ</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 2,
      anchorPath: [0, 0, 0],
      focusOffset: 2,
      focusPath: [0, 0, 0],
    });
  });

  test('Handles Arabic characters with diacritics', async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('هَ');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">هَ</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 2,
      anchorPath: [0, 0, 0],
      focusOffset: 2,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('Backspace');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">ه</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [0, 0, 0],
      focusOffset: 1,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await page.keyboard.type('هَ');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">هَ</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 2,
      anchorPath: [0, 0, 0],
      focusOffset: 2,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('ArrowRight');
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 0, 0],
      focusOffset: 0,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('Delete');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">ه</span>
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
  /* eslint-disable sort-keys-fix/sort-keys-fix */
  test.describe('IME', () => {
    test.describe(() => {
      test.skip(({browserName}) => browserName !== 'chromium');
      test('Can type Hiragana via IME', async ({page}) => {
        // We don't yet support FF.

        await focusEditor(page);
        await enableCompositionKeyEvents(page);

        const client = await page.context().newCDPSession(page);
        await typeSushiMojia(client, page);

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">すし もじあ</span>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 6,
          anchorPath: [0, 0, 0],
          focusOffset: 6,
          focusPath: [0, 0, 0],
        });
      });

      test('Can type Hiragana via IME between line breaks', async ({page}) => {
        // We don't yet support FF.

        await focusEditor(page);
        await enableCompositionKeyEvents(page);

        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');

        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');

        await page.keyboard.press('ArrowLeft');

        const client = await page.context().newCDPSession(page);
        await typeSushiMojia(client, page);

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br />
              <span data-lexical-text="true">すし もじあ</span>
              <br />
              <br data-lexical-managed-linebreak="true" />
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 6,
          anchorPath: [0, 1, 0],
          focusOffset: 6,
          focusPath: [0, 1, 0],
        });
      });
    });

    test.describe(() => {
      test.skip(
        ({browserName, isPlainText}) =>
          browserName !== 'chromium' || isPlainText,
      );
      test('Can type Hiragana via IME into a new bold format', async ({
        page,
      }) => {
        // We don't yet support FF.

        await focusEditor(page);
        await enableCompositionKeyEvents(page);

        await page.keyboard.type('Hello');

        await keyDownCtrlOrMeta(page);
        await page.keyboard.press('b');
        await keyUpCtrlOrMeta(page);

        const client = await page.context().newCDPSession(page);
        await imeCompose(
          client,
          HIRAGANA_SUSHI.steps,
          HIRAGANA_SUSHI.commitText,
        );

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Hello</span>
              <strong
                class="PlaygroundEditorTheme__textBold"
                data-lexical-text="true">
                すし
              </strong>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 2,
          anchorPath: [0, 1, 0],
          focusOffset: 2,
          focusPath: [0, 1, 0],
        });
      });
    });

    test.describe(() => {
      test.skip(({browserName}) => browserName !== 'chromium');
      test('Can type Hiragana via IME between emojis', async ({page}) => {
        await focusEditor(page);
        await enableCompositionKeyEvents(page);

        await page.keyboard.type(':):)');

        await page.keyboard.press('ArrowLeft');

        const client = await page.context().newCDPSession(page);
        await imeCompose(
          client,
          HIRAGANA_SUSHI.steps,
          HIRAGANA_SUSHI.commitText,
        );
        await page.keyboard.type(' ');
        await imeCompose(
          client,
          HIRAGANA_MOJIA.steps,
          HIRAGANA_MOJIA.commitText,
        );

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span class="emoji happysmile" data-lexical-text="true">
                <span class="emoji-inner">🙂</span>
              </span>
              <span data-lexical-text="true">すし もじあ</span>
              <span class="emoji happysmile" data-lexical-text="true">
                <span class="emoji-inner">🙂</span>
              </span>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 6,
          anchorPath: [0, 1, 0],
          focusOffset: 6,
          focusPath: [0, 1, 0],
        });

        await pressBackspace(page, 6);
        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span class="emoji happysmile" data-lexical-text="true">
                <span class="emoji-inner">🙂</span>
              </span>
              <span class="emoji happysmile" data-lexical-text="true">
                <span class="emoji-inner">🙂</span>
              </span>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 2,
          anchorPath: [0, 0, 0, 0],
          focusOffset: 2,
          focusPath: [0, 0, 0, 0],
        });

        await imeCompose(
          client,
          ['ｓ', 'す', 'すｓ', 'すｓｈ', 'すし', 'す', ''],
          '',
        );

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span class="emoji happysmile" data-lexical-text="true">
                <span class="emoji-inner">🙂</span>
              </span>
              <span class="emoji happysmile" data-lexical-text="true">
                <span class="emoji-inner">🙂</span>
              </span>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 2,
          anchorPath: [0, 0, 0, 0],
          focusOffset: 2,
          focusPath: [0, 0, 0, 0],
        });
      });

      test('Can type Hiragana via IME at the end of a mention', async ({
        page,
      }) => {
        // We don't yet support FF.

        await focusEditor(page);
        await enableCompositionKeyEvents(page);

        await page.keyboard.type('@Luke');
        await waitForTypeaheadMenuOption(page, 'Luke Skywalker');
        await page.keyboard.press('Enter');

        await waitForSelector(page, '.mention');

        const client = await page.context().newCDPSession(page);
        await imeCompose(
          client,
          HIRAGANA_SUSHI.steps,
          HIRAGANA_SUSHI.commitText,
        );
        await page.keyboard.type(' ');
        await imeCompose(
          client,
          HIRAGANA_MOJIA.steps,
          HIRAGANA_MOJIA.commitText,
        );

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span
                class="mention"
                spellcheck="false"
                style="background-color: rgba(24, 119, 232, 0.2);"
                data-lexical-text="true">
                Luke Skywalker
              </span>
              <span data-lexical-text="true">すし もじあ</span>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 6,
          anchorPath: [0, 1, 0],
          focusOffset: 6,
          focusPath: [0, 1, 0],
        });
      });

      test('Can type Hiragana via IME part way through a mention', async ({
        page,
      }) => {
        // We don't yet support FF.

        await focusEditor(page);
        await enableCompositionKeyEvents(page);

        await page.keyboard.type('@Luke');
        await waitForTypeaheadMenuOption(page, 'Luke Skywalker');
        await page.keyboard.press('Enter');

        await waitForSelector(page, '.mention');

        await moveLeft(page, 9);

        const client = await page.context().newCDPSession(page);
        await imeCompose(
          client,
          HIRAGANA_SUSHI.steps,
          HIRAGANA_SUSHI.commitText,
        );
        await page.keyboard.type(' ');
        await imeCompose(
          client,
          HIRAGANA_MOJIA.steps,
          HIRAGANA_MOJIA.commitText,
        );

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Luke すし もじあSkywalker</span>
            </p>
          `,
        );

        await assertSelection(page, {
          anchorOffset: 11,
          anchorPath: [0, 0, 0],
          focusOffset: 11,
          focusPath: [0, 0, 0],
        });
      });

      test('Typing after mention with IME should not break it', async ({
        page,
      }) => {
        // We don't yet support FF.

        await focusEditor(page);
        await enableCompositionKeyEvents(page);

        await page.keyboard.type('@Luke');
        await waitForTypeaheadMenuOption(page, 'Luke Skywalker');
        await page.keyboard.press('Enter');

        const client = await page.context().newCDPSession(page);
        await imeCompose(
          client,
          HIRAGANA_SUSHI.steps,
          HIRAGANA_SUSHI.commitText,
        );

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span
                class="mention"
                spellcheck="false"
                style="background-color: rgba(24, 119, 232, 0.2)"
                data-lexical-text="true">
                Luke Skywalker
              </span>
              <span data-lexical-text="true">すし</span>
            </p>
          `,
        );
      });

      test('Can type Hiragana via IME with hashtags', async ({page}) => {
        // We don't yet support FF.

        await focusEditor(page);
        await enableCompositionKeyEvents(page);

        await page.keyboard.type('#');

        const client = await page.context().newCDPSession(page);
        await imeCompose(
          client,
          HIRAGANA_SUSHI.steps,
          HIRAGANA_SUSHI.commitText,
        );

        await page.keyboard.type(' ');
        await imeCompose(
          client,
          HIRAGANA_MOJIA.steps,
          HIRAGANA_MOJIA.commitText,
        );

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #すし
              </span>
              <span data-lexical-text="true">もじあ</span>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 4,
          anchorPath: [0, 1, 0],
          focusOffset: 4,
          focusPath: [0, 1, 0],
        });

        await moveToLineBeginning(page);

        await imeCompose(
          client,
          HIRAGANA_SUSHI.steps,
          HIRAGANA_SUSHI.commitText,
        );

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">すし#すし もじあ</span>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 2,
          anchorPath: [0, 0, 0],
          focusOffset: 2,
          focusPath: [0, 0, 0],
        });
      });

      test('Can type, delete and cancel Hiragana via IME', async ({page}) => {
        // We don't yet support FF.

        await focusEditor(page);
        await enableCompositionKeyEvents(page);

        const client = await page.context().newCDPSession(page);
        await imeCompose(
          client,
          ['ｓ', 'す', 'すｓ', 'すｓｈ', 'すし', 'す', ''],
          '',
        );

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 0,
          anchorPath: [0],
          focusOffset: 0,
          focusPath: [0],
        });

        await page.keyboard.type(' ');
        await page.keyboard.press('ArrowLeft');

        await imeCompose(
          client,
          ['ｓ', 'す', 'すｓ', 'すｓｈ', 'すし', 'す', ''],
          '',
        );

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true"></span>
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
    });

    test.describe(() => {
      test.skip(
        ({browserName, isPlainText}) =>
          browserName !== 'chromium' || isPlainText,
      );
      test('Floating toolbar should not be displayed when using IME', async ({
        page,
      }) => {
        // We don't yet support FF.

        await focusEditor(page);
        await enableCompositionKeyEvents(page);

        const client = await page.context().newCDPSession(page);

        await client.send('Input.imeSetComposition', {
          selectionStart: 0,
          selectionEnd: 1,
          text: 'ｓ',
        });
        await client.send('Input.imeSetComposition', {
          selectionStart: 0,
          selectionEnd: 1,
          text: 'す',
        });
        await client.send('Input.imeSetComposition', {
          selectionStart: 0,
          selectionEnd: 2,
          text: 'すｓ',
        });
        await client.send('Input.imeSetComposition', {
          selectionStart: 0,
          selectionEnd: 3,
          text: 'すｓｈ',
        });
        await client.send('Input.imeSetComposition', {
          selectionStart: 0,
          // The fourth character in the DOM is a zero-width space
          // which is not represented in the lexical document (or this string)
          selectionEnd: 4,
          text: 'すｓｈ',
        });

        const isFloatingToolbarDisplayedWhenUseIME = await evaluate(
          page,
          () => {
            return !!document.querySelector('.floating-text-format-popup');
          },
        );

        expect(isFloatingToolbarDisplayedWhenUseIME).toEqual(false);

        await client.send('Input.insertText', {
          text: 'すｓｈ',
        });
        await selectCharacters(page, 'left', 3);

        const isFloatingToolbarDisplayed = await evaluate(page, () => {
          return !!document.querySelector('.floating-text-format-popup');
        });

        expect(isFloatingToolbarDisplayed).toEqual(true);
      });
    });

    test.describe(() => {
      test.skip(({browserName}) => browserName !== 'chromium');
      test('Typeahead menu should not close during IME composition', async ({
        page,
      }) => {
        // We don't yet support FF.

        await focusEditor(page);
        await enableCompositionKeyEvents(page);

        await page.keyboard.type('@Luke');
        await waitForTypeaheadMenuOption(page, 'Luke Skywalker');

        const client = await page.context().newCDPSession(page);

        await client.send('Input.imeSetComposition', {
          selectionStart: 5,
          selectionEnd: 6,
          text: 'ｓ',
        });

        await client.send('Input.imeSetComposition', {
          selectionStart: 5,
          selectionEnd: 6,
          text: 'す',
        });

        await client.send('Input.imeSetComposition', {
          selectionStart: 5,
          selectionEnd: 7,
          text: 'すｓ',
        });

        await client.send('Input.imeSetComposition', {
          selectionStart: 5,
          selectionEnd: 8,
          text: 'すｓｈ',
        });

        const isTypeaheadMenuDisplayedDuringIMEComposition = await evaluate(
          page,
          () => {
            return !!document.querySelector('#typeahead-menu');
          },
        );

        expect(isTypeaheadMenuDisplayedDuringIMEComposition).toBe(true);
      });
    });

    test.describe(() => {
      test.skip(
        ({browserName, isPlainText}) =>
          browserName !== 'chromium' || isPlainText,
      );
      test('Can replace multiple formatted text nodes with IME composition (Korean)', async ({
        page,
      }) => {
        // We don't yet support FF.

        await focusEditor(page);
        await enableCompositionKeyEvents(page);

        await page.keyboard.type('helloworld');

        await moveLeft(page, 10);
        await selectCharacters(page, 'right', 5);
        await toggleBold(page);

        await selectAll(page);

        const client = await page.context().newCDPSession(page);

        await client.send('Input.imeSetComposition', {
          selectionEnd: 1,
          selectionStart: 1,
          text: 'ㄱ',
        });
        await client.send('Input.imeSetComposition', {
          selectionEnd: 1,
          selectionStart: 1,
          text: '가',
        });
        await client.send('Input.insertText', {text: '가'});

        await client.send('Input.imeSetComposition', {
          selectionEnd: 2,
          selectionStart: 2,
          text: '가ㄴ',
        });
        await client.send('Input.imeSetComposition', {
          selectionEnd: 2,
          selectionStart: 2,
          text: '가나',
        });
        await client.send('Input.insertText', {text: '나'});

        await client.send('Input.imeSetComposition', {
          selectionEnd: 3,
          selectionStart: 3,
          text: '가나ㄷ',
        });
        await client.send('Input.imeSetComposition', {
          selectionEnd: 3,
          selectionStart: 3,
          text: '가나다',
        });
        await client.send('Input.insertText', {text: '다'});

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <strong
                class="PlaygroundEditorTheme__textBold"
                data-lexical-text="true">
                가나다
              </strong>
            </p>
          `,
        );
      });
    });
  });
  /* eslint-enable sort-keys-fix/sort-keys-fix */
});
