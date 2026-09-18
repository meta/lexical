/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {selectAll} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  createHumanReadableSelection,
  focusEditor,
  html,
  initialize,
  insertYouTubeEmbed,
  selectFromAlignDropdown,
  test,
  YOUTUBE_SAMPLE_URL,
} from '../utils/index.mjs';

test.describe('BlockWithAlignableContents', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('Can create full width blocks for YouTube videos', async ({
    page,
    isPlainText,
  }) => {
    test.skip(isPlainText);
    await focusEditor(page);
    await page.keyboard.type('Hello world');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello world</span>
        </p>
      `,
    );
    await insertYouTubeEmbed(page, YOUTUBE_SAMPLE_URL);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello world</span>
        </p>
        <div contenteditable="false" data-lexical-decorator="true">
          <div class="PlaygroundEditorTheme__embedBlock">
            <iframe
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen=""
              frameborder="0"
              height="315"
              src="${YOUTUBE_SAMPLE_URL}"
              title="YouTube video"
              width="560"></iframe>
          </div>
        </div>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Can align contents within full width blocks', async ({
    page,
    isPlainText,
  }) => {
    test.skip(isPlainText);
    await focusEditor(page);
    await page.keyboard.type('Hello world');
    await insertYouTubeEmbed(page, YOUTUBE_SAMPLE_URL);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello world</span>
        </p>
        <div contenteditable="false" data-lexical-decorator="true">
          <div class="PlaygroundEditorTheme__embedBlock">
            <iframe
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen=""
              frameborder="0"
              height="315"
              src="${YOUTUBE_SAMPLE_URL}"
              title="YouTube video"
              width="560"></iframe>
          </div>
        </div>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await selectAll(page);
    await selectFromAlignDropdown(page, '.center-align');
    await assertHTML(
      page,
      html`
        <p
          class="PlaygroundEditorTheme__paragraph"
          dir="auto"
          style="text-align: center">
          <span data-lexical-text="true">Hello world</span>
        </p>
        <div contenteditable="false" data-lexical-decorator="true">
          <div
            class="PlaygroundEditorTheme__embedBlock PlaygroundEditorTheme__embedBlockFocus"
            style="text-align: center">
            <iframe
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen=""
              frameborder="0"
              height="315"
              src="${YOUTUBE_SAMPLE_URL}"
              title="YouTube video"
              width="560"></iframe>
          </div>
        </div>
        <p
          class="PlaygroundEditorTheme__paragraph"
          dir="auto"
          style="text-align: center">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  // #7618: an unfocused embed block must not opt out of user selection, or the
  // browser refuses to extend a triple click to the end of the paragraph that
  // precedes it and collapses the selection to the start of that paragraph.
  test('Can triple click to select a paragraph followed by an embed block', async ({
    page,
    isPlainText,
    isCollab,
  }) => {
    test.skip(isPlainText || isCollab);
    await focusEditor(page);
    const text = 'Hello world';
    await page.keyboard.type(text);
    await insertYouTubeEmbed(page, YOUTUBE_SAMPLE_URL);
    await page
      .locator('div[contenteditable="true"] > p')
      .first()
      .click({clickCount: 3, delay: 50});
    await assertSelection(
      page,
      createHumanReadableSelection('the whole first paragraph', {
        anchorOffset: {desc: 'start of the text', value: 0},
        anchorPath: [
          {desc: 'first paragraph', value: 0},
          {desc: 'first span', value: 0},
          {desc: 'Text node', value: 0},
        ],
        focusOffset: {desc: 'end of the text', value: text.length},
        focusPath: [
          {desc: 'first paragraph', value: 0},
          {desc: 'first span', value: 0},
          {desc: 'Text node', value: 0},
        ],
      }),
    );
  });
});
