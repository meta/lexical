/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {selectAll} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  focusEditor,
  html,
  initialize,
  insertTable,
  pasteFromClipboard,
  selectFromAlignDropdown,
  test,
} from '../utils/index.mjs';

async function toggleBulletList(page) {
  await click(page, '.block-controls');
  await click(page, '.dropdown .icon.bullet-list');
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

const MAX_INDENT = 7;

test.describe('Identation', () => {
  test.beforeEach(({isCollab, page}) =>
    initialize({isCollab, page, tableHorizontalScroll: false}),
  );

  test(`Can create content and indent and outdent it all`, async ({
    page,
    browserName,
    isPlainText,
    isCollab,
  }) => {
    // We have to skip collab due to styling on the table for selected cells
    test.skip(isPlainText || isCollab);
    await focusEditor(page);
    await page.keyboard.type('foo');
    await page.keyboard.press('Enter');
    await page.keyboard.type('bar');
    await page.keyboard.press('Enter');
    await page.keyboard.type('yar');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- item');
    await page.keyboard.type('item 2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('item 3');
    await click(page, '.toolbar-item.alignment');
    await click(page, 'button:has-text("Indent")');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('``` ');
    await page.keyboard.type('code');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    await insertTable(page, 1, 1);

    await page.keyboard.type('foo');

    await selectAll(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">foo</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">bar</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">yar</span>
        </p>
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">itemitem 2</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">item 3</span>
              </li>
            </ul>
          </li>
        </ul>
        <code
          class="PlaygroundEditorTheme__code"
          dir="auto"
          spellcheck="false"
          data-gutter="1">
          <span data-lexical-text="true">code</span>
        </code>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table
          class="PlaygroundEditorTheme__table PlaygroundEditorTheme__tableSelection"
          dir="auto">
          <colgroup>
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">foo</span>
              </p>
            </th>
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await click(page, '.toolbar-item.alignment');
    await click(page, 'button:has-text("Indent")');

    await assertHTML(
      page,
      html`
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">foo</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">bar</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">yar</span>
        </p>
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="1">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">itemitem 2</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">item 3</span>
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
        <code
          class="PlaygroundEditorTheme__code"
          dir="auto"
          spellcheck="false"
          data-gutter="1">
          <span data-lexical-text="true">code</span>
        </code>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table
          class="PlaygroundEditorTheme__table PlaygroundEditorTheme__tableSelection"
          dir="auto">
          <colgroup>
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p
                class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
                dir="auto"
                style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
                <span data-lexical-text="true">foo</span>
              </p>
            </th>
          </tr>
        </table>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await click(page, '.toolbar-item.alignment');
    await click(page, 'button:has-text("Indent")');

    await assertHTML(
      page,
      html`
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(2 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">foo</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(2 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">bar</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(2 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">yar</span>
        </p>
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="1">
            <ul class="PlaygroundEditorTheme__ul">
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="1">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">itemitem 2</span>
                  </li>
                  <li
                    class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                    value="2">
                    <ul class="PlaygroundEditorTheme__ul">
                      <li class="PlaygroundEditorTheme__listItem" value="1">
                        <span data-lexical-text="true">item 3</span>
                      </li>
                    </ul>
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
        <code
          class="PlaygroundEditorTheme__code"
          dir="auto"
          spellcheck="false"
          data-gutter="1">
          <span data-lexical-text="true">code</span>
        </code>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(2 * var(--lexical-indent-base-value, 40px))">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table
          class="PlaygroundEditorTheme__table PlaygroundEditorTheme__tableSelection"
          dir="auto">
          <colgroup>
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p
                class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
                dir="auto"
                style="padding-inline-start: calc(2 * var(--lexical-indent-base-value, 40px))">
                <span data-lexical-text="true">foo</span>
              </p>
            </th>
          </tr>
        </table>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(2 * var(--lexical-indent-base-value, 40px))">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await click(page, '.toolbar-item.alignment');
    await click(page, 'button:has-text("Outdent")');

    await assertHTML(
      page,
      html`
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">foo</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">bar</span>
        </p>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
          <span data-lexical-text="true">yar</span>
        </p>
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="1">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">itemitem 2</span>
              </li>
              <li
                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                value="2">
                <ul class="PlaygroundEditorTheme__ul">
                  <li class="PlaygroundEditorTheme__listItem" value="1">
                    <span data-lexical-text="true">item 3</span>
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
        <code
          class="PlaygroundEditorTheme__code"
          dir="auto"
          spellcheck="false"
          data-gutter="1">
          <span data-lexical-text="true">code</span>
        </code>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table
          class="PlaygroundEditorTheme__table PlaygroundEditorTheme__tableSelection"
          dir="auto">
          <colgroup>
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p
                class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
                dir="auto"
                style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
                <span data-lexical-text="true">foo</span>
              </p>
            </th>
          </tr>
        </table>
        <p
          class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent"
          dir="auto"
          style="padding-inline-start: calc(1 * var(--lexical-indent-base-value, 40px))">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await click(page, '.toolbar-item.alignment');
    await click(page, 'button:has-text("Outdent")');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">foo</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">bar</span>
        </p>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">yar</span>
        </p>
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">itemitem 2</span>
          </li>
          <li
            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
            value="2">
            <ul class="PlaygroundEditorTheme__ul">
              <li class="PlaygroundEditorTheme__listItem" value="1">
                <span data-lexical-text="true">item 3</span>
              </li>
            </ul>
          </li>
        </ul>
        <code
          class="PlaygroundEditorTheme__code"
          dir="auto"
          spellcheck="false"
          data-gutter="1">
          <span data-lexical-text="true">code</span>
        </code>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <table
          class="PlaygroundEditorTheme__table PlaygroundEditorTheme__tableSelection"
          dir="auto">
          <colgroup>
            <col style="width: 92px" />
          </colgroup>
          <tr dir="auto">
            <th
              class="PlaygroundEditorTheme__tableCell PlaygroundEditorTheme__tableCellHeader PlaygroundEditorTheme__tableCellSelected"
              dir="auto">
              <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                <span data-lexical-text="true">foo</span>
              </p>
            </th>
          </tr>
        </table>
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });

  test(`Can only indent paragraph until the max depth`, async ({
    page,
    isPlainText,
  }) => {
    test.skip(isPlainText);
    await focusEditor(page);
    await clickIndentButton(page, MAX_INDENT);

    const expectedHTML =
      '<p class="PlaygroundEditorTheme__paragraph PlaygroundEditorTheme__indent" dir="auto" style="padding-inline-start: calc(6 * var(--lexical-indent-base-value, 40px))"><br data-lexical-managed-linebreak="true" /></p>';

    await assertHTML(page, expectedHTML);
    await clickIndentButton(page, MAX_INDENT);

    // should stay the same
    await assertHTML(page, expectedHTML);
  });

  test(`Can only indent until the max depth when list is empty`, async ({
    page,
    isPlainText,
  }) => {
    test.skip(isPlainText);
    await focusEditor(page);
    await toggleBulletList(page);

    await clickIndentButton(page, MAX_INDENT);

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
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="1">
                                    <br data-lexical-managed-linebreak="true" />
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
              </li>
            </ul>
          </li>
        </ul>
      `,
    );

    await clickIndentButton(page);

    // should stay the same
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
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="1">
                                    <br data-lexical-managed-linebreak="true" />
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
              </li>
            </ul>
          </li>
        </ul>
      `,
    );
  });

  test(`Can only indent until the max depth when list has content`, async ({
    page,
    isPlainText,
  }) => {
    test.skip(isPlainText);
    await focusEditor(page);
    await toggleBulletList(page);
    await page.keyboard.type('World');

    await clickIndentButton(page, MAX_INDENT);

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
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="1">
                                    <span data-lexical-text="true">World</span>
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
              </li>
            </ul>
          </li>
        </ul>
      `,
    );

    await clickIndentButton(page);

    // should stay the same
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
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="1">
                                    <span data-lexical-text="true">World</span>
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
              </li>
            </ul>
          </li>
        </ul>
      `,
    );
  });

  test(`Can only indent until the max depth a list with nested lists`, async ({
    page,
    isPlainText,
  }) => {
    test.skip(isPlainText);

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
    await clickIndentButton(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('side');
    await clickIndentButton(page);
    await page.keyboard.press('Enter');

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
                  <li
                    class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                    value="2">
                    <ul class="PlaygroundEditorTheme__ul">
                      <li class="PlaygroundEditorTheme__listItem" value="1">
                        <span data-lexical-text="true">other</span>
                      </li>
                      <li
                        class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                        value="2">
                        <ul class="PlaygroundEditorTheme__ul">
                          <li class="PlaygroundEditorTheme__listItem" value="1">
                            <span data-lexical-text="true">side</span>
                          </li>
                          <li class="PlaygroundEditorTheme__listItem" value="2">
                            <br data-lexical-managed-linebreak="true" />
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

    await selectAll(page);

    await clickIndentButton(page, 3);

    // the "side" item and the one following it remain at maximum nesting, while the others are indented
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
                          <li
                            class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                            value="2">
                            <ul class="PlaygroundEditorTheme__ul">
                              <li
                                class="PlaygroundEditorTheme__listItem"
                                value="1">
                                <span data-lexical-text="true">the</span>
                              </li>
                              <li
                                class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
                                value="2">
                                <ul class="PlaygroundEditorTheme__ul">
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="1">
                                    <span data-lexical-text="true">other</span>
                                  </li>
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="2">
                                    <span data-lexical-text="true">side</span>
                                  </li>
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="3">
                                    <br data-lexical-managed-linebreak="true" />
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
              </li>
            </ul>
          </li>
        </ul>
      `,
    );

    await clickIndentButton(page, 3);

    // all items have reached maximum nesting depth
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
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="1">
                                    <span data-lexical-text="true">Hello</span>
                                  </li>
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="2">
                                    <span data-lexical-text="true">from</span>
                                  </li>
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="3">
                                    <span data-lexical-text="true">the</span>
                                  </li>
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="4">
                                    <span data-lexical-text="true">other</span>
                                  </li>
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="5">
                                    <span data-lexical-text="true">side</span>
                                  </li>
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="6">
                                    <br data-lexical-managed-linebreak="true" />
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
              </li>
            </ul>
          </li>
        </ul>
      `,
    );

    await clickIndentButton(page);

    // should stay the same
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
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="1">
                                    <span data-lexical-text="true">Hello</span>
                                  </li>
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="2">
                                    <span data-lexical-text="true">from</span>
                                  </li>
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="3">
                                    <span data-lexical-text="true">the</span>
                                  </li>
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="4">
                                    <span data-lexical-text="true">other</span>
                                  </li>
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="5">
                                    <span data-lexical-text="true">side</span>
                                  </li>
                                  <li
                                    class="PlaygroundEditorTheme__listItem"
                                    value="6">
                                    <br data-lexical-managed-linebreak="true" />
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
              </li>
            </ul>
          </li>
        </ul>
      `,
    );
  });

  test(`Cannot have negative indents (#7410)`, async ({page, isPlainText}) => {
    test.skip(isPlainText);
    await focusEditor(page);

    await pasteFromClipboard(page, {
      'text/html': html`
        <p style="padding-inline-start: 1px">hello1</p>
        <p style="padding-inline-start: 2px">hello2</p>
        <p style="padding-inline-start: 3px">hello3</p>
      `,
    });

    await selectAll(page);
    await clickOutdentButton(page, 2);

    await click(page, '.block-controls');
    await click(page, '.dropdown .icon.bullet-list');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">hello1</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="2">
            <span data-lexical-text="true">hello2</span>
          </li>
          <li class="PlaygroundEditorTheme__listItem" value="3">
            <span data-lexical-text="true">hello3</span>
          </li>
        </ul>
      `,
    );
  });
});
