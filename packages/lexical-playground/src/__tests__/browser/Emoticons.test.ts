/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {PlainTextExtension} from '@lexical/plain-text';
import {RichTextExtension} from '@lexical/rich-text';
import {defineExtension, IS_APPLE} from 'lexical';
import {describe, test} from 'vitest';
import {server, userEvent} from 'vitest/browser';

import {EmojiNode} from '../../nodes/EmojiNode';
import {EmojisExtension} from '../../plugins/EmojisExtension';
import {
  assertHTML,
  assertSelection,
  html,
  press,
  setupEditor,
  typeText,
} from './utils';

const browserName = server.browser;
const emojiExtension = defineExtension({
  dependencies: [EmojisExtension],
  name: '[emoticons-test]',
  nodes: () => [EmojiNode],
});
describe.each([true, false])('Emoticons (rich text: %s)', isRichText => {
  test(`Can enter multiple emoticons`, async () => {
    const {root} = setupEditor([
      isRichText ? RichTextExtension : PlainTextExtension,
      emojiExtension,
    ]);
    await typeText(':) :) <3 :(');
    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
          <span data-lexical-text="true"></span>
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
          <span data-lexical-text="true"></span>
          <span class="emoji heart" data-lexical-text="true">
            <span class="emoji-inner">❤</span>
          </span>
          <span data-lexical-text="true"></span>
          <span class="emoji unhappysmile" data-lexical-text="true">
            <span class="emoji-inner">🙁</span>
          </span>
        </p>
      `,
    );
    await assertSelection(root, {
      anchorOffset: 2,
      anchorPath: [0, 6, 0, 0],
      focusOffset: 2,
      focusPath: [0, 6, 0, 0],
    });

    await userEvent.keyboard('{' + 'Shift' + '>}');
    await press('Enter');
    await userEvent.keyboard('{/' + 'Shift' + '}');
    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
          <span data-lexical-text="true"></span>
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
          <span data-lexical-text="true"></span>
          <span class="emoji heart" data-lexical-text="true">
            <span class="emoji-inner">❤</span>
          </span>
          <span data-lexical-text="true"></span>
          <span class="emoji unhappysmile" data-lexical-text="true">
            <span class="emoji-inner">🙁</span>
          </span>
          <br />
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
    await assertSelection(root, {
      anchorOffset: 8,
      anchorPath: [0],
      focusOffset: 8,
      focusPath: [0],
    });

    await typeText(':) :) <3 :(');
    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
          <span data-lexical-text="true"></span>
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
          <span data-lexical-text="true"></span>
          <span class="emoji heart" data-lexical-text="true">
            <span class="emoji-inner">❤</span>
          </span>
          <span data-lexical-text="true"></span>
          <span class="emoji unhappysmile" data-lexical-text="true">
            <span class="emoji-inner">🙁</span>
          </span>
          <br />
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
          <span data-lexical-text="true"></span>
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
          <span data-lexical-text="true"></span>
          <span class="emoji heart" data-lexical-text="true">
            <span class="emoji-inner">❤</span>
          </span>
          <span data-lexical-text="true"></span>
          <span class="emoji unhappysmile" data-lexical-text="true">
            <span class="emoji-inner">🙁</span>
          </span>
        </p>
      `,
    );
    await assertSelection(root, {
      anchorOffset: 2,
      anchorPath: [0, 14, 0, 0],
      focusOffset: 2,
      focusPath: [0, 14, 0, 0],
    });

    await press('Enter');
    if (isRichText) {
      await assertHTML(
        root,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji heart" data-lexical-text="true">
              <span class="emoji-inner">❤</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji unhappysmile" data-lexical-text="true">
              <span class="emoji-inner">🙁</span>
            </span>
            <br />
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji heart" data-lexical-text="true">
              <span class="emoji-inner">❤</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji unhappysmile" data-lexical-text="true">
              <span class="emoji-inner">🙁</span>
            </span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(root, {
        anchorOffset: 0,
        anchorPath: [1],
        focusOffset: 0,
        focusPath: [1],
      });
    } else {
      await assertHTML(
        root,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji heart" data-lexical-text="true">
              <span class="emoji-inner">❤</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji unhappysmile" data-lexical-text="true">
              <span class="emoji-inner">🙁</span>
            </span>
            <br />
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji heart" data-lexical-text="true">
              <span class="emoji-inner">❤</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji unhappysmile" data-lexical-text="true">
              <span class="emoji-inner">🙁</span>
            </span>
            <br />
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(root, {
        anchorOffset: 16,
        anchorPath: [0],
        focusOffset: 16,
        focusPath: [0],
      });
    }

    await typeText(':) :) <3 :(');
    if (isRichText) {
      await assertHTML(
        root,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji heart" data-lexical-text="true">
              <span class="emoji-inner">❤</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji unhappysmile" data-lexical-text="true">
              <span class="emoji-inner">🙁</span>
            </span>
            <br />
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji heart" data-lexical-text="true">
              <span class="emoji-inner">❤</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji unhappysmile" data-lexical-text="true">
              <span class="emoji-inner">🙁</span>
            </span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji heart" data-lexical-text="true">
              <span class="emoji-inner">❤</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji unhappysmile" data-lexical-text="true">
              <span class="emoji-inner">🙁</span>
            </span>
          </p>
        `,
      );
      await assertSelection(root, {
        anchorOffset: 2,
        anchorPath: [1, 6, 0, 0],
        focusOffset: 2,
        focusPath: [1, 6, 0, 0],
      });
    } else {
      await assertHTML(
        root,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji heart" data-lexical-text="true">
              <span class="emoji-inner">❤</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji unhappysmile" data-lexical-text="true">
              <span class="emoji-inner">🙁</span>
            </span>
            <br />
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji heart" data-lexical-text="true">
              <span class="emoji-inner">❤</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji unhappysmile" data-lexical-text="true">
              <span class="emoji-inner">🙁</span>
            </span>
            <br />
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji happysmile" data-lexical-text="true">
              <span class="emoji-inner">🙂</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji heart" data-lexical-text="true">
              <span class="emoji-inner">❤</span>
            </span>
            <span data-lexical-text="true"></span>
            <span class="emoji unhappysmile" data-lexical-text="true">
              <span class="emoji-inner">🙁</span>
            </span>
          </p>
        `,
      );
      await assertSelection(root, {
        anchorOffset: 2,
        anchorPath: [0, 22, 0, 0],
        focusOffset: 2,
        focusPath: [0, 22, 0, 0],
      });
    }

    await press(IS_APPLE ? 'Meta+ArrowLeft' : 'Home');
    // This should not crash on a deletion on a token node
    await press('Backspace');
    await press(IS_APPLE ? 'Meta+ArrowRight' : 'End');

    await press('Backspace', 22);
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

    await typeText(':):):):):)');
    await press('ArrowLeft');
    if (browserName === 'firefox') {
      await assertSelection(root, {
        anchorOffset: 0,
        anchorPath: [0, 4, 0, 0],
        focusOffset: 0,
        focusPath: [0, 4, 0, 0],
      });
    } else {
      await assertSelection(root, {
        anchorOffset: 2,
        anchorPath: [0, 3, 0, 0],
        focusOffset: 2,
        focusPath: [0, 3, 0, 0],
      });
    }

    await press('ArrowLeft');
    if (browserName === 'firefox') {
      await assertSelection(root, {
        anchorOffset: 0,
        anchorPath: [0, 3, 0, 0],
        focusOffset: 0,
        focusPath: [0, 3, 0, 0],
      });
    } else {
      await assertSelection(root, {
        anchorOffset: 2,
        anchorPath: [0, 2, 0, 0],
        focusOffset: 2,
        focusPath: [0, 2, 0, 0],
      });
    }

    await press('ArrowLeft');
    if (browserName === 'firefox') {
      await assertSelection(root, {
        anchorOffset: 0,
        anchorPath: [0, 2, 0, 0],
        focusOffset: 0,
        focusPath: [0, 2, 0, 0],
      });
    } else {
      await assertSelection(root, {
        anchorOffset: 2,
        anchorPath: [0, 1, 0, 0],
        focusOffset: 2,
        focusPath: [0, 1, 0, 0],
      });
    }

    await press('ArrowLeft');
    if (browserName === 'firefox') {
      await assertSelection(root, {
        anchorOffset: 0,
        anchorPath: [0, 1, 0, 0],
        focusOffset: 0,
        focusPath: [0, 1, 0, 0],
      });
    } else {
      await assertSelection(root, {
        anchorOffset: 2,
        anchorPath: [0, 0, 0, 0],
        focusOffset: 2,
        focusPath: [0, 0, 0, 0],
      });
    }

    await press('ArrowLeft');
    await assertSelection(root, {
      anchorOffset: 0,
      anchorPath: [0, 0, 0, 0],
      focusOffset: 0,
      focusPath: [0, 0, 0, 0],
    });

    await typeText('Hey');
    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hey</span>
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
          <span class="emoji happysmile" data-lexical-text="true">
            <span class="emoji-inner">🙂</span>
          </span>
        </p>
      `,
    );
    await assertSelection(root, {
      anchorOffset: 3,
      anchorPath: [0, 0, 0],
      focusOffset: 3,
      focusPath: [0, 0, 0],
    });
  });
  test(`Can handle single emoticon replaced with text`, async () => {
    const {root} = setupEditor([
      isRichText ? RichTextExtension : PlainTextExtension,
      emojiExtension,
    ]);
    await typeText(':)');
    await userEvent.keyboard('{' + 'Shift' + '>}');
    await press('ArrowLeft');
    await userEvent.keyboard('{/' + 'Shift' + '}');
    await typeText('a');
    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">a</span>
        </p>
      `,
    );
    await assertSelection(root, {
      anchorOffset: 1,
      anchorPath: [0, 0, 0],
      focusOffset: 1,
      focusPath: [0, 0, 0],
    });
    await press('Backspace');
    await typeText(':) foo');
    await press('Shift+ArrowLeft', 5);
    await typeText('a');
    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">a</span>
        </p>
      `,
    );
    await assertSelection(root, {
      anchorOffset: 1,
      anchorPath: [0, 0, 0],
      focusOffset: 1,
      focusPath: [0, 0, 0],
    });
  });
});
