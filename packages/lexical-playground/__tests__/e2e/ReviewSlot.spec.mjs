/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveToEditorEnd,
  moveToLineBeginning,
  selectAll,
} from '../keyboardShortcuts/index.mjs';
import {
  click,
  copyToClipboard,
  evaluate,
  expect,
  focusEditor,
  initialize,
  locate,
  pasteFromClipboard,
  sleep,
  test,
  waitForSelector,
} from '../utils/index.mjs';

async function insertReview(page) {
  await page.keyboard.type('/review');
  await waitForSelector(page, '.typeahead-popover');
  await page.keyboard.press('Enter');
}

const PARA = '⏎';
const STAR = '.lexical-review-stars button';
const AUTHOR = '.lexical-review-author [data-lexical-slot="author"]';
const BODY = '.lexical-review-body .lexical-review-children';

async function regionText(page, selector) {
  return evaluate(
    page,
    ([sel, para]) => {
      const region = document.querySelector(sel);
      if (region == null) {
        return null;
      }
      return Array.from(region.querySelectorAll('p'))
        .map(p => p.textContent)
        .join(para);
    },
    [selector, PARA],
  );
}

// The committed rating, read from aria-pressed (bound to the model `rating`),
// so it is independent of the hover preview that drives the lit-star class.
async function ratingValue(page) {
  return evaluate(
    page,
    () =>
      document.querySelectorAll(
        '.lexical-review-stars button[aria-pressed="true"]',
      ).length,
  );
}

// The number of visibly lit stars, which reflects the hover preview when the
// pointer is over the widget and the committed rating otherwise.
async function starOnCount(page) {
  return evaluate(
    page,
    () => document.querySelectorAll('.lexical-review-star-on').length,
  );
}

async function reviewCount(page) {
  return evaluate(
    page,
    () => document.querySelectorAll('.lexical-review-node').length,
  );
}

async function placeholderBefore(page, selector) {
  return evaluate(
    page,
    sel => {
      const p = document.querySelector(`${sel} p`);
      return p && window.getComputedStyle(p, '::before').content;
    },
    selector,
  );
}

// Reset the document to a single empty paragraph via the editor API. A
// document-wide range Backspace leaves a first-block shadow-root host (the
// Review, which now starts the document since insertion seeds no leading
// paragraph) in place, and unlike the Card the Review has no chrome-click
// NodeSelection to delete it, so clearing here stays deterministic.
async function clearDocument(page) {
  await evaluate(page, () => {
    const editor = window.lexicalEditor;
    editor.update(
      () => {
        const root = editor.getEditorState()._nodeMap.get('root');
        let kept = null;
        for (const child of Array.from(root.getChildren())) {
          if (kept === null && child.getType() === 'paragraph') {
            child.clear();
            kept = child;
          } else {
            child.remove();
          }
        }
        if (kept !== null) {
          kept.selectStart();
        }
      },
      {discrete: true},
    );
  });
  await sleep(80);
}

