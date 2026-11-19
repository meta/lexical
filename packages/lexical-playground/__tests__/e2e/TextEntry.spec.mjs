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
  selectAll,
  selectCharacters,
  toggleBold,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  focusEditor,
  html,
  initialize,
  keyDownCtrlOrAlt,
  keyUpCtrlOrAlt,
  test,
} from '../utils/index.mjs';

test.describe('TextEntry', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test(`Can type 'Hello Lexical' in the editor`, async ({page}) => {
    const targetText = 'Hello Lexical';
    await focusEditor(page);
    await page.keyboard.type(targetText);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello Lexical</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: targetText.length,
      anchorPath: [0, 0, 0],
      focusOffset: targetText.length,
      focusPath: [0, 0, 0],
    });
  });

  test.describe(() => {
    test.skip(({isCollab}) => isCollab);
    test(`Can insert text and replace it`, async ({page}) => {
      await page.locator('[data-lexical-editor]').fill('Front');
      await page.locator('[data-lexical-editor]').fill('Front updated');
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Front updated</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 13,
        anchorPath: [0, 0, 0],
        focusOffset: 13,
        focusPath: [0, 0, 0],
      });
    });
  });

  test.describe(() => {
    test.skip(({isPlainText}) => isPlainText);
    test(`Can type 'Hello' as a header and insert a paragraph before`, async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('# Hello');

      await moveToLineBeginning(page);

      await assertHTML(
        page,
        html`
          <h1 class="PlaygroundEditorTheme__h1" dir="auto">
            <span data-lexical-text="true">Hello</span>
          </h1>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0, 0, 0],
        focusOffset: 0,
        focusPath: [0, 0, 0],
      });

      await page.keyboard.press('Enter');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
          <h1 class="PlaygroundEditorTheme__h1" dir="auto">
            <span data-lexical-text="true">Hello</span>
          </h1>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, 0, 0],
        focusOffset: 0,
        focusPath: [1, 0, 0],
      });
    });

    test(`Can insert a paragraph between two text nodes`, async ({page}) => {
      await focusEditor(page);
      await page.keyboard.type('Hello ');
      await toggleBold(page);
      await page.keyboard.type('world');
      await moveLeft(page, 5);
      await page.keyboard.press('Enter');

      await assertHTML(
        page,
        html`
          <p dir="auto">
            <span data-lexical-text="true">Hello</span>
          </p>
          <p dir="auto">
            <strong data-lexical-text="true">world</strong>
          </p>
        `,
        undefined,
        {ignoreClasses: true},
      );
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, 0, 0],
        focusOffset: 0,
        focusPath: [1, 0, 0],
      });
    });
  });

  test(`Can type 'Hello Lexical' in the editor and replace it with foo`, async ({
    page,
  }) => {
    const targetText = 'Hello Lexical';
    await focusEditor(page);
    await page.keyboard.type(targetText);

    // Select all the text
    await selectAll(page);

    await page.keyboard.type('Foo');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Foo</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 3,
      anchorPath: [0, 0, 0],
      focusOffset: 3,
      focusPath: [0, 0, 0],
    });
  });

  test(`Can type 'Hello Lexical' in the editor and replace it with an empty space`, async ({
    page,
  }) => {
    const targetText = 'Hello Lexical';
    await focusEditor(page);
    await page.keyboard.type(targetText);

    // Select all the text
    await selectAll(page);

    await page.keyboard.type(' ');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true"></span>
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

  test('Paragraphed text entry and selection', async ({page, isRichText}) => {
    await focusEditor(page);
    await page.keyboard.type('Hello World.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('This is another block.');
    await page.keyboard.down('Shift');
    await moveLeft(page, 6);
    if (isRichText) {
      await assertSelection(page, {
        anchorOffset: 22,
        anchorPath: [1, 0, 0],
        focusOffset: 16,
        focusPath: [1, 0, 0],
      });
    } else {
      await assertSelection(page, {
        anchorOffset: 22,
        anchorPath: [0, 2, 0],
        focusOffset: 16,
        focusPath: [0, 2, 0],
      });
    }

    await page.keyboard.up('Shift');
    await page.keyboard.type('paragraph.');
    await page.keyboard.type(' :)');

    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Hello World.</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">This is another paragraph.</span>
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 2,
        anchorPath: [1, 1, 0, 0],
        focusOffset: 2,
        focusPath: [1, 1, 0, 0],
      });
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Hello World.</span>
            <br />
            <span data-lexical-text="true">This is another paragraph.</span>
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 2,
        anchorPath: [0, 3, 0, 0],
        focusOffset: 2,
        focusPath: [0, 3, 0, 0],
      });
    }
  });

  test(`Can delete characters after they're typed`, async ({
    page,
    isRichText,
  }) => {
    await focusEditor(page);
    const text = 'Delete some of these characters.';
    const backspacedText = 'Delete some of these characte';
    await page.keyboard.type(text);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Delete some of these characte</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: backspacedText.length,
      anchorPath: [0, 0, 0],
      focusOffset: backspacedText.length,
      focusPath: [0, 0, 0],
    });
  });

  test(`Can type characters, and select and replace a part`, async ({
    page,
    isRichText,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Hello foobar.');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello foobar.</span>
        </p>
      `,
    );

    await moveLeft(page, 7);

    await assertSelection(page, {
      anchorOffset: 6,
      anchorPath: [0, 0, 0],
      focusOffset: 6,
      focusPath: [0, 0, 0],
    });

    await selectCharacters(page, 'right', 3);

    await assertSelection(page, {
      anchorOffset: 6,
      anchorPath: [0, 0, 0],
      focusOffset: 9,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.type('lol');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello lolbar.</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 9,
      anchorPath: [0, 0, 0],
      focusOffset: 9,
      focusPath: [0, 0, 0],
    });
  });

  test(`Can select and delete a word`, async ({
    page,
    browserName,
    isRichText,
  }) => {
    await focusEditor(page);
    const text = 'Delete some of these characters.';
    const backspacedText = 'Delete some of these ';
    await page.keyboard.type(text);
    await keyDownCtrlOrAlt(page);
    await page.keyboard.down('Shift');
    // Chrome stops words on punctuation, so we need to trigger
    // the left arrow key one more time.
    await moveLeft(page, browserName === 'chromium' ? 2 : 1);
    await page.keyboard.up('Shift');
    await keyUpCtrlOrAlt(page);
    // Ensure the selection is now covering the whole word and period.
    await assertSelection(page, {
      anchorOffset: text.length,
      anchorPath: [0, 0, 0],
      focusOffset: backspacedText.length,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Delete some of these</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: backspacedText.length,
      anchorPath: [0, 0, 0],
      focusOffset: backspacedText.length,
      focusPath: [0, 0, 0],
    });
  });

  test('First paragraph backspace handling', async ({page, isRichText}) => {
    await focusEditor(page);

    // Add some trimmable text
    await page.keyboard.type('  ');

    // Add paragraph
    await page.keyboard.press('Enter');

    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true"></span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1],
        focusOffset: 0,
        focusPath: [1],
      });
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true"></span>
            <br />
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 2,
        anchorPath: [0],
        focusOffset: 2,
        focusPath: [0],
      });
    }

    // Move to previous paragraph and press backspace
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Backspace');

    if (isRichText) {
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
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true"></span>
            <br />
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0, 0, 0],
        focusOffset: 0,
        focusPath: [0, 0, 0],
      });
    }
  });

  test('Mix of paragraphs and break points', async ({page, isRichText}) => {
    await focusEditor(page);

    // Add some line breaks
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br />
          <br />
          <br />
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 3,
      anchorPath: [0],
      focusOffset: 3,
      focusPath: [0],
    });

    // Move to top
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0],
      focusOffset: 0,
      focusPath: [0],
    });

    // Add paragraph
    await page.keyboard.press('Enter');

    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br />
            <br />
            <br />
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1],
        focusOffset: 0,
        focusPath: [1],
      });
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br />
            <br />
            <br />
            <br />
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 1,
        anchorPath: [0],
        focusOffset: 1,
        focusPath: [0],
      });
    }

    await page.keyboard.press('ArrowUp');
    await page.keyboard.type('هَ');

    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">هَ</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br />
            <br />
            <br />
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">هَ</span>
            <br />
            <br />
            <br />
            <br />
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
    }

    await assertSelection(page, {
      anchorOffset: 2,
      anchorPath: [0, 0, 0],
      focusOffset: 2,
      focusPath: [0, 0, 0],
    });
  });

  test('Empty paragraph and new line node selection', async ({
    isRichText,
    page,
  }) => {
    await focusEditor(page);

    // Add paragraph
    await page.keyboard.press('Enter');
    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1],
        focusOffset: 0,
        focusPath: [1],
      });
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br />
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 1,
        anchorPath: [0],
        focusOffset: 1,
        focusPath: [0],
      });
    }

    await page.keyboard.press('ArrowLeft');
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0],
      focusOffset: 0,
      focusPath: [0],
    });

    await page.keyboard.press('ArrowRight');
    if (isRichText) {
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1],
        focusOffset: 0,
        focusPath: [1],
      });
    } else {
      await assertSelection(page, {
        anchorOffset: 1,
        anchorPath: [0],
        focusOffset: 1,
        focusPath: [0],
      });
    }

    await page.keyboard.press('ArrowLeft');
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0],
      focusOffset: 0,
      focusPath: [0],
    });

    // Remove paragraph
    await page.keyboard.press('Delete');
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

    // Add line break
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br />
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [0],
      focusOffset: 1,
      focusPath: [0],
    });

    await page.keyboard.press('ArrowLeft');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br />
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

    // Remove line break
    await page.keyboard.press('Delete');
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
  });
});
