/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {OverflowNode} from '@lexical/overflow';
import {PlainTextExtension} from '@lexical/plain-text';
import {CharacterLimitPlugin} from '@lexical/react/LexicalCharacterLimitPlugin';
import {
  mountReactPluginComponent,
  mountReactPluginHost,
  ReactPluginHostExtension,
} from '@lexical/react/ReactPluginHostExtension';
import {RichTextExtension} from '@lexical/rich-text';
import {$createParagraphNode, $getRoot, defineExtension} from 'lexical';
import {act} from 'react';
import {describe, onTestFinished, test} from 'vitest';

import theme from '../../themes/PlaygroundEditorTheme';
import {
  assertCaret,
  assertHTML,
  html,
  press as nativePress,
  typeText as nativeTypeText,
} from './utils';

const press = (key: string, count = 1) => act(() => nativePress(key, count));
const typeText = (text: string) => act(() => nativeTypeText(text));
async function repeat(count: number, callback: () => Promise<void>) {
  for (let i = 0; i < count; i++) await callback();
}

async function setup(charset: 'UTF-8' | 'UTF-16', isRichText: boolean) {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  root.style.whiteSpace = 'pre-wrap';
  const plugins = document.createElement('div');
  document.body.append(root, plugins);
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        isRichText ? RichTextExtension : PlainTextExtension,
        ReactPluginHostExtension,
      ],
      name: '[character-limit-browser]',
      nodes: () => [OverflowNode],
      theme,
    }),
  );
  onTestFinished(async () => {
    await act(async () => editor.dispose());
    root.remove();
    plugins.remove();
    window.getSelection()?.removeAllRanges();
  });
  await act(async () => {
    mountReactPluginHost(editor, plugins);
    mountReactPluginComponent(editor, {
      Component: CharacterLimitPlugin,
      key: 'character-limit',
      props: {charset, maxLength: 5},
    });
    editor.setRootElement(root);
    editor.update(
      () => {
        $getRoot().clear().append($createParagraphNode());
        $getRoot().selectEnd();
      },
      {discrete: true},
    );
  });
  window.focus();
  root.focus();
  return {editor, root};
}

describe.each(['UTF-8', 'UTF-16'] as const)('character limit %s', charset => {
  describe.each([true, false])('rich text: %s', isRichText => {
    test('can type new lines inside overflow', async () => {
      const {root} = await setup(charset, isRichText);

      await typeText('123456');
      await press('Enter');
      await typeText('7');
      if (isRichText) {
        await assertHTML(
          root,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">12345</span>
              <span class="PlaygroundEditorTheme__characterLimit">
                <span data-lexical-text="true">6</span>
              </span>
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span class="PlaygroundEditorTheme__characterLimit">
                <span data-lexical-text="true">7</span>
              </span>
            </p>
          `,
        );
      } else {
        await assertHTML(
          root,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">12345</span>
              <span class="PlaygroundEditorTheme__characterLimit">
                <span data-lexical-text="true">6</span>
                <br />
                <span data-lexical-text="true">7</span>
              </span>
            </p>
          `,
        );
      }

      await press('Backspace', 3);
      await assertHTML(
        root,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">12345</span>
          </p>
        `,
      );
    });
    test('can delete text in front and overflow is recomputed', async () => {
      const {editor, root} = await setup(charset, isRichText);

      await typeText('123456');
      await press('Enter');
      await press('7');
      await act(async () => {
        editor.update(() => $getRoot().selectStart(), {discrete: true});
      });

      await assertCaret(editor, 'p:first-child > span:first-child', 0);
      await press('Delete');
      if (isRichText) {
        await assertHTML(
          root,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">23456</span>
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span class="PlaygroundEditorTheme__characterLimit">
                <span data-lexical-text="true">7</span>
              </span>
            </p>
          `,
        );
      } else {
        await assertHTML(
          root,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">23456</span>
              <span class="PlaygroundEditorTheme__characterLimit">
                <br />
                <span data-lexical-text="true">7</span>
              </span>
            </p>
          `,
        );
      }

      await assertCaret(editor, 'p:first-child > span:first-child', 0);
      await press('Delete');
      if (isRichText) {
        await assertHTML(
          root,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">3456</span>
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span class="PlaygroundEditorTheme__characterLimit">
                <span data-lexical-text="true">7</span>
              </span>
            </p>
          `,
        );
      } else {
        await assertHTML(
          root,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">3456</span>
              <br />
              <span class="PlaygroundEditorTheme__characterLimit">
                <span data-lexical-text="true">7</span>
              </span>
            </p>
          `,
        );
      }
    });
    test('handles accented characters', async () => {
      const {root} = await setup(charset, isRichText);

      // Worth 1 byte in UTF-16, 2 bytes in UTF-8
      await repeat(6, async () => await typeText('à'));
      if (charset === 'UTF-16') {
        await assertHTML(
          root,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">ààààà</span>
              <span class="PlaygroundEditorTheme__characterLimit">
                <span data-lexical-text="true">à</span>
              </span>
            </p>
          `,
        );
      } else {
        await assertHTML(
          root,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">àà</span>
              <span class="PlaygroundEditorTheme__characterLimit">
                <span data-lexical-text="true">àààà</span>
              </span>
            </p>
          `,
        );
      }
    });
    test('handles graphemes', async () => {
      const {root} = await setup(charset, isRichText);

      await typeText('👨‍👩‍👦‍👦');
      await assertHTML(
        root,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span class="PlaygroundEditorTheme__characterLimit">
              <span data-lexical-text="true">👨‍👩‍👦‍👦</span>
            </span>
          </p>
        `,
      );
    });
  });
});
