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
  locate,
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

    test('Dragging a paragraph above the first paragraph works when the window is scrolled', async ({
      page,
    }) => {
      // Regression test for #9943: dragover/drop compared the pointer's page
      // position (pageY) with the block's viewport position, so any window
      // scroll made every drop land after the hovered block.
      await focusEditor(page);
      for (let i = 1; i <= 40; i++) {
        await page.keyboard.type(`Paragraph ${i}`);
        if (i < 40) {
          await page.keyboard.press('Enter');
        }
      }
      // Scroll the window, but only half as far as the sticky toolbar's
      // position on the page: it then still scrolls with the editor and
      // cannot cover the first paragraph.
      // (Typing scrolled the window to the end, so measure from the top.)
      const scrollY = await page.evaluate(() => {
        window.scrollTo(0, 0);
        const toolbarTop =
          document.querySelector('.toolbar').getBoundingClientRect().top +
          window.scrollY;
        window.scrollTo(0, Math.floor(toolbarTop / 2));
        return window.scrollY;
      });
      expect(scrollY).toBeGreaterThan(0);

      const paragraphs = '.ContentEditable__root > p';
      await mouseMoveToSelector(page, `${paragraphs} >> nth=5`);
      const firstParagraph = await selectorBoundingBox(
        page,
        `${paragraphs} >> nth=0`,
      );
      // The drop point must be on the editor, not under the toolbar, or the
      // drag below tests the layout instead of the plugin.
      expect(
        await page.evaluate(
          ([x, y]) =>
            document
              .elementFromPoint(x, y)
              ?.closest('.ContentEditable__root') != null,
          [firstParagraph.x + 20, firstParagraph.y - 2],
        ),
      ).toBe(true);
      // Hold the drag 2px above the top edge of the first paragraph.
      await dragMouse(
        page,
        await selectorBoundingBox(page, '.draggable-block-menu'),
        firstParagraph,
        {mouseUp: false, offsetEnd: {x: 20, y: -2}, positionEnd: 'start'},
      );
      // The move above starts the drag; move again so dragover fires there.
      await page.mouse.move(firstParagraph.x + 21, firstParagraph.y - 2);
      // The drop indicator line (positioned on dragover) is shown just above
      // the first paragraph, not below it. While hidden, the line is parked
      // far off screen, so check that it is shown and next to the paragraph.
      await expect
        .poll(async () => {
          const line = locate(page, '.draggable-block-target-line');
          if ((await line.evaluate(el => el.style.opacity)) === '0') {
            return 'hidden';
          }
          const box = await line.boundingBox();
          const lineMiddle = box.y + box.height / 2;
          const {y, height} = firstParagraph;
          if (lineMiddle < y - height || lineMiddle > y + 2 * height) {
            return 'elsewhere';
          }
          return lineMiddle < y + height / 2 ? 'above' : 'below';
        })
        .toBe('above');
      await page.mouse.up();

      await expect(
        page.locator('.ContentEditable__root > p').first(),
      ).toHaveText('Paragraph 6');
      await expect(
        page.locator('.ContentEditable__root > p').nth(1),
      ).toHaveText('Paragraph 1');
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

  test('Drag-selecting text over the block menu does not extend the selection past the pointer (#9389)', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Paragraph 1');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Paragraph 2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Paragraph 3');

    const paragraph3 = await selectorBoundingBox(
      page,
      'p:has-text("Paragraph 3")',
    );
    // Hovering paragraph 3 puts the menu next to it.
    await page.mouse.move(
      paragraph3.x + 5,
      paragraph3.y + paragraph3.height / 2,
    );
    const menu = await selectorBoundingBox(page, '.draggable-block-menu');

    // Press at the end of paragraph 3 and drag right-to-left onto the menu.
    await page.mouse.move(
      paragraph3.x + paragraph3.width - 1,
      paragraph3.y + paragraph3.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      paragraph3.x + 5,
      paragraph3.y + paragraph3.height / 2,
      {
        steps: 5,
      },
    );
    await page.mouse.move(menu.x + menu.width / 2, menu.y + menu.height / 2, {
      steps: 5,
    });
    const focus = await page.evaluate(() => {
      const selection = window.getSelection();
      return selection && selection.focusNode
        ? selection.focusNode.textContent
        : null;
    });
    await page.mouse.up();

    expect(focus).toBe('Paragraph 3');
  });
});
