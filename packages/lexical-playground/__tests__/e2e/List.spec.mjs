/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {expect} from '@playwright/test';

import {
  indent,
  moveLeft,
  moveRight,
  moveToEditorBeginning,
  moveToEditorEnd,
  moveToLineBeginning,
  moveToParagraphEnd,
  pressBackspace,
  redo,
  selectAll,
  selectCharacters,
  toggleBold,
  undo,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  clearEditor,
  click,
  copyToClipboard,
  focusEditor,
  getExpectedDateTimeHtml,
  html,
  initialize,
  insertDateTime,
  pasteFromClipboard,
  repeat,
  selectFromAlignDropdown,
  selectFromColorPicker,
  selectFromFormatDropdown,
  test,
  waitForSelector,
  withExclusiveClipboardAccess,
} from '../utils/index.mjs';

async function toggleBulletList(page) {
  await click(page, '.block-controls');
  await click(page, '.dropdown .icon.bullet-list');
}

async function toggleNumberedList(page) {
  await click(page, '.block-controls');
  await click(page, '.dropdown .icon.numbered-list');
}

async function toggleCheckList(page) {
  await click(page, '.block-controls');
  await click(page, '.dropdown .icon.check-list');
}

async function clickIndentButton(page, times = 1) {
  for (let i = 0; i < times; i++) {
    await selectFromAlignDropdown(page, '.indent');
  }
}

async function clickOutdentButton(page, times = 1) {
  for (let i = 0; i < times; i++) {
    await selectFromAlignDropdown(page, '.outdent');
  }
}

test.beforeEach(({isPlainText}) => {
  test.skip(isPlainText);
});

test.describe('Checklist focus option', () => {
  test('(shouldDisableFocusOnClickChecklist: true) Keeps focus outside the editor when clicking a checklist item', async ({
    isCollab,
    page,
  }) => {
    test.skip(isCollab);
    await initialize({
      isCollab,
      page,
      shouldDisableFocusOnClickChecklist: true,
    });

    await toggleCheckList(page);
    await page.keyboard.type('Task');

    const checklistItem = page.locator('li[role="checkbox"]').first();

    // Force focus outside the editor to verify it does not switch on click.
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
    });
    expect(
      await page.evaluate(
        () =>
          document.activeElement === document.body ||
          document.activeElement === document.documentElement,
      ),
    ).toBe(true);

    // Click on the checkbox marker area (left side of the item)
    const box = await checklistItem.boundingBox();
    await page.mouse.click(box.x + 10, box.y + box.height / 2);

    // The item toggles, but focus remains on the body when disabled.
    await expect(checklistItem).toHaveAttribute('aria-checked', 'true');
    const isBodyFocused = await page.evaluate(
      () => document.activeElement === document.body,
    );
    expect(isBodyFocused).toBe(true);
  });

  test('(shouldDisableFocusOnClickChecklist: false) Moves focus into the editor/listItem when clicking a checklist item', async ({
    isCollab,
    page,
  }) => {
    test.skip(isCollab);
    await initialize({
      isCollab,
      page,
      shouldDisableFocusOnClickChecklist: false,
    });

    await toggleCheckList(page);
    await page.keyboard.type('Task');

    const checklistItem = page.locator('li[role="checkbox"]').first();

    // Force focus outside the editor to verify it switches on click.
    await page.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
    });
    expect(
      await page.evaluate(
        () =>
          document.activeElement === document.body ||
          document.activeElement === document.documentElement,
      ),
    ).toBe(true);

    // Click on the checkbox marker area (left side of the item)
    const box = await checklistItem.boundingBox();
    await page.mouse.click(box.x + 10, box.y + box.height / 2, {
      button: 'left',
    });

    // The item toggles and focus moves into the editor when enabled.
    await expect(checklistItem).toHaveAttribute('aria-checked', 'true');
    const isEditorFocused = await page.evaluate(() => {
      const rootElement = window.lexicalEditor.getRootElement();
      return (
        rootElement != null &&
        document.activeElement != null &&
        rootElement.contains(document.activeElement)
      );
    });
    expect(isEditorFocused).toBe(true);
  });
});

