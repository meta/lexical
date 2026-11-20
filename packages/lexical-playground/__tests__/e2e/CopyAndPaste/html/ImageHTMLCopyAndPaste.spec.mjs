/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {expect} from '@playwright/test';

import {moveLeft, selectAll, undo} from '../../../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  copyToClipboard,
  focusEditor,
  html,
  initialize,
  LEXICAL_IMAGE_BASE64,
  pasteFromClipboard,
  prettifyHTML,
  SAMPLE_IMAGE_URL,
  sleepInsertImage,
  test,
} from '../../../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('HTML Image CopyAndPaste', () => {
  test.beforeEach(({isCollab, page}) =>
    initialize({isCollab, page, showNestedEditorTreeView: false}),
  );

  test.describe(() => {
    test.skip(({isCollab}) => isCollab);
    test('Copy + paste HTML of a figure with img and figcaption', async ({
      page,
    }) => {
      let clipboard = {
        'text/html': html`
          <meta charset="utf-8" />
          <figure>
            <img
              alt="sample image alt"
              height="inherit"
              src="${SAMPLE_IMAGE_URL}"
              width="inherit" />
            <figcaption>
              this is a caption with
              <b>rich text</b>
            </figcaption>
          </figure>
        `,
      };
      await page.keyboard.type('An image');
      await moveLeft(page, 'image'.length);
      await pasteFromClipboard(page, clipboard);
      await sleepInsertImage();
      await page.keyboard.type(' inline ');
      const captionEditorStyle = `user-select: text; white-space: pre-wrap; word-break: break-word`;

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">An</span>
            <span
              class="editor-image"
              contenteditable="false"
              data-lexical-decorator="true">
              <div draggable="false">
                <img
                  alt="sample image alt"
                  draggable="false"
                  src="${SAMPLE_IMAGE_URL}"
                  style="height: inherit; max-width: 500px; width: inherit" />
              </div>
              <div class="image-caption-container">
                <div
                  class="ImageNode__contentEditable"
                  contenteditable="true"
                  role="textbox"
                  spellcheck="true"
                  style="${captionEditorStyle}"
                  aria-placeholder="Enter a caption..."
                  data-lexical-editor="true">
                  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                    <span data-lexical-text="true">this is a caption with</span>
                    <strong
                      class="PlaygroundEditorTheme__textBold"
                      data-lexical-text="true">
                      rich text
                    </strong>
                  </p>
                </div>
              </div>
            </span>
            <span data-lexical-text="true">inline image</span>
          </p>
        `,
      );

      await selectAll(page);
      clipboard = await copyToClipboard(page);
      expect(await prettifyHTML(clipboard['text/html'])).toEqual(
        await prettifyHTML(
          html`
            <span style="white-space: pre-wrap;">An</span>
            <figure>
              <img
                alt="sample image alt"
                height="inherit"
                src="${SAMPLE_IMAGE_URL}"
                width="inherit" />
              <figcaption>
                <span style="white-space: pre-wrap;">
                  this is a caption with
                </span>
                <b>
                  <strong
                    class="PlaygroundEditorTheme__textBold"
                    style="white-space: pre-wrap;">
                    rich text
                  </strong>
                </b>
              </figcaption>
            </figure>
            <span style="white-space: pre-wrap;">inline image</span>
          `.trim(),
        ),
      );
    });
  });

  test('Copy + paste an image', async ({page}) => {
    await focusEditor(page);

    const clipboard = {
      'playwright/base64': [LEXICAL_IMAGE_BASE64, 'image/png'],
    };

    await page.keyboard.type('An image');
    await moveLeft(page, 'image'.length);
    await pasteFromClipboard(page, clipboard);
    await sleepInsertImage();
    await page.keyboard.type(' inline ');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">An</span>
          <span
            class="editor-image"
            contenteditable="false"
            data-lexical-decorator="true">
            <div draggable="false">
              <img
                alt="file"
                draggable="false"
                src="${LEXICAL_IMAGE_BASE64}"
                style="height: inherit; max-width: 500px; width: inherit" />
            </div>
          </span>
          <span data-lexical-text="true">inline image</span>
        </p>
      `,
    );
  });

  test.describe(() => {
    test.skip(({isCollab}) => isCollab);
    test('Copy + paste + undo multiple image', async ({page}) => {
      await focusEditor(page);

      const clipboard = {
        'playwright/base64_1': [LEXICAL_IMAGE_BASE64, 'image/png'],
        'playwright/base64_2': [LEXICAL_IMAGE_BASE64, 'image/png'],
      };

      await pasteFromClipboard(page, clipboard);
      await sleepInsertImage(2);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span
              class="editor-image"
              contenteditable="false"
              data-lexical-decorator="true">
              <div draggable="false">
                <img
                  alt="file"
                  draggable="false"
                  src="${LEXICAL_IMAGE_BASE64}"
                  style="height: inherit; max-width: 500px; width: inherit" />
              </div>
            </span>
            <span
              class="editor-image"
              contenteditable="false"
              data-lexical-decorator="true">
              <div draggable="false">
                <img
                  alt="file"
                  draggable="false"
                  src="${LEXICAL_IMAGE_BASE64}"
                  style="height: inherit; max-width: 500px; width: inherit" />
              </div>
            </span>
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );

      await undo(page);
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
    });
  });
});
