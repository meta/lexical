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
  click,
  focusEditor,
  html,
  initialize,
  selectFromAlignDropdown,
  test,
} from '../utils/index.mjs';

test.describe('Element format', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(({isCollab, page}) => {
    return initialize({isCollab, page});
  });

  test('Can indent/align paragraph when caret is within link', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Hello https://lexical.io world');
    await moveLeft(page, 10);
    await selectFromAlignDropdown(page, '.indent');
    await selectFromAlignDropdown(page, '.indent');
    await selectFromAlignDropdown(page, '.center-align');

    await assertHTML(
      page,
      html`
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(2 * var(--lexical-indent-base-value, 40px)); text-align: center;">
          <span data-lexical-text="true">Hello</span>
          <a class="PlaygroundEditorTheme__link" href="https://lexical.io">
            <span data-lexical-text="true">https://lexical.io</span>
          </a>
          <span data-lexical-text="true">world</span>
        </p>
      `,
      undefined,
      {
        ignoreClasses: false,
        ignoreInlineStyles: false,
      },
    );
  });

  test('Can center align an empty paragraph', async ({page}) => {
    await focusEditor(page);
    await click(page, '.alignment');
    await click(page, '.center-align');

    await assertHTML(
      page,
      html`
        <p
          class="PlaygroundEditorTheme__paragraph"
          dir="auto"
          style="text-align: center">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });
});
