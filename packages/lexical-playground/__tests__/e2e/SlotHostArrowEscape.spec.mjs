/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {moveToLineEnd} from '../keyboardShortcuts/index.mjs';
import {
  click,
  evaluate,
  expect,
  focusEditor,
  initialize,
  sleep,
  test,
  waitForSelector,
} from '../utils/index.mjs';

async function insertReview(page) {
  await page.keyboard.type('/review');
  await waitForSelector(page, '.typeahead-popover');
  await page.keyboard.press('Enter');
  await waitForSelector(page, '.lexical-review-chrome');
}

// Drop the empty boundary paragraph at the given edge of the document so the
// slot host becomes the first / last block. Deleting it by keyboard is
// unreliable around a shadow-root host (forward-merge into the host is a no-op),
// so go through the editor API and only ever remove an empty paragraph — never
// the host itself.
async function makeHostEdgeBlock(page, edge) {
  await evaluate(
    page,
    side => {
      const editor = window.lexicalEditor;
      editor.update(
        () => {
          const root = editor.getEditorState()._nodeMap.get('root');
          const child =
            side === 'first' ? root.getFirstChild() : root.getLastChild();
          if (
            child !== null &&
            child.getType() === 'paragraph' &&
            child.getTextContent() === ''
          ) {
            child.remove();
          }
        },
        {discrete: true},
      );
    },
    edge,
  );
  await sleep(80);
}

// Text of the top-level block immediately before / after the host, or null if
// there is none — used to confirm an arrow press inserted a paragraph outside
// the host and landed the caret there.
async function blockOutsideHost(page, hostSelector, side) {
  return evaluate(
    page,
    ([sel, which]) => {
      const root = document.querySelector('[data-lexical-editor="true"]');
      const host = document.querySelector(sel);
      if (root === null || host === null) {
        return null;
      }
      const blocks = Array.from(root.children);
      const index = blocks.indexOf(host);
      const target = which === 'before' ? blocks[index - 1] : blocks[index + 1];
      return target ? target.textContent : null;
    },
    [hostSelector, side],
  );
}

// Whether the collapsed DOM caret is inside an element matching `selector`.
async function caretInSelector(page, selector) {
  return evaluate(
    page,
    sel => {
      const s = window.getSelection();
      if (!s || s.rangeCount === 0 || s.anchorNode === null) {
        return false;
      }
      const node = s.anchorNode;
      const el = node.nodeType === 3 ? node.parentElement : node;
      return el !== null && el.closest(sel) !== null;
    },
    selector,
  );
}

async function blockCount(page) {
  return evaluate(
    page,
    () =>
      document.querySelector('[data-lexical-editor="true"]').children.length,
  );
}

const REVIEW = '.lexical-review-node';
const REVIEW_AUTHOR = '.lexical-review-author [data-lexical-slot="author"] p';
const REVIEW_BODY_FIRST = '.lexical-review-children p:first-child';

// The slot-aware ArrowDown/Up navigation (registerSlotHostArrowEscape) keeps a
// slot host from trapping the caret: it steps between the host's regions across
// the contentEditable island boundaries that Firefox will not cross on its own,
// and inserts a paragraph before/after the host when it is the first/last block
// so the host is never a dead end. Stepping into an existing sibling is left to
// the browser.
test.describe('Slot host ArrowDown/Up escape', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(({isCollab, page}) => {
    return initialize({isCollab, page});
  });

  // The Review is the interesting case: its chrome renders the body children
  // ABOVE the `author` slot, the opposite of the slots-first Card / PullQuote.
  // The helper reads the rendered order, so no per-host configuration is needed.
  test('Review: ArrowDown at the end of the author (last block) exits below it', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await click(page, REVIEW_AUTHOR);
    await page.keyboard.type('Jane');
    await makeHostEdgeBlock(page, 'last');

    await click(page, REVIEW_AUTHOR);
    await moveToLineEnd(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.type('After');
    await sleep(120);

    expect(await blockOutsideHost(page, REVIEW, 'after')).toBe('After');
    // The author line was not disturbed by the escape.
    expect(
      await evaluate(
        page,
        sel => {
          const p = document.querySelector(sel);
          return p ? p.textContent : null;
        },
        REVIEW_AUTHOR,
      ),
    ).toBe('Jane');
  });

  test('Review: ArrowDown from the body steps into the author', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await click(page, REVIEW_BODY_FIRST);
    await page.keyboard.type('Body');
    await click(page, REVIEW_AUTHOR);
    await page.keyboard.type('Jane');
    // The `author` slot renders below the body in the chrome. Even as the last
    // block (no trailing sibling to step into), ArrowDown from the body steps
    // into the author across the contentEditable island rather than escaping the
    // Review. The helper performs the move programmatically, so it works in
    // Firefox too — not only via Chromium's native cross-island navigation.
    await makeHostEdgeBlock(page, 'last');
    const before = await blockCount(page);

    await click(page, REVIEW_BODY_FIRST);
    await moveToLineEnd(page);
    await page.keyboard.press('ArrowDown');
    await sleep(100);

    expect(await caretInSelector(page, '[data-lexical-slot="author"]')).toBe(
      true,
    );
    // Stepping between regions must not insert a paragraph.
    expect(await blockCount(page)).toBe(before);
  });
});
