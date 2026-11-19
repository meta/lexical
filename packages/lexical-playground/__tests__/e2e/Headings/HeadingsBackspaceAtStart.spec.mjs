/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveToEditorBeginning,
  moveToLineBeginning,
} from '../../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  focusEditor,
  html,
  initialize,
  test,
} from '../../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test('Headings - stays as a heading when you backspace at the start of a heading with no previous sibling nodes present', async ({
  page,
  isCollab,
}) => {
  await initialize({isCollab, page});
  await focusEditor(page);

  await click(page, '.block-controls');
  await click(page, '.dropdown .icon.h1');

  await page.keyboard.type('Welcome to the playground');

  await assertHTML(
    page,
    html`
      <h1 class="PlaygroundEditorTheme__h1" dir="auto">
        <span data-lexical-text="true">Welcome to the playground</span>
      </h1>
    `,
  );

  await moveToEditorBeginning(page);

  await page.keyboard.press('Backspace');

  await assertHTML(
    page,
    html`
      <h1 class="PlaygroundEditorTheme__h1" dir="auto">
        <span data-lexical-text="true">Welcome to the playground</span>
      </h1>
    `,
  );
});

test('Headings - removes only the empty previous paragraph and preserves heading on backspace at start (#4359)', async ({
  page,
  isCollab,
}) => {
  await initialize({isCollab, page});
  await focusEditor(page);

  // Create an empty paragraph followed by a heading containing text.
  await page.keyboard.press('Enter');
  await click(page, '.block-controls');
  await click(page, '.dropdown .icon.h1');
  await page.keyboard.type('Welcome to the playground');

  await assertHTML(
    page,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <br data-lexical-managed-linebreak="true" />
      </p>
      <h1 class="PlaygroundEditorTheme__h1" dir="auto">
        <span data-lexical-text="true">Welcome to the playground</span>
      </h1>
    `,
  );

  // Move the caret to the start of the heading and press Backspace.
  await moveToLineBeginning(page);
  await page.keyboard.press('Backspace');

  // The empty paragraph is removed, but the heading stays as a heading.
  await assertHTML(
    page,
    html`
      <h1 class="PlaygroundEditorTheme__h1" dir="auto">
        <span data-lexical-text="true">Welcome to the playground</span>
      </h1>
    `,
  );
});
