/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveLeft,
  moveRight,
  moveToLineBeginning,
  redo,
  selectAll,
  selectCharacters,
  toggleUnderline,
  undo,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  clearEditor,
  click,
  copyToClipboard,
  focusEditor,
  getHTML,
  html,
  initialize,
  IS_COLLAB_V2,
  pasteFromClipboard,
  SAMPLE_IMAGE_URL,
  test,
  waitForSelector,
} from '../utils/index.mjs';

async function checkHTMLExpectationsIncludingUndoRedo(
  page,
  forwardHTML,
  undoHTML,
  isCollab,
) {
  await assertHTML(page, forwardHTML);
  if (isCollab || undoHTML === 'none') {
    // Collab uses its own undo/redo
    return;
  }
  await undo(page);
  await assertHTML(page, undoHTML);
  await redo(page);
  await assertHTML(page, forwardHTML);
}

test.describe('Markdown', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  const triggersAndExpectations = [
    {
      expectation:
        '<h1 class="PlaygroundEditorTheme__h1" dir="auto"><br data-lexical-managed-linebreak="true"></h1>',
      importExpectation: '',
      isBlockTest: true,
      markdownImport: '',
      markdownText: '# ',
      undoHTML: '', // H1.
    },
    {
      expectation:
        '<code class="PlaygroundEditorTheme__code" dir="auto" spellcheck="false" data-gutter="1"><br data-lexical-managed-linebreak="true"></code>',
      importExpectation: '',
      isBlockTest: true,
      markdownImport: '',
      markdownText: '``` ',
      undoHTML: '', // Code block.
    },
    {
      expectation:
        '<ul class="PlaygroundEditorTheme__ul" dir="auto"><li value="1" class="PlaygroundEditorTheme__listItem"><br data-lexical-managed-linebreak="true"></li></ul>',
      importExpectation: '',
      isBlockTest: true,
      markdownImport: '',
      markdownText: '* ',
      undoHTML: '', // Unordered.
    },
    {
      expectation:
        '<ul class="PlaygroundEditorTheme__ul" dir="auto"><li value="1" class="PlaygroundEditorTheme__listItem"><br data-lexical-managed-linebreak="true"></li></ul>',
      importExpectation:
        '<ul class="PlaygroundEditorTheme__ul" dir="auto"><li class="PlaygroundEditorTheme__listItem" value="1"><span data-lexical-text="true">hello</span></li></ul>',
      isBlockTest: true,
      markdownImport: '- hello',
      markdownText: '- ',
      undoHTML: '', // Unordered.
    },
    {
      expectation:
        '<ol start="321" class="PlaygroundEditorTheme__ol1" dir="auto"><li value="321" class="PlaygroundEditorTheme__listItem"><br data-lexical-managed-linebreak="true"></li></ol>',
      importExpectation:
        '<ol class="PlaygroundEditorTheme__ol1" start="321" dir="auto"><li class="PlaygroundEditorTheme__listItem" value="321"><span data-lexical-text="true">hello</span></li></ol>',
      isBlockTest: true,
      markdownImport: '', // '321. hello', Need to merge w/ Maksims changes first to get correct start number.
      markdownText: '321. ',
      undoHTML: '', // Ordered.
    },
    {
      expectation:
        '<hr class="PlaygroundEditorTheme__hr" data-lexical-decorator="true" contenteditable="false" /><p class="PlaygroundEditorTheme__paragraph" dir="auto"><br data-lexical-managed-linebreak="true"></p>',
      importExpectation: '',
      isBlockTest: true,
      markdownImport: '',
      markdownText: '*** ',
      undoHTML: '', // HR rule.
    },
    {
      expectation:
        '<hr class="PlaygroundEditorTheme__hr" data-lexical-decorator="true" contenteditable="false" /><p class="PlaygroundEditorTheme__paragraph" dir="auto"><br data-lexical-managed-linebreak="true"></p>',
      importExpectation: '',
      isBlockTest: true,
      markdownImport: '',
      markdownText: '--- ',
      undoHTML: '', // HR Rule.
    },
    {
      expectation:
        '<p class="PlaygroundEditorTheme__paragraph" dir="auto"><strong class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough" data-lexical-text="true">test</strong><span data-lexical-text="true"></span></p>',
      importExpectation: '',
      isBlockTest: true,
      markdownImport: '',
      markdownText: '~~_**test**_~~ ',
      undoHTML: 'none', // strikethru, italic, bold
    },
    {
      expectation:
        '<p class="PlaygroundEditorTheme__paragraph" dir="auto"><em class="PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough" data-lexical-text="true">test</em><span data-lexical-text="true"></span></p>',
      importExpectation: '',
      isBlockTest: true,
      markdownImport: '',
      markdownText: '~~_test_~~ ',
      undoHTML: 'none', // strikethru, italic
    },
    {
      expectation:
        '<p class="PlaygroundEditorTheme__paragraph" dir="auto"><strong class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textStrikethrough" data-lexical-text="true">test</strong><span data-lexical-text="true"></span></p>',
      importExpectation: '',
      isBlockTest: true,
      markdownImport: '',
      markdownText: '~~**test**~~ ',
      undoHTML: 'none', // strikethru, bold
    },
    {
      expectation:
        '<p class="PlaygroundEditorTheme__paragraph" dir="auto"><strong class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic" data-lexical-text="true">test</strong><span data-lexical-text="true"></span></p>',
      importExpectation:
        '<p class="PlaygroundEditorTheme__paragraph" dir="auto"> <strong class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic" data-lexical-text="true">test</strong></p>',
      isBlockTest: true,
      markdownImport: '_**test**_',
      markdownText: '_**test**_ ',
      undoHTML: 'none', // italic, bold
    },
  ];
  // forward case is the normal case.
  // undo case is when the user presses undo.

  const count = triggersAndExpectations.length;
  for (let i = 0; i < count; ++i) {
    const markdownText = triggersAndExpectations[i].markdownText;

    if (triggersAndExpectations[i].isBlockTest === false) {
      test.describe(() => {
        test.skip(({isPlainText}) => isPlainText);
        test(`Should create stylized (e.g. BIUS) text from plain text using a markdown shortcut e.g. ${markdownText}`, async ({
          page,
          isCollab,
        }) => {
          const text = 'x' + markdownText + 'y';

          await focusEditor(page);
          await page.keyboard.type(text);
          await moveLeft(page, text.length);
          await assertSelection(page, {
            anchorOffset: 0,
            anchorPath: [0, 0, 0],
            focusOffset: 0,
            focusPath: [0, 0, 0],
          });

          await moveRight(page, 1 + markdownText.length);

          // Trigger markdown.
          await page.keyboard.type(' ');

          await checkHTMLExpectationsIncludingUndoRedo(
            page,
            triggersAndExpectations[i].expectation,
            triggersAndExpectations[i].undoHTML,
            isCollab,
          );
        });

        test(`Should create stylized (e.g. BIUS) text from already stylized text using a markdown shortcut e.g. ${markdownText}`, async ({
          page,
          isCollab,
        }) => {
          const text = 'x' + markdownText + 'y';

          await focusEditor(page);
          await page.keyboard.type(text);
          await moveLeft(page, text.length);
          await assertSelection(page, {
            anchorOffset: 0,
            anchorPath: [0, 0, 0],
            focusOffset: 0,
            focusPath: [0, 0, 0],
          });

          // Select first 2 characters.
          await selectCharacters(page, 'right', 2);

          // Make underline.
          await toggleUnderline(page);

          // Back to beginning.
          await moveLeft(page, 2);

          // Move to end.
          await moveRight(page, text.length);

          // Select last two characters.
          await selectCharacters(page, 'left', 2);

          // Make underline.
          await toggleUnderline(page);

          // Back to beginning of text.
          await moveLeft(page, text.length);

          // Move after markdown text.
          await moveRight(page, 1 + markdownText.length);

          // Trigger markdown.
          await page.keyboard.type(' ');

          await assertHTML(
            page,
            triggersAndExpectations[i].stylizedExpectation,
          );

          await checkHTMLExpectationsIncludingUndoRedo(
            page,
            triggersAndExpectations[i].stylizedExpectation,
            triggersAndExpectations[i].stylizedUndoHTML,
            isCollab,
          );
        });
      });
    }

    if (triggersAndExpectations[i].isBlockTest === true) {
      test.describe(() => {
        test.skip(({isPlainText}) => isPlainText);
        test(`Should test markdown with the (${markdownText}) trigger. Should include undo and redo.`, async ({
          page,
          isCollab,
        }) => {
          await focusEditor(page);

          await page.keyboard.type(markdownText);

          const forwardHTML = triggersAndExpectations[i].expectation;

          const undoHTML = `<p class="PlaygroundEditorTheme__paragraph" dir="auto"><span data-lexical-text="true">${markdownText}</span></p>`;

          await checkHTMLExpectationsIncludingUndoRedo(
            page,
            forwardHTML,
            triggersAndExpectations[i].undoHTML || undoHTML,
            isCollab,
          );
        });
      });
    }

    if (triggersAndExpectations[i].markdownImport.length > 0) {
      test.describe(() => {
        test.skip(({isPlainText}) => isPlainText);
        test(`Should test importing markdown (${markdownText}) trigger.`, async ({
          page,
        }) => {
          await focusEditor(page);

          await page.keyboard.type('```markdown ');
          await page.keyboard.insertText(
            triggersAndExpectations[i].markdownImport,
          );
          await click(page, 'i.markdown');

          const htmlInner = triggersAndExpectations[i].importExpectation;
          await assertHTML(page, htmlInner);

          // Click on markdow toggle twice to run import -> export loop and then
          // validate that it's the same rich text after full cycle
          await click(page, 'i.markdown');
          await click(page, 'i.markdown');
          await assertHTML(page, htmlInner);
        });
      });
    }
  }
});

