/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {expect} from '@playwright/test';

import {undo} from '../keyboardShortcuts/index.mjs';
import {
  advanceHistoryClock,
  focusEditor,
  getPageOrFrame,
  initialize,
  pasteFromClipboard,
  sleep,
  test,
} from '../utils/index.mjs';

const MARKDOWN = '# Title\n- **one**\n- two';

test.describe('Markdown paste', () => {
  test.beforeEach(async ({isCollab, isPlainText, page}) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});
    await focusEditor(page);
  });

  const prompt = page => getPageOrFrame(page).locator('.markdown-paste-prompt');
  const editor = page =>
    getPageOrFrame(page).locator('div[contenteditable="true"]').first();

  async function expectConverted(page) {
    await expect(editor(page).locator('h1')).toHaveText('Title');
    await expect(editor(page).locator('li strong')).toHaveText('one');
    await expect(prompt(page)).toHaveCount(0);
  }

  test('the offer outlasts the selectionchange that follows the paste', async ({
    page,
  }) => {
    await pasteFromClipboard(page, {'text/plain': MARKDOWN});
    await expect(prompt(page)).toBeVisible();
    // What the browser fires when the reconciler sets the selection. The commit
    // also dispatches SELECTION_CHANGE_COMMAND; neither may dismiss the offer.
    await getPageOrFrame(page).evaluate(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    await sleep(500);
    await expect(prompt(page)).toBeVisible();
    await expect(editor(page).locator('p').first()).toHaveText('# Title');
  });

  test('clicking Convert keeps the selection and converts', async ({page}) => {
    await pasteFromClipboard(page, {'text/plain': MARKDOWN});
    await prompt(page)
      .getByRole('button', {name: /^Convert/})
      .click();
    await expectConverted(page);
    // The caret stayed in the editor, at the end of the converted content.
    await page.keyboard.type('!');
    await expect(editor(page).locator('li').last()).toHaveText('two!');
  });

  test('clicking dismiss keeps the paste and the selection', async ({page}) => {
    await pasteFromClipboard(page, {'text/plain': MARKDOWN});
    await prompt(page).getByRole('button', {name: 'Keep as pasted'}).click();
    await expect(prompt(page)).toHaveCount(0);
    await page.keyboard.type('!');
    await expect(editor(page).locator('p').last()).toHaveText('- two!');
  });

  test('Tab converts, and undo restores the paste', async ({page}) => {
    await pasteFromClipboard(page, {'text/plain': MARKDOWN});
    await expect(prompt(page)).toBeVisible();
    // Collab's undo merges edits made in quick succession, and a person takes
    // longer than this test to read the prompt.
    await advanceHistoryClock(page);
    await page.keyboard.press('Tab');
    await expectConverted(page);
    await undo(page);
    await expect(editor(page).locator('p').first()).toHaveText('# Title');
    await expect(editor(page).locator('h1')).toHaveCount(0);
  });

  test('the first Escape dismisses without blurring the editor', async ({
    page,
  }) => {
    await pasteFromClipboard(page, {'text/plain': MARKDOWN});
    await expect(prompt(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(prompt(page)).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
  });

  test('Tab goes back to indenting once the offer is gone', async ({page}) => {
    await pasteFromClipboard(page, {'text/plain': MARKDOWN});
    await expect(prompt(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(prompt(page)).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(editor(page)).toBeFocused();
    await expect(editor(page).locator('h1')).toHaveCount(0);
    await expect(editor(page).locator('p').last()).toHaveText(/- two/);
  });

  test('typing dismisses the offer', async ({page}) => {
    await pasteFromClipboard(page, {'text/plain': MARKDOWN});
    await expect(prompt(page)).toBeVisible();
    await page.keyboard.type('x');
    await expect(prompt(page)).toHaveCount(0);
  });

  test('a code block paste is replaced by the converted Markdown', async ({
    page,
  }) => {
    await pasteFromClipboard(page, {
      'text/html': `<pre><code>${MARKDOWN}</code></pre>`,
      'text/plain': MARKDOWN,
    });
    await expect(editor(page).locator('code')).toBeVisible();
    await page.keyboard.press('Tab');
    await expectConverted(page);
    await expect(editor(page).locator('code')).toHaveCount(0);
  });

  test('the offer is announced in a live region', async ({page}) => {
    await pasteFromClipboard(page, {'text/plain': MARKDOWN});
    await expect(
      getPageOrFrame(page).locator('[aria-live="polite"]', {
        hasText: 'looks like Markdown',
      }),
    ).toHaveCount(1);
  });
});
