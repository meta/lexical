/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {expect} from '@playwright/test';

import {
  focusEditor,
  initialize,
  pasteFromClipboard,
  test,
} from '../../../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('HTML CopyAndPaste', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test.describe(() => {
    test.skip(({isCollab}) => isCollab);
    test('Copy + paste multi line html with extra newlines', async ({page}) => {
      await focusEditor(page);
      await pasteFromClipboard(page, {
        'text/html':
          '<p>Hello\n</p>\n\n<p>\n\nWorld\n\n</p>\n\n<p>Hello\n\n   World   \n\n!\n\n</p><p>Hello <b>World</b> <i>!</i></p>',
      });

      const paragraphs = page.locator('div[contenteditable="true"] > p');
      await expect(paragraphs).toHaveCount(4);

      // Explicitly checking inner text, since regular assertHTML will prettify it and strip all
      // extra newlines, which makes this test less accurate
      await expect(paragraphs.nth(0)).toHaveText('Hello', {useInnerText: true});
      await expect(paragraphs.nth(1)).toHaveText('World', {useInnerText: true});
      await expect(paragraphs.nth(2)).toHaveText('Hello   World   !', {
        useInnerText: true,
      });
      await expect(paragraphs.nth(3)).toHaveText('Hello World !', {
        useInnerText: true,
      });
    });
  });
});
