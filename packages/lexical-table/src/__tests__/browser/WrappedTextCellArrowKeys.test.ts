/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTableNodeWithDimensions,
  $isTableCellNode,
  $isTableRowNode,
  TableExtension,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

// Regression tests for the arrow key exit detection in cells whose text
// soft-wraps.
//
// $handleArrowKey decides whether a vertical arrow key leaves the cell by
// comparing the caret's rect with the cell's edge child box. At a soft wrap
// the caret sits between two visual lines, and a collapsed DOM range there
// reports its bounding rect at the end of the *previous* line in every
// engine (it is the first of the client rects). With the caret logically at
// the start of a cell's last visual line that stale rect made
//
// - ArrowDown keep the native movement on Chromium, which lands in the cell
//   to the right (document order) instead of the one below; Gecko happens
//   to move below on its own, masking the bug.
// - ArrowUp hijack the caret out of the table on every engine, instead of
//   moving up one visual line within the cell.
//
// The engine's vertical caret movement is layout-driven, so these tests run
// in a real browser (see the `browser` project in vitest.config.mts) against
// real line boxes — jsdom has neither a caret nor wrapped line boxes.
//
// The theme mirrors the playground's table CSS because a narrow fixed-layout
// cell is what forces the text to wrap.
const PLAYGROUND_CSS = `
.test-scrollWrapper { overflow-x: auto; margin: 0px 0px 5px 0px; scrollbar-width: none; }
.test-scrollWrapper > .test-table { margin-top: 0; margin-bottom: 0; }
.test-table { border-collapse: collapse; border-spacing: 0; table-layout: fixed; width: fit-content; margin-top: 25px; margin-bottom: 30px; }
.test-cell { border: 1px solid #bbb; width: 75px; vertical-align: top; text-align: start; padding: 6px 8px; position: relative; outline: none; overflow: auto; }
.test-cell > * { overflow: inherit; }
.test-cellHeader { background-color: #f2f3f5; text-align: start; }
`;

const THEME = {
  table: 'test-table',
  tableCell: 'test-cell',
  tableCellHeader: 'test-cellHeader',
  tableScrollableWrapper: 'test-scrollWrapper',
};

const C4_TEXT = 'c4 aaabbb cccddd';

/**
 * A 3x3 table with a header row whose cells read "c1".."c9" in document
 * order, except that c4 holds enough text to soft-wrap in the narrow cell.
 * An assertion on the anchor's text content names the cell the caret is in:
 * below c4 is c7, to its right c5, above it the header cell c1.
 */
function $createNumberedTable() {
  const table = $createTableNodeWithDimensions(3, 3, true);
  let n = 0;
  let c4TextKey = '';
  for (const row of table.getChildren()) {
    if (!$isTableRowNode(row)) {
      continue;
    }
    for (const cell of row.getChildren()) {
      if (!$isTableCellNode(cell)) {
        continue;
      }
      const paragraph = $createParagraphNode();
      const text = $createTextNode(++n === 4 ? C4_TEXT : `c${n}`);
      paragraph.append(text);
      cell.clear().append(paragraph);
      if (n === 4) {
        c4TextKey = text.getKey();
      }
    }
  }
  return {c4TextKey, table};
}

function setUpEditor($initialEditorState: () => void): LexicalEditor {
  const style = document.createElement('style');
  style.textContent = PLAYGROUND_CSS;
  document.head.appendChild(style);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState,
      afterRegistration(builtEditor) {
        const rootElement = document.createElement('div');
        rootElement.contentEditable = 'true';
        container.appendChild(rootElement);
        builtEditor.setRootElement(rootElement);
        return () => {
          document.body.removeChild(container);
          document.head.removeChild(style);
        };
      },
      dependencies: [RichTextExtension, TableExtension],
      name: '[wrapped-text-arrows-browser]',
      theme: THEME,
    }),
  );
  onTestFinished(() => editor.dispose());
  return editor;
}

