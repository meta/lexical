/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  assertHTML,
  click,
  focusEditor,
  html,
  initialize,
  test,
} from '../../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test('Headings - changes to a paragraph when you press enter at the end of a heading', async ({
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

  await page.keyboard.press('Enter');

  await assertHTML(
    page,
    html`
      <h1 class="PlaygroundEditorTheme__h1" dir="auto">
        <span data-lexical-text="true">Welcome to the playground</span>
      </h1>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <br data-lexical-managed-linebreak="true" />
      </p>
    `,
  );
});
