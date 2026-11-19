/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {HashtagExtension} from '@lexical/hashtag';
import {PlainTextExtension} from '@lexical/plain-text';
import {RichTextExtension} from '@lexical/rich-text';
import {IS_APPLE} from 'lexical';
import {describe, test} from 'vitest';
import {server} from 'vitest/browser';

import {
  assertHTML,
  assertSelection,
  html,
  press,
  setupEditor,
  typeText,
} from './utils';

const browserName = server.browser;

async function repeat(count: number, callback: () => Promise<void>) {
  for (let i = 0; i < count; i++) await callback();
}
async function moveToEditorBeginning() {
  await press(IS_APPLE ? 'Meta+ArrowUp' : 'PageUp');
  if (!IS_APPLE && browserName === 'firefox') await press('Home');
}

describe.each([true, false])('Hashtags (rich text: %s)', isRichText => {
  test(`Can handle adjacent hashtags`, async () => {
    const {root} = setupEditor([
      isRichText ? RichTextExtension : PlainTextExtension,
      HashtagExtension,
    ]);
    await typeText('#hello world');

    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #hello
          </span>
          <span data-lexical-text="true">world</span>
        </p>
      `,
    );
    await assertSelection(root, {
      anchorOffset: 6,
      anchorPath: [0, 1, 0],
      focusOffset: 6,
      focusPath: [0, 1, 0],
    });

    await press('ArrowLeft', 5);
    await assertSelection(root, {
      anchorOffset: 1,
      anchorPath: [0, 1, 0],
      focusOffset: 1,
      focusPath: [0, 1, 0],
    });

    await press('Backspace');
    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #helloworld
          </span>
        </p>
      `,
    );
    await assertSelection(root, {
      anchorOffset: 6,
      anchorPath: [0, 0, 0],
      focusOffset: 6,
      focusPath: [0, 0, 0],
    });

    await press('Space');
    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #hello
          </span>
          <span data-lexical-text="true">world</span>
        </p>
      `,
    );
    await assertSelection(root, {
      anchorOffset: 1,
      anchorPath: [0, 1, 0],
      focusOffset: 1,
      focusPath: [0, 1, 0],
    });

    await press('ArrowLeft');
    if (browserName === 'firefox') {
      await assertSelection(root, {
        anchorOffset: 0,
        anchorPath: [0, 1, 0],
        focusOffset: 0,
        focusPath: [0, 1, 0],
      });
    } else {
      await assertSelection(root, {
        anchorOffset: 6,
        anchorPath: [0, 0, 0],
        focusOffset: 6,
        focusPath: [0, 0, 0],
      });
    }

    await press('Delete');
    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #helloworld
          </span>
        </p>
      `,
    );
    await assertSelection(root, {
      anchorOffset: 6,
      anchorPath: [0, 0, 0],
      focusOffset: 6,
      focusPath: [0, 0, 0],
    });
  });
  test(`Can insert many hashtags mixed with text and delete them all correctly`, async () => {
    const {root} = setupEditor([
      isRichText ? RichTextExtension : PlainTextExtension,
      HashtagExtension,
    ]);
    await typeText(
      '#hello world foo #lol #lol asdasd #lol test this #asdas #asdas lasdasd asdasd',
    );

    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #hello
          </span>
          <span data-lexical-text="true">world foo</span>
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #lol
          </span>
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #lol
          </span>
          <span data-lexical-text="true">asdasd</span>
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #lol
          </span>
          <span data-lexical-text="true">test this</span>
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #asdas
          </span>
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #asdas
          </span>
          <span data-lexical-text="true">lasdasd asdasd</span>
        </p>
      `,
    );
    await assertSelection(root, {
      anchorOffset: 15,
      anchorPath: [0, 11, 0],
      focusOffset: 15,
      focusPath: [0, 11, 0],
    });

    await moveToEditorBeginning();

    await assertSelection(root, {
      anchorOffset: 0,
      anchorPath: [0, 0, 0],
      focusOffset: 0,
      focusPath: [0, 0, 0],
    });

    await repeat(20, async () => {
      await press(IS_APPLE ? 'Alt+Delete' : 'Control+Delete');
    });
    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await assertSelection(root, {
      anchorOffset: 0,
      anchorPath: [0],
      focusOffset: 0,
      focusPath: [0],
    });
  });
  test.runIf(isRichText)('Hashtag inherits format', async () => {
    const {root} = setupEditor([
      isRichText ? RichTextExtension : PlainTextExtension,
      HashtagExtension,
    ]);
    await typeText('Hello ');
    await press('ControlOrMeta+b');
    await typeText('#world');
    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
          <strong
            class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__hashtag"
            data-lexical-text="true">
            #world
          </strong>
        </p>
      `,
    );
  });
  test('Should not break with multiple leading "#" #5636', async () => {
    const {root} = setupEditor([
      isRichText ? RichTextExtension : PlainTextExtension,
      HashtagExtension,
    ]);
    await typeText('#hello');

    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #hello
          </span>
        </p>
      `,
    );
    await assertSelection(root, {
      anchorOffset: 6,
      anchorPath: [0, 0, 0],
      focusOffset: 6,
      focusPath: [0, 0, 0],
    });

    await moveToEditorBeginning();
    await typeText('#');

    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">#</span>
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #hello
          </span>
        </p>
      `,
    );
  });
  test('Should not break while skipping invalid hashtags #5703', async () => {
    const {root} = setupEditor([
      isRichText ? RichTextExtension : PlainTextExtension,
      HashtagExtension,
    ]);
    await typeText('#hello');

    await press('Space');

    await typeText('#world');
    await typeText('#invalid');

    await press('Space');
    await typeText('#next');

    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #hello
          </span>
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #world
          </span>
          <span data-lexical-text="true">#invalid</span>
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #next
          </span>
        </p>
      `,
    );
  });
  test('Can handle hashtags following multiple invalid hashtags', async () => {
    const {root} = setupEditor([
      isRichText ? RichTextExtension : PlainTextExtension,
      HashtagExtension,
    ]);
    await typeText('#hello');

    await press('Space');

    await typeText('#world');
    await typeText('#invalid');
    await typeText('#invalid');
    await typeText('#invalid');

    await press('Space');

    await typeText('#valid');

    await press('Space');

    await typeText('#valid');
    await typeText('#invalid');

    await press('Space');
    await typeText('#valid');

    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #hello
          </span>
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #world
          </span>
          <span data-lexical-text="true">#invalid#invalid#invalid</span>
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #valid
          </span>
          <span data-lexical-text="true"></span>
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #valid
          </span>
          <span data-lexical-text="true">#invalid</span>
          <span class="PlaygroundEditorTheme__hashtag" data-lexical-text="true">
            #valid
          </span>
        </p>
      `,
    );
  });
});
