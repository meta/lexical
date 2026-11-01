/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {moveLeft} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  click,
  focusEditor,
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
