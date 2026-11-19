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
  moveToEditorBeginning,
  moveToEditorEnd,
  moveToLineBeginning,
  moveToLineEnd,
  selectAll,
} from '../../../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  click,
  copyToClipboard,
  focusEditor,
  html,
  initialize,
  insertYouTubeEmbed,
  IS_LINUX,
  keyDownCtrlOrMeta,
  keyUpCtrlOrMeta,
  pasteFromClipboard,
  test,
  withExclusiveClipboardAccess,
  YOUTUBE_SAMPLE_URL,
} from '../../../utils/index.mjs';

test.describe('CopyAndPaste', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test('Basic copy + paste', async ({isRichText, page, browserName}) => {
    await focusEditor(page);

    // Add paragraph
    await page.keyboard.type('Copy + pasting?');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Sounds good!');
    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Copy + pasting?</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Sounds good!</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 12,
        anchorPath: [2, 0, 0],
        focusOffset: 12,
        focusPath: [2, 0, 0],
      });
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Copy + pasting?</span>
            <br />
            <br />
            <span data-lexical-text="true">Sounds good!</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 12,
        anchorPath: [0, 3, 0],
        focusOffset: 12,
        focusPath: [0, 3, 0],
      });
    }

    // Select all the text
    await selectAll(page);
    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Copy + pasting?</span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Sounds good!</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0, 0, 0],
        focusOffset: 12,
        focusPath: [2, 0, 0],
      });
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Copy + pasting?</span>
            <br />
            <br />
            <span data-lexical-text="true">Sounds good!</span>
          </p>
        `,
      );

      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0, 0, 0],
        focusOffset: 12,
        focusPath: [0, 3, 0],
      });
    }

    // Copy all the text
    {
      const clipboard = await copyToClipboard(page);
      if (isRichText) {
        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Copy + pasting?</span>
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Sounds good!</span>
            </p>
          `,
        );
      } else {
        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Copy + pasting?</span>
              <br />
              <br />
              <span data-lexical-text="true">Sounds good!</span>
            </p>
          `,
        );
      }

      // Paste after
      await page.keyboard.press('ArrowRight');
      await pasteFromClipboard(page, clipboard);
      if (isRichText) {
        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Copy + pasting?</span>
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Sounds good!Copy + pasting?</span>
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Sounds good!</span>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 12,
          anchorPath: [4, 0, 0],
          focusOffset: 12,
          focusPath: [4, 0, 0],
        });
      } else {
        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Copy + pasting?</span>
              <br />
              <br />
              <span data-lexical-text="true">Sounds good!Copy + pasting?</span>
              <br />
              <br />
              <span data-lexical-text="true">Sounds good!</span>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 12,
          anchorPath: [0, 6, 0],
          focusOffset: 12,
          focusPath: [0, 6, 0],
        });
      }
    }
  });

  test.describe(() => {
    test.fixme(
      ({browserName, isCollab, isPlainText}) => isCollab && IS_LINUX,
      'Flaky on Linux + Collab',
    );
    test.skip(({browserName, isCollab, isPlainText}) => isPlainText);
    test.fixme(
      ({browserName, isCollab, isPlainText}) =>
        IS_LINUX && browserName === 'chromium',
      'Flaky on Linux + Chromium',
    );
    test(`Copy and paste heading`, async ({page}) => {
      await focusEditor(page);
      await page.keyboard.type('# Heading');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Some text');

      await moveToEditorBeginning(page);
      await page.keyboard.down('Shift');
      await moveToLineEnd(page);
      await page.keyboard.up('Shift');

      {
        const clipboard = await copyToClipboard(page);

        await moveToEditorEnd(page);
        await page.keyboard.press('Enter');

        // Paste the content
        await pasteFromClipboard(page, clipboard);

        await assertHTML(
          page,
          html`
            <h1 class="PlaygroundEditorTheme__h1" dir="auto">
              <span data-lexical-text="true">Heading</span>
            </h1>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Some text</span>
            </p>
            <h1 class="PlaygroundEditorTheme__h1" dir="auto">
              <span data-lexical-text="true">Heading</span>
            </h1>
          `,
        );

        await assertSelection(page, {
          anchorOffset: 7,
          anchorPath: [2, 0, 0],
          focusOffset: 7,
          focusPath: [2, 0, 0],
        });
      }
    });
  });

  test(`Copy and paste between sections`, async ({isRichText, page}) => {
    await focusEditor(page);
    await page.keyboard.type('Hello world #foobar test #foobar2 when #not');

    await page.keyboard.press('Enter');
    await page.keyboard.type('Next #line of #text test #foo');

    if (isRichText) {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Hello world</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #foobar
            </span>
            <span data-lexical-text="true">test</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #foobar2
            </span>
            <span data-lexical-text="true">when</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #not
            </span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Next</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #line
            </span>
            <span data-lexical-text="true">of</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #text
            </span>
            <span data-lexical-text="true">test</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #foo
            </span>
          </p>
        `,
      );

      await assertSelection(page, {
        anchorOffset: 4,
        anchorPath: [1, 5, 0],
        focusOffset: 4,
        focusPath: [1, 5, 0],
      });
    } else {
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Hello world</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #foobar
            </span>
            <span data-lexical-text="true">test</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #foobar2
            </span>
            <span data-lexical-text="true">when</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #not
            </span>
            <br />
            <span data-lexical-text="true">Next</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #line
            </span>
            <span data-lexical-text="true">of</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #text
            </span>
            <span data-lexical-text="true">test</span>
            <span
              class="PlaygroundEditorTheme__hashtag"
              data-lexical-text="true">
              #foo
            </span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 4,
        anchorPath: [0, 12, 0],
        focusOffset: 4,
        focusPath: [0, 12, 0],
      });
    }

    // Select all the content
    await selectAll(page);

    if (isRichText) {
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0, 0, 0],
        focusOffset: 4,
        focusPath: [1, 5, 0],
      });
    } else {
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0, 0, 0],
        focusOffset: 4,
        focusPath: [0, 12, 0],
      });
    }

    {
      // Copy all the text
      let clipboard = await copyToClipboard(page);
      await page.keyboard.press('Delete');
      // Paste the content
      await pasteFromClipboard(page, clipboard);

      if (isRichText) {
        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Hello world</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #foobar
              </span>
              <span data-lexical-text="true">test</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #foobar2
              </span>
              <span data-lexical-text="true">when</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #not
              </span>
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Next</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #line
              </span>
              <span data-lexical-text="true">of</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #text
              </span>
              <span data-lexical-text="true">test</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #foo
              </span>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 4,
          anchorPath: [1, 5, 0],
          focusOffset: 4,
          focusPath: [1, 5, 0],
        });
      } else {
        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Hello world</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #foobar
              </span>
              <span data-lexical-text="true">test</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #foobar2
              </span>
              <span data-lexical-text="true">when</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #not
              </span>
              <br />
              <span data-lexical-text="true">Next</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #line
              </span>
              <span data-lexical-text="true">of</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #text
              </span>
              <span data-lexical-text="true">test</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #foo
              </span>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 4,
          anchorPath: [0, 12, 0],
          focusOffset: 4,
          focusPath: [0, 12, 0],
        });
      }

      // Select backwards from "#|foo" in the second section to " |test " in
      // the first. Shift+ArrowUp keeps the caret's x position, so where it
      // lands on the line above depends on glyph widths, and how many word
      // moves reach " test " from there depends on the platform. Extending to
      // the start of that line and counting characters works with any font.
      await moveLeft(page, 'foo'.length);
      await page.keyboard.down('Shift');
      await page.keyboard.press('ArrowUp');
      await moveToLineBeginning(page);
      await moveRight(page, 'Hello world #foobar '.length);
      await page.keyboard.up('Shift');

      if (isRichText) {
        await assertSelection(page, {
          anchorOffset: 1,
          anchorPath: [1, 5, 0],
          focusOffset: 1,
          focusPath: [0, 2, 0],
        });
      } else {
        await assertSelection(page, {
          anchorOffset: 1,
          anchorPath: [0, 12, 0],
          focusOffset: 1,
          focusPath: [0, 2, 0],
        });
      }

      // Copy selected text
      clipboard = await copyToClipboard(page);
      await page.keyboard.press('Delete');
      // Paste the content
      await pasteFromClipboard(page, clipboard);

      if (isRichText) {
        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Hello world</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #foobar
              </span>
              <span data-lexical-text="true">test</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #foobar2
              </span>
              <span data-lexical-text="true">when</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #not
              </span>
            </p>
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Next</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #line
              </span>
              <span data-lexical-text="true">of</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #text
              </span>
              <span data-lexical-text="true">test</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #foo
              </span>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 1,
          anchorPath: [1, 5, 0],
          focusOffset: 1,
          focusPath: [1, 5, 0],
        });
      } else {
        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <span data-lexical-text="true">Hello world</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #foobar
              </span>
              <span data-lexical-text="true">test</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #foobar2
              </span>
              <span data-lexical-text="true">when</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #not
              </span>
              <br />
              <span data-lexical-text="true">Next</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #line
              </span>
              <span data-lexical-text="true">of</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #text
              </span>
              <span data-lexical-text="true">test</span>
              <span
                class="PlaygroundEditorTheme__hashtag"
                data-lexical-text="true">
                #foo
              </span>
            </p>
          `,
        );
        await assertSelection(page, {
          anchorOffset: 1,
          anchorPath: [0, 12, 0],
          focusOffset: 1,
          focusPath: [0, 12, 0],
        });
      }

      // Select all the content
      await selectAll(page);

      if (isRichText) {
        await assertSelection(page, {
          anchorOffset: 0,
          anchorPath: [0, 0, 0],
          focusOffset: 4,
          focusPath: [1, 5, 0],
        });
      } else {
        await assertSelection(page, {
          anchorOffset: 0,
          anchorPath: [0, 0, 0],
          focusOffset: 4,
          focusPath: [0, 12, 0],
        });
      }

      await page.keyboard.press('Delete');
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0],
        focusOffset: 0,
        focusPath: [0],
      });
    }
  });

  test.describe(() => {
    test.skip(({isPlainText}) => isPlainText);
    test('Copy and paste an inline element into a leaf node', async ({
      page,
    }) => {
      await focusEditor(page);

      // Root
      //   |- Paragraph
      //      |- Link
      //         |- Text "Hello"
      //      |- Text "World"
      await page.keyboard.type('Hello');
      await selectAll(page);
      await click(page, '.link');
      await click(page, '.link-confirm');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Space');
      await page.keyboard.type('World');

      await selectAll(page);

      {
        const clipboard = await copyToClipboard(page);

        await page.keyboard.press('ArrowRight');

        await pasteFromClipboard(page, clipboard);
      }

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <a
              class="PlaygroundEditorTheme__link"
              href="https://"
              rel="noreferrer">
              <span data-lexical-text="true">Hello</span>
            </a>
            <span data-lexical-text="true">World</span>
            <a
              class="PlaygroundEditorTheme__link"
              href="https://"
              rel="noreferrer">
              <span data-lexical-text="true">Hello</span>
            </a>
            <span data-lexical-text="true">World</span>
          </p>
        `,
      );
    });

    test('Copy + paste multi-line plain text into rich text produces separate paragraphs', async ({
      page,
    }) => {
      await focusEditor(page);
      await page.keyboard.type('# Hello ');
      await pasteFromClipboard(page, {
        'text/plain': 'world\nAnd text below',
      });
      await assertHTML(
        page,
        html`
          <h1 class="PlaygroundEditorTheme__h1" dir="auto">
            <span data-lexical-text="true">Hello world</span>
          </h1>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">And text below</span>
          </p>
        `,
      );
    });
  });

  test.describe(() => {
    test.skip(({isCollab, isPlainText}) => isPlainText || isCollab);
    test('Pasting a decorator node on a blank line inserts before the line', async ({
      page,
    }) => {
      // TODO: This is skipped on collab because the right frame won't have the block cursor HTML

      // copying and pasting the node is easier than creating the clipboard data
      await focusEditor(page);
      await insertYouTubeEmbed(page, YOUTUBE_SAMPLE_URL);
      await page.keyboard.press('ArrowLeft'); // this selects the node
      {
        const clipboard = await copyToClipboard(page);
        await page.keyboard.press('ArrowRight'); // this moves to a new line (empty paragraph node)
        await pasteFromClipboard(page, clipboard);

        await assertHTML(
          page,
          html`
            <p class="PlaygroundEditorTheme__paragraph" dir="auto">
              <br data-lexical-managed-linebreak="true" />
            </p>
            <div contenteditable="false" data-lexical-decorator="true">
              <div class="PlaygroundEditorTheme__embedBlock">
                <iframe
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowfullscreen=""
                  frameborder="0"
                  height="315"
                  src="https://www.youtube-nocookie.com/embed/jNQXAC9IVRw"
                  title="YouTube video"
                  width="560"></iframe>
              </div>
            </div>
            <div contenteditable="false" data-lexical-decorator="true">
              <div class="PlaygroundEditorTheme__embedBlock">
                <iframe
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowfullscreen=""
                  frameborder="0"
                  height="315"
                  src="https://www.youtube-nocookie.com/embed/jNQXAC9IVRw"
                  title="YouTube video"
                  width="560"></iframe>
              </div>
            </div>
            <div
              class="PlaygroundEditorTheme__blockCursor"
              contenteditable="false"
              data-lexical-cursor="true"></div>
          `,
        );
      }
    });
  });

  test.describe(() => {
    test.skip(({isPlainText}) => isPlainText);
    test('Copy and paste paragraph into quote', async ({page}) => {
      await focusEditor(page);

      await page.keyboard.type('Hello world');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Some text');

      await selectAll(page);

      {
        const clipboard = await copyToClipboard(page);

        await page.keyboard.type('> ');

        await pasteFromClipboard(page, clipboard);
      }
      await assertHTML(
        page,
        html`
          <blockquote class="PlaygroundEditorTheme__quote" dir="auto">
            <span data-lexical-text="true">Hello world</span>
          </blockquote>
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Some text</span>
          </p>
        `,
      );
    });

    test('Process font-size from content copied from Google Docs/MS Word', async ({
      page,
    }) => {
      await focusEditor(page);

      const clipboard = {
        'text/html': `<meta charset='utf-8'><meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1e6b36e2-7fff-9788-e6e2-d502cc6babbf"><p dir="ltr" style="line-height:1.56;margin-top:10pt;margin-bottom:0pt;"><span style="font-size:24pt;font-family:Lato,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Random text at </span><span style="font-size:36pt;font-family:Lato,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">36 pt</span></p></b>`,
      };

      await pasteFromClipboard(page, clipboard);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
            <span style="font-size: 24pt" data-lexical-text="true">
              Random text at
            </span>
            <span style="font-size: 36pt" data-lexical-text="true">36 pt</span>
          </p>
        `,
      );
    });

    test('test font-size in pt and px both are processed correctly', async ({
      page,
    }) => {
      await focusEditor(page);

      const clipboard = {
        'text/html': `<meta charset='utf-8'><meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-2d2ed25f-7fff-2f5a-2422-f7e624a743db"><p dir="ltr" style="line-height:1.56;margin-top:10pt;margin-bottom:0pt;"><span style="font-size:24px;font-family:Lato,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Text in 24px</span></p><p dir="ltr" style="line-height:1.56;margin-top:10pt;margin-bottom:0pt;"><span style="font-size:36pt;font-family:Lato,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Text in 36pt</span></p></b>`,
      };

      await pasteFromClipboard(page, clipboard);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
            <span style="font-size: 24px;" data-lexical-text="true">
              Text in 24px
            </span>
          </p>
          <p class="PlaygroundEditorTheme__paragraph" dir="ltr">
            <span style="font-size: 36pt;" data-lexical-text="true">
              Text in 36pt
            </span>
          </p>
        `,
      );
    });
  });

  test('Cut then copy empty selection preserves clipboard', async ({
    isRichText,
    page,
    context,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Hello world');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello world</span>
        </p>
      `,
    );

    // Select all and cut
    await selectAll(page);
    await withExclusiveClipboardAccess(async () => {
      await keyDownCtrlOrMeta(page);
      await page.keyboard.press('x');
      await keyUpCtrlOrMeta(page);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );

      // Copy with a collapsed selection, we expect it to not change the clipboard
      await keyDownCtrlOrMeta(page);
      await page.keyboard.press('c');
      await keyUpCtrlOrMeta(page);

      // Paste what was on the clipboard back into the document
      await keyDownCtrlOrMeta(page);
      await page.keyboard.press('v');
      await keyUpCtrlOrMeta(page);
    });

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello world</span>
        </p>
      `,
    );
  });
});
