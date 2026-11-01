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
  focusEditor,
  html,
  initialize,
  test,
} from '../utils/index.mjs';

test.describe('Emoticons', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test(`Can handle a single emoticon`, async ({page, browserName}) => {
    await focusEditor(page);
    await page.keyboard.type('This is an emoji :)');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">This is an emoji</span>
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 2,
      anchorPath: [0, 1, 0, 0],
      focusOffset: 2,
      focusPath: [0, 1, 0, 0],
    });

    await page.keyboard.press('Backspace');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">This is an emoji</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 17,
      anchorPath: [0, 0, 0],
      focusOffset: 17,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.type(':)');
    await page.keyboard.press('ArrowLeft');
    if (browserName === 'firefox') {
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0, 1, 0, 0],
        focusOffset: 0,
        focusPath: [0, 1, 0, 0],
      });
    } else {
      await assertSelection(page, {
        anchorOffset: 17,
        anchorPath: [0, 0, 0],
        focusOffset: 17,
        focusPath: [0, 0, 0],
      });
    }

    await page.keyboard.press('ArrowRight');
    await assertSelection(page, {
      anchorOffset: 2,
      anchorPath: [0, 1, 0, 0],
      focusOffset: 2,
      focusPath: [0, 1, 0, 0],
    });

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Delete');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">This is an emoji</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 17,
      anchorPath: [0, 0, 0],
      focusOffset: 17,
      focusPath: [0, 0, 0],
    });
  });
});
