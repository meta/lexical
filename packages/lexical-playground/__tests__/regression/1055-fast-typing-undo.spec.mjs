/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {undo} from '../keyboardShortcuts/index.mjs';
import {
  advanceHistoryClock,
  assertHTML,
  focusEditor,
  html,
  initialize,
  test,
} from '../utils/index.mjs';

test.skip(({isCollab}) => isCollab, 'Requires non-collaborative editing');

test.describe('Regression test #1055', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test(`Adds new editor state into undo stack right after undo was done`, async ({
    page,
  }) => {
    await focusEditor(page);
    // Freeze the history merge clock before typing so the whole burst coalesces
    // into a single undo entry deterministically. History merges consecutive
    // same-type keystrokes only while each lands within the 300ms merge window
    // (@lexical/history's default `delay`) of the previous one, measured against
    // the wall clock. With slowMo + WebKit under CI load an inter-keystroke gap
    // can exceed that window, splitting "hello" across multiple undo-stack
    // entries so the single undo() below reverts only the last fragment and the
    // editor is not empty when we assert (flaky on the mac-plain/webkit suite).
    // Freezing the clock removes the timing dimension: every keystroke observes
    // the same instant, so the burst always coalesces regardless of scheduling.
    await advanceHistoryClock(page);
    await page.keyboard.type('hello');
    // Barrier: ensure every keystroke has been applied before undoing so the
    // undo can't race ahead of input that WebKit is still settling.
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">hello</span>
        </p>
      `,
    );
    await undo(page);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await page.keyboard.type('hello');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">hello</span>
        </p>
      `,
    );
    await undo(page);
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  });
});
