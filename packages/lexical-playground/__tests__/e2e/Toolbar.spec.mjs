/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  selectAll,
  selectCharacters,
  toggleBold,
  toggleItalic,
  toggleUnderline,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  evaluate,
  expect,
  focus,
  focusEditor,
  html,
  initialize,
  insertSampleImage,
  IS_COLLAB_V2,
  SAMPLE_IMAGE_URL,
  selectFromAlignDropdown,
  selectFromInsertDropdown,
  test,
  waitForSelector,
} from '../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('Toolbar', () => {
  test.beforeEach(({isCollab, page}) =>
    initialize({
      isCollab,
      page,
      showNestedEditorTreeView: false,
      tableHorizontalScroll: false,
    }),
  );

  test.describe(() => {
    test.skip(IS_COLLAB_V2);
    test('Insert image caption + table', async ({page}) => {
      // TODO(collab-v2): nested editors are not supported yet

      await focusEditor(page);

      // Add caption
      await insertSampleImage(page);
      // The image is rendered behind React.Suspense (fallback={null}) and only
      // appears once the sample asset finishes loading; under parallel load
      // that can exceed assertHTML's 5s retry window, leaving an empty
      // decorator. Wait for the <img> explicitly before asserting.
      await waitForSelector(page, '.editor-image img', {timeout: 30000});
      // Catch flakiness earlier
      await assertHTML(
        page,
        html`
          <p dir="auto">
            <span contenteditable="false" data-lexical-decorator="true">
              <div draggable="false">
                <img
                  alt="Yellow flower in tilt shift lens"
                  draggable="false"
                  src="${SAMPLE_IMAGE_URL}" />
              </div>
            </span>
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
        undefined,
        {
          ignoreClasses: true,
          ignoreInlineStyles: true,
        },
      );
      await click(page, '.editor-image img');
      await click(page, '.image-caption-button');
      await focus(page, '.ImageNode__contentEditable');
      await page.keyboard.type('Yellow flower in tilt shift lens');
      await assertHTML(
        page,
        html`
          <p dir="auto">
            <span contenteditable="false" data-lexical-decorator="true">
              <div draggable="false">
                <img
                  alt="Yellow flower in tilt shift lens"
                  draggable="false"
                  src="${SAMPLE_IMAGE_URL}" />
              </div>
              <div>
                <div
                  contenteditable="true"
                  role="textbox"
                  spellcheck="true"
                  aria-placeholder="Enter a caption..."
                  data-lexical-editor="true">
                  <p dir="auto">
                    <span data-lexical-text="true">
                      Yellow flower in tilt shift lens
                    </span>
                  </p>
                </div>
              </div>
            </span>
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
        undefined,
        {
          ignoreClasses: true,
          ignoreInlineStyles: true,
        },
        actualHtml =>
          // flaky fix: remove the extra <p dir="auto"><br data-lexical-managed-linebreak="true" /></p> that appears occasionally in CI runs
          actualHtml.replace(
            html`
              <p dir="auto">
                <span data-lexical-text="true">
                  Yellow flower in tilt shift lens
                </span>
              </p>
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            `,
            html`
              <p dir="auto">
                <span data-lexical-text="true">
                  Yellow flower in tilt shift lens
                </span>
              </p>
            `,
          ),
      );

      // Delete image
      // TODO Revisit the a11y side of NestedEditors
      await evaluate(page, () => {
        const p = document.querySelector('[contenteditable="true"] p');
        document.getSelection().setBaseAndExtent(p, 0, p, 0);
      });
      await selectAll(page);
      await page.keyboard.press('Delete');
      await assertHTML(
        page,
        html`
          <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        `,
        undefined,
        {
          ignoreClasses: true,
          ignoreInlineStyles: true,
        },
      );

      // Add table
      await selectFromInsertDropdown(page, '.table');
      await click(page, '[data-test-id="table-model-confirm-insert"] button');

      await assertHTML(
        page,
        html`
          <p dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
          <table dir="auto">
            <colgroup>
              <col style="width: 92px" />
              <col style="width: 92px" />
              <col style="width: 92px" />
              <col style="width: 92px" />
              <col style="width: 92px" />
            </colgroup>
            <tr dir="auto">
              <th dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </th>
              <th dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </th>
              <th dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </th>
              <th dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </th>
              <th dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </th>
            </tr>
            <tr dir="auto">
              <th dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </th>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
            </tr>
            <tr dir="auto">
              <th dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </th>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
            </tr>
            <tr dir="auto">
              <th dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </th>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
            </tr>
            <tr dir="auto">
              <th dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </th>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
            </tr>
          </table>
          <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        `,
        undefined,
        {
          ignoreClasses: true,
          ignoreInlineStyles: true,
        },
      );
    });
  });

  test.describe(() => {
    test.skip(({isCollab}) => isCollab);
    test('Center align image', async ({page}) => {
      // Image selection can't be synced in collab

      await focusEditor(page);

      await insertSampleImage(page);
      await click(page, '.editor-image img');
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span
              class="editor-image"
              contenteditable="false"
              data-lexical-decorator="true">
              <div draggable="true">
                <img
                  class="focused draggable"
                  alt="Yellow flower in tilt shift lens"
                  draggable="false"
                  src="${SAMPLE_IMAGE_URL}"
                  style="height: inherit; max-width: 500px; width: inherit" />
              </div>
              <div>
                <button class="image-caption-button">Add Caption</button>
                <div class="image-resizer image-resizer-n"></div>
                <div class="image-resizer image-resizer-ne"></div>
                <div class="image-resizer image-resizer-e"></div>
                <div class="image-resizer image-resizer-se"></div>
                <div class="image-resizer image-resizer-s"></div>
                <div class="image-resizer image-resizer-sw"></div>
                <div class="image-resizer image-resizer-w"></div>
                <div class="image-resizer image-resizer-nw"></div>
              </div>
            </span>
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );

      await focus(page, '.editor-image');
      await page.pause();
      await selectFromAlignDropdown(page, '.center-align');
      await assertHTML(
        page,
        html`
          <p
            class="PlaygroundEditorTheme__paragraph"
            dir="auto"
            style="text-align: center">
            <span
              class="editor-image"
              contenteditable="false"
              data-lexical-decorator="true">
              <div draggable="true">
                <img
                  class="focused draggable"
                  alt="Yellow flower in tilt shift lens"
                  draggable="false"
                  src="${SAMPLE_IMAGE_URL}"
                  style="height: inherit; max-width: 500px; width: inherit" />
              </div>
              <div>
                <button class="image-caption-button">Add Caption</button>
                <div class="image-resizer image-resizer-n"></div>
                <div class="image-resizer image-resizer-ne"></div>
                <div class="image-resizer image-resizer-e"></div>
                <div class="image-resizer image-resizer-se"></div>
                <div class="image-resizer image-resizer-s"></div>
                <div class="image-resizer image-resizer-sw"></div>
                <div class="image-resizer image-resizer-w"></div>
                <div class="image-resizer image-resizer-nw"></div>
              </div>
            </span>
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
    });

    test('When we select three textNodes with different formatting at the same time, the selection formatting should show no formatting at all', async ({
      page,
    }) => {
      await focusEditor(page);

      await toggleBold(page);
      await page.keyboard.type('A ');
      await toggleBold(page);
      await toggleItalic(page);
      await page.keyboard.type('B ');
      await toggleItalic(page);
      await toggleUnderline(page);
      await page.keyboard.type('C');
      await selectCharacters(page, 'left', 5);

      const actives = await page.$$('div.toolbar button.toolbar-item.active');
      expect(actives.length).toEqual(0);
    });

    test('Selecting empty paragraphs has empty selection format', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.press('Enter');
      await selectAll(page);
      const actives = await page.$$('div.toolbar button.toolbar-item.active');
      expect(actives.length).toEqual(0);
    });
  });
});
