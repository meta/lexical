/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  deleteBackward,
  moveLeft,
  moveRight,
  moveToLineBeginning,
  moveToLineEnd,
  paste,
  selectAll,
  selectCharacters,
  STANDARD_KEYPRESS_DELAY_MS,
  toggleBold,
  undo,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  click,
  focus,
  focusEditor,
  html,
  initialize,
  insertSampleImage,
  keyDownCtrlOrMeta,
  keyUpCtrlOrMeta,
  pasteFromClipboard,
  SAMPLE_IMAGE_URL,
  test,
  withExclusiveClipboardAccess,
} from '../utils/index.mjs';

test.beforeEach(({isPlainText}) => {
  test.skip(isPlainText);
});

test.describe('Links', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test(`Can convert a text node into a link`, async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('Hello');
    await selectAll(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
        </p>
      `,
    );

    // link
    await click(page, '.link');
    await click(page, '.link-confirm');

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
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0, 0],
    });

    await selectAll(page);
    await setURL(page, 'facebook.com');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://facebook.com"
            rel="noreferrer">
            <span data-lexical-text="true">Hello</span>
          </a>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0, 0],
    });

    // unlink
    await click(page, '.link');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0],
    });
  });

  test(`Can convert multi-formatted text into a link (backward)`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type(' abc');

    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('b');
    await keyUpCtrlOrMeta(page);

    await page.keyboard.type('def');

    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('b');
    await keyUpCtrlOrMeta(page);

    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('i');
    await keyUpCtrlOrMeta(page);

    await page.keyboard.type('ghi');

    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('i');
    await keyUpCtrlOrMeta(page);

    await page.keyboard.type(' ');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">abc</span>
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            def
          </strong>
          <em
            class="PlaygroundEditorTheme__textItalic"
            data-lexical-text="true">
            ghi
          </em>
          <span data-lexical-text="true"></span>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [0, 3, 0],
      focusOffset: 1,
      focusPath: [0, 3, 0],
    });

    await moveLeft(page, 1);
    await selectCharacters(page, 'left', 9);

    // link
    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">abc</span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              def
            </strong>
            <em
              class="PlaygroundEditorTheme__textItalic"
              data-lexical-text="true">
              ghi
            </em>
          </a>
          <span data-lexical-text="true"></span>
        </p>
      `,
    );

    await setURL(page, 'facebook.com');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://facebook.com"
            rel="noreferrer">
            <span data-lexical-text="true">abc</span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              def
            </strong>
            <em
              class="PlaygroundEditorTheme__textItalic"
              data-lexical-text="true">
              ghi
            </em>
          </a>
          <span data-lexical-text="true"></span>
        </p>
      `,
    );
  });

  test(`Can convert multi-formatted text into a link (forward)`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type(' abc');

    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('b');
    await keyUpCtrlOrMeta(page);

    await page.keyboard.type('def');

    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('b');
    await keyUpCtrlOrMeta(page);

    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('i');
    await keyUpCtrlOrMeta(page);

    await page.keyboard.type('ghi');

    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('i');
    await keyUpCtrlOrMeta(page);

    await page.keyboard.type(' ');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">abc</span>
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            def
          </strong>
          <em
            class="PlaygroundEditorTheme__textItalic"
            data-lexical-text="true">
            ghi
          </em>
          <span data-lexical-text="true"></span>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [0, 3, 0],
      focusOffset: 1,
      focusPath: [0, 3, 0],
    });

    await moveLeft(page, 10);
    await selectCharacters(page, 'right', 9);

    // link
    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">abc</span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              def
            </strong>
            <em
              class="PlaygroundEditorTheme__textItalic"
              data-lexical-text="true">
              ghi
            </em>
          </a>
          <span data-lexical-text="true"></span>
        </p>
      `,
    );

    await setURL(page, 'facebook.com');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://facebook.com"
            rel="noreferrer">
            <span data-lexical-text="true">abc</span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              def
            </strong>
            <em
              class="PlaygroundEditorTheme__textItalic"
              data-lexical-text="true">
              ghi
            </em>
          </a>
          <span data-lexical-text="true"></span>
        </p>
      `,
    );
  });

  test(`Can create a link in a list and insert a paragraph at the start`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('- hello');
    await selectCharacters(page, 'left', 5);

    // link
    await click(page, '.link');
    await click(page, '.link-confirm');

    await moveLeft(page, 1);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <a
              class="PlaygroundEditorTheme__link"
              href="https://"
              rel="noreferrer">
              <span data-lexical-text="true">hello</span>
            </a>
          </li>
        </ul>
      `,
    );

    await page.keyboard.press('Enter');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <br data-lexical-managed-linebreak="true" />
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <a
              class="PlaygroundEditorTheme__link"
              href="https://"
              rel="noreferrer">
              <span data-lexical-text="true">hello</span>
            </a>
          </li>
        </ul>
      `,
    );
  });

  test(`Can create a link with some text after, insert paragraph, then backspace, it should merge correctly`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type(' abc def ');
    await moveLeft(page, 5);
    await selectCharacters(page, 'left', 3);

    // link
    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">abc</span>
          </a>
          <span data-lexical-text="true">def</span>
        </p>
      `,
    );

    await moveLeft(page, 1);
    await moveRight(page, 2);
    await page.keyboard.press('Enter');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">ab</span>
          </a>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">c</span>
          </a>
          <span data-lexical-text="true">def</span>
        </p>
      `,
    );

    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">abc</span>
          </a>
          <span data-lexical-text="true">def</span>
        </p>
      `,
    );
  });

  test(`Can backspace across a link and it deletes text, not the whole link`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type(' abc def ');
    await moveLeft(page, 5);
    await selectCharacters(page, 'left', 3);

    // link
    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">abc</span>
          </a>
          <span data-lexical-text="true">def</span>
        </p>
      `,
    );

    await moveRight(page, 4);

    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">ab</span>
          </a>
          <span data-lexical-text="true">f</span>
        </p>
      `,
    );
  });

  test(`Can create a link then replace it with plain text`, async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type(' abc ');

    await moveLeft(page, 1);
    await selectCharacters(page, 'left', 3);

    // link
    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">abc</span>
          </a>
          <span data-lexical-text="true"></span>
        </p>
      `,
    );

    await page.keyboard.type('a');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">a</span>
        </p>
      `,
    );
  });

  test(`Can create a link then replace it with plain text #2`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type(' abc ');

    await moveLeft(page, 1);
    await selectCharacters(page, 'left', 3);

    // link
    await click(page, '.link');
    await click(page, '.link-confirm');

    await selectCharacters(page, 'left', 1);
    await page.keyboard.type('a');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">a</span>
        </p>
      `,
    );
  });

  test(`Can create a link then partly replace it with plain text`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type(' abc ');

    await moveLeft(page, 1);
    await selectCharacters(page, 'left', 3);

    // link
    await click(page, '.link');
    await click(page, '.link-confirm');

    await selectCharacters(page, 'right', 1);
    await page.keyboard.type('a');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">a</span>
          </a>
          <span data-lexical-text="true">a</span>
        </p>
      `,
    );
  });

  test.describe('Inserting text either side of links', () => {
    // In each of the pasting tests, we'll paste the letter 'x' in a different
    // clipboard data format.
    const clipboardData = {
      html: {'text/html': 'x'},
      lexical: {
        'application/x-lexical-editor': JSON.stringify({
          namespace: 'Playground',
          nodes: [
            {
              detail: 0,
              format: 0,
              mode: 'normal',
              style: '',
              text: 'x',
              type: 'text',
              version: 1,
            },
          ],
        }),
      },
      plain: {'text/plain': 'x'},
    };

    test.describe('Inserting text before links', () => {
      test.describe('Start-of-paragraph links', () => {
        /**
         * @param {import('@playwright/test').Page} page
         * @param {'type' | 'paste:plain' | 'paste:html' | 'paste:lexical'} insertMethod
         */
        const setup = async (page, insertMethod) => {
          await focusEditor(page);
          await page.keyboard.type('ab');

          // Turn 'a' into a link
          await moveLeft(page, 'b'.length);
          await selectCharacters(page, 'left', 1);
          await click(page, '.link');
          await click(page, '.link-confirm');

          // Insert a character directly before the link
          await moveLeft(page, 1);
          if (insertMethod === 'type') {
            await page.keyboard.type('x');
          } else {
            const data =
              insertMethod === 'paste:plain'
                ? clipboardData.plain
                : insertMethod === 'paste:html'
                  ? clipboardData.html
                  : clipboardData.lexical;
            await pasteFromClipboard(page, data);
          }

          // The character should be inserted before the link
          await assertHTML(
            page,
            html`
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">x</span>
                <a
                  class="PlaygroundEditorTheme__link"
                  href="https://"
                  rel="noreferrer">
                  <span data-lexical-text="true">a</span>
                </a>
                <span data-lexical-text="true">b</span>
              </p>
            `,
          );
        };

        test(`Can insert text before a start-of-paragraph link, via typing`, async ({
          page,
        }) => {
          await setup(page, 'type');
        });

        test(`Can insert text before a start-of-paragraph link, via pasting plain text`, async ({
          page,
        }) => {
          await setup(page, 'paste:plain');
        });

        test(`Can insert text before a start-of-paragraph link, via pasting HTML`, async ({
          page,
        }) => {
          await setup(page, 'paste:html');
        });

        test(`Can insert text before a start-of-paragraph link, via pasting Lexical text`, async ({
          page,
        }) => {
          await setup(page, 'paste:lexical');
        });
      });

      test.describe('Mid-paragraph links', () => {
        /**
         * @param {import('@playwright/test').Page} page
         * @param {'type' | 'paste:plain' | 'paste:html' | 'paste:lexical'} insertMethod
         */
        const setup = async (page, insertMethod) => {
          await focusEditor(page);
          await page.keyboard.type('abc');

          // Turn 'b' into a link
          await moveLeft(page, 1);
          await selectCharacters(page, 'left', 1);
          await click(page, '.link');
          await click(page, '.link-confirm');

          // Insert a character directly before the link
          await moveLeft(page, 1);
          if (insertMethod === 'type') {
            await page.keyboard.type('x');
          } else {
            const data =
              insertMethod === 'paste:plain'
                ? clipboardData.plain
                : insertMethod === 'paste:html'
                  ? clipboardData.html
                  : clipboardData.lexical;
            await pasteFromClipboard(page, data);
          }

          // The character should be inserted before the link
          await assertHTML(
            page,
            html`
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">ax</span>
                <a
                  class="PlaygroundEditorTheme__link"
                  href="https://"
                  rel="noreferrer">
                  <span data-lexical-text="true">b</span>
                </a>
                <span data-lexical-text="true">c</span>
              </p>
            `,
          );
        };

        test(`Can insert text before a mid-paragraph link, via typing`, async ({
          page,
        }) => {
          await setup(page, 'type');
        });

        test(`Can insert text before a mid-paragraph link, via pasting plain text`, async ({
          page,
        }) => {
          await setup(page, 'paste:plain');
        });

        test(`Can insert text before a mid-paragraph link, via pasting HTML`, async ({
          page,
        }) => {
          await setup(page, 'paste:html');
        });

        test(`Can insert text before a mid-paragraph link, via pasting Lexical text`, async ({
          page,
        }) => {
          await setup(page, 'paste:lexical');
        });
      });

      test.describe('End-of-paragraph links', () => {
        /**
         * @param {import('@playwright/test').Page} page
         * @param {'type' | 'paste:plain' | 'paste:html' | 'paste:lexical'} insertMethod
         */
        const setup = async (page, insertMethod) => {
          await focusEditor(page);
          await page.keyboard.type('ab');

          // Turn 'b' into a link
          await selectCharacters(page, 'left', 1);
          await click(page, '.link');
          await click(page, '.link-confirm');

          // Insert a character directly before the link
          await moveLeft(page, 1);
          if (insertMethod === 'type') {
            await page.keyboard.type('x');
          } else {
            const data =
              insertMethod === 'paste:plain'
                ? clipboardData.plain
                : insertMethod === 'paste:html'
                  ? clipboardData.html
                  : clipboardData.lexical;
            await pasteFromClipboard(page, data);
          }

          // The character should be inserted before the link
          await assertHTML(
            page,
            html`
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">ax</span>
                <a
                  class="PlaygroundEditorTheme__link"
                  href="https://"
                  rel="noreferrer">
                  <span data-lexical-text="true">b</span>
                </a>
              </p>
            `,
          );
        };

        test(`Can insert text before an end-of-paragraph link, via typing`, async ({
          page,
        }) => {
          await setup(page, 'type');
        });

        test(`Can insert text before an end-of-paragraph link, via pasting plain text`, async ({
          page,
        }) => {
          await setup(page, 'paste:plain');
        });

        test(`Can insert text before an end-of-paragraph link, via pasting HTML`, async ({
          page,
        }) => {
          await setup(page, 'paste:html');
        });

        test(`Can insert text before an end-of-paragraph link, via pasting Lexical text`, async ({
          page,
        }) => {
          await setup(page, 'paste:lexical');
        });
      });
    });

    test.describe('Inserting text after links', () => {
      test.describe('Start-of-paragraph links', () => {
        /**
         * @param {import('@playwright/test').Page} page
         * @param {'type' | 'paste:plain' | 'paste:html' | 'paste:lexical'} insertMethod
         */
        const setup = async (page, insertMethod) => {
          await focusEditor(page);
          await page.keyboard.type('ab');

          // Turn 'a' into a link
          await moveLeft(page, 'b'.length);
          await selectCharacters(page, 'left', 1);
          await click(page, '.link');
          await click(page, '.link-confirm');

          // Insert a character directly after the link
          await moveRight(page, 1);
          if (insertMethod === 'type') {
            await page.keyboard.type('x');
          } else {
            const data =
              insertMethod === 'paste:plain'
                ? clipboardData.plain
                : insertMethod === 'paste:html'
                  ? clipboardData.html
                  : clipboardData.lexical;
            await pasteFromClipboard(page, data);
          }

          // The character should be inserted after the link
          await assertHTML(
            page,
            html`
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <a
                  class="PlaygroundEditorTheme__link"
                  href="https://"
                  rel="noreferrer">
                  <span data-lexical-text="true">a</span>
                </a>
                <span data-lexical-text="true">xb</span>
              </p>
            `,
          );
        };

        test(`Can insert text after a start-of-paragraph link, via typing`, async ({
          page,
        }) => {
          await setup(page, 'type');
        });

        test(`Can insert text after a start-of-paragraph link, via pasting plain text`, async ({
          page,
        }) => {
          await setup(page, 'paste:plain');
        });

        test(`Can insert text after a start-of-paragraph link, via pasting HTML`, async ({
          page,
        }) => {
          await setup(page, 'paste:html');
        });

        test(`Can insert text after a start-of-paragraph link, via pasting Lexical text`, async ({
          page,
        }) => {
          await setup(page, 'paste:lexical');
        });
      });

      test.describe('Mid-paragraph links', () => {
        /**
         * @param {import('@playwright/test').Page} page
         * @param {'type' | 'paste:plain' | 'paste:html' | 'paste:lexical'} insertMethod
         */
        const setup = async (page, insertMethod) => {
          await focusEditor(page);
          await page.keyboard.type('abc');

          // Turn 'b' into a link
          await moveLeft(page, 1);
          await selectCharacters(page, 'left', 1);
          await click(page, '.link');
          await click(page, '.link-confirm');

          // Insert a character directly after the link
          await moveRight(page, 1);
          if (insertMethod === 'type') {
            await page.keyboard.type('x');
          } else {
            const data =
              insertMethod === 'paste:plain'
                ? clipboardData.plain
                : insertMethod === 'paste:html'
                  ? clipboardData.html
                  : clipboardData.lexical;
            await pasteFromClipboard(page, data);
          }

          // The character should be inserted after the link
          await assertHTML(
            page,
            html`
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">a</span>
                <a
                  class="PlaygroundEditorTheme__link"
                  href="https://"
                  rel="noreferrer">
                  <span data-lexical-text="true">b</span>
                </a>
                <span data-lexical-text="true">xc</span>
              </p>
            `,
          );
        };

        test(`Can insert text after a mid-paragraph link, via typing`, async ({
          page,
        }) => {
          await setup(page, 'type');
        });

        test(`Can insert text after a mid-paragraph link, via pasting plain text`, async ({
          page,
        }) => {
          await setup(page, 'paste:plain');
        });

        test(`Can insert text after a mid-paragraph link, via pasting HTML`, async ({
          page,
        }) => {
          await setup(page, 'paste:html');
        });

        test(`Can insert text after a mid-paragraph link, via pasting Lexical text`, async ({
          page,
        }) => {
          await setup(page, 'paste:lexical');
        });
      });

      test.describe('End-of-paragraph links', () => {
        /**
         * @param {import('@playwright/test').Page} page
         * @param {'type' | 'paste:plain' | 'paste:html' | 'paste:lexical'} insertMethod
         */
        const setup = async (page, insertMethod) => {
          await focusEditor(page);
          await page.keyboard.type('ab');

          // Turn 'b' into a link
          await selectCharacters(page, 'left', 1);
          await click(page, '.link');
          await click(page, '.link-confirm');

          // Insert a character directly after the link
          await moveRight(page, 1);
          if (insertMethod === 'type') {
            await page.keyboard.type('x');
          } else {
            const data =
              insertMethod === 'paste:plain'
                ? clipboardData.plain
                : insertMethod === 'paste:html'
                  ? clipboardData.html
                  : clipboardData.lexical;
            await pasteFromClipboard(page, data);
          }

          // The character should be inserted after the link
          await assertHTML(
            page,
            html`
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">a</span>
                <a
                  class="PlaygroundEditorTheme__link"
                  href="https://"
                  rel="noreferrer">
                  <span data-lexical-text="true">b</span>
                </a>
                <span data-lexical-text="true">x</span>
              </p>
            `,
          );
        };

        test(`Can insert text after an end-of-paragraph link, via typing`, async ({
          page,
        }) => {
          await setup(page, 'type');
        });

        test(`Can insert text after an end-of-paragraph link, via pasting plain text`, async ({
          page,
        }) => {
          await setup(page, 'paste:plain');
        });

        test(`Can insert text after an end-of-paragraph link, via pasting HTML`, async ({
          page,
        }) => {
          await setup(page, 'paste:html');
        });

        test(`Can insert text after an end-of-paragraph link, via pasting Lexical text`, async ({
          page,
        }) => {
          await setup(page, 'paste:lexical');
        });
      });
    });
  });

  test(`Can convert multi-formatted text into a link and then modify text after`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type(' abc');

    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('b');
    await keyUpCtrlOrMeta(page);

    await page.keyboard.type('def');

    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('b');
    await keyUpCtrlOrMeta(page);

    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('i');
    await keyUpCtrlOrMeta(page);

    await page.keyboard.type('ghi');

    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('i');
    await keyUpCtrlOrMeta(page);

    await page.keyboard.type(' ');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">abc</span>
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            def
          </strong>
          <em
            class="PlaygroundEditorTheme__textItalic"
            data-lexical-text="true">
            ghi
          </em>
          <span data-lexical-text="true"></span>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [0, 3, 0],
      focusOffset: 1,
      focusPath: [0, 3, 0],
    });

    await moveLeft(page, 1);
    await selectCharacters(page, 'left', 9);

    // link
    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">abc</span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              def
            </strong>
            <em
              class="PlaygroundEditorTheme__textItalic"
              data-lexical-text="true">
              ghi
            </em>
          </a>
          <span data-lexical-text="true"></span>
        </p>
      `,
    );

    await moveRight(page, 1);
    await page.keyboard.type('a');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">abc</span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              def
            </strong>
            <em
              class="PlaygroundEditorTheme__textItalic"
              data-lexical-text="true">
              ghi
            </em>
          </a>
          <span data-lexical-text="true">a</span>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [0, 2, 0],
      focusOffset: 1,
      focusPath: [0, 2, 0],
    });
  });

  test(`It can insert text inside a link after a formatted text node`, async ({
    page,
  }) => {
    await focusEditor(page);
    const linkText = 'This is the bold link';
    await page.keyboard.type(linkText);

    // Select all characters
    await selectCharacters(page, 'left', linkText.length);

    // Make it a link
    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">${linkText}</span>
          </a>
        </p>
      `,
    );
    // Move caret to end of link
    await page.keyboard.press('ArrowRight');

    // Move caret to end of 'bold'
    await moveLeft(page, ' link'.length);

    // Select the word 'bold'
    await selectCharacters(page, 'left', 'bold'.length);

    await toggleBold(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">This is the</span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              bold
            </strong>
            <span data-lexical-text="true">link</span>
          </a>
        </p>
      `,
    );

    // Move caret to after 'bold'
    await page.keyboard.press('ArrowRight');

    // Change word to 'boldest'
    await page.keyboard.type('est');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">This is the</span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              boldest
            </strong>
            <span data-lexical-text="true">link</span>
          </a>
        </p>
      `,
    );
  });

  test(`It can insert text inside a link before a formatted text node`, async ({
    page,
  }) => {
    await focusEditor(page);
    const linkText = 'This is a bold link';
    await page.keyboard.type(linkText);

    // Select all characters
    await selectCharacters(page, 'left', linkText.length);

    // Make it a link
    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">${linkText}</span>
          </a>
        </p>
      `,
    );

    // Move caret to end of link
    await page.keyboard.press('ArrowRight');

    // Move caret to end of 'bold'
    await moveLeft(page, ' link'.length);

    // Select the word 'bold'
    await selectCharacters(page, 'left', 'bold'.length);

    await toggleBold(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">This is a</span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              bold
            </strong>
            <span data-lexical-text="true">link</span>
          </a>
        </p>
      `,
    );

    // Move caret to the start of the word 'bold'
    await page.keyboard.press('ArrowLeft');

    await selectCharacters(page, 'left', 'a '.length);

    // Replace 'a ' with 'the '
    await page.keyboard.type('the ');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">This is the</span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              bold
            </strong>
            <span data-lexical-text="true">link</span>
          </a>
        </p>
      `,
    );
  });

  test('Can edit link with collapsed selection', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('A link');
    await selectAll(page);

    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">A link</span>
          </a>
        </p>
      `,
    );

    await moveToLineBeginning(page);
    await setURL(page, 'facebook.com');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://facebook.com"
            rel="noreferrer">
            <span data-lexical-text="true">A link</span>
          </a>
        </p>
      `,
    );
  });

  test(`Can type text before and after`, async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('An Awesome Website');
    await selectAll(page);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">An Awesome Website</span>
        </p>
      `,
    );

    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">An Awesome Website</span>
          </a>
        </p>
      `,
    );

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('Hey, check this out: ');
    await moveToLineEnd(page);
    await page.keyboard.type('!');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hey, check this out:</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">An Awesome Website</span>
          </a>
          <span data-lexical-text="true">!</span>
        </p>
      `,
    );
  });

  test(`Can delete text up to a link and then add text after`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('This is an Awesome Website right?');
    await moveLeft(page, ' right?'.length);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">
            This is an Awesome Website right?
          </span>
        </p>
      `,
    );

    await selectCharacters(page, 'left', 'Awesome Website'.length);
    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      `
        <p
          class="PlaygroundEditorTheme__paragraph"
          dir="auto">
          <span data-lexical-text="true">This is an</span>
          <a
            href="https://"
            rel="noreferrer"
            class="PlaygroundEditorTheme__link"
>
            <span data-lexical-text="true">Awesome Website</span>
          </a>
          <span data-lexical-text="true"> right?</span>
        </p>
      `,
    );

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await deleteBackward(page);

    await page.keyboard.type(', ');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">This is an</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">Awesome Website</span>
          </a>
          <span data-lexical-text="true">, right?</span>
        </p>
      `,
    );
  });

  test(`Can convert part of a text node into a link with forwards selection`, async ({
    page,
    browserName,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Hello world');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello world</span>
        </p>
      `,
    );

    await moveLeft(page, 5);
    await selectCharacters(page, 'right', 5);

    // link
    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">world</span>
          </a>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 0,
      // Previous to #7046 NodeCaret the selection anchor would've been
      // inside the <a> tag but now it's normalized to the text
      anchorPath: [0, 1, 0, 0],
      focusOffset: 5,
      focusPath: [0, 1, 0, 0],
    });

    await setURL(page, 'facebook.com');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://facebook.com"
            rel="noreferrer">
            <span data-lexical-text="true">world</span>
          </a>
        </p>
      `,
    );

    // Previous to #7046 NodeCaret the selection anchor would've been
    // inside the <a> tag but now it's normalized to the text
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 1, 0, 0],
      focusOffset: 5,
      focusPath: [0, 1, 0, 0],
    });

    // unlink
    await click(page, '.link');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello world</span>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 6,
      anchorPath: [0, 0, 0],
      focusOffset: 11,
      focusPath: [0, 0, 0],
    });
  });

  test(`Can convert part of a text node into a link with backwards selection`, async ({
    page,
    browserName,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Hello world');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello world</span>
        </p>
      `,
    );

    await selectCharacters(page, 'left', 5);

    // link
    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">world</span>
          </a>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 5,
      anchorPath: [0, 1, 0, 0],
      focusOffset: 0,
      focusPath: [0, 1, 0, 0],
    });

    await setURL(page, 'facebook.com');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://facebook.com"
            rel="noreferrer">
            <span data-lexical-text="true">world</span>
          </a>
        </p>
      `,
    );

    if (browserName === 'webkit') {
      await assertSelection(page, {
        anchorOffset: 5,
        anchorPath: [0, 1, 0, 0],
        focusOffset: 0,
        focusPath: [0, 1, 0, 0],
      });
    } else if (browserName === 'chromium') {
      await assertSelection(page, {
        anchorOffset: 5,
        anchorPath: [0, 1, 0, 0],
        focusOffset: 0,
        focusPath: [0, 1, 0, 0],
      });
    } else {
      await assertSelection(page, {
        anchorOffset: 5,
        anchorPath: [0, 1, 0, 0],
        focusOffset: 0,
        focusPath: [0, 1, 0, 0],
      });
    }

    // unlink
    await click(page, '.link');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello world</span>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 11,
      anchorPath: [0, 0, 0],
      focusOffset: 6,
      focusPath: [0, 0, 0],
    });
  });

  test(`Can convert part of a text node into a link and change block type`, async ({
    page,
    browserName,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Hello world');

    await selectCharacters(page, 'left', 5);

    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">world</span>
          </a>
        </p>
      `,
    );

    await page.keyboard.press('ArrowLeft');

    await click(page, '.block-controls');
    await click(page, '.dropdown .icon.h1');

    await assertHTML(
      page,
      html`
        <h1 class="PlaygroundEditorTheme__h1" dir="auto">
          <span data-lexical-text="true">Hello</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">world</span>
          </a>
        </h1>
      `,
    );
  });

  test('Can create multiline links', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('Hello world');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Hello world');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Hello world');

    await selectAll(page);

    await click(page, '.link');

    await assertHTML(
      page,
      html`
        <p dir="auto">
          <a href="https://" rel="noreferrer">
            <span data-lexical-text="true">Hello world</span>
          </a>
        </p>
        <p dir="auto">
          <a href="https://" rel="noreferrer">
            <span data-lexical-text="true">Hello world</span>
          </a>
        </p>
        <p dir="auto">
          <a href="https://" rel="noreferrer">
            <span data-lexical-text="true">Hello world</span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can handle pressing Enter inside a Link', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('Hello awesome');
    await selectAll(page);
    await click(page, '.link');
    await click(page, '.link-confirm');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('world');

    await moveToLineBeginning(page);
    await moveRight(page, 6);

    await page.keyboard.press('Enter');

    await assertHTML(
      page,
      html`
        <p dir="auto">
          <a href="https://" rel="noreferrer">
            <span data-lexical-text="true">Hello</span>
          </a>
        </p>
        <p dir="auto">
          <a href="https://" rel="noreferrer">
            <span data-lexical-text="true">awesome</span>
          </a>
          <span data-lexical-text="true">world</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can handle pressing Enter inside a Link containing multiple TextNodes', async ({
    page,
    isCollab,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Hello ');
    await toggleBold(page);
    await page.keyboard.type('awe');
    await toggleBold(page);
    await page.keyboard.type('some');
    await selectAll(page);
    await click(page, '.link');
    await click(page, '.link-confirm');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type(' world');

    await moveToLineBeginning(page);
    await moveRight(page, 6);

    await page.keyboard.press('Enter');

    await assertHTML(
      page,
      html`
        <p dir="auto">
          <a href="https://" rel="noreferrer">
            <span data-lexical-text="true">Hello</span>
          </a>
        </p>
        <p dir="auto">
          <a href="https://" rel="noreferrer">
            <strong data-lexical-text="true">awe</strong>
            <span data-lexical-text="true">some</span>
          </a>
          <span data-lexical-text="true">world</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can handle pressing Enter at the beginning of a Link', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Hello awesome');
    await selectAll(page);
    await click(page, '.link');
    await click(page, '.link-confirm');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type(' world');

    await moveToLineBeginning(page);
    await page.keyboard.press('Enter');

    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <p dir="auto">
          <a href="https://" rel="noreferrer">
            <span data-lexical-text="true">Hello awesome</span>
          </a>
          <span data-lexical-text="true">world</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can handle pressing Enter at the end of a Link', async ({
    isCollab,
    page,
  }) => {
    test.fixme(true, 'Flaky');
    await focusEditor(page);
    await page.keyboard.type('Hello awesome');
    await selectAll(page);
    await click(page, '.link');
    await click(page, '.link-confirm');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type(' world');

    await moveLeft(page, 6, STANDARD_KEYPRESS_DELAY_MS);

    await page.keyboard.press('Enter');

    await assertHTML(
      page,
      html`
        <p dir="auto">
          <a href="https://" rel="noreferrer">
            <span data-lexical-text="true">Hello awesome</span>
          </a>
        </p>
        <p dir="auto">
          <span data-lexical-text="true">world</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can add, edit and remove links on images', async ({
    page,
    isCollab,
    browserName,
  }) => {
    // Skip for collaborative mode and Firefox on Linux
    test.skip(
      isCollab || (browserName === 'firefox' && process.platform === 'linux'),
    );
    await focusEditor(page);

    // Insert image
    await insertSampleImage(page);

    // Add link to image
    await click(page, '.editor-image img');
    await click(page, '.link');
    await focus(page, '.link-input');
    await page.keyboard.type('lexical.dev');
    await click(page, '.link-confirm');

    // Verify link was added
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://lexical.dev"
            rel="noreferrer">
            <span
              class="editor-image"
              contenteditable="false"
              data-lexical-decorator="true">
              <div draggable="true">
                <img
                  class="focused draggable"
                  alt="Yellow flower in tilt shift lens"
                  draggable="false"
                  src="${SAMPLE_IMAGE_URL}"
                  style="height: inherit; max-width: 500px; width: inherit" />
              </div>
              <div>
                <button class="image-caption-button">Add Caption</button>
                <div class="image-resizer image-resizer-n"></div>
                <div class="image-resizer image-resizer-ne"></div>
                <div class="image-resizer image-resizer-e"></div>
                <div class="image-resizer image-resizer-se"></div>
                <div class="image-resizer image-resizer-s"></div>
                <div class="image-resizer image-resizer-sw"></div>
                <div class="image-resizer image-resizer-w"></div>
                <div class="image-resizer image-resizer-nw"></div>
              </div>
            </span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: false},
    );

    // Edit link
    await click(page, '.editor-image img');
    await click(page, '.link-edit');
    await focus(page, '.link-input');
    await selectAll(page);
    await page.keyboard.press('Backspace');
    await page.keyboard.type('https://github.com/facebook/lexical');
    await click(page, '.link-confirm');

    // Verify link was updated
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://github.com/facebook/lexical"
            rel="noreferrer">
            <span
              class="editor-image"
              contenteditable="false"
              data-lexical-decorator="true">
              <div draggable="true">
                <img
                  class="focused draggable"
                  alt="Yellow flower in tilt shift lens"
                  draggable="false"
                  src="${SAMPLE_IMAGE_URL}"
                  style="height: inherit; max-width: 500px; width: inherit" />
              </div>
              <div>
                <button class="image-caption-button">Add Caption</button>
                <div class="image-resizer image-resizer-n"></div>
                <div class="image-resizer image-resizer-ne"></div>
                <div class="image-resizer image-resizer-e"></div>
                <div class="image-resizer image-resizer-se"></div>
                <div class="image-resizer image-resizer-s"></div>
                <div class="image-resizer image-resizer-sw"></div>
                <div class="image-resizer image-resizer-w"></div>
                <div class="image-resizer image-resizer-nw"></div>
              </div>
            </span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: false},
    );

    // Remove link
    await click(page, '.editor-image img');
    await click(page, '.link-trash');

    // Verify link was removed but image remains
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="editor-image"
            contenteditable="false"
            data-lexical-decorator="true">
            <div draggable="true">
              <img
                class="focused draggable"
                alt="Yellow flower in tilt shift lens"
                draggable="false"
                src="${SAMPLE_IMAGE_URL}"
                style="height: inherit; max-width: 500px; width: inherit" />
            </div>
            <div>
              <button class="image-caption-button">Add Caption</button>
              <div class="image-resizer image-resizer-n"></div>
              <div class="image-resizer image-resizer-ne"></div>
              <div class="image-resizer image-resizer-e"></div>
              <div class="image-resizer image-resizer-se"></div>
              <div class="image-resizer image-resizer-s"></div>
              <div class="image-resizer image-resizer-sw"></div>
              <div class="image-resizer image-resizer-w"></div>
              <div class="image-resizer image-resizer-nw"></div>
            </div>
          </span>
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
      undefined,
      {ignoreClasses: false},
    );
  });

  test('Can add, edit and remove links on multiple selected images', async ({
    page,
    isCollab,
    browserName,
  }) => {
    // Skip for collaborative mode and Firefox on Linux
    test.skip(
      isCollab || (browserName === 'firefox' && process.platform === 'linux'),
    );
    await focusEditor(page);

    // Insert first image
    await insertSampleImage(page);
    await page.keyboard.press('Enter');

    // Insert second image
    await insertSampleImage(page);

    // Select both images
    await click(page, 'p:nth-child(1) .editor-image img');
    await page.keyboard.down('Shift');
    await click(page, 'p:nth-child(2) .editor-image img');
    await page.keyboard.up('Shift');

    // Add link to both images
    await click(page, '.link');
    await focus(page, '.link-input');
    await page.keyboard.type('lexical.dev');
    await click(page, '.link-confirm');

    // Verify both images are linked
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://lexical.dev"
            rel="noreferrer">
            <span
              class="editor-image"
              contenteditable="false"
              data-lexical-decorator="true">
              <div draggable="true">
                <img
                  class="focused draggable"
                  alt="Yellow flower in tilt shift lens"
                  draggable="false"
                  src="${SAMPLE_IMAGE_URL}"
                  style="height: inherit; max-width: 500px; width: inherit" />
              </div>
              <div>
                <button class="image-caption-button">Add Caption</button>
                <div class="image-resizer image-resizer-n"></div>
                <div class="image-resizer image-resizer-ne"></div>
                <div class="image-resizer image-resizer-e"></div>
                <div class="image-resizer image-resizer-se"></div>
                <div class="image-resizer image-resizer-s"></div>
                <div class="image-resizer image-resizer-sw"></div>
                <div class="image-resizer image-resizer-w"></div>
                <div class="image-resizer image-resizer-nw"></div>
              </div>
            </span>
          </a>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://lexical.dev"
            rel="noreferrer">
            <span
              class="editor-image"
              contenteditable="false"
              data-lexical-decorator="true">
              <div draggable="true">
                <img
                  class="focused draggable"
                  alt="Yellow flower in tilt shift lens"
                  draggable="false"
                  src="${SAMPLE_IMAGE_URL}"
                  style="height: inherit; max-width: 500px; width: inherit" />
              </div>
              <div>
                <button class="image-caption-button">Add Caption</button>
                <div class="image-resizer image-resizer-n"></div>
                <div class="image-resizer image-resizer-ne"></div>
                <div class="image-resizer image-resizer-e"></div>
                <div class="image-resizer image-resizer-se"></div>
                <div class="image-resizer image-resizer-s"></div>
                <div class="image-resizer image-resizer-sw"></div>
                <div class="image-resizer image-resizer-w"></div>
                <div class="image-resizer image-resizer-nw"></div>
              </div>
            </span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: false},
    );

    // Edit link for both images
    await click(page, 'p:nth-child(1) .editor-image img');
    await page.keyboard.down('Shift');
    await click(page, 'p:nth-child(2) .editor-image img');
    await page.keyboard.up('Shift');
    await click(page, '.link-edit');
    await focus(page, '.link-input');
    await selectAll(page);
    await page.keyboard.press('Backspace');
    await page.keyboard.type('https://github.com/facebook/lexical');
    await click(page, '.link-confirm');

    // Verify both links were updated
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://github.com/facebook/lexical"
            rel="noreferrer">
            <span
              class="editor-image"
              contenteditable="false"
              data-lexical-decorator="true">
              <div draggable="true">
                <img
                  class="focused draggable"
                  alt="Yellow flower in tilt shift lens"
                  draggable="false"
                  src="${SAMPLE_IMAGE_URL}"
                  style="height: inherit; max-width: 500px; width: inherit" />
              </div>
              <div>
                <button class="image-caption-button">Add Caption</button>
                <div class="image-resizer image-resizer-n"></div>
                <div class="image-resizer image-resizer-ne"></div>
                <div class="image-resizer image-resizer-e"></div>
                <div class="image-resizer image-resizer-se"></div>
                <div class="image-resizer image-resizer-s"></div>
                <div class="image-resizer image-resizer-sw"></div>
                <div class="image-resizer image-resizer-w"></div>
                <div class="image-resizer image-resizer-nw"></div>
              </div>
            </span>
          </a>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://github.com/facebook/lexical"
            rel="noreferrer">
            <span
              class="editor-image"
              contenteditable="false"
              data-lexical-decorator="true">
              <div draggable="true">
                <img
                  class="focused draggable"
                  alt="Yellow flower in tilt shift lens"
                  draggable="false"
                  src="${SAMPLE_IMAGE_URL}"
                  style="height: inherit; max-width: 500px; width: inherit" />
              </div>
              <div>
                <button class="image-caption-button">Add Caption</button>
                <div class="image-resizer image-resizer-n"></div>
                <div class="image-resizer image-resizer-ne"></div>
                <div class="image-resizer image-resizer-e"></div>
                <div class="image-resizer image-resizer-se"></div>
                <div class="image-resizer image-resizer-s"></div>
                <div class="image-resizer image-resizer-sw"></div>
                <div class="image-resizer image-resizer-w"></div>
                <div class="image-resizer image-resizer-nw"></div>
              </div>
            </span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: false},
    );

    // Remove links from both images
    await click(page, 'p:nth-child(1) .editor-image img');
    await page.keyboard.down('Shift');
    await click(page, 'p:nth-child(2) .editor-image img');
    await page.keyboard.up('Shift');
    await click(page, '.link-trash');

    // Verify links were removed but images remain
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="editor-image"
            contenteditable="false"
            data-lexical-decorator="true">
            <div draggable="true">
              <img
                class="focused draggable"
                alt="Yellow flower in tilt shift lens"
                draggable="false"
                src="${SAMPLE_IMAGE_URL}"
                style="height: inherit; max-width: 500px; width: inherit" />
            </div>
            <div>
              <button class="image-caption-button">Add Caption</button>
              <div class="image-resizer image-resizer-n"></div>
              <div class="image-resizer image-resizer-ne"></div>
              <div class="image-resizer image-resizer-e"></div>
              <div class="image-resizer image-resizer-se"></div>
              <div class="image-resizer image-resizer-s"></div>
              <div class="image-resizer image-resizer-sw"></div>
              <div class="image-resizer image-resizer-w"></div>
              <div class="image-resizer image-resizer-nw"></div>
            </div>
          </span>
          <br data-lexical-managed-linebreak="true" />
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="editor-image"
            contenteditable="false"
            data-lexical-decorator="true">
            <div draggable="true">
              <img
                class="focused draggable"
                alt="Yellow flower in tilt shift lens"
                draggable="false"
                src="${SAMPLE_IMAGE_URL}"
                style="height: inherit; max-width: 500px; width: inherit" />
            </div>
            <div>
              <button class="image-caption-button">Add Caption</button>
              <div class="image-resizer image-resizer-n"></div>
              <div class="image-resizer image-resizer-ne"></div>
              <div class="image-resizer image-resizer-e"></div>
              <div class="image-resizer image-resizer-se"></div>
              <div class="image-resizer image-resizer-s"></div>
              <div class="image-resizer image-resizer-sw"></div>
              <div class="image-resizer image-resizer-w"></div>
              <div class="image-resizer image-resizer-nw"></div>
            </div>
          </span>
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
      undefined,
      {ignoreClasses: false},
    );
  });

  test('Undo from the link URL input undoes in the editor rather than natively (#6714)', async ({
    page,
    browserName,
    isCollab,
  }) => {
    // Firefox keeps the undo scoped to the focused control and never
    // dispatches `beforeinput`/`historyUndo` on the editor root, so there is
    // nothing for the editor to mishandle.
    test.skip(browserName === 'firefox' || isCollab);
    await focusEditor(page);
    await page.keyboard.type('Hello world ');
    await withExclusiveClipboardAccess(async () => {
      await pasteFromClipboard(page, {'text/plain': 'https://lexical.dev'});
    });
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello world</span>
          <a class="PlaygroundEditorTheme__link" href="https://lexical.dev">
            <span data-lexical-text="true">https://lexical.dev</span>
          </a>
        </p>
      `,
    );

    // Open the URL field of the link popup, which moves focus out of the
    // editor and leaves the editor without a selection.
    await click(page, '.link-edit');
    await focus(page, '.link-input');

    // Chromium and WebKit exhaust the URL field's own (empty) undo stack and
    // then dispatch the undo at the editor root. Nothing has been typed into
    // the URL field, so this is the very first undo the user presses.
    await undo(page);

    // The pasted link is undone. Before the fix the browser ran its native
    // undo over the editor's DOM instead, producing "Hhttps://lexical.dev":
    // a state that was never in Lexical's history.
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello world</span>
        </p>
      `,
    );
  });
});

test.describe('Link attributes', () => {
  test.use({hasLinkAttributes: true});
  test.beforeEach(({isCollab, hasLinkAttributes, page}) =>
    initialize({hasLinkAttributes, isCollab, page}),
  );
  test('Can add attributes with paste', async ({
    page,
    context,
    hasLinkAttributes,
    browserName,
  }) => {
    if (browserName === 'chromium') {
      await focusEditor(page);
      await page.keyboard.type('Hello awesome');
      await focusEditor(page);
      await selectAll(page);
      await withExclusiveClipboardAccess(async () => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.evaluate(() =>
          navigator.clipboard.writeText('https://facebook.com'),
        );
        await paste(page);
      });
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <a
              class="PlaygroundEditorTheme__link"
              href="https://facebook.com"
              rel="noopener noreferrer"
              target="_blank">
              <span data-lexical-text="true">Hello awesome</span>
            </a>
          </p>
        `,
      );
    }
  });
});

async function setURL(page, url) {
  await click(page, '.link-edit');
  await focus(page, '.link-input');
  await page.keyboard.type(url);
  await page.keyboard.press('Enter');
}
