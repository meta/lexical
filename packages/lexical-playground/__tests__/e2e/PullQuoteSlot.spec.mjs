/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  deleteLineBackward,
  moveToLineBeginning,
  moveToLineEnd,
  selectAll,
} from '../keyboardShortcuts/index.mjs';
import {
  assertCaret,
  click,
  evaluate,
  expect,
  focusEditor,
  initialize,
  IS_MAC,
  sleep,
  test,
  waitForSelector,
} from '../utils/index.mjs';

async function insertPullQuote(page) {
  await page.keyboard.type('/pull');
  await waitForSelector(page, '.typeahead-popover');
  await page.keyboard.press('Enter');
}

// Paragraphs within a slot are joined with a marker so multi-paragraph
// states are unambiguous (mirrors CardSlot.spec).
const PARA = '⏎';

async function slotText(page, name) {
  return evaluate(
    page,
    n => {
      const wrapper = document.querySelector(`[data-lexical-slot="${n}"]`);
      if (!wrapper) {
        return null;
      }
      return Array.from(
        wrapper.querySelectorAll('p.PlaygroundEditorTheme__paragraph'),
      )
        .map(p =>
          Array.from(p.querySelectorAll('span[data-lexical-text="true"]'))
            .map(s => s.textContent)
            .join(''),
        )
        .join('⏎');
    },
    name,
  );
}

async function pullquoteCount(page) {
  return evaluate(
    page,
    () => document.querySelectorAll('.lexical-pullquote-node').length,
  );
}