test.describe('Checklist space key', () => {
  // Pressing the mouse anywhere in an item focuses the <li>, which carries
  // tabIndex="-1" for its checkbox role. Firefox left focus there, and the
  // key handlers read a focused item as "the checkbox is what the keyboard is
  // operating", so Space toggled the item instead of typing a space.
  test('typing a space in the label leaves the checkbox alone', async ({
    isCollab,
    page,
  }) => {
    test.skip(isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);

    await toggleCheckList(page);
    await page.keyboard.type('Task');

    const item = page.locator('li[role="checkbox"]').first();
    await expect(item).toHaveAttribute('aria-checked', 'false');

    // Click the text itself, well clear of the marker on the left.
    const textBox = await page.getByText('Task', {exact: true}).boundingBox();
    await page.mouse.click(
      textBox.x + textBox.width / 2,
      textBox.y + textBox.height / 2,
    );

    // The click is in the label, so the editor holds the focus. The item is
    // the active element only when its checkbox is what was clicked.
    expect(
      await page.evaluate(
        () => document.activeElement === window.lexicalEditor.getRootElement(),
      ),
    ).toBe(true);

    await page.keyboard.press('Space');

    await expect(item).toHaveAttribute('aria-checked', 'false');
    await expect(item).toHaveText('Ta sk');
  });

  test('space toggles the item after its checkbox is clicked', async ({
    isCollab,
    page,
  }) => {
    test.skip(isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);

    await toggleCheckList(page);
    await page.keyboard.type('Task');

    const item = page.locator('li[role="checkbox"]').first();
    const box = await item.boundingBox();

    // Click the marker, which is the flow that hands the item keyboard focus.
    await page.mouse.click(box.x + 5, box.y + box.height / 2);
    await expect(item).toHaveAttribute('aria-checked', 'true');
    expect(
      await page.evaluate(
        () =>
          document.activeElement ===
          document.querySelector('li[role="checkbox"]'),
      ),
    ).toBe(true);

    await page.keyboard.press('Space');

    await expect(item).toHaveAttribute('aria-checked', 'false');
    await expect(item).toHaveText('Task');
  });

  test('clicking the label after the checkbox gives focus back', async ({
    isCollab,
    page,
  }) => {
    test.skip(isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);

    await toggleCheckList(page);
    await page.keyboard.type('Task');

    const item = page.locator('li[role="checkbox"]').first();
    const box = await item.boundingBox();

    // The checkbox click leaves the item focused, and the click that follows
    // lands in the label, so the editor has to take the focus back.
    await page.mouse.click(box.x + 5, box.y + box.height / 2);
    await expect(item).toHaveAttribute('aria-checked', 'true');

    const textBox = await page.getByText('Task', {exact: true}).boundingBox();
    await page.mouse.click(
      textBox.x + textBox.width / 2,
      textBox.y + textBox.height / 2,
    );
    await page.keyboard.press('Space');

    await expect(item).toHaveAttribute('aria-checked', 'true');
    await expect(item).toHaveText('Ta sk');
  });

  test('space toggles the item the arrow key moved onto', async ({
    isCollab,
    page,
  }) => {
    test.skip(isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);

    await toggleCheckList(page);
    await page.keyboard.type('One');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Two');

    const first = page.locator('li[role="checkbox"]').first();
    const second = page.locator('li[role="checkbox"]').nth(1);
    const box = await first.boundingBox();

    await page.mouse.click(box.x + 5, box.y + box.height / 2);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');

    await expect(second).toHaveAttribute('aria-checked', 'true');
    await expect(second).toHaveText('Two');
  });

  test('space toggles the item the left arrow moved onto', async ({
    isCollab,
    page,
  }) => {
    test.skip(isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);

    await toggleCheckList(page);
    await page.keyboard.type('Task');

    const item = page.locator('li[role="checkbox"]').first();

    // The left arrow at the start of the label is the third way onto the
    // checkbox, with the caret never having left the item.
    await moveToLineBeginning(page);
    await moveLeft(page);
    expect(
      await page.evaluate(
        () =>
          document.activeElement ===
          document.querySelector('li[role="checkbox"]'),
      ),
    ).toBe(true);

    await page.keyboard.press('Space');

    await expect(item).toHaveAttribute('aria-checked', 'true');
    await expect(item).toHaveText('Task');
  });

  test('the item does not hold the focus for the length of the press', async ({
    isCollab,
    page,
  }) => {
    test.skip(isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);

    await toggleCheckList(page);
    await page.keyboard.type('Task');

    // Press the label and hold: the item is the caret's nearest focusable
    // ancestor, so the browser focuses it, and it should not stay focused
    // while the button is down.
    const textBox = await page.getByText('Task', {exact: true}).boundingBox();
    await page.mouse.move(
      textBox.x + textBox.width / 2,
      textBox.y + textBox.height / 2,
    );
    await page.mouse.down();

    expect(
      await page.evaluate(
        () => document.activeElement === window.lexicalEditor.getRootElement(),
      ),
    ).toBe(true);

    await page.mouse.up();
  });

  test('an arrow key that moves the caret hands focus back to the editor', async ({
    isCollab,
    page,
  }) => {
    test.skip(isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);

    await toggleCheckList(page);
    await page.keyboard.type('Task');

    const item = page.locator('li[role="checkbox"]').first();
    const box = await item.boundingBox();

    // Click the check mark, so the item holds the focus.
    await page.mouse.click(box.x + 5, box.y + box.height / 2);
    await expect(item).toHaveAttribute('aria-checked', 'true');

    // Moving the caret through the label is operating the text, not the
    // checkbox, so the editor takes the focus back.
    await moveLeft(page);
    expect(
      await page.evaluate(
        () => document.activeElement === window.lexicalEditor.getRootElement(),
      ),
    ).toBe(true);

    await page.keyboard.press('Space');

    await expect(item).toHaveAttribute('aria-checked', 'true');
    await expect(item).toHaveText('Tas k');
  });

  test('the left arrow leaves the item when the checkbox already holds focus', async ({
    isCollab,
    page,
  }) => {
    test.skip(isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);

    await toggleCheckList(page);
    await page.keyboard.type('One');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Two');

    const first = page.locator('li[role="checkbox"]').first();
    const second = page.locator('li[role="checkbox"]').nth(1);

    // The first left arrow reaches the checkbox of the second item.
    await moveToLineBeginning(page);
    await moveLeft(page);
    expect(
      await page.evaluate(
        () =>
          document.activeElement ===
          document.querySelectorAll('li[role="checkbox"]')[1],
      ),
    ).toBe(true);

    // The second one leaves the item, so the caret carries on into the item
    // before it and the focus goes with it.
    await moveLeft(page);
    expect(
      await page.evaluate(
        () => document.activeElement === window.lexicalEditor.getRootElement(),
      ),
    ).toBe(true);

    await page.keyboard.type('X');

    await expect(first).toHaveText('OneX');
    await expect(second).toHaveText('Two');
    await expect(second).toHaveAttribute('aria-checked', 'false');
  });

  test('the right arrow moves the caret off a checkbox the left arrow reached', async ({
    isCollab,
    page,
  }) => {
    test.skip(isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);

    await toggleCheckList(page);
    await page.keyboard.type('Task');

    const item = page.locator('li[role="checkbox"]').first();

    // Left at the start of the label puts the focus on the checkbox.
    await moveToLineBeginning(page);
    await moveLeft(page);
    expect(
      await page.evaluate(
        () =>
          document.activeElement ===
          document.querySelector('li[role="checkbox"]'),
      ),
    ).toBe(true);

    // Right moves the caret back into the label, so the checkbox is no
    // longer what the keyboard is operating.
    await moveRight(page, 1);
    expect(
      await page.evaluate(
        () => document.activeElement === window.lexicalEditor.getRootElement(),
      ),
    ).toBe(true);

    await page.keyboard.press('Space');

    await expect(item).toHaveAttribute('aria-checked', 'false');
    await expect(item).toHaveText('T ask');
  });

  test('typing in the label hands focus back to the editor', async ({
    isCollab,
    page,
  }) => {
    test.skip(isCollab);
    await initialize({isCollab, page});
    await focusEditor(page);

    await toggleCheckList(page);
    await page.keyboard.type('Task');

    const item = page.locator('li[role="checkbox"]').first();
    const box = await item.boundingBox();

    // Click the check mark, so the item holds the focus and the caret is
    // still sitting in the label.
    await page.mouse.click(box.x + 5, box.y + box.height / 2);
    await expect(item).toHaveAttribute('aria-checked', 'true');

    // Typing is text entry, so the editor takes the focus back and the next
    // Space is a space rather than a toggle.
    await page.keyboard.type('X');
    expect(
      await page.evaluate(
        () => document.activeElement === window.lexicalEditor.getRootElement(),
      ),
    ).toBe(true);

    await moveLeft(page);
    await page.keyboard.press('Space');

    await expect(item).toHaveAttribute('aria-checked', 'true');
    await expect(item).toHaveText('Task X');
  });
});

