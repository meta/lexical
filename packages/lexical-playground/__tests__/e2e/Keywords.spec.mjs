/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveLeft,
  moveToPrevWord,
  toggleBold,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  focusEditor,
  html,
  initialize,
  test,
  waitForSelector,
} from '../utils/index.mjs';

test.describe('Keywords', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test(`Can create a decorator and move selection around it`, async ({
    page,
    browserName,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('congrats');

    await waitForSelector(page, '.keyword');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="keyword"
            style="cursor: default;"
            data-lexical-text="true">
            congrats
          </span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 8,
      anchorPath: [0, 0, 0],
      focusOffset: 8,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.type('c');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">congratsc</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 9,
      anchorPath: [0, 0, 0],
      focusOffset: 9,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Space');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="keyword"
            style="cursor: default;"
            data-lexical-text="true">
            congrats
          </span>
          <span data-lexical-text="true">c</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [0, 1, 0],
      focusOffset: 1,
      focusPath: [0, 1, 0],
    });

    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('ongrats');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="keyword"
            style="cursor: default;"
            data-lexical-text="true">
            congrats
          </span>
          <span data-lexical-text="true"></span>
          <span
            class="keyword"
            style="cursor: default;"
            data-lexical-text="true">
            congrats
          </span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 8,
      anchorPath: [0, 2, 0],
      focusOffset: 8,
      focusPath: [0, 2, 0],
    });

    await moveLeft(page, 8);
    if (browserName === 'firefox') {
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [0, 2, 0],
        focusOffset: 0,
        focusPath: [0, 2, 0],
      });
    } else {
      await assertSelection(page, {
        anchorOffset: 1,
        anchorPath: [0, 1, 0],
        focusOffset: 1,
        focusPath: [0, 1, 0],
      });
    }

    await page.keyboard.press('Backspace');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">congratscongrats</span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 8,
      anchorPath: [0, 0, 0],
      focusOffset: 8,
      focusPath: [0, 0, 0],
    });

    await page.keyboard.press('Space');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="keyword"
            style="cursor: default;"
            data-lexical-text="true">
            congrats
          </span>
          <span data-lexical-text="true"></span>
          <span
            class="keyword"
            style="cursor: default;"
            data-lexical-text="true">
            congrats
          </span>
        </p>
      `,
    );
    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [0, 1, 0],
      focusOffset: 1,
      focusPath: [0, 1, 0],
    });
  });

  test('Can type congrats[Team]!', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('congrats[Team]!');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span
            class="keyword"
            style="cursor: default;"
            data-lexical-text="true">
            congrats
          </span>
          <span data-lexical-text="true">[Team]!</span>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 7,
      anchorPath: [0, 1, 0],
      focusOffset: 7,
      focusPath: [0, 1, 0],
    });
  });

  test.describe(() => {
    test.skip(({isPlainText}) => isPlainText);
    test('Can type "congrats Bob!" where " Bob!" is bold', async ({page}) => {
      await focusEditor(page);
      await page.keyboard.type('congrats');

      await waitForSelector(page, '.keyword');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span
              class="keyword"
              style="cursor: default;"
              data-lexical-text="true">
              congrats
            </span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 8,
        anchorPath: [0, 0, 0],
        focusOffset: 8,
        focusPath: [0, 0, 0],
      });

      await toggleBold(page);

      await page.keyboard.type(' Bob!');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span
              class="keyword"
              style="cursor: default;"
              data-lexical-text="true">
              congrats
            </span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              Bob!
            </strong>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 5,
        anchorPath: [0, 1, 0],
        focusOffset: 5,
        focusPath: [0, 1, 0],
      });

      await moveLeft(page, 4);

      await assertSelection(page, {
        anchorOffset: 1,
        anchorPath: [0, 1, 0],
        focusOffset: 1,
        focusPath: [0, 1, 0],
      });

      await page.keyboard.press('Backspace');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">congrats</span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              Bob!
            </strong>
          </p>
        `,
      );

      await page.keyboard.press('Space');

      // deleteCharacter builds its selection in the model (#8766), so the
      // post-backspace state — and therefore the DOM produced by the space
      // insertion — is the same in every browser.
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span
              class="keyword"
              style="cursor: default;"
              data-lexical-text="true">
              congrats
            </span>
            <span data-lexical-text="true"></span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              Bob!
            </strong>
          </p>
        `,
      );

      await assertSelection(page, {
        anchorOffset: 1,
        anchorPath: [0, 1, 0],
        focusOffset: 1,
        focusPath: [0, 1, 0],
      });
    });

    test('Can type "Everyone congrats!" where "Everyone " and "!" are bold', async ({
      page,
    }) => {
      await focusEditor(page);

      await toggleBold(page);
      await page.keyboard.type('Everyone ');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              Everyone
            </strong>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 9,
        anchorPath: [0, 0, 0],
        focusOffset: 9,
        focusPath: [0, 0, 0],
      });

      await toggleBold(page);

      await page.keyboard.type('congrats');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              Everyone
            </strong>
            <span
              class="keyword"
              style="cursor: default;"
              data-lexical-text="true">
              congrats
            </span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 8,
        anchorPath: [0, 1, 0],
        focusOffset: 8,
        focusPath: [0, 1, 0],
      });

      await page.keyboard.type('!');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              Everyone
            </strong>
            <span
              class="keyword"
              style="cursor: default;"
              data-lexical-text="true">
              congrats
            </span>
            <span data-lexical-text="true">!</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 1,
        anchorPath: [0, 2, 0],
        focusOffset: 1,
        focusPath: [0, 2, 0],
      });

      await page.keyboard.press('Backspace');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              Everyone
            </strong>
            <span
              class="keyword"
              style="cursor: default;"
              data-lexical-text="true">
              congrats
            </span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 8,
        anchorPath: [0, 1, 0],
        focusOffset: 8,
        focusPath: [0, 1, 0],
      });

      await toggleBold(page);

      await page.keyboard.type('!');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              Everyone
            </strong>
            <span
              class="keyword"
              style="cursor: default;"
              data-lexical-text="true">
              congrats
            </span>
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              !
            </strong>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 1,
        anchorPath: [0, 2, 0],
        focusOffset: 1,
        focusPath: [0, 2, 0],
      });

      await page.keyboard.press('Backspace');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              Everyone
            </strong>
            <span
              class="keyword"
              style="cursor: default;"
              data-lexical-text="true">
              congrats
            </span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 8,
        anchorPath: [0, 1, 0],
        focusOffset: 8,
        focusPath: [0, 1, 0],
      });

      await moveToPrevWord(page);

      await page.keyboard.press('Backspace');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              Everyone
            </strong>
            <span data-lexical-text="true">congrats</span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 8,
        anchorPath: [0, 0, 0],
        focusOffset: 8,
        focusPath: [0, 0, 0],
      });

      await page.keyboard.press('Space');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <strong
              class="PlaygroundEditorTheme__textBold"
              data-lexical-text="true">
              Everyone
            </strong>
            <span
              class="keyword"
              style="cursor: default;"
              data-lexical-text="true">
              congrats
            </span>
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 9,
        anchorPath: [0, 0, 0],
        focusOffset: 9,
        focusPath: [0, 0, 0],
      });
    });
  });
});
