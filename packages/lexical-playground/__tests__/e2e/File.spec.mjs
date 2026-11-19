/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {selectAll, toggleBold} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  focusEditor,
  html,
  initialize,
  insertUploadImage,
  IS_COLLAB_V2,
  test,
  waitForSelector,
} from '../utils/index.mjs';

// TODO(collab-v2): nested editors are not supported yet
test.skip(
  ({isPlainText}) => isPlainText || IS_COLLAB_V2,
  'Requires rich text without collaboration v2',
);

test.use({acceptDownloads: true});
test.describe('File', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test(`Can import/export`, async ({page}) => {
    await focusEditor(page);
    await toggleBold(page);
    await page.keyboard.type('Hello');
    await toggleBold(page);
    await page.keyboard.type(' World');
    await page.keyboard.press('Enter');
    await page.keyboard.type('1. one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await page.keyboard.press('Enter');

    await insertUploadImage(page, [
      'packages/lexical-playground/src/images/yellow-flower-small.jpg',
    ]);

    await waitForSelector(page, '.editor-image img');

    const expectedHtml = html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <strong
          class="PlaygroundEditorTheme__textBold"
          data-lexical-text="true">
          Hello
        </strong>
        <span data-lexical-text="true">World</span>
      </p>
      <ol class="PlaygroundEditorTheme__ol1" dir="auto">
        <li class="PlaygroundEditorTheme__listItem" value="1">
          <span data-lexical-text="true">one</span>
        </li>
        <li class="PlaygroundEditorTheme__listItem" value="2">
          <span data-lexical-text="true">two</span>
        </li>
        <li class="PlaygroundEditorTheme__listItem" value="3">
          <span
            class="editor-image"
            contenteditable="false"
            data-lexical-decorator="true">
            <div draggable="false">
              <img
                alt=""
                draggable="false"
                src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAASABIAAD/4QCMRXhpZgAATU0AKgAAAAgABQESAAMAAAABAAEAAAEaAAUAAAABAAAASgEbAAUAAAABAAAAUgEoAAMAAAABAAIAAIdpAAQAAAABAAAAWgAAAAAAAABIAAAAAQAAAEgAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAAAAagAwAEAAAAAQAAAAcAAAAA/8IAEQgABwAGAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAMCBAEFAAYHCAkKC//EAMMQAAEDAwIEAwQGBAcGBAgGcwECAAMRBBIhBTETIhAGQVEyFGFxIweBIJFCFaFSM7EkYjAWwXLRQ5I0ggjhU0AlYxc18JNzolBEsoPxJlQ2ZJR0wmDShKMYcOInRTdls1V1pJXDhfLTRnaA40dWZrQJChkaKCkqODk6SElKV1hZWmdoaWp3eHl6hoeIiYqQlpeYmZqgpaanqKmqsLW2t7i5usDExcbHyMnK0NTV1tfY2drg5OXm5+jp6vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAQIAAwQFBgcICQoL/8QAwxEAAgIBAwMDAgMFAgUCBASHAQACEQMQEiEEIDFBEwUwIjJRFEAGMyNhQhVxUjSBUCSRoUOxFgdiNVPw0SVgwUThcvEXgmM2cCZFVJInotIICQoYGRooKSo3ODk6RkdISUpVVldYWVpkZWZnaGlqc3R1dnd4eXqAg4SFhoeIiYqQk5SVlpeYmZqgo6SlpqeoqaqwsrO0tba3uLm6wMLDxMXGx8jJytDT1NXW19jZ2uDi4+Tl5ufo6ery8/T19vf4+fr/2wBDAAIDAwMEAwQFBQQGBgYGBggIBwcICA0JCgkKCQ0TDA4MDA4MExEUEQ8RFBEeGBUVGB4jHRwdIyolJSo1MjVFRVz/2wBDAQIDAwMEAwQFBQQGBgYGBggIBwcICA0JCgkKCQ0TDA4MDA4MExEUEQ8RFBEeGBUVGB4jHRwdIyolJSo1MjVFRVz/2gAMAwEAAhEDEQAAAfBeXfV/i9n/2gAIAQEAAQUCmlT7p//aAAgBAxEBPwGWbIKo/wBmP+0f/9oACAECEQE/AYYoHddn7pf7V//aAAgBAQAGPwKFaUpWtZJJVUl//8QAMxABAAMAAgICAgIDAQEAAAILAREAITFBUWFxgZGhscHw0RDh8SAwQFBgcICQoLDA0OD/2gAIAQEAAT8hFyPFTveHPBl//9oADAMBAAIRAxEAABCL/8QAMxEBAQEAAwABAgUFAQEAAQEJAQARITEQQVFhIHHwkYGhsdHB4fEwQFBgcICQoLDA0OD/2gAIAQMRAT8QYOAdB9nP5t//2gAIAQIRAT8QEWh51X58fxf/2gAIAQEAAT8QJfU4BLBcKyeUzf/Z"
                style="height: inherit; max-width: 500px; width: inherit;" />
            </div>
          </span>
          <br data-lexical-managed-linebreak="true" />
        </li>
      </ol>
    `;

    await assertHTML(page, expectedHtml);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      click(page, '.action-button.export'),
    ]);
    const filePath = await download.path();

    await focusEditor(page);
    await selectAll(page);
    await page.keyboard.press('Backspace');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    page.on('filechooser', fileChooser => {
      fileChooser.setFiles([filePath]);
    });
    await click(page, '.action-button.import');

    // The import reads and parses the file asynchronously; assertHTML retries
    // until the imported document replaces the empty editor, so no fixed wait
    // is needed.
    await assertHTML(page, expectedHtml);
  });
});
