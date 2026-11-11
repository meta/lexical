/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  registerMarkdownShortcuts,
} from '@lexical/markdown';
import {MarkdownTestExtension} from '@lexical/markdown/src/__tests__/utils';
import {
  $createParagraphNode,
  $getRoot,
  configExtension,
  defineExtension,
} from 'lexical';
import {assert, expect, onTestFinished, test} from 'vitest';
import {page, userEvent} from 'vitest/browser';

import {
  assertHTML,
  assertSelection,
  html,
  press,
  redo,
  setupEditor,
  typeText,
  undo,
} from './utils';

const extension = defineExtension({
  dependencies: [
    MarkdownTestExtension,
    // Keys typed in a row make one undo step only while each comes within the
    // history delay (300 ms) of the one before, which a busy runner can miss.
    // Merge them however slowly they come, so each undo takes the step the
    // undo/redo test expects.
    configExtension(HistoryExtension, {delay: Infinity}),
  ],
  name: '[markdown-inline-test]',
  register: editor => registerMarkdownShortcuts(editor),
});
const setup = () => setupEditor([extension]);
const cases = [
  {
    html: html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">hello</span>
        <em class="PlaygroundEditorTheme__textItalic" data-lexical-text="true">
          world
        </em>
        <span data-lexical-text="true">!</span>
      </p>
    `,
    text: 'hello *world*!',
  },
  {
    html: html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">hello</span>
        <strong
          class="PlaygroundEditorTheme__textBold"
          data-lexical-text="true">
          world
        </strong>
        <span data-lexical-text="true">!</span>
      </p>
    `,
    text: 'hello **world**!',
  },
  {
    html: html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">hello</span>
        <strong
          class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
          data-lexical-text="true">
          world
        </strong>
        <span data-lexical-text="true">!</span>
      </p>
    `,
    text: 'hello ***world***!',
  },
  {
    html: html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">hello</span>
        <strong
          class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
          data-lexical-text="true">
          world
        </strong>
        <span data-lexical-text="true">!</span>
      </p>
    `,
    text: 'hello ___world___!',
  },
  {
    html: html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">hello</span>
        <a class="PlaygroundEditorTheme__link" href="https://www.test.com">
          <span data-lexical-text="true">world</span>
        </a>
        <span data-lexical-text="true">!</span>
      </p>
    `,
    text: 'hello [world](https://www.test.com)!',
  },
  {
    html: html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <strong
          class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough"
          data-lexical-text="true">
          hello world
        </strong>
        <span data-lexical-text="true">!</span>
      </p>
    `,
    text: '~~_**hello world**_~~!',
  },
  {
    html: html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <em
          class="PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough"
          data-lexical-text="true">
          hello world
        </em>
        <span data-lexical-text="true">!</span>
      </p>
    `,
    text: '~~_hello world_~~!',
  },
  {
    html: html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <strong
          class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textStrikethrough"
          data-lexical-text="true">
          hello world
        </strong>
        <span data-lexical-text="true">!</span>
      </p>
    `,
    text: '~~**hello world**~~!',
  },
  {
    html: html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <strong
          class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
          data-lexical-text="true">
          hello world
        </strong>
        <span data-lexical-text="true">!</span>
      </p>
    `,
    text: '_**hello world**_!',
  },
];

test.each(cases)(
  'types and round-trips $text',
  async ({text, html: expected}) => {
    const {editor, root} = setup();
    await typeText(text);
    await assertHTML(root, expected);
    expect(root.textContent).toBe('hello world!');
    editor.update(() => $convertFromMarkdownString(text), {discrete: true});
    await assertHTML(root, expected);
    for (let i = 0; i < 2; i++) {
      const markdown = editor.read(() => $convertToMarkdownString());
      editor.update(() => $convertFromMarkdownString(markdown), {
        discrete: true,
      });
      await assertHTML(root, expected);
    }
  },
);
// An iframe has its own performance.timeOrigin, and a capture-phase input
// listener above the root (React adds one to a portal's container) lets the
// mutation observer run before Lexical handles the native insertion.
test.each([
  {keys: '*hi*', selector: 'em', text: 'hi'},
  {keys: '**hi**', selector: 'strong', text: 'hi'},
  {keys: '`hi`', selector: 'code', text: 'hi'},
  {keys: '# hi', selector: 'h1', text: 'hi'},
  // userEvent.keyboard reads a single [ as the start of a key name
  {keys: '[[hi](https://lexical.dev)', selector: 'a', text: 'hi'},
])(
  'transforms $keys when the editor root is in an iframe',
  async ({keys, selector, text}) => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const iframeDocument = iframe.contentDocument;
    assert(
      iframeDocument !== null,
      'Expected the test iframe to have a document',
    );
    iframeDocument.body.addEventListener('input', () => {}, true);
    const root = iframeDocument.createElement('div');
    root.contentEditable = 'true';
    root.style.whiteSpace = 'pre-wrap';
    root.dataset.testid = 'editor';
    iframeDocument.body.append(root);
    const editor = buildEditorFromExtensions([extension]);
    editor.setRootElement(root);
    editor.update(
      () => {
        $getRoot().clear().append($createParagraphNode());
        $getRoot().selectEnd();
      },
      {discrete: true},
    );
    onTestFinished(() => {
      editor.dispose();
      iframe.remove();
    });
    // Firefox keeps keyboard focus in the parent frame after a programmatic
    // focus() inside the iframe, so click into the editor instead
    await page
      .frameLocator(page.elementLocator(iframe))
      .getByTestId('editor')
      .click();
    await userEvent.keyboard(keys);
    await expect.poll(() => root.textContent).toBe(text);
    expect(root.querySelector(selector)?.textContent).toBe(text);
  },
);
test('can undo/redo nested transformations', async () => {
  const {root} = setup();
  await typeText('~~_**hello world**_~~');

  const BOLD_ITALIC_STRIKETHROUGH = html`
    <p class="PlaygroundEditorTheme__paragraph" dir="auto">
      <strong
        class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough"
        data-lexical-text="true">
        hello world
      </strong>
    </p>
  `;
  const BOLD_ITALIC = html`
    <p class="PlaygroundEditorTheme__paragraph" dir="auto">
      <span data-lexical-text="true">~~</span>
      <strong
        class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
        data-lexical-text="true">
        hello world
      </strong>
      <span data-lexical-text="true">~~</span>
    </p>
  `;
  const BOLD = html`
    <p class="PlaygroundEditorTheme__paragraph" dir="auto">
      <span data-lexical-text="true">~~_</span>
      <strong class="PlaygroundEditorTheme__textBold" data-lexical-text="true">
        hello world
      </strong>
      <span data-lexical-text="true">_</span>
    </p>
  `;
  const PLAIN = html`
    <p class="PlaygroundEditorTheme__paragraph" dir="auto">
      <span data-lexical-text="true">~~_**hello world**</span>
    </p>
  `;

  await assertHTML(root, BOLD_ITALIC_STRIKETHROUGH);

  await undo(); // Undo last transformation
  await assertHTML(root, BOLD_ITALIC);
  await undo(); // Undo transformation & its text typing
  await undo();
  await assertHTML(root, BOLD);
  await undo(); // Undo transformation & its text typing
  await undo();
  await assertHTML(root, PLAIN);
  await redo(); // Redo transformation & its text typing
  await redo();
  await assertHTML(root, BOLD);
  await redo(); // Redo transformation & its text typing
  await redo();
  await assertHTML(root, BOLD_ITALIC);
  await redo(); // Redo transformation
  await assertHTML(root, BOLD_ITALIC_STRIKETHROUGH);
});

test('can convert already styled text (overlapping ranges)', async () => {
  // type partially bold/underlined text, add opening markdown tag within bold/underline part
  // and add closing within plain text
  const {root} = setup();
  await press('ControlOrMeta+b');
  await press('ControlOrMeta+u');
  await typeText('h*e~~llo');
  await press('ControlOrMeta+b');
  await press('ControlOrMeta+u');
  await typeText(' wo~~r*ld');
  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <strong
          class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textUnderline"
          data-lexical-text="true">
          h
        </strong>
        <strong
          class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textUnderline"
          data-lexical-text="true">
          e
        </strong>
        <strong
          class="PlaygroundEditorTheme__textUnderlineStrikethrough PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
          data-lexical-text="true">
          llo
        </strong>
        <em
          class="PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough"
          data-lexical-text="true">
          wo
        </em>
        <em class="PlaygroundEditorTheme__textItalic" data-lexical-text="true">
          r
        </em>
        <span data-lexical-text="true">ld</span>
      </p>
    `,
  );
});

test('does not use code-formatted text in text format transformers (#7349)', async () => {
  const {root} = setup();
  await typeText('`void*` or `int*`');
  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <code spellcheck="false" data-lexical-text="true">
          <span class="PlaygroundEditorTheme__textCode">void*</span>
        </code>
        <span data-lexical-text="true">or</span>
        <code spellcheck="false" data-lexical-text="true">
          <span class="PlaygroundEditorTheme__textCode">int*</span>
        </code>
      </p>
    `,
  );
});

test('can adjust selection after text match transformer', async () => {
  const {root} = setup();
  await typeText('Hello  world');
  await press('ArrowLeft', 6);
  await typeText('[link](https://lexical.dev)');
  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Hello</span>
        <a class="PlaygroundEditorTheme__link" href="https://lexical.dev">
          <span data-lexical-text="true">link</span>
        </a>
        <span data-lexical-text="true">world</span>
      </p>
    `,
  );
  // Selection starts after newly created link element

  await assertSelection(root, {
    anchorOffset: 0,
    anchorPath: [0, 2, 0],
    focusOffset: 0,
    focusPath: [0, 2, 0],
  });
});
