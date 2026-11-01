/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  assertHTML,
  assertSelection,
  focusEditor,
  html,
  initialize,
  pasteFromClipboard,
  selectFromAlignDropdown,
  test,
} from '../../../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('HTML Lists CopyAndPaste', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('Copy + paste a list element', async ({page}) => {
    await focusEditor(page);

    const clipboard = {'text/html': '<ul><li>Hello</li><li>world!</li></ul>'};

    await pasteFromClipboard(page, clipboard);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">world!</span>
          </li>
        </ul>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 6,
      anchorPath: [0, 1, 0, 0],
      focusOffset: 6,
      focusPath: [0, 1, 0, 0],
    });

    await selectFromAlignDropdown(page, '.indent');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">world!</span>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );

    await selectFromAlignDropdown(page, '.outdent');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">world!</span>
          </li>
        </ul>
      `,
    );
  });
});
