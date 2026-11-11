/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {registerMarkdownShortcuts} from '@lexical/markdown';
import {MarkdownTestExtension} from '@lexical/markdown/src/__tests__/utils';
import {
  defineExtension,
  INDENT_CONTENT_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {test} from 'vitest';

import {ShortcutsExtension} from '../../plugins/ShortcutsExtension';
import {assertHTML, html, press, setupEditor, typeText} from './utils';

const extension = defineExtension({
  dependencies: [MarkdownTestExtension, ShortcutsExtension],
  name: '[list-keyboard-browser]',
  register: editor => registerMarkdownShortcuts(editor),
});
async function indent(editor: LexicalEditor, count: number) {
  for (let i = 0; i < count; i++) {
    editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);
    editor.read(() => {});
  }
}
test('Should outdent if indented when the backspace key is pressed', async () => {
  const {editor, root} = setupEditor([extension]);
  await press('ControlOrMeta+Shift+8');

  await typeText('Hello');
  await press('Enter');

  await indent(editor, 3);

  await assertHTML(
    root,
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

  await press('Backspace');

  await assertHTML(
    root,
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

  await press('Backspace');

  await assertHTML(
    root,
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
test(`Should not process paragraph markdown inside list.`, async () => {
  const {root} = setupEditor([extension]);

  await press('ControlOrMeta+Shift+8');
  await typeText('# ');
  await assertHTML(
    root,
    html`
      <ul class="PlaygroundEditorTheme__ul" dir="auto">
        <li class="PlaygroundEditorTheme__listItem" value="1">
          <span data-lexical-text="true">#</span>
        </li>
      </ul>
    `,
  );
});
test(`Un-indents list empty list items when the user presses enter`, async () => {
  const {editor, root} = setupEditor([extension]);
  await press('ControlOrMeta+Shift+8');
  await typeText('a');
  await press('Enter');
  await indent(editor, 1);
  await indent(editor, 1);
  await press('Enter');
  await assertHTML(
    root,
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
  await press('Enter');
  await assertHTML(
    root,
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
  await press('Enter');
  await assertHTML(
    root,
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
