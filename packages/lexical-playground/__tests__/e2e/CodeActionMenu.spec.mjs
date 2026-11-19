/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {paste} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  evaluate,
  expect,
  focusEditor,
  initialize,
  mouseMoveToSelector,
  pasteFromClipboard,
  test,
  waitForSelector,
  withExclusiveClipboardAccess,
} from '../utils/index.mjs';

test.describe('CodeActionMenu', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test.describe(() => {
    test.skip(true);
    test('Can copy code, when click `Copy` button', async ({
      page,
      context,
      browserName,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('``` ');
      await page.keyboard.press('Space');
      await page.keyboard.type(`const a = 'Hello'`);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await page.keyboard.press('Space');
      await page.keyboard.type(`const b = 'World'`);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');

      await assertHTML(
        page,
        `
        <code
          class="PlaygroundEditorTheme__code"
          dir="ltr"
          spellcheck="false"
          data-gutter="123"
          data-highlight-language="javascript">
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__tokenAttr" data-lexical-text="true">
            const
          </span>
          <span data-lexical-text="true">a</span>
          <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
            =
          </span>
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__tokenSelector" data-lexical-text="true">
            'Hello'
          </span>
          <br data-lexical-managed-linebreak="true" />
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__tokenAttr" data-lexical-text="true">
            const
          </span>
          <span data-lexical-text="true">b</span>
          <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
            =
          </span>
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__tokenSelector" data-lexical-text="true">
            'World'
          </span>
          <br data-lexical-managed-linebreak="true" />
          <span data-lexical-text="true"></span>
        </code>
      `,
      );

      await mouseMoveToSelector(page, 'code.PlaygroundEditorTheme__code');

      await withExclusiveClipboardAccess(async () => {
        if (browserName === 'chromium') {
          await context.grantPermissions(['clipboard-write']);
          await click(page, 'button[aria-label=copy]');
          await paste(page);
          await context.clearPermissions();
        } else {
          await waitForSelector(page, 'button[aria-label=copy]');

          const copiedText = await evaluate(page, () => {
            let text = null;

            navigator.clipboard._writeText = navigator.clipboard.writeText;
            navigator.clipboard.writeText = function (data) {
              text = data;
              this._writeText(data);
            };
            document.querySelector('button[aria-label=copy]').click();

            return text;
          });

          await pasteFromClipboard(page, {
            'text/plain': copiedText,
          });
        }
      });

      await assertHTML(
        page,
        `
          <code
          class="PlaygroundEditorTheme__code"
          dir="ltr"
          spellcheck="false"
          data-gutter="12345"
          data-highlight-language="javascript">
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__tokenAttr" data-lexical-text="true">
            const
          </span>
          <span data-lexical-text="true">a</span>
          <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
            =
          </span>
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__tokenSelector" data-lexical-text="true">
            'Hello'
          </span>
          <br data-lexical-managed-linebreak="true" />
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__tokenAttr" data-lexical-text="true">
            const
          </span>
          <span data-lexical-text="true">b</span>
          <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
            =
          </span>
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__tokenSelector" data-lexical-text="true">
            'World'
          </span>
          <br data-lexical-managed-linebreak="true" />
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__tokenAttr" data-lexical-text="true">
            const
          </span>
          <span data-lexical-text="true">a</span>
          <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
            =
          </span>
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__tokenSelector" data-lexical-text="true">
            'Hello'
          </span>
          <br data-lexical-managed-linebreak="true" />
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__tokenAttr" data-lexical-text="true">
            const
          </span>
          <span data-lexical-text="true">b</span>
          <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
            =
          </span>
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__tokenSelector" data-lexical-text="true">
            'World'
          </span>
          <br data-lexical-managed-linebreak="true" />
          <span data-lexical-text="true"></span>
        </code>
      `,
      );
    });
  });

  test.describe(() => {
    test.skip(({isCollab, isPlainText}) => isCollab);
    test.skip(({isCollab, isPlainText}) => isPlainText);
    test('In the case of syntactically correct code, when the `prettier` button is clicked, the code needs to be properly formatted', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('``` ');
      await page.keyboard.press('Space');
      await page.keyboard.type(`const  luci  =  'Hello World'`);

      await assertHTML(
        page,
        `
        <code
          class="PlaygroundEditorTheme__code"
          dir="auto"
          spellcheck="false"
          data-gutter="1">
          <span data-lexical-text="true">const luci = 'Hello World'</span>
        </code>
      `,
      );

      await mouseMoveToSelector(page, 'code.PlaygroundEditorTheme__code');
      await click(page, 'button[aria-label=prettier]');

      // Prettier loads and formats asynchronously; wait for the reformatted
      // result instead of a fixed timeout. Formatting turns the single input
      // line into multiple lines, so a <br> inside the code block is a reliable
      // "prettier finished" signal (attached, not visible: <br> has no box).
      await waitForSelector(page, 'code.PlaygroundEditorTheme__code br', {
        state: 'attached',
      });

      await assertHTML(
        page,
        `
        <code
        class="PlaygroundEditorTheme__code"
        dir="auto"
        spellcheck="false"
        data-gutter="12">
          <span data-lexical-text="true">const luci = "Hello World";</span>
          <br />
          <br data-lexical-managed-linebreak="true" />
        </code>
      `,
      );
    });

    test('If the code syntax is incorrect, an error message should be displayed', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('``` ');
      await page.keyboard.press('Space');
      await page.keyboard.type(`cons  luci  =  'Hello World'`);

      await assertHTML(
        page,
        `
        <code
          class="PlaygroundEditorTheme__code"
          dir="auto"
          spellcheck="false"
          data-gutter="1">
          <span data-lexical-text="true">cons luci = 'Hello World'</span>
        </code>
      `,
      );

      await mouseMoveToSelector(page, 'code.PlaygroundEditorTheme__code');
      await click(page, 'button[aria-label=prettier]');

      // Prettier reports invalid syntax asynchronously; wait for the error badge
      // to appear instead of a fixed timeout (the assertions below do not retry).
      await waitForSelector(page, 'i.format.prettier-error');

      expect(await page.$('i.format.prettier-error')).toBeTruthy();

      const errorTips = await page.$('pre.code-error-tips');

      expect(errorTips).toBeTruthy();

      const tips = await evaluate(page, () => {
        return document.querySelector('pre.code-error-tips').innerText;
      });

      expect(tips).toBe(
        'Missing semicolon. (1:6)\n' +
          "> 1 |  cons  luci  =  'Hello World'\n" +
          '    |      ^',
      );
    });
  });
});
