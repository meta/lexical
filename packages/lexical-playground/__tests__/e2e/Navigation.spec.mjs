/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveToEditorBeginning,
  moveToEditorEnd,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  focusEditor,
  html,
  initialize,
  test,
} from '../utils/index.mjs';

// The detailed word/line/paragraph matrices run in Navigation.test.ts.
// Keep an integration smoke for native typing and navigation in the playground.
test('can type and navigate several paragraphs', async ({
  isCollab,
  isRichText,
  page,
}) => {
  await initialize({isCollab, page});
  await focusEditor(page);
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await page.keyboard.type('three');
  await assertHTML(
    page,
    isRichText
      ? html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">one</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">two</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">three</span>
          </p>
        `
      : html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">one</span>
            <br />
            <span data-lexical-text="true">two</span>
            <br />
            <span data-lexical-text="true">three</span>
          </p>
        `,
  );
  await moveToEditorBeginning(page);
  await assertSelection(page, {
    anchorOffset: 0,
    anchorPath: [0, 0, 0],
    focusOffset: 0,
    focusPath: [0, 0, 0],
  });
  await moveToEditorEnd(page);
  const path = isRichText ? [2, 0, 0] : [0, 4, 0];
  await assertSelection(page, {
    anchorOffset: 5,
    anchorPath: path,
    focusOffset: 5,
    focusPath: path,
  });
});
