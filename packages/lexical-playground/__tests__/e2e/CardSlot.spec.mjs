/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveToLineBeginning,
  moveToLineEnd,
  selectAll,
} from '../keyboardShortcuts/index.mjs';
import {
  click,
  copyToClipboard,
  evaluate,
  expect,
  focusEditor,
  initialize,
  pasteFromClipboard,
  sleep,
  test,
  waitForSelector,
} from '../utils/index.mjs';

// Insert a Card and type the demo "Title" / "Body" content the slot-mechanics
// tests operate on. The model seeds empty fields (the hints are CSS
// placeholders), so the content is typed here rather than baked into the node.
async function insertCard(page) {
  await insertEmptyCard(page);
  await click(page, '[data-lexical-slot="title"] p');
  await page.keyboard.type('Title');
  await click(page, '.lexical-card-node > p');
  await page.keyboard.type('Body');
}

async function insertEmptyCard(page) {
  await page.keyboard.type('/card');
  await waitForSelector(page, '.typeahead-popover');
  await page.keyboard.press('Enter');
}

// Paragraphs within a slot are joined with a marker so multi-paragraph
// states are unambiguous; an empty slot yields ''.
const PARA = '⏎';

async function slotText(page, name) {
  return evaluate(
    page,
    n => {
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
    },
    name,
  );
}

async function cardCount(page) {
  return evaluate(
    page,
    () => document.querySelectorAll('.lexical-card-node').length,
  );
}

async function selectedCardCount(page) {
  return evaluate(
    page,
    () =>
      document.querySelectorAll('.lexical-card-node[data-selected="true"]')
        .length,
  );
}

async function slotCount(page, name) {
  return evaluate(
    page,
    n => document.querySelectorAll(`[data-lexical-slot="${n}"]`).length,
    name,
  );
}

