/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createCodeHighlightNode,
  $createCodeNode,
  $isCodeNode,
  CodeLineNumbersExtension,
} from '@lexical/code-core';
import {CodePrismExtension} from '@lexical/code-prism';
import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $getRoot,
  configExtension,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import theme from '../../themes/PlaygroundEditorTheme';

// A code block with word wrap on soft wraps its long lines, and the
// playground theme numbers it per line, so a number is drawn on the first
// row of each line and not on the rows it wraps onto. Where the rows and
// the numbers land depends on real layout, which jsdom doesn't have, so
// these tests run in a real browser against the theme's own CSS. See the
// `browser` project in vitest.config.mts.
//
// Note: browser tests dispose with onTestFinished instead of `using`. See
// AGENTS.md.

const CONTAINER_WIDTH = 360;

const LONG_LINE = Array.from(
  {length: 40},
  (_, i) => `<a class="item-${i}" href="/p/${i}">${i}</a>`,
)
  .join('')
  .slice(0, 655);
// One token with no break opportunity, which wraps only because of
// overflow-wrap: anywhere.
const LONG_TOKEN = 'https://example.com/' + 'a'.repeat(380);
const LINES = [LONG_LINE, '', LONG_TOKEN, 'end'];

// Makes the line numbers the only hit targets inside a code block, so
// elementFromPoint tells whether a number is drawn at a point, and which.
const NUMBER_HIT_TEST_CSS = [
  '.PlaygroundEditorTheme__code, .PlaygroundEditorTheme__code * { pointer-events: none !important; }',
  '.PlaygroundEditorTheme__code::before, .PlaygroundEditorTheme__code [data-lexical-code-line-break]::after { pointer-events: auto !important; }',
].join('\n');

interface Mode {
  name: string;
  /** How the playground configures CodeLineNumbersExtension. */
  onlyWordWrapped: boolean;
}

const MODES: Mode[] = [
  // The playground's default: only wrapped blocks get per line numbers, and
  // the other blocks keep the data-gutter float.
  {name: 'line numbers only while wrapped', onlyWordWrapped: true},
  // The playground's line numbers setting: every block is numbered per line.
  {name: 'line numbers on every block', onlyWordWrapped: false},
];

function $createCodeBlock(lines: string[]) {
  const code = $createCodeNode('html');
  lines.forEach((line, i) => {
    if (i > 0) {
      code.append($createLineBreakNode());
    }
    if (line !== '') {
      code.append($createCodeHighlightNode(line));
    }
  });
  return code;
}

function setUpEditor(mode: Mode) {
  const container = document.createElement('div');
  container.style.width = `${CONTAINER_WIDTH}px`;
  document.body.appendChild(container);
  const editor = buildEditorFromExtensions(
    defineExtension({
      afterRegistration(builtEditor) {
        const rootElement = document.createElement('div');
        rootElement.contentEditable = 'true';
        container.appendChild(rootElement);
        builtEditor.setRootElement(rootElement);
        return () => {
          document.body.removeChild(container);
        };
      },
      dependencies: [
        RichTextExtension,
        CodePrismExtension,
        configExtension(CodeLineNumbersExtension, {
          onlyWordWrapped: mode.onlyWordWrapped,
        }),
      ],
      name: '[code-word-wrap]',
      onError: (error: Error) => {
        throw error;
      },
      theme,
    }),
  );
  onTestFinished(() => editor.dispose());
  // Build the block in an update rather than as the initial state, so Prism
  // tokenizes it as it would in the app.
  editor.update(
    () => {
      $getRoot().clear().append($createCodeBlock(LINES));
    },
    {discrete: true},
  );
  const code = getCode(editor);
  expect(code.hasAttribute('data-lexical-code-word-wrap')).toBe(false);
  expect(code.hasAttribute('data-lexical-code-line-numbers')).toBe(
    !mode.onlyWordWrapped,
  );
  expect(code.scrollWidth).toBeGreaterThan(code.clientWidth);
  return editor;
}

function getCode(editor: LexicalEditor): HTMLElement {
  const code = editor.getRootElement()!.querySelector('code');
  expect(code).not.toBeNull();
  return code!;
}

/**
 * Turns word wrap on or off and returns the code element. With
 * onlyWordWrapped, a toggle replaces the code element.
 */
function setWordWrap(editor: LexicalEditor, wordWrap: boolean): HTMLElement {
  editor.update(
    () => {
      const node = $getRoot().getFirstChildOrThrow();
      if (!$isCodeNode(node)) {
        throw new Error('Expected a code block');
      }
      node.setWordWrap(wordWrap);
    },
    {discrete: true},
  );
  return getCode(editor);
}

/** What elementFromPoint hits when only the line numbers are hit targets. */
function hitTestNumbers(x: number, y: number): Element | null {
  const style = document.createElement('style');
  style.textContent = NUMBER_HIT_TEST_CSS;
  document.head.appendChild(style);
  try {
    return document.elementFromPoint(x, y);
  } finally {
    document.head.removeChild(style);
  }
}