test.describe('Nested List', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test(`Can create a list and partially copy some content out of it`, async ({
    page,
    isCollab,
  }) => {
    await focusEditor(page);
    await page.keyboard.type(
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nam venenatis risus ac cursus efficitur. Cras efficitur magna odio, lacinia posuere mauris placerat in. Etiam eu congue nisl. Vestibulum ante ipsum primis in faucibus orci luctus et ultrices posuere cubilia curae; Nulla vulputate justo id eros convallis, vel pellentesque orci hendrerit. Pellentesque accumsan molestie eros, vitae tempor nisl semper sit amet. Sed vulputate leo dolor, et bibendum quam feugiat eget. Praesent vestibulum libero sed enim ornare, in consequat dui posuere. Maecenas ornare vestibulum felis, non elementum urna imperdiet sit amet.',
    );
    await toggleBulletList(page);
    await moveToEditorBeginning(page);
    await moveRight(page, 6);
    await selectCharacters(page, 'right', 11);

    await withExclusiveClipboardAccess(async () => {
      const clipboard = await copyToClipboard(page);

      await moveToEditorEnd(page);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');

      await pasteFromClipboard(page, clipboard);
    });

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">
              Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nam
              venenatis risus ac cursus efficitur. Cras efficitur magna odio,
              lacinia posuere mauris placerat in. Etiam eu congue nisl.
              Vestibulum ante ipsum primis in faucibus orci luctus et ultrices
              posuere cubilia curae; Nulla vulputate justo id eros convallis,
              vel pellentesque orci hendrerit. Pellentesque accumsan molestie
              eros, vitae tempor nisl semper sit amet. Sed vulputate leo dolor,
              et bibendum quam feugiat eget. Praesent vestibulum libero sed enim
              ornare, in consequat dui posuere. Maecenas ornare vestibulum
              felis, non elementum urna imperdiet sit amet.
            </span>
          </li>
        </ul>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">ipsum dolor</span>
        </p>
      `,
    );
  });

  test('Should outdent if indented when the backspace key is pressed', async ({
    page,
  }) => {
    await focusEditor(page);
    await toggleBulletList(page);

    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');

    await clickIndentButton(page, 3);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="1">
                <ul class="PlaygroundEditorTheme__ul">
                  <li
                    class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                    value="1">
                    <ul class="PlaygroundEditorTheme__ul">
                      <li class="PlaygroundEditorTheme__listItem" value="1">
                        <br data-lexical-managed-linebreak="true" />
                      </li>
                    </ul>
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );

    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="1">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <br data-lexical-managed-linebreak="true" />
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );

    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <br data-lexical-managed-linebreak="true" />
              </li>
            </ul>
          </li>
        </ul>
      `,
    );
  });

  test('Should outdent if indented when the backspace key is pressed only at the front', async ({
    page,
  }) => {
    // repro for #7514
    await focusEditor(page);
    await toggleBulletList(page);

    await insertDateTime(page);
    await page.keyboard.type('x');
    await moveLeft(page, 1);

    await clickIndentButton(page, 1);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="1">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                ${getExpectedDateTimeHtml()}
                <span data-lexical-text="true">x</span>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );

    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="1">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">x</span>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );
  });

  test('Should retain selection style when exiting list', async ({page}) => {
    await focusEditor(page);
    await toggleBulletList(page);

    await selectFromColorPicker(page);
    await toggleBold(page);
    await page.keyboard.type('Item one');
    await page.keyboard.press('Enter');
    await clickIndentButton(page);
    await page.keyboard.type('Nested item two');
    // Double-enter to exit nested list
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Item three');
    // Double-enter to exit list
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Normal text');

    // This color is normalized by the browser
    const expectedTextStyle = 'color: rgb(208, 2, 27);';
    // This isn't (yet) parsed as a color, so it isn't normalized
    const expectedMarkerStyle = '--listitem-marker-color: #d0021b;';
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li
            class="PlaygroundEditorTheme__listItem"
            style="${expectedMarkerStyle}"
            value="1">
            <strong
              class="PlaygroundEditorTheme__textBold"
              style="${expectedTextStyle}"
              data-lexical-text="true">
              Item one
            </strong>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            style="${expectedMarkerStyle}"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li
                class="PlaygroundEditorTheme__listItem"
                style="${expectedMarkerStyle}"
                value="1">
                <strong
                  class="PlaygroundEditorTheme__textBold"
                  style="${expectedTextStyle}"
                  data-lexical-text="true">
                  Nested item two
                </strong>
              </li>
            </ul>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem"
            style="${expectedMarkerStyle}"
            value="2">
            <strong
              class="PlaygroundEditorTheme__textBold"
              style="${expectedTextStyle}"
              data-lexical-text="true">
              Item three
            </strong>
          </li>
        </ul>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <strong
            class="PlaygroundEditorTheme__textBold"
            style="${expectedTextStyle}"
            data-lexical-text="true">
            Normal text
          </strong>
        </p>
      `,
    );
  });

  test(`Can indent/outdent multiple list nodes in a list with multiple levels of indentation`, async ({
    page,
  }) => {
    await focusEditor(page);

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <br data-lexical-managed-linebreak="true" />
          </li>
        </ul>
      `,
    );

    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('from');

    await clickIndentButton(page);

    // - Hello
    //    - from
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );

    await selectAll(page);

    await clickIndentButton(page, 3);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="1">
            <ul class="PlaygroundEditorTheme__ul">
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="1">
                <ul class="PlaygroundEditorTheme__ul">
                  <li
                    class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                    value="1">
                    <ul class="PlaygroundEditorTheme__ul">
                      <li class="PlaygroundEditorTheme__listItem" value="1">
                        <span data-lexical-text="true">Hello</span>
                      </li>
                      <li
                        class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                        value="2">
                        <ul class="PlaygroundEditorTheme__ul">
                          <li class="PlaygroundEditorTheme__listItem" value="1">
                            <span data-lexical-text="true">from</span>
                          </li>
                        </ul>
                      </li>
                    </ul>
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );

    await clickOutdentButton(page, 3);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );

    await page.keyboard.press('ArrowRight');

    await page.keyboard.press('Enter');
    await page.keyboard.type('the');
    await page.keyboard.press('Enter');
    await page.keyboard.type('other');
    await page.keyboard.press('Enter');
    await page.keyboard.type('side');

    await clickOutdentButton(page);

    // - Hello
    //    - from
    //    - the
    //    - other
    // - side
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">the</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="3">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );

    await selectAll(page);

    await clickIndentButton(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="1">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">Hello</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">from</span>
                  </li>
                  <li class="PlaygroundEditorTheme__listItem" value="2">
                    <span data-lexical-text="true">the</span>
                  </li>
                  <li class="PlaygroundEditorTheme__listItem" value="3">
                    <span data-lexical-text="true">other</span>
                  </li>
                </ul>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">side</span>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );

    await clickOutdentButton(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">the</span>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="3">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );
  });

  test(`Can indent a list with a list item in between nested lists`, async ({
    page,
  }) => {
    await focusEditor(page);
    await toggleBulletList(page);
    await page.keyboard.type('foo');
    await clickIndentButton(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('bar');
    await clickOutdentButton(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('baz');
    await clickIndentButton(page);

    await selectAll(page);
    await clickIndentButton(page);
    await assertHTML(
      page,
      html`
        <ul dir="auto">
          <li value="1">
            <ul>
              <li value="1">
                <ul>
                  <li value="1">
                    <span data-lexical-text="true">foo</span>
                  </li>
                </ul>
              </li>
              <li value="1">
                <span data-lexical-text="true">bar</span>
              </li>
              <li value="2">
                <ul>
                  <li value="1">
                    <span data-lexical-text="true">baz</span>
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Can create a list and then toggle it back to original state.`, async ({
    page,
  }) => {
    await focusEditor(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await page.keyboard.type('Hello');

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
        </ul>
      `,
    );

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
        </p>
      `,
    );

    await page.keyboard.press('Enter');
    await page.keyboard.type('from');
    await page.keyboard.press('Enter');
    await page.keyboard.type('the');
    await page.keyboard.press('Enter');
    await page.keyboard.type('other');
    await page.keyboard.press('Enter');
    await page.keyboard.type('side');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">from</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">the</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">other</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">side</span>
        </p>
      `,
    );

    await selectAll(page);

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">from</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">the</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="4">
            <span data-lexical-text="true">other</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="5">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">from</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">the</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">other</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">side</span>
        </p>
      `,
    );

    // works for an indented list

    await toggleBulletList(page);

    await clickIndentButton(page, 3);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="1">
            <ul class="PlaygroundEditorTheme__ul">
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="1">
                <ul class="PlaygroundEditorTheme__ul">
                  <li
                    class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                    value="1">
                    <ul class="PlaygroundEditorTheme__ul">
                      <li class="PlaygroundEditorTheme__listItem" value="1">
                        <span data-lexical-text="true">Hello</span>
                      </li>
                      <li class="PlaygroundEditorTheme__listItem" value="2">
                        <span data-lexical-text="true">from</span>
                      </li>
                      <li class="PlaygroundEditorTheme__listItem" value="3">
                        <span data-lexical-text="true">the</span>
                      </li>
                      <li class="PlaygroundEditorTheme__listItem" value="4">
                        <span data-lexical-text="true">other</span>
                      </li>
                      <li class="PlaygroundEditorTheme__listItem" value="5">
                        <span data-lexical-text="true">side</span>
                      </li>
                    </ul>
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(3 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">Hello</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(3 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">from</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(3 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">the</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(3 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">other</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(3 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">side</span>
        </p>
      `,
    );
  });

  test(`Can toggle format for multi-line list of each type without losing indentation state.`, async ({
    page,
  }) => {
    await focusEditor(page);

    // Standard assertion
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await toggleBulletList(page);

    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('from');
    await clickIndentButton(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('the');
    await clickIndentButton(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('other');
    await clickOutdentButton(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('side');
    await clickOutdentButton(page);

    // Before toggle off/on unordered list
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ul>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );

    await selectAll(page);

    await toggleBulletList(page);
    await toggleBulletList(page);

    // After toggle off/on unordered list
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ul>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );

    await toggleNumberedList(page);

    // Before toggle off/on ordered list
    await assertHTML(
      page,
      html`
        <ol class="PlaygroundEditorTheme__ol1" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ol class="PlaygroundEditorTheme__ol2">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ol class="PlaygroundEditorTheme__ol3">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ol>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ol>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ol>
      `,
    );

    await toggleNumberedList(page);
    await toggleNumberedList(page);

    // After toggle off/on ordered list
    await assertHTML(
      page,
      html`
        <ol class="PlaygroundEditorTheme__ol1" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ol class="PlaygroundEditorTheme__ol2">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ol class="PlaygroundEditorTheme__ol3">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ol>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ol>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ol>
      `,
    );

    await toggleCheckList(page);

    // Before toggle off/on checklist
    await assertHTML(
      page,
      html`
        <ul
          class="PlaygroundEditorTheme__ul PlaygroundEditorTheme__checklist"
          dir="auto">
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
            role="checkbox"
            tabindex="-1"
            value="1"
            aria-checked="false">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul
              class="PlaygroundEditorTheme__ul PlaygroundEditorTheme__checklist">
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
                role="checkbox"
                tabindex="-1"
                value="1"
                aria-checked="false">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul
                  class="PlaygroundEditorTheme__ul PlaygroundEditorTheme__checklist">
                  <li
                    class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
                    role="checkbox"
                    tabindex="-1"
                    value="1"
                    aria-checked="false">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ul>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
                role="checkbox"
                tabindex="-1"
                value="2"
                aria-checked="false">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
            role="checkbox"
            tabindex="-1"
            value="2"
            aria-checked="false">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );

    await toggleCheckList(page);
    await toggleCheckList(page);

    // After toggle off/on checklist
    await assertHTML(
      page,
      html`
        <ul
          class="PlaygroundEditorTheme__ul PlaygroundEditorTheme__checklist"
          dir="auto">
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
            role="checkbox"
            tabindex="-1"
            value="1"
            aria-checked="false">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul
              class="PlaygroundEditorTheme__ul PlaygroundEditorTheme__checklist">
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
                role="checkbox"
                tabindex="-1"
                value="1"
                aria-checked="false">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul
                  class="PlaygroundEditorTheme__ul PlaygroundEditorTheme__checklist">
                  <li
                    class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
                    role="checkbox"
                    tabindex="-1"
                    value="1"
                    aria-checked="false">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ul>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
                role="checkbox"
                tabindex="-1"
                value="2"
                aria-checked="false">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
            role="checkbox"
            tabindex="-1"
            value="2"
            aria-checked="false">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );
  });

  test(`Can create a list containing inline blocks and then toggle it back to original state.`, async ({
    page,
  }) => {
    await focusEditor(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await page.keyboard.type('One two three');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">One two three</span>
        </p>
      `,
    );

    await moveLeft(page, 6);
    await selectCharacters(page, 'left', 3);

    // link
    await click(page, '.link');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">One</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">two</span>
          </a>
          <span data-lexical-text="true">three</span>
        </p>
      `,
    );

    // move to end of paragraph to close the floating link bar
    await moveToParagraphEnd(page);

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">One</span>
            <a
              class="PlaygroundEditorTheme__link"
              href="https://"
              rel="noreferrer">
              <span data-lexical-text="true">two</span>
            </a>
            <span data-lexical-text="true">three</span>
          </li>
        </ul>
      `,
    );

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">One</span>
          <a
            class="PlaygroundEditorTheme__link"
            href="https://"
            rel="noreferrer">
            <span data-lexical-text="true">two</span>
          </a>
          <span data-lexical-text="true">three</span>
        </p>
      `,
    );
  });

  test(`Can create multiple bullet lists and then toggle off the list.`, async ({
    page,
  }) => {
    await focusEditor(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await page.keyboard.type('Hello');

    await toggleBulletList(page);

    await page.keyboard.press('Enter');
    await page.keyboard.type('from');

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    await page.keyboard.type('the');

    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    await page.keyboard.type('other');

    await toggleBulletList(page);

    await page.keyboard.press('Enter');
    await page.keyboard.type('side');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">from</span>
          </li>
        </ul>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">the</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">other</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );

    await selectAll(page);

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">from</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">the</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">other</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">side</span>
        </p>
      `,
    );

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">from</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <br data-lexical-managed-linebreak="true" />
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="4">
            <span data-lexical-text="true">the</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="5">
            <br data-lexical-managed-linebreak="true" />
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="6">
            <span data-lexical-text="true">other</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="7">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );
  });

  test(`Can create an unordered list and convert it to an ordered list `, async ({
    page,
  }) => {
    await focusEditor(page);

    await waitForSelector(page, '.block-controls');

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <br data-lexical-managed-linebreak="true" />
          </li>
        </ul>
      `,
    );

    await toggleNumberedList(page);

    await assertHTML(
      page,
      html`
        <ol class="PlaygroundEditorTheme__ol1" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <br data-lexical-managed-linebreak="true" />
          </li>
        </ol>
      `,
    );

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <br data-lexical-managed-linebreak="true" />
          </li>
        </ul>
      `,
    );
  });

  test(`Can create a single item unordered list with text and convert it to an ordered list `, async ({
    page,
  }) => {
    await focusEditor(page);

    await toggleBulletList(page);

    await page.keyboard.type('Hello');

    await toggleNumberedList(page);

    await assertHTML(
      page,
      html`
        <ol class="PlaygroundEditorTheme__ol1" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
        </ol>
      `,
    );

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
        </ul>
      `,
    );
  });

  test(`Can create a multi-line unordered list and convert it to an ordered list `, async ({
    page,
  }) => {
    await focusEditor(page);

    await toggleBulletList(page);

    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('from');
    await page.keyboard.press('Enter');
    await page.keyboard.type('the');
    await page.keyboard.press('Enter');
    await page.keyboard.type('other');
    await page.keyboard.press('Enter');
    await page.keyboard.type('side');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">from</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">the</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="4">
            <span data-lexical-text="true">other</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="5">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );

    await toggleNumberedList(page);

    await assertHTML(
      page,
      html`
        <ol class="PlaygroundEditorTheme__ol1" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">from</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">the</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="4">
            <span data-lexical-text="true">other</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="5">
            <span data-lexical-text="true">side</span>
          </li>
        </ol>
      `,
    );

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">from</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">the</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="4">
            <span data-lexical-text="true">other</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="5">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );
  });

  test(`Can create a multi-line unordered list and convert it to an ordered list when no nodes are in the selection`, async ({
    page,
  }) => {
    await focusEditor(page);

    await toggleBulletList(page);

    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('from');
    await page.keyboard.press('Enter');
    await page.keyboard.type('the');
    await page.keyboard.press('Enter');
    await page.keyboard.type('other');
    await page.keyboard.press('Enter');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">from</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">the</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="4">
            <span data-lexical-text="true">other</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="5">
            <br data-lexical-managed-linebreak="true" />
          </li>
        </ul>
      `,
    );

    await toggleNumberedList(page);

    await assertHTML(
      page,
      html`
        <ol class="PlaygroundEditorTheme__ol1" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">from</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">the</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="4">
            <span data-lexical-text="true">other</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="5">
            <br data-lexical-managed-linebreak="true" />
          </li>
        </ol>
      `,
    );

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">from</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">the</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="4">
            <span data-lexical-text="true">other</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="5">
            <br data-lexical-managed-linebreak="true" />
          </li>
        </ul>
      `,
    );
  });

  test(`Can create an indented multi-line unordered list and convert it to an ordered list `, async ({
    page,
  }) => {
    await focusEditor(page);

    await toggleBulletList(page);

    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('from');
    await clickIndentButton(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('the');
    await clickIndentButton(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('other');
    await clickOutdentButton(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('side');
    await clickOutdentButton(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ul>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );

    await selectAll(page);

    await toggleNumberedList(page);

    await assertHTML(
      page,
      html`
        <ol class="PlaygroundEditorTheme__ol1" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ol class="PlaygroundEditorTheme__ol2">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ol class="PlaygroundEditorTheme__ol3">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ol>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ol>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ol>
      `,
    );

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ul>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );
  });

  test(`Can create an indented multi-line unordered list and convert individual lists in the nested structure to a numbered list. `, async ({
    page,
  }) => {
    await focusEditor(page);

    await toggleBulletList(page);

    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('from');
    await clickIndentButton(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('the');
    await clickIndentButton(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('other');
    await clickOutdentButton(page);

    await page.keyboard.press('Enter');
    await page.keyboard.type('side');
    await clickOutdentButton(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ul>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );

    await toggleNumberedList(page);

    await assertHTML(
      page,
      html`
        <ol class="PlaygroundEditorTheme__ol1" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ul>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ol>
      `,
    );

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ul>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );

    // move to next item up in list
    await page.keyboard.press('ArrowUp');

    await toggleNumberedList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ol class="PlaygroundEditorTheme__ol2">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ul>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ol>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ul>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );

    // move to next item up in list
    await page.keyboard.press('ArrowUp');

    await toggleNumberedList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ol class="PlaygroundEditorTheme__ol3">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ol>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">from</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">the</span>
                  </li>
                </ul>
              </li>
              <li class="PlaygroundEditorTheme__listItem" value="2">
                <span data-lexical-text="true">other</span>
              </li>
            </ul>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );
  });

  test(`Should merge selected nodes into existing list siblings of the same type when formatting to a list`, async ({
    page,
  }) => {
    await focusEditor(page);

    // Hello
    // - from
    // the
    // - other
    // side
    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('from');
    await toggleBulletList(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('the');
    await page.keyboard.press('Enter');
    await page.keyboard.type('other');
    await toggleBulletList(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('side');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
        </p>
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">from</span>
          </li>
        </ul>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">the</span>
        </p>
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">other</span>
          </li>
        </ul>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">side</span>
        </p>
      `,
    );

    await selectAll(page);

    await toggleBulletList(page);

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">from</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">the</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="4">
            <span data-lexical-text="true">other</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="5">
            <span data-lexical-text="true">side</span>
          </li>
        </ul>
      `,
    );
  });

  test(`Should NOT merge selected nodes into existing list siblings of a different type when formatting to a list`, async ({
    page,
    isCollab,
  }) => {
    await focusEditor(page);

    // - Hello
    // - from
    // the
    await toggleBulletList(page);
    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await page.keyboard.type('from');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('the');
    await toggleNumberedList(page);

    // - Hello
    // - from
    // 1. the
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">from</span>
          </li>
        </ul>
        <ol class="PlaygroundEditorTheme__ol1" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">the</span>
          </li>
        </ol>
      `,
    );

    await clearEditor(page);

    // Hello
    // 1. from
    // 2. the
    await page.keyboard.type('Hello');
    await page.keyboard.press('Enter');
    await toggleNumberedList(page);
    await page.keyboard.type('from');
    await page.keyboard.press('Enter');
    await page.keyboard.type('the');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await toggleNumberedList(page);

    // 1. Hello
    // 2. from
    // 3. the
    await assertHTML(
      page,
      html`
        <ol class="PlaygroundEditorTheme__ol1" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">from</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">the</span>
          </li>
        </ol>
      `,
    );
  });

  test(`Should create list with start number markdown`, async ({
    page,
    isCollab,
  }) => {
    await focusEditor(page);
    // Trigger markdown using 321 digits followed by "." and a trigger of " ".
    await page.keyboard.type('321. ');

    // forward case is the normal case.
    // undo case is when the user presses undo.

    const forwardHTML =
      '<ol start="321" class="PlaygroundEditorTheme__ol1" dir="auto"><li value="321" class="PlaygroundEditorTheme__listItem"><br data-lexical-managed-linebreak="true"></li></ol>';

    const undoHTML = html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">321.</span>
      </p>
    `;

    await assertHTML(page, forwardHTML);
    if (isCollab) {
      // Collab uses its own undo/redo
      return;
    }
    await undo(page);
    await assertHTML(page, undoHTML);
    await redo(page);
    await assertHTML(page, forwardHTML);
  });

  test(`Should not process paragraph markdown inside list.`, async ({page}) => {
    await focusEditor(page);

    await toggleBulletList(page);
    await page.keyboard.type('# ');
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">#</span>
          </li>
        </ul>
      `,
    );
  });

  test(`Un-indents list empty list items when the user presses enter`, async ({
    page,
  }) => {
    await focusEditor(page);
    await toggleBulletList(page);
    await page.keyboard.type('a');
    await page.keyboard.press('Enter');
    await clickIndentButton(page);
    await clickIndentButton(page);
    await page.keyboard.press('Enter');
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">a</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <br data-lexical-managed-linebreak="true" />
              </li>
            </ul>
          </li>
        </ul>
      `,
    );
    await page.keyboard.press('Enter');
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">a</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <br data-lexical-managed-linebreak="true" />
          </li>
        </ul>
      `,
    );
    await page.keyboard.press('Enter');
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">a</span>
          </li>
        </ul>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test(`Converts a List with one ListItem to a Paragraph when Normal is selected in the format menu`, async ({
    page,
  }) => {
    await focusEditor(page);
    await toggleBulletList(page);
    await page.keyboard.type('a');
    await assertHTML(
      page,
      html`
        <ul dir="auto">
          <li value="1">
            <span data-lexical-text="true">a</span>
          </li>
        </ul>
      `,
      undefined,
      {ignoreClasses: true},
    );
    await selectFromFormatDropdown(page, '.paragraph');
    await assertHTML(
      page,
      html`
        <p dir="auto"><span data-lexical-text="true">a</span></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Converts the last ListItem in a List with multiple ListItem to a Paragraph when Normal is selected in the format menu`, async ({
    page,
  }) => {
    await focusEditor(page);
    await toggleBulletList(page);
    await page.keyboard.type('a');
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    await assertHTML(
      page,
      html`
        <ul dir="auto">
          <li value="1">
            <span data-lexical-text="true">a</span>
          </li>
          <li value="2">
            <span data-lexical-text="true">b</span>
          </li>
        </ul>
      `,
      undefined,
      {ignoreClasses: true},
    );
    await selectFromFormatDropdown(page, '.paragraph');
    await assertHTML(
      page,
      html`
        <ul dir="auto">
          <li value="1">
            <span data-lexical-text="true">a</span>
          </li>
        </ul>
        <p dir="auto"><span data-lexical-text="true">b</span></p>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test(`Converts the middle ListItem in a List with multiple ListItem to a Paragraph when Normal is selected in the format menu`, async ({
    page,
  }) => {
    await focusEditor(page);
    await toggleBulletList(page);
    await page.keyboard.type('a');
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    await page.keyboard.press('Enter');
    await page.keyboard.type('c');
    await page.keyboard.press('ArrowUp');
    await assertHTML(
      page,
      html`
        <ul dir="auto">
          <li value="1">
            <span data-lexical-text="true">a</span>
          </li>
          <li value="2">
            <span data-lexical-text="true">b</span>
          </li>
          <li value="3">
            <span data-lexical-text="true">c</span>
          </li>
        </ul>
      `,
      undefined,
      {ignoreClasses: true},
    );
    await selectFromFormatDropdown(page, '.paragraph');
    await assertHTML(
      page,
      html`
        <ul dir="auto">
          <li value="1">
            <span data-lexical-text="true">a</span>
          </li>
        </ul>
        <p dir="auto"><span data-lexical-text="true">b</span></p>
        <ul dir="auto">
          <li value="1">
            <span data-lexical-text="true">c</span>
          </li>
        </ul>
      `,
      undefined,
      {ignoreClasses: true},
    );
  });

  test('Can create check list, toggle it to bullet-list and back', async ({
    page,
  }) => {
    await focusEditor(page);
    await toggleCheckList(page);
    await page.keyboard.type('a');
    await click(page, '.PlaygroundEditorTheme__listItemUnchecked', {
      position: {x: 10, y: 10},
    });
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    await page.keyboard.press('Enter');
    await click(page, '.toolbar-item.alignment');
    await click(page, 'button:has-text("Indent")');
    await page.keyboard.type('c');
    await assertHTML(
      page,
      html`
        <ul
          class="PlaygroundEditorTheme__ul PlaygroundEditorTheme__checklist"
          dir="auto">
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemChecked"
            role="checkbox"
            tabindex="-1"
            value="1"
            aria-checked="true">
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
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked PlaygroundEditorTheme__nestedListItem"
            value="3">
            <ul
              class="PlaygroundEditorTheme__ul PlaygroundEditorTheme__checklist">
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
                role="checkbox"
                tabindex="-1"
                value="1"
                aria-checked="false">
                <span data-lexical-text="true">c</span>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );
    await moveToEditorBeginning(page);
    await toggleBulletList(page);
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">a</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">b</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="3">
            <ul
              class="PlaygroundEditorTheme__ul PlaygroundEditorTheme__checklist">
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
                role="checkbox"
                tabindex="-1"
                value="1"
                aria-checked="false">
                <span data-lexical-text="true">c</span>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );
    await toggleCheckList(page);
    await assertHTML(
      page,
      html`
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
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked PlaygroundEditorTheme__nestedListItem"
            value="3">
            <ul
              class="PlaygroundEditorTheme__ul PlaygroundEditorTheme__checklist">
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
                role="checkbox"
                tabindex="-1"
                value="1"
                aria-checked="false">
                <span data-lexical-text="true">c</span>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );
  });

  test('can navigate and check/uncheck with keyboard', async ({
    page,
    isCollab,
  }) => {
    await focusEditor(page);
    await toggleCheckList(page);
    //
    // [ ] a
    // [ ] b
    //     [ ] c
    //         [ ] d
    //         [ ] e
    // [ ] f
    await page.keyboard.type('a');
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    await page.keyboard.press('Enter');
    await click(page, '.toolbar-item.alignment');
    await click(page, 'button:has-text("Indent")');
    await page.keyboard.type('c');
    await page.keyboard.press('Enter');
    await click(page, '.toolbar-item.alignment');
    await click(page, 'button:has-text("Indent")');
    await page.keyboard.type('d');
    await page.keyboard.press('Enter');
    await page.keyboard.type('e');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('f');

    const assertCheckCount = async (checkCount, uncheckCount) => {
      const pageOrFrame = await (isCollab ? page.frame('left') : page);
      await expect(
        pageOrFrame.locator('li[role="checkbox"][aria-checked="true"]'),
      ).toHaveCount(checkCount);
      await expect(
        pageOrFrame.locator('li[role="checkbox"][aria-checked="false"]'),
      ).toHaveCount(uncheckCount);
    };

    await assertCheckCount(0, 6);

    // Go back to select checkbox
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Space');

    await repeat(5, async () => {
      await page.keyboard.press('ArrowUp', {delay: 50});
      await page.keyboard.press('Space');
    });

    await assertCheckCount(6, 0);

    await repeat(3, async () => {
      await page.keyboard.press('ArrowDown', {delay: 50});
      await page.keyboard.press('Space');
    });

    await assertCheckCount(3, 3);
  });

  test('replaces existing element node', async ({page}) => {
    // Create two quote blocks, select it and format to a list
    // should replace quotes (instead of moving quotes into the list items)
    await focusEditor(page);
    await page.keyboard.type('> Hello from');
    await page.keyboard.press('Enter');
    await page.keyboard.type('> the other side');
    await selectAll(page);
    await toggleBulletList(page);
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello from</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">the other side</span>
          </li>
        </ul>
      `,
    );
  });

  test('remove list breaks when selection in empty nested list item', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Hello World');
    await page.keyboard.press('Enter');
    await toggleBulletList(page);
    await click(page, '.toolbar-item.alignment');
    await click(page, 'button:has-text("Indent")');
    await toggleBulletList(page);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello World</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [1],
      focusOffset: 0,
      focusPath: [1],
    });
  });

  test('remove list breaks when selection in empty nested list item 2', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Hello World');
    await page.keyboard.press('Enter');
    await page.keyboard.type('a');
    await toggleBulletList(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await click(page, '.toolbar-item.alignment');
    await click(page, 'button:has-text("Indent")');
    await toggleBulletList(page);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello World</span>
        </p>
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">a</span>
          </li>
        </ul>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">b</span>
          </li>
        </ul>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2],
      focusOffset: 0,
      focusPath: [2],
    });
  });
  test('new list item should preserve format from previous list item even after new list item is indented', async ({
    page,
  }) => {
    await focusEditor(page);
    await toggleBulletList(page);
    await toggleBold(page);
    await page.keyboard.type('MLH Fellowship');
    await page.keyboard.press('Enter');
    await indent(page, 1);
    await page.keyboard.type('Fall 2024');
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              MLH Fellowship
            </strong>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <strong
                  class="PlaygroundEditorTheme__textBold"
                  data-lexical-text="true">
                  Fall 2024
                </strong>
              </li>
            </ul>
          </li>
        </ul>
      `,
    );
  });
  test('collapseAtStart for trivial bullet list', async ({page}) => {
    await focusEditor(page);
    await toggleBulletList(page);
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <br data-lexical-managed-linebreak="true" />
          </li>
        </ul>
      `,
    );
    await pressBackspace(page);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });
  test('collapseAtStart for bullet list with text', async ({page}) => {
    await focusEditor(page);
    await toggleBulletList(page);
    await page.keyboard.type('Hello World');
    await moveToLineBeginning(page);
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Hello World</span>
          </li>
        </ul>
      `,
    );
    await pressBackspace(page);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello World</span>
        </p>
      `,
    );
  });
  test('collapseAtStart for bullet list with text inside autolink', async ({
    page,
  }) => {
    await focusEditor(page);
    await toggleBulletList(page);
    await page.keyboard.type('www.example.com');
    await moveToLineBeginning(page);
    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <a
              class="PlaygroundEditorTheme__link"
              href="https://www.example.com">
              <span data-lexical-text="true">www.example.com</span>
            </a>
          </li>
        </ul>
      `,
    );
    await pressBackspace(page);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <a class="PlaygroundEditorTheme__link" href="https://www.example.com">
            <span data-lexical-text="true">www.example.com</span>
          </a>
        </p>
      `,
    );
  });
});