// The Review is an ElementNode whose presentation is React chrome that goes
// beyond static layout: an interactive star-rating widget (click/hover, backed
// by NodeState) sits alongside the two editable islands — the named `author`
// slot (useLexicalSlotRef) and the getDOMSlot body children — which use the
// same render-hidden-then-attach technique as the other slot demos.
test.describe('Review React-chromed ElementNode', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(({isCollab, page}) => {
    return initialize({isCollab, page});
  });

  test('inserts a Review with React chrome, editable regions, and a rating widget', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');

    // The shell is non-editable chrome; the regions flip back to editable.
    const shellEditable = await evaluate(page, () => {
      return document.querySelector('.lexical-review-node').contentEditable;
    });
    expect(shellEditable).toBe('false');
    const regions = await evaluate(page, () => {
      const author = document.querySelector(
        '.lexical-review-author [data-lexical-slot="author"]',
      );
      const children = document.querySelector(
        '.lexical-review-body .lexical-review-children',
      );
      return {
        authorDisplay: author && author.style.display,
        authorEditable: author && author.contentEditable,
        childrenDisplay: children && children.style.display,
        childrenEditable: children && children.contentEditable,
      };
    });
    expect(regions.authorDisplay).toBe('');
    expect(regions.authorEditable).toBe('true');
    expect(regions.childrenDisplay).toBe('');
    expect(regions.childrenEditable).toBe('true');

    // The rating widget renders five star buttons, none set at rating 0.
    expect(await locate(page, STAR).count()).toBe(5);
    expect(await ratingValue(page)).toBe(0);
  });

  test('clicking a star sets the rating, and clicking it again clears it', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');

    await click(page, `${STAR}:nth-child(4)`);
    await sleep(100);
    expect(await ratingValue(page)).toBe(4);

    // Clicking the current top star toggles the rating back to zero.
    await click(page, `${STAR}:nth-child(4)`);
    await sleep(100);
    expect(await ratingValue(page)).toBe(0);

    await click(page, `${STAR}:nth-child(2)`);
    await sleep(100);
    expect(await ratingValue(page)).toBe(2);
  });

  test('hovering a star previews the rating without committing it', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');

    await click(page, `${STAR}:nth-child(2)`);
    await sleep(100);
    expect(await ratingValue(page)).toBe(2);

    // Hovering a higher star lights it as a preview but does not commit it...
    await locate(page, `${STAR}:nth-child(4)`).hover();
    await sleep(50);
    expect(await starOnCount(page)).toBe(4);
    expect(await ratingValue(page)).toBe(2);

    // ...and leaving the widget reverts the preview to the committed rating.
    await locate(page, AUTHOR).hover();
    await sleep(50);
    expect(await starOnCount(page)).toBe(2);
    expect(await ratingValue(page)).toBe(2);
  });

  test('the rating persists across a body edit', async ({page}) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');

    await click(page, `${STAR}:nth-child(3)`);
    await sleep(100);
    expect(await ratingValue(page)).toBe(3);

    // Editing the prose (a separate channel) must not disturb the NodeState
    // rating, which rides the model rather than the DOM.
    await click(page, `${BODY} p`);
    await sleep(100);
    await page.keyboard.type('Loved it');
    await sleep(120);

    expect(await regionText(page, BODY)).toBe('Loved it');
    expect(await ratingValue(page)).toBe(3);
  });

  test('typing inside the author slot replaces only its text', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');

    await click(page, `${AUTHOR} p`);
    await sleep(100);
    await page.keyboard.type('Jane Doe');
    await sleep(120);

    expect(await regionText(page, AUTHOR)).toBe('Jane Doe');
    // The body prose is a separate channel and stays empty.
    expect(await regionText(page, BODY)).toBe('');
  });

  test('typing inside the body children replaces only its text', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');

    // Note: Cmd+A in the body stays document-scoped by design (the body is the
    // ordinary child channel, not a slot frame), so type into the empty prose.
    await click(page, `${BODY} p`);
    await sleep(100);
    await page.keyboard.type('Great product');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Highly recommend');
    await sleep(120);

    expect(await regionText(page, BODY)).toBe(
      `Great product${PARA}Highly recommend`,
    );
    // The author slot is a separate channel and stays empty.
    expect(await regionText(page, AUTHOR)).toBe('');
  });

  test('document text outside the Review stays editable around it', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');

    // Insertion seeds no leading paragraph, so the Review is the first block;
    // the trailing top-level paragraph is where surrounding prose goes.
    await moveToEditorEnd(page);
    await page.keyboard.type('After');
    await sleep(120);
    expect(
      await evaluate(page, () => {
        const root = document.querySelector('[data-lexical-editor="true"]');
        const review = document.querySelector('.lexical-review-node');
        // The prose lands in a top-level paragraph sibling of the Review, not
        // inside one of its regions.
        return Array.from(root.children)
          .filter(c => c !== review)
          .map(c => c.textContent)
          .join('');
      }),
    ).toContain('After');
    // The rating widget is still present and the regions are intact.
    expect(await locate(page, STAR).count()).toBe(5);
  });

  test.describe(() => {
    test.skip(({isCollab}) => isCollab);
    test('exports to HTML and re-imports through the DOMImportExtension rule', async ({
      page,
    }) => {
      // Clipboard round-trips run once; collab adds nothing to the import path.

      await focusEditor(page);
      await insertReview(page);
      await waitForSelector(page, '.lexical-review-chrome');

      // Set a rating and fill both editable regions.
      await click(page, `${STAR}:nth-child(4)`);
      await sleep(100);
      await click(page, `${AUTHOR} p`);
      await page.keyboard.type('Jane Doe');
      await click(page, `${BODY} p`);
      await page.keyboard.type('Loved it');
      await sleep(120);

      // Select the whole document from the trailing top-level paragraph (outside
      // the Review's shadow root, so Cmd+A is document-scoped) and copy. The
      // Review is the first block now that insertion seeds no leading paragraph,
      // so start from the end rather than the beginning.
      await moveToEditorEnd(page);
      await selectAll(page);
      const clipboard = await copyToClipboard(page);
      // Export side: the author rides its named wrapper, and the rating — being
      // NodeState rather than a child or slot — rides a data attribute.
      expect(clipboard['text/html']).toContain('data-lexical-slot="author"');
      expect(clipboard['text/html']).toContain('data-rating="4"');

      // Drop everything, then paste HTML-only so the import must go through the
      // DOMImportExtension review rule (the clipboard's lexical JSON is dropped).
      await clearDocument(page);
      expect(await reviewCount(page)).toBe(0);
      await pasteFromClipboard(page, {'text/html': clipboard['text/html']});
      await sleep(200);
      await waitForSelector(page, '.lexical-review-chrome');

      // Import side: the host, both regions, and the rating are reconstructed.
      expect(await reviewCount(page)).toBe(1);
      expect(await regionText(page, AUTHOR)).toBe('Jane Doe');
      expect(await regionText(page, BODY)).toBe('Loved it');
      expect(await ratingValue(page)).toBe(4);
    });
  });

  // Backspace deletes a text-empty Review (like the Card) from the start of its
  // body. The rating is not counted as content, so a rated Review goes too.
  test('backspace from the body of an empty review deletes it', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');
    expect(await reviewCount(page)).toBe(1);

    await click(page, `${BODY} p`);
    await moveToLineBeginning(page);
    await page.keyboard.press('Backspace');
    await sleep(120);

    expect(await reviewCount(page)).toBe(0);
  });

  test('backspace deletes a textless review even with a rating set', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');
    await click(page, `${STAR}:nth-child(4)`);
    await sleep(100);
    expect(await ratingValue(page)).toBe(4);

    // The rating is not content, so an empty-text Review is still deleted.
    await click(page, `${BODY} p`);
    await moveToLineBeginning(page);
    await page.keyboard.press('Backspace');
    await sleep(120);

    expect(await reviewCount(page)).toBe(0);
  });

  // Select-all then Backspace on a first-block Review replaces the whole node
  // with a paragraph in one press (the deletion's start is re-anchored before
  // the Review), rather than only clearing its contents and leaving the shell.
  test('select-all + Backspace replaces a first-block review with a paragraph', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');
    await click(page, `${BODY} p`);
    await page.keyboard.type('Hello');
    await sleep(100);

    // Cmd+A from the body is document-scoped (the body is the child channel,
    // not a slot frame), so this selects the whole document.
    await selectAll(page);
    await sleep(80);
    await page.keyboard.press('Backspace');
    await sleep(120);

    expect(await reviewCount(page)).toBe(0);
    expect(
      await evaluate(page, () =>
        Array.from(
          document.querySelector('[data-lexical-editor="true"]').children,
        ).map(c => c.tagName.toLowerCase()),
      ),
    ).toEqual(['p']);
  });

  // The author IS a slot frame, so select-all there is slot-scoped: the
  // re-anchor must not fire and the Review must survive with only its author
  // text cleared.
  test('select-all in the author slot keeps the review', async ({page}) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');
    await click(page, `${AUTHOR} p`);
    await page.keyboard.type('Jane');
    await sleep(100);

    await selectAll(page);
    await sleep(80);
    await page.keyboard.press('Backspace');
    await sleep(120);

    expect(await reviewCount(page)).toBe(1);
    expect(await regionText(page, AUTHOR)).toBe('');
  });

  // Forward Delete on the document-wide select-all replaces the Review too, not
  // just Backspace.
  test('select-all + forward Delete replaces a first-block review', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');
    await click(page, `${BODY} p`);
    await page.keyboard.type('Hello');
    await sleep(100);

    await selectAll(page);
    await sleep(80);
    await page.keyboard.press('Delete');
    await sleep(120);

    expect(await reviewCount(page)).toBe(0);
    expect(
      await evaluate(page, () =>
        Array.from(
          document.querySelector('[data-lexical-editor="true"]').children,
        ).map(c => c.tagName.toLowerCase()),
      ),
    ).toEqual(['p']);
  });
});

