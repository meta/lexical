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
} from '@lexical/code-core';
import {CodePrismExtension} from '@lexical/code-prism';
import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  type AnyLexicalExtensionArgument,
  defineExtension,
  isDOMTextNode,
  isHTMLElement,
  type LexicalCommand,
  type LexicalEditor,
  MOVE_TO_END,
  MOVE_TO_START,
  type TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

import theme from '../../themes/PlaygroundEditorTheme';

// When Lexical moves the caret in a code block with a long line, it scrolls
// the block sideways to reveal the caret. Where the caret ends up depends on
// real layout: scroll widths, where the caret is drawn, and where the gutter
// is drawn. jsdom has none of that, so these tests run in a real browser
// against the playground theme's own CSS. See the `browser` project in
// vitest.config.mts.
//
// Note: browser tests dispose with onTestFinished instead of `using`. See
// AGENTS.md.

const CONTAINER_WIDTH = 360;

const IS_FIREFOX =
  typeof navigator !== 'undefined' && /Firefox/i.test(navigator.userAgent);

// The theme's inline end padding leaves room for the caret at the end of the
// longest line. Firefox leaves that padding out of the scroll range while a
// sticky box is in the block, like the data-gutter float. So with the block
// scrolled as far as it goes, Firefox can draw the caret just outside it. At
// the far left end of a right to left line it is 0.33px past the left edge.
// At the end of the longest left to right line, Firefox on the Windows CI
// runners drew it 0.25px past the right edge: at x 360.25, with scrollLeft
// 4375 and the scrollport ending at 360. Chromium and WebKit keep it inside.
// That is how Firefox lays out the block, and the block can't scroll any
// further, so only those two steps allow 0.5px past the edge, and only in
// Firefox.
const FIREFOX_LINE_END_SLACK = IS_FIREFOX ? 0.5 : 0;

const LONG_LINE = Array.from(
  {length: 40},
  (_, i) => `<a class="item-${i}" href="/p/${i}">${i}</a>`,
)
  .join('')
  .slice(0, 655);
const INDENTED_LINE = ' '.repeat(12) + LONG_LINE.slice(0, 400);
const RTL_LINE = 'שלום '.repeat(130);

/** A way for the theme to draw line numbers next to a code block. */
interface Gutter {
  /** Extensions that give the code block this gutter. */
  dependencies: AnyLexicalExtensionArgument[];
  /** Checks that the code block is set up to draw this gutter. */
  expectGutter: (code: HTMLElement, lineCount: number) => void;
  name: string;
}

const DATA_GUTTER_FLOAT: Gutter = {
  dependencies: [],
  // The highlighter lists the line numbers in data-gutter, and the theme
  // draws them with the code element's ::before, floated left and sticky.
  expectGutter(code, lineCount) {
    expect(code.getAttribute('data-gutter')).toBe(
      Array.from({length: lineCount}, (_, i) => i + 1).join('\n'),
    );
    expect(getComputedStyle(code, '::before').float).toBe('left');
  },
  name: 'the data-gutter float',
};

// Every scroll case below runs once for each of these gutters.
const GUTTERS: Gutter[] = [DATA_GUTTER_FLOAT];

// Makes the pseudo elements the theme draws line numbers with the only hit
// targets inside a code block, so elementFromPoint tells whether a number is
// drawn at a point.
const GUTTER_HIT_TEST_CSS = [
  '.PlaygroundEditorTheme__code, .PlaygroundEditorTheme__code * { pointer-events: none !important; }',
  '.PlaygroundEditorTheme__code::before, .PlaygroundEditorTheme__code ::before, .PlaygroundEditorTheme__code ::after { pointer-events: auto !important; }',
].join('\n');

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

interface Scaling {
  by: 'transform' | 'zoom';
  scale: number;
}

function setUpEditor(gutter: Gutter, lines: string[], scaling?: Scaling) {
  const container = document.createElement('div');
  const scale = scaling === undefined ? 1 : scaling.scale;
  // The same width on screen at any scale
  container.style.width = `${CONTAINER_WIDTH / scale}px`;
  if (scaling !== undefined && scaling.by === 'zoom') {
    container.style.setProperty('zoom', String(scale));
  } else if (scaling !== undefined) {
    container.style.transform = `scale(${scale})`;
    container.style.transformOrigin = '0 0';
  }
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
        ...gutter.dependencies,
      ],
      name: '[code-caret-scroll]',
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
      $getRoot().clear().append($createCodeBlock(lines));
    },
    {discrete: true},
  );
  const rootElement = editor.getRootElement()!;
  const code = rootElement.querySelector('code')!;
  expect(code).not.toBeNull();
  gutter.expectGutter(code, lines.length);
  return {code, editor, rootElement};
}

