/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {selectAll} from '../../../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  click,
  expect,
  focusEditor,
  html,
  initialize,
  locate,
  pasteFromClipboard,
  test,
} from '../../../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('HTML Links CopyAndPaste', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('Copy + paste an anchor element', async ({page}) => {
    await focusEditor(page);

    const clipboard = {
      'text/html': '<a href="https://facebook.com">Facebook!</a>',
    };

    await pasteFromClipboard(page, clipboard);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a class="PlaygroundEditorTheme__link" href="https://facebook.com">
            <span data-lexical-text="true">Facebook!</span>
          </a>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 9,
      anchorPath: [0, 0, 0, 0],
      focusOffset: 9,
      focusPath: [0, 0, 0, 0],
    });

    await selectAll(page);

    // unlink
    await click(page, '.link');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Facebook!</span>
        </p>
      `,
    );

    await click(page, '.link');
    await expect(locate(page, '.link-input')).toBeFocused();
    await page.keyboard.type('facebook.com');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a
            class="PlaygroundEditorTheme__link"
            href="https://facebook.com"
            rel="noreferrer">
            <span data-lexical-text="true">Facebook!</span>
          </a>
        </p>
      `,
    );
  });
});
