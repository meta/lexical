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
  click,
  focusEditor,
  html,
  initialize,
  test,
} from '../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test('Layout - removes layout completely when both columns are empty and backspace is pressed at the first layout item', async ({
  page,
  isCollab,
}) => {
  await initialize({isCollab, page});
  await focusEditor(page);

  await page.keyboard.type('/');
  await click(page, '.typeahead-popover .icon.columns');
  await click(page, '.Modal__modal .Modal__content .Button__root');

  // Focus on second column
  await click(
    page,
    '.PlaygroundEditorTheme__layoutContainer .PlaygroundEditorTheme__layoutItem:nth-child(2)',
  );
  await page.keyboard.press('Backspace');

  await assertHTML(
    page,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <br data-lexical-managed-linebreak="true" />
      </p>
      <div
        class="PlaygroundEditorTheme__layoutContainer"
        dir="auto"
        style="grid-template-columns: 1fr 1fr">
        <div
          class="PlaygroundEditorTheme__layoutItem"
          dir="auto"
          data-lexical-layout-item="true">
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        </div>
        <div
          class="PlaygroundEditorTheme__layoutItem"
          dir="auto"
          data-lexical-layout-item="true">
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        </div>
      </div>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <br data-lexical-managed-linebreak="true" />
      </p>
    `,
  );

  // Delete content from first column - entire layout should be removed
  await click(
    page,
    '.PlaygroundEditorTheme__layoutContainer .PlaygroundEditorTheme__layoutItem:nth-child(1)',
  );
  await page.keyboard.press('Backspace');
  await assertHTML(
    page,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <br data-lexical-managed-linebreak="true" />
      </p>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <br data-lexical-managed-linebreak="true" />
      </p>
    `,
  );
});

for (const key of ['ArrowRight', 'ArrowDown']) {
  test.describe(() => {
    test.skip(({isCollab}) => isCollab);
    test(`Layout - ${key} key should exit from the layout if the selection is at the end of the element`, async ({
      page,
    }) => {
      await initialize({page});
      await focusEditor(page);

      await page.keyboard.type('/');
      await click(page, '.typeahead-popover .icon.columns');
      await click(page, '.Modal__modal .Modal__content .Button__root');

      // remove empty paragraphs around the layout
      await moveToEditorEnd(page);
      await page.keyboard.press('Backspace');
      await moveToEditorBeginning(page);
      await page.keyboard.press('Backspace');

      // Focus on second column
      await click(
        page,
        '.PlaygroundEditorTheme__layoutContainer .PlaygroundEditorTheme__layoutItem:nth-child(2)',
      );
      await page.keyboard.type('[site](https://lexical.dev)');

      // selection at the edge element node
      await assertSelection(page, {
        anchorOffset: 1,
        anchorPath: [0, 1, 0],
        focusOffset: 1,
        focusPath: [0, 1, 0],
      });
      await assertHTML(
        page,
        html`
          <div
            class="PlaygroundEditorTheme__layoutContainer"
            dir="auto"
            style="grid-template-columns: 1fr 1fr">
            <div
              class="PlaygroundEditorTheme__layoutItem"
              dir="auto"
              data-lexical-layout-item="true">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </div>
            <div
              class="PlaygroundEditorTheme__layoutItem"
              dir="auto"
              data-lexical-layout-item="true">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <a
                  class="PlaygroundEditorTheme__link"
                  href="https://lexical.dev">
                  <span data-lexical-text="true">site</span>
                </a>
              </p>
            </div>
          </div>
        `,
      );

      await page.keyboard.press(key);

      // selection at the new paragraph
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1],
        focusOffset: 0,
        focusPath: [1],
      });
      await assertHTML(
        page,
        html`
          <div
            class="PlaygroundEditorTheme__layoutContainer"
            dir="auto"
            style="grid-template-columns: 1fr 1fr">
            <div
              class="PlaygroundEditorTheme__layoutItem"
              dir="auto"
              data-lexical-layout-item="true">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </div>
            <div
              class="PlaygroundEditorTheme__layoutItem"
              dir="auto"
              data-lexical-layout-item="true">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <a
                  class="PlaygroundEditorTheme__link"
                  href="https://lexical.dev">
                  <span data-lexical-text="true">site</span>
                </a>
              </p>
            </div>
          </div>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
    });
  });
}
