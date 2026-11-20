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

test.describe('Regression tests for #6974', () => {
  test.beforeEach(({isPlainText, isCollab, page}) =>
    initialize({isCollab, isPlainText, page}),
  );

  test(`deleteCharacter merges children from adjacent blocks even if the previous leaf is an inline decorator`, async ({
    page,
  }) => {
    await focusEditor(page);
    const testEquation = '$x$';
    const testString = 'test';
    await page.keyboard.type(testEquation);
    await page.keyboard.press('Enter');
    await page.keyboard.type(testString);
    const beforeHtml = html`
      <p dir="auto">
        <span
          contenteditable="false"
          role="math"
          aria-label="Equation: x"
          data-lexical-decorator="true">
          <img
            alt=""
            height="0"
            src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
            width="0" />
          <span>
            <span>
              <span aria-hidden="true">
                <span>
                  <span></span>
                  <span>x</span>
                </span>
              </span>
            </span>
          </span>
          <img
            alt=""
            height="0"
            src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
            width="0" />
        </span>
        <br data-lexical-managed-linebreak="true" />
      </p>
      <p dir="auto"><span data-lexical-text="true">test</span></p>
    `;
    await assertHTML(page, beforeHtml, beforeHtml, {
      ignoreClasses: true,
      ignoreInlineStyles: true,
    });
    await moveToLineBeginning(page);
    await assertCaret(page, ':scope > p:last-child > span', 0);
    await deleteBackward(page);
    const afterHtml = html`
      <p dir="auto">
        <span
          contenteditable="false"
          role="math"
          aria-label="Equation: x"
          data-lexical-decorator="true">
          <img
            alt=""
            height="0"
            src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
            width="0" />
          <span>
            <span>
              <span aria-hidden="true">
                <span>
                  <span></span>
                  <span>x</span>
                </span>
              </span>
            </span>
          </span>
          <img
            alt=""
            height="0"
            src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
            width="0" />
        </span>
        <span data-lexical-text="true">test</span>
      </p>
    `;
    await assertHTML(page, afterHtml, afterHtml, {
      ignoreClasses: true,
      ignoreInlineStyles: true,
    });
  });
});