async function setUpWithC4(): Promise<{c4Key: string; editor: LexicalEditor}> {
  let c4Key = '';
  const editor = setUpEditor(() => {
    const {c4TextKey, table} = $createNumberedTable();
    $getRoot().clear().append(table);
    c4Key = c4TextKey;
  });
  editor.focus();
  // Let the initial reconcile and layout settle before measuring line boxes.
  await new Promise(resolve => setTimeout(resolve, 60));
  return {c4Key, editor};
}

async function press(key: string): Promise<void> {
  await userEvent.keyboard(key);
  // Let the engine's selectionchange (and Lexical's reconcile of it) settle.
  await new Promise(resolve => setTimeout(resolve, 60));
}

/** The text of the node the caret is anchored in, or a description of a
 * non-text anchor. */
function anchorText(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      return `not a RangeSelection: ${String(selection)}`;
    }
    const anchor = selection.anchor;
    return anchor.type === 'text'
      ? anchor.getNode().getTextContent()
      : `element point on ${anchor.getNode().getType()}@${anchor.offset}`;
  });
}

function getDomText(editor: LexicalEditor, key: string): Text {
  const firstChild = editor.getElementByKey(key)!.firstChild;
  if (firstChild === null || firstChild.nodeType !== Node.TEXT_NODE) {
    throw new Error(`no DOM text node for key ${key}`);
  }
  return firstChild as Text;
}

/** The top of the visual line the character after `offset` renders on. */
function nextCharLineTop(domText: Text, offset: number): number {
  const range = domText.ownerDocument.createRange();
  range.setStart(domText, offset);
  range.setEnd(domText, offset + 1);
  const rects = range.getClientRects();
  return rects.length > 0 ? rects[rects.length - 1].top : Number.NaN;
}

/**
 * The offset at which the text soft-wraps onto its last visual line: the
 * first offset whose following character renders on the bottom line. A
 * caret placed there belongs to the last line for arrow key purposes,
 * although every engine reports its collapsed range rect at the end of the
 * previous line. Measured from the rendered line boxes so the test does not
 * depend on font metrics.
 */
function findLastLineStartOffset(domText: Text): number {
  const {length} = domText.data;
  const tops: number[] = [];
  let lastTop = -Infinity;
  for (let offset = 0; offset + 1 < length; offset++) {
    tops[offset] = nextCharLineTop(domText, offset);
    if (tops[offset] > lastTop) {
      lastTop = tops[offset];
    }
  }
  if (lastTop === -Infinity) {
    throw new Error('no measurable character rects: did the text render?');
  }
  const wrapOffset = tops.findIndex(top => top > lastTop - 4);
  if (wrapOffset < 0) {
    throw new Error('the cell text does not soft-wrap');
  }
  return wrapOffset;
}

async function setUpC4Caret(
  editor: LexicalEditor,
  c4Key: string,
  offset: number,
): Promise<void> {
  editor.update(
    () => {
      const textNode = $getNodeByKey(c4Key);
      // Both offsets: a single one would leave the focus at the end of the
      // text, yielding a non-collapsed selection.
      if ($isTextNode(textNode)) {
        textNode.select(offset, offset);
      }
    },
    {discrete: true},
  );
  editor.focus();
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(anchorText(editor)).toBe(C4_TEXT);
}

/** The distinct tops of the visual lines the text renders on. */
function visualLineTops(domText: Text): number[] {
  const {length} = domText.data;
  const tops: number[] = [];
  for (let offset = 0; offset + 1 < length; offset++) {
    const top = nextCharLineTop(domText, offset);
    if (tops.every(existing => Math.abs(existing - top) > 4)) {
      tops.push(top);
    }
  }
  return tops;
}

/**
 * Whether this browser environment actually delivers trusted keyboard input.
 * Some playwright + Firefox combinations (observed on macOS) swallow
 * synthesized input entirely, which would make every expectation below fail
 * for harness reasons. Probe once and skip the suite where keys do not
 * arrive, the same way the engine-specific behaviors above are gated.
 */
