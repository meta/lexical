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
  focus,
  focusEditor,
  html,
  initialize,
  selectFromInsertDropdown,
  test,
  waitForSelector,
} from '../utils/index.mjs';

export async function insertBlockEquation(page, equation) {
  await selectFromInsertDropdown(page, '.equation');
  await click(page, 'input[data-test-id="equation-inline-checkbox"]');
  await focus(page, 'textarea[data-test-id="equation-input"]');
  await page.keyboard.type(equation);
  await click(page, 'button[data-test-id="equation-submit-btn"]');
}

function equationHtml(inline = true) {
  const tag = inline ? 'span' : 'div';
  return `<${tag}
            class="editor-equation"
            contenteditable="false"
            data-lexical-decorator="true"
            role="math"
            aria-label="Equation: 1">
            <img
              alt=""
              height="0"
              src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
              width="0" />
            <span>
              ${inline ? '' : `<span class="katex-display">`}
              <span class="katex">
                <span class="katex-html" aria-hidden="true">
                  <span class="base">
                    <span class="strut" style="height: 0.6444em;"></span>
                    <span class="mord">1</span>
                  </span>
                </span>
              </span>
              ${inline ? '' : `</span>`}
            </span>
            <img
              alt=""
              height="0"
              src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
              width="0" />
          </${tag}>`;
}

test.describe('EquationNode', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(({isCollab, page}) => {
    return initialize({
      isCollab,
      page,
    });
  });
  test('inline EquationNode is wrapped in a paragraph', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('$1$');
    await waitForSelector(page, '.editor-equation');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          ${equationHtml(true)}
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });
  test('block EquationNode is a child of the root', async ({page}) => {
    await focusEditor(page);
    await insertBlockEquation(page, '1');
    await waitForSelector(page, '.editor-equation');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        ${equationHtml(false)}
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });
});
