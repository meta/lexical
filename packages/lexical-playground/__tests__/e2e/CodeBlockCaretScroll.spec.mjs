/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveToLineBeginning,
  moveToLineEnd,
} from '../keyboardShortcuts/index.mjs';
import {
  evaluate,
  expect,
  focusEditor,
  initialize,
  locate,
  test,
} from '../utils/index.mjs';

const CODE = 'code.PlaygroundEditorTheme__code';

const LONG_LINE = Array.from(
  {length: 40},
  (_, i) => `<a class="item-${i}" href="/p/${i}">${i}</a>`,
)
  .join('')
  .slice(0, 655);
const INDENTED_LINE = ' '.repeat(12) + LONG_LINE.slice(0, 400);

/**
 * Types an html code block with these lines. Enter copies the indentation
 * of the line above, so indented lines have to come last. The text is
 * inserted rather than typed key by key, which would be slow for lines
 * this long.
 */
async function createCodeBlock(page, lines) {
  await focusEditor(page);
  await page.keyboard.type('```html ');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      await page.keyboard.press('Enter');
    }
    if (lines[i] !== '') {
      await page.keyboard.insertText(lines[i]);
    }
  }
  await expect.poll(() => getCodeLines(page)).toEqual(lines);
}

/** The lines of the first code block, read from the editor state. */
async function getCodeLines(page) {
  return await evaluate(page, () => {
    const code = window.lexicalEditor.getEditorState().toJSON().root
      .children[0];
    if (code.type !== 'code') {
      return null;
    }
    return code.children
      .map(child => (child.type === 'linebreak' ? '\n' : child.text))
      .join('')
      .split('\n');
  });
}

async function measure(page) {
  return await evaluate(
    page,
    selector => {
      const code = document.querySelector(selector);
      const selection = document.getSelection();
      if (code === null || selection.rangeCount === 0) {
        return null;
      }
      let caret = selection.getRangeAt(0).getBoundingClientRect();
      if (
        caret.top === 0 &&
        caret.bottom === 0 &&
        caret.left === 0 &&
        caret.right === 0
      ) {
        // A caret between two elements has no rect of its own. Use the
        // element after it.
        const child = selection.focusNode.childNodes[selection.focusOffset];
        if (!child || child.nodeType !== Node.ELEMENT_NODE) {
          return null;
        }
        caret = child.getBoundingClientRect();
      }
      const rect = code.getBoundingClientRect();
      const scrollportLeft = rect.left + code.clientLeft;
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      const firstText = walker.nextNode();
      if (firstText === null) {
        return null;
      }
      range.setStart(firstText, 0);
      return {
        caretLeft: caret.left,
        caretRight: caret.right,
        // Where the text of a line starts with the block scrolled all the way
        // back: just after the gutter, whatever its width.
        lineStartX: range.getBoundingClientRect().left + code.scrollLeft,
        scrollLeft: code.scrollLeft,
        scrollportLeft,
        scrollportRight: scrollportLeft + code.clientWidth,
      };
    },
    CODE,
  );
}

/**
 * Polls the code block's geometry until `check` passes. On a timeout the
 * failure shows the last measurement.
 */
async function pollGeometry(page, check) {
  await expect
    .poll(async () => {
      const m = await measure(page);
      // null means there was no caret to measure.
      return m !== null && check(m) ? 'ok' : JSON.stringify(m);
    })
    .toBe('ok');
}

test.skip(
  ({isCollab, isPlainText}) => isPlainText || isCollab,
  'Requires rich text without collaboration',
);

test.describe('Code block caret scrolling', () => {
  test('Home, End and Enter keep the caret visible in long lines', async ({
    page,
    isCollab,
    browserName,
  }) => {
    await initialize({isCollab, page});
    await createCodeBlock(page, [LONG_LINE, INDENTED_LINE]);
    // The data-gutter float numbers the lines.
    await expect(locate(page, CODE)).toHaveAttribute('data-gutter', '1\n2');

    // The caret is at the end of the indented line, and the block is
    // scrolled to show it. Smart Home stops after the indentation, and the
    // block scrolls all the way back.
    await pollGeometry(
      page,
      m => m.scrollLeft > 0 && m.caretRight <= m.scrollportRight,
    );
    await moveToLineBeginning(page);
    await pollGeometry(
      page,
      m => m.scrollLeft === 0 && m.caretLeft > m.lineStartX + 1,
    );

    await moveToLineEnd(page);
    await pollGeometry(
      page,
      m =>
        m.scrollLeft > 0 &&
        m.caretLeft >= m.lineStartX - 1 &&
        m.caretRight <= m.scrollportRight,
    );

    // The new line copies the 12 spaces of indentation.
    await page.keyboard.type('abc');
    await page.keyboard.press('Enter');
    await pollGeometry(
      page,
      m => m.scrollLeft === 0 && m.caretLeft > m.lineStartX + 1,
    );

    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Backspace');
    }
    await expect
      .poll(() => getCodeLines(page))
      .toEqual([LONG_LINE, INDENTED_LINE + 'abc', '']);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');

    // The end of the longest line, with the block scrolled as far as it goes.
    // Firefox leaves the theme's inline end padding out of the scroll range
    // while a sticky box is in the block, like the data-gutter float. On the
    // Windows CI runners it drew the caret here 0.25px past the right edge:
    // at x 1143.25, with scrollLeft 3699 and the scrollport ending at 1143.
    // So only this step allows 0.5px past the edge, and only in Firefox.
    const endSlack = browserName === 'firefox' ? 0.5 : 0;
    await moveToLineEnd(page);
    await pollGeometry(
      page,
      m =>
        m.scrollLeft > 0 &&
        m.caretLeft >= m.lineStartX - 1 &&
        m.caretRight <= m.scrollportRight + endSlack,
    );
    await moveToLineBeginning(page);
    await pollGeometry(
      page,
      m => m.scrollLeft === 0 && Math.abs(m.caretLeft - m.lineStartX) <= 1,
    );
  });
});