function isNumber(code: HTMLElement, element: Element | null): boolean {
  return (
    element === code ||
    (element !== null && element.hasAttribute('data-lexical-code-line-break'))
  );
}

interface Row {
  bottom: number;
  left: number;
  top: number;
}

/** The rows a range is laid out on, top to bottom. */
function rowsOf(range: Range): Row[] {
  const rows: Row[] = [];
  for (const rect of range.getClientRects()) {
    if (rect.height <= 0) {
      continue;
    }
    const row = rows.find(({top}) => Math.abs(top - rect.top) <= 2);
    if (row) {
      row.bottom = Math.max(row.bottom, rect.bottom);
      row.left = Math.min(row.left, rect.left);
    } else {
      rows.push({bottom: rect.bottom, left: rect.left, top: rect.top});
    }
  }
  return rows.sort((a, b) => a.top - b.top);
}

/** The rows of each line, found between the line break wrappers. */
function rowsOfLines(code: HTMLElement, wrappers: Element[]): Row[][] {
  const lineRows: Row[][] = [];
  for (let i = 0; i <= wrappers.length; i++) {
    const range = document.createRange();
    if (i === 0) {
      range.setStart(code, 0);
    } else {
      range.setStartAfter(wrappers[i - 1]);
    }
    if (i === wrappers.length) {
      range.setEnd(code, code.childNodes.length);
    } else {
      range.setEndBefore(wrappers[i]);
    }
    let rows = rowsOf(range);
    if (rows.length === 0) {
      // An empty line. The <br> that ends it is all that is on it.
      const {bottom, left, top} =
        wrappers[i].firstElementChild!.getBoundingClientRect();
      rows = [{bottom, left, top}];
    }
    lineRows.push(rows);
  }
  return lineRows;
}

describe.each(MODES)('word wrap in a code block with $name', mode => {
  test('wraps long lines and numbers the first row of every line', () => {
    const editor = setUpEditor(mode);

    const code = setWordWrap(editor, true);
    expect(code.getAttribute('data-lexical-code-word-wrap')).toBe('true');
    expect(code.getAttribute('data-lexical-code-line-numbers')).toBe('true');
    expect(code.scrollWidth).toBeLessThanOrEqual(code.clientWidth + 1);
    const wrappers = Array.from(
      code.querySelectorAll(':scope > [data-lexical-code-line-break]'),
    );
    expect(wrappers).toHaveLength(LINES.length - 1);

    const lineRows = rowsOfLines(code, wrappers);
    // The long line and the long token wrap. The empty line and 'end' don't.
    expect(lineRows.map(rows => rows.length > 1)).toEqual([
      true,
      false,
      true,
      false,
    ]);

    // x in the middle of the 42px number box.
    const numberX = code.getBoundingClientRect().left + 21;
    lineRows.forEach((rows, i) => {
      const number = i === 0 ? code : wrappers[i - 1];
      rows.forEach(({bottom, left, top}, row) => {
        const where = `line ${i + 1}, row ${row + 1}`;
        const middle = (top + bottom) / 2;
        const hit = hitTestNumbers(numberX, middle);
        if (row === 0) {
          expect(hit, where).toBe(number);
        } else {
          expect(isNumber(code, hit), where).toBe(false);
        }
        // No number is drawn over the text of any row.
        expect(isNumber(code, hitTestNumbers(left + 1, middle)), where).toBe(
          false,
        );
      });
    });
  });

  test('unwrapping scrolls long lines again and brings back the gutter', () => {
    const editor = setUpEditor(mode);
    setWordWrap(editor, true);

    const code = setWordWrap(editor, false);
    expect(code.hasAttribute('data-lexical-code-word-wrap')).toBe(false);
    expect(code.scrollWidth).toBeGreaterThan(code.clientWidth);
    expect(code.getAttribute('data-gutter')).toBe('1\n2\n3\n4');
    if (mode.onlyWordWrapped) {
      // The data-gutter float numbers it again.
      expect(code.hasAttribute('data-lexical-code-line-numbers')).toBe(false);
      expect(
        code.querySelectorAll('[data-lexical-code-line-break]'),
      ).toHaveLength(0);
      const float = getComputedStyle(code, '::before');
      expect(float.content).not.toBe('none');
      expect(float.float).toBe('left');
    } else {
      // Still numbered per line, with sticky numbers in the line.
      expect(code.getAttribute('data-lexical-code-line-numbers')).toBe('true');
      expect(
        code.querySelectorAll(':scope > [data-lexical-code-line-break]'),
      ).toHaveLength(LINES.length - 1);
      expect(getComputedStyle(code, '::before').position).toBe('sticky');
    }
  });
});