// The Card body is regular ElementNode children, not a named slot, so its
// paragraphs sit directly under `.lexical-card-node` rather than inside a
// `[data-lexical-slot]` wrapper.
async function bodyText(page) {
  return evaluate(page, () => {
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

async function placeholderBefore(page, selector) {
  return evaluate(
    page,
    sel => {
      const el = document.querySelector(sel);
      return el && window.getComputedStyle(el, '::before').content;
    },
    selector,
  );
}

async function assertCardIntact(page, {title, body}) {
  expect(await cardCount(page)).toBe(1);
  expect(await slotCount(page, 'title')).toBe(1);
  expect(await slotText(page, 'title')).toBe(title);
  expect(await bodyText(page)).toBe(body);
}

// Place the caret at the start of the block immediately after the card (the
// trailing paragraph $insertNodeToNearestRoot leaves behind), to verify
// Backspace from there leaves the host alone (#8712).
async function selectStartAfterCard(page) {
  await evaluate(page, () => {
    const editor = window.lexicalEditor;
    editor.update(
      () => {
        const root = editor.getEditorState()._nodeMap.get('root');
        for (const child of root.getChildren()) {
          if (child.getType() === 'card') {
            const next = child.getNextSibling();
            if (next) {
              next.selectStart();
            }
          }
        }
      },
      {discrete: true},
    );
  });
  await sleep(60);
}

test.describe('Card slot deletion boundaries', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(async ({isCollab, page}) => {
    await initialize({isCollab, page});
  });

  // --- Boundary no-op cases: the card must stay structurally intact ---

  test('backspace at empty title-slot start is a no-op', async ({page}) => {
    await focusEditor(page);
    await insertCard(page);
    await click(page, '[data-lexical-slot="title"]');
    await sleep(100);
    // Empty the slot with the same caret-then-single-key pattern the other
    // boundary tests use; the Meta+a variant flaked in CI.
    await moveToLineEnd(page);
    for (let i = 0; i < 'Title'.length; i++) {
      await page.keyboard.press('Backspace');
    }
    await sleep(120);
    expect(await slotText(page, 'title')).toBe('');
    // Caret is now at the empty slot start: this backspace must be a no-op.
    await page.keyboard.press('Backspace');
    await sleep(120);
    await assertCardIntact(page, {body: 'Body', title: ''});
  });

  test('backspace at non-empty title-slot start is a no-op', async ({page}) => {
    await focusEditor(page);
    await insertCard(page);
    await click(page, '[data-lexical-slot="title"]');
    await sleep(100);
    await moveToLineBeginning(page);
    await page.keyboard.press('Backspace');
    await sleep(120);
    await assertCardIntact(page, {body: 'Body', title: 'Title'});
  });

  test('forward-delete at title-slot end is a no-op', async ({page}) => {
    await focusEditor(page);
    await insertCard(page);
    await click(page, '[data-lexical-slot="title"]');
    await sleep(100);
    await moveToLineEnd(page);
    await page.keyboard.press('Delete');
    await sleep(120);
    await assertCardIntact(page, {body: 'Body', title: 'Title'});
  });

  // --- Intra-slot deletion: ordinary editing within a slot must still work ---

  test('backspace deletes one char within title slot', async ({page}) => {
    await focusEditor(page);
    await insertCard(page);
    await click(page, '[data-lexical-slot="title"]');
    await sleep(100);
    await moveToLineEnd(page);
    await page.keyboard.press('Backspace');
    await sleep(120);
    await assertCardIntact(page, {body: 'Body', title: 'Titl'});
  });

  test('forward-delete one char within body', async ({page}) => {
    await focusEditor(page);
    await insertCard(page);
    // Body is regular ElementNode children, so its paragraph sits directly
    // under the card rather than inside a `[data-lexical-slot]` wrapper.
    await click(page, '.lexical-card-node > p');
    await sleep(100);
    await moveToLineBeginning(page);
    await page.keyboard.press('Delete');
    await sleep(120);
    await assertCardIntact(page, {body: 'ody', title: 'Title'});
  });

  // --- Empty-card deletion: backspace removes the whole box ---

  test('backspace from the title of an empty card deletes the card', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertEmptyCard(page);
    expect(await cardCount(page)).toBe(1);

    await click(page, '[data-lexical-slot="title"]');
    await moveToLineBeginning(page);
    await page.keyboard.press('Backspace');
    await sleep(120);

    expect(await cardCount(page)).toBe(0);
  });

  test('backspace from the block after an empty card leaves the card alone (#8712)', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertEmptyCard(page);
    expect(await cardCount(page)).toBe(1);

    await selectStartAfterCard(page);
    await page.keyboard.press('Backspace');
    await sleep(120);

    // Per #8712: the caret sits in the next block, not the host, so
    // Backspace leaves the host alone — the trailing paragraph is dropped
    // and the caret lands inside the card body. The inside-host escape
    // gesture (caret at the start of the empty title) still removes the
    // card; covered above.
    expect(await cardCount(page)).toBe(1);
  });

  test('select-all + Backspace replaces a first-block card with a paragraph', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertEmptyCard(page);
    await click(page, '.lexical-card-node > p');
    await page.keyboard.type('Body');
    await sleep(100);

    // Cmd+A from the body is document-scoped (the body is the child channel),
    // so this selects the whole document; one Backspace replaces the Card.
    await selectAll(page);
    await sleep(80);
    await page.keyboard.press('Backspace');
    await sleep(120);

    expect(await cardCount(page)).toBe(0);
    expect(
      await evaluate(page, () =>
        Array.from(
          document.querySelector('[data-lexical-editor="true"]').children,
        ).map(c => c.tagName.toLowerCase()),
      ),
    ).toEqual(['p']);
  });

  // --- Single-line slot: the title's value is a bare paragraph ---

  // The title slot's value is a bare ParagraphNode — the slot link itself is
  // the virtual shadow root, so the slot holds exactly one block. Enter has
  // no position for a sibling paragraph and is a core no-op (mirrors Enter
  // in an <input>); typing afterwards continues on the same single line.
  // (Multi-paragraph intra-slot merging is covered by the PullQuote quote
  // slot, which keeps a multi-block SlotContainerNode.)
  test('Enter inside the title slot is a no-op (single-line slot)', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertCard(page);
    await click(page, '[data-lexical-slot="title"]');
    await sleep(100);
    await moveToLineEnd(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('SECOND');
    await sleep(120);
    // Still a single paragraph: the Enter did not split the title.
    expect(await slotText(page, 'title')).not.toContain(PARA);
    await assertCardIntact(page, {body: 'Body', title: 'TitleSECOND'});
  });
});