let keyboardDelivery: boolean | null = null;
async function probeKeyboardDelivery(ctx: {
  skip: {(condition: boolean, note?: string): void};
}): Promise<boolean> {
  if (keyboardDelivery === null) {
    let delivered = false;
    const onKey = () => {
      delivered = true;
    };
    window.addEventListener('keydown', onKey, true);
    try {
      await userEvent.keyboard('{Shift}');
      await new Promise(resolve => setTimeout(resolve, 30));
    } finally {
      window.removeEventListener('keydown', onKey, true);
    }
    keyboardDelivery = delivered;
  }
  ctx.skip(
    !keyboardDelivery,
    'this browser environment does not deliver trusted keyboard input',
  );
  return keyboardDelivery;
}

describe('arrow keys across soft-wrapped cell text', () => {
  test('ArrowDown from the start of the last visual line moves to the cell below', async ctx => {
    await probeKeyboardDelivery(ctx);
    const {c4Key, editor} = await setUpWithC4();
    const domText = getDomText(editor, c4Key);
    // The ArrowUp variant below only manifests when the wrapped cell has
    // exactly two lines: the caret's stale rect is then the end of the
    // *first* line, which reads as "on the first line" to the exit
    // detection. Keep this text at two rendered lines.
    expect(visualLineTops(domText)).toHaveLength(2);
    const offset = findLastLineStartOffset(domText);
    await setUpC4Caret(editor, c4Key, offset);

    // Without the visual line detection the caret's stale rect reads as "on
    // the previous line": Chromium lets the native movement run, which lands
    // in c5 (the cell to the right), while the caret must exit below to c7.
    await press('{ArrowDown}');
    expect(anchorText(editor)).toBe('c7');
  });

  test('ArrowUp from the start of the last visual line stays in the cell', async ctx => {
    await probeKeyboardDelivery(ctx);
    const {c4Key, editor} = await setUpWithC4();
    const domText = getDomText(editor, c4Key);
    expect(visualLineTops(domText)).toHaveLength(2);
    const offset = findLastLineStartOffset(domText);
    await setUpC4Caret(editor, c4Key, offset);

    // The stale rect reads as "on the first line", so every engine used to
    // hijack the caret out of the table (to the header cell above) instead
    // of letting it move up one visual line within c4.
    await press('{ArrowUp}');
    expect(anchorText(editor)).toBe(C4_TEXT);
  });

  test('ArrowDown from the middle of the first visual line stays in the cell', async ctx => {
    await probeKeyboardDelivery(ctx);
    const {c4Key, editor} = await setUpWithC4();
    const domText = getDomText(editor, c4Key);
    const offset = findLastLineStartOffset(domText);
    // Control: a caret mid-way through the first line ("c4| …") must not be
    // mistaken for the last line, in this engine or any other.
    expect(
      Math.abs(nextCharLineTop(domText, 2) - nextCharLineTop(domText, 0)),
    ).toBeLessThan(4);
    expect(offset).toBeGreaterThan(2);
    await setUpC4Caret(editor, c4Key, 2);

    await press('{ArrowDown}');
    expect(anchorText(editor)).toBe(C4_TEXT);
  });

  test('ArrowDown from the end of the last visual line still exits to the cell below', async ctx => {
    await probeKeyboardDelivery(ctx);
    const {c4Key, editor} = await setUpWithC4();
    // Control: the pre-existing exit behavior from the very end of the cell
    // must keep working.
    await setUpC4Caret(editor, c4Key, C4_TEXT.length);

    await press('{ArrowDown}');
    expect(anchorText(editor)).toBe('c7');
  });

  test('ArrowUp from the start of the first visual line still exits to the cell above', async ctx => {
    await probeKeyboardDelivery(ctx);
    const {c4Key, editor} = await setUpWithC4();
    // Control: the pre-existing exit behavior from the very start of the
    // cell must keep working.
    await setUpC4Caret(editor, c4Key, 0);

    await press('{ArrowUp}');
    expect(anchorText(editor)).toBe('c1');
  });
});
