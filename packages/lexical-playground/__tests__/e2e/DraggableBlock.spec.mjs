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
  initialize,
  insertYouTubeEmbed,
  mouseMoveToSelector,
  selectorBoundingBox,
  test,
  YOUTUBE_SAMPLE_URL,
} from '../utils/index.mjs';

test.describe('DraggableBlock', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('Paragraph one can be successfully dragged below paragraph two', async ({
    page,
    isPlainText,
    browserName,
    isCollab,
  }) => {
    test.skip(isCollab);
    test.skip(isPlainText);
    test.skip(browserName === 'firefox');

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
    isPlainText,
    browserName,
    isCollab,
  }) => {
    test.skip(isCollab);
    test.skip(isPlainText);
    test.skip(browserName === 'firefox');

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
    isPlainText,
    browserName,
    isCollab,
  }) => {
    test.skip(isCollab);
    test.skip(isPlainText);
    test.skip(browserName === 'firefox');

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
    isPlainText,
    browserName,
    isCollab,
  }) => {
    test.skip(isCollab);
    test.skip(isPlainText);
    test.skip(browserName === 'firefox');

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

  test('Restores focus after dragging a selected decorator block', async ({
    page,
    isPlainText,
    browserName,
    isCollab,
  }) => {
    test.skip(isCollab);
    test.skip(isPlainText);

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
      {positionEnd: 'end', positionStart: 'middle', slow: true},
    );

    await expect(page.locator('.ContentEditable__root')).toBeFocused();
  });
});
