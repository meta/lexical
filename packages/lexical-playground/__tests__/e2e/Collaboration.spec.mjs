/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {expect} from '@playwright/test';

import {
  moveLeft,
  moveToLineBeginning,
  moveToLineEnd,
  selectCharacters,
  toggleBold,
  undo,
} from '../keyboardShortcuts/index.mjs';
import {
  advanceHistoryClock,
  assertHTML,
  assertSelection,
  click,
  focusEditor,
  freezeCollabUndoGrouping,
  html,
  initialize,
  reloadCollabFrame,
  test,
} from '../utils/index.mjs';

async function toggleCheckList(page) {
  await click(page, '.block-controls');
  await click(page, '.dropdown .icon.check-list');
}

test.describe('Collaboration', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('Undo with collaboration on', async ({
    isRichText,
    page,
    isCollab,
    browserName,
  }) => {
    test.skip(!isCollab);

    await focusEditor(page);
    // The two `undo`s below each expect to revert an entire edit group as a unit
    // (the "hello world again" burst, then the whole checklist). Disable the Yjs
    // UndoManager's wall-clock capture window so a CI stall can't split a group
    // across stack items and leave a partial revert — see the helper's doc.
    await freezeCollabUndoGrouping(page);
    await page.keyboard.type('hello');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('world');
    await advanceHistoryClock(page);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.type('hello world again');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">hello</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">hello world again</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">world</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 17,
      anchorPath: [1, 0, 0],
      focusOffset: 17,
      focusPath: [1, 0, 0],
    });

    await undo(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">hello</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">world</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [1],
      focusOffset: 0,
      focusPath: [1],
    });

    await toggleCheckList(page);
    await page.keyboard.type('a');
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    await page.keyboard.press('Enter');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">hello</span>
        </p>
        <ul
          class="PlaygroundEditorTheme__ul PlaygroundEditorTheme__checklist"
          dir="auto">
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
            role="checkbox"
            tabindex="-1"
            value="1"
            aria-checked="false">
            <span data-lexical-text="true">a</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
            role="checkbox"
            tabindex="-1"
            value="2"
            aria-checked="false">
            <span data-lexical-text="true">b</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
            role="checkbox"
            tabindex="-1"
            value="3"
            aria-checked="false">
            <br data-lexical-managed-linebreak="true" />
          </li>
        </ul>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">world</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [1, 2],
      focusOffset: 0,
      focusPath: [1, 2],
    });

    await undo(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">hello</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">world</span>
        </p>
      `,
    );
    if (isCollab === 1) {
      await assertSelection(page, {
        anchorOffset: 5,
        anchorPath: [0, 0, 0],
        focusOffset: 5,
        focusPath: [0, 0, 0],
      });
    } else {
      await assertSelection(page, {
        anchorOffset: 1,
        anchorPath: [0],
        focusOffset: 1,
        focusPath: [0],
      });
    }

    await page.keyboard.press('ArrowDown');
    await page.keyboard.type('Some bold text');

    // Move caret to end of 'bold'
    await moveLeft(page, ' text'.length);

    // Select the word 'bold'
    await selectCharacters(page, 'left', 'bold'.length);

    await toggleBold(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">hello</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Some</span>
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            bold
          </strong>
          <span data-lexical-text="true">text</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">world</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 4,
      anchorPath: [1, 1, 0],
      focusOffset: 0,
      focusPath: [1, 1, 0],
    });
  });

  test('Remove dangling text from YJS when there is no preceding text node', async ({
    isRichText,
    page,
    isCollab,
    browserName,
  }) => {
    test.skip(!isCollab);

    // Left collaborator types two paragraphs of text
    await focusEditor(page);
    // The undo below expects to revert the whole "This is a test. " burst as a
    // unit, so drop the Yjs UndoManager's wall-clock capture window — a CI
    // stall between two keystrokes must not split the burst across stack items
    // and leave a partial revert behind. See the helper's doc.
    await freezeCollabUndoGrouping(page);
    await page.keyboard.type('Line 1');
    await page.keyboard.press('Enter');
    await advanceHistoryClock(page);
    await page.keyboard.type('This is a test. ');

    // Right collaborator types at the end of paragraph 2. Click into that
    // paragraph to place the caret — a real remote user positions the cursor
    // with a click — then move to the line end. Relying on a default caret
    // position + ArrowDown is fragile: once content has synced in, the idle
    // frame's selection is not guaranteed to start at the top of the document.
    const rightFrame = page.frameLocator('iframe[name="right"]');
    await expect(
      rightFrame.locator('[data-lexical-editor="true"]'),
    ).toContainText('This is a test.');
    await rightFrame.locator('p').nth(1).click();
    await moveToLineEnd(page);
    await page.keyboard.type('Word');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Line 1</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">This is a test. Word</span>
        </p>
      `,
    );

    // Left collaborator undoes their text in the second paragraph.
    const undoButton = page
      .frameLocator('iframe[name="left"]')
      .getByLabel('Undo');
    await expect(undoButton).toBeEnabled();
    await undoButton.click();

    // The undo also removed the text node from YJS.
    // Check that the dangling text from right user was also removed.
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Line 1</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    // Left collaborator refreshes their page
    await reloadCollabFrame(page, 'left');

    // Page content should be the same as before the refresh
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Line 1</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test('Merge dangling text into preceding text node', async ({
    isRichText,
    page,
    isCollab,
    browserName,
  }) => {
    test.skip(!isCollab);

    // Left collaborator types two pieces of text in the same paragraph, but with different styling.
    await focusEditor(page);
    // The undo below expects to revert the bold format *and* the "bold" burst
    // it applies to as a unit, so drop the Yjs UndoManager's wall-clock capture
    // window — see the helper's doc.
    await freezeCollabUndoGrouping(page);
    await page.keyboard.type('normal');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">normal</span>
        </p>
      `,
    );
    await advanceHistoryClock(page);
    await toggleBold(page);
    await page.keyboard.type('bold');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">normal</span>
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            bold
          </strong>
        </p>
      `,
    );

    // Right collaborator types at the end of the paragraph. Click to place the
    // caret (real remote user positioning) then move to the line end, rather
    // than relying on a default caret position + ArrowDown.
    await page.frameLocator('iframe[name="right"]').locator('p').click();
    await moveToLineEnd(page);
    await page.keyboard.type('BOLD');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">normal</span>
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            boldBOLD
          </strong>
        </p>
      `,
    );

    // Left collaborator undoes their bold text. The assertHTML above already
    // confirmed both frames converged, so wait for the undo control to be
    // actionable instead of sleeping.
    const undoButton = page
      .frameLocator('iframe[name="left"]')
      .getByLabel('Undo');
    await expect(undoButton).toBeEnabled();
    await undoButton.click();

    // The undo also removed bold the text node from YJS.
    // Check that the dangling text from right user was merged into the preceding text node.
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">normalBOLD</span>
        </p>
      `,
    );

    // Left collaborator refreshes their page
    await reloadCollabFrame(page, 'left');

    // Page content should be the same as before the refresh
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">normalBOLD</span>
        </p>
      `,
    );
  });

  test('Undo/redo where text node is split by formatting change', async ({
    isRichText,
    page,
    isCollab,
    browserName,
  }) => {
    test.skip(!isCollab);

    // Left collaborator types two words, sets the second one to bold.
    await focusEditor(page);
    await page.keyboard.type('normal bold');

    await advanceHistoryClock(page);
    await selectCharacters(page, 'left', 'bold'.length);
    await toggleBold(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">normal</span>
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            bold
          </strong>
        </p>
      `,
    );

    // Right collaborator types in the middle of the bold word. Click to place
    // the caret (real remote-user positioning), then step left from the line
    // end — relying on a default caret position + ArrowDown is fragile because
    // the idle frame's synced selection isn't guaranteed to start at the top.
    await page.frameLocator('iframe[name="right"]').locator('p').click();
    await moveToLineEnd(page);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('BOLD');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">normal</span>
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            boBOLDld
          </strong>
        </p>
      `,
    );

    // Left collaborator undoes their bold text.
    await page.frameLocator('iframe[name="left"]').getByLabel('Undo').click();

    if (isCollab === 1) {
      // The undo causes the text to be appended to the original string, like in the above test.
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">normal boldBOLD</span>
          </p>
        `,
      );
    } else {
      // In v2, the text is not moved.
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">normal boBOLDld</span>
          </p>
        `,
      );
    }

    // Left collaborator redoes the bold text.
    await page.frameLocator('iframe[name="left"]').getByLabel('Redo').click();

    // The text should be back as it was prior to the undo.
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">normal</span>
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            boBOLDld
          </strong>
        </p>
      `,
    );

    // Collaboration should still work. Click into the paragraph and move to the
    // line end, rather than relying on a default caret position + ArrowDown.
    await page.frameLocator('iframe[name="right"]').locator('p').click();
    await moveToLineEnd(page);
    // Firefox doesn't carry the bold format to a caret at the very end of the
    // bold run, so re-enter the run and return so the appended text inherits it.
    if (browserName === 'firefox') {
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.type(' text');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">normal</span>
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            boBOLDld text
          </strong>
        </p>
      `,
    );
  });

  test('Undo/redo where text node is split by inline element node', async ({
    isRichText,
    page,
    isCollab,
    browserName,
  }) => {
    test.skip(!isCollab);

    // Left collaborator types some text, then splits the text nodes with an element node.
    await focusEditor(page);
    await page.keyboard.type('Check out the website!');

    await advanceHistoryClock(page);
    await page.keyboard.press('ArrowLeft');
    await selectCharacters(page, 'left', 'website'.length);
    await page
      .frameLocator('iframe[name="left"]')
      .getByLabel('Insert link')
      .first()
      .click();

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Check out the</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">website</span>
          </a>
          <span data-lexical-text="true">!</span>
        </p>
      `,
    );

    // Right collaborator adds some text just before the trailing "!". Click to
    // place the caret (real remote user positioning), move to the line end,
    // then step left over "!", rather than relying on a default caret position.
    await page.frameLocator('iframe[name="right"]').locator('p').click();
    await moveToLineEnd(page);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type(' now');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Check out the</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">website</span>
          </a>
          <span data-lexical-text="true">now!</span>
        </p>
      `,
    );

    // Left collaborator undoes the link.
    await page.frameLocator('iframe[name="left"]').getByLabel('Undo').click();

    if (isCollab === 1) {
      // The undo causes the text to be appended to the original string, like in the above test.
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Check out the website! now</span>
          </p>
        `,
      );
    } else {
      // The undo causes the YText node to be removed.
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Check out the website!</span>
          </p>
        `,
      );
    }

    // Left collaborator redoes the link.
    await page.frameLocator('iframe[name="left"]').getByLabel('Redo').click();

    // The text should be back as it was prior to the undo.
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Check out the</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">website</span>
          </a>
          <span data-lexical-text="true">now!</span>
        </p>
      `,
    );

    // Collaboration should still work. Click into the paragraph and move to the
    // line end to append after "now!", rather than relying on a default caret
    // position + ArrowDown.
    await page.frameLocator('iframe[name="right"]').locator('p').click();
    await moveToLineEnd(page);
    await page.keyboard.type(' Check it out.');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Check out the</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">website</span>
          </a>
          <span data-lexical-text="true">now! Check it out.</span>
        </p>
      `,
    );
  });

  test('$handleNormalizationMergeConflicts handles nodes that have been reparented', async ({
    page,
    isCollab,
  }) => {
    test.skip(!isCollab);

    // Add paragraph, type ABC into second paragraph, bold the B, backspace text into the first paragraph to reparent the text nodes
    await focusEditor(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('ABC');
    await page.keyboard.press('ArrowLeft');
    await selectCharacters(page, 'left', 'B'.length);
    await toggleBold(page);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">A</span>
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            B
          </strong>
          <span data-lexical-text="true">C</span>
        </p>
      `,
    );

    // Left collaborator deletes A, right deletes B.
    await advanceHistoryClock(page);
    await page.keyboard.press('Delete');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <strong
            class="PlaygroundEditorTheme__textBold"
            data-lexical-text="true">
            B
          </strong>
          <span data-lexical-text="true">C</span>
        </p>
      `,
    );
    // Right collaborator deletes "B". Click into the paragraph and move to the
    // line start so forward-Delete removes the leading bold "B", rather than
    // relying on a default caret position.
    await page.frameLocator('iframe[name="right"]').locator('p').click();
    await moveToLineBeginning(page);
    await page.keyboard.press('Delete');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">C</span>
        </p>
      `,
    );

    // Left collaborator undoes their deletion of A.
    await page.frameLocator('iframe[name="left"]').getByLabel('Undo').click();

    // Check that normalization worked properly.
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">AC</span>
        </p>
      `,
    );
  });
});
