/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveLeft,
  moveToEditorBeginning,
  moveToEditorEnd,
  pressShiftEnter,
  selectAll,
  selectCharacters,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  click,
  focusEditor,
  html,
  initialize,
  test,
} from '../utils/index.mjs';

async function toggleCodeBlock(page) {
  await click(page, '.block-controls');
  await click(page, '.dropdown .icon.code');
}

test.describe('CodeBlock', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test('Can create code block with markdown', async ({page, isRichText}) => {
    await focusEditor(page);
    await page.keyboard.type('``` alert(1);');
    if (isRichText) {
      await assertSelection(page, {
        anchorOffset: 9,
        anchorPath: [0, 0, 0],
        focusOffset: 9,
        focusPath: [0, 0, 0],
      });
      await assertHTML(
        page,
        html`
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="1">
            <span data-lexical-text="true">alert(1);</span>
          </code>
        `,
      );

      // Remove code block (back to a normal paragraph) and check that highlights are converted into regular text
      await moveToEditorBeginning(page);
      await page.keyboard.press('Backspace');
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">alert(1);</span>
          </p>
        `,
      );
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">\`\`\` alert(1);</span>
          </p>
        `,
      );
    }
  });

  test('Can create code block with markdown and wrap existing text', async ({
    page,
    isRichText,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('alert(1);');
    await moveToEditorBeginning(page);
    await page.keyboard.type('``` ');
    if (isRichText) {
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0, 0, 0],
        focusOffset: 0,
        focusPath: [0, 0, 0],
      });
      await assertHTML(
        page,
        html`
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="1">
            <span data-lexical-text="true">alert(1);</span>
          </code>
        `,
      );
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">\`\`\` alert(1);</span>
          </p>
        `,
      );
    }
  });

  test.describe(() => {
    test.skip(({isPlainText}) => isPlainText);
    test('Can select multiple paragraphs and convert to code block', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('foo');
      await page.keyboard.press('Enter');
      await page.keyboard.type('bar');
      await page.keyboard.press('Enter');
      await page.keyboard.type('yar');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.type('meh');

      await selectAll(page);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">foo</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">bar</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">yar</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">meh</span>
          </p>
        `,
      );

      await toggleCodeBlock(page);

      await assertHTML(
        page,
        html`
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="12345">
            <span data-lexical-text="true">foo</span>
            <br />
            <span data-lexical-text="true">bar</span>
            <br />
            <span data-lexical-text="true">yar</span>
            <br />
            <br />
            <span data-lexical-text="true">meh</span>
          </code>
        `,
      );
    });

    test('Can select partial paragraphs and convert to code block', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('foo');
      await page.keyboard.press('Enter');
      await page.keyboard.type('bar');
      await page.keyboard.press('Enter');
      await page.keyboard.type('yar');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.type('meh');
      await page.keyboard.down('Shift');
      await moveLeft(page, 10);
      await page.keyboard.up('Shift');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">foo</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">bar</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">yar</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">meh</span>
          </p>
        `,
      );

      await toggleCodeBlock(page);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">foo</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">ba</span>
          </p>
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="1234">
            <span data-lexical-text="true">r</span>
            <br />
            <span data-lexical-text="true">yar</span>
            <br />
            <br />
            <span data-lexical-text="true">meh</span>
          </code>
        `,
      );
    });

    test('Can select a line within line breaks and convert to code block', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('aaa');
      await pressShiftEnter(page);
      await page.keyboard.type('bbb');
      await pressShiftEnter(page);
      await page.keyboard.type('ccc');
      await moveLeft(page, 4);
      await selectCharacters(page, 'left', 3);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">aaa</span>
            <br />
            <span data-lexical-text="true">bbb</span>
            <br />
            <span data-lexical-text="true">ccc</span>
          </p>
        `,
      );

      await toggleCodeBlock(page);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">aaa</span>
          </p>
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="1">
            <span data-lexical-text="true">bbb</span>
          </code>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">ccc</span>
          </p>
        `,
      );
    });
  });

  test('Can switch highlighting language in a toolbar', async ({
    page,
    isRichText,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('``` select * from users');
    if (isRichText) {
      await assertHTML(
        page,
        html`
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="1">
            <span data-lexical-text="true">select * from users</span>
          </code>
        `,
      );
      await click(page, '.toolbar-item.code-language');
      await click(page, 'button:has-text("SQL")');
      await assertHTML(
        page,
        html`
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="1"
            data-highlight-language="sql"
            data-language="sql">
            <span
              class="PlaygroundEditorTheme__tokenAttr"
              data-lexical-text="true">
              select
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="PlaygroundEditorTheme__tokenOperator"
              data-lexical-text="true">
              *
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="PlaygroundEditorTheme__tokenAttr"
              data-lexical-text="true">
              from
            </span>
            <span data-lexical-text="true">users</span>
          </code>
        `,
      );
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">\`\`\` select * from users</span>
          </p>
        `,
      );
    }
  });

  test.describe(() => {
    test.skip(({isPlainText}) => isPlainText);
    test('Can maintain indent when creating new lines', async ({page}) => {
      await focusEditor(page);
      await page.keyboard.type('``` alert(1);');
      await page.keyboard.press('Enter');
      await click(page, '.toolbar-item.alignment');
      await click(page, 'button:has-text("Indent")');
      await page.keyboard.type('alert(2);');
      await page.keyboard.press('Enter');
      await page.keyboard.type(';');
      await assertHTML(
        page,
        html`
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="123">
            <span data-lexical-text="true">alert(1);</span>
            <br />
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span data-lexical-text="true">alert(2);</span>
            <br />
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span data-lexical-text="true">;</span>
          </code>
        `,
      );
    });

    test('Can (un)indent multiple lines at once', async ({page}) => {
      await focusEditor(page);
      await page.keyboard.type('``` if (x) {');
      await page.keyboard.press('Enter');
      await click(page, '.toolbar-item.alignment');
      await click(page, 'button:has-text("Indent")');
      await page.keyboard.type('x();');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Backspace');
      await page.keyboard.type('}');
      await assertHTML(
        page,
        html`
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="123">
            <span data-lexical-text="true">if (x) {</span>
            <br />
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span data-lexical-text="true">x();</span>
            <br />
            <span data-lexical-text="true">}</span>
          </code>
        `,
      );
      await page.keyboard.down('Shift');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.up('Shift');
      await click(page, '.toolbar-item.alignment');
      await click(page, 'button:has-text("Indent")');
      await click(page, '.toolbar-item.alignment');
      await click(page, 'button:has-text("Indent")');
      await assertHTML(
        page,
        html`
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="123">
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span data-lexical-text="true">if (x) {</span>
            <br />
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span data-lexical-text="true">x();</span>
            <br />
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span data-lexical-text="true">}</span>
          </code>
        `,
      );
      await page.keyboard.down('Shift');
      await click(page, '.toolbar-item.alignment');
      await click(page, 'button:has-text("Outdent")');
      await page.keyboard.up('Shift');
      await assertHTML(
        page,
        html`
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="123">
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span data-lexical-text="true">if (x) {</span>
            <br />
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span data-lexical-text="true">x();</span>
            <br />
            <span
              class="PlaygroundEditorTheme__tabNode"
              data-lexical-text="true"></span>
            <span data-lexical-text="true">}</span>
          </code>
        `,
      );
      await click(page, '.toolbar-item.alignment');
      await click(page, 'button:has-text("Outdent")');
      await click(page, '.toolbar-item.alignment');
      await click(page, 'button:has-text("Outdent")');
      await assertHTML(
        page,
        html`
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="123">
            <span data-lexical-text="true">if (x) {</span>
            <br />
            <span data-lexical-text="true">x();</span>
            <br />
            <span data-lexical-text="true">}</span>
          </code>
        `,
      );
    });
  });

  test('Can create code block with language `diff`', async ({
    page,
    isRichText,
  }) => {
    await focusEditor(page);
    await page.keyboard.type(
      '```diff >let a = 1;\n<let b = 2;\nlet c = 3;\n let d = 4;',
    );
    if (isRichText) {
      await assertHTML(
        page,
        html`
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="1234"
            data-highlight-language="diff"
            data-language="diff">
            <span
              class="PlaygroundEditorTheme__tokenInserted"
              data-lexical-text="true">
              &gt;
            </span>
            <span data-lexical-text="true">let a = 1;</span>
            <br />
            <span
              class="PlaygroundEditorTheme__tokenDeleted"
              data-lexical-text="true">
              &lt;
            </span>
            <span data-lexical-text="true">let b = 2;</span>
            <br />
            <span data-lexical-text="true">let c = 3;</span>
            <br />
            <span
              class="PlaygroundEditorTheme__tokenUnchanged"
              data-lexical-text="true"></span>
            <span data-lexical-text="true">let d = 4;</span>
          </code>
        `,
      );
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">\`\`\`diff &gt;let a = 1;</span>
            <br />
            <span data-lexical-text="true">&lt;let b = 2;</span>
            <br />
            <span data-lexical-text="true">let c = 3;</span>
            <br />
            <span data-lexical-text="true">let d = 4;</span>
          </p>
        `,
      );
    }
  });

  test('Can create code block with language `diff-javascript`', async ({
    page,
    isRichText,
  }) => {
    await focusEditor(page);
    await page.keyboard.type(
      '```diff-javascript +let a = 1;\n-let b = 2;\nlet c = 3;\n let d = 4;',
    );
    if (isRichText) {
      await assertHTML(
        page,
        html`
          <code
            class="PlaygroundEditorTheme__code"
            dir="auto"
            spellcheck="false"
            data-gutter="1234"
            data-highlight-language="diff-javascript"
            data-language="diff-javascript">
            <span
              class="PlaygroundEditorTheme__tokenInserted"
              data-lexical-text="true">
              +
            </span>
            <span
              class="PlaygroundEditorTheme__tokenAttr"
              data-lexical-text="true">
              let
            </span>
            <span data-lexical-text="true">a</span>
            <span
              class="PlaygroundEditorTheme__tokenOperator"
              data-lexical-text="true">
              =
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="PlaygroundEditorTheme__tokenProperty"
              data-lexical-text="true">
              1
            </span>
            <span
              class="PlaygroundEditorTheme__tokenPunctuation"
              data-lexical-text="true">
              ;
            </span>
            <br />
            <span
              class="PlaygroundEditorTheme__tokenDeleted"
              data-lexical-text="true">
              -
            </span>
            <span
              class="PlaygroundEditorTheme__tokenAttr"
              data-lexical-text="true">
              let
            </span>
            <span data-lexical-text="true">b</span>
            <span
              class="PlaygroundEditorTheme__tokenOperator"
              data-lexical-text="true">
              =
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="PlaygroundEditorTheme__tokenProperty"
              data-lexical-text="true">
              2
            </span>
            <span
              class="PlaygroundEditorTheme__tokenPunctuation"
              data-lexical-text="true">
              ;
            </span>
            <br />
            <span data-lexical-text="true">let c = 3;</span>
            <br />
            <span
              class="PlaygroundEditorTheme__tokenUnchanged"
              data-lexical-text="true"></span>
            <span
              class="PlaygroundEditorTheme__tokenAttr"
              data-lexical-text="true">
              let
            </span>
            <span data-lexical-text="true">d</span>
            <span
              class="PlaygroundEditorTheme__tokenOperator"
              data-lexical-text="true">
              =
            </span>
            <span data-lexical-text="true"></span>
            <span
              class="PlaygroundEditorTheme__tokenProperty"
              data-lexical-text="true">
              4
            </span>
            <span
              class="PlaygroundEditorTheme__tokenPunctuation"
              data-lexical-text="true">
              ;
            </span>
          </code>
        `,
      );
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">
              \`\`\`diff-javascript +let a = 1;
            </span>
            <br />
            <span data-lexical-text="true">-let b = 2;</span>
            <br />
            <span data-lexical-text="true">let c = 3;</span>
            <br />
            <span data-lexical-text="true">let d = 4;</span>
          </p>
        `,
      );
    }
  });

  for (const key of ['ArrowRight', 'ArrowDown']) {
    test.describe(() => {
      test.skip(({isCollab, isPlainText}) => isPlainText || isCollab);
      test(`${key} key should exit from the code block inside the layout`, async ({
        page,
      }) => {
        await initialize({page});
        await focusEditor(page);

        await page.keyboard.type('/');
        await click(page, '.typeahead-popover .icon.columns');
        await click(page, '.Modal__modal .Modal__content .Button__root');

        // remove empty paragraphs around the layout
        await moveToEditorEnd(page);
        await page.keyboard.press('Backspace');
        await moveToEditorBeginning(page);
        await page.keyboard.press('Backspace');

        // Focus on first column
        await click(
          page,
          '.PlaygroundEditorTheme__layoutContainer .PlaygroundEditorTheme__layoutItem:nth-child(1)',
        );
        await page.keyboard.type('```');
        await page.keyboard.press('Enter');

        // selection at the code
        await assertSelection(page, {
          anchorOffset: 0,
          anchorPath: [0, 0, 0],
          focusOffset: 0,
          focusPath: [0, 0, 0],
        });
        await assertHTML(
          page,
          html`
            <div
              class="PlaygroundEditorTheme__layoutContainer"
              dir="auto"
              style="grid-template-columns: 1fr 1fr">
              <div
                class="PlaygroundEditorTheme__layoutItem"
                dir="auto"
                data-lexical-layout-item="true">
                <code
                  class="PlaygroundEditorTheme__code"
                  dir="auto"
                  spellcheck="false"
                  data-gutter="1">
                  <br data-lexical-managed-linebreak="true" />
                </code>
              </div>
              <div
                class="PlaygroundEditorTheme__layoutItem"
                dir="auto"
                data-lexical-layout-item="true">
                <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                  <br data-lexical-managed-linebreak="true" />
                </p>
              </div>
            </div>
          `,
        );

        await page.keyboard.press(key);

        // selection at the new paragraph but inside the layout
        await assertSelection(page, {
          anchorOffset: 0,
          anchorPath: [0, 0, 1],
          focusOffset: 0,
          focusPath: [0, 0, 1],
        });
        await assertHTML(
          page,
          html`
            <div
              class="PlaygroundEditorTheme__layoutContainer"
              dir="auto"
              style="grid-template-columns: 1fr 1fr">
              <div
                class="PlaygroundEditorTheme__layoutItem"
                dir="auto"
                data-lexical-layout-item="true">
                <code
                  class="PlaygroundEditorTheme__code"
                  dir="auto"
                  spellcheck="false"
                  data-gutter="1">
                  <br data-lexical-managed-linebreak="true" />
                </code>
                <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                  <br data-lexical-managed-linebreak="true" />
                </p>
              </div>
              <div
                class="PlaygroundEditorTheme__layoutItem"
                dir="auto"
                data-lexical-layout-item="true">
                <p class="PlaygroundEditorTheme__paragraph" dir="auto">
                  <br data-lexical-managed-linebreak="true" />
                </p>
              </div>
            </div>
          `,
        );
      });
    });
  }
});
