/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {moveToLineEnd, selectAll} from '../../../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  doubleClick,
  evaluate,
  expect,
  focusEditor,
  getPageOrFrame,
  html,
  initialize,
  pasteFromClipboard,
  test,
  withExclusiveClipboardAccess,
} from '../../../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('ContextMenuCopyAndPaste', () => {
  test.use({shouldUseLexicalContextMenu: true});
  test.beforeEach(({isCollab, page, shouldUseLexicalContextMenu}) =>
    initialize({isCollab, page, shouldUseLexicalContextMenu}),
  );

  test('Basic copy-paste #6231', async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('hello');
    await click(page, '.lock');

    await doubleClick(page, 'div[contenteditable="false"] span');
    await withExclusiveClipboardAccess(async () => {
      await click(page, 'div[contenteditable="false"] span', {button: 'right'});
      await getPageOrFrame(page)
        .getByRole('menuitem', {exact: true, name: 'Copy'})
        .click();
      await click(page, '.unlock');
      await focusEditor(page);

      await pasteFromClipboard(page);
    });

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">hellohello</span>
        </p>
      `,
    );
  });

  test.describe(() => {
    test.skip(
      ({browserName, isCollab}) => isCollab || browserName !== 'chromium',
    );
    test('Rich text Copy and Paste with  different Font Size', async ({
      page,
    }) => {
      await withExclusiveClipboardAccess(async () => {
        await page
          .context()
          .grantPermissions(['clipboard-read', 'clipboard-write']);

        await click(page, '.font-increment');
        await focusEditor(page);
        await page.keyboard.type('MLH Fellowship');
        await moveToLineEnd(page);
        await page.keyboard.press('Enter');
        await page.keyboard.type('Fall 2024');

        await click(page, '.lock');

        await doubleClick(page, 'div[contenteditable="false"] span');
        await click(page, 'div[contenteditable="false"] span', {
          button: 'right',
        });
        await getPageOrFrame(page)
          .getByRole('menuitem', {exact: true, name: 'Copy'})
          .click();

        await click(page, '.unlock');
        await focusEditor(page);
        await pasteFromClipboard(page);
      });

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span style="font-size: 18px;" data-lexical-text="true">
              MLH Fellowship
            </span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span style="font-size: 18px;" data-lexical-text="true">
              Fall 2024Fellowship
            </span>
          </p>
        `,
      );
    });

    test('Copy as Markdown', async ({page}) => {
      await withExclusiveClipboardAccess(async () => {
        await page
          .context()
          .grantPermissions(['clipboard-read', 'clipboard-write']);

        await focusEditor(page);
        await page.keyboard.type('# Title');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Some **bold** text');
        await selectAll(page);

        await click(page, 'div[contenteditable="true"] strong', {
          button: 'right',
        });
        await getPageOrFrame(page)
          .getByRole('menuitem', {name: 'Copy as Markdown'})
          .click();

        // The Windows clipboard converts line endings to CRLF
        const text = await evaluate(page, () => navigator.clipboard.readText());
        expect(text.replace(/\r\n/g, '\n')).toBe(
          '# Title\n\nSome **bold** text',
        );
      });
    });
  });
});
