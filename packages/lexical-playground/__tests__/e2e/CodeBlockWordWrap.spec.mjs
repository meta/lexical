/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {selectAll} from '../keyboardShortcuts/index.mjs';
import {
  click,
  copyToClipboard,
  evaluate,
  expect,
  focusEditor,
  initialize,
  locate,
  mouseMoveToSelector,
  test,
  waitForSelector,
} from '../utils/index.mjs';

const CODE = 'code.PlaygroundEditorTheme__code';
const WRAP_BUTTON = 'button[aria-label="wrap"]';

const LONG_LINE = Array.from(
  {length: 40},
  (_, i) => `<a class="item-${i}" href="/p/${i}">${i}</a>`,
)
  .join('')
  .slice(0, 655);
const LONG_TOKEN = 'https://example.com/' + 'a'.repeat(380);

// Makes the line numbers the only hit targets inside a code block, so
// elementFromPoint tells which number is drawn next to a row.
const NUMBER_HIT_TEST_CSS = [
  '.PlaygroundEditorTheme__code, .PlaygroundEditorTheme__code * { pointer-events: none !important; }',
  '.PlaygroundEditorTheme__code::before, .PlaygroundEditorTheme__code [data-lexical-code-line-break]::after { pointer-events: auto !important; }',
].join('\n');

/**
 * Types an html code block with these lines. The text is inserted rather
 * than typed key by key, which would be slow for lines this long.
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

async function getWordWrapJSON(page) {
  return await evaluate(
    page,
    () =>
      window.lexicalEditor.getEditorState().toJSON().root.children[0].wordWrap,
  );
}

/**
 * For each line after the first: which line break wrapper's number is drawn
 * at the start of the line's first row, as an index into the wrappers.
 */
async function getFirstRowNumbers(page) {
  return await evaluate(
    page,
    ([selector, css]) => {
      const code = document.querySelector(selector);
      if (code === null) {
        return null;
      }
      const wrappers = Array.from(
        code.querySelectorAll(':scope > [data-lexical-code-line-break]'),
      );
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
      try {
        // The middle of the 42px number box.
        const x = code.getBoundingClientRect().left + 21;
        return wrappers.map((wrapper, i) => {
          const next = wrappers[i + 1];
          const range = document.createRange();
          range.setStartAfter(wrapper);
          if (next) {
            range.setEndBefore(next);
          } else {
            range.setEnd(code, code.childNodes.length);
          }
          const rects = Array.from(range.getClientRects()).filter(
            rect => rect.height > 0,
          );
          // An empty line has only the <br> that ends it.
          const row =
            rects.length > 0
              ? rects.reduce((a, b) => (b.top < a.top ? b : a))
              : next.firstElementChild.getBoundingClientRect();
          const hit = document.elementFromPoint(x, (row.top + row.bottom) / 2);
          return wrappers.indexOf(hit);
        });
      } finally {
        document.head.removeChild(style);
      }
    },
    [CODE, NUMBER_HIT_TEST_CSS],
  );
}

/** How far the code block can scroll sideways. */
async function getOverflowWidth(page) {
  return await evaluate(
    page,
    selector => {
      const code = document.querySelector(selector);
      return code === null ? null : code.scrollWidth - code.clientWidth;
    },
    CODE,
  );
}

async function countLineBreaks(page) {
  return await evaluate(
    page,
    selector =>
      document.querySelectorAll(
        `${selector} br:not([data-lexical-managed-linebreak])`,
      ).length,
    CODE,
  );
}

async function copyAll(page) {
  await focusEditor(page);
  await selectAll(page);
  return await copyToClipboard(page);
}

async function toggleWrap(page) {
  await mouseMoveToSelector(page, CODE);
  await click(page, WRAP_BUTTON);
}

test.skip(
  ({isCollab, isPlainText}) => isPlainText || isCollab,
  'Requires rich text without collaboration',
);

test.describe('Code block word wrap', () => {
  for (const [name, settings] of [
    ['Prism', {}],
    ['Shiki', {isCodeShiki: true}],
  ]) {
    test(`The wrap button soft wraps a code block and numbers its lines (${name})`, async ({
      page,
      isCollab,
    }) => {
      await initialize({isCollab, page, ...settings});
      await createCodeBlock(page, [LONG_LINE, '', LONG_TOKEN, 'end']);
      // Add a paragraph after the block. A copy of nothing but the block's
      // text exports its lines without the <pre>.
      await page.keyboard.press('ArrowDown');
      await page.keyboard.type('after');
      const before = await copyAll(page);
      expect(before['text/html']).toContain('<pre');
      expect(before['text/html']).not.toContain('data-lexical-code-word-wrap');
      expect(await countLineBreaks(page)).toBe(3);
      await expect(locate(page, CODE)).not.toHaveAttribute(
        'data-lexical-code-line-numbers',
      );
      await expect.poll(() => getOverflowWidth(page)).toBeGreaterThan(0);

      await toggleWrap(page);
      await expect(locate(page, WRAP_BUTTON)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await waitForSelector(page, 'code[data-lexical-code-word-wrap]');
      await expect(locate(page, CODE)).toHaveAttribute(
        'data-lexical-code-line-numbers',
        'true',
      );
      await expect.poll(() => getOverflowWidth(page)).toBeLessThanOrEqual(1);
      expect(await getWordWrapJSON(page)).toBe(true);
      await expect.poll(() => getFirstRowNumbers(page)).toEqual([0, 1, 2]);

      const after = await copyAll(page);
      expect(after['text/plain']).toBe(before['text/plain']);
      expect(after['text/html']).toContain(
        'data-lexical-code-word-wrap="true"',
      );
      // The line numbers stay out of the copy. Apart from the word wrap
      // attribute, it has the same HTML as before, with a plain <br> for
      // each line break.
      expect(after['text/html']).not.toContain('data-lexical-code-line');
      expect(
        after['text/html'].replace(' data-lexical-code-word-wrap="true"', ''),
      ).toBe(before['text/html']);
      expect(await countLineBreaks(page)).toBe(3);

      await toggleWrap(page);
      await expect(locate(page, WRAP_BUTTON)).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await expect(locate(page, CODE)).not.toHaveAttribute(
        'data-lexical-code-word-wrap',
      );
      await expect(locate(page, CODE)).not.toHaveAttribute(
        'data-lexical-code-line-numbers',
      );
      expect(await getWordWrapJSON(page)).toBeUndefined();
      await expect.poll(() => getOverflowWidth(page)).toBeGreaterThan(0);
    });
  }
});
