/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveLeft,
  moveToLineBeginning,
  moveToLineEnd,
  selectAll,
  selectCharacters,
} from '../../../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  copyToClipboard,
  focusEditor,
  html,
  initialize,
  IS_LINUX,
  IS_WINDOWS,
  pasteFromClipboard,
  test,
} from '../../../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('Lists CopyAndPaste', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('Copy and paste of partial list items into an empty editor', async ({
    page,
  }) => {
    await focusEditor(page);

    // Add three list items
    await page.keyboard.type('- one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await page.keyboard.press('Enter');
    await page.keyboard.type('three');

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    // Add a paragraph
    await page.keyboard.type('Some text.');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">one</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">two</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">three</span>
          </li>
        </ul>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Some text.</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 10,
      anchorPath: [1, 0, 0],
      focusOffset: 10,
      focusPath: [1, 0, 0],
    });

    await page.keyboard.down('Shift');
    await moveToLineBeginning(page);
    await moveLeft(page, 3);
    await page.keyboard.up('Shift');

    await assertSelection(page, {
      anchorOffset: 10,
      anchorPath: [1, 0, 0],
      focusOffset: 3,
      focusPath: [0, 2, 0, 0],
    });

    {
      // Copy the partial list item and paragraph
      const clipboard = await copyToClipboard(page);

      // Select all and remove content
      await selectAll(page);
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0],
        focusOffset: 0,
        focusPath: [0],
      });

      // Paste

      await pasteFromClipboard(page, clipboard);

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">ee</span>
            </li>
          </ul>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Some text.</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 10,
        anchorPath: [1, 0, 0],
        focusOffset: 10,
        focusPath: [1, 0, 0],
      });
    }
  });

  test('Copy and paste of partial list items into the list', async ({
    page,
    browserName,
  }) => {
    await focusEditor(page);

    // Add three list items
    await page.keyboard.type('- one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await page.keyboard.press('Enter');
    await page.keyboard.type('three');

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    // Add a paragraph
    await page.keyboard.type('Some text.');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">one</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">two</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">three</span>
          </li>
        </ul>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Some text.</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 10,
      anchorPath: [1, 0, 0],
      focusOffset: 10,
      focusPath: [1, 0, 0],
    });

    await page.keyboard.down('Shift');
    await moveToLineBeginning(page);
    await moveLeft(page, 3);
    await page.keyboard.up('Shift');

    await assertSelection(page, {
      anchorOffset: 10,
      anchorPath: [1, 0, 0],
      focusOffset: 3,
      focusPath: [0, 2, 0, 0],
    });

    {
      // Copy the partial list item and paragraph
      const clipboard = await copyToClipboard(page);

      // Select all and remove content
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      if (!IS_WINDOWS && browserName === 'firefox') {
        await page.keyboard.press('ArrowUp');
      }
      await moveToLineEnd(page);

      await page.keyboard.down('Enter');

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">one</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <br data-lexical-managed-linebreak="true" />
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="3">
              <span data-lexical-text="true">two</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="4">
              <span data-lexical-text="true">three</span>
            </li>
          </ul>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Some text.</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0, 1],
        focusOffset: 0,
        focusPath: [0, 1],
      });

      await pasteFromClipboard(page, clipboard);

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">one</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <span data-lexical-text="true">ee</span>
            </li>
          </ul>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Some text.</span>
          </p>
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">two</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <span data-lexical-text="true">three</span>
            </li>
          </ul>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Some text.</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 10,
        anchorPath: [1, 0, 0],
        focusOffset: 10,
        focusPath: [1, 0, 0],
      });
    }
  });

  test('Copy list items and paste back into list', async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('- one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await page.keyboard.press('Enter');
    await page.keyboard.type('three');
    await page.keyboard.press('Enter');
    await page.keyboard.type('four');
    await page.keyboard.press('Enter');
    await page.keyboard.type('five');

    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');

    await moveToLineBeginning(page);
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await moveToLineEnd(page);
    await page.keyboard.up('Shift');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">one</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">two</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">three</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="4">
            <span data-lexical-text="true">four</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="5">
            <span data-lexical-text="true">five</span>
          </li>
        </ul>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 2, 0, 0],
      focusOffset: 4,
      focusPath: [0, 3, 0, 0],
    });

    {
      const clipboard = await copyToClipboard(page);

      await page.keyboard.press('Backspace');

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">one</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <span data-lexical-text="true">two</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="3">
              <br data-lexical-managed-linebreak="true" />
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="4">
              <span data-lexical-text="true">five</span>
            </li>
          </ul>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0, 2],
        focusOffset: 0,
        focusPath: [0, 2],
      });

      await pasteFromClipboard(page, clipboard);

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">one</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <span data-lexical-text="true">two</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="3">
              <span data-lexical-text="true">three</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="4">
              <span data-lexical-text="true">four</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="5">
              <span data-lexical-text="true">five</span>
            </li>
          </ul>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 4,
        anchorPath: [0, 3, 0, 0],
        focusOffset: 4,
        focusPath: [0, 3, 0, 0],
      });
    }
  });

  test.describe(() => {
    test.fixme(({isCollab}) => isCollab && IS_LINUX, 'Flaky on Linux + Collab');
    test('Copy list items and paste into list', async ({page}) => {
      await focusEditor(page);

      await page.keyboard.type('- one');
      await page.keyboard.press('Enter');
      await page.keyboard.type('two');
      await page.keyboard.press('Enter');
      await page.keyboard.type('three');
      await page.keyboard.press('Enter');
      await page.keyboard.type('four');
      await page.keyboard.press('Enter');
      await page.keyboard.type('five');

      await selectAll(page);

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">one</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <span data-lexical-text="true">two</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="3">
              <span data-lexical-text="true">three</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="4">
              <span data-lexical-text="true">four</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="5">
              <span data-lexical-text="true">five</span>
            </li>
          </ul>
        `,
      );

      {
        const clipboard = await copyToClipboard(page);

        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');

        await page.keyboard.type('12345');

        await assertHTML(
          page,
          html`
            <ul class="PlaygroundEditorTheme__ul" dir="auto">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">one</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">two</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="3">
                <span data-lexical-text="true">three</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="4">
                <span data-lexical-text="true">four</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="5">
                <span data-lexical-text="true">five</span>
              </li>
            </ul>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">12345</span>
            </p>
          `,
        );

        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await selectCharacters(page, 'left', 1);

        await pasteFromClipboard(page, clipboard);

        await assertHTML(
          page,
          html`
            <ul class="PlaygroundEditorTheme__ul" dir="auto">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">one</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">two</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="3">
                <span data-lexical-text="true">three</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="4">
                <span data-lexical-text="true">four</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="5">
                <span data-lexical-text="true">five</span>
              </li>
            </ul>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">12</span>
            </p>
            <ul class="PlaygroundEditorTheme__ul" dir="auto">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">one</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">two</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="3">
                <span data-lexical-text="true">three</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="4">
                <span data-lexical-text="true">four</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="5">
                <span data-lexical-text="true">five</span>
              </li>
            </ul>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">45</span>
            </p>
          `,
        );
      }
    });
  });

  test('Copy and paste of list items and paste back into list on an existing item', async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('- one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await page.keyboard.press('Enter');
    await page.keyboard.type('three');
    await page.keyboard.press('Enter');
    await page.keyboard.type('four');
    await page.keyboard.press('Enter');
    await page.keyboard.type('five');

    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');

    await moveToLineBeginning(page);
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await moveToLineEnd(page);
    await page.keyboard.up('Shift');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">one</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">two</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">three</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="4">
            <span data-lexical-text="true">four</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="5">
            <span data-lexical-text="true">five</span>
          </li>
        </ul>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 2, 0, 0],
      focusOffset: 4,
      focusPath: [0, 3, 0, 0],
    });

    {
      const clipboard = await copyToClipboard(page);

      await page.keyboard.press('ArrowRight');

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">one</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <span data-lexical-text="true">two</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="3">
              <span data-lexical-text="true">three</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="4">
              <span data-lexical-text="true">four</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="5">
              <span data-lexical-text="true">five</span>
            </li>
          </ul>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 4,
        anchorPath: [0, 3, 0, 0],
        focusOffset: 4,
        focusPath: [0, 3, 0, 0],
      });

      await pasteFromClipboard(page, clipboard);

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">one</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <span data-lexical-text="true">two</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="3">
              <span data-lexical-text="true">three</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="4">
              <span data-lexical-text="true">four</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="5">
              <span data-lexical-text="true">three</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="6">
              <span data-lexical-text="true">four</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="7">
              <span data-lexical-text="true">five</span>
            </li>
          </ul>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 4,
        anchorPath: [0, 5, 0, 0],
        focusOffset: 4,
        focusPath: [0, 5, 0, 0],
      });
    }
  });

  test('Copy and paste two paragraphs into list on an existing item', async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('World');

    await selectAll(page);

    {
      const clipboard = await copyToClipboard(page);

      await page.keyboard.press('Backspace');

      await page.keyboard.type('- one');
      await page.keyboard.press('Enter');
      await page.keyboard.type('two');
      await page.keyboard.press('Enter');
      await page.keyboard.type('three');
      await page.keyboard.press('Enter');
      await page.keyboard.type('four');
      await page.keyboard.press('Enter');
      await page.keyboard.type('five');

      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');

      await moveToLineBeginning(page);
      await page.keyboard.press('ArrowDown');
      await moveToLineEnd(page);
      await moveLeft(page, 2);

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">one</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <span data-lexical-text="true">two</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="3">
              <span data-lexical-text="true">three</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="4">
              <span data-lexical-text="true">four</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="5">
              <span data-lexical-text="true">five</span>
            </li>
          </ul>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 2,
        anchorPath: [0, 3, 0, 0],
        focusOffset: 2,
        focusPath: [0, 3, 0, 0],
      });

      await pasteFromClipboard(page, clipboard);

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">one</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <span data-lexical-text="true">two</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="3">
              <span data-lexical-text="true">three</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="4">
              <span data-lexical-text="true">foHello</span>
            </li>
          </ul>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Worldur</span>
          </p>
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">five</span>
            </li>
          </ul>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 5,
        anchorPath: [1, 0, 0],
        focusOffset: 5,
        focusPath: [1, 0, 0],
      });
    }
  });

  test('Copy and paste two paragraphs at the end of a list', async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('World');

    await selectAll(page);

    {
      const clipboard = await copyToClipboard(page);

      await page.keyboard.press('Backspace');

      await page.keyboard.type('- one');
      await page.keyboard.press('Enter');
      await page.keyboard.type('two');
      await page.keyboard.press('Enter');
      await page.keyboard.type('three');
      await page.keyboard.press('Enter');
      await page.keyboard.type('four');
      await page.keyboard.press('Enter');
      await page.keyboard.type('five');
      await page.keyboard.press('Enter');

      await pasteFromClipboard(page, clipboard);

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">one</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <span data-lexical-text="true">two</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="3">
              <span data-lexical-text="true">three</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="4">
              <span data-lexical-text="true">four</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="5">
              <span data-lexical-text="true">five</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="6">
              <span data-lexical-text="true">Hello</span>
            </li>
          </ul>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">World</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 5,
        anchorPath: [1, 0, 0],
        focusOffset: 5,
        focusPath: [1, 0, 0],
      });

      await pasteFromClipboard(page, clipboard);

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">one</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <span data-lexical-text="true">two</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="3">
              <span data-lexical-text="true">three</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="4">
              <span data-lexical-text="true">four</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="5">
              <span data-lexical-text="true">five</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="6">
              <span data-lexical-text="true">Hello</span>
            </li>
          </ul>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">WorldHello</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">World</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 5,
        anchorPath: [2, 0, 0],
        focusOffset: 5,
        focusPath: [2, 0, 0],
      });
    }
  });
});