test.describe('Card HTML serialization round-trip', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(async ({isCollab, page}) => {
    await initialize({isCollab, page});
  });

  test('copying a card and pasting it as HTML-only rebuilds its slots', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertCard(page);
    await assertCardIntact(page, {body: 'Body', title: 'Title'});

    // Select the whole card through its chrome — the 12px padding outside the
    // slots, which CardExtension promotes to a NodeSelection. A click in the
    // slot interior would drop the caret inside the slot instead.
    await click(page, '.lexical-card-node', {position: {x: 6, y: 6}});
    await sleep(100);

    const clipboard = await copyToClipboard(page);
    // Export side: title rides in its named wrapper (the explicit
    // serialization from CardNode.exportDOM); body is regular children, so
    // its paragraph serializes through the normal child path with no slot
    // wrapper.
    expect(clipboard['text/html']).toContain('data-lexical-slot="title"');
    expect(clipboard['text/html']).not.toContain('data-lexical-slot="body"');

    // Drop the whole card, then paste HTML-only. The clipboard also carries
    // lexical JSON, which paste would prefer; passing text/html alone forces
    // the DOMImportExtension card rule — the import path this change adds.
    await page.keyboard.press('Backspace');
    await sleep(120);
    expect(await cardCount(page)).toBe(0);
    await pasteFromClipboard(page, {'text/html': clipboard['text/html']});
    await sleep(200);

    await assertCardIntact(page, {body: 'Body', title: 'Title'});
  });
});

test.describe('Card host data-selected mirroring', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(async ({isCollab, page}) => {
    await initialize({isCollab, page});
  });

  // CardNode and PullQuoteNode both register the shared
  // NodeSelectionDataSelectedExtension under one name, each contributing its
  // own node type. The two `nodes` arrays must concatenate during config
  // merge; a plain shallow merge would let the last contributor win and the
  // Card host would never mirror its selection. This guards the Card side
  // (PullQuoteSlot guards the PullQuote side, so the pair covers the merge).
  test('selecting a card sets data-selected on its host', async ({page}) => {
    await focusEditor(page);
    await insertCard(page);
    expect(await selectedCardCount(page)).toBe(0);
    // Click the chrome (the 12px padding outside the slots) to promote the
    // whole card to a NodeSelection.
    await click(page, '.lexical-card-node', {position: {x: 6, y: 6}});
    await sleep(120);
    expect(await selectedCardCount(page)).toBe(1);
  });
});

// Counterpart to the data-selected mirroring above: a click inside the title
// slot wrapper (the keyless data-lexical-slot region — its editable paragraph
// or surrounding padding / border) must drop the caret into the slot and NOT
// promote to a whole-Card NodeSelection. The reconciler scaffold wrapper is
// keyless, so without the explicit guard $getNearestNodeFromDOMNode would walk
// past it to the Card and the CLICK_COMMAND would promote.
test.describe('Card slot wrapper click does not promote', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(async ({isCollab, page}) => {
    await initialize({isCollab, page});
  });

  test('clicking inside the title slot keeps the click in the slot', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertCard(page);
    expect(await selectedCardCount(page)).toBe(0);
    // A click at the wrapper's top-left lands on the title's editable
    // paragraph (or the wrapper padding around it), which must keep the
    // caret in the slot rather than select the whole card.
    await click(page, '[data-lexical-slot="title"]', {position: {x: 4, y: 4}});
    await sleep(120);
    expect(await selectedCardCount(page)).toBe(0);
  });
});

