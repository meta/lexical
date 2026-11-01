/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {expect} from '@playwright/test';

import {
  assertHTML,
  dragDraggableMenuTo,
  dragMouse,
  focusEditor,
  html,
  initialize,
  insertYouTubeEmbed,
  mouseMoveToSelector,
  selectorBoundingBox,
  test,
  YOUTUBE_SAMPLE_URL,
} from '../utils/index.mjs';

test.skip(
  ({isCollab, isPlainText}) => isCollab || isPlainText,
  'Requires rich text without collaboration',
);

test.describe('DraggableBlock', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test.describe(() => {
    test.skip(({browserName}) => browserName === 'firefox');
    test('Paragraph one can be successfully dragged below paragraph two', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('Paragraph 1');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Paragraph 2');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Paragraph 3');

      await mouseMoveToSelector(page, 'p:has-text("Paragraph 1")');
      await page.pause();
      await dragDraggableMenuTo(
        page,
        'p:has-text("Paragraph 2")',
        'middle',
        'end',
      );
      await page.pause();
      await assertHTML(
        page,
        `
        <p
          class="PlaygroundEditorTheme__paragraph"
          dir="auto">
          <span data-lexical-text="true">Paragraph 2</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph"
          dir="auto"
          style="">
          <span data-lexical-text="true">Paragraph 1</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph"
          dir="auto">
          <span data-lexical-text="true">Paragraph 3</span>
        </p>
      `,
      );
    });

    test('Dragging a paragraph to the end of itself does not change the content', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('Paragraph 1');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Paragraph 2');

      await mouseMoveToSelector(page, 'p:has-text("Paragraph 1")');
      await page.pause();
      await dragDraggableMenuTo(
        page,
        'p:has-text("Paragraph 1")',
        'middle',
        'end',
      );

      await assertHTML(
        page,
        `
        <p
          class="PlaygroundEditorTheme__paragraph"
          dir="auto"
          style="">
          <span data-lexical-text="true">Paragraph 1</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph"
          dir="auto">
          <span data-lexical-text="true">Paragraph 2</span>
        </p>
      `,
      );
    });

    test('Drag a paragraph to the bottom of its previous paragraph and nothing happens', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('Paragraph 1');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Paragraph 2');

      await mouseMoveToSelector(page, 'p:has-text("Paragraph 2")');
      await page.pause();
      await dragDraggableMenuTo(
        page,
        'p:has-text("Paragraph 1")',
        'middle',
        'end',
      );

      await assertHTML(
        page,
        `
        <p
          class="PlaygroundEditorTheme__paragraph"
          dir="auto">
          <span data-lexical-text="true">Paragraph 1</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph"
          dir="auto"
          style="">
          <span data-lexical-text="true">Paragraph 2</span>
        </p>
      `,
      );
    });

    test('Dragging the first paragraph to an empty space in the middle of the editor works correctly', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('Paragraph 1');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Paragraph 2');

      await mouseMoveToSelector(page, 'p:has-text("Paragraph 1")');
      await page.pause();
      await dragDraggableMenuTo(page, '.ContentEditable__root');

      await assertHTML(
        page,
        `
      <p
        class="PlaygroundEditorTheme__paragraph"
        dir="auto">
        <span data-lexical-text="true">Paragraph 2</span>
      </p>
      <p
        class="PlaygroundEditorTheme__paragraph"
        dir="auto"
        style="">
        <span data-lexical-text="true">Paragraph 1</span>
      </p>
    `,
      );
    });

    test('List item one can be dragged below list item two', async ({page}) => {
      await focusEditor(page);
      await page.keyboard.type('- One');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Two');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Three');

      await mouseMoveToSelector(page, 'li:has-text("One")');
      await dragDraggableMenuTo(page, 'li:has-text("Two")', 'middle', 'end');

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">Two</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" style="" value="2">
              <span data-lexical-text="true">One</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="3">
              <span data-lexical-text="true">Three</span>
            </li>
          </ul>
        `,
      );
    });

    test('A nested list item can be dragged below its sibling', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('- One');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      await page.keyboard.type('Nested one');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Nested two');

      await mouseMoveToSelector(page, 'ul ul > li:has-text("Nested one")');
      await dragDraggableMenuTo(
        page,
        'ul ul > li:has-text("Nested two")',
        'middle',
        'end',
      );

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">One</span>
            </li>
            <li
              class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
              value="2">
              <ul class="PlaygroundEditorTheme__ul">
                <li class="PlaygroundEditorTheme__listItem" value="1">
                  <span data-lexical-text="true">Nested two</span>
                </li>
                <li class="PlaygroundEditorTheme__listItem" style="" value="2">
                  <span data-lexical-text="true">Nested one</span>
                </li>
              </ul>
            </li>
          </ul>
        `,
      );
    });

    test('A list item dragged below a paragraph gets its own list', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('- One');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Two');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Paragraph');

      await mouseMoveToSelector(page, 'li:has-text("Two")');
      await dragDraggableMenuTo(
        page,
        'p:has-text("Paragraph")',
        'middle',
        'end',
      );

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">One</span>
            </li>
          </ul>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Paragraph</span>
          </p>
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" style="" value="1">
              <span data-lexical-text="true">Two</span>
            </li>
          </ul>
        `,
      );
    });

    test('A paragraph dragged onto a list item lands below the list', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('Paragraph');
      await page.keyboard.press('Enter');
      await page.keyboard.type('- One');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Two');

      await mouseMoveToSelector(page, 'p:has-text("Paragraph")');
      await dragDraggableMenuTo(page, 'li:has-text("One")', 'middle', 'end');

      await assertHTML(
        page,
        html`
          <ul class="PlaygroundEditorTheme__ul" dir="auto">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">One</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <span data-lexical-text="true">Two</span>
            </li>
          </ul>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto" style="">
            <span data-lexical-text="true">Paragraph</span>
          </p>
        `,
      );
    });
  });

  test('Restores focus after dragging a selected decorator block', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Before');
    await insertYouTubeEmbed(page, YOUTUBE_SAMPLE_URL);
    await page.keyboard.type('After');

    const decorator = page.locator('.PlaygroundEditorTheme__embedBlock');
    const decoratorElement = page.locator('div[data-lexical-decorator="true"]');
    const decoratorBox = await decoratorElement.boundingBox();
    if (decoratorBox === null) {
      throw new Error('Decorator block is not visible');
    }
    const pointerX = decoratorBox.x + 10;
    const pointerY = decoratorBox.y + decoratorBox.height / 2;
    await decorator.evaluate(element => element.click());
    await expect(decorator).toHaveClass(
      /PlaygroundEditorTheme__embedBlockFocus/,
    );
    await decoratorElement.dispatchEvent('mousemove', {
      clientX: pointerX,
      clientY: pointerY,
    });
    await page.locator('.draggable-block-menu').waitFor();
    await dragMouse(
      page,
      await selectorBoundingBox(page, '.draggable-block-menu'),
      await selectorBoundingBox(page, 'p:has-text("After")'),
      {positionEnd: 'end', positionStart: 'middle'},
    );

    await expect(page.locator('.ContentEditable__root')).toBeFocused();
  });
});
