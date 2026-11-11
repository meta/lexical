/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  applyCodeBlock,
  applyHeading,
  selectAll,
  toggleBold,
  toggleItalic,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  evaluate,
  expect,
  focusEditor,
  html,
  initialize,
  insertDateTime,
  repeat,
  test,
} from '../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('HTML', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test(`Can export HTML using the button`, async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('Foo');
    await applyHeading(page, 1);
    await page.keyboard.press('Enter');
    await applyCodeBlock(page);
    await page.keyboard.type('const x = "hello world";');
    await repeat(3, async () => await page.keyboard.press('Enter'));
    await page.keyboard.type('Today ');
    await toggleBold(page);
    await toggleItalic(page);
    await insertDateTime(page);

    const expectedViewHtml = html`
      <h1 class="PlaygroundEditorTheme__h1" dir="auto">
        <span data-lexical-text="true">Foo</span>
      </h1>
      <code
        class="PlaygroundEditorTheme__code"
        dir="auto"
        spellcheck="false"
        data-gutter="*">
        <span data-lexical-text="true">const x = "hello world";</span>
      </code>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Today</span>
        <span
          contenteditable="false"
          data-lexical-datetime="*"
          data-lexical-decorator="true">
          <div class="dateTimePill bold italic">*</div>
        </span>
        <br data-lexical-managed-linebreak="true" />
      </p>
    `;
    await await assertHTML(
      page,
      expectedViewHtml,
      undefined,
      {ignoreInlineStyles: true},
      // Custom modification: replace the date text and data-lexical-datetime value with wildcards for matching
      actualHtml =>
        actualHtml
          .replace(/data-gutter="[^"]*"/g, 'data-gutter="*"')
          .replace(/(<div[^>]*>)(.*?)(<\/div>)/, '$1*$3')
          .replace(
            /data-lexical-datetime="[^"]*"/,
            'data-lexical-datetime="*"',
          ),
    );

    await click(page, '.action-button .html');

    await await assertHTML(
      page,
      html`
        <code
          class="PlaygroundEditorTheme__code"
          dir="auto"
          spellcheck="false"
          data-gutter="*"
          data-highlight-language="html"
          data-language="html">
          *
        </code>
      `,
      undefined,
      {ignoreInlineStyles: true},
      actualHtml =>
        actualHtml
          .replace(/data-gutter="[^"]*"/g, 'data-gutter="*"')
          .replace(/(<code[^>]*>)([\s\S]*)(<\/code>)/, '$1\n  *\n$3'),
    );

    await click(page, '.action-button .html');
    // same view after import html
    await await assertHTML(
      page,
      expectedViewHtml,
      undefined,
      {ignoreInlineStyles: true},
      // Custom modification: replace the date text and data-lexical-datetime value with wildcards for matching
      actualHtml =>
        actualHtml
          .replace(/data-gutter="[^"]*"/g, 'data-gutter="*"')
          .replace(/(<div[^>]*>)(.*?)(<\/div>)/g, '$1*$3')
          .replace(
            /data-lexical-datetime="[^"]*"/g,
            'data-lexical-datetime="*"',
          ),
    );
  });

  test(`Can import HTML using the button`, async ({page}) => {
    await focusEditor(page);
    await click(page, '.action-button .html');

    await await assertHTML(
      page,
      html`
        <code
          class="PlaygroundEditorTheme__code"
          dir="auto"
          spellcheck="false"
          data-gutter="*"
          data-highlight-language="html"
          data-language="html">
          *
        </code>
      `,
      undefined,
      {ignoreInlineStyles: true},
      actualHtml =>
        actualHtml
          .replace(/data-gutter="[^"]*"/g, 'data-gutter="*"')
          .replace(/(<code[^>]*>)([\s\S]*)(<\/code>)/, '$1\n  *\n$3'),
    );

    await selectAll(page);
    await page.keyboard.type(html`
      <h1>Foo</h1>
      <pre>const x = "hello world";</pre>
      <p>
        Hello
        <b><i>world</i></b>
      </p>
    `);
    await click(page, '.action-button .html');

    await await assertHTML(
      page,
      html`
        <h1 class="PlaygroundEditorTheme__h1" dir="auto">
          <span data-lexical-text="true">Foo</span>
        </h1>
        <code
          class="PlaygroundEditorTheme__code"
          dir="auto"
          spellcheck="false"
          data-gutter="*">
          <span data-lexical-text="true">const x = "hello world";</span>
        </code>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
          <strong
            class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
            data-lexical-text="true">
            world
          </strong>
        </p>
      `,
      undefined,
      {ignoreInlineStyles: true},
      actualHtml =>
        actualHtml.replace(/data-gutter="[^"]*"/g, 'data-gutter="*"'),
    );
  });

  test(`Formats a terse HTML export with prettier`, async ({page}) => {
    await focusEditor(page);
    await applyHeading(page, 1);
    await page.keyboard.type('Foo');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Hello world');

    await click(page, '.action-button .html');

    const expectedPrettyHtml = [
      '<h1><span>Foo</span></h1>',
      '<p><span>Hello world</span></p>',
    ].join('\n');

    await expect(async () => {
      const codeText = await evaluate(page, () => {
        const editor = window.lexicalEditor;
        return window.lexicalEditor.read(() =>
          editor.getEditorState()._nodeMap.get('root').getTextContent(),
        );
      });
      expect(codeText).toBe(expectedPrettyHtml);
    }).toPass({intervals: [100, 250, 500], timeout: 5000});
  });

  test.describe(() => {
    test.skip(({isCollab}) => isCollab);
    test(`Can switch from Pages mode`, async ({page}) => {
      await focusEditor(page);
      // Ensure we're in pageless mode
      await page.waitForSelector(
        '.ContentEditable__root > .PlaygroundEditorTheme__paragraph',
      );
      await applyHeading(page, 1);
      await page.keyboard.type('Foo');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Hello world');

      await click(page, '.page-setup');
      const btn = page.getByRole('button', {name: /^Statement /});
      await expect(btn).toBeVisible();
      await btn.click();
      // Ensure we're in page mode
      await page.waitForSelector(
        '.ContentEditable__root > .PlaygroundEditorTheme__page > .PlaygroundEditorTheme__pageContent',
      );
      await click(page, '.action-button .html');

      const expectedPrettyHtml = [
        '<h1><span>Foo</span></h1>',
        '<p><span>Hello world</span></p>',
      ].join('\n');
      await expect(async () => {
        const codeText = await evaluate(page, () => {
          const editor = window.lexicalEditor;
          return window.lexicalEditor.read(() =>
            editor.getEditorState()._nodeMap.get('root').getTextContent(),
          );
        });
        expect(codeText).toBe(expectedPrettyHtml);
      }).toPass({intervals: [100, 250, 500], timeout: 5000});

      await click(page, '.action-button .html');
      // Ensure we're in page mode
      await page.waitForSelector(
        '.ContentEditable__root > .PlaygroundEditorTheme__page > .PlaygroundEditorTheme__pageContent',
      );
    });
  });
});