async function settle(): Promise<void> {
  // Let the engine's selectionchange, and Lexical's handling of it, settle.
  await new Promise(resolve => setTimeout(resolve, 50));
}

async function focus(rootElement: HTMLElement): Promise<void> {
  rootElement.focus();
  await settle();
}

/** Puts the caret at the start or the end of a line (0 based). */
async function selectInLine(
  editor: LexicalEditor,
  line: number,
  edge: 'start' | 'end',
): Promise<void> {
  editor.update(
    () => {
      const code = $getRoot().getFirstChildOrThrow();
      if (!$isCodeNode(code)) {
        throw new Error('Expected a code block');
      }
      const lines: TextNode[][] = [[]];
      for (const node of code.getChildren()) {
        if ($isTextNode(node)) {
          lines[lines.length - 1].push(node);
        } else {
          lines.push([]);
        }
      }
      const lineNodes = lines[line];
      if (edge === 'start') {
        lineNodes[0].select(0, 0);
      } else {
        lineNodes[lineNodes.length - 1].select();
      }
    },
    {discrete: true},
  );
  await settle();
}

async function moveTo(
  editor: LexicalEditor,
  command: LexicalCommand<KeyboardEvent>,
): Promise<void> {
  editor.dispatchCommand(
    command,
    new KeyboardEvent('keydown', {
      key: command === MOVE_TO_END ? 'End' : 'Home',
    }),
  );
  // Commit the update. That is when Lexical scrolls the caret into view.
  editor.read(() => {});
  await settle();
}

async function type(keys: string): Promise<void> {
  await userEvent.keyboard(keys);
  await settle();
}

function isEmptyRect(rect: DOMRect): boolean {
  return (
    rect.top === 0 && rect.bottom === 0 && rect.left === 0 && rect.right === 0
  );
}

/**
 * The rect the caret is drawn at. A collapsed range between two elements
 * has no rect, so that falls back to the element after the caret. WebKit
 * gives no rect for a caret at the logical end of right to left text
 * either, so that falls back to the character before the caret. The caret
 * is at one of its edges.
 */
function caretRect(): DOMRect {
  const selection = window.getSelection()!;
  expect(selection.rangeCount).toBe(1);
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!isEmptyRect(rect)) {
    return rect;
  }
  const {focusNode, focusOffset} = selection;
  if (isDOMTextNode(focusNode) && focusOffset > 0) {
    const range = document.createRange();
    range.setStart(focusNode, focusOffset - 1);
    range.setEnd(focusNode, focusOffset);
    return range.getBoundingClientRect();
  }
  const child: Node | null = focusNode!.childNodes[focusOffset] || null;
  if (!isHTMLElement(child)) {
    throw new Error('Expected an element after the caret');
  }
  return child.getBoundingClientRect();
}

/** Whether the gutter draws a line number at this point in the viewport. */
function isGutterAt(code: HTMLElement, x: number, y: number): boolean {
  const style = document.createElement('style');
  style.textContent = GUTTER_HIT_TEST_CSS;
  document.head.appendChild(style);
  try {
    const hit = document.elementFromPoint(x, y);
    return hit !== null && code.contains(hit);
  } finally {
    document.head.removeChild(style);
  }
}

/**
 * Rects are in viewport px, while clientLeft, clientWidth and scrollLeft are
 * in the code element's own px, so those are multiplied by the scale.
 */
function measure(code: HTMLElement, scale = 1) {
  const rect = code.getBoundingClientRect();
  const scrollportLeft = rect.left + code.clientLeft * scale;
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  const firstText = walker.nextNode();
  expect(firstText).not.toBeNull();
  const range = document.createRange();
  range.setStart(firstText!, 0);
  const caret = caretRect();
  return {
    caretBottom: caret.bottom,
    caretLeft: caret.left,
    caretRight: caret.right,
    caretTop: caret.top,
    // Where the text of a line starts with the block scrolled all the way
    // back: just after the gutter, whatever its width.
    lineStartX: range.getBoundingClientRect().left + code.scrollLeft * scale,
    scrollLeft: code.scrollLeft,
    scrollportLeft,
    scrollportRight: scrollportLeft + code.clientWidth * scale,
  };
}

