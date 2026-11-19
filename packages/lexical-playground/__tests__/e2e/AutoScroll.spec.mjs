/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {toggleBulletList} from '../keyboardShortcuts/index.mjs';
import {
  evaluate,
  expect,
  focusEditor,
  initialize,
  test,
} from '../utils/index.mjs';

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('Auto scroll while typing', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  async function addScroll(page, selector_) {
    await evaluate(
      page,
      selector => {
        const element = document.querySelector(selector);
        element.style.overflow = 'auto';
        element.style.maxHeight = '200px';
      },
      selector_,
    );
  }

  async function isCaretVisible(page, selector_) {
    return await evaluate(
      page,
      selector => {
        const selection = document.getSelection();
        const range = selection.getRangeAt(0);
        const element = document.createElement('span');
        element.innerHTML = '|';
        range.insertNode(element);
        const selectionRect = element.getBoundingClientRect();
        element.parentNode.removeChild(element);
        const containerRect = document
          .querySelector(selector)
          .getBoundingClientRect();

        return (
          selectionRect.top >= containerRect.top &&
          selectionRect.top < containerRect.bottom
        );
      },
      selector_,
    );
  }

  [
    {
      name: 'Can auto scroll if content editable element is scrollable',
      selector: '.ContentEditable__root',
    },
    {
      name: 'Can auto scroll if parent element is scrollable',
      selector: '.editor-container',
    },
  ].forEach(testCase => {
    [true, false].forEach(isSoftLineBreak => {
      test.describe(() => {
        test.skip(isSoftLineBreak);
        test(`${testCase.name}${
          isSoftLineBreak ? ' (soft line break)' : ''
        }`, async ({page}) => {
          await focusEditor(page);
          await addScroll(page, testCase.selector);

          for (let i = 0; i < 15; i++) {
            await page.keyboard.type('Hello');

            if (isSoftLineBreak) {
              await page.keyboard.down('Shift');
              await page.keyboard.press('Enter');
              await page.keyboard.up('Shift');
            } else {
              await page.keyboard.press('Enter');
            }

            expect(await isCaretVisible(page, testCase.selector)).toBe(true);
          }
        });
      });
    });
  });
});

test.describe('Auto scroll respects mobile visual viewport', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  // Replace window.visualViewport with a stub reporting a smaller height,
  // simulating an on-screen keyboard occupying the lower part of the viewport.
  // Layout viewport (window.innerHeight) stays unchanged, only the visible
  // area shrinks, like it does on a real mobile browser.
  //
  // Dispatch a 'resize' event right after installing the stub to mirror the real
  // browser sequence (keyboard appears -> visualViewport.onresize fires).
  async function shrinkVisualViewport(page, visibleHeight) {
    await evaluate(
      page,
      h => {
        const target = new EventTarget();
        const stub = {
          addEventListener: target.addEventListener.bind(target),
          dispatchEvent: target.dispatchEvent.bind(target),
          height: h,
          offsetLeft: 0,
          offsetTop: 0,
          onresize: null,
          onscroll: null,
          pageLeft: window.scrollX,
          pageTop: window.scrollY,
          removeEventListener: target.removeEventListener.bind(target),
          scale: 1,
          width: window.innerWidth,
        };
        Object.defineProperty(window, 'visualViewport', {
          configurable: true,
          get() {
            return stub;
          },
        });
        target.dispatchEvent(new Event('resize'));
      },
      visibleHeight,
    );
  }

  // Returns the bottom (in layout-viewport coords) of the current caret.
  // Read-only: no DOM mutation, so Lexical's mutation observer / reconciler is
  // not triggered.
  // For an element-anchor we take the child at focusOffset (the placeholder <br> inserted in empty blocks),
  // otherwise we fall back to the range's own rect.
  async function caretBottom(page) {
    return await evaluate(page, () => {
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) {
        return null;
      }
      const focusNode = sel.focusNode;
      if (focusNode && focusNode.nodeType === 1) {
        const child = focusNode.childNodes[sel.focusOffset];
        if (child && child.nodeType === 1) {
          return child.getBoundingClientRect().bottom;
        }
      }
      const range = sel.getRangeAt(0);
      const r = range.getBoundingClientRect();
      if (r.top === 0 && r.bottom === 0 && r.width === 0 && r.height === 0) {
        return null;
      }
      return r.bottom;
    });
  }

  // Wait one animation frame so Lexical's post-update DOM/scroll settles before we measure positions.
  async function waitForFrame(page) {
    await evaluate(
      page,
      () =>
        new Promise(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
  }

  // Half-screen keyboard: visible area on top, hidden area below.
  const VIEWPORT_HEIGHT = 600;
  const KEYBOARD_HEIGHT = VIEWPORT_HEIGHT / 2;

  test('Pressing Enter scrolls new caret above the on-screen keyboard', async ({
    page,
  }) => {
    await page.setViewportSize({height: VIEWPORT_HEIGHT, width: 400});
    await focusEditor(page);
    await toggleBulletList(page);

    // Fill the list past overflow so the last item lives below the keyboard.
    for (let i = 0; i < 30; i++) {
      await page.keyboard.insertText(`Item ${i}`);
      await page.keyboard.press('Enter');
    }
    await page.keyboard.insertText('Last');

    // Mirrors the real mobile sequence: focus -> keyboard appears -> visualViewport resize event fires.
    await shrinkVisualViewport(page, VIEWPORT_HEIGHT - KEYBOARD_HEIGHT);
    await waitForFrame(page);

    await page.keyboard.press('Enter');
    await waitForFrame(page);

    const bottom = await caretBottom(page);
    // offsetTop + height (not just height) so the assertion stays correct
    // on iOS where the visual viewport can be offset within the layout.
    const visualViewportBottom = await evaluate(
      page,
      () => window.visualViewport.offsetTop + window.visualViewport.height,
    );

    expect(bottom).not.toBeNull();
    // Sub-pixel tolerance: Firefox can return e.g. 300.27 when the scroll
    // target is exactly 300 due to fractional layout rounding. The original
    // bug overshoots by ~280 px, so 1 px still catches it cleanly.
    expect(bottom).toBeLessThanOrEqual(visualViewportBottom + 1);
  });
});
