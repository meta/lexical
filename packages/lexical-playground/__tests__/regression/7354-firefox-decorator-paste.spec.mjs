/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {moveLeft} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  focusEditor,
  html,
  initialize,
  keyDownCtrlOrMeta,
  keyUpCtrlOrMeta,
  selectFromInsertDropdown,
  test,
  withExclusiveClipboardAccess,
} from '../utils/index.mjs';

test.skip(
  ({isCollab, isPlainText}) => isPlainText || isCollab,
  'Requires rich text without collaboration',
);

test.describe('HTML CopyAndPaste', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('Copy + paste multi line html with extra newlines', async ({page}) => {
    await focusEditor(page);
    await selectFromInsertDropdown(page, '.poll');
    await click(page, '.Modal__overlay[role=dialog] .Input__input');
    await page.keyboard.type('Question');
    await click(page, '.Modal__overlay[role=dialog] .DialogActions button');
    await click(page, '.PollNode__optionInput');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            contenteditable="false"
            style="display: inline-block"
            data-lexical-decorator="true">
            <div class="PollNode__container">
              <div class="PollNode__inner">
                <h2 class="PollNode__heading">Question</h2>
                <div class="PollNode__optionContainer">
                  <div class="PollNode__optionCheckboxWrapper">
                    <input class="PollNode__optionCheckbox" type="checkbox" />
                  </div>
                  <div class="PollNode__optionInputWrapper">
                    <div
                      class="PollNode__optionInputVotes"
                      style="width: 0%"></div>
                    <span class="PollNode__optionInputVotesCount"></span>
                    <input
                      class="PollNode__optionInput"
                      placeholder="Option 1"
                      type="text"
                      value="" />
                  </div>
                  <button
                    class="PollNode__optionDelete PollNode__optionDeleteDisabled"
                    disabled=""
                    aria-label="Remove"></button>
                </div>
                <div class="PollNode__optionContainer">
                  <div class="PollNode__optionCheckboxWrapper">
                    <input class="PollNode__optionCheckbox" type="checkbox" />
                  </div>
                  <div class="PollNode__optionInputWrapper">
                    <div
                      class="PollNode__optionInputVotes"
                      style="width: 0%"></div>
                    <span class="PollNode__optionInputVotesCount"></span>
                    <input
                      class="PollNode__optionInput"
                      placeholder="Option 2"
                      type="text"
                      value="" />
                  </div>
                  <button
                    class="PollNode__optionDelete PollNode__optionDeleteDisabled"
                    disabled=""
                    aria-label="Remove"></button>
                </div>
                <div class="PollNode__footer">
                  <button class="Button__root Button__small">Add Option</button>
                </div>
              </div>
            </div>
          </span>
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await page.keyboard.type('hello');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            contenteditable="false"
            style="display: inline-block"
            data-lexical-decorator="true">
            <div class="PollNode__container">
              <div class="PollNode__inner">
                <h2 class="PollNode__heading">Question</h2>
                <div class="PollNode__optionContainer">
                  <div class="PollNode__optionCheckboxWrapper">
                    <input class="PollNode__optionCheckbox" type="checkbox" />
                  </div>
                  <div class="PollNode__optionInputWrapper">
                    <div
                      class="PollNode__optionInputVotes"
                      style="width: 0%"></div>
                    <span class="PollNode__optionInputVotesCount"></span>
                    <input
                      class="PollNode__optionInput"
                      placeholder="Option 1"
                      type="text"
                      value="hello" />
                  </div>
                  <button
                    class="PollNode__optionDelete PollNode__optionDeleteDisabled"
                    disabled=""
                    aria-label="Remove"></button>
                </div>
                <div class="PollNode__optionContainer">
                  <div class="PollNode__optionCheckboxWrapper">
                    <input class="PollNode__optionCheckbox" type="checkbox" />
                  </div>
                  <div class="PollNode__optionInputWrapper">
                    <div
                      class="PollNode__optionInputVotes"
                      style="width: 0%"></div>
                    <span class="PollNode__optionInputVotesCount"></span>
                    <input
                      class="PollNode__optionInput"
                      placeholder="Option 2"
                      type="text"
                      value="" />
                  </div>
                  <button
                    class="PollNode__optionDelete PollNode__optionDeleteDisabled"
                    disabled=""
                    aria-label="Remove"></button>
                </div>
                <div class="PollNode__footer">
                  <button class="Button__root Button__small">Add Option</button>
                </div>
              </div>
            </div>
          </span>
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await page.keyboard.down('Shift');
    await moveLeft(page, 4);
    await page.keyboard.up('Shift');
    await keyDownCtrlOrMeta(page);
    await withExclusiveClipboardAccess(async () => {
      // copy 'ello' once
      await page.keyboard.press('c');
      await keyUpCtrlOrMeta(page);
      await keyDownCtrlOrMeta(page);
      // paste it twice into the decorator's input
      await page.keyboard.press('v');
      await page.keyboard.press('v');
    });
    await keyUpCtrlOrMeta(page);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            contenteditable="false"
            style="display: inline-block"
            data-lexical-decorator="true">
            <div class="PollNode__container">
              <div class="PollNode__inner">
                <h2 class="PollNode__heading">Question</h2>
                <div class="PollNode__optionContainer">
                  <div class="PollNode__optionCheckboxWrapper">
                    <input class="PollNode__optionCheckbox" type="checkbox" />
                  </div>
                  <div class="PollNode__optionInputWrapper">
                    <div
                      class="PollNode__optionInputVotes"
                      style="width: 0%"></div>
                    <span class="PollNode__optionInputVotesCount"></span>
                    <input
                      class="PollNode__optionInput"
                      placeholder="Option 1"
                      type="text"
                      value="helloello" />
                  </div>
                  <button
                    class="PollNode__optionDelete PollNode__optionDeleteDisabled"
                    disabled=""
                    aria-label="Remove"></button>
                </div>
                <div class="PollNode__optionContainer">
                  <div class="PollNode__optionCheckboxWrapper">
                    <input class="PollNode__optionCheckbox" type="checkbox" />
                  </div>
                  <div class="PollNode__optionInputWrapper">
                    <div
                      class="PollNode__optionInputVotes"
                      style="width: 0%"></div>
                    <span class="PollNode__optionInputVotesCount"></span>
                    <input
                      class="PollNode__optionInput"
                      placeholder="Option 2"
                      type="text"
                      value="" />
                  </div>
                  <button
                    class="PollNode__optionDelete PollNode__optionDeleteDisabled"
                    disabled=""
                    aria-label="Remove"></button>
                </div>
                <div class="PollNode__footer">
                  <button class="Button__root Button__small">Add Option</button>
                </div>
              </div>
            </div>
          </span>
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });
});