/**
 * The caret is inside the code block's scrollport, and no line number is
 * drawn over it. At the end of the longest line the block is scrolled as far
 * as it goes, so this also checks the theme leaves room for the caret there.
 * leftSlack and rightSlack let the caret be that many px past the left or
 * the right edge.
 */
function expectCaretVisible(
  code: HTMLElement,
  {
    leftSlack = 0,
    rightSlack = 0,
    scale = 1,
  }: {leftSlack?: number; rightSlack?: number; scale?: number} = {},
): void {
  const m = measure(code, scale);
  const state = JSON.stringify(m);
  expect(m.caretLeft, state).toBeGreaterThanOrEqual(
    m.scrollportLeft - leftSlack,
  );
  expect(m.caretRight, state).toBeLessThanOrEqual(
    m.scrollportRight + rightSlack,
  );
  const x = Math.min(
    Math.max(m.caretLeft, m.scrollportLeft + 0.5),
    m.scrollportRight - 0.5,
  );
  expect(isGutterAt(code, x, (m.caretTop + m.caretBottom) / 2), state).toBe(
    false,
  );
}

describe.each(GUTTERS)('caret scrolling in a code block with $name', gutter => {
  test('End reveals the end of a long line, and Home scrolls all the way back', async () => {
    const {code, editor, rootElement} = setUpEditor(gutter, [
      LONG_LINE,
      INDENTED_LINE,
    ]);
    expect(code.scrollWidth).toBeGreaterThan(code.clientWidth);
    await focus(rootElement);
    await selectInLine(editor, 0, 'start');
    expect(code.scrollLeft).toBe(0);

    await moveTo(editor, MOVE_TO_END);
    let m = measure(code);
    expect(m.scrollLeft, JSON.stringify(m)).toBeGreaterThan(0);
    // Clear of the gutter, not just inside the scrollport.
    expect(m.caretLeft, JSON.stringify(m)).toBeGreaterThanOrEqual(
      m.lineStartX - 1,
    );
    // The end of the longest line, with the block scrolled as far as it goes
    expectCaretVisible(code, {rightSlack: FIREFOX_LINE_END_SLACK});

    await moveTo(editor, MOVE_TO_START);
    m = measure(code);
    expect(m.scrollLeft, JSON.stringify(m)).toBe(0);
    expect(
      Math.abs(m.caretLeft - m.lineStartX),
      JSON.stringify(m),
    ).toBeLessThanOrEqual(1);
    expectCaretVisible(code);
  });

  test('moving back to the end of a shorter line stops the caret at the gutter, not under it', async () => {
    const {code, editor, rootElement} = setUpEditor(gutter, [
      LONG_LINE,
      INDENTED_LINE,
    ]);
    await focus(rootElement);
    await selectInLine(editor, 0, 'start');
    await moveTo(editor, MOVE_TO_END);
    const endScrollLeft = code.scrollLeft;
    expect(endScrollLeft).toBeGreaterThan(0);

    // The end of the indented line is left of the view, but too far along
    // the line to fit with the block scrolled all the way back. So the block
    // only scrolls back part of the way, and the gutter is still in view.
    await selectInLine(editor, 1, 'end');
    const m = measure(code);
    expect(m.scrollLeft, JSON.stringify(m)).toBeGreaterThan(0);
    expect(m.scrollLeft, JSON.stringify(m)).toBeLessThan(endScrollLeft);
    expect(m.caretLeft, JSON.stringify(m)).toBeGreaterThanOrEqual(
      m.lineStartX - 1,
    );
    expectCaretVisible(code);
  });

  test('Enter after typing at the end of a long line scrolls back to the start of the new line', async () => {
    const {code, editor, rootElement} = setUpEditor(gutter, [
      LONG_LINE,
      INDENTED_LINE,
    ]);
    await focus(rootElement);
    await selectInLine(editor, 0, 'start');
    await moveTo(editor, MOVE_TO_END);
    expect(code.scrollLeft).toBeGreaterThan(0);

    await type('abc{Enter}');
    await expect.poll(() => code.scrollLeft).toBe(0);
    const m = measure(code);
    expect(
      Math.abs(m.caretLeft - m.lineStartX),
      JSON.stringify(m),
    ).toBeLessThanOrEqual(1);
    expectCaretVisible(code);
  });

  test('smart Home on an indented line scrolls all the way back and shows the indentation', async () => {
    const {code, editor, rootElement} = setUpEditor(gutter, [
      LONG_LINE,
      INDENTED_LINE,
    ]);
    await focus(rootElement);
    await selectInLine(editor, 1, 'end');
    expect(code.scrollLeft).toBeGreaterThan(0);

    await moveTo(editor, MOVE_TO_START);
    const m = measure(code);
    expect(m.scrollLeft, JSON.stringify(m)).toBe(0);
    // Home stops after the indentation, not at the start of the line.
    expect(m.caretLeft, JSON.stringify(m)).toBeGreaterThan(m.lineStartX + 1);
    expectCaretVisible(code);
  });

  test('Enter on an indented line scrolls all the way back and shows the copied indentation', async () => {
    const {code, editor, rootElement} = setUpEditor(gutter, [
      LONG_LINE,
      INDENTED_LINE,
    ]);
    await focus(rootElement);
    await selectInLine(editor, 1, 'start');
    await moveTo(editor, MOVE_TO_END);
    expect(code.scrollLeft).toBeGreaterThan(0);

    // The new line starts with the 12 spaces of the line above.
    await type('abc{Enter}');
    await expect.poll(() => code.scrollLeft).toBe(0);
    const m = measure(code);
    expect(m.caretLeft, JSON.stringify(m)).toBeGreaterThan(m.lineStartX + 1);
    expectCaretVisible(code);
  });

  test('right to left lines scroll the other way and keep the caret visible', async () => {
    const {code, editor, rootElement} = setUpEditor(gutter, [RTL_LINE]);
    expect(getComputedStyle(code).direction).toBe('rtl');
    expect(code.scrollWidth).toBeGreaterThan(code.clientWidth);
    await focus(rootElement);
    await selectInLine(editor, 0, 'start');
    expect(code.scrollLeft).toBe(0);

    // The gutter isn't always on the same side of the view here. The float
    // is on the left, but as a sticky box it can't leave the code element's
    // content box, so it scrolls out of view when the block scrolls toward
    // the end of a line. WebKit draws it about 10px from the right edge
    // instead, over the first characters of the line, and hit tests it there
    // too. So the checks look for a number drawn at the caret instead of at
    // a fixed side.

    // In a right to left line, MOVE_TO_START goes to the visual start of the
    // line, on the left, which is its logical end.
    await moveTo(editor, MOVE_TO_START);
    expect(code.scrollLeft).toBeLessThan(0);
    expectCaretVisible(code, {leftSlack: FIREFOX_LINE_END_SLACK});

    await moveTo(editor, MOVE_TO_END);
    expect(
      editor.read(() => {
        const selection = $getSelection();
        return $isRangeSelection(selection) &&
          selection.isCollapsed() &&
          selection.anchor.getNode().getPreviousSibling() === null
          ? selection.anchor.offset
          : null;
      }),
    ).toBe(0);
    expect(code.scrollLeft).toBe(0);
    expectCaretVisible(code);
  });
});