async function assertMarkdownImportExport(
  page,
  textToImport,
  expectedHTML,
  ignoreClasses,
) {
  // Clear the editor from previous content
  await clearEditor(page);

  // Create code block that will be imported as a markdown into editor
  await page.keyboard.type('```markdown ');
  await page.keyboard.insertText(textToImport);
  await click(page, '.action-button .markdown');
  await assertHTML(page, expectedHTML, undefined, {ignoreClasses});

  // Cycle through import-export to verify it produces the same result
  await click(page, '.action-button .markdown');
  await click(page, '.action-button .markdown');
  await assertHTML(page, expectedHTML);
}

test.describe('Markdown', () => {
  test.skip(({isPlainText}) => isPlainText, 'Requires rich text');
  test.beforeEach(({isCollab, page}) => {
    return initialize({isCollab, page});
  });

  const HORIZONTAL_RULE_SHORTCUTS = [
    {
      html: html`
        <hr
          class="PlaygroundEditorTheme__hr"
          contenteditable="false"
          data-lexical-decorator="true" />
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      text: '--- ',
    },
    {
      html: html`
        <hr
          class="PlaygroundEditorTheme__hr"
          contenteditable="false"
          data-lexical-decorator="true" />
        <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
      `,
      text: '*** ',
    },
  ];

  const SIMPLE_TEXT_FORMAT_SHORTCUTS = [
    {
      html: html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">10:20:30😄</span>
        </p>
      `,
      text: '10:20:30:smile:',
    },
  ];

  HORIZONTAL_RULE_SHORTCUTS.forEach(testCase => {
    test(`can convert "${testCase.text}" shortcut`, async ({
      page,
      isCollab,
    }) => {
      await focusEditor(page);
      await page.keyboard.type(testCase.text);
      await assertHTML(page, testCase.html, undefined, {ignoreClasses: true});

      if (!isCollab) {
        const escapedText = testCase.text.replace('>', '&gt;');
        await undo(page);
        await assertHTML(
          page,
          `<p dir="auto"><span data-lexical-text="true">${escapedText}</span></p>`,
          undefined,
          {ignoreClasses: true},
        );
        await redo(page);
        await assertHTML(page, testCase.html, undefined, {ignoreClasses: true});
      }
    });
  });

  SIMPLE_TEXT_FORMAT_SHORTCUTS.forEach(testCase => {
    test(`can convert "${testCase.text}" shortcut`, async ({page}) => {
      await focusEditor(page);
      await page.keyboard.type(testCase.text);
      await assertHTML(page, testCase.html, undefined, {ignoreClasses: false});
      await assertMarkdownImportExport(page, testCase.text, testCase.html);
    });
  });

  test('can convert markdown text into rich text', async ({page, isCollab}) => {
    await focusEditor(page);
    await page.keyboard.type('```markdown ');
    await pasteFromClipboard(page, {
      'text/plain': IMPORTED_MARKDOWN,
    });

    const originalHTML = await getHTML(page);
    // Both peers must receive the source before converting the whole document.
    await assertHTML(page, originalHTML);

    // Import from current markdown codeblock content
    await click(page, '.action-button .markdown');
    await assertHTML(page, IMPORTED_MARKDOWN_HTML);

    if (!isCollab) {
      await undo(page);
      await assertHTML(page, originalHTML);
      await redo(page);
      await assertHTML(page, IMPORTED_MARKDOWN_HTML);

      // Click again to run export/import cycle twice to make sure
      // no extra nodes (e.g. newlines) are created
      await click(page, '.action-button .markdown');
      await click(page, '.action-button .markdown');
      await click(page, '.action-button .markdown');
      await click(page, '.action-button .markdown');
      await assertHTML(page, IMPORTED_MARKDOWN_HTML);
    }
  });

  test('can type text with markdown', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type(TYPED_MARKDOWN);
    await assertHTML(page, TYPED_MARKDOWN_HTML);
  });

  test('intraword text format', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('he_llo_ world');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">he_llo_ world</span>
        </p>
      `,
    );

    await clearEditor(page);
    await page.keyboard.type('_hello world');
    await moveLeft(page, 3);
    await page.keyboard.type('_');
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">_hello wo_rld</span>
        </p>
      `,
    );
  });

  test('can export text format next to a newline', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('Hello');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.type('_world_');
    await click(page, '.action-button .markdown');
    await assertHTML(
      page,
      html`
        <code
          class="PlaygroundEditorTheme__code"
          dir="auto"
          spellcheck="false"
          data-gutter="12"
          data-highlight-language="markdown"
          data-language="markdown">
          <span data-lexical-text="true">Hello</span>
          <br />
          <span
            class="PlaygroundEditorTheme__tokenPunctuation"
            data-lexical-text="true">
            *
          </span>
          <span data-lexical-text="true">world</span>
          <span
            class="PlaygroundEditorTheme__tokenPunctuation"
            data-lexical-text="true">
            *
          </span>
        </code>
      `,
    );
  });

  test.describe(() => {
    test.skip(IS_COLLAB_V2);
    test('can import single decorator node (#2604)', async ({page}) => {
      // TODO(collab-v2): nested editors are not supported yet

      await focusEditor(page);
      await page.keyboard.type('```markdown ');
      await page.keyboard.insertText(
        '![Yellow flower in tilt shift lens](' + SAMPLE_IMAGE_URL + ')',
      );
      await click(page, '.action-button .markdown');
      await waitForSelector(page, '.editor-image img');
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span
              class="editor-image"
              contenteditable="false"
              data-lexical-decorator="true">
              <div draggable="false">
                <img
                  alt="Yellow flower in tilt shift lens"
                  draggable="false"
                  src="${SAMPLE_IMAGE_URL}"
                  style="height: inherit; max-width: 500px; width: inherit" />
              </div>
            </span>
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
    });

    test('can import several text match transformers in a same line (#5385)', async ({
      page,
    }) => {
      // TODO(collab-v2): nested editors are not supported yet

      await focusEditor(page);
      await page.keyboard.type('```markdown ');
      await page.keyboard.insertText(
        '[link](https://lexical.dev)[link](https://lexical.dev)![Yellow flower in tilt shift lens](' +
          SAMPLE_IMAGE_URL +
          ')just text in between$1$',
      );
      await click(page, '.action-button .markdown');
      await waitForSelector(page, '.editor-image img');
      await waitForSelector(page, '.editor-equation');
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <a class="PlaygroundEditorTheme__link" href="https://lexical.dev">
              <span data-lexical-text="true">linklink</span>
            </a>
            <span
              class="editor-image"
              contenteditable="false"
              data-lexical-decorator="true">
              <div draggable="false">
                <img
                  alt="Yellow flower in tilt shift lens"
                  draggable="false"
                  src="${SAMPLE_IMAGE_URL}"
                  style="height: inherit; max-width: 500px; width: inherit" />
              </div>
            </span>
            <span data-lexical-text="true">just text in between</span>
            <span
              class="editor-equation"
              contenteditable="false"
              role="math"
              aria-label="Equation: 1"
              data-lexical-decorator="true">
              <img
                alt=""
                height="0"
                src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
                width="0" />
              <span>
                <span class="katex">
                  <span class="katex-html" aria-hidden="true">
                    <span class="base">
                      <span class="strut" style="height: 0.6444em;"></span>
                      <span class="mord">1</span>
                    </span>
                  </span>
                </span>
              </span>
              <img
                alt=""
                height="0"
                src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
                width="0" />
            </span>
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
    });
  });

  // The hashtag entity claims the "#Welcome" inside "##Welcome", which moves
  // the caret into a different leaf while the shortcut is being typed.
  test('can type a heading shortcut in front of existing text (#5366)', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Welcome to the playground');
    await moveToLineBeginning(page);
    await page.keyboard.type('## ');
    await assertHTML(
      page,
      html`
        <h2 class="PlaygroundEditorTheme__h2" dir="auto">
          <span data-lexical-text="true">Welcome to the playground</span>
        </h2>
      `,
    );
  });

  test('keep list marker on its own items', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('+');
    await page.keyboard.type(' a');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('b');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('c');
    await click(page, '.action-button .markdown');
    await assertHTML(page, LIST_MARKER_MARKDOWN);
  });

  test('keep list marker on its own items with copy/paste', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('+');
    await page.keyboard.type(' a');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('b');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('c');
    await selectAll(page);
    {
      const clipboard = await copyToClipboard(page);
      // Delete selected text and then delete remaining bullet list.
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');
      await pasteFromClipboard(page, clipboard);
      await click(page, '.action-button .markdown');
      await assertHTML(page, LIST_MARKER_MARKDOWN);
    }
  });
});

