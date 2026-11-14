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
} from '../utils/index.mjs';

for (const scrollOwner of ['container', 'viewport']) {
  for (const direction of ['up', 'down']) {
    test(`block dragging autoscrolls the ${scrollOwner} ${direction} with a stationary cursor`, async ({
      page,
      isCollab,
      isPlainText,
      browserName,
    }) => {
      // The playground only mounts this plugin in standalone rich-text mode.
      test.skip(isCollab || isPlainText);
      // Match DraggableBlock.spec.mjs: native dragging is not exercised in Firefox.
      // The scrolling controller and plugin lifecycle still run in Firefox browser tests.
      test.skip(browserName === 'firefox');
      await initialize({page, showNestedEditorTreeView: false});
      await focusEditor(page);
      await pasteFromClipboard(page, {
        'text/plain': Array.from({length: 100}, (_, i) => `Block ${i}`).join(
          '\n',
        ),
      });
      const root = page.locator('[data-lexical-editor="true"]').first();
      await expect(root.locator('p')).toHaveCount(100);
      await page.evaluate(() => {
        // Native dragover delivery can lag behind Playwright mouse movement.
        // Observe DOM events so releasing the mouse uses the intended target.
        window.lastBlockDragOverY = null;
        window.addEventListener('dragover', event => {
          window.lastBlockDragOverY = event.clientY;
        });
      });
      if (scrollOwner === 'container') {
        await page.locator('.editor-shell').evaluate(
          (shell, start) => {
            shell.style.cssText =
              'position:fixed;top:60px;left:100px;width:800px;height:400px;overflow:auto;margin:0;';
            shell.scrollTop = start;
          },
          direction === 'up' ? 2000 : 0,
        );
      } else {
        await page.evaluate(
          start => window.scrollTo(0, start),
          direction === 'up' ? 2000 : 0,
        );
      }
      const sourceLabel = direction === 'up' ? 'Block 75' : 'Block 0';
      await root
        .locator('p')
        .filter({hasText: new RegExp(`^${sourceLabel}$`)})
        .hover();
      const scrollOffset = () =>
        page.evaluate(
          owner =>
            owner === 'container'
              ? document.querySelector('.editor-shell').scrollTop
              : window.scrollY,
          scrollOwner,
        );
      const initialOffset = await scrollOffset();
      const handle = page.locator('.draggable-block-menu .icon').last();
      await expect(handle).toBeVisible();
      // Grab the drag icon rather than the adjacent add button.
      const handleBox = await handle.boundingBox();
      await page.mouse.move(
        handleBox.x + handleBox.width / 2,
        handleBox.y + handleBox.height / 2,
      );
      await page.mouse.down();
      const rootBox = await root.boundingBox();
      const edge =
        scrollOwner === 'container'
          ? (await page.locator('.editor-shell').boundingBox()).y +
            (direction === 'up' ? 5 : 395)
          : direction === 'up'
            ? 5
            : page.viewportSize().height - 5;
      await page.mouse.move(rootBox.x + 80, edge, {steps: 20});
      await page.mouse.move(rootBox.x + 81, edge);
      await page.mouse.move(rootBox.x + 82, edge);
      await expect
        .poll(
          async () =>
            ((await scrollOffset()) - initialOffset) *
            (direction === 'up' ? -1 : 1),
        )
        .toBeGreaterThan(100);
      const before = await scrollOffset();
      // No mouse movement between these observations: scrolling must continue.
      await expect
        .poll(
          async () =>
            ((await scrollOffset()) - before) * (direction === 'up' ? -1 : 1),
        )
        .toBeGreaterThan(100);
      await page.mouse.move(
        rootBox.x + 80,
        scrollOwner === 'container' ? 260 : page.viewportSize().height / 2,
        {steps: 10},
      );
      await page.mouse.move(
        rootBox.x + 81,
        scrollOwner === 'container' ? 260 : page.viewportSize().height / 2,
      );
      await expect
        .poll(async () => {
          await page.mouse.move(
            rootBox.x + 82,
            scrollOwner === 'container' ? 260 : page.viewportSize().height / 2,
          );
          await page.mouse.move(
            rootBox.x + 81,
            scrollOwner === 'container' ? 260 : page.viewportSize().height / 2,
          );
          return page.evaluate(() => window.lastBlockDragOverY);
        })
        .toBe(
          scrollOwner === 'container' ? 260 : page.viewportSize().height / 2,
        );
      const targetLabel = await page.evaluate(
        ({x, y}) => {
          const target = document.elementFromPoint(x, y)?.closest('p');
          return target?.textContent;
        },
        {
          x: rootBox.x + 80,
          y: scrollOwner === 'container' ? 260 : page.viewportSize().height / 2,
        },
      );
      expect(targetLabel).toBeTruthy();
      await page.mouse.up();
      await expect
        .poll(async () => {
          const labels = await root.locator('p').allTextContents();
          return labels[labels.indexOf(targetLabel) + 1];
        })
        .toBe(sourceLabel);
    });
  }
}