async function selectedPullquoteCount(page) {
  return evaluate(
    page,
    () =>
      document.querySelectorAll('.lexical-pullquote-node[data-selected="true"]')
        .length,
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

async function selectionInSlot(page, name, collapsed) {
  return evaluate(
    page,
    ({slotName, isCollapsed}) => {
      const slot = document.querySelector(`[data-lexical-slot="${slotName}"]`);
      const editor = window.lexicalEditor;
      const selection = editor.getEditorState()._selection;
      const domSelection = window.getSelection();
      return (
        slot !== null &&
        selection?.anchor !== undefined &&
        selection.isCollapsed() === isCollapsed &&
        slot.contains(editor.getElementByKey(selection.anchor.key)) &&
        slot.contains(editor.getElementByKey(selection.focus.key)) &&
        domSelection !== null &&
        domSelection.isCollapsed === isCollapsed &&
        slot.contains(domSelection.anchorNode) &&
        slot.contains(domSelection.focusNode)
      );
    },
    {isCollapsed: collapsed, slotName: name},
  );
}

async function selectSlotText(page, name) {
  // The native click and Lexical's selectionchange handler settle separately.
  // Select-all must see the slot selection before replacing its content.
  await click(page, `[data-lexical-slot="${name}"] p`);
  await expect.poll(() => selectionInSlot(page, name, true)).toBe(true);
  await selectAll(page);
  await expect.poll(() => selectionInSlot(page, name, false)).toBe(true);
}

test.describe('PullQuote slot host', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(async ({isCollab, page}) => {
    await initialize({isCollab, page});
  });

  test('inserts a PullQuote with two seeded editable slots', async ({page}) => {
    await focusEditor(page);
    await insertPullQuote(page);

    expect(await pullquoteCount(page)).toBe(1);
    expect(await slotText(page, 'quote')).toContain('discover the limits');
    expect(await slotText(page, 'attribution')).toBe('Arthur C. Clarke');
  });

  test('typing inside the quote slot replaces only its text', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertPullQuote(page);

    await selectSlotText(page, 'quote');
    await page.keyboard.type('A new quote');

    await expect.poll(() => slotText(page, 'quote')).toBe('A new quote');
    expect(await slotText(page, 'attribution')).toBe('Arthur C. Clarke');
  });

  test('typing inside the attribution slot replaces only its text', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertPullQuote(page);

    await selectSlotText(page, 'attribution');
    await page.keyboard.type('Someone Else');

    await expect.poll(() => slotText(page, 'attribution')).toBe('Someone Else');
    expect(await slotText(page, 'quote')).toContain('discover the limits');
  });

  // The quote slot keeps a multi-block SlotContainerNode (a quote is
  // legitimately multi-block), so Enter splits a second paragraph inside the
  // slot and Backspace at that paragraph's start merges it back — ordinary
  // intra-slot editing, scoped by the container's shadow root. (This is the
  // multi-paragraph coverage the Card title can no longer host now that its
  // value is a bare single-line paragraph.)
  test('backspace at 2nd-paragraph start merges within the quote slot', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertPullQuote(page);

    // Replace the long seed with a short word first: the seed can wrap
    // across visual lines, which would make moveToLineEnd ambiguous.
    await selectSlotText(page, 'quote');
    await page.keyboard.type('QUOTE');
    await expect.poll(() => slotText(page, 'quote')).toBe('QUOTE');
    await moveToLineEnd(page);
    await assertCaret(page, '[data-lexical-slot="quote"] p > span', 5);
    await page.keyboard.press('Enter');
    await page.keyboard.type('SECOND');
    // Two paragraphs in the quote slot before the merge.
    await expect.poll(() => slotText(page, 'quote')).toBe(`QUOTE${PARA}SECOND`);
    await moveToLineBeginning(page);
    await assertCaret(
      page,
      '[data-lexical-slot="quote"] p:last-child > span',
      0,
    );
    await page.keyboard.press('Backspace');
    await expect.poll(() => slotText(page, 'quote')).toBe('QUOTESECOND');
    expect(await slotText(page, 'attribution')).toBe('Arthur C. Clarke');
    expect(await pullquoteCount(page)).toBe(1);
  });

  // At the end of a slot Chromium's native forward delete covers the whole
  // line before the caret, so Delete there must not empty the slot (#9363).
  test('Delete inside the attribution slot deletes one character', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertPullQuote(page);

    await click(page, '[data-lexical-slot="attribution"] p');
    await expect
      .poll(() => selectionInSlot(page, 'attribution', true))
      .toBe(true);
    await moveToLineEnd(page);
    await page.keyboard.press('Delete');
    await moveToLineBeginning(page);
    await page.keyboard.press('Delete');
    await expect
      .poll(() => slotText(page, 'attribution'))
      .toBe('rthur C. Clarke');
    expect(await slotText(page, 'quote')).toContain('discover the limits');
  });

  // Cmd+Backspace deletes the line, not one character (#9363).
  test('deleteLineBackward inside the quote slot deletes the line', async ({
    page,
  }) => {
    test.skip(!IS_MAC, 'deleteLineBackward is only bound on Mac');
    await focusEditor(page);
    await insertPullQuote(page);

    await selectSlotText(page, 'quote');
    await page.keyboard.type('QUOTE');
    await page.keyboard.press('Enter');
    await page.keyboard.type('SECOND');
    await expect.poll(() => slotText(page, 'quote')).toBe(`QUOTE${PARA}SECOND`);
    await deleteLineBackward(page);
    await expect.poll(() => slotText(page, 'quote')).toBe(`QUOTE${PARA}`);
    expect(await slotText(page, 'attribution')).toBe('Arthur C. Clarke');
  });

  // The attribution slot's value is a bare ParagraphNode — the slot link
  // itself is the virtual shadow root, so the slot holds exactly one block.
  // Enter has no position for a sibling paragraph and is a core no-op
  // (mirrors Enter in an <input>); typing afterwards continues on the same
  // single line.
  test('Enter inside the attribution slot is a no-op (single-line slot)', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertPullQuote(page);

    await click(page, '[data-lexical-slot="attribution"] p');
    await sleep(100);
    await moveToLineEnd(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('!');
    await sleep(120);

    expect(await slotText(page, 'attribution')).not.toContain(PARA);
    expect(await slotText(page, 'attribution')).toBe('Arthur C. Clarke!');
    expect(await slotText(page, 'quote')).toContain('discover the limits');
    expect(await pullquoteCount(page)).toBe(1);
  });

  // Clicking the chrome (the padding outside both slot wrappers) promotes
  // the whole PullQuote to a NodeSelection — mirrored onto the host DOM
  // via `data-selected="true"` by NodeSelectionDataSelectedExtension.
  test('chrome click sets data-selected on the host', async ({page}) => {
    await focusEditor(page);
    await insertPullQuote(page);

    expect(await selectedPullquoteCount(page)).toBe(0);
    await click(page, '.lexical-pullquote-node', {position: {x: 4, y: 4}});
    await sleep(120);
    expect(await selectedPullquoteCount(page)).toBe(1);
  });

  // Clicking inside either slot wrapper must drop the caret in the slot,
  // not promote to a whole-PullQuote NodeSelection. The reconciler scaffold
  // wrapper is keyless, so without the explicit guard in
  // `$resolveChromeTarget` the click would resolve to the PullQuote host
  // and steal focus from the slot the user just clicked into.
  test('slot wrapper click stays in the slot', async ({page}) => {
    await focusEditor(page);
    await insertPullQuote(page);

    await click(page, '[data-lexical-slot="quote"]', {position: {x: 4, y: 4}});
    await sleep(120);
    expect(await selectedPullquoteCount(page)).toBe(0);
  });

  // Enter on the selected PullQuote drops the caret into the quote slot, and
  // Escape from either slot selects the whole PullQuote again — a keyboard
  // counterpart to the chrome click, so the box is reachable both ways.
  test('Enter on the selected PullQuote drops the caret into the quote', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertPullQuote(page);
    await click(page, '.lexical-pullquote-node', {position: {x: 4, y: 4}});
    await sleep(120);
    expect(await selectedPullquoteCount(page)).toBe(1);

    await page.keyboard.press('Enter');
    await sleep(120);
    expect(await caretInSelector(page, '[data-lexical-slot="quote"]')).toBe(
      true,
    );
    expect(await selectedPullquoteCount(page)).toBe(0);
  });

  test('Escape from the quote selects the whole PullQuote', async ({page}) => {
    await focusEditor(page);
    await insertPullQuote(page);
    await click(page, '[data-lexical-slot="quote"]', {position: {x: 4, y: 4}});
    await sleep(120);
    expect(await selectedPullquoteCount(page)).toBe(0);

    await page.keyboard.press('Escape');
    await sleep(120);
    expect(await selectedPullquoteCount(page)).toBe(1);
  });

  test('Escape from the attribution selects the whole PullQuote', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertPullQuote(page);
    await click(page, '[data-lexical-slot="attribution"]', {
      position: {x: 4, y: 4},
    });
    await sleep(120);
    expect(await selectedPullquoteCount(page)).toBe(0);

    await page.keyboard.press('Escape');
    await sleep(120);
    expect(await selectedPullquoteCount(page)).toBe(1);
  });

  // Backspace deletes an empty PullQuote, like the Card / Review.
  test('backspace from the quote of an empty pullquote deletes it', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertPullQuote(page);

    for (const name of ['quote', 'attribution']) {
      await selectSlotText(page, name);
      await page.keyboard.press('Backspace');
      await expect.poll(() => slotText(page, name)).toBe('');
    }

    // Now backspace from the start of the (empty) quote deletes the whole box.
    await click(page, '[data-lexical-slot="quote"] p');
    await expect.poll(() => selectionInSlot(page, 'quote', true)).toBe(true);
    await moveToLineBeginning(page);
    await page.keyboard.press('Backspace');
    await expect.poll(() => pullquoteCount(page)).toBe(0);
  });
});