// The Card model seeds empty fields; the "Title" / "Body" hints are CSS
// placeholders shown only while a field is empty (no seeded TextNodes), so
// they never appear in the serialized model or in copied text.
test.describe('Card empty-field placeholders', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(async ({isCollab, page}) => {
    await initialize({isCollab, page});
  });

  test('an inserted card starts empty with CSS placeholders, which clear on typing', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertEmptyCard(page);
    await sleep(120);

    // the model carries no text — the hints are purely presentational
    expect(await slotText(page, 'title')).toBe('');
    expect(await bodyText(page)).toBe('');

    // the placeholder text comes from CSS ::before, not from the DOM text
    const titleSelector = '.lexical-card-node [data-lexical-slot="title"] p';
    const bodySelector = '.lexical-card-node > p';
    expect(await placeholderBefore(page, titleSelector)).toContain('Title');
    expect(await placeholderBefore(page, bodySelector)).toContain('Body');

    // typing into the title clears its placeholder but not the body's
    await click(page, '[data-lexical-slot="title"] p');
    await page.keyboard.type('Hi');
    await sleep(120);
    const titleAfterTyping = await placeholderBefore(page, titleSelector);
    expect(titleAfterTyping === 'none' || titleAfterTyping === '').toBe(true);
    expect(await placeholderBefore(page, bodySelector)).toContain('Body');
  });

  test('pasting text into an empty title clears its placeholder immediately (#9126)', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertEmptyCard(page);
    await sleep(120);

    await click(page, '[data-lexical-slot="title"] p');
    await pasteFromClipboard(page, {'text/plain': 'Pasted Title'});
    await sleep(120);

    expect(await slotText(page, 'title')).toBe('Pasted Title');
    const before = await placeholderBefore(
      page,
      '.lexical-card-node [data-lexical-slot="title"] p',
    );
    expect(before === 'none' || before === '').toBe(true);
  });

  test('pasting text into an empty body clears its placeholder immediately (#9126)', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertEmptyCard(page);
    await sleep(120);

    await click(page, '.lexical-card-node > p');
    await pasteFromClipboard(page, {'text/plain': 'Pasted Body'});
    await sleep(120);

    expect(await bodyText(page)).toBe('Pasted Body');
    const before = await placeholderBefore(page, '.lexical-card-node > p');
    expect(before === 'none' || before === '').toBe(true);
  });

  test('a soft line break inside non-empty title/body does not resurrect the placeholder', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertEmptyCard(page);
    await sleep(120);

    await click(page, '[data-lexical-slot="title"] p');
    await page.keyboard.type('Hello');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.type('World');
    await sleep(120);

    expect(await slotText(page, 'title')).toBe('HelloWorld');
    const titleBefore = await placeholderBefore(
      page,
      '.lexical-card-node [data-lexical-slot="title"] p',
    );
    expect(titleBefore === 'none' || titleBefore === '').toBe(true);

    await click(page, '.lexical-card-node > p');
    await page.keyboard.type('Great');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.type('Product');
    await sleep(120);

    const bodyBefore = await placeholderBefore(page, '.lexical-card-node > p');
    expect(bodyBefore === 'none' || bodyBefore === '').toBe(true);
  });

  test('the body placeholder shows only for a single empty body paragraph', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertEmptyCard(page);
    await sleep(120);

    const firstBodyBefore = () =>
      evaluate(page, () => {
        const ps = document.querySelectorAll('.lexical-card-node > p');
        return {
          before: ps[0]
            ? window.getComputedStyle(ps[0], '::before').content
            : null,
          count: ps.length,
        };
      });

    // a single empty body paragraph: the placeholder shows
    let state = await firstBodyBefore();
    expect(state.count).toBe(1);
    expect(state.before).toContain('Body');

    // add a second (empty) body paragraph: now neither is the only paragraph,
    // so the placeholder must NOT show even though the first is still empty
    await click(page, '.lexical-card-node > p');
    await sleep(80);
    await page.keyboard.press('Enter');
    await sleep(120);

    state = await firstBodyBefore();
    expect(state.count).toBe(2);
    expect(state.before === 'none' || state.before === '').toBe(true);
  });
});

// Tab from the title's editable paragraph hops the caret into the first
// body paragraph; Shift+Tab from the body returns it to the title. The
// CardExtension's slot-aware key handler is the first real consumer of
// $getSlotNameWithinHost, so a future refactor could regress the caret
// bridge in either direction without affecting any other surface.
test.describe('Card Tab / Shift+Tab slot caret navigation', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(async ({isCollab, page}) => {
    await initialize({isCollab, page});
  });

  test('Tab from the title slot moves the caret into the body', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertCard(page);
    await click(page, '[data-lexical-slot="title"] p');
    await sleep(100);
    await moveToLineEnd(page);
    await page.keyboard.press('Tab');
    await sleep(120);
    await page.keyboard.type('!');
    await sleep(120);
    // The exclamation point lands at the body's caret position; Tab moved
    // the caret out of the title and into the body's first paragraph.
    await assertCardIntact(page, {body: '!Body', title: 'Title'});
  });

  test('Shift+Tab from the body moves the caret into the title slot', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertCard(page);
    await click(page, '.lexical-card-node > p');
    await sleep(100);
    await moveToLineBeginning(page);
    await page.keyboard.press('Shift+Tab');
    await sleep(120);
    await page.keyboard.type('!');
    await sleep(120);
    await assertCardIntact(page, {body: 'Body', title: 'Title!'});
  });
});

// SELECT_ALL inside a slot stays scoped to that slot rather than escaping
// to the editor root — a maintainer-named requirement (D5 in the slot
// implementation decisions). Typing a single character after Cmd+A in the
// title slot must replace only the title text, leaving the body intact.
test.describe('Card SELECT_ALL stays slot-scoped', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(async ({isCollab, page}) => {
    await initialize({isCollab, page});
  });

  test('Cmd+A inside the title slot replaces only the title text', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertCard(page);
    await click(page, '[data-lexical-slot="title"] p');
    await sleep(100);
    await selectAll(page);
    await sleep(120);
    await page.keyboard.type('X');
    await sleep(120);
    await assertCardIntact(page, {body: 'Body', title: 'X'});
  });
});
