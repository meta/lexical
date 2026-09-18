/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {expect} from '@playwright/test';

import {
  moveToLineBeginning,
  moveToLineEnd,
  selectCharacters,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  E2E_PORT,
  focusEditor,
  html,
  initialize,
  sleep,
  test,
} from '../utils/index.mjs';

/**
 * Same origin as the playground on purpose. A cross-origin target makes WebKit
 * swap the popup into a brand new WebContent process, which is both slow and,
 * on macOS CI, a way to crash the browser out from under the test.
 */
const LINK_URL = `http://localhost:${E2E_PORT}/link-target`;

/**
 * How long to wait before concluding that no (further) tab was opened. The
 * browser opens a middle-clicked link itself, on top of anything the page
 * does, so "exactly one tab" only means something after the browser has had
 * a chance to open a second one.
 */
const NO_MORE_TABS_MS = 1000;

/**
 * Serve the link target from the test itself, so no test depends on the dev
 * server having a route there. Installed on the BrowserContext rather than the
 * Page so that it also covers the tabs opened by clicking the link, which is
 * the whole point of these tests.
 */
async function stubLinkTarget(page) {
  await page.context().route('**/link-target', route =>
    route.fulfill({
      body: '<!doctype html><title>target</title>',
      contentType: 'text/html',
    }),
  );
}

/**
 * Records every tab the browser opens from here on. `settle()` waits long
 * enough for a tab the browser opens on its own (a native middle click) to
 * show up, then returns the URLs of everything that opened.
 */
function recordOpenedTabs(page) {
  const context = page.context();
  const opened = [];
  const onPage = newPage => opened.push(newPage);
  context.on('page', onPage);
  return {
    async settle() {
      await sleep(NO_MORE_TABS_MS);
      context.off('page', onPage);
      const urls = [];
      for (const newPage of opened) {
        await newPage
          .waitForLoadState('domcontentloaded')
          .catch(() => undefined);
        urls.push(newPage.url());
        // Close as we go: an unclosed tab is a live renderer process for the
        // rest of the worker's run.
        await newPage.close().catch(() => undefined);
      }
      return urls;
    },
  };
}

/** Real mouse input at the center of the editor's only link. */
async function clickLink(page, button) {
  const link = page.locator('[data-lexical-editor="true"] a').first();
  await expect(link).toBeVisible();
  const box = await link.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
    button,
  });
}

/** Type `Hello world` and turn `Hello` into a link pointing at LINK_URL. */
async function createLink(page) {
  await focusEditor(page);
  await page.keyboard.type('Hello world');
  await moveToLineBeginning(page);
  await selectCharacters(page, 'right', 5);
  await click(page, '.link');
  await page.fill('.link-input', LINK_URL);
  await click(page, '.link-confirm');
  await assertHTML(
    page,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <a
          class="PlaygroundEditorTheme__link"
          href="${LINK_URL}"
          rel="noreferrer">
          <span data-lexical-text="true">Hello</span>
        </a>
        <span data-lexical-text="true">world</span>
      </p>
    `,
  );
}

/**
 * Put the caret past the link. `registerClickableLink` deliberately ignores a
 * click while text is selected -- that is a user dragging over the link text,
 * not following it -- and creating a link leaves its text selected.
 */
async function collapseSelectionAfterLink(page) {
  await moveToLineEnd(page);
}

async function toggleReadOnly(page) {
  await click(page, '.action-button.lock');
  await expect(
    page.locator('div[contenteditable="false"][data-lexical-editor="true"]'),
  ).toBeVisible();
}

// These drive real mouse buttons and count the tabs the browser opens, which
// the split-frame collab harness cannot observe, and links need rich text.
test.beforeEach(({isCollab, isPlainText}) => {
  test.skip(isPlainText || isCollab);
});

test.describe('Clickable links', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test.describe('read-only mode', () => {
    test('a left click opens the link in exactly one tab', async ({page}) => {
      await stubLinkTarget(page);
      await createLink(page);
      await collapseSelectionAfterLink(page);
      await toggleReadOnly(page);

      const tabs = recordOpenedTabs(page);
      await clickLink(page, 'left');

      expect(await tabs.settle()).toEqual([LINK_URL]);
    });

    test('a middle click opens the link in exactly one tab', async ({page}) => {
      await stubLinkTarget(page);
      await createLink(page);
      await collapseSelectionAfterLink(page);
      await toggleReadOnly(page);

      const tabs = recordOpenedTabs(page);
      await clickLink(page, 'middle');

      // Canceling `mouseup` does not stop the browser from opening a
      // middle-clicked link itself, so handling the middle button there
      // opened the URL twice: once natively and once through `window.open`.
      expect(await tabs.settle()).toEqual([LINK_URL]);
    });

    test('a right click does not open the link', async ({page}) => {
      await stubLinkTarget(page);
      await createLink(page);
      await collapseSelectionAfterLink(page);
      await toggleReadOnly(page);

      const tabs = recordOpenedTabs(page);
      await clickLink(page, 'right');
      // Dismiss the native context menu the right click may have raised.
      await page.keyboard.press('Escape');

      // `auxclick` fires for every non-primary button, not just the middle
      // one, so a right click must not be mistaken for a middle click -- it
      // belongs to the context menu.
      expect(await tabs.settle()).toEqual([]);
    });

    test('the link editor does not open', async ({page}) => {
      await stubLinkTarget(page);
      await createLink(page);
      await collapseSelectionAfterLink(page);
      await toggleReadOnly(page);

      await clickLink(page, 'left');

      // The link editor is an editing affordance (it offers edit and delete
      // buttons and cannot even resolve the URL while read-only), so it has
      // no place in a read-only editor.
      await expect(page.locator('.link-editor .link-view')).toHaveCount(0);
      await expect(page.locator('.link-editor .link-input')).toHaveCount(0);
    });

    test('locking closes an open link editor', async ({page}) => {
      await createLink(page);

      // The caret is still inside the link, so the link editor is showing.
      await expect(page.locator('.link-editor .link-view')).toHaveCount(1);

      await toggleReadOnly(page);

      await expect(page.locator('.link-editor .link-view')).toHaveCount(0);
    });
  });

  test.describe('editable mode', () => {
    test('the link editor opens for the link under the caret', async ({
      page,
    }) => {
      await createLink(page);

      await expect(page.locator('.link-editor .link-view a')).toHaveAttribute(
        'href',
        LINK_URL,
      );
    });

    test('clicking a link does not follow it', async ({page}) => {
      await stubLinkTarget(page);
      await createLink(page);
      await collapseSelectionAfterLink(page);
      const playgroundURL = page.url();

      const tabs = recordOpenedTabs(page);
      await clickLink(page, 'left');

      // Clickable links are only enabled in read-only mode; in an editable
      // editor a click places the caret instead of navigating.
      expect(await tabs.settle()).toEqual([]);
      expect(page.url()).toBe(playgroundURL);
    });
  });
});
