/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveLeft,
  moveRight,
  moveToLineBeginning,
  moveToLineEnd,
  selectAll,
  selectCharacters,
  toggleBold,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  focusEditor,
  html,
  initialize,
  pasteFromClipboard,
  pressInsertLinkButton,
  test,
} from '../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('Auto Links', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('Can convert url-like text into links', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type(
      'Hello http://example.com and https://example.com/path?with=query#and-hash and www.example.com',
    );
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">Hello</span>
          <a href="http://example.com">
            <span data-lexical-text="true">http://example.com</span>
          </a>
          <span data-lexical-text="true">and</span>
          <a href="https://example.com/path?with=query#and-hash">
            <span data-lexical-text="true">
              https://example.com/path?with=query#and-hash
            </span>
          </a>
          <span data-lexical-text="true">and</span>
          <a href="https://www.example.com">
            <span data-lexical-text="true">www.example.com</span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can convert url-like text into links for email', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type(
      'Hello name@example.com and anothername@test.example.uk !',
    );
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">Hello</span>
          <a href="mailto:name@example.com">
            <span data-lexical-text="true">name@example.com</span>
          </a>
          <span data-lexical-text="true">and</span>
          <a href="mailto:anothername@test.example.uk">
            <span data-lexical-text="true">anothername@test.example.uk</span>
          </a>
          <span data-lexical-text="true">!</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can destruct links if add non-spacing text in front or right after it', async ({
    page,
  }) => {
    const htmlWithLink = html`
      <p dir="auto">
        <a href="http://example.com">
          <span data-lexical-text="true">http://example.com</span>
        </a>
      </p>
    `;

    await focusEditor(page);
    await page.keyboard.type('http://example.com');
    await assertHTML(page, htmlWithLink, undefined, {ignoreClasses: true});

    // Add non-url text after the link
    await page.keyboard.type('!');
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">http://example.com!</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
    await page.keyboard.press('Backspace');
    await assertHTML(page, htmlWithLink, undefined, {ignoreClasses: true});

    // Add non-url text before the link
    await moveToLineBeginning(page);
    await page.keyboard.type('!');
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">!http://example.com</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
    await page.keyboard.press('Backspace');
    await assertHTML(page, htmlWithLink, undefined, {ignoreClasses: true});

    // Add newline after link
    await moveToLineEnd(page);
    await page.keyboard.press('Enter');
    await assertHTML(
      page,
      htmlWithLink +
        html`
          <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
        `,
      undefined,
      {ignoreClasses: true},
    );
    await page.keyboard.press('Backspace');
    await assertHTML(page, htmlWithLink, undefined, {ignoreClasses: true});
  });

  test('Can create link when pasting text with urls', async ({page}) => {
    await focusEditor(page);
    await pasteFromClipboard(page, {
      'text/plain':
        'Hello http://example.com and https://example.com/path?with=query#and-hash and www.example.com',
    });
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">Hello</span>
          <a href="http://example.com">
            <span data-lexical-text="true">http://example.com</span>
          </a>
          <span data-lexical-text="true">and</span>
          <a href="https://example.com/path?with=query#and-hash">
            <span data-lexical-text="true">
              https://example.com/path?with=query#and-hash
            </span>
          </a>
          <span data-lexical-text="true">and</span>
          <a href="https://www.example.com">
            <span data-lexical-text="true">www.example.com</span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can create link for email when pasting text with urls', async ({
    page,
  }) => {
    await focusEditor(page);
    await pasteFromClipboard(page, {
      'text/plain':
        'Hello name@example.com and anothername@test.example.uk and www.example.com !',
    });
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">Hello</span>
          <a href="mailto:name@example.com">
            <span data-lexical-text="true">name@example.com</span>
          </a>
          <span data-lexical-text="true">and</span>
          <a href="mailto:anothername@test.example.uk">
            <span data-lexical-text="true">anothername@test.example.uk</span>
          </a>
          <span data-lexical-text="true">and</span>
          <a href="https://www.example.com">
            <span data-lexical-text="true">www.example.com</span>
          </a>
          <span data-lexical-text="true">!</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Does not create redundant auto-link', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('hm');

    await selectAll(page);
    await click(page, '.link');
    await click(page, '.link-confirm');

    await assertHTML(
      page,
      html`
        <p dir="auto">
          <a href="https://" rel="noreferrer">
            <span data-lexical-text="true">hm</span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
    await moveLeft(page, 1);
    await moveRight(page, 1);
    await page.keyboard.type('ttps://facebook.co');
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <a href="https://" rel="noreferrer">
            <span data-lexical-text="true">https://facebook.com</span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can create links when pasting text with multiple autolinks in a row separated by non-alphanumeric characters, but not whitespaces', async ({
    page,
  }) => {
    await focusEditor(page);
    await pasteFromClipboard(page, {
      'text/plain':
        'https://1.com/,https://2.com/;;;https://3.com;name@domain.uk;',
    });
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <a href="https://1.com/">
            <span data-lexical-text="true">https://1.com/</span>
          </a>
          <span data-lexical-text="true">,</span>
          <a href="https://2.com/">
            <span data-lexical-text="true">https://2.com/</span>
          </a>
          <span data-lexical-text="true">;;;</span>
          <a href="https://3.com">
            <span data-lexical-text="true">https://3.com</span>
          </a>
          <span data-lexical-text="true">;</span>
          <a href="mailto:name@domain.uk">
            <span data-lexical-text="true">name@domain.uk</span>
          </a>
          <span data-lexical-text="true">;</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Handles multiple autolinks in a row', async ({page}) => {
    await focusEditor(page);
    await pasteFromClipboard(page, {
      'text/plain':
        'https://1.com/ https://2.com/ https://3.com/ https://4.com/ name-lastname@meta.com',
    });
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <a href="https://1.com/">
            <span data-lexical-text="true">https://1.com/</span>
          </a>
          <span data-lexical-text="true"></span>
          <a href="https://2.com/">
            <span data-lexical-text="true">https://2.com/</span>
          </a>
          <span data-lexical-text="true"></span>
          <a href="https://3.com/">
            <span data-lexical-text="true">https://3.com/</span>
          </a>
          <span data-lexical-text="true"></span>
          <a href="https://4.com/">
            <span data-lexical-text="true">https://4.com/</span>
          </a>
          <span data-lexical-text="true"></span>
          <a href="mailto:name-lastname@meta.com">
            <span data-lexical-text="true">name-lastname@meta.com</span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Handles autolink following an invalid autolink', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('Hellohttps://example.com https://example.com');

    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">Hellohttps://example.com</span>
          <a href="https://example.com">
            <span data-lexical-text="true">https://example.com</span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Handles autolink following an invalid autolink to email', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type(
      'Hello name@example.c name@example.1 name-lastname@example.com name.lastname@meta.com',
    );

    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">
            Hello name@example.c name@example.1
          </span>
          <a href="mailto:name-lastname@example.com">
            <span data-lexical-text="true">name-lastname@example.com</span>
          </a>
          <span data-lexical-text="true"></span>
          <a href="mailto:name.lastname@meta.com">
            <span data-lexical-text="true">name.lastname@meta.com</span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can convert url-like text with formatting into links', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Hellohttp://example.com and more');

    // Add bold formatting to com
    await moveToLineBeginning(page);
    await moveRight(page, 20);
    await selectCharacters(page, 'right', 3);
    await toggleBold(page);

    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">Hellohttp://example.</span>
          <strong data-lexical-text="true">com</strong>
          <span data-lexical-text="true">and more</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );

    // Add space before formatted link text
    await moveToLineBeginning(page);
    await moveRight(page, 5);
    await page.keyboard.type(' ');

    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">Hello</span>
          <a href="http://example.com">
            <span data-lexical-text="true">http://example.</span>
            <strong data-lexical-text="true">com</strong>
          </a>
          <span data-lexical-text="true">and more</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can convert url-like text with styles into links', async ({page}) => {
    await focusEditor(page);

    //increase font size
    await click(page, '.font-increment');
    await click(page, '.font-increment');

    await page.keyboard.type('Hellohttp://example.com and more');

    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span style="font-size: 20px;" data-lexical-text="true">
            Hellohttp://example.com and more
          </span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );

    // Add space before link text
    await moveToLineBeginning(page);
    await moveRight(page, 5);
    await page.keyboard.type(' ');

    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span style="font-size: 20px;" data-lexical-text="true">Hello</span>
          <a href="http://example.com">
            <span style="font-size: 20px;" data-lexical-text="true">
              http://example.com
            </span>
          </a>
          <span style="font-size: 20px;" data-lexical-text="true">
            and more
          </span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can unlink the autolink and then make it link again', async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Hello http://www.example.com test');
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">Hello</span>
          <a href="http://www.example.com">
            <span data-lexical-text="true">http://www.example.com</span>
          </a>
          <span data-lexical-text="true">test</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );

    await focusEditor(page);
    await click(page, 'a[href="http://www.example.com"]');
    await click(page, 'div.link-editor div.link-trash');

    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">Hello</span>
          <span>
            <span data-lexical-text="true">http://www.example.com</span>
          </span>
          <span data-lexical-text="true">test</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );

    await click(page, 'span:has-text("http://www.example.com")');
    await pressInsertLinkButton(page);

    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">Hello</span>
          <a href="http://www.example.com">
            <span data-lexical-text="true">http://www.example.com</span>
          </a>
          <span data-lexical-text="true">test</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Unlinked autolink is preserved when adding punctuation before or after it', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('http://example.com');
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <a href="http://example.com">
            <span data-lexical-text="true">http://example.com</span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );

    await focusEditor(page);
    await click(page, 'a[href="http://example.com"]');
    await click(page, 'div.link-editor div.link-trash');
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span>
            <span data-lexical-text="true">http://example.com</span>
          </span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );

    // Add non-url text after the link
    await moveToLineEnd(page);
    await page.keyboard.type('!');
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span>
            <span data-lexical-text="true">http://example.com</span>
          </span>
          <span data-lexical-text="true">!</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );

    await page.keyboard.press('Backspace');

    // Add non-url text before the link
    await moveToLineBeginning(page);
    await page.keyboard.type('!');
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">!</span>
          <span>
            <span data-lexical-text="true">http://example.com</span>
          </span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
    await page.keyboard.press('Backspace');
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span>
            <span data-lexical-text="true">http://example.com</span>
          </span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Adding an invalid character will destruct an unlinked autolink', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('http://example.com');
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <a href="http://example.com">
            <span data-lexical-text="true">http://example.com</span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );

    await focusEditor(page);
    await click(page, 'a[href="http://example.com"]');
    await click(page, 'div.link-editor div.link-trash');
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span>
            <span data-lexical-text="true">http://example.com</span>
          </span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );

    // break autolink
    await moveToLineEnd(page);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('[');
    // plain text without wrapper
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">http://example.co[m</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Adding an emoji inside an unlinked autolink will destruct it', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('http://example.com');
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <a href="http://example.com">
            <span data-lexical-text="true">http://example.com</span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );

    await focusEditor(page);
    await click(page, 'a[href="http://example.com"]');
    await click(page, 'div.link-editor div.link-trash');
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span>
            <span data-lexical-text="true">http://example.com</span>
          </span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );

    // type emoji
    await moveToLineEnd(page);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type(':)');
    // ':', ')' — is valid chars for link but inserting an emoji
    // should break the link by splitting it into two text nodes
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <span data-lexical-text="true">http://example.co</span>
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
          <span data-lexical-text="true">m</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Pressing Enter inside an AutoLinkNode does not insert extra paragraph', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('http://example.com');

    // Wait for auto-link to be created
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <a href="http://example.com">
            <span data-lexical-text="true">http://example.com</span>
          </a>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );

    // Move cursor one character to the left (before the 'm')
    await moveLeft(page, 1);

    // Press Enter to split the link
    await page.keyboard.press('Enter');

    // Should produce exactly 2 paragraphs, not 3
    await assertHTML(
      page,
      html`
        <p dir="auto">
          <a href="http://example.co">
            <span data-lexical-text="true">http://example.co</span>
          </a>
        </p>
        <p dir="auto">
          <span data-lexical-text="true">m</span>
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });
});
