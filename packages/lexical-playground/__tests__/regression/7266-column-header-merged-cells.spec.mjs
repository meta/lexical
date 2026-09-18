/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  assertTableHTML as assertHTML,
  click,
  expect,
  focusEditor,
  getPageOrFrame,
  html,
  initialize,
  insertTable,
  mergeTableCells,
  selectCellFromTableCoord,
  selectCellsFromTableCords,
  test,
  toggleColumnHeader,
  toggleRowHeader,
} from '../utils/index.mjs';

test.describe('Regression test #7266', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('toggling column header with merged column cells should only apply column header to the selected column', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);

    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 4, 4);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 1},
      {x: 1, y: 2},
      false,
      false,
    );

    await mergeTableCells(page);

    await toggleColumnHeader(page);

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
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto"
              rowspan="2">
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
          </tr>
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

  test('toggling column header applies to the grid column of the clicked cell, not its index among its row children', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);

    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 3, 4);

    // Merge grid columns 1 and 2 of row 1 into one cell, so the cells after it
    // in that row sit one grid column to the right of their child index.
    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 1},
      {x: 2, y: 1},
      false,
      false,
    );
    await mergeTableCells(page);

    // The last cell of row 1 is now the third child of its row but still
    // occupies grid column 3.
    await selectCellFromTableCoord(page, {x: 2, y: 1}, false);
    await toggleColumnHeader(page);

    // Read back which grid columns are headers, per row.
    const headerGrid = await getPageOrFrame(page).evaluate(() => {
      const table = document.querySelector('table');
      return Array.from(table.querySelectorAll(':scope > tr')).map(row =>
        Array.from(row.children).flatMap(cell =>
          Array.from({length: cell.colSpan}, () => cell.tagName),
        ),
      );
    });

    expect(headerGrid).toEqual([
      ['TH', 'TH', 'TH', 'TH'],
      ['TH', 'TD', 'TD', 'TH'],
      ['TH', 'TD', 'TD', 'TH'],
    ]);
  });

  test('toggling row header with merged row cells should only apply row header to the selected row', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);

    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 4, 4);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 1},
      {x: 2, y: 1},
      false,
      false,
    );

    await mergeTableCells(page);

    await toggleRowHeader(page);

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
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              colspan="2"
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
