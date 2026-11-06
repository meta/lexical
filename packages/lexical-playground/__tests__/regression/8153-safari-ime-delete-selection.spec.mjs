/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {selectAll} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  focusEditor,
  html,
  initialize,
  test,
} from '../utils/index.mjs';

test.skip(
  ({browserName, isPlainText, isCollab}) =>
    browserName !== 'webkit' || isPlainText || !!isCollab,
  'Requires WebKit rich text without collaboration',
);

/**
 * Safari fires compositionend before keydown (unlike Chrome/Firefox).
 * Dispatching this event sets isSafariEndingComposition = true in LexicalEvents.ts,
 * which is the stale flag that causes the bug.
 */
async function dispatchCompositionEnd(page) {
  await page.evaluate(() => {
    document.querySelector('[contenteditable="true"]').dispatchEvent(
      new CompositionEvent('compositionend', {
        bubbles: true,
        cancelable: false,
        data: 'あああ',
      }),
    );
  });
}

test.describe('Regression #8153', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('Can delete all text selected with Cmd+A after IME composition end on Safari', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('World');

    await dispatchCompositionEnd(page);

    await selectAll(page);
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

  test('Can delete multi-paragraph selection with Shift+ArrowUp after IME composition end on Safari', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('World');
    await page.keyboard.press('Enter');
    await page.keyboard.type('あああ');

    await dispatchCompositionEnd(page);

    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
        </p>
      `,
    );
  });
});
