/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  click,
  expect,
  focusEditor,
  getPageOrFrame,
  initialize,
  test,
} from '../utils/index.mjs';

test.describe('ContextMenu', () => {
  test.use({shouldUseLexicalContextMenu: true});
  test.beforeEach(({isCollab, page, shouldUseLexicalContextMenu}) =>
    initialize({isCollab, page, shouldUseLexicalContextMenu}),
  );

  test('Renders a visible icon for every menu item', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('hello');
    await click(page, 'div[contenteditable="true"] span', {button: 'right'});

    const menu = getPageOrFrame(page).locator(
      '.PlaygroundEditorTheme__contextMenu',
    );
    await expect(menu.getByRole('menuitem').first()).toBeVisible();

    const icons = await menu
      .locator('.PlaygroundEditorTheme__contextMenuItemIcon')
      .evaluateAll(elements =>
        elements.map(element => {
          const style = getComputedStyle(element);
          const {width, height} = element.getBoundingClientRect();
          return {
            backgroundColor: style.backgroundColor,
            height,
            label: element.parentElement.textContent,
            maskImage: style.maskImage || style.webkitMaskImage,
            width,
          };
        }),
      );

    expect(icons.length).toBe(await menu.getByRole('menuitem').count());
    for (const icon of icons) {
      expect(icon, icon.label).toMatchObject({height: 20, width: 20});
      expect(icon.maskImage, icon.label).toContain('url(');
      expect(icon.backgroundColor, icon.label).not.toBe('rgba(0, 0, 0, 0)');
    }
  });
});
