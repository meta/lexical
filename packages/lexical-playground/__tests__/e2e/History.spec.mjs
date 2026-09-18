/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveLeft,
  pressBackspace,
  redo,
  toggleBold,
  undo,
} from '../keyboardShortcuts/index.mjs';
import {
  advanceHistoryClock,
  assertHTML,
  assertSelection,
  enableCompositionKeyEvents,
  focusEditor,
  html,
  initialize,
  test,
} from '../utils/index.mjs';

test.describe('History', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test(`Can type two paragraphs of text and correctly undo and redo`, async ({
    isRichText,
    page,
    isCollab,
  }) => {
    test.skip(isCollab);
    await page.focus('div[contenteditable="true"]');
    // Freeze the history merge clock before the first burst so "hello" coalesces
    // into a single undo entry deterministically. Each advanceHistoryClock call
    // only makes the bursts *after* it deterministic; without this leading call
    // the initial "hello" is typed against the real 300ms merge window, and
    // under WebKit/CI load a slow inter-keystroke gap can split it across undo
    // entries and desync every undo/redo assertion below (flaky on webkit).
    await advanceHistoryClock(page);
    await page.keyboard.type('hello');
    await advanceHistoryClock(page);
    await page.keyboard.type(' world');
    await page.keyboard.press('Enter');
    await page.keyboard.type('hello world again');
    await moveLeft(page, 6);
    await page.keyboard.type(', again and');

    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world, again and again</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 22,
        anchorPath: [1, 0, 0],
        focusOffset: 22,
        focusPath: [1, 0, 0],
      });
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
            <br />
            <span data-lexical-text="true">hello world, again and again</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 22,
        anchorPath: [0, 2, 0],
        focusOffset: 22,
        focusPath: [0, 2, 0],
      });
    }

    await undo(page);

    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world again</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 11,
        anchorPath: [1, 0, 0],
        focusOffset: 11,
        focusPath: [1, 0, 0],
      });
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
            <br />
            <span data-lexical-text="true">hello world again</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 11,
        anchorPath: [0, 2, 0],
        focusOffset: 11,
        focusPath: [0, 2, 0],
      });
    }

    await undo(page);

    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
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
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
            <br />
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 2,
        anchorPath: [0],
        focusOffset: 2,
        focusPath: [0],
      });
    }

    await undo(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">hello world</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 11,
      anchorPath: [0, 0, 0],
      focusOffset: 11,
      focusPath: [0, 0, 0],
    });

    await undo(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">hello</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 5,
      anchorPath: [0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0],
    });

    await undo(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0],
      focusOffset: 0,
      focusPath: [0],
    });

    await redo(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">hello</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 5,
      anchorPath: [0, 0, 0],
      focusOffset: 5,
      focusPath: [0, 0, 0],
    });

    await redo(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">hello world</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 11,
      anchorPath: [0, 0, 0],
      focusOffset: 11,
      focusPath: [0, 0, 0],
    });

    await redo(page);

    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
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
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
            <br />
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 2,
        anchorPath: [0],
        focusOffset: 2,
        focusPath: [0],
      });
    }

    await redo(page);

    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world again</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 11,
        anchorPath: [1, 0, 0],
        focusOffset: 11,
        focusPath: [1, 0, 0],
      });
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
            <br />
            <span data-lexical-text="true">hello world again</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 11,
        anchorPath: [0, 2, 0],
        focusOffset: 11,
        focusPath: [0, 2, 0],
      });
    }

    await redo(page);

    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world, again and again</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 22,
        anchorPath: [1, 0, 0],
        focusOffset: 22,
        focusPath: [1, 0, 0],
      });
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
            <br />
            <span data-lexical-text="true">hello world, again and again</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 22,
        anchorPath: [0, 2, 0],
        focusOffset: 22,
        focusPath: [0, 2, 0],
      });
    }

    await pressBackspace(page, 4);

    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world, again again</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 18,
        anchorPath: [1, 0, 0],
        focusOffset: 18,
        focusPath: [1, 0, 0],
      });
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
            <br />
            <span data-lexical-text="true">hello world, again again</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 18,
        anchorPath: [0, 2, 0],
        focusOffset: 18,
        focusPath: [0, 2, 0],
      });
    }

    await undo(page);

    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world, again and again</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 22,
        anchorPath: [1, 0, 0],
        focusOffset: 22,
        focusPath: [1, 0, 0],
      });
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">hello world</span>
            <br />
            <span data-lexical-text="true">hello world, again and again</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 22,
        anchorPath: [0, 2, 0],
        focusOffset: 22,
        focusPath: [0, 2, 0],
      });
    }
  });

  test('Can coalesce when switching inline styles (#1151)', async ({
    page,
    isCollab,
    isPlainText,
  }) => {
    test.skip(isCollab || isPlainText);

    await focusEditor(page);
    // Freeze the history merge clock: without it each burst is typed against
    // the real 300ms merge window, and under WebKit/CI load a slow
    // inter-keystroke gap splits one burst across two undo entries, so the
    // first undo leaves part of the run behind ("bar" -> "b") and every
    // assertion below desyncs. Frozen, the only boundaries are the style
    // switches, which is what this test is about.
    await advanceHistoryClock(page);
    await toggleBold(page);
    await page.keyboard.type('foo');
    await toggleBold(page);
    await page.keyboard.type('bar');
    await toggleBold(page);
    await page.keyboard.type('baz');

    const step1HTML = html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <strong
          class="PlaygroundEditorTheme__textBold"
          data-lexical-text="true">
          foo
        </strong>
        <span data-lexical-text="true">bar</span>
        <strong
          class="PlaygroundEditorTheme__textBold"
          data-lexical-text="true">
          baz
        </strong>
      </p>
    `;
    const step2HTML = html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <strong
          class="PlaygroundEditorTheme__textBold"
          data-lexical-text="true">
          foo
        </strong>
        <span data-lexical-text="true">bar</span>
      </p>
    `;
    const step3HTML = html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <strong
          class="PlaygroundEditorTheme__textBold"
          data-lexical-text="true">
          foo
        </strong>
      </p>
    `;
    const step4HTML = html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <br data-lexical-managed-linebreak="true" />
      </p>
    `;

    await assertHTML(page, step1HTML);
    await undo(page);
    await assertHTML(page, step2HTML);
    await undo(page);
    await assertHTML(page, step3HTML);
    await undo(page);
    await assertHTML(page, step4HTML);
    await redo(page);
    await assertHTML(page, step3HTML);
    await redo(page);
    await assertHTML(page, step2HTML);
    await redo(page);
    await assertHTML(page, step1HTML);
  });
});