const LIST_MARKER_MARKDOWN = html`
  <code
    class="PlaygroundEditorTheme__code"
    dir="auto"
    spellcheck="false"
    data-gutter="123"
    data-highlight-language="markdown"
    data-language="markdown">
    <span data-lexical-text="true">+</span>
    <span data-lexical-text="true">a</span>
    <br />
    <span data-lexical-text="true"></span>
    <span data-lexical-text="true">-</span>
    <span data-lexical-text="true">b</span>
    <br />
    <span data-lexical-text="true">+</span>
    <span data-lexical-text="true">c</span>
  </code>
`;

const TYPED_MARKDOWN = `# Markdown Shortcuts
This is *italic*, _italic_, **bold**, __bold__, ~~strikethrough~~ text
This is ~~*__bold italic strikethrough__*~~ text, ___~~this one too~~___
It ~~___works [with links](https://lexical.io) too___~~
*Nested **stars tags** are handled too*
# Title
## Subtitle
> Quote
--- - List here

    - Nested one


\`\`\`sql Code block


Done`;

const TYPED_MARKDOWN_HTML = html`
  <h1 class="PlaygroundEditorTheme__h1" dir="auto">
    <span data-lexical-text="true">Markdown Shortcuts</span>
  </h1>
  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
    <span data-lexical-text="true">This is</span>
    <em class="PlaygroundEditorTheme__textItalic" data-lexical-text="true">
      italic
    </em>
    <span data-lexical-text="true">,</span>
    <em class="PlaygroundEditorTheme__textItalic" data-lexical-text="true">
      italic
    </em>
    <span data-lexical-text="true">,</span>
    <strong class="PlaygroundEditorTheme__textBold" data-lexical-text="true">
      bold
    </strong>
    <span data-lexical-text="true">,</span>
    <strong class="PlaygroundEditorTheme__textBold" data-lexical-text="true">
      bold
    </strong>
    <span data-lexical-text="true">,</span>
    <span
      class="PlaygroundEditorTheme__textStrikethrough"
      data-lexical-text="true">
      strikethrough
    </span>
    <span data-lexical-text="true">text</span>
  </p>
  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
    <span data-lexical-text="true">This is</span>
    <strong
      class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough"
      data-lexical-text="true">
      bold italic strikethrough
    </strong>
    <span data-lexical-text="true">text,</span>
    <strong
      class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough"
      data-lexical-text="true">
      this one too
    </strong>
  </p>
  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
    <span data-lexical-text="true">It</span>
    <strong
      class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough"
      data-lexical-text="true">
      works
    </strong>
    <a class="PlaygroundEditorTheme__link" href="https://lexical.io">
      <strong
        class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough"
        data-lexical-text="true">
        with links
      </strong>
    </a>
    <strong
      class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough"
      data-lexical-text="true">
      too
    </strong>
  </p>
  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
    <em class="PlaygroundEditorTheme__textItalic" data-lexical-text="true">
      Nested
    </em>
    <strong
      class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
      data-lexical-text="true">
      stars tags
    </strong>
    <em class="PlaygroundEditorTheme__textItalic" data-lexical-text="true">
      are handled too
    </em>
  </p>
  <h1 class="PlaygroundEditorTheme__h1" dir="auto">
    <span data-lexical-text="true">Title</span>
  </h1>
  <h2 class="PlaygroundEditorTheme__h2" dir="auto">
    <span data-lexical-text="true">Subtitle</span>
  </h2>
  <blockquote class="PlaygroundEditorTheme__quote" dir="auto">
    <span data-lexical-text="true">Quote</span>
  </blockquote>
  <hr
    class="PlaygroundEditorTheme__hr"
    contenteditable="false"
    data-lexical-decorator="true" />
  <ul class="PlaygroundEditorTheme__ul" dir="auto">
    <li class="PlaygroundEditorTheme__listItem" value="1">
      <span data-lexical-text="true">List here</span>
    </li>
    <li
      class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
      value="2">
      <ul class="PlaygroundEditorTheme__ul">
        <li class="PlaygroundEditorTheme__listItem" value="1">
          <span data-lexical-text="true">Nested one</span>
        </li>
      </ul>
    </li>
  </ul>
  <code
    class="PlaygroundEditorTheme__code"
    dir="auto"
    spellcheck="false"
    data-gutter="1"
    data-highlight-language="sql"
    data-language="sql">
    <span data-lexical-text="true">Code block</span>
  </code>
  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
    <span data-lexical-text="true">Done</span>
  </p>
`;

