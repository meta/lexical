/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveRight,
  moveToEditorBeginning,
  selectCharacters,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  evaluate,
  expect,
  focusEditor,
  html,
  initialize,
  test,
} from '../utils/index.mjs';

/**
 * Dispatch HTML5 dragstart/drop events directly on the root element. Playwright's
 * mouse API does not trigger native drag events, so we synthesize them.
 */
async function dragSelectionToOffset(page, sourceText, clientTextOffset) {
  return evaluate(
    page,
    ({text, offset}) => {
      const editable = document.querySelector('[contenteditable="true"]');
      if (!editable) {
        throw new Error('editor not found');
      }
      const paragraph = editable.querySelector('p');
      const span = paragraph.querySelector('span');
      const domText = span.firstChild;
      const range = document.createRange();
      range.setStart(domText, offset);
      range.setEnd(domText, offset);
      const rect = range.getBoundingClientRect();
      const clientX = rect.left;
      const clientY = rect.top + rect.height / 2;

      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', text);
      dataTransfer.setData('text/html', text);

      editable.dispatchEvent(
        new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      );
      const dragoverEvent = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        dataTransfer,
      });
      editable.dispatchEvent(dragoverEvent);
      if (dragoverEvent.defaultPrevented) {
        throw new Error(
          'dragover over text must not be prevented; canceling it suppresses ' +
            'the native editable drop handling that external text drops rely on',
        );
      }
      editable.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          dataTransfer,
        }),
      );
      editable.dispatchEvent(
        new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      );
    },
    {offset: clientTextOffset, text: sourceText},
  );
}

test.describe('Text drag and drop', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test.describe(() => {
    test.skip(({isPlainText}) => isPlainText);
    test('moves a selected word forward within the same block (rich text)', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('abcFOOdef');

      // Select "FOO" (characters 3-6).
      await moveToEditorBeginning(page);
      await moveRight(page, 6);
      await selectCharacters(page, 'left', 3);

      // Drop at offset 9 (end of the text).
      await dragSelectionToOffset(page, 'FOO', 9);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">abcdefFOO</span>
          </p>
        `,
      );
    });

    test('moves a selected word backward within the same block (rich text)', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('abcFOOdef');

      await moveToEditorBeginning(page);
      await moveRight(page, 6);
      await selectCharacters(page, 'left', 3);

      // Drop at offset 0 (beginning of the text).
      await dragSelectionToOffset(page, 'FOO', 0);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">FOOabcdef</span>
          </p>
        `,
      );
    });

    test('dropping inside the source range is a no-op (rich text)', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('abcFOOdef');

      await moveToEditorBeginning(page);
      await moveRight(page, 6);
      await selectCharacters(page, 'left', 3);

      // Drop inside the "FOO" selection (offset 4 lands between F and O).
      await dragSelectionToOffset(page, 'FOO', 4);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">abcFOOdef</span>
          </p>
        `,
      );
    });
  });

  test.describe(() => {
    test.skip(({isPlainText}) => !isPlainText);
    test('moves a selected word forward within the same block (plain text)', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('abcFOOdef');

      await moveToEditorBeginning(page);
      await moveRight(page, 6);
      await selectCharacters(page, 'left', 3);

      await dragSelectionToOffset(page, 'FOO', 9);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">abcdefFOO</span>
          </p>
        `,
      );
    });
  });

  test.describe(() => {
    test.skip(({browserName, isCollab}) => browserName !== 'chromium');
    test.skip(({browserName, isCollab}) => !!isCollab);
    test('native drop of text from a non-Lexical drag source inserts it', async ({
      page,
    }) => {
      // The other tests dispatch synthetic drag events, which never run the
      // browser's default actions and so can't detect a handler that breaks
      // native drop handling (e.g. an unconditional preventDefault() on
      // dragover tells the browser the page owns the drop, suppressing the
      // native editable insertFromDrop that external text drops rely on).
      // Playwright's mouse API composes a real drag through the browser's
      // drag controller, but only Chromium supports that interception.

      await focusEditor(page);
      await page.keyboard.type('hello world');

      // Inject a draggable element that is not part of any Lexical editor.
      await evaluate(page, () => {
        const source = document.createElement('div');
        source.id = 'external-drag-source';
        source.textContent = 'DRAG ME';
        source.draggable = true;
        source.style.cssText =
          'position:fixed;top:4px;left:4px;z-index:99999;padding:8px;';
        source.addEventListener('dragstart', e => {
          e.dataTransfer.setData('text/plain', 'EXTERNAL');
        });
        document.body.appendChild(source);
      });

      const source = await page.locator('#external-drag-source').boundingBox();
      const target = await page
        .locator('div[contenteditable="true"]')
        .first()
        .boundingBox();

      await page.mouse.move(
        source.x + source.width / 2,
        source.y + source.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(source.x + 40, source.y + 40, {steps: 5});
      await page.mouse.move(target.x + target.width / 2, target.y + 20, {
        steps: 15,
      });
      await page.mouse.up();

      await expect(
        page.locator('div[contenteditable="true"]').first(),
      ).toContainText('EXTERNAL');
    });
  });
});
