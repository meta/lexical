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
  insertTable,
  insertTableColumnAfter,
  insertTableColumnBefore,
  selectCellsFromTableCords,
  test,
} from '../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('Regression test #4661', () => {
  test.beforeEach(({isCollab, page}) =>
    initialize({isCollab, page, tableHorizontalScroll: false}),
  );
  test('inserting 2 columns before inserts before selection', async ({
    page,
  }) => {
    await focusEditor(page);

    await insertTable(page, 2, 2);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 0},
      true,
      true,
    );

    await insertTableColumnBefore(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
          </tr>
          <tr dir="auto">
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('inserting 2 columns after inserts after selection', async ({page}) => {
    await focusEditor(page);

    await insertTable(page, 2, 2);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 0},
      {x: 0, y: 0},
      true,
      true,
    );

    await insertTableColumnAfter(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });
});