const IMPORTED_MARKDOWN = `# Markdown Import
### Formatting
This is *italic*, _italic_, **bold**, __bold__, ~~strikethrough~~ text

This is *__~~bold italic strikethrough~~__* text,
___~~this one too~~___

It ***~~works~~*** and [***~~with links~~***](https://lexical.io) too

Links [with underscores](https://lexical.io/tag_here_and__here__and___here___too) and ([parenthesis](https://lexical.dev))

*Nested **stars tags** are handled too*
### Headings
# h1 Heading
## h2 Heading
### h3 Heading
#### h4 Heading
##### h5 Heading
###### h6 Heading
### Horizontal Rules
---
### Blockquotes
> Blockquotes text goes here
> And second
line after

> Standalone again

### Unordered lists
- Create a list with \`+\`, \`-\`, or \`*\`
    - Lists can be indented with 2 spaces
        - Very easy
### Ordered lists
1. Oredered lists started with numbers as \`1.\`
    1. And can be nested
    and multiline as well

.
31. Have any starting number
### Inline code
Inline \`code\` format which also \`preserves **_~~any markdown-like~~_** text\` within
### Code blocks
\`\`\`javascript
// Some comments
1 + 1 = 2;
**_~~1~~_**
\`\`\``;

const IMPORTED_MARKDOWN_HTML = html`
  <h1 class="PlaygroundEditorTheme__h1" dir="auto">
    <span data-lexical-text="true">Markdown Import</span>
  </h1>
  <h3 class="PlaygroundEditorTheme__h3" dir="auto">
    <span data-lexical-text="true">Formatting</span>
  </h3>
  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
    <span data-lexical-text="true">This is</span>
    <em class="PlaygroundEditorTheme__textItalic" data-lexical-text="true">
      italic
    </em>
    <span data-lexical-text="true">,</span>
    <em class="PlaygroundEditorTheme__textItalic" data-lexical-text="true">
      italic
    </em>
    <span data-lexical-text="true">,</span>
    <strong class="PlaygroundEditorTheme__textBold" data-lexical-text="true">
      bold
    </strong>
    <span data-lexical-text="true">,</span>
    <strong class="PlaygroundEditorTheme__textBold" data-lexical-text="true">
      bold
    </strong>
    <span data-lexical-text="true">,</span>
    <span
      class="PlaygroundEditorTheme__textStrikethrough"
      data-lexical-text="true">
      strikethrough
    </span>
    <span data-lexical-text="true">text</span>
  </p>
  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
    <span data-lexical-text="true">This is</span>
    <strong
      class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough"
      data-lexical-text="true">
      bold italic strikethrough
    </strong>
    <span data-lexical-text="true">text,</span>
    <br />
    <strong
      class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough"
      data-lexical-text="true">
      this one too
    </strong>
  </p>
  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
    <span data-lexical-text="true">It</span>
    <strong
      class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough"
      data-lexical-text="true">
      works
    </strong>
    <span data-lexical-text="true">and</span>
    <a class="PlaygroundEditorTheme__link" href="https://lexical.io">
      <strong
        class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic PlaygroundEditorTheme__textStrikethrough"
        data-lexical-text="true">
        with links
      </strong>
    </a>
    <span data-lexical-text="true">too</span>
  </p>
  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
    <span data-lexical-text="true">Links</span>
    <a
      class="PlaygroundEditorTheme__link"
      href="https://lexical.io/tag_here_and__here__and___here___too">
      <span data-lexical-text="true">with underscores</span>
    </a>
    <span data-lexical-text="true">and (</span>
    <a class="PlaygroundEditorTheme__link" href="https://lexical.dev">
      <span data-lexical-text="true">parenthesis</span>
    </a>
    <span data-lexical-text="true">)</span>
  </p>
  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
    <em class="PlaygroundEditorTheme__textItalic" data-lexical-text="true">
      Nested
    </em>
    <strong
      class="PlaygroundEditorTheme__textBold PlaygroundEditorTheme__textItalic"
      data-lexical-text="true">
      stars tags
    </strong>
    <em class="PlaygroundEditorTheme__textItalic" data-lexical-text="true">
      are handled too
    </em>
  </p>
  <h3 class="PlaygroundEditorTheme__h3" dir="auto">
    <span data-lexical-text="true">Headings</span>
  </h3>
  <h1 class="PlaygroundEditorTheme__h1" dir="auto">
    <span data-lexical-text="true">h1 Heading</span>
  </h1>
  <h2 class="PlaygroundEditorTheme__h2" dir="auto">
    <span data-lexical-text="true">h2 Heading</span>
  </h2>
  <h3 class="PlaygroundEditorTheme__h3" dir="auto">
    <span data-lexical-text="true">h3 Heading</span>
  </h3>
  <h4 class="PlaygroundEditorTheme__h4" dir="auto">
    <span data-lexical-text="true">h4 Heading</span>
  </h4>
  <h5 class="PlaygroundEditorTheme__h5" dir="auto">
    <span data-lexical-text="true">h5 Heading</span>
  </h5>
  <h6 class="PlaygroundEditorTheme__h6" dir="auto">
    <span data-lexical-text="true">h6 Heading</span>
  </h6>
  <h3 class="PlaygroundEditorTheme__h3" dir="auto">
    <span data-lexical-text="true">Horizontal Rules</span>
  </h3>
  <hr
    class="PlaygroundEditorTheme__hr"
    contenteditable="false"
    data-lexical-decorator="true" />
  <h3 class="PlaygroundEditorTheme__h3" dir="auto">
    <span data-lexical-text="true">Blockquotes</span>
  </h3>
  <blockquote class="PlaygroundEditorTheme__quote" dir="auto">
    <span data-lexical-text="true">Blockquotes text goes here</span>
    <br />
    <span data-lexical-text="true">And second</span>
    <br />
    <span data-lexical-text="true">line after</span>
  </blockquote>
  <blockquote class="PlaygroundEditorTheme__quote" dir="auto">
    <span data-lexical-text="true">Standalone again</span>
  </blockquote>
  <h3 class="PlaygroundEditorTheme__h3" dir="auto">
    <span data-lexical-text="true">Unordered lists</span>
  </h3>
  <ul class="PlaygroundEditorTheme__ul" dir="auto">
    <li class="PlaygroundEditorTheme__listItem" value="1">
      <span data-lexical-text="true">Create a list with</span>
      <code spellcheck="false" data-lexical-text="true">
        <span class="PlaygroundEditorTheme__textCode">+</span>
      </code>
      <span data-lexical-text="true">,</span>
      <code spellcheck="false" data-lexical-text="true">
        <span class="PlaygroundEditorTheme__textCode">-</span>
      </code>
      <span data-lexical-text="true">, or</span>
      <code spellcheck="false" data-lexical-text="true">
        <span class="PlaygroundEditorTheme__textCode">*</span>
      </code>
    </li>
    <li
      class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
      value="2">
      <ul class="PlaygroundEditorTheme__ul">
        <li class="PlaygroundEditorTheme__listItem" value="1">
          <span data-lexical-text="true">
            Lists can be indented with 2 spaces
          </span>
        </li>
        <li
          class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
          value="2">
          <ul class="PlaygroundEditorTheme__ul">
            <li class="PlaygroundEditorTheme__listItem" value="1">
              <span data-lexical-text="true">Very easy</span>
            </li>
          </ul>
        </li>
      </ul>
    </li>
  </ul>
  <h3 class="PlaygroundEditorTheme__h3" dir="auto">
    <span data-lexical-text="true">Ordered lists</span>
  </h3>
  <ol class="PlaygroundEditorTheme__ol1" dir="auto">
    <li class="PlaygroundEditorTheme__listItem" value="1">
      <span data-lexical-text="true">
        Oredered lists started with numbers as
      </span>
      <code spellcheck="false" data-lexical-text="true">
        <span class="PlaygroundEditorTheme__textCode">1.</span>
      </code>
    </li>
    <li
      class="PlaygroundEditorTheme__listItem PlaygroundEditorTheme__nestedListItem"
      value="2">
      <ol class="PlaygroundEditorTheme__ol2">
        <li class="PlaygroundEditorTheme__listItem" value="1">
          <span data-lexical-text="true">And can be nested</span>
          <br />
          <span data-lexical-text="true">and multiline as well</span>
        </li>
      </ol>
    </li>
  </ol>
  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
    <span data-lexical-text="true">.</span>
  </p>
  <ol class="PlaygroundEditorTheme__ol1" dir="auto" start="31">
    <li class="PlaygroundEditorTheme__listItem" value="31">
      <span data-lexical-text="true">Have any starting number</span>
    </li>
  </ol>
  <h3 class="PlaygroundEditorTheme__h3" dir="auto">
    <span data-lexical-text="true">Inline code</span>
  </h3>
  <p class="PlaygroundEditorTheme__paragraph" dir="auto">
    <span data-lexical-text="true">Inline</span>
    <code spellcheck="false" data-lexical-text="true">
      <span class="PlaygroundEditorTheme__textCode">code</span>
    </code>
    <span data-lexical-text="true">format which also</span>
    <code spellcheck="false" data-lexical-text="true">
      <span class="PlaygroundEditorTheme__textCode">
        preserves **_~~any markdown-like~~_** text
      </span>
    </code>
    <span data-lexical-text="true">within</span>
  </p>
  <h3 class="PlaygroundEditorTheme__h3" dir="auto">
    <span data-lexical-text="true">Code blocks</span>
  </h3>
  <code
    class="PlaygroundEditorTheme__code"
    dir="auto"
    spellcheck="false"
    data-gutter="123"
    data-highlight-language="javascript"
    data-language="javascript">
    <span class="PlaygroundEditorTheme__tokenComment" data-lexical-text="true">
      // Some comments
    </span>
    <br />
    <span class="PlaygroundEditorTheme__tokenProperty" data-lexical-text="true">
      1
    </span>
    <span data-lexical-text="true"></span>
    <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
      +
    </span>
    <span data-lexical-text="true"></span>
    <span class="PlaygroundEditorTheme__tokenProperty" data-lexical-text="true">
      1
    </span>
    <span data-lexical-text="true"></span>
    <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
      =
    </span>
    <span data-lexical-text="true"></span>
    <span class="PlaygroundEditorTheme__tokenProperty" data-lexical-text="true">
      2
    </span>
    <span
      class="PlaygroundEditorTheme__tokenPunctuation"
      data-lexical-text="true">
      ;
    </span>
    <br />
    <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
      **
    </span>
    <span data-lexical-text="true">_</span>
    <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
      ~
    </span>
    <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
      ~
    </span>
    <span class="PlaygroundEditorTheme__tokenProperty" data-lexical-text="true">
      1
    </span>
    <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
      ~
    </span>
    <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
      ~
    </span>
    <span data-lexical-text="true">_</span>
    <span class="PlaygroundEditorTheme__tokenOperator" data-lexical-text="true">
      **
    </span>
  </code>
`;
