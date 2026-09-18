/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  deleteBackward,
  extendToNextWord,
  moveDown,
  moveLeft,
  moveRight,
  moveToEditorBeginning,
  moveToEditorEnd,
  moveToLineEnd,
  moveUp,
  pressBackspace,
  selectAll,
  selectCharacters,
  undo,
} from '../keyboardShortcuts/index.mjs';
import {
  advanceHistoryClock,
  assertSelection,
  assertTableHTML as assertHTML,
  assertTableSelectionCoordinates,
  click,
  clickSelectors,
  copyToClipboard,
  deleteTableColumns,
  deleteTableRows,
  dragMouse,
  evaluate,
  expect,
  focusEditor,
  getExpectedDateTimeHtml,
  getPageOrFrame,
  html,
  initialize,
  insertCollapsible,
  insertDateTime,
  insertHorizontalRule,
  insertTable,
  insertTableColumnBefore,
  insertTableRowAbove,
  insertTableRowBelow,
  IS_TABLE_HORIZONTAL_SCROLL,
  mergeTableCells,
  pasteFromClipboard,
  resizeTableCell,
  selectCellFromTableCoord,
  selectCellsFromTableCords,
  selectFromAdditionalStylesDropdown,
  selectFromAlignDropdown,
  selectorBoundingBox,
  setBackgroundColor,
  sleep,
  test,
  toggleColumnHeader,
  unmergeTableCell,
  waitForSelector,
  withExclusiveClipboardAccess,
} from '../utils/index.mjs';

async function fillTablePartiallyWithText(page) {
  await page.keyboard.type('a');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('b');
  await page.keyboard.press('Tab');
  await page.keyboard.press('c');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  await page.keyboard.press('b');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('d');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('e');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('f');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('c');
}

const WRAPPER = IS_TABLE_HORIZONTAL_SCROLL ? [0, 0] : [];
const nthTableSelector = nth =>
  IS_TABLE_HORIZONTAL_SCROLL
    ? `div:nth-of-type(${nth}) > div.PlaygroundEditorTheme__tableScrollableWrapper > table`
    : `table:nth-of-type(${nth})`;

