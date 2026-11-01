/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {IS_APPLE} from 'lexical';
import {test} from 'vitest';
import {userEvent} from 'vitest/browser';

import {
  assertHTML,
  pasteFromClipboard,
  setupPasteEditor,
} from './htmlPasteUtils';
import {assertSelection, html, press, typeText} from './utils';

test('Copy + paste blocks after two line breaks', async () => {
  const {root} = setupPasteEditor();

  await typeText('Line of text');
  await press('Shift+Enter');
  await press('Shift+Enter');
  await pasteFromClipboard(root, {
    'text/html': '<h3>Heading 3</h3><p>Some paragraph</p>',
  });

  // The pasted heading keeps its own block instead of merging into the
  // paragraph above it, and the empty line the user typed survives: only the
  // break that terminated the caret's own line goes with it (#4815).
  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Line of text</span>
        <br />
        <br data-lexical-managed-linebreak="true" />
      </p>
      <h3 class="PlaygroundEditorTheme__h3" dir="auto">
        <span data-lexical-text="true">Heading 3</span>
      </h3>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Some paragraph</span>
      </p>
    `,
  );
  await assertSelection(root, {
    anchorOffset: 14,
    anchorPath: [2, 0, 0],
    focusOffset: 14,
    focusPath: [2, 0, 0],
  });
});

test('Copy + paste blocks ending in an empty block keeps the caret at the join', async () => {
  const {root} = setupPasteEditor();

  await typeText('asdf');
  await press(IS_APPLE ? 'Meta+ArrowLeft' : 'Home');
  // Copying several blocks out of an editor carries a trailing empty
  // paragraph, which is the block the split-off text is appended into.
  await pasteFromClipboard(root, {
    'text/html': '<p>AA</p><p>BB</p><p></p>',
  });

  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">AA</span>
      </p>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">BB</span>
      </p>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">asdf</span>
      </p>
    `,
  );
  // The caret belongs where the pasted content ends, not at the end of the
  // document past the text that was moved in.
  await assertSelection(root, {
    anchorOffset: 0,
    anchorPath: [2, 0, 0],
    focusOffset: 0,
    focusPath: [2, 0, 0],
  });

  // Typing lands at the join rather than after the "f".
  await typeText('X');
  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">AA</span>
      </p>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">BB</span>
      </p>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Xasdf</span>
      </p>
    `,
  );
});

test('Copy + paste a code block with BR', async () => {
  const {root} = setupPasteEditor();

  const clipboard = {
    'text/html': `<meta charset='utf-8'><p class="x1f6kntn x1fcty0u x16h55sf x12nagc xdj266r" dir="ltr"><span>Code block</span></p><code class="x1f6kntn x1fcty0u x16h55sf x1xmf6yo x1e56ztr x1q8sqs3 xeq4nuv x1lliihq xz9dl7a xn6708d xsag5q8 x1ye3gou" spellcheck="false" data-language="javascript" data-highlight-language="javascript"><span class="xuc5kci">function</span><span> </span><span class="xu88d7e">foo</span><span class="x1noocy9">(</span><span class="x1noocy9">)</span><span> </span><span class="x1noocy9">{</span><br><span>  </span><span class="xuc5kci">return</span><span> </span><span class="x180nigk">'Hey there'</span><span class="x1noocy9">;</span><br><span class="x1noocy9">}</span></code><p class="x1f6kntn x1fcty0u x16h55sf x12nagc xdj266r" dir="ltr"><span>--end--</span></p>`,
  };

  await pasteFromClipboard(root, clipboard);

  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
        <span data-lexical-text="true">Code block</span>
      </p>
      <code
        class="PlaygroundEditorTheme__code"
        dir="auto"
        spellcheck="false"
        data-gutter="1&#10;2&#10;3"
        data-highlight-language="javascript"
        data-language="javascript">
        <span class="PlaygroundEditorTheme__tokenAttr" data-lexical-text="true">
          function
        </span>
        <span data-lexical-text="true"></span>
        <span
          class="PlaygroundEditorTheme__tokenFunction"
          data-lexical-text="true">
          foo
        </span>
        <span
          class="PlaygroundEditorTheme__tokenPunctuation"
          data-lexical-text="true">
          (
        </span>
        <span
          class="PlaygroundEditorTheme__tokenPunctuation"
          data-lexical-text="true">
          )
        </span>
        <span data-lexical-text="true"></span>
        <span
          class="PlaygroundEditorTheme__tokenPunctuation"
          data-lexical-text="true">
          {
        </span>
        <br />
        <span class="PlaygroundEditorTheme__tokenAttr" data-lexical-text="true">
          return
        </span>
        <span data-lexical-text="true"></span>
        <span
          class="PlaygroundEditorTheme__tokenSelector"
          data-lexical-text="true">
          'Hey there'
        </span>
        <span
          class="PlaygroundEditorTheme__tokenPunctuation"
          data-lexical-text="true">
          ;
        </span>
        <br />
        <span
          class="PlaygroundEditorTheme__tokenPunctuation"
          data-lexical-text="true">
          }
        </span>
      </code>
      <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
        <span data-lexical-text="true">--end--</span>
      </p>
    `,
  );
});

test('Copy + paste a paragraph element between horizontal rules', async () => {
  const {root} = setupPasteEditor();

  let clipboard = {'text/html': '<hr/><hr/>'};

  await pasteFromClipboard(root, clipboard);
  // Collab doesn't process the cursor correctly

  await assertHTML(
    root,
    html`
      <hr
        class="PlaygroundEditorTheme__hr"
        contenteditable="false"
        data-lexical-decorator="true" />
      <hr
        class="PlaygroundEditorTheme__hr"
        contenteditable="false"
        data-lexical-decorator="true" />
      <div
        class="PlaygroundEditorTheme__blockCursor"
        contenteditable="false"
        data-lexical-cursor="true"></div>
    `,
  );

  await userEvent.click(root.querySelector('hr:first-of-type')!);

  // sets focus between HRs
  await press('ArrowRight');

  clipboard = {'text/html': '<p>Text between HRs</p>'};

  await pasteFromClipboard(root, clipboard);
  await assertHTML(
    root,
    html`
      <hr
        class="PlaygroundEditorTheme__hr"
        contenteditable="false"
        data-lexical-decorator="true" />
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Text between HRs</span>
      </p>
      <hr
        class="PlaygroundEditorTheme__hr"
        contenteditable="false"
        data-lexical-decorator="true" />
    `,
  );
  await assertSelection(root, {
    anchorOffset: 16,
    anchorPath: [1, 0, 0],
    focusOffset: 16,
    focusPath: [1, 0, 0],
  });
});

test('Paste top level element in the middle of paragraph', async () => {
  const {root} = setupPasteEditor();

  await typeText('Hello world');
  await press(IS_APPLE ? 'Alt+ArrowLeft' : 'Control+ArrowLeft');
  await pasteFromClipboard(root, {
    'text/html': `<hr />`,
  });

  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Hello</span>
      </p>
      <hr
        class="PlaygroundEditorTheme__hr"
        contenteditable="false"
        data-lexical-decorator="true" />
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">world</span>
      </p>
    `,
  );
});
