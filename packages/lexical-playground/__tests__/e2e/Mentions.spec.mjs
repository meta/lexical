/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  deleteNextWord,
  moveLeft,
  moveRight,
  moveToEditorBeginning,
  selectAll,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  expect,
  focusEditor,
  html,
  initialize,
  IS_WINDOWS,
  pasteFromClipboard,
  test,
  waitForSelector,
  waitForTypeaheadMenuOption,
} from '../utils/index.mjs';

test.describe('Mentions', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test(`Can enter the Luke Skywalker mention`, async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('@Luke');
    await assertSelection(page, {
      anchorOffset: 5,
      anchorPath: [0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0],
    });

    await waitForTypeaheadMenuOption(page, 'Luke Skywalker');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">@Luke</span>
        </p>
      `,
    );

    await page.keyboard.press('Enter');
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
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 14,
      anchorPath: [0, 0, 0],
      focusOffset: 14,
      focusPath: [0, 0, 0],
    });

    await waitForSelector(page, '.mention');

    await page.keyboard.press('ArrowLeft');
    await assertSelection(page, {
      anchorOffset: 13,
      anchorPath: [0, 0, 0],
      focusOffset: 13,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('ArrowRight');
    await assertSelection(page, {
      anchorOffset: 14,
      anchorPath: [0, 0, 0],
      focusOffset: 14,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('ArrowRight');
    await assertSelection(page, {
      anchorOffset: 14,
      anchorPath: [0, 0, 0],
      focusOffset: 14,
      focusPath: [0, 0, 0],
    });
  });

  test(`Can enter and delete part of the Luke Skywalker mention`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('@Luke');
    await assertSelection(page, {
      anchorOffset: 5,
      anchorPath: [0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0],
    });

    await waitForTypeaheadMenuOption(page, 'Luke Skywalker');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">@Luke</span>
        </p>
      `,
    );

    await page.keyboard.press('Enter');
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
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 14,
      anchorPath: [0, 0, 0],
      focusOffset: 14,
      focusPath: [0, 0, 0],
    });

    await waitForSelector(page, '.mention');

    await page.keyboard.press('ArrowLeft');
    await assertSelection(page, {
      anchorOffset: 13,
      anchorPath: [0, 0, 0],
      focusOffset: 13,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('Delete');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="mention"
            spellcheck="false"
            style="background-color: rgba(24, 119, 232, 0.2);"
            data-lexical-text="true">
            Luke
          </span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 4,
      anchorPath: [0, 0, 0],
      focusOffset: 4,
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
  });

  test(`Can enter and backspace part of the Luke Skywalker mention in the middle`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('@Luke');
    await assertSelection(page, {
      anchorOffset: 5,
      anchorPath: [0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0],
    });

    await waitForTypeaheadMenuOption(page, 'Luke Skywalker');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">@Luke</span>
        </p>
      `,
    );

    await page.keyboard.press('Enter');
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
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 14,
      anchorPath: [0, 0, 0],
      focusOffset: 14,
      focusPath: [0, 0, 0],
    });

    await waitForSelector(page, '.mention');

    await moveLeft(page, 10);

    await assertSelection(page, {
      anchorOffset: 4,
      anchorPath: [0, 0, 0],
      focusOffset: 4,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('Backspace');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="mention"
            spellcheck="false"
            style="background-color: rgba(24, 119, 232, 0.2);"
            data-lexical-text="true">
            Skywalker
          </span>
        </p>
      `,
    );
  });

  test(`Can enter and delete part of the Luke Skywalker mention in the middle`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('@Luke');
    await assertSelection(page, {
      anchorOffset: 5,
      anchorPath: [0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0],
    });

    await waitForTypeaheadMenuOption(page, 'Luke Skywalker');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">@Luke</span>
        </p>
      `,
    );

    await page.keyboard.press('Enter');
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
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 14,
      anchorPath: [0, 0, 0],
      focusOffset: 14,
      focusPath: [0, 0, 0],
    });

    await waitForSelector(page, '.mention');

    await moveLeft(page, 10);

    await assertSelection(page, {
      anchorOffset: 4,
      anchorPath: [0, 0, 0],
      focusOffset: 4,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('Delete');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="mention"
            spellcheck="false"
            style="background-color: rgba(24, 119, 232, 0.2);"
            data-lexical-text="true">
            Luke
          </span>
        </p>
      `,
    );
  });

  test(`Can enter and backspace part of the Luke Skywalker mention`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('@Luke');
    await assertSelection(page, {
      anchorOffset: 5,
      anchorPath: [0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0],
    });

    await waitForTypeaheadMenuOption(page, 'Luke Skywalker');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">@Luke</span>
        </p>
      `,
    );

    await page.keyboard.press('Enter');
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
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 14,
      anchorPath: [0, 0, 0],
      focusOffset: 14,
      focusPath: [0, 0, 0],
    });

    await waitForSelector(page, '.mention');

    await page.keyboard.press('Backspace');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="mention"
            spellcheck="false"
            style="background-color: rgba(24, 119, 232, 0.2);"
            data-lexical-text="true">
            Luke
          </span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 4,
      anchorPath: [0, 0, 0],
      focusOffset: 4,
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

    await page.keyboard.type('abc  def');

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">abc def</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 4,
      anchorPath: [0, 0, 0],
      focusOffset: 4,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.type('@Luke');

    await waitForTypeaheadMenuOption(page, 'Luke Skywalker');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">abc @Luke def</span>
        </p>
      `,
    );

    await page.keyboard.press('Enter');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">abc</span>
          <span
            class="mention"
            spellcheck="false"
            style="background-color: rgba(24, 119, 232, 0.2);"
            data-lexical-text="true">
            Luke Skywalker
          </span>
          <span data-lexical-text="true">def</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 14,
      anchorPath: [0, 1, 0],
      focusOffset: 14,
      focusPath: [0, 1, 0],
    });

    await page.keyboard.press('Backspace');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">abc</span>
          <span
            class="mention"
            spellcheck="false"
            style="background-color: rgba(24, 119, 232, 0.2);"
            data-lexical-text="true">
            Luke
          </span>
          <span data-lexical-text="true">def</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 4,
      anchorPath: [0, 1, 0],
      focusOffset: 4,
      focusPath: [0, 1, 0],
    });
  });

  test(`Can enter multiple Luke Skywalker mentions and then delete them from start`, async ({
    page,
    browserName,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('@Luke');
    await assertSelection(page, {
      anchorOffset: 5,
      anchorPath: [0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0],
    });

    await waitForTypeaheadMenuOption(page, 'Luke Skywalker');
    await page.keyboard.press('Enter');

    await waitForSelector(page, '.mention');

    await page.keyboard.type(' ');

    await page.keyboard.type('@Luke');

    await waitForTypeaheadMenuOption(page, 'Luke Skywalker');
    await page.keyboard.press('Enter');

    await waitForSelector(page, '.mention:nth-child(1)');

    await page.keyboard.type(' ');

    await page.keyboard.type('@Luke');

    await waitForTypeaheadMenuOption(page, 'Luke Skywalker');
    await page.keyboard.press('Enter');

    await waitForSelector(page, '.mention:nth-child(3)');

    await page.keyboard.type(' ');

    await page.keyboard.type('@Luke');

    await waitForTypeaheadMenuOption(page, 'Luke Skywalker');
    await page.keyboard.press('Enter');

    await waitForSelector(page, '.mention:nth-child(5)');

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
          <span data-lexical-text="true"></span>
          <span
            class="mention"
            spellcheck="false"
            style="background-color: rgba(24, 119, 232, 0.2);"
            data-lexical-text="true">
            Luke Skywalker
          </span>
          <span data-lexical-text="true"></span>
          <span
            class="mention"
            spellcheck="false"
            style="background-color: rgba(24, 119, 232, 0.2);"
            data-lexical-text="true">
            Luke Skywalker
          </span>
          <span data-lexical-text="true"></span>
          <span
            class="mention"
            spellcheck="false"
            style="background-color: rgba(24, 119, 232, 0.2);"
            data-lexical-text="true">
            Luke Skywalker
          </span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 14,
      anchorPath: [0, 6, 0],
      focusOffset: 14,
      focusPath: [0, 6, 0],
    });

    await moveToEditorBeginning(page);

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 0, 0],
      focusOffset: 0,
      focusPath: [0, 0, 0],
    });

    await deleteNextWord(page);

    if (IS_WINDOWS && browserName === 'chromium') {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Skywalker</span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
          </p>
        `,
      );
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Skywalker</span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
          </p>
        `,
      );
    }
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 0, 0],
      focusOffset: 0,
      focusPath: [0, 0, 0],
    });

    await deleteNextWord(page);
    if (IS_WINDOWS && browserName === 'chromium') {
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
            <span data-lexical-text="true"></span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
          </p>
        `,
      );
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true"></span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
          </p>
        `,
      );
    }
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 0, 0],
      focusOffset: 0,
      focusPath: [0, 0, 0],
    });

    await deleteNextWord(page);
    if (IS_WINDOWS && browserName === 'chromium') {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Skywalker</span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
          </p>
        `,
      );
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Skywalker</span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="mention"
              spellcheck="false"
              style="background-color: rgba(24, 119, 232, 0.2);"
              data-lexical-text="true">
              Luke Skywalker
            </span>
          </p>
        `,
      );
    }
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 0, 0],
      focusOffset: 0,
      focusPath: [0, 0, 0],
    });

    await deleteNextWord(page);
    await deleteNextWord(page);
    await deleteNextWord(page);
    await deleteNextWord(page);
    await deleteNextWord(page);

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

  test(`Can enter a mention then delete it and partially remove text after`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('@Luke');
    await assertSelection(page, {
      anchorOffset: 5,
      anchorPath: [0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0],
    });

    await waitForTypeaheadMenuOption(page, 'Luke Skywalker');
    await page.keyboard.press('Enter');

    await waitForSelector(page, '.mention');

    await page.keyboard.type(' foo bar');

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
          <span data-lexical-text="true">foo bar</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 8,
      anchorPath: [0, 1, 0],
      focusOffset: 8,
      focusPath: [0, 1, 0],
    });

    await moveLeft(page, 4);

    await assertSelection(page, {
      anchorOffset: 4,
      anchorPath: [0, 1, 0],
      focusOffset: 4,
      focusPath: [0, 1, 0],
    });

    await page.keyboard.down('Shift');
    await moveLeft(page, 18);
    await page.keyboard.up('Shift');

    await assertSelection(page, {
      anchorOffset: 4,
      anchorPath: [0, 1, 0],
      focusOffset: 0,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">bar</span>
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

  test(`Pasting over a mention does not lead to crash`, async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('@Luke');
    await assertSelection(page, {
      anchorOffset: 5,
      anchorPath: [0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0],
    });

    await waitForTypeaheadMenuOption(page, 'Luke Skywalker');
    await page.keyboard.press('Enter');

    await waitForSelector(page, '.mention');

    await selectAll(page);

    await pasteFromClipboard(page, {
      'text/html':
        '<meta charset="utf-8"><span data-lexical-mention="true">Luke Skywalker</span>',
    });

    await moveRight(page, 2);

    await page.keyboard.type(' foo bar');

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
          <span data-lexical-text="true">foo bar</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 8,
      anchorPath: [0, 1, 0],
      focusOffset: 8,
      focusPath: [0, 1, 0],
    });
  });

  test.describe(() => {
    test.skip(({isCollab}) => isCollab);
    test(`Sets correct attributes on typeahead menu container`, async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('@a');

      const menuElement = page.locator('#typeahead-menu');
      expect(await menuElement.getAttribute('aria-label')).toBe(
        'Typeahead menu',
      );
      expect(await menuElement.getAttribute('role')).toBe('listbox');
    });
  });
});
