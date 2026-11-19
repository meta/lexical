/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {INDENT_CONTENT_COMMAND, OUTDENT_CONTENT_COMMAND} from 'lexical';
import {test} from 'vitest';

import {
  assertHTML,
  pasteFromClipboard,
  setupPasteEditor,
} from './htmlPasteUtils';
import {assertSelection, html, press, typeText} from './utils';

test('Copy + paste a list element with right alignment', async () => {
  const {root} = setupPasteEditor();

  const clipboard = {
    'text/html':
      '<ul><li style="text-align: right;">Hello</li><li style="text-align: right;">world!</li></ul>',
  };

  await pasteFromClipboard(root, clipboard);

  await assertHTML(
    root,
    html`
      <ul class="PlaygroundEditorTheme__ul" dir="auto">
        <li
          class="PlaygroundEditorTheme__listItem"
          style="text-align: right;"
          value="1">
          <span data-lexical-text="true">Hello</span>
        </li>
        <li
          class="PlaygroundEditorTheme__listItem"
          style="text-align: right;"
          value="2">
          <span data-lexical-text="true">world!</span>
        </li>
      </ul>
    `,
  );

  await assertSelection(root, {
    anchorOffset: 6,
    anchorPath: [0, 1, 0, 0],
    focusOffset: 6,
    focusPath: [0, 1, 0, 0],
  });
});

test('Copy + paste a Lexical nested list', async () => {
  const {root} = setupPasteEditor();

  const clipboard = {
    'text/html':
      '<ul><li>Hello</li><li><ul><li>awesome</li></ul></li><li>world!</li></ul>',
  };

  await pasteFromClipboard(root, clipboard);

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
              <span data-lexical-text="true">awesome</span>
            </li>
          </ul>
        </li>
        <li class="PlaygroundEditorTheme__listItem" value="2">
          <span data-lexical-text="true">world!</span>
        </li>
      </ul>
    `,
  );
});

test('Copy + paste (Nested List - directly nested ul)', async () => {
  const {editor, root} = setupPasteEditor();

  const clipboard = {
    'text/html': '<ul><ul><li>Hello</li></ul><li>world!</li></ul>',
  };

  await pasteFromClipboard(root, clipboard);

  await assertHTML(
    root,
    html`
      <ul class="PlaygroundEditorTheme__ul" dir="auto">
        <li
          class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
          value="1">
          <ul class="PlaygroundEditorTheme__ul">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">Hello</span>
            </li>
          </ul>
        </li>
        <li class="PlaygroundEditorTheme__listItem" value="1">
          <span data-lexical-text="true">world!</span>
        </li>
      </ul>
    `,
  );

  await assertSelection(root, {
    anchorOffset: 6,
    anchorPath: [0, 1, 0, 0],
    focusOffset: 6,
    focusPath: [0, 1, 0, 0],
  });

  await editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);

  await assertHTML(
    root,
    html`
      <ul class="PlaygroundEditorTheme__ul" dir="auto">
        <li
          class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
          value="1">
          <ul class="PlaygroundEditorTheme__ul">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">Hello</span>
            </li>
            <li class="PlaygroundEditorTheme__listItem" value="2">
              <span data-lexical-text="true">world!</span>
            </li>
          </ul>
        </li>
      </ul>
    `,
  );

  await press('ArrowUp');

  await editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);

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
              <span data-lexical-text="true">world!</span>
            </li>
          </ul>
        </li>
      </ul>
    `,
  );
});