describe.each<Scaling>([
  {by: 'transform', scale: 0.5},
  {by: 'transform', scale: 2},
  {by: 'zoom', scale: 2},
])('caret scrolling in a code block scaled by $scale with CSS $by', scaling => {
  test('End and smart Home keep the caret visible and clear of the gutter', async () => {
    const {scale} = scaling;
    const {code, editor, rootElement} = setUpEditor(
      DATA_GUTTER_FLOAT,
      [LONG_LINE, INDENTED_LINE],
      scaling,
    );
    await focus(rootElement);
    // The indented line is the shorter one, so End stops before the end of
    // the block's scroll range.
    await selectInLine(editor, 1, 'start');
    expect(code.scrollLeft).toBe(0);

    await moveTo(editor, MOVE_TO_END);
    let m = measure(code, scale);
    expect(m.scrollLeft, JSON.stringify(m)).toBeGreaterThan(0);
    expect(m.caretLeft, JSON.stringify(m)).toBeGreaterThanOrEqual(
      m.lineStartX - 1,
    );
    expectCaretVisible(code, {scale});

    await moveTo(editor, MOVE_TO_START);
    m = measure(code, scale);
    expect(m.scrollLeft, JSON.stringify(m)).toBe(0);
    expect(m.caretLeft, JSON.stringify(m)).toBeGreaterThan(m.lineStartX + 1);
    expectCaretVisible(code, {scale});
  });
});
