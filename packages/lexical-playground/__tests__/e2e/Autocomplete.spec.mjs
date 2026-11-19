/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  decreaseFontSize,
  increaseFontSize,
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleUnderline,
  undo,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  focusEditor,
  html,
  initialize,
  sleep,
  test,
} from '../utils/index.mjs';

test.describe('Autocomplete', () => {
  test.beforeEach(({isCollab, page}) =>
    initialize({isAutocomplete: true, isCollab, page}),
  );
  test('Can autocomplete a word', async ({page, isPlainText}) => {
    await focusEditor(page);
    await page.keyboard.type('Sort by alpha');
    await sleep(500);
    // The ghost is a DOM-only decoration on the active TextNode's span and
    // is intentionally not part of EditorState, so it doesn't sync through
    // Yjs to the right collab frame.
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">
            Sort by alpha
            <span
              class="PlaygroundEditorTheme__autocomplete"
              contenteditable="false"
              data-autocomplete-ghost="true">
              betical (TAB)
            </span>
          </span>
        </p>
      `,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Sort by alpha</span>
        </p>
      `,
    );
    await page.keyboard.press('Tab');
    await page.keyboard.type(' order:');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Sort by alphabetical order:</span>
        </p>
      `,
    );
  });

  test.describe(() => {
    test.skip(({isPlainText}) => isPlainText);
    test('Can autocomplete in the same format as the original text', async ({
      page,
    }) => {
      await focusEditor(page);
      await toggleBold(page);
      await toggleItalic(page);
      await toggleUnderline(page);
      await toggleStrikethrough(page);
      await increaseFontSize(page);

      await page.keyboard.type('Test');
      await sleep(500);

      // The ghost is appended inside the keyed DOM (here `<strong>` for bold-
      // formatted text), so it picks up the parent tag's formatting tag-wise
      // (bold via `<strong>`) and inherits the surrounding font-size via CSS.
      // Right collab frame doesn't see the ghost (DOM-only decoration).
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textUnderlineStrikethrough PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
              style="font-size: 18px;"
              data-lexical-text="true">
              Test
              <span
                class="PlaygroundEditorTheme__autocomplete"
                contenteditable="false"
                data-autocomplete-ghost="true">
                imonials (TAB)
              </span>
            </strong>
          </p>
        `,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textUnderlineStrikethrough PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
              style="font-size: 18px;"
              data-lexical-text="true">
              Test
            </strong>
          </p>
        `,
      );

      await page.keyboard.press('Tab');

      await toggleBold(page);
      await toggleItalic(page);
      await toggleUnderline(page);
      await toggleStrikethrough(page);
      await decreaseFontSize(page);

      await page.keyboard.type(' 2024');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textUnderlineStrikethrough PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
              style="font-size: 18px;"
              data-lexical-text="true">
              Testimonials
            </strong>
            <span style="font-size: 16px;" data-lexical-text="true">2024</span>
          </p>
        `,
      );
    });
  });
  test.describe(() => {
    test.skip(({isCollab, isPlainText}) => isPlainText);
    test.skip(({isCollab, isPlainText}) => isCollab);
    test('Undo does not cause an exception', async ({page}) => {
      // Autocomplete has known issues in collab https://github.com/meta/lexical/issues/6844

      await focusEditor(page);
      await toggleBold(page);
      await toggleItalic(page);
      await toggleUnderline(page);
      await toggleStrikethrough(page);
      await increaseFontSize(page);

      await page.keyboard.type('Test');
      await sleep(500);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textUnderlineStrikethrough PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
              style="font-size: 18px;"
              data-lexical-text="true">
              Test
              <span
                class="PlaygroundEditorTheme__autocomplete"
                contenteditable="false"
                data-autocomplete-ghost="true">
                imonials (TAB)
              </span>
            </strong>
          </p>
        `,
      );

      await page.keyboard.press('Tab');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textUnderlineStrikethrough PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
              style="font-size: 18px;"
              data-lexical-text="true">
              Testimonials
            </strong>
          </p>
        `,
      );

      await undo(page);

      // After undo the ghost decoration is not part of the editor state and
      // re-renders via the plugin's update listener after the next query
      // resolves; wait for that round-trip before snapshotting.
      await sleep(500);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textUnderlineStrikethrough PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
              style="font-size: 18px;"
              data-lexical-text="true">
              Test
              <span
                class="PlaygroundEditorTheme__autocomplete"
                contenteditable="false"
                data-autocomplete-ghost="true">
                imonials (TAB)
              </span>
            </strong>
          </p>
        `,
      );
    });
  });
});