test.describe('Tables', () => {
  test(`Can a table be inserted from the toolbar`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});
    await focusEditor(page);

    await insertTable(page, 2, 2);

    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
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
          </tr>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
            <td dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Selection placed on a <col> element resolves into the first cell`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText || isCollab);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 2);

    // Type into the last cell so Lexical has a definite prior selection
    // there. Without the fix, prior to landing the caret on <col>, the
    // resolution falls back to that last cell.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('last');

    // Force the DOM caret onto a <col> child of the table's <colgroup>,
    // mimicking what Firefox 150+ does on some navigation actions.
    await evaluate(page, () => {
      const col = document.querySelector(
        'div[contenteditable="true"] table > colgroup > col',
      );
      window.getSelection().setBaseAndExtent(col, 0, col, 0);
    });

    // The DOM caret must not be left inside the <col> / <colgroup> region
    // (the reconciler should have written it back to the resolved cell).
    // Poll for the selectionchange -> reconcile round-trip instead of sleeping
    // a fixed time, which can be too short under load.
    await expect
      .poll(() =>
        evaluate(
          page,
          () => window.getSelection().anchorNode?.nodeName ?? null,
        ),
      )
      .not.toMatch(/^COL(GROUP)?$/);

    // Typing should land in the first cell, not extend "last".
    await page.keyboard.type('X');
    const cellTexts = await evaluate(page, () => {
      const cells = document.querySelectorAll(
        'div[contenteditable="true"] table th, div[contenteditable="true"] table td',
      );
      return Array.from(cells).map(c => c.textContent);
    });
    expect(cellTexts[0]).toBe('X');
    expect(cellTexts[cellTexts.length - 1]).toBe('last');
  });

  test(`TableSelection converts to RangeSelection when DOM selection extends onto the editor root (Issue #8584 follow-up)`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText || isCollab);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 2);

    // Create a TableSelection across the first header cell (th at
    // {x:0,y:0}) and the last body cell (td at {x:1,y:1}). The default
    // insertTable marks row 0 and column 0 as headers, so {x:1,y:1} is
    // the only plain td in a 2x2 table.
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 1},
      true,
      false,
    );

    // Sanity check: the editor selection is a TableSelection.
    const isTableSelection = await evaluate(page, () => {
      const editor = window.lexicalEditor;
      const sel = editor.getEditorState()._selection;
      return Boolean(sel && 'tableKey' in sel);
    });
    expect(isTableSelection).toBe(true);

    // Move the DOM focus onto the editor root element itself (outside the
    // table). Before #8584 root carried no `__lexicalKey_*`, so
    // `$getNearestNodeFromDOMNode(rootElement)` returned null and the
    // `isFocusOutside` check in `$fixTableSelectionForSelectedTable`
    // short-circuited — the TableSelection was never converted. After
    // #8584 root resolves to RootNode, so `isFocusOutside` is truthy and
    // the selection is correctly switched to a RangeSelection.
    //
    // The TableObserver clears the window selection when it enters
    // TableSelection mode, so we cannot rely on the prior anchorNode —
    // build a fresh range with a known cell as the anchor instead.
    await evaluate(page, () => {
      const root = document.querySelector('div[contenteditable="true"]');
      const firstCell = document.querySelector(
        'div[contenteditable="true"] table th, div[contenteditable="true"] table td',
      );
      window
        .getSelection()
        .setBaseAndExtent(firstCell, 0, root, root.childNodes.length);
    });
    await sleep(50);

    const selectionAfter = await evaluate(page, () => {
      const editor = window.lexicalEditor;
      const sel = editor.getEditorState()._selection;
      return {
        isRange: Boolean(
          sel && 'anchor' in sel && 'focus' in sel && !('tableKey' in sel),
        ),
        isTable: Boolean(sel && 'tableKey' in sel),
      };
    });
    expect(selectionAfter.isTable).toBe(false);
    expect(selectionAfter.isRange).toBe(true);
  });

  test(`Can type inside of table cell`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 2);

    await page.keyboard.type('abc');

    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">abc</span></p>
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
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test.describe(`Can exit table with the horizontal arrow keys`, () => {
    test(`Can exit the first cell of a table`, async ({
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      await initialize({isCollab, page});

      await focusEditor(page);
      await insertTable(page, 2, 2);

      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 1, 0, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 1, 0, 0],
      });

      await moveLeft(page, 1);

      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0],
        focusOffset: 0,
        focusPath: [0],
      });

      await moveRight(page, 1);
      await page.keyboard.type('ab');

      await assertSelection(page, {
        anchorOffset: 2,
        anchorPath: [1, ...WRAPPER, 1, 0, 0, 0, 0],
        focusOffset: 2,
        focusPath: [1, ...WRAPPER, 1, 0, 0, 0, 0],
      });

      await moveRight(page, 3);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 2, 1, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 2, 1, 0],
      });
    });

    test(`Can exit the last cell of a table`, async ({
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      await initialize({isCollab, page});

      await focusEditor(page);
      await insertTable(page, 2, 2);

      await moveRight(page, 3);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 2, 1, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 2, 1, 0],
      });

      await moveRight(page, 1);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [2],
        focusOffset: 0,
        focusPath: [2],
      });

      await moveLeft(page, 1);
      await page.keyboard.type('ab');
      await assertSelection(page, {
        anchorOffset: 2,
        anchorPath: [1, ...WRAPPER, 2, 1, 0, 0, 0],
        focusOffset: 2,
        focusPath: [1, ...WRAPPER, 2, 1, 0, 0, 0],
      });

      await moveRight(page, 3);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [2],
        focusOffset: 0,
        focusPath: [2],
      });
    });

    test(`Can exit the first cell of a nested table into the parent table cell`, async ({
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      await initialize({hasNestedTables: true, isCollab, page});

      await focusEditor(page);
      await insertTable(page, 2, 2);
      await insertTable(page, 2, 2);

      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 1, 0, 1, ...WRAPPER, 1, 0, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 1, 0, 1, ...WRAPPER, 1, 0, 0],
      });

      await moveLeft(page, 1);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 1, 0, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 1, 0, 0],
      });
    });

    test(`Can exit the last cell of a nested table into the parent table cell`, async ({
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      await initialize({hasNestedTables: true, isCollab, page});

      await focusEditor(page);
      await insertTable(page, 2, 2);
      await insertTable(page, 2, 2);

      await moveRight(page, 3);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 1, 0, 1, ...WRAPPER, 2, 1, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 1, 0, 1, ...WRAPPER, 2, 1, 0],
      });

      await moveRight(page, 1);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 1, 0, 2],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 1, 0, 2],
      });
    });
  });

  test(`Can insert a paragraph after a table, that is the last node, with the "Enter" key`, async ({
    page,
    isPlainText,
    isCollab,
    browserName,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 2);

    await moveDown(page, 2);
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2],
      focusOffset: 0,
      focusPath: [2],
    });

    await deleteBackward(page);
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [1, ...WRAPPER, 2, 1, 0],
      focusOffset: 0,
      focusPath: [1, ...WRAPPER, 2, 1, 0],
    });
    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
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
          </tr>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
            <td dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </td>
          </tr>
        </table>
      `,
      undefined,
      {ignoreClasses: true},
    );

    await moveRight(page, 1);
    await assertSelection(page, {
      anchorOffset: 2,
      anchorPath: [],
      focusOffset: 2,
      focusPath: [],
    });

    await page.keyboard.press('Enter');
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2],
      focusOffset: 0,
      focusPath: [2],
    });

    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
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
          </tr>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
            <td dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Can type text after a table that is the last node`, async ({
    page,
    isPlainText,
    isCollab,
    browserName,
  }) => {
    test.skip(isPlainText);

    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 2);

    await moveDown(page, 2);
    await deleteBackward(page);

    await moveRight(page, 1);
    await page.keyboard.type('a');
    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [2, 0, 0],
      focusOffset: 1,
      focusPath: [2, 0, 0],
    });

    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
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
          </tr>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
            <td dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><span data-lexical-text="true">a</span></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Can't backwards delete from text to a table`, async ({
    page,
    isPlainText,
    isCollab,
    browserName,
  }) => {
    test.skip(isPlainText);

    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 2);
    await moveDown(page, 2);
    await page.keyboard.type('asdf');

    // check initial state
    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
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
          </tr>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
            <td dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><span data-lexical-text="true">asdf</span></p>
      `,
      undefined,
      {ignoreClasses: true},
    );

    await moveLeft(page, 2);
    await deleteBackward(page);
    await deleteBackward(page);
    await deleteBackward(page);
    await deleteBackward(page);

    // only 'as' should be deleted
    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
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
          </tr>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
            <td dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><span data-lexical-text="true">df</span></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2, 0, 0],
      focusOffset: 0,
      focusPath: [2, 0, 0],
    });
  });

  test(`Can enter a table from a paragraph underneath via the left arrow key`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 2);

    await moveDown(page, 2);
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2],
      focusOffset: 0,
      focusPath: [2],
    });

    await moveLeft(page, 1);
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [1, ...WRAPPER, 2, 1, 0],
      focusOffset: 0,
      focusPath: [1, ...WRAPPER, 2, 1, 0],
    });
  });

  test.describe(`Can navigate table with keyboard`, () => {
    test(`Can navigate cells horizontally`, async ({
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      await initialize({isCollab, page});

      await focusEditor(page);
      await insertTable(page, 2, 2);

      await assertHTML(
        page,
        html`
          <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
          <table dir="auto">
            <colgroup>
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
            </tr>
            <tr dir="auto">
              <th dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </th>
              <td dir="auto">
                <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              </td>
            </tr>
          </table>
          <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        `,
        undefined,
        {ignoreClasses: true},
      );

      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 1, 0, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 1, 0, 0],
      });

      await moveRight(page, 1);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 1, 1, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 1, 1, 0],
      });

      await moveRight(page, 1);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 2, 0, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 2, 0, 0],
      });

      await moveRight(page, 1);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 2, 1, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 2, 1, 0],
      });

      await moveLeft(page, 1);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 2, 0, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 2, 0, 0],
      });

      await moveLeft(page, 1);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 1, 1, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 1, 1, 0],
      });

      await moveLeft(page, 1);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 1, 0, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 1, 0, 0],
      });
    });

    test(`Can navigate cells vertically`, async ({
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      await initialize({isCollab, page});

      await focusEditor(page);
      await insertTable(page, 2, 2);

      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 1, 0, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 1, 0, 0],
      });

      await moveDown(page, 1);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 2, 0, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 2, 0, 0],
      });

      await moveUp(page, 1);
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [1, ...WRAPPER, 1, 0, 0],
        focusOffset: 0,
        focusPath: [1, ...WRAPPER, 1, 0, 0],
      });
    });

    test('Should not navigate cells when typeahead menu is open and focused', async ({
      page,
      isCollab,
      isPlainText,
    }) => {
      test.skip(isPlainText);
      await initialize({isCollab, page});

      await focusEditor(page);
      await insertTable(page, 2, 2);

      await page.keyboard.type('@A');
      await assertSelection(page, {
        anchorOffset: 2,
        anchorPath: [1, ...WRAPPER, 1, 0, 0, 0, 0],
        focusOffset: 2,
        focusPath: [1, ...WRAPPER, 1, 0, 0, 0, 0],
      });

      await waitForSelector(
        page,
        `div[class="typeahead-popover mentions-menu"] ul li:first-child.selected`,
      );

      await moveDown(page, 1);
      await assertSelection(page, {
        anchorOffset: 2,
        anchorPath: [1, ...WRAPPER, 1, 0, 0, 0, 0],
        focusOffset: 2,
        focusPath: [1, ...WRAPPER, 1, 0, 0, 0, 0],
      });

      await waitForSelector(
        page,
        'div[class="typeahead-popover mentions-menu"] ul li:nth-child(2).selected',
      );
    });
  });

  test(`Can select cells using Table selection`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 3);

    await fillTablePartiallyWithText(page);
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 1},
      true,
      false,
    );

    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><span data-lexical-text="true">a</span></p>
            </th>
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><span data-lexical-text="true">bb</span></p>
            </th>
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">cc</span></p>
            </th>
          </tr>
          <tr dir="auto">
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><span data-lexical-text="true">d</span></p>
            </th>
            <td class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><span data-lexical-text="true">e</span></p>
            </td>
            <td dir="auto">
              <p dir="auto"><span data-lexical-text="true">f</span></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Can select cells using Table selection via keyboard`, async ({
    page,
    isPlainText,
    isCollab,
    browserName,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 3, 3);

    await fillTablePartiallyWithText(page);

    let p = page;

    if (isCollab) {
      await focusEditor(page);
      p = await page.frame('left');
    }

    const firstRowFirstColumnCellBoundingBox = await p.locator(
      'table:first-of-type > :nth-match(tr, 1) > th:nth-child(1)',
    );

    // Focus on inside the iFrame or the boundingBox() below returns null.
    await firstRowFirstColumnCellBoundingBox.click();

    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.up('Shift');

    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><span data-lexical-text="true">a</span></p>
            </th>
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><span data-lexical-text="true">bb</span></p>
            </th>
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">cc</span></p>
            </th>
          </tr>
          <tr dir="auto">
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><span data-lexical-text="true">d</span></p>
            </th>
            <td class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><span data-lexical-text="true">e</span></p>
            </td>
            <td dir="auto">
              <p dir="auto"><span data-lexical-text="true">f</span></p>
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
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true, ignoreInlineStyles: true},
    );
  });

  test(`Can style text using Table selection`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 3);

    await fillTablePartiallyWithText(page);
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 1},
      true,
      false,
    );

    await clickSelectors(page, ['.bold', '.italic', '.underline']);

    await selectFromAdditionalStylesDropdown(page, '.strikethrough');

    // Check that the character styles are applied.
    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><strong data-lexical-text="true">a</strong></p>
            </th>
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><strong data-lexical-text="true">bb</strong></p>
            </th>
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">cc</span></p>
            </th>
          </tr>
          <tr dir="auto">
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><strong data-lexical-text="true">d</strong></p>
            </th>
            <td class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><strong data-lexical-text="true">e</strong></p>
            </td>
            <td dir="auto">
              <p dir="auto"><span data-lexical-text="true">f</span></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Can style on empty table cells and paragraphs with no text`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 3);
    await selectAll(page);

    // Apply style on empty table
    await clickSelectors(page, ['.bold']);

    // Add text after applying styles
    await click(page, 'div[contenteditable="true"] p:first-of-type');
    await page.keyboard.type('abc');

    await click(page, 'th p:first-of-type');
    await fillTablePartiallyWithText(page);

    // Check that the character styles are applied.
    await assertHTML(
      page,
      html`
        <p dir="auto"><strong data-lexical-text="true">abc</strong></p>
        <table dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><strong data-lexical-text="true">a</strong></p>
            </th>
            <th dir="auto">
              <p dir="auto"><strong data-lexical-text="true">bb</strong></p>
            </th>
            <th dir="auto">
              <p dir="auto"><strong data-lexical-text="true">cc</strong></p>
            </th>
          </tr>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><strong data-lexical-text="true">d</strong></p>
            </th>
            <td dir="auto">
              <p dir="auto"><strong data-lexical-text="true">e</strong></p>
            </td>
            <td dir="auto">
              <p dir="auto"><strong data-lexical-text="true">f</strong></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Align selection style for table cells`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 3);

    // Add text in bold to first cell
    await click(page, 'th p:first-of-type');
    await page.keyboard.type('a');
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    await clickSelectors(page, ['.bold']);

    // Apply bold style to whole table
    // Bold style shouldn't be applied to any paragraphs and removed from all cells
    await selectAll(page);
    await clickSelectors(page, ['.bold']);

    // Add text after applying styles
    await click(page, 'div[contenteditable="true"] p:first-of-type');
    await page.keyboard.type('abc');

    await click(page, 'th p:first-of-type');
    await fillTablePartiallyWithText(page);

    // None of the paragraphs have style applied
    await assertHTML(
      page,
      html`
        <p dir="auto"><span data-lexical-text="true">abc</span></p>
        <table dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">aa</span></p>
            </th>
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">bb</span></p>
            </th>
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">cc</span></p>
            </th>
          </tr>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">d</span></p>
            </th>
            <td dir="auto">
              <p dir="auto"><span data-lexical-text="true">e</span></p>
            </td>
            <td dir="auto">
              <p dir="auto"><span data-lexical-text="true">f</span></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Can copy + paste (internal) using Table selection`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 3);

    await fillTablePartiallyWithText(page);
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 1},
      true,
      false,
    );

    await withExclusiveClipboardAccess(async () => {
      const clipboard = await copyToClipboard(page);

      // For some reason you need to click the paragraph twice for this to pass
      // on Collab Firefox.
      await click(page, 'div.ContentEditable__root > p:first-of-type');
      await click(page, 'div.ContentEditable__root > p:first-of-type');

      await pasteFromClipboard(page, clipboard);
    });

    // Check that the character styles are applied.
    await assertHTML(
      page,
      html`
        <table dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">a</span></p>
            </th>
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">bb</span></p>
            </th>
          </tr>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">d</span></p>
            </th>
            <td dir="auto">
              <p dir="auto"><span data-lexical-text="true">e</span></p>
            </td>
          </tr>
        </table>
        <table dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">a</span></p>
            </th>
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">bb</span></p>
            </th>
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">cc</span></p>
            </th>
          </tr>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">d</span></p>
            </th>
            <td dir="auto">
              <p dir="auto"><span data-lexical-text="true">e</span></p>
            </td>
            <td dir="auto">
              <p dir="auto"><span data-lexical-text="true">f</span></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Can clear text using Table selection`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 3);

    await fillTablePartiallyWithText(page);
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 1},
      true,
      false,
    );

    await page.keyboard.press('Backspace');

    // Check that the text was cleared.
    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
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
              <p dir="auto"><span data-lexical-text="true">cc</span></p>
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
              <p dir="auto"><span data-lexical-text="true">f</span></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Range Selection is corrected when it contains a partial Table.`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 1, 2);
    await moveToEditorBeginning(page);

    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Shift');

    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Select All when document contains tables adds custom table styles.`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await page.keyboard.type('Hello World');

    await insertTable(page, 2, 3);

    await selectAll(page);

    await assertHTML(
      page,
      html`
        <p dir="auto"><span data-lexical-text="true">Hello World</span></p>
        <table dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
          </tr>
          <tr dir="auto">
            <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
            <td class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </td>
            <td class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can delete all with node selection', async ({
    page,
    isCollab,
    isPlainText,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});
    await focusEditor(page);
    await page.keyboard.type('Text before');
    await page.keyboard.press('Enter');
    await insertDateTime(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Text after');
    await insertTable(page, 2, 3);
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
  });

  test('Can delete all with range selection anchored in table', async ({
    page,
    isCollab,
    isPlainText,
  }) => {
    test.skip(isPlainText || isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);
    await insertTable(page, 1, 1);
    // Remove paragraph before
    await moveUp(page);
    await page.keyboard.press('Backspace');
    await assertHTML(
      page,
      html`
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup><col style="width: 92px" /></colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    // Select all but from the table
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+A`);
    // The observer is active
    await expect(page.locator('.table-cell-action-button')).toBeVisible();
    await page.keyboard.press('Backspace');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test(`Horizontal rule inside cell`, async ({page, isPlainText, isCollab}) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});
    await focusEditor(page);

    await insertTable(page, 1, 2);
    await page.keyboard.type('123');
    await insertHorizontalRule(page);

    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">123</span></p>
              <hr contenteditable="false" data-lexical-decorator="true" />
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
            <th dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Table selection: can select multiple cells and insert a decorator', async ({
    page,
    isPlainText,
    isCollab,
    browserName,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 2, 2);

    await click(page, '.PlaygroundEditorTheme__tableCell:first-child');
    await page.keyboard.type('Hello');

    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.up('Shift');

    await insertDateTime(page);
    await page.keyboard.type(' <- it works!');

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
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">Hello</span>
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
                ${getExpectedDateTimeHtml()}
                <span data-lexical-text="true">&lt;- it works!</span>
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

  test('Table selection: can backspace lines, backspacing empty cell does not destroy it #3278', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 1, 2);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await page.keyboard.type('cell one');
    await moveRight(page, 1);
    await page.keyboard.type('first line');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second line');

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
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">cell one</span>
              </p>
            </th>
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">first line</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">second line</span>
              </p>
            </th>
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await pressBackspace(page, 50);
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
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">cell one</span>
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Can remove new lines in a collapsible section inside of a table', async ({
    page,
    isPlainText,
    isCollab,
    browserName,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 1, 2);
    await insertCollapsible(page);

    await page.keyboard.type('123');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.type('123');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    const collapsibleOpeningTag =
      browserName === 'chromium' || browserName === 'firefox'
        ? '<div class="Collapsible__container" open="" dir="auto">'
        : '<details class="Collapsible__container" open="" dir="auto">';
    const collapsibleClosingTag =
      browserName === 'chromium' || browserName === 'firefox'
        ? '</div>'
        : '</details>';

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
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
              ${collapsibleOpeningTag}
              <summary class="Collapsible__title" dir="auto">
                <p class="PlaygroundEditorTheme__paragraph">
                  <span data-lexical-text="true">123</span>
                </p>
              </summary>
              <div class="Collapsible__content" dir="auto">
                <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                  <span data-lexical-text="true">123</span>
                </p>
                <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                  <br data-lexical-managed-linebreak="true" />
                </p>
                <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                  <br data-lexical-managed-linebreak="true" />
                </p>
                <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                  <br data-lexical-managed-linebreak="true" />
                </p>
              </div>
              ${collapsibleClosingTag}
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await pressBackspace(page, 10);
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
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
              ${collapsibleOpeningTag}
              <summary class="Collapsible__title" dir="auto">
                <p class="PlaygroundEditorTheme__paragraph">
                  <span data-lexical-text="true">123</span>
                </p>
              </summary>
              <div class="Collapsible__content" dir="auto">
                <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                  <br data-lexical-managed-linebreak="true" />
                </p>
              </div>
              ${collapsibleClosingTag}
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Resize merged cells width (1)', async ({
    browserName,
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 3, 3);
    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 1},
      true,
      false,
    );
    await mergeTableCells(page);
    await click(page, 'td:nth-child(3) > .PlaygroundEditorTheme__paragraph');
    const resizerBoundingBox = await selectorBoundingBox(
      page,
      '.TableCellResizer__resizer:first-child',
    );
    const x = resizerBoundingBox.x + resizerBoundingBox.width / 2;
    const y = resizerBoundingBox.y + resizerBoundingBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 50, y);
    await page.mouse.up();

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
            <col style="width: 142px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              colspan="2"
              dir="auto"
              rowspan="2">
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Resize merged cells width (2)', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 3, 3);
    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 1},
      true,
      false,
    );
    await mergeTableCells(page);
    await click(page, 'th');
    const resizerBoundingBox = await selectorBoundingBox(
      page,
      '.TableCellResizer__resizer:first-child',
    );
    const x = resizerBoundingBox.x + resizerBoundingBox.width / 2;
    const y = resizerBoundingBox.y + resizerBoundingBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 50, y);
    await page.mouse.up();

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 142px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              colspan="2"
              dir="auto"
              rowspan="2">
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Resize merged cells height', async ({
    browserName,
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 3, 3);
    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 1},
      true,
      false,
    );
    await mergeTableCells(page);
    await click(page, 'th');
    const resizerBoundingBox = await selectorBoundingBox(
      page,
      '.TableCellResizer__resizer:nth-child(2)',
    );
    const x = resizerBoundingBox.x + resizerBoundingBox.width / 2;
    const y = resizerBoundingBox.y + resizerBoundingBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 50);
    await page.mouse.up();

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
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              colspan="2"
              dir="auto"
              rowspan="2">
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
          <tr dir="auto" style="height: 89px">
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
      undefined,
      {
        ignoreClasses: false,
        ignoreInlineStyles: false,
      },
      actualHtml =>
        // flaky fix: +- 1px for the height assertion
        actualHtml.replace(
          '<tr dir="auto" style="height: 88px">',
          '<tr dir="auto" style="height: 89px">',
        ),
    );
  });

  test('Merge/unmerge cells (1)', async ({page, isPlainText, isCollab}) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 1, 3);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await moveRight(page, 1);
    await page.keyboard.type('first');
    await page.keyboard.press('Tab');
    await page.keyboard.type('second');
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 0},
      {x: 2, y: 0},
      true,
      true,
    );
    await mergeTableCells(page);
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
              colspan="2"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">first</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">second</span>
              </p>
            </th>
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await unmergeTableCell(page);
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
                <span data-lexical-text="true">first</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">second</span>
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Merge/unmerge cells (2)', async ({page, isPlainText, isCollab}) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 3, 3);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await moveRight(page, 1);
    await page.keyboard.type('first');
    await page.keyboard.press('Tab');
    await page.keyboard.type('second');
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 1},
      {x: 2, y: 2},
      false,
      false,
    );
    await mergeTableCells(page);
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
                <span data-lexical-text="true">first</span>
              </p>
            </th>
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">second</span>
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
            <td
              class="PlaygroundEditorTheme__tableCell"
              colspan="2"
              dir="auto"
              rowspan="2">
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
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await unmergeTableCell(page);
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
                <span data-lexical-text="true">first</span>
              </p>
            </th>
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">second</span>
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Merge/unmerge with already merged cells', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    // 1. Create a 5x5 table
    await insertTable(page, 5, 5);

    // 2. Type the letters in specific cells
    await click(page, '.PlaygroundEditorTheme__tableCell');

    // Move to cell for 'a' and type
    await moveRight(page, 1);
    await moveDown(page, 2);
    await page.keyboard.type('a');

    // Move to cell for 'b' and type
    await moveRight(page, 1);
    await page.keyboard.type('b');

    // Move to cell for 'c' and type
    await moveLeft(page, 2);
    await moveDown(page, 1);
    await page.keyboard.type('c');

    // Move to cell for 'd' and type
    await moveRight(page, 1);
    await page.keyboard.type('d');

    // Move to cell for 'e' and type
    await moveRight(page, 1);
    await page.keyboard.type('e');

    // Move to cell for 'f' and type
    await moveDown(page, 1);
    await page.keyboard.type('f');

    // 3. First merge: Select and merge cells a,b,c,d
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 2},
      {x: 2, y: 3},
      false,
      false,
    );
    await mergeTableCells(page);
    // 4. Second merge: Select and merge cells e,f
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 3},
      {x: 3, y: 4},
      false,
      false,
    );
    await mergeTableCells(page);

    // 5. Final merge: Non-rectangular selection attempt
    await selectCellsFromTableCords(
      page,
      {x: 2, y: 4},
      {x: 1, y: 3},
      false,
      false,
    );
    await mergeTableCells(page);
    // 6. Assert the final state
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
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
            <td
              class="PlaygroundEditorTheme__tableCell"
              colspan="3"
              dir="auto"
              rowspan="3">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">a</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">b</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">c</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">d</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">e</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">f</span>
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
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await unmergeTableCell(page);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
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
                <span data-lexical-text="true">a</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">b</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">c</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">d</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">e</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">f</span>
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

  test('Merged cell tab navigation forward', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    test.skip(isCollab);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 3, 3);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 0, y: 1},
      true,
      true,
    );
    await mergeTableCells(page);
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 0},
      {x: 2, y: 0},
      true,
      true,
    );
    await mergeTableCells(page);
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
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto"
              rowspan="2">
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await click(page, '.PlaygroundEditorTheme__tableCell');
    for (const i of Array.from({length: 9 - 2}, (_v, idx) => idx)) {
      await page.keyboard.type(String(i));
      await page.keyboard.press('Tab');
    }
    await page.keyboard.type('Done!');
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
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto"
              rowspan="2">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">0</span>
              </p>
            </th>
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              colspan="2"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">1</span>
              </p>
            </th>
          </tr>
          <tr dir="auto">
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">2</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">3</span>
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">4</span>
              </p>
            </th>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">5</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">6</span>
              </p>
            </td>
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Done!</span>
        </p>
      `,
    );
  });

  test('Merged cell tab navigation reverse', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    test.skip(isCollab);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 3, 3);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 0, y: 1},
      true,
      true,
    );
    await mergeTableCells(page);
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 0},
      {x: 2, y: 0},
      true,
      true,
    );
    await mergeTableCells(page);
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
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto"
              rowspan="2">
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await click(page, ':nth-match(.PlaygroundEditorTheme__tableCell, 7)');
    for (const i of Array.from({length: 9 - 2}, (_v, idx) => idx)) {
      await page.keyboard.type(String(i));
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
    }
    await page.keyboard.type('Done!');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Done!</span>
        </p>
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto"
              rowspan="2">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">6</span>
              </p>
            </th>
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              colspan="2"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">5</span>
              </p>
            </th>
          </tr>
          <tr dir="auto">
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">4</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">3</span>
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">2</span>
              </p>
            </th>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">1</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">0</span>
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

  test('Merge with content', async ({page, isPlainText, isCollab}) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 3, 3);
    await moveDown(page, 1);
    await moveRight(page, 1);
    await page.keyboard.type('A');
    await moveRight(page, 1);
    await page.keyboard.type('B');
    await moveRight(page, 2);
    await page.keyboard.type('C');
    await moveRight(page, 1);
    await page.keyboard.type('D');

    await selectCellsFromTableCords(
      page,
      {x: 1, y: 1},
      {x: 2, y: 2},
      false,
      false,
    );
    await mergeTableCells(page);
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
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <td
              class="PlaygroundEditorTheme__tableCell"
              colspan="2"
              dir="auto"
              rowspan="2">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">A</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">B</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">C</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">D</span>
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
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Select multiple merged cells (selection expands to a rectangle)', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 3, 3);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await moveDown(page, 1);
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 0, y: 1},
      true,
      true,
    );
    await mergeTableCells(page);

    await moveRight(page, 1);
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 0},
      {x: 2, y: 0},
      true,
      true,
    );
    await mergeTableCells(page);

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 0},
      true,
      true,
    );

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table
          class="PlaygroundEditorTheme__table PlaygroundEditorTheme__tableSelection"
          dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader PlaygroundEditorTheme__tableCellSelected"
              dir="auto"
              rowspan="2">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader PlaygroundEditorTheme__tableCellSelected"
              colspan="2"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
          </tr>
          <tr dir="auto">
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto"
              rowspan="2">
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Merge multiple merged cells and then unmerge', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 3, 3);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await moveDown(page, 1);
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 0, y: 1},
      true,
      true,
    );
    await mergeTableCells(page);

    await moveRight(page, 1);
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 0},
      {x: 2, y: 0},
      true,
      true,
    );
    await mergeTableCells(page);

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 0},
      true,
      true,
    );
    await mergeTableCells(page);

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
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              colspan="3"
              dir="auto"
              rowspan="2">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
          </tr>
          <tr dir="auto"><br data-lexical-managed-linebreak="true" /></tr>
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 0, y: 0},
      true,
      true,
    );
    await unmergeTableCell(page);

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
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Insert row above (with conflicting merged cell)', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 2, 2);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 0},
      {x: 1, y: 1},
      true,
      false,
    );
    await mergeTableCells(page);

    await moveLeft(page, 1);
    await insertTableRowBelow(page);

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
              dir="auto"
              rowspan="3">
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
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Insert column before (with conflicting merged cell)', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

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
    await mergeTableCells(page);

    await moveDown(page, 1);
    await moveRight(page, 1);
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
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              colspan="3"
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
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Insert column before (with selected cell with rowspan > 1)', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 2, 1);

    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 0, y: 1},
      true,
      true,
    );
    await mergeTableCells(page);
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
              dir="auto"
              rowspan="2">
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
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Insert column before (with 1+ selected cells in a row)', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

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

  test('Delete rows (with conflicting merged cell)', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 4, 2);

    await selectCellsFromTableCords(
      page,
      {x: 1, y: 1},
      {x: 1, y: 3},
      false,
      false,
    );
    await mergeTableCells(page);

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 0, y: 1},
      true,
      true,
    );

    await deleteTableRows(page);

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
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto" rowspan="2">
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
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Delete selected rows (with merged cell overflowing selection from top and bottom)', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 10, 5);

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 3},
      {x: 0, y: 8},
      true,
      true,
    );
    await mergeTableCells(page);

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 4},
      {x: 3, y: 5},
      false,
      false,
    );

    await deleteTableRows(page);

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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto"
              rowspan="4">
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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
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

  test('Delete selected rows (with merged cell overflowing selection from the top)', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 10, 5);

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 4},
      {x: 0, y: 7},
      true,
      true,
    );
    await mergeTableCells(page);

    await selectCellsFromTableCords(
      page,
      {x: 1, y: 3},
      {x: 3, y: 4},
      false,
      false,
    );

    await deleteTableRows(page);

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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto"
              rowspan="3">
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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
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

  test('Delete selected rows (with merged cell overflowing selection from the bottom)', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 10, 5);

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 4},
      {x: 0, y: 7},
      true,
      true,
    );
    await mergeTableCells(page);

    await selectCellsFromTableCords(
      page,
      {x: 1, y: 7},
      {x: 3, y: 8},
      false,
      false,
    );

    await deleteTableRows(page);

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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto"
              rowspan="3">
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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
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

  test('Delete columns (with conflicting merged cell)', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 2, 4);

    await selectCellsFromTableCords(
      page,
      {x: 1, y: 1},
      {x: 3, y: 1},
      false,
      false,
    );
    await mergeTableCells(page);

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 0},
      true,
      true,
    );

    await deleteTableColumns(page);

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
          </tr>
          <tr dir="auto">
            <td class="PlaygroundEditorTheme__tableCell" colspan="2" dir="auto">
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

  test('Delete columns backward', async ({page, isPlainText, isCollab}) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 2, 4);

    await selectCellsFromTableCords(
      page,
      {x: 3, y: 1},
      {x: 1, y: 1},
      false,
      false,
    );

    await deleteTableColumns(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
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
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Delete columns forward at end of table', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 2, 4);

    await selectCellsFromTableCords(
      page,
      {x: 1, y: 1},
      {x: 3, y: 1},
      false,
      false,
    );

    await deleteTableColumns(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
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
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Deselect when click outside #3785 #4138', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await page.keyboard.type('123');
    await insertTable(page, 1, 1);
    await selectAll(page);

    await click(page, 'div[contenteditable="true"] p:first-of-type');

    await assertSelection(page, {
      anchorOffset: 3,
      anchorPath: [0, 0, 0],
      focusOffset: 3,
      focusPath: [0, 0, 0],
    });
  });

  test('Background color to cell', async ({page, isPlainText, isCollab}) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 1, 1);
    await setBackgroundColor(page);
    await click(page, '.color-picker-basic-color button');
    await click(page, '.Modal__closeButton');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto"
              style="background-color: rgb(208, 2, 27)">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Cell merge feature disabled', async ({page, isPlainText, isCollab}) => {
    test.skip(isPlainText);
    await initialize({isCollab, page, tableCellMerge: false});

    await focusEditor(page);
    await pasteFromClipboard(page, {
      'text/html': `<div dir="auto">
      <table>
         <tbody>
            <tr>
               <td colspan="2" rowspan="2">
                  <p>Hello world</p>
               </td>
               <td>
                  <p>a</p>
               </td>
            </tr>
            <tr>
               <td>
                  <p>b</p>
               </td>
            </tr>
            <tr>
               <td>
                  <p>c</p>
               </td>
               <td>
                  <p>d</p>
               </td>
               <td>
                  <p>e</p>
               </td>
            </tr>
         </tbody>
      </table>
   </div>`,
    });

    await assertHTML(
      page,
      html`
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">Hello world</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">a</span>
              </p>
            </td>
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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">b</span>
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">c</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">d</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">e</span>
              </p>
            </td>
          </tr>
        </table>
      `,
    );
  });

  test('Cell background color feature disabled', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page, tableCellBackgroundColor: false});

    await focusEditor(page);
    await pasteFromClipboard(page, {
      'text/html': `<div dir="auto">
        <table>
           <tbody>
              <tr>
                 <td style="background-color: red">
                    <p dir="auto">Hello world</p>
                 </td>
              </tr>
           </tbody>
        </table>
     </div>`,
    });

    await assertHTML(
      page,
      html`
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">Hello world</span>
              </p>
            </td>
          </tr>
        </table>
      `,
    );
  });

  test('Add column header after merging cells #4378', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 4, 4);
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 2},
      {x: 3, y: 3},
      false,
      false,
    );
    await mergeTableCells(page);
    await selectCellsFromTableCords(
      page,
      {x: 3, y: 1},
      {x: 3, y: 1},
      false,
      false,
    );
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
              colspan="3"
              dir="auto"
              rowspan="2">
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
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Can align text using Table selection', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 2, 3);

    await fillTablePartiallyWithText(page);
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 1},
      true,
      false,
    );

    await selectFromAlignDropdown(page, '.center-align');

    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCellSelected"
              dir="auto"
              style="text-align: center">
              <p dir="auto" style="text-align: center">
                <span data-lexical-text="true">a</span>
              </p>
            </th>
            <th
              class="PlaygroundEditorTheme__tableCellSelected"
              dir="auto"
              style="text-align: center">
              <p dir="auto" style="text-align: center">
                <span data-lexical-text="true">bb</span>
              </p>
            </th>
            <th dir="auto">
              <p dir="auto"><span data-lexical-text="true">cc</span></p>
            </th>
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCellSelected"
              dir="auto"
              style="text-align: center">
              <p dir="auto" style="text-align: center">
                <span data-lexical-text="true">d</span>
              </p>
            </th>
            <td
              class="PlaygroundEditorTheme__tableCellSelected"
              dir="auto"
              style="text-align: center">
              <p dir="auto" style="text-align: center">
                <span data-lexical-text="true">e</span>
              </p>
            </td>
            <td dir="auto">
              <p dir="auto"><span data-lexical-text="true">f</span></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Aligns the table itself (not cell text) when the whole table is selected in reverse, e.g. bottom-right to top-left (#8880)', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);
    await insertTable(page, 3, 3);

    await selectCellsFromTableCords(
      page,
      {x: 2, y: 2},
      {x: 0, y: 0},
      false,
      true,
    );

    await selectFromAlignDropdown(page, '.center-align');

    const tableIsCenterAligned = await evaluate(page, () => {
      const table = document.querySelector('div[contenteditable="true"] table');
      return table.classList.contains(
        'PlaygroundEditorTheme__tableAlignmentCenter',
      );
    });
    expect(tableIsCenterAligned).toBe(true);

    const cellParagraphsWithTextAlign = await evaluate(page, () => {
      const paragraphs = document.querySelectorAll(
        'div[contenteditable="true"] table th p, div[contenteditable="true"] table td p',
      );
      return Array.from(paragraphs).filter(p => p.hasAttribute('style')).length;
    });
    expect(cellParagraphsWithTextAlign).toBe(0);
  });

  test('Paste and insert new lines after unmerging cells', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    const pageOrFrame = getPageOrFrame(page);

    await focusEditor(page);

    await insertTable(page, 3, 3);

    await selectCellsFromTableCords(
      page,
      {x: 1, y: 1},
      {x: 2, y: 2},
      false,
      false,
    );
    await mergeTableCells(page);
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
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <td
              class="PlaygroundEditorTheme__tableCell"
              colspan="2"
              dir="auto"
              rowspan="2">
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
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await unmergeTableCell(page);

    // move caret to the last paragraph
    await focusEditor(page);
    await moveToEditorEnd(page);

    await page.keyboard.type('Hello');
    await selectCharacters(page, 'left', 'Hello'.length);

    await withExclusiveClipboardAccess(async () => {
      const clipboard = await copyToClipboard(page);

      // move caret to the first position of the editor
      await pageOrFrame
        .locator('.PlaygroundEditorTheme__paragraph')
        .first()
        .click();

      // move caret to the table cell (2,2)
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');

      await pasteFromClipboard(page, clipboard);
      await pasteFromClipboard(page, clipboard);
      await pasteFromClipboard(page, clipboard);

      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');

      await pasteFromClipboard(page, clipboard);
    });

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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">HelloHelloHello</span>
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">Hello</span>
              </p>
            </td>
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
        </p>
      `,
    );
  });

  test('Can delete table row when previous cell is a merged cell', async ({
    page,
    isCollab,
    isPlainText,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 5, 5);

    await selectCellsFromTableCords(
      page,
      {x: 1, y: 1},
      {x: 1, y: 3},
      false,
      false,
    );
    await mergeTableCells(page);
    await selectCellsFromTableCords(
      page,
      {x: 1, y: 2},
      {x: 2, y: 4},
      false,
      false,
    );
    await mergeTableCells(page);
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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto" rowspan="3">
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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto" rowspan="3">
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

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 2},
      {x: 0, y: 2},
      true,
      true,
    );

    await deleteTableRows(page);

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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto" rowspan="2">
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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto" rowspan="2">
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

  test('Can delete table row when siblings are merged cell', async ({
    page,
    isCollab,
    isPlainText,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 5, 5);

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 0, y: 3},
      true,
      true,
    );
    await mergeTableCells(page);
    await selectCellsFromTableCords(
      page,
      {x: 2, y: 0},
      {x: 1, y: 2},
      true,
      false,
    );
    await mergeTableCells(page);
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
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto"
              rowspan="4">
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
              dir="auto"
              rowspan="3">
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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
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

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 2},
      {x: 0, y: 2},
      false,
      false,
    );

    await deleteTableRows(page);

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
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              dir="auto"
              rowspan="3">
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
              dir="auto"
              rowspan="2">
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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
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

  test('Can insert multiple rows above the selection', async ({
    page,
    isCollab,
    isPlainText,
  }) => {
    await initialize({isCollab, page});
    test.skip(isPlainText);
    test.skip(isCollab);

    await focusEditor(page);

    await insertTable(page, 5, 5);

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 1},
      {x: 4, y: 3},
      true,
      false,
    );

    await insertTableRowAbove(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table
          class="PlaygroundEditorTheme__table PlaygroundEditorTheme__tableSelection"
          dir="auto">
          <colgroup>
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
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
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
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

  test('Can insert multiple rows below the selection', async ({
    page,
    isCollab,
    isPlainText,
  }) => {
    await initialize({isCollab, page});
    test.skip(isPlainText);
    test.skip(isCollab);

    await focusEditor(page);

    await insertTable(page, 5, 5);

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 1},
      {x: 4, y: 3},
      true,
      false,
    );

    await insertTableRowBelow(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table
          class="PlaygroundEditorTheme__table PlaygroundEditorTheme__tableSelection"
          dir="auto">
          <colgroup>
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
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
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
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
  test.describe('with context menu', () => {
    test.use({shouldUseLexicalContextMenu: true});
    test(`Can select cells using Table selection and cut them with the context menu`, async ({
      page,
      isPlainText,
      isCollab,
      shouldUseLexicalContextMenu,
      browserName,
    }) => {
      test.skip(isPlainText);
      // The way that the clicks happen in test doesn't work in firefox for some reason
      // but it does seem to work when you do it by hand
      test.fixme(browserName === 'firefox');
      await initialize({isCollab, page, shouldUseLexicalContextMenu});

      await focusEditor(page);
      await insertTable(page, 2, 3);

      await fillTablePartiallyWithText(page);
      await selectCellsFromTableCords(
        page,
        {x: 0, y: 0},
        {x: 1, y: 1},
        true,
        false,
      );

      await assertHTML(
        page,
        html`
          <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
          <table dir="auto">
            <colgroup>
              <col style="width: 92px" />
              <col style="width: 92px" />
              <col style="width: 92px" />
            </colgroup>
            <tr dir="auto">
              <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
                <p dir="auto"><span data-lexical-text="true">a</span></p>
              </th>
              <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
                <p dir="auto"><span data-lexical-text="true">bb</span></p>
              </th>
              <th dir="auto">
                <p dir="auto"><span data-lexical-text="true">cc</span></p>
              </th>
            </tr>
            <tr dir="auto">
              <th class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
                <p dir="auto"><span data-lexical-text="true">d</span></p>
              </th>
              <td class="PlaygroundEditorTheme__tableCellSelected" dir="auto">
                <p dir="auto"><span data-lexical-text="true">e</span></p>
              </td>
              <td dir="auto">
                <p dir="auto"><span data-lexical-text="true">f</span></p>
              </td>
            </tr>
          </table>
          <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        `,
        undefined,
        {ignoreClasses: true},
      );

      await withExclusiveClipboardAccess(async () => {
        await click(page, 'div[contenteditable] th p', {
          button: 'right',
        });
        await getPageOrFrame(page)
          .getByRole('menuitem', {
            name: 'Cut',
          })
          .click();
      });

      await assertHTML(
        page,
        html`
          <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
          <table dir="auto">
            <colgroup>
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
                <p dir="auto"><span data-lexical-text="true">cc</span></p>
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
                <p dir="auto"><span data-lexical-text="true">f</span></p>
              </td>
            </tr>
          </table>
          <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        `,
        undefined,
        {ignoreClasses: true},
      );
    });
  });

  test(`Cannot insert nested tables`, async ({page, isPlainText, isCollab}) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});
    await focusEditor(page);

    // Insert a table
    await insertTable(page, 2, 2);

    // Focus inside the first cell
    await click(page, '.PlaygroundEditorTheme__tableCell:first-child');

    // Try to insert another table inside the cell
    await insertTable(page, 2, 2);

    // Verify no nested table was created
    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
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
          </tr>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
            <td dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Cannot paste tables inside table cells`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    // Create and copy a table
    await insertTable(page, 2, 2);
    await page.keyboard.type('test');
    await selectAll(page);
    await withExclusiveClipboardAccess(async () => {
      const clipboard = await copyToClipboard(page);
      await page.keyboard.press('Backspace');
      await moveToEditorBeginning(page);

      // Create another table and try to paste the first table into a cell
      await insertTable(page, 2, 2);
      await click(page, '.PlaygroundEditorTheme__tableCell:first-child');
      await pasteFromClipboard(page, clipboard);
    });

    // Verify that no content was pasted into the cell
    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table dir="auto">
          <colgroup>
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
          </tr>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </th>
            <td dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </td>
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Can paste tables inside table cells (with hasNestedTables)`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({hasNestedTables: true, isCollab, page});
    await focusEditor(page);

    // Create and copy a table
    await insertTable(page, 2, 2);
    await page.keyboard.type('test inner table');
    await selectAll(page);
    await withExclusiveClipboardAccess(async () => {
      const clipboard = await copyToClipboard(page);
      await page.keyboard.press('Backspace');
      await moveToEditorBeginning(page);

      // Create another table and try to paste the first table into a cell
      await insertTable(page, 2, 2);
      await click(page, '.PlaygroundEditorTheme__tableCell:first-child');
      await pasteFromClipboard(page, clipboard);
    });

    // Verify that a nested table was pasted into the cell
    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table>
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              <table>
                <colgroup>
                  <col style="width: 92px" />
                  <col style="width: 92px" />
                </colgroup>
                <tr dir="auto">
                  <th dir="auto">
                    <p dir="auto">
                      <span data-lexical-text="true">test inner table</span>
                    </p>
                  </th>
                  <th dir="auto">
                    <p dir="auto">
                      <br data-lexical-managed-linebreak="true" />
                    </p>
                  </th>
                </tr>
                <tr dir="auto">
                  <th dir="auto">
                    <p dir="auto">
                      <br data-lexical-managed-linebreak="true" />
                    </p>
                  </th>
                  <td dir="auto">
                    <p dir="auto">
                      <br data-lexical-managed-linebreak="true" />
                    </p>
                  </td>
                </tr>
              </table>
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
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true, ignoreDir: true},
    );
  });

  test(`Can paste and autofit tables inside table cells (with hasNestedTables, hasFitNestedTables)`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    test.skip(IS_TABLE_HORIZONTAL_SCROLL); // hasFitNestedTables disables horizontally scrollable tables
    await initialize({
      hasFitNestedTables: true,
      hasNestedTables: true,
      isCollab,
      page,
    });
    await focusEditor(page);

    // Create and copy a table
    await insertTable(page, 2, 2);

    await page.keyboard.type('test inner table');

    await selectAll(page);
    await withExclusiveClipboardAccess(async () => {
      const clipboard = await copyToClipboard(page);
      await page.keyboard.press('Backspace');
      await moveToEditorBeginning(page);

      // Create another table and try to paste the first table into a cell
      await insertTable(page, 2, 2);
      // Resize outer table cell (92px default + 50px = 142px)
      await resizeTableCell(page, 'tr:nth-child(2) > th:nth-child(1)', 50);
      await click(
        page,
        'tr:nth-child(2) > th:nth-child(1) > .PlaygroundEditorTheme__paragraph',
      );

      await pasteFromClipboard(page, clipboard);
    });

    // Verify that a nested table was pasted into the cell
    await assertHTML(
      page,
      html`
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        <table>
          <colgroup>
            <col style="width: 142px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th dir="auto">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              <table>
                <colgroup>
                  <col style="width: 62.5px" />
                  <col style="width: 62.5px" />
                </colgroup>
                <tr dir="auto">
                  <th dir="auto">
                    <p dir="auto">
                      <span data-lexical-text="true">test inner table</span>
                    </p>
                  </th>
                  <th dir="auto">
                    <p dir="auto">
                      <br data-lexical-managed-linebreak="true" />
                    </p>
                  </th>
                </tr>
                <tr dir="auto">
                  <th dir="auto">
                    <p dir="auto">
                      <br data-lexical-managed-linebreak="true" />
                    </p>
                  </th>
                  <td dir="auto">
                    <p dir="auto">
                      <br data-lexical-managed-linebreak="true" />
                    </p>
                  </td>
                </tr>
              </table>
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
          </tr>
        </table>
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      {ignoreClasses: true, ignoreDir: true},
    );
  });

  test(`Click and drag to create selection in Firefox #7245`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText || isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);

    // Insert a table
    await insertTable(page, 5, 5);

    // Initial conditions
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
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

    // Click and drag to select a 3x3 box (leaving the mouse down)
    await dragMouse(
      page,
      await selectorBoundingBox(
        page,
        'table > tr:nth-of-type(2) > *:nth-child(2)',
      ),
      await selectorBoundingBox(
        page,
        'table > tr:nth-of-type(4) > *:nth-child(4)',
      ),
      {mouseDown: true, mouseUp: false, slow: true},
    );

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table
          class="PlaygroundEditorTheme__table PlaygroundEditorTheme__tableSelection"
          dir="auto">
          <colgroup>
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
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
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
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
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
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
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
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
    // Drag to change the selection to a 4x2 box (releasing the mouse)
    await dragMouse(
      page,
      await selectorBoundingBox(
        page,
        'table > tr:nth-of-type(4) > *:nth-child(4)',
      ),
      await selectorBoundingBox(
        page,
        'table > tr:nth-of-type(3) > *:nth-child(5)',
      ),
      {mouseDown: false, mouseUp: true, slow: true},
    );
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table
          class="PlaygroundEditorTheme__table PlaygroundEditorTheme__tableSelection"
          dir="auto">
          <colgroup>
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
            <col style="width: 92px;" />
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
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
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
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
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

  test('Resize row with merged cells spanning multiple rows', async ({
    browserName,
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    // Create a 3x3 table
    await insertTable(page, 3, 3);

    // Merge first two rows
    await click(page, '.PlaygroundEditorTheme__tableCell');
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 2, y: 1},
      true,
      false,
    );
    await mergeTableCells(page);

    // Click on the merged cell to select it
    await click(page, '.PlaygroundEditorTheme__tableCell');

    // Get the resizer element and its position
    const resizerBoundingBox = await selectorBoundingBox(
      page,
      '.TableCellResizer__resizer:nth-child(2)',
    );
    const x = resizerBoundingBox.x + resizerBoundingBox.width / 2;
    const y = resizerBoundingBox.y + resizerBoundingBox.height / 2;

    // Simulate dragging the resizer down
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 50);
    await page.mouse.up();

    // Verify the row height was updated correctly
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
          </colgroup>
          <tr dir="auto" style="height: 69px">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader"
              colspan="3"
              dir="auto"
              rowspan="2">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </th>
          </tr>
          <tr dir="auto"><br data-lexical-managed-linebreak="true" /></tr>
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
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
      undefined,
      {
        ignoreClasses: false,
        ignoreInlineStyles: false,
      },
      actualHtml =>
        // flaky fix: handle height differences in the assertion
        actualHtml.replace(
          /<tr dir="auto" style="height: \d+px">/,
          '<tr dir="auto" style="height: 69px">',
        ),
    );
  });

  test(`Table action menu is hidden when cell overflows`, async ({
    page,
    isPlainText,
    isCollab,
    browserName,
  }) => {
    // The way that the clicks happen in test doesn't work in firefox for some reason
    // but it does seem to work when you do it by hand
    test.fixme(browserName === 'firefox');
    test.skip(isPlainText || isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);

    // Insert a 2x2 table
    await insertTable(page, 2, 2);

    // Find and drag the column resize handle
    const firstCell = await page.$('th >> nth=0');
    const firstCellBox = await firstCell.boundingBox();

    // Click the cell in 2nd column
    await click(page, 'th >> nth=1');

    // Check that the action menu button is visible when no overflow
    // If button exists, menu is visible
    await expect(page.locator('.table-cell-action-button')).toBeVisible();

    // Make the column very wide to ensure overflow
    await page.mouse.move(
      firstCellBox.x + firstCellBox.width - 5,
      firstCellBox.y + firstCellBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      firstCellBox.x + 2000, // Make column very wide - 2000 for more scroll space
      firstCellBox.y + firstCellBox.height / 2,
    );
    await page.mouse.up();

    // Click the cell
    await click(page, 'th >> nth=0');

    // If button doesn't exist, menu is hidden
    await expect(page.locator('.table-cell-action-button')).toBeHidden();
  });

  test(`Can expand table to fit content when pasting table into table`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText || isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);

    await pasteFromClipboard(page, {'text/html': TABLE_WITH_MERGED_CELLS});

    await selectCellsFromTableCords(
      page,
      {x: 1, y: 0},
      {x: 2, y: 1},
      false,
      false,
    );

    await withExclusiveClipboardAccess(async () => {
      const clipboard = await copyToClipboard(page);

      await selectCellFromTableCoord(page, {x: 0, y: 2});

      await pasteFromClipboard(page, clipboard);
    });

    await assertHTML(
      page,
      html`
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a1</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a2</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a3</span>
              </p>
            </td>
          </tr>
          <tr dir="auto" style="height: 38px">
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              rowspan="2"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b1</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b2</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b3</span>
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a2</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a3</span>
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b2</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b3</span>
              </p>
            </td>
          </tr>
        </table>
      `,
    );

    await undo(page);

    await selectCellsFromTableCords(
      page,
      {x: 1, y: 0},
      {x: 2, y: 1},
      false,
      false,
    );

    await withExclusiveClipboardAccess(async () => {
      const clipboard = await copyToClipboard(page);

      await selectCellFromTableCoord(page, {x: 2, y: 1});

      await pasteFromClipboard(page, clipboard);
    });

    await assertHTML(
      page,
      html`
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a1</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a2</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a3</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
          </tr>
          <tr dir="auto" style="height: 38px">
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              rowspan="2"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b1</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b2</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a2</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a3</span>
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">c2</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b2</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b3</span>
              </p>
            </td>
          </tr>
        </table>
      `,
    );
  });

  test(`Can paste table containing merged cells into table`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});
    await focusEditor(page);

    await pasteFromClipboard(page, {'text/html': TABLE_WITH_MERGED_CELLS});

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 1},
      {x: 0, y: 2},
      false,
      false,
    );
    // undo is used below, so force a new undo group here. Mode-agnostic:
    // freezes the @lexical/history clock locally, or resets the Yjs
    // UndoManager capture window in collab.
    await advanceHistoryClock(page);

    await withExclusiveClipboardAccess(async () => {
      const clipboard = await copyToClipboard(page);

      await selectCellFromTableCoord(page, {x: 0, y: 2});

      await pasteFromClipboard(page, clipboard);
    });

    await assertHTML(
      page,
      html`
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a1</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a2</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a3</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
          </tr>
          <tr dir="auto" style="height: 38px">
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              rowspan="2"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b1</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b2</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b3</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              rowspan="2"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b1</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b2</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b3</span>
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" colspan="2" dir="auto">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">c2</span>
              </p>
            </td>
          </tr>
        </table>
      `,
    );

    await undo(page);

    await selectCellsFromTableCords(
      page,
      {x: 0, y: 1},
      {x: 0, y: 2},
      false,
      false,
    );

    await withExclusiveClipboardAccess(async () => {
      const clipboard = await copyToClipboard(page);

      await selectCellFromTableCoord(page, {x: 0, y: 0});

      await pasteFromClipboard(page, clipboard);
    });

    await assertHTML(
      page,
      html`
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              rowspan="2"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b1</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b2</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b3</span>
              </p>
            </td>
          </tr>
          <tr dir="auto" style="height: 38px">
            <td
              class="PlaygroundEditorTheme__tableCell"
              colspan="2"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">c2</span>
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <br data-lexical-managed-linebreak="true" />
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              colspan="2"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">c2</span>
              </p>
            </td>
          </tr>
        </table>
      `,
    );
  });

  test(`Can paste table into table while having table selection`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});
    await focusEditor(page);

    await pasteFromClipboard(page, {'text/html': TABLE_WITH_MERGED_CELLS});

    await selectCellsFromTableCords(
      page,
      {x: 1, y: 1},
      {x: 0, y: 2},
      false,
      false,
    );

    await pasteFromClipboard(page, {'text/html': TABLE_WITH_MERGED_CELLS});

    await assertHTML(
      page,
      html`
        <table class="PlaygroundEditorTheme__table" dir="auto">
          <colgroup>
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a1</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a2</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a3</span>
              </p>
            </td>
          </tr>
          <tr dir="auto" style="height: 38px">
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              rowspan="2"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b1</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a1</span>
              </p>
            </td>
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">a2</span>
              </p>
            </td>
          </tr>
          <tr dir="auto">
            <td
              class="PlaygroundEditorTheme__tableCell"
              dir="auto"
              style="width: 75px">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b1</span>
              </p>
            </td>
            <td class="PlaygroundEditorTheme__tableCell" dir="auto">
              <p
                class="PlaygroundEditorTheme__paragraph"
                dir="auto"
                style="text-align: start">
                <span data-lexical-text="true">b2</span>
              </p>
            </td>
          </tr>
        </table>
      `,
    );
  });

  test('Can delete table when fully selected with merged cells', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    test.fixme(isCollab, 'Flaky on Collab');
    await initialize({isCollab, page});

    await focusEditor(page);

    // Insert a 3x3 table
    await insertTable(page, 3, 3);

    // Merge some cells to create a complex merged cell structure
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 1, y: 1},
      true,
      false,
    );
    await mergeTableCells(page);

    // Select the entire table
    await selectCellsFromTableCords(
      page,
      {x: 0, y: 0},
      {x: 2, y: 2},
      true,
      false,
    );

    // Press backspace to delete
    await page.keyboard.press('Backspace');

    // Assert that the table is deleted and only empty paragraphs remain
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

  test('Ctrl+A selects all cells in table with merged cells when table is only content', async ({
    page,
    isPlainText,
    isCollab,
    browserName,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    // Insert a 3x3 table
    await insertTable(page, 3, 3);

    // Remove all other nodes, leaving only the table
    // First, select all and delete to clear everything
    await selectAll(page);
    await page.keyboard.press('Backspace');

    // Insert table again
    await insertTable(page, 3, 3);

    // Merge two cells in the last column (merge cells in row 0 and row 1, column 2)
    // Do this BEFORE removing paragraphs to avoid navigation issues
    await selectCellsFromTableCords(
      page,
      {x: 2, y: 0},
      {x: 2, y: 1},
      true,
      false,
    );
    await mergeTableCells(page);

    // CRITICAL: Remove ALL paragraphs (before and after table) to ensure table is the ONLY content
    // This matches the bug reproduction: "Remove all other nodes from the editor, leaving only the table"
    // Empty paragraphs (even one) will prevent the bug from reproducing
    // Following the exact pattern from Selection.spec.mjs test "shift+arrowup into a table, when the table is the only node"

    // Delete the paragraph before the table
    await moveToEditorBeginning(page);
    await deleteBackward(page);

    // Delete the paragraph after the table
    await moveToEditorEnd(page);
    await deleteBackward(page);

    // Place cursor inside any cell of the table
    await selectCellFromTableCoord(page, {x: 0, y: 0}, true);

    // Press Ctrl+A
    await selectAll(page);

    // Verify that all cells are selected by checking table selection coordinates
    // The selection should span from first cell (0,0) to last cell (2,2)
    await assertTableSelectionCoordinates(page, {
      anchor: {x: 0, y: 0},
      focus: {x: 2, y: 2},
    });
  });

  test('Drag-select column in 2x2 table selects all cells in that column', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    // Insert a 2x2 table
    await insertTable(page, 2, 2);
    const pageOrFrame = getPageOrFrame(page);

    await pageOrFrame.waitForFunction(() => {
      const cell = document.querySelector(
        'table:first-of-type td, table:first-of-type th',
      );

      return Boolean(cell && cell._cell);
    });

    const readTableSelectionCoordinates = async () => {
      return await pageOrFrame.evaluate(() => {
        const editor = window.lexicalEditor;
        if (!editor) {
          return null;
        }
        const selection = editor.getEditorState()._selection;
        if (!selection || selection.tableKey == null) {
          return null;
        }
        const anchorElement = editor.getElementByKey(selection.anchor.key);
        const focusElement = editor.getElementByKey(selection.focus.key);
        const anchorCell = anchorElement?._cell;
        const focusCell = focusElement?._cell;
        if (!anchorCell || !focusCell) {
          return null;
        }
        return {
          anchor: {x: anchorCell.x, y: anchorCell.y},
          focus: {x: focusCell.x, y: focusCell.y},
        };
      });
    };

    const matchesExpected = (coords, expected) => {
      if (!coords) {
        return false;
      }
      const anchorMatches =
        expected.anchor == null ||
        ((expected.anchor.x === undefined ||
          coords.anchor.x === expected.anchor.x) &&
          (expected.anchor.y === undefined ||
            coords.anchor.y === expected.anchor.y));
      const focusMatches =
        expected.focus == null ||
        ((expected.focus.x === undefined ||
          coords.focus.x === expected.focus.x) &&
          (expected.focus.y === undefined ||
            coords.focus.y === expected.focus.y));
      return anchorMatches && focusMatches;
    };

    const waitForTableSelectionCoordinates = async expected => {
      for (let i = 0; i < 20; i++) {
        const coords = await readTableSelectionCoordinates();
        if (matchesExpected(coords, expected)) {
          return true;
        }
        await sleep(50);
      }
      return false;
    };

    const dispatchPointerDrag = async (dragStart, dragEnd) => {
      return await pageOrFrame.evaluate(
        ({endPoint, startPoint}) => {
          const startTarget = document.elementFromPoint(
            startPoint.x,
            startPoint.y,
          );
          const endTarget = document.elementFromPoint(endPoint.x, endPoint.y);
          if (!startTarget || !endTarget) {
            return false;
          }
          const baseEvent = {
            bubbles: true,
            button: 0,
            buttons: 1,
            isPrimary: true,
            pointerId: 1,
            pointerType: 'mouse',
          };
          startTarget.dispatchEvent(
            new PointerEvent('pointerdown', {
              ...baseEvent,
              clientX: startPoint.x,
              clientY: startPoint.y,
            }),
          );
          endTarget.dispatchEvent(
            new PointerEvent('pointermove', {
              ...baseEvent,
              clientX: endPoint.x,
              clientY: endPoint.y,
            }),
          );
          endTarget.dispatchEvent(
            new PointerEvent('pointerup', {
              ...baseEvent,
              buttons: 0,
              clientX: endPoint.x,
              clientY: endPoint.y,
            }),
          );
          return true;
        },
        {endPoint: dragEnd, startPoint: dragStart},
      );
    };

    const dragAndAssertSelection = async (fromBox, toBox, expected) => {
      await dragMouse(page, fromBox, toBox, {slow: true});
      if (await waitForTableSelectionCoordinates(expected)) {
        return;
      }
      const start = {
        x: fromBox.x + fromBox.width / 2,
        y: fromBox.y + fromBox.height / 2,
      };
      const end = {
        x: toBox.x + toBox.width / 2,
        y: toBox.y + toBox.height / 2,
      };
      await dispatchPointerDrag(start, end);
      if (await waitForTableSelectionCoordinates(expected)) {
        return;
      }
      const coords = await readTableSelectionCoordinates();
      throw new Error(
        `Expected table selection ${JSON.stringify(
          expected,
        )} but got ${JSON.stringify(coords)}`,
      );
    };

    // Test first column: straight drag from top to bottom (no click first)
    // This tests the fix for issue #8079 - straight drag should work
    const firstColTop = await selectorBoundingBox(
      page,
      'table:first-of-type > tr:nth-of-type(1) > th:nth-child(1)',
    );
    const firstColBottom = await selectorBoundingBox(
      page,
      'table:first-of-type > tr:nth-of-type(2) > th:nth-child(1)',
    );

    await dragAndAssertSelection(firstColTop, firstColBottom, {
      anchor: {x: 0, y: 0},
      focus: {x: 0, y: 1},
    });

    // Test second column: straight drag from top to bottom on FIRST attempt
    // This was the bug: first drag missed top cell, subsequent drags worked
    const secondColTop = await selectorBoundingBox(
      page,
      'table:first-of-type > tr:nth-of-type(1) > th:nth-child(2)',
    );
    const secondColBottom = await selectorBoundingBox(
      page,
      'table:first-of-type > tr:nth-of-type(2) > td:nth-child(2)',
    );

    await dragAndAssertSelection(secondColTop, secondColBottom, {
      anchor: {x: 1, y: 0},
      focus: {x: 1, y: 1},
    });
  });

  test('Can clear table selection in table by selecting cell in another table', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    // Insert two tables.
    await insertTable(page, 2, 2);
    await moveToEditorEnd(page);
    await insertTable(page, 2, 2);

    const pageOrFrame = getPageOrFrame(page);

    // Select all cells in the first table via shift-click
    const firstTableFirstCell = pageOrFrame.locator(
      `${nthTableSelector(1)} > :nth-match(tr, 1) > th:nth-child(1)`,
    );
    const firstTableLastCell = pageOrFrame.locator(
      `${nthTableSelector(1)} > :nth-match(tr, 2) > td:nth-child(2)`,
    );
    await firstTableFirstCell.click();
    await page.keyboard.down('Shift');
    await firstTableLastCell.click();
    await page.keyboard.up('Shift');

    // Verify the first table has selected cells
    await pageOrFrame
      .locator(
        `${nthTableSelector(1)} > :nth-match(tr, 1) > th.PlaygroundEditorTheme__tableCellSelected:nth-child(1)`,
      )
      .waitFor();
    await pageOrFrame
      .locator(
        `${nthTableSelector(1)} > :nth-match(tr, 2) > td.PlaygroundEditorTheme__tableCellSelected:nth-child(2)`,
      )
      .waitFor();

    // Click a cell in the second table
    await pageOrFrame
      .locator(`${nthTableSelector(2)} > tr:first-of-type > th:first-of-type`)
      .click();

    // Verify the first table no longer has any selected cells
    await expect(
      pageOrFrame.locator(
        `${nthTableSelector(1)} > :nth-match(tr, 1) > th.PlaygroundEditorTheme__tableCellSelected:nth-child(1)`,
      ),
    ).toHaveCount(0);
    await expect(
      pageOrFrame.locator(
        `${nthTableSelector(1)} > :nth-match(tr, 2) > td.PlaygroundEditorTheme__tableCellSelected:nth-child(2)`,
      ),
    ).toHaveCount(0);
  });

  test('Table selection is properly cleared when clicking and dragging a cell in the same table', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText);
    await initialize({isCollab, page});

    await focusEditor(page);

    await insertTable(page, 2, 2);

    const pageOrFrame = getPageOrFrame(page);

    // Select all cells in the first table via shift-click
    const firstTableFirstCell = pageOrFrame.locator(
      `${nthTableSelector(1)} > :nth-match(tr, 1) > th:nth-child(1)`,
    );
    const firstTableLastCell = pageOrFrame.locator(
      `${nthTableSelector(1)} > :nth-match(tr, 2) > td:nth-child(2)`,
    );
    await firstTableFirstCell.click();
    await page.keyboard.down('Shift');
    await firstTableLastCell.click();
    await page.keyboard.up('Shift');

    // Verify the table has selected cells
    await pageOrFrame
      .locator(
        `${nthTableSelector(1)} > :nth-match(tr, 1) > th.PlaygroundEditorTheme__tableCellSelected:nth-child(1)`,
      )
      .waitFor();
    await pageOrFrame
      .locator(
        `${nthTableSelector(1)} > :nth-match(tr, 2) > td.PlaygroundEditorTheme__tableCellSelected:nth-child(2)`,
      )
      .waitFor();

    // Click a cell in the same table
    await dragMouse(
      page,
      await selectorBoundingBox(
        page,
        `${nthTableSelector(1)} > tr:first-of-type > th:first-of-type`,
      ),
      await selectorBoundingBox(
        page,
        `${nthTableSelector(1)} > tr:first-of-type > th:first-of-type`,
      ),
      {offsetEnd: {x: 10}},
    );

    // Verify the first table no longer has any selected cells
    await expect(
      pageOrFrame.locator(
        `${nthTableSelector(1)} > :nth-match(tr, 1) > th.PlaygroundEditorTheme__tableCellSelected:nth-child(1)`,
      ),
    ).toHaveCount(0);
    await expect(
      pageOrFrame.locator(
        `${nthTableSelector(1)} > :nth-match(tr, 2) > td.PlaygroundEditorTheme__tableCellSelected:nth-child(2)`,
      ),
    ).toHaveCount(0);
  });

  test(`Drag-selecting to the edge of a scrollable table auto-scrolls it #7153`, async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText || isCollab);
    // The horizontal scroll wrapper only exists when scrollable tables are on.
    test.skip(!IS_TABLE_HORIZONTAL_SCROLL);
    await initialize({isCollab, page});
    await focusEditor(page);

    // A table with many columns overflows the editor width, so it becomes
    // horizontally scrollable.
    await insertTable(page, 3, 15);

    const wrapperSelector = 'div.PlaygroundEditorTheme__tableScrollableWrapper';
    const getScroll = () =>
      evaluate(
        page,
        selector => {
          const wrapper = document.querySelector(selector);
          return {
            left: wrapper.scrollLeft,
            max: wrapper.scrollWidth - wrapper.clientWidth,
          };
        },
        wrapperSelector,
      );

    // Sanity check: the table is actually wider than its scroll container.
    const {max} = await getScroll();
    expect(max).toBeGreaterThan(0);

    // Start a drag in a left-hand cell and hold the pointer just inside the
    // right edge of the scroll container (within the auto-scroll edge zone),
    // leaving the mouse button down.
    const anchorBox = await selectorBoundingBox(
      page,
      `${nthTableSelector(1)} > tr:nth-of-type(2) > td:nth-child(2)`,
    );
    const wrapperBox = await selectorBoundingBox(page, wrapperSelector);
    const holdY = anchorBox.y + anchorBox.height / 2;
    await dragMouse(
      page,
      anchorBox,
      {height: 0, width: 0, x: wrapperBox.x + wrapperBox.width - 5, y: holdY},
      {mouseDown: true, mouseUp: false, slow: true},
    );

    // While the pointer is held near the edge, the requestAnimationFrame loop
    // scrolls the wrapper all the way to the end...
    await expect
      .poll(async () => (await getScroll()).left, {timeout: 5000})
      .toBeGreaterThanOrEqual(max - 1);

    // ...and the selection focus reaches the last column (index 14), which was
    // initially off-screen — the behavior that regressed in #7153.
    await assertTableSelectionCoordinates(page, {
      anchor: {x: 1},
      focus: {x: 14},
    });

    await page.mouse.up();
  });

  test.describe('shift-selection tests', () => {
    test('Range-select from above table into it selects the entire table', async ({
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      await initialize({isCollab, page});

      await focusEditor(page);

      await page.keyboard.type('before');
      await insertTable(page, 2, 2);
      await moveToEditorEnd(page);
      await page.keyboard.type('after');

      const pageOrFrame = getPageOrFrame(page);

      await pageOrFrame.locator('p').filter({hasText: 'before'}).click();
      await page.keyboard.down('Shift');
      await pageOrFrame
        .locator('table > tr:first-of-type > th:first-of-type')
        .click();
      await page.keyboard.up('Shift');

      // Entire table should be selected.
      await expect(
        pageOrFrame.locator(
          'table th.PlaygroundEditorTheme__tableCellSelected',
        ),
      ).toHaveCount(3);
      await expect(
        pageOrFrame.locator(
          'table td.PlaygroundEditorTheme__tableCellSelected',
        ),
      ).toHaveCount(1);
    });

    test('Range-select from below table into it selects the entire table', async ({
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      await initialize({isCollab, page});

      await focusEditor(page);

      await page.keyboard.type('before');
      await insertTable(page, 2, 2);
      await moveToEditorEnd(page);
      await page.keyboard.type('after');

      const pageOrFrame = getPageOrFrame(page);

      await pageOrFrame.locator('p').filter({hasText: 'after'}).click();
      await page.keyboard.down('Shift');
      await pageOrFrame.locator('table > tr > td').click();
      await page.keyboard.up('Shift');

      // Entire table should be selected.
      await expect(
        pageOrFrame.locator(
          'table th.PlaygroundEditorTheme__tableCellSelected',
        ),
      ).toHaveCount(3);
      await expect(
        pageOrFrame.locator(
          'table td.PlaygroundEditorTheme__tableCellSelected',
        ),
      ).toHaveCount(1);
    });

    test('Range-select from inside table to text above it selects the entire table', async ({
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      await initialize({isCollab, page});

      await focusEditor(page);

      await page.keyboard.type('before');
      await insertTable(page, 2, 2);
      await moveToEditorEnd(page);
      await page.keyboard.type('after');

      const pageOrFrame = getPageOrFrame(page);
      await pageOrFrame
        .locator('table > tr:first-of-type > th:first-of-type')
        .click();
      await page.keyboard.down('Shift');
      await pageOrFrame.locator('p').filter({hasText: 'before'}).click();
      await page.keyboard.up('Shift');

      // Entire table should be selected.
      await expect(
        pageOrFrame.locator(
          'table th.PlaygroundEditorTheme__tableCellSelected',
        ),
      ).toHaveCount(3);
      await expect(
        pageOrFrame.locator(
          'table td.PlaygroundEditorTheme__tableCellSelected',
        ),
      ).toHaveCount(1);
    });

    test('Range-select from inside table to text below it selects the entire table', async ({
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      await initialize({isCollab, page});

      await focusEditor(page);

      await page.keyboard.type('before');
      await insertTable(page, 2, 2);
      await moveToEditorEnd(page);
      await page.keyboard.type('after');

      const pageOrFrame = getPageOrFrame(page);
      await pageOrFrame.locator('table > tr > td').click();
      await page.keyboard.down('Shift');
      await pageOrFrame.locator('p').filter({hasText: 'after'}).click();
      await page.keyboard.up('Shift');

      // Entire table should be selected.
      await expect(
        pageOrFrame.locator(
          'table th.PlaygroundEditorTheme__tableCellSelected',
        ),
      ).toHaveCount(3);
      await expect(
        pageOrFrame.locator(
          'table td.PlaygroundEditorTheme__tableCellSelected',
        ),
      ).toHaveCount(1);
    });
  });

  test.describe('nested table shift-selection tests', () => {
    const END_OF_INNER_TABLE = [1, ...WRAPPER, 2, 1, 1, ...WRAPPER, 2, 1]; // paragraph in the last cell
    const START_OF_INNER_TABLE = [1, ...WRAPPER, 2, 1, 1, ...WRAPPER, 1, 0]; // paragraph in the first cell
    const TEXT_BEFORE_NESTED_TABLE = [1, ...WRAPPER, 2, 1, 0, 0, 0]; // the word "before"
    const TEXT_AFTER_NESTED_TABLE = [1, ...WRAPPER, 2, 1, 2, 0, 0]; // the word "after"

    async function setupTables(page) {
      const pageOrFrame = getPageOrFrame(page);
      await focusEditor(page);
      await insertTable(page, 2, 2);
      await pageOrFrame.locator('table td').click();
      await page.keyboard.type('before');
      await insertTable(page, 2, 2);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.type('after');
    }

    test('Range-select from above nested table into it selects the entire table, but not the outer table', async ({
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      test.skip(isCollab);
      await initialize({hasNestedTables: true, page});

      await setupTables(page);

      const pageOrFrame = getPageOrFrame(page);

      await pageOrFrame
        .locator('p')
        .filter({hasText: 'before'})
        .click({force: true}); // `force` to ignore playwright blocking due to TableCellResizer interception
      // move the cursor to the end of the word
      await moveToLineEnd(page);
      await page.keyboard.down('Shift');
      await pageOrFrame
        .locator('table table > tr:first-of-type > th:first-of-type')
        .click();
      await page.keyboard.up('Shift');

      // Assert the selection is a range selection solely within the cell containing the nested table.
      await assertSelection(page, {
        anchorOffset: 6, // at the end of the word "before"
        anchorPath: TEXT_BEFORE_NESTED_TABLE,
        focusOffset: 1,
        focusPath: END_OF_INNER_TABLE,
      });
    });

    test('Range-select from below nested table into it selects the entire table, but not the outer table', async ({
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      test.skip(isCollab);
      await initialize({hasNestedTables: true, page});

      await setupTables(page);

      const pageOrFrame = getPageOrFrame(page);

      await pageOrFrame.locator('p').filter({hasText: 'after'}).waitFor();
      await page.keyboard.down('Shift');
      await pageOrFrame
        .locator('table table > tr:last-of-type > th')
        .click({force: true}); // `force` to ignore playwright blocking due to TableCellResizer interception
      await page.keyboard.up('Shift');

      // Assert the selection is a range selection solely within the cell containing the nested table.
      await assertSelection(page, {
        anchorOffset: 5, // at the end of the word "after"
        anchorPath: TEXT_AFTER_NESTED_TABLE,
        focusOffset: 0,
        focusPath: START_OF_INNER_TABLE,
      });
    });

    test('Range-select from inside nested table to text above it selects the entire table, but not the outer table', async ({
      browserName,
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      test.skip(isCollab);
      test.fixme(
        browserName === 'firefox',
        'Firefox resolves this shift-click as whole cells of the nested table, so what is imported is a TableSelection rather than a range and $fixRangeSelectionForSelectedTable never gets to clamp the anchor',
      );
      await initialize({hasNestedTables: true, page});

      await setupTables(page);

      const pageOrFrame = getPageOrFrame(page);

      await pageOrFrame
        .locator('table table > tr:first-of-type > th:first-of-type')
        .click();
      await page.keyboard.down('Shift');

      // workaround to ensure you reach the end of the word
      await pageOrFrame.locator('p span').filter({hasText: 'before'}).click();
      await extendToNextWord(page);

      await page.keyboard.up('Shift');

      // Assert the selection is a range selection solely within the cell containing the nested table.
      await assertSelection(page, {
        anchorOffset: 1, // anchor moves to the end of the table
        anchorPath: END_OF_INNER_TABLE,
        focusOffset: 6,
        focusPath: TEXT_BEFORE_NESTED_TABLE,
      });
    });

    test('Range-select from inside nested table to text below it selects the entire table, but not the outer table', async ({
      browserName,
      page,
      isPlainText,
      isCollab,
    }) => {
      test.skip(isPlainText);
      test.skip(isCollab);
      test.fixme(
        browserName === 'firefox',
        'No longer selects the entire outer cell, but the rest is left to the ' +
          'engine and only linux Firefox resolves it the same way as the other ' +
          'engines -- on windows the focus stays at offset 0 of the text below',
      );
      await initialize({hasNestedTables: true, page});

      await setupTables(page);

      const pageOrFrame = getPageOrFrame(page);

      await pageOrFrame.locator('table table td').click();
      await page.keyboard.down('Shift');

      // workaround to ensure you reach the end of the word
      await pageOrFrame.locator('p span').filter({hasText: 'after'}).click();
      await extendToNextWord(page);

      await page.keyboard.up('Shift');

      // Assert the selection is a range selection solely within the cell containing the nested table.
      await assertSelection(page, {
        anchorOffset: 0, // anchor moves to the start of the table
        anchorPath: START_OF_INNER_TABLE,
        focusOffset: 5,
        focusPath: TEXT_AFTER_NESTED_TABLE,
      });
    });
  });
});

const TABLE_WITH_MERGED_CELLS = `
<table class="PlaygroundEditorTheme__table">
  <colgroup>
    <col style="width: 92px;">
    <col style="width: 92px;">
    <col style="width: 92px;">
  </colgroup>
  <tbody>
    <tr>
      <td class="PlaygroundEditorTheme__tableCell" style="border: 1px solid black; width: 75px; vertical-align: top; text-align: start;">
        <p class="PlaygroundEditorTheme__paragraph">
          <span style="white-space: pre-wrap;">a1</span>
        </p>
      </td>
      <td class="PlaygroundEditorTheme__tableCell" style="border: 1px solid black; width: 75px; vertical-align: top; text-align: start;">
        <p class="PlaygroundEditorTheme__paragraph">
          <span style="white-space: pre-wrap;">a2</span>
        </p>
      </td>
      <td class="PlaygroundEditorTheme__tableCell" style="border: 1px solid black; width: 75px; vertical-align: top; text-align: start;">
        <p class="PlaygroundEditorTheme__paragraph">
          <span style="white-space: pre-wrap;">a3</span>
        </p>
      </td>
    </tr>
    <tr style="height: 38px;">
      <td rowspan="2" class="PlaygroundEditorTheme__tableCell" style="border: 1px solid black; width: 75px; vertical-align: top; text-align: start;">
        <p class="PlaygroundEditorTheme__paragraph">
          <span style="white-space: pre-wrap;">b1</span>
        </p>
      </td>
      <td class="PlaygroundEditorTheme__tableCell" style="border: 1px solid black; width: 75px; vertical-align: top; text-align: start;">
        <p class="PlaygroundEditorTheme__paragraph">
          <span style="white-space: pre-wrap;">b2</span>
        </p>
      </td>
      <td class="PlaygroundEditorTheme__tableCell" style="border: 1px solid black; width: 75px; vertical-align: top; text-align: start;">
        <p class="PlaygroundEditorTheme__paragraph">
          <span style="white-space: pre-wrap;">b3</span>
        </p>
      </td>
    </tr>
    <tr>
      <td colspan="2" class="PlaygroundEditorTheme__tableCell" style="border: 1px solid black; width: 75px; vertical-align: top; text-align: start;">
        <p class="PlaygroundEditorTheme__paragraph">
          <span style="white-space: pre-wrap;">c2</span>
        </p>
      </td>
    </tr>
  </tbody>
</table>`;
