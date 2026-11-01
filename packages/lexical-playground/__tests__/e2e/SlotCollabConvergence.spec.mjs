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
  expect,
  focusEditor,
  initialize,
  sleep,
  test,
  waitForSelector,
} from '../utils/index.mjs';

// The other client. `focusEditor` and all the keyboard/click helpers act on the
// 'left' frame, so reading 'right' proves the slot host and its slot contents
// crossed the Yjs channel rather than only rendering locally.
function otherFrame(page) {
  return page.frame('right');
}

// Insert a Card and type its "Title" / "Body" content on the left frame. The
// Card model seeds empty fields (the hints are CSS placeholders), so the slot
// text whose convergence these tests assert is typed here rather than baked
// into the node.
async function insertCard(page) {
  await page.keyboard.type('/card');
  await waitForSelector(page, '.typeahead-popover');
  await page.keyboard.press('Enter');
  await click(page, '[data-lexical-slot="title"] p');
  await page.keyboard.type('Title');
  await click(page, '.lexical-card-node > p');
  await page.keyboard.type('Body');
}

async function insertPullQuote(page) {
  await page.keyboard.type('/pull');
  await waitForSelector(page, '.typeahead-popover');
  await page.keyboard.press('Enter');
}

// The Card body is regular ElementNode children, not a named slot, so its
// paragraphs sit directly under `.lexical-card-node` rather than inside a
// `[data-lexical-slot]` wrapper.
function cardBodyText(frame) {
  return frame.evaluate(() => {
    const card = document.querySelector('.lexical-card-node');
    if (!card) {
      return null;
    }
    return Array.from(
      card.querySelectorAll(':scope > p.PlaygroundEditorTheme__paragraph'),
    )
      .map(p =>
        Array.from(p.querySelectorAll('span[data-lexical-text="true"]'))
          .map(s => s.textContent)
          .join(''),
      )
      .join('⏎');
  });
}

function slotText(frame, name) {
  return frame.evaluate(n => {
    const slot = document.querySelector(`[data-lexical-slot="${n}"]`);
    if (!slot) {
      return null;
    }
    return Array.from(
      slot.querySelectorAll('p.PlaygroundEditorTheme__paragraph'),
    )
      .map(p =>
        Array.from(p.querySelectorAll('span[data-lexical-text="true"]'))
          .map(s => s.textContent)
          .join(''),
      )
      .join('⏎');
  }, name);
}

function cardCount(frame) {
  return frame.evaluate(
    () => document.querySelectorAll('.lexical-card-node').length,
  );
}

function slotCount(frame, name) {
  return frame.evaluate(
    n => document.querySelectorAll(`[data-lexical-slot="${n}"]`).length,
    name,
  );
}

function pullquoteCount(frame) {
  return frame.evaluate(
    () => document.querySelectorAll('.lexical-pullquote-node').length,
  );
}

test.describe('Named slot collaborative convergence', () => {
  test.skip(
    ({isCollab, isPlainText}) => !isCollab || isPlainText,
    'Requires rich text with collaboration',
  );
  test.beforeEach(async ({isCollab, page}) => {
    // Only meaningful with a second client; plain text has no slot hosts.

    await initialize({isCollab, page});
  });

  test('an ElementNode slot host and its slot text converge to the other client', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertCard(page);

    const right = otherFrame(page);
    await expect.poll(() => cardCount(right)).toBe(1);
    await expect.poll(() => slotCount(right, 'title')).toBe(1);
    await expect.poll(() => slotText(right, 'title')).toBe('Title');
    await expect.poll(() => cardBodyText(right)).toBe('Body');
  });

  test('editing slot text on one client converges to the other', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertCard(page);
    const right = otherFrame(page);
    await expect.poll(() => slotText(right, 'title')).toBe('Title');

    await click(page, '[data-lexical-slot="title"]');
    await sleep(100);
    await moveToLineEnd(page);
    await page.keyboard.type('X');
    await sleep(120);

    await expect.poll(() => slotText(right, 'title')).toBe('TitleX');
    // The body children must not have been disturbed by the title slot edit.
    await expect.poll(() => cardBodyText(right)).toBe('Body');
  });

  test('a DecoratorNode slot host converges with both editable slots intact', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertPullQuote(page);

    const right = otherFrame(page);
    await expect.poll(() => pullquoteCount(right)).toBe(1);
    await expect.poll(() => slotCount(right, 'quote')).toBe(1);
    await expect.poll(() => slotCount(right, 'attribution')).toBe(1);
    // Both slot values are SlotContainerNodes with seeded text — the seed
    // must arrive on the other client.
    await expect
      .poll(() => slotText(right, 'quote'))
      .toContain('discover the limits');
    await expect
      .poll(() => slotText(right, 'attribution'))
      .toBe('Arthur C. Clarke');
  });
});