test.describe('Review empty-field placeholders', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(({isCollab, page}) => {
    return initialize({isCollab, page});
  });

  test('pasting text into the empty author slot clears its placeholder immediately (#9126)', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');

    await click(page, `${AUTHOR} p`);
    await pasteFromClipboard(page, {'text/plain': 'Jane Doe'});
    await sleep(120);

    expect(await regionText(page, AUTHOR)).toBe('Jane Doe');
    const before = await placeholderBefore(page, AUTHOR);
    expect(before === 'none' || before === '').toBe(true);
  });

  test('pasting text into the empty body clears its placeholder immediately (#9126)', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');

    await click(page, `${BODY} p`);
    await pasteFromClipboard(page, {'text/plain': 'Loved it'});
    await sleep(120);

    expect(await regionText(page, BODY)).toBe('Loved it');
    const before = await placeholderBefore(page, BODY);
    expect(before === 'none' || before === '').toBe(true);
  });

  test('a soft line break inside non-empty author/body does not resurrect the placeholder', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertReview(page);
    await waitForSelector(page, '.lexical-review-chrome');

    await click(page, `${AUTHOR} p`);
    await page.keyboard.type('Jane');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.type('Doe');
    await sleep(120);

    expect(await regionText(page, AUTHOR)).toBe('JaneDoe');
    const authorBefore = await placeholderBefore(page, AUTHOR);
    expect(authorBefore === 'none' || authorBefore === '').toBe(true);

    await click(page, `${BODY} p`);
    await page.keyboard.type('Loved');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.type('it');
    await sleep(120);

    const bodyBefore = await placeholderBefore(page, BODY);
    expect(bodyBefore === 'none' || bodyBefore === '').toBe(true);
  });
});