test('Copy + paste (Nested List - li with non-list content plus ul child)', async () => {
  const {editor, root} = setupPasteEditor();

  const clipboard = {
    'text/html': '<ul><li>Hello<ul><li>world!</li></ul></li></ul>',
  };

  await pasteFromClipboard(root, clipboard);

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
              <span data-lexical-text="true">world!</span>
            </li>
          </ul>
        </li>
      </ul>
    `,
  );

  await assertSelection(root, {
    anchorOffset: 6,
    anchorPath: [0, 1, 0, 0, 0, 0],
    focusOffset: 6,
    focusPath: [0, 1, 0, 0, 0, 0],
  });

  await editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);

  await assertHTML(
    root,
    html`
      <ul class="PlaygroundEditorTheme__ul" dir="auto">
        <li class="PlaygroundEditorTheme__listItem" value="1">
          <span data-lexical-text="true">Hello</span>
        </li>
        <li class="PlaygroundEditorTheme__listItem" value="2">
          <span data-lexical-text="true">world!</span>
        </li>
      </ul>
    `,
  );

  await press('ArrowUp');

  await editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);

  await assertHTML(
    root,
    html`
      <ul class="PlaygroundEditorTheme__ul" dir="auto">
        <li
          class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
          value="1">
          <ul class="PlaygroundEditorTheme__ul">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">Hello</span>
            </li>
          </ul>
        </li>
        <li class="PlaygroundEditorTheme__listItem" value="1">
          <span data-lexical-text="true">world!</span>
        </li>
      </ul>
    `,
  );
});

test('Copy + paste a checklist', async () => {
  const {root} = setupPasteEditor();

  const clipboard = {
    'text/html': `<meta charset='utf-8'><ul __lexicallisttype="check"><li role="checkbox" tabindex="-1" aria-checked="false" value="1" class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"><span>Hello</span></li><li role="checkbox" tabindex="-1" aria-checked="false" value="2" class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"><span>world</span></li></ul>`,
  };

  await pasteFromClipboard(root, clipboard);

  await assertHTML(
    root,
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
          class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
          role="checkbox"
          tabindex="-1"
          value="2"
          aria-checked="false">
          <span data-lexical-text="true">world</span>
        </li>
      </ul>
    `,
  );

  await press('ControlOrMeta+a');
  await press('Backspace');

  // Ensure we preserve checked status.
  clipboard['text/html'] =
    `<meta charset='utf-8'><ul __lexicallisttype="check"><li role="checkbox" tabindex="-1" aria-checked="true" value="1" class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemChecked"><span>Hello</span></li><li role="checkbox" tabindex="-1" aria-checked="false" value="2" class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"><span>world</span></li></ul>`;

  await pasteFromClipboard(root, clipboard);

  await assertHTML(
    root,
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
          <span data-lexical-text="true">Hello</span>
        </li>
        <li
          class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__listItemUnchecked"
          role="checkbox"
          tabindex="-1"
          value="2"
          aria-checked="false">
          <span data-lexical-text="true">world</span>
        </li>
      </ul>
    `,
  );
});

test('Paste top level element in the middle of list', async () => {
  const {root} = setupPasteEditor();

  // Add three list items
  await typeText('- one');
  await press('Enter');
  await typeText('two');
  await press('Enter');
  await typeText('three');
  await press('Enter');
  await typeText('four');

  await press('Enter');
  await press('Enter');
  await press('ArrowUp');
  await press('ArrowUp');
  await press('ArrowUp');
  await pasteFromClipboard(root, {
    'text/html': `<hr />`,
  });

  await assertHTML(
    root,
    html`
      <ul class="PlaygroundEditorTheme__ul" dir="auto">
        <li class="PlaygroundEditorTheme__listItem" value="1">
          <span data-lexical-text="true">one</span>
        </li>
      </ul>
      <hr
        class="PlaygroundEditorTheme__hr"
        contenteditable="false"
        data-lexical-decorator="true" />
      <ul class="PlaygroundEditorTheme__ul" dir="auto">
        <li class="PlaygroundEditorTheme__listItem" value="1">
          <span data-lexical-text="true">two</span>
        </li>
        <li class="PlaygroundEditorTheme__listItem" value="2">
          <span data-lexical-text="true">three</span>
        </li>
        <li class="PlaygroundEditorTheme__listItem" value="3">
          <span data-lexical-text="true">four</span>
        </li>
      </ul>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <br data-lexical-managed-linebreak="true" />
      </p>
    `,
  );
});

test('Copy + paste a nested divs in a list', async () => {
  const {root} = setupPasteEditor();

  const clipboard = {
    'text/html': html`
      <ol>
        <li>
          1
          <div>2</div>
          3
        </li>
        <li>
          A
          <div>B</div>
          C
        </li>
      </ol>
    `,
  };

  await pasteFromClipboard(root, clipboard);

  await assertHTML(
    root,
    html`
      <ol class="PlaygroundEditorTheme__ol1" dir="auto">
        <li class="PlaygroundEditorTheme__listItem" value="1">
          <span data-lexical-text="true">1</span>
          <br />
          <span data-lexical-text="true">2</span>
          <br />
          <span data-lexical-text="true">3</span>
        </li>
        <li class="PlaygroundEditorTheme__listItem" value="2">
          <span data-lexical-text="true">A</span>
          <br />
          <span data-lexical-text="true">B</span>
          <br />
          <span data-lexical-text="true">C</span>
        </li>
      </ol>
    `,
  );

  await assertSelection(root, {
    anchorOffset: 1,
    anchorPath: [0, 1, 4, 0],
    focusOffset: 1,
    focusPath: [0, 1, 4, 0],
  });
});