/* eslint-disable sort-keys-fix/sort-keys-fix */
test.describe('History - IME', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test('Can undo composed Hirigana via IME after composition ends (#2479)', async ({
    page,
    browserName,
    isCollab,
    isPlainText,
  }) => {
    // We don't yet support FF.
    test.skip(isCollab || isPlainText || browserName !== 'chromium');

    await focusEditor(page);
    await enableCompositionKeyEvents(page);

    const client = await page.context().newCDPSession(page);
    // await page.keyboard.imeSetComposition('ｓ', 1, 1);
    await client.send('Input.imeSetComposition', {
      selectionStart: 1,
      selectionEnd: 1,
      text: 'ｓ',
    });
    // await page.keyboard.imeSetComposition('す', 1, 1);
    await client.send('Input.imeSetComposition', {
      selectionStart: 1,
      selectionEnd: 1,
      text: 'す',
    });
    // await page.keyboard.imeSetComposition('すｓ', 2, 2);
    await client.send('Input.imeSetComposition', {
      selectionStart: 2,
      selectionEnd: 2,
      text: 'すｓ',
    });
    // await page.keyboard.imeSetComposition('すｓｈ', 3, 3);
    await client.send('Input.imeSetComposition', {
      selectionStart: 3,
      selectionEnd: 3,
      text: 'すｓｈ',
    });
    // await page.keyboard.imeSetComposition('すし', 2, 2);
    await client.send('Input.imeSetComposition', {
      selectionStart: 2,
      selectionEnd: 2,
      text: 'すし',
    });
    // await page.keyboard.insertText('すし');
    await client.send('Input.insertText', {
      text: 'すし',
    });

    await advanceHistoryClock(page);

    await page.keyboard.type(' ');

    await advanceHistoryClock(page);

    // await page.keyboard.imeSetComposition('m', 1, 1);
    await client.send('Input.imeSetComposition', {
      selectionStart: 1,
      selectionEnd: 1,
      text: 'm',
    });
    // await page.keyboard.imeSetComposition('も', 1, 1);
    await client.send('Input.imeSetComposition', {
      selectionStart: 1,
      selectionEnd: 1,
      text: 'も',
    });
    // await page.keyboard.imeSetComposition('もj', 2, 2);
    await client.send('Input.imeSetComposition', {
      selectionStart: 2,
      selectionEnd: 2,
      text: 'もj',
    });

    await advanceHistoryClock(page);

    // await page.keyboard.imeSetComposition('もじ', 2, 2);
    await client.send('Input.imeSetComposition', {
      selectionStart: 2,
      selectionEnd: 2,
      text: 'もじ',
    });
    // await page.keyboard.imeSetComposition('もじあ', 3, 3);
    await client.send('Input.imeSetComposition', {
      selectionStart: 3,
      selectionEnd: 3,
      text: 'もじあ',
    });
    // await page.keyboard.insertText('もじあ');
    await client.send('Input.insertText', {
      text: 'もじあ',
    });

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">すし もじあ</span>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 6,
      anchorPath: [0, 0, 0],
      focusOffset: 6,
      focusPath: [0, 0, 0],
    });

    await undo(page);

    const WHITESPACE_TOKEN = ' ';

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">すし${WHITESPACE_TOKEN}</span>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 3,
      anchorPath: [0, 0, 0],
      focusOffset: 3,
      focusPath: [0, 0, 0],
    });

    await undo(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">すし</span>
        </p>
      `,
    );

    if (browserName === 'webkit') {
      await assertSelection(page, {
        anchorOffset: 3,
        anchorPath: [0, 0, 0],
        focusOffset: 3,
        focusPath: [0, 0, 0],
      });
    } else {
      await assertSelection(page, {
        anchorOffset: 2,
        anchorPath: [0, 0, 0],
        focusOffset: 2,
        focusPath: [0, 0, 0],
      });
    }

    await undo(page);

    if (browserName === 'webkit') {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">すし</span>
          </p>
        `,
      );
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
    }

    if (browserName === 'webkit') {
      await assertSelection(page, {
        anchorOffset: 2,
        anchorPath: [0, 0, 0],
        focusOffset: 2,
        focusPath: [0, 0, 0],
      });
    } else {
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0],
        focusOffset: 0,
        focusPath: [0],
      });
    }

    await redo(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">すし</span>
        </p>
      `,
    );

    if (browserName === 'webkit') {
      await assertSelection(page, {
        anchorOffset: 3,
        anchorPath: [0, 0, 0],
        focusOffset: 3,
        focusPath: [0, 0, 0],
      });
    } else {
      await assertSelection(page, {
        anchorOffset: 2,
        anchorPath: [0, 0, 0],
        focusOffset: 2,
        focusPath: [0, 0, 0],
      });
    }
  });

  test('Cancel composition not push undo stack', async ({
    page,
    browserName,
    isCollab,
    isPlainText,
  }) => {
    // We don't yet support FF.
    test.skip(isCollab || isPlainText || browserName !== 'chromium');

    await focusEditor(page);
    await enableCompositionKeyEvents(page);

    const client = await page.context().newCDPSession(page);

    await client.send('Input.insertText', {
      text: 'a',
    });

    await advanceHistoryClock(page);

    await client.send('Input.imeSetComposition', {
      selectionStart: 1,
      selectionEnd: 1,
      text: 'ｓ',
    });
    await client.send('Input.imeSetComposition', {
      selectionStart: 1,
      selectionEnd: 1,
      text: '',
    });
    // Escape would fire here
    await page.keyboard.insertText('');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">a</span>
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

  test('Merge IME input when less delay', async ({
    page,
    browserName,
    isCollab,
    isPlainText,
  }) => {
    // We don't yet support FF.
    test.skip(isCollab || isPlainText || browserName !== 'chromium');

    await focusEditor(page);
    await enableCompositionKeyEvents(page);

    const client = await page.context().newCDPSession(page);

    await client.send('Input.insertText', {
      text: 'a',
    });

    await client.send('Input.imeSetComposition', {
      selectionStart: 1,
      selectionEnd: 1,
      text: 'ｓ',
    });
    // await page.keyboard.imeSetComposition('す', 1, 1);
    await client.send('Input.imeSetComposition', {
      selectionStart: 1,
      selectionEnd: 1,
      text: 'す',
    });

    await client.send('Input.insertText', {
      selectionStart: 1,
      selectionEnd: 1,
      text: 'す',
    });

    await undo(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await client.send('Input.insertText', {
      text: 'a',
    });

    await advanceHistoryClock(page);

    await client.send('Input.imeSetComposition', {
      selectionStart: 2,
      selectionEnd: 2,
      text: 'ｓ',
    });

    await client.send('Input.imeSetComposition', {
      selectionStart: 2,
      selectionEnd: 2,
      text: 'す',
    });

    await client.send('Input.insertText', {
      selectionStart: 2,
      selectionEnd: 2,
      text: 'す',
    });

    await client.send('Input.imeSetComposition', {
      selectionStart: 2,
      selectionEnd: 2,
      text: 'ｓ',
    });

    await client.send('Input.imeSetComposition', {
      selectionStart: 2,
      selectionEnd: 2,
      text: 'す',
    });

    await client.send('Input.insertText', {
      selectionStart: 2,
      selectionEnd: 2,
      text: 'す',
    });

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">aすす</span>
        </p>
      `,
    );

    await undo(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">a</span>
        </p>
      `,
    );
  });

  test('RangeSelection should be retained when undo IME', async ({
    page,
    browserName,
    isCollab,
    isPlainText,
  }) => {
    // We don't yet support FF.
    test.skip(isCollab || isPlainText || browserName !== 'chromium');

    await focusEditor(page);
    await enableCompositionKeyEvents(page);

    const client = await page.context().newCDPSession(page);

    await client.send('Input.insertText', {
      text: 'ab',
    });
    await advanceHistoryClock(page);

    await page.keyboard.down('Shift');
    await moveLeft(page, 1);
    await page.keyboard.up('Shift');

    await client.send('Input.imeSetComposition', {
      selectionStart: 1,
      selectionEnd: 1,
      text: 'ｓ',
    });
    // await page.keyboard.imeSetComposition('す', 1, 1);
    await client.send('Input.imeSetComposition', {
      selectionStart: 1,
      selectionEnd: 1,
      text: 'す',
    });

    await client.send('Input.insertText', {
      selectionStart: 1,
      selectionEnd: 1,
      text: 'す',
    });

    await undo(page);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">ab</span>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 2,
      anchorPath: [0, 0, 0],
      focusOffset: 1,
      focusPath: [0, 0, 0],
    });
  });
});
/* eslint-enable sort-keys-fix/sort-keys-fix */
