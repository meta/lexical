/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  click,
  evaluate,
  expect,
  focusEditor,
  initialize,
  test,
} from '../utils/index.mjs';

test.describe('Focus', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test.describe(() => {
    test.skip(
      ({browserName, isRichText}) => isRichText || browserName === 'webkit',
    );
    test(`can tab out of the editor`, async ({page}) => {
      // This won't work in webkit on macOS as tab works differently unless changed in
      // system preferences.

      await focusEditor(page);
      await page.keyboard.press('Tab');
      const isEditorFocused = await page.evaluate(() => {
        const editor = document.querySelector('div[contenteditable="true"]');
        return editor === document.activeElement;
      });

      expect(isEditorFocused).toBe(false);
    });
  });

  test.describe(() => {
    test.skip(({isCollab}) => isCollab);
    test(`selection remains internally when clicking outside the editor`, async ({
      page,
    }) => {
      const getInternalSelection = async () =>
        await evaluate(page, () => {
          return document
            .querySelector(`div[contenteditable="true"]`)
            .__lexicalEditor.getEditorState()._selection;
        });
      await focusEditor(page);
      await page.keyboard.type('Hello world');
      expect(await getInternalSelection()).toEqual(
        expect.objectContaining({
          anchor: expect.objectContaining({
            offset: 11,
          }),
          focus: expect.objectContaining({
            offset: 11,
          }),
        }),
      );
      await click(page, '.tree-view-output');
      expect(await getInternalSelection()).toEqual(
        expect.objectContaining({
          anchor: expect.objectContaining({
            offset: 11,
          }),
          focus: expect.objectContaining({
            offset: 11,
          }),
        }),
      );
    });
  });
});
