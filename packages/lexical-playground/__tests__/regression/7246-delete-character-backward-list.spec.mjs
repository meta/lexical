/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  deleteBackward,
  moveToLineBeginning,
} from '../keyboardShortcuts/index.mjs';
import {
  assertCaret,
  assertHTML,
  focusEditor,
  html,
  initialize,
  test,
} from '../utils/index.mjs';

test.skip(
  ({isCollab, isPlainText}) => isCollab || isPlainText,
  'Requires rich text without collaboration',
);

test.describe('Regression tests for #7246', () => {
  test.beforeEach(({isPlainText, isCollab, page}) =>
    initialize({isCollab, isPlainText, page}),
  );

  test(`deleteCharacter merges children from block adjacent to ListNode`, async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('* list');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('paragraph');
    const beforeHtml = html`
      <ul dir="auto">
        <li value="1"><span data-lexical-text="true">list</span></li>
      </ul>
      <p dir="auto"><span data-lexical-text="true">paragraph</span></p>
    `;
    await assertHTML(page, beforeHtml, beforeHtml, {
      ignoreClasses: true,
      ignoreInlineStyles: true,
    });
    await moveToLineBeginning(page);
    await assertCaret(page, ':scope > p:last-child > span', 0);
    await deleteBackward(page);
    const afterHtml = html`
      <ul dir="auto">
        <li value="1">
          <span data-lexical-text="true">listparagraph</span>
        </li>
      </ul>
    `;
    await assertHTML(page, afterHtml, afterHtml, {
      ignoreClasses: true,
      ignoreInlineStyles: true,
    });
  });
});
