/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  centerAlign,
  clearFormatting,
  indent,
  moveToPrevWord,
  outdent,
  rightAlign,
  selectAll,
  selectCharacters,
  toggleBold,
  toggleItalic,
  toggleUnderline,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  clearEditor,
  expect,
  focusEditor,
  html,
  initialize,
  locate,
  pasteFromClipboard,
  selectFromAdditionalStylesDropdown,
  selectFromBackgroundColorPicker,
  selectFromColorPicker,
  test,
  waitForTypeaheadMenuOption,
} from '../utils/index.mjs';

test.describe('Clear All Formatting', () => {
  test.beforeEach(({isPlainText, isCollab, page}) => {
    test.skip(isPlainText);
    return initialize({isCollab, page});
  });
  test(`Can clear BIU formatting`, async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('Hello');
    await toggleBold(page);
    await page.keyboard.type(' World');
    await toggleItalic(page);
    await toggleUnderline(page);
    await page.keyboard.type(' Test');
    await selectAll(page);
    await selectFromAdditionalStylesDropdown(page, '.clear');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello World Test</span>
        </p>
      `,
    );
  });

  test(`Should preserve the default styling of links and quoted text`, async ({
    page,
  }) => {
    await focusEditor(page);

    const clipboard = {
      'text/html': '<a href="https://facebook.com">Facebook!</a>',
    };

    await pasteFromClipboard(page, clipboard);
    await selectAll(page);
    await toggleBold(page);
    await toggleItalic(page);
    await toggleUnderline(page);
    await selectFromColorPicker(page);
    await selectFromAdditionalStylesDropdown(page, '.clear');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a class="PlaygroundEditorTheme__link" href="https://facebook.com">
            <span data-lexical-text="true">Facebook!</span>
          </a>
        </p>
      `,
    );

    await clearEditor(page);

    await page.keyboard.type('> Testing for quote node');
    await selectAll(page);
    await toggleBold(page);
    await toggleItalic(page);
    await toggleUnderline(page);
    await selectFromBackgroundColorPicker(page);
    await selectFromColorPicker(page);
    await selectFromAdditionalStylesDropdown(page, '.clear');
    await assertHTML(
      page,
      html`
        <blockquote class="PlaygroundEditorTheme__quote" dir="auto">
          <span data-lexical-text="true">Testing for quote node</span>
        </blockquote>
      `,
    );
  });

  test(`Should preserve the default styling of hashtags and mentions`, async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('#facebook testing');
    await selectAll(page);
    await toggleItalic(page);
    await selectFromBackgroundColorPicker(page);
    await selectFromColorPicker(page);
    await selectFromAdditionalStylesDropdown(page, '.clear');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #facebook
          </span>
          <span data-lexical-text="true">testing</span>
        </p>
      `,
    );

    await clearEditor(page);

    await page.keyboard.type('@Luke');

    // Wait until "Luke Skywalker" is the *highlighted* option before pressing
    // Enter; see waitForTypeaheadMenuOption for why merely-present is racy.
    await waitForTypeaheadMenuOption(page, 'Luke Skywalker');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">@Luke</span>
        </p>
      `,
    );

    await page.keyboard.press('Enter');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="mention"
            spellcheck="false"
            style="background-color: rgba(24, 119, 232, 0.2);"
            data-lexical-text="true">
            Luke Skywalker
          </span>
        </p>
      `,
    );

    await page.keyboard.type(' is testing');
    await selectAll(page);
    await toggleBold(page);
    await selectFromColorPicker(page);
    await selectFromAdditionalStylesDropdown(page, '.clear');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="mention"
            spellcheck="false"
            style="background-color: rgba(24, 119, 232, 0.2);"
            data-lexical-text="true">
            Luke Skywalker
          </span>
          <span data-lexical-text="true">is testing</span>
        </p>
      `,
    );
  });

  test(`Can clear left/center/right alignment when BIU formatting already applied`, async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Hello');
    await toggleBold(page);
    await page.keyboard.type(' World');
    await rightAlign(page);
    await page.keyboard.type(' Test');
    await selectAll(page);
    await selectFromAdditionalStylesDropdown(page, '.clear');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello World Test</span>
        </p>
      `,
    );
  });

  test(`Can clear left/center/right alignment when BIU formatting not applied`, async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Hello World');
    await rightAlign(page);
    await page.keyboard.type(' Test');
    await centerAlign(page);
    await selectAll(page);
    await selectFromAdditionalStylesDropdown(page, '.clear');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello World Test</span>
        </p>
      `,
    );
  });

  test(`Can clear when only indent/outdent alignment is applied`, async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Hello World');
    await indent(page);
    await page.keyboard.type(' Test');
    await indent(page);
    await selectAll(page);
    await selectFromAdditionalStylesDropdown(page, '.clear');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello World Test</span>
        </p>
      `,
    );
  });

  test(`Can clear indent/outdent alignment when other formatting options like BIU or left/right/center align are also applied`, async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Hello');
    await toggleBold(page);
    await toggleItalic(page);
    await page.keyboard.type(' World');
    await indent(page);
    await indent(page);
    await indent(page);
    await rightAlign(page);
    await page.keyboard.type(' Test');
    await outdent(page);
    await selectAll(page);
    await selectFromAdditionalStylesDropdown(page, '.clear');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello World Test</span>
        </p>
      `,
    );
  });

  test(`Can clear alignment and indent with a collapsed selection`, async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Hello World');
    await rightAlign(page);
    await indent(page);
    await clearFormatting(page);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello World</span>
        </p>
      `,
    );
  });

  test(`Should clear formatting of selected text which spans over 1 paragraph`, async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Foo bar');
    await page.keyboard.press('Enter');
    await page.keyboard.type('baz qux');
    await selectAll(page);
    await toggleBold(page);
    await page.keyboard.press('ArrowRight');
    await moveToPrevWord(page);
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.up('Shift');
    await selectFromAdditionalStylesDropdown(page, '.clear');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            Foo
          </strong>
          <span data-lexical-text="true">bar</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">baz</span>
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            qux
          </strong>
        </p>
      `,
    );
  });

  test(`Should reset the toolbar state after clearing formatting (#8881)`, async ({
    page,
  }) => {
    await focusEditor(page);

    // Bold a word in the middle of the paragraph, so that clearing splits and
    // merges text nodes rather than reformatting the whole block
    await page.keyboard.type('Hello World Test');
    await moveToPrevWord(page);
    await moveToPrevWord(page);
    await selectCharacters(page, 'right', 'World'.length);
    await toggleBold(page);

    // locate() (not page.locator()) so this resolves inside the left frame in
    // collab mode, where the playground runs in a two-iframe split view
    const boldButton = locate(
      page,
      '.toolbar-item[aria-label^="Format text as bold"]',
    );
    await expect(boldButton).toHaveClass(/active/);

    await selectFromAdditionalStylesDropdown(page, '.clear');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello World Test</span>
        </p>
      `,
    );
    // The formatting is gone, so the button must not stay stuck in the active
    // state - otherwise it takes two clicks to bold the selection again
    await expect(boldButton).not.toHaveClass(/active/);
  });
});
