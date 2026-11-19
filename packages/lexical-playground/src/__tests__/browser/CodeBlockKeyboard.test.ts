/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode} from '@lexical/code-core';
import {TabIndentationExtension} from '@lexical/extension';
import {registerMarkdownShortcuts} from '@lexical/markdown';
import {MarkdownTestExtension} from '@lexical/markdown/src/__tests__/utils';
import {$setBlocksType} from '@lexical/selection';
import {
  $getSelection,
  configExtension,
  defineExtension,
  INDENT_CONTENT_COMMAND,
  IS_APPLE,
} from 'lexical';
import {test} from 'vitest';
import {userEvent} from 'vitest/browser';

import {CodeHighlightExtension} from '../../plugins/CodeHighlightExtension';
import {
  assertCaret,
  assertHTML,
  assertSelection,
  html,
  press,
  setupEditor,
  typeText,
} from './utils';

const extension = defineExtension({
  dependencies: [
    MarkdownTestExtension,
    configExtension(CodeHighlightExtension, {mode: 'prism'}),
    TabIndentationExtension,
  ],
  name: '[code-keyboard-test]',
  register: editor => registerMarkdownShortcuts(editor),
});
test('Can indent text via tab when selecting the line with Shift+Down', async () => {
  const {root} = setupEditor([extension]);
  await typeText('``` alert(1);');
  await press('Enter');
  await press('Enter');
  await typeText('alert(2);');
  await press(IS_APPLE ? 'Meta+ArrowLeft' : 'Home');
  await press('ArrowUp');
  await press('ArrowUp');
  await userEvent.keyboard('{' + 'Shift' + '>}');
  await press('ArrowDown');
  await userEvent.keyboard('{/' + 'Shift' + '}');
  await press('Tab');
  await assertHTML(
    root,
    html`
      <code
        class="PlaygroundEditorTheme__code"
        dir="auto"
        spellcheck="false"
        data-gutter="1&#10;2&#10;3">
        <span
          class="PlaygroundEditorTheme__tabNode"
          data-lexical-text="true"></span>
        <span data-lexical-text="true">alert(1);</span>
        <br />
        <br />
        <span data-lexical-text="true">alert(2);</span>
      </code>
    `,
  );
});
test('Can move around lines with option+arrow keys', async () => {
  const abcHTML = html`
    <code
      class="PlaygroundEditorTheme__code"
      dir="auto"
      spellcheck="false"
      data-gutter="1&#10;2&#10;3">
      <span data-lexical-text="true">a();</span>
      <br />
      <span data-lexical-text="true">b();</span>
      <br />
      <span data-lexical-text="true">c();</span>
    </code>
  `;
  const bcaHTML = html`
    <code
      class="PlaygroundEditorTheme__code"
      dir="auto"
      spellcheck="false"
      data-gutter="1&#10;2&#10;3">
      <span data-lexical-text="true">b();</span>
      <br />
      <span data-lexical-text="true">c();</span>
      <br />
      <span data-lexical-text="true">a();</span>
    </code>
  `;
  const endOfFirstLine = {
    anchorOffset: 4,
    anchorPath: [0, 0, 0],
    focusOffset: 4,
    focusPath: [0, 0, 0],
  };
  const endOfLastLine = {
    anchorOffset: 4,
    anchorPath: [0, 4, 0],
    focusOffset: 4,
    focusPath: [0, 4, 0],
  };
  const {root} = setupEditor([extension]);
  await typeText('``` a();\nb();\nc();');
  await assertHTML(root, abcHTML);
  await assertSelection(root, endOfLastLine);
  await press('ArrowUp');
  await press('ArrowUp');
  // Workaround for #1173: just insert and remove a space to fix Firefox losing the selection
  await typeText(' ');
  await press('Backspace');
  await assertSelection(root, endOfFirstLine);
  // End workaround
  // Ensure attempting to move a line up at the top of a codeblock no-ops
  await userEvent.keyboard('{' + 'Alt' + '>}');
  await press('ArrowUp');
  await assertSelection(root, endOfFirstLine);
  await assertHTML(root, abcHTML);
  await press('ArrowDown');
  await press('ArrowDown');
  await assertSelection(root, endOfLastLine);
  // Can't move a line down and out of codeblock
  await assertHTML(root, bcaHTML);
  await press('ArrowDown');
  await assertSelection(root, endOfLastLine);
  await assertHTML(root, bcaHTML);

  await userEvent.keyboard('{/Alt}');
});
test('should not prevent selection and typing outside code block boundaries if block has siblings', async () => {
  const {editor, root} = setupEditor([extension]);

  // make three paragraphs and move on to the middle one
  await press('Enter');
  await press('Enter');
  await press('ArrowUp');
  await assertCaret(editor, 'p:nth-child(2)', 0);

  await typeText('console.log("test");');
  await assertCaret(editor, 'p:nth-child(2) > span', 20);
  await editor.update(
    () => $setBlocksType($getSelection(), () => $createCodeNode()),
    {discrete: true},
  );

  // ArrowUp's code-block handler reads Lexical's selection, so both carets
  // must reach the start of the line before it runs.
  await press(IS_APPLE ? 'Meta+ArrowLeft' : 'Home');
  await assertSelection(root, {
    anchorOffset: 0,
    anchorPath: [1, 0, 0],
    focusOffset: 0,
    focusPath: [1, 0, 0],
  });
  await assertCaret(editor, 'code > span', 0);
  await press('ArrowUp');
  await assertSelection(root, {
    anchorOffset: 0,
    anchorPath: [0],
    focusOffset: 0,
    focusPath: [0],
  });
  await assertCaret(editor, 'p:first-child', 0);

  await typeText('Hello');

  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Hello</span>
      </p>
      <code
        class="PlaygroundEditorTheme__code"
        dir="auto"
        spellcheck="false"
        data-gutter="1">
        <span data-lexical-text="true">console.log("test");</span>
      </code>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <br data-lexical-managed-linebreak="true" />
      </p>
    `,
  );

  await assertCaret(editor, 'p:first-child > span', 5);
  await press('ArrowDown');
  await assertCaret(editor, 'code > span');
  await press(IS_APPLE ? 'Meta+ArrowRight' : 'End');

  // Selection must at the end of code block
  await assertSelection(root, {
    anchorOffset: 20,
    anchorPath: [1, 0, 0],
    focusOffset: 20,
    focusPath: [1, 0, 0],
  });
  await assertCaret(editor, 'code > span', 20);

  // Selection must at the start of next paragraph after another when pressing down
  await press('ArrowDown');
  await assertSelection(root, {
    anchorOffset: 0,
    anchorPath: [2],
    focusOffset: 0,
    focusPath: [2],
  });
  await assertCaret(editor, 'p:last-child', 0);

  await typeText('world');

  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Hello</span>
      </p>
      <code
        class="PlaygroundEditorTheme__code"
        dir="auto"
        spellcheck="false"
        data-gutter="1">
        <span data-lexical-text="true">console.log("test");</span>
      </code>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">world</span>
      </p>
    `,
  );
});
test('When pressing CMD/Ctrl + Left, CMD/Ctrl + Right, the cursor should go to the start of the code', async () => {
  const {editor, root} = setupEditor([extension]);
  await typeText('``` ');
  await press('Space');
  await editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);
  await typeText('a b');
  await press('Space');
  await press('Enter');
  await typeText('c d');
  await press('Space');
  await assertHTML(
    root,
    `
      <code
        class="PlaygroundEditorTheme__code"
        dir="auto"
        spellcheck="false"
        data-gutter="1&#10;2">
        <span class="PlaygroundEditorTheme__tabNode" data-lexical-text="true"></span>
        <span data-lexical-text="true">a b</span>
        <br />
        <span class="PlaygroundEditorTheme__tabNode" data-lexical-text="true"></span>
        <span data-lexical-text="true">c d</span>
      </code>
    `,
  );

  await press('Shift+ArrowLeft', 11);
  await assertSelection(root, {
    anchorOffset: 5,
    anchorPath: [0, 4, 0],
    focusOffset: 1,
    focusPath: [0, 1, 0],
  });

  await press(IS_APPLE ? 'Meta+ArrowLeft' : 'Home');
  await assertSelection(root, {
    anchorOffset: 0,
    anchorPath: [0, 0, 0],
    focusOffset: 0,
    focusPath: [0, 0, 0],
  });

  await press(IS_APPLE ? 'Meta+ArrowRight' : 'End');
  await assertSelection(root, {
    anchorOffset: 5,
    anchorPath: [0, 1, 0],
    focusOffset: 5,
    focusPath: [0, 1, 0],
  });

  await press(IS_APPLE ? 'Meta+ArrowLeft' : 'Home');
  await assertSelection(root, {
    anchorOffset: 1,
    anchorPath: [0, 1, 0],
    focusOffset: 1,
    focusPath: [0, 1, 0],
  });

  await press('Shift+ArrowRight', 11);
  await assertSelection(root, {
    anchorOffset: 1,
    anchorPath: [0, 1, 0],
    focusOffset: 5,
    focusPath: [0, 4, 0],
  });

  await press(IS_APPLE ? 'Meta+ArrowRight' : 'End');
  await assertSelection(root, {
    anchorOffset: 5,
    anchorPath: [0, 4, 0],
    focusOffset: 5,
    focusPath: [0, 4, 0],
  });
});
