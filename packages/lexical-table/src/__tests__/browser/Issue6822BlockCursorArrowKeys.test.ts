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
  $getRoot,
  $getSelection,
  $isRangeSelection,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

// Regression tests for #6822.
//
// A table that is the first or last child of the root gets a block cursor
// beside it when the caret steps off its edge. Getting back into the table
// from that block cursor is native caret movement, so these tests run in a
// real browser (see the `browser` project in vitest.config.mts) against real
// layout — jsdom has neither a caret nor line boxes to move it between. That
// also means the block cursor is only reachable on an engine whose native
// caret walks off the table's edge, so the suite probes for that first (see
// nativeVerticalCaretLeavesTrailingTable) and skips where it does not.
//
// The theme mirrors the playground's block cursor and table CSS because the
// engine's vertical caret movement is layout-driven; an approximation of the
// real stylesheet lands the caret in different cells.
const PLAYGROUND_CSS = `
.test-blockCursor { display: block; pointer-events: none; position: absolute; }
.test-blockCursor:after { content: ''; display: block; position: absolute; top: -2px; width: 20px; border-top: 1px solid black; }
.test-scrollWrapper { overflow-x: auto; margin: 0px 0px 5px 0px; scrollbar-width: none; }
.test-scrollWrapper > .test-table { margin-top: 0; margin-bottom: 0; }
.test-table { border-collapse: collapse; border-spacing: 0; table-layout: fixed; width: fit-content; margin-top: 25px; margin-bottom: 30px; }
.test-cell { border: 1px solid #bbb; width: 75px; vertical-align: top; text-align: start; padding: 6px 8px; position: relative; outline: none; overflow: auto; }
.test-cell > * { overflow: inherit; }
.test-cellHeader { background-color: #f2f3f5; text-align: start; }
`;

const THEME = {
  blockCursor: 'test-blockCursor',
  table: 'test-table',
  tableCell: 'test-cell',
  tableCellHeader: 'test-cellHeader',
  tableScrollableWrapper: 'test-scrollWrapper',
};

/**
 * A 3x3 table whose cells read "c1".."c9" in document order, so an assertion
 * on the anchor's text content names the cell the caret landed in.
 */
function $createNumberedTable() {
  const table = $createTableNodeWithDimensions(3, 3, true);
  let n = 0;
  for (const row of table.getChildren()) {
    if (!$isTableRowNode(row)) {
      continue;
    }
    for (const cell of row.getChildren()) {
      if (!$isTableCellNode(cell)) {
        continue;
      }
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(`c${++n}`));
      cell.clear().append(paragraph);
    }
  }
  return table;
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
      // hasHorizontalScroll defaults on, which is what arms the Firefox
      // scroll workaround under test.
      dependencies: [RichTextExtension, TableExtension],
      name: '[6822-browser]',
      theme: THEME,
    }),
  );
  onTestFinished(() => editor.dispose());
  return editor;
}

async function press(key: string): Promise<void> {
  await userEvent.keyboard(key);
  // Let the engine's selectionchange (and Lexical's reconcile of it) settle.
  await new Promise(resolve => setTimeout(resolve, 60));
}

/** The text of the node the caret is anchored in, or a description of a
 * non-text anchor (`block cursor` for a collapsed element point on the root). */
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

function hasBlockCursor(editor: LexicalEditor): boolean {
  return editor._blockCursorElement !== null;
}

/**
 * Ask the engine itself whether a downward line move takes the caret out of a
 * table that has nothing after it, using a scratch contenteditable outside of
 * Lexical.
 *
 * Every step these tests make is native caret movement — Lexical only imports
 * the result through its selectionchange listener — so the block cursor is
 * only reachable on an engine that walks the caret off the table's edge.
 * Gecko does not: the caret stops on the table element itself and no further
 * arrow press moves it, in or out. Probing the capability keeps the tests
 * running wherever that movement happens instead of pinning them to a user
 * agent string.
 */
function nativeVerticalCaretLeavesTrailingTable(): boolean {
  const div = document.createElement('div');
  div.contentEditable = 'true';
  div.innerHTML =
    '<p>before</p><table><tbody><tr><td><p>cell</p></td></tr></tbody></table>';
  document.body.appendChild(div);
  const table = div.querySelector('table')!;
  const cellText = div.querySelector('td p')!.firstChild as Text;
  const domSelection = window.getSelection()!;
  try {
    domSelection.setBaseAndExtent(
      cellText,
      cellText.length,
      cellText,
      cellText.length,
    );
    domSelection.modify('move', 'forward', 'line');
    const {focusNode} = domSelection;
    return focusNode !== null && !table.contains(focusNode);
  } catch {
    // No Selection.modify to probe with: run the tests and let a real failure
    // be visible rather than skipping them silently.
    return true;
  } finally {
    // Clear immediately (not at test end): a selection left in the scratch
    // element would interfere with the first editor built below.
    domSelection.removeAllRanges();
    document.body.removeChild(div);
  }
}

const NATIVE_CARET_LEAVES_TABLE = nativeVerticalCaretLeavesTrailingTable();

describe.skipIf(!NATIVE_CARET_LEAVES_TABLE)(
  'block cursor beside a table (#6822)',
  () => {
    test('ArrowUp from the block cursor below a trailing table returns to the last row', async () => {
      const editor = setUpEditor(() => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('before'));
        $getRoot().clear().append(paragraph, $createNumberedTable());
      });
      editor.update(
        () => {
          // The last descendant of the root is the text in the table's last
          // cell in both layouts under test.
          $getRoot().getLastDescendant()!.selectEnd();
        },
        {discrete: true},
      );
      editor.focus();
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(anchorText(editor)).toBe('c9');

      // Step off the bottom edge: the caret becomes a block cursor after the
      // table (an element point on the root).
      await press('{ArrowDown}');
      expect(hasBlockCursor(editor)).toBe(true);
      expect(anchorText(editor)).toBe('element point on root@2');

      // A second ArrowDown moves nothing — there is nothing below the table.
      await press('{ArrowDown}');
      expect(hasBlockCursor(editor)).toBe(true);
      expect(anchorText(editor)).toBe('element point on root@2');

      // ArrowUp must step back into the row the caret left, not jump to the
      // top-left cell.
      await press('{ArrowUp}');
      expect(hasBlockCursor(editor)).toBe(false);
      expect(anchorText(editor)).toBe('c9');

      await press('z');
      expect(
        editor.getEditorState().read(() => $getRoot().getTextContent()),
      ).toBe('before\n\nc1\n\nc2\n\nc3\n\nc4\n\nc5\n\nc6\n\nc7\n\nc8\n\nc9z');
    });

    test('ArrowUp from the block cursor below a table that is the only root child returns to the last row', async () => {
      const editor = setUpEditor(() => {
        $getRoot().clear().append($createNumberedTable());
      });
      editor.update(
        () => {
          // The last descendant of the root is the text in the table's last
          // cell in both layouts under test.
          $getRoot().getLastDescendant()!.selectEnd();
        },
        {discrete: true},
      );
      editor.focus();
      await new Promise(resolve => setTimeout(resolve, 60));

      await press('{ArrowDown}');
      expect(hasBlockCursor(editor)).toBe(true);
      await press('{ArrowDown}');
      expect(hasBlockCursor(editor)).toBe(true);
      await press('{ArrowUp}');
      expect(anchorText(editor)).toBe('c9');
    });

    test('ArrowDown from the block cursor above a leading table still enters the first cell', async () => {
      // A control: this passes with and without the fix, because in this engine
      // the native ArrowDown lands in the first cell on its own. It is here to
      // pin the direction the Firefox scroll workaround is gated to — entering
      // the table from above must keep working.
      const editor = setUpEditor(() => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('after'));
        $getRoot().clear().append($createNumberedTable(), paragraph);
      });
      editor.update(
        () => {
          $getRoot().getFirstDescendant()!.selectStart();
        },
        {discrete: true},
      );
      editor.focus();
      await new Promise(resolve => setTimeout(resolve, 60));

      await press('{ArrowUp}');
      expect(hasBlockCursor(editor)).toBe(true);
      expect(anchorText(editor)).toBe('element point on root@0');

      await press('{ArrowDown}');
      expect(hasBlockCursor(editor)).toBe(false);
      expect(anchorText(editor)).toBe('c1');

      await press('z');
      expect(
        editor.getEditorState().read(() => $getRoot().getTextContent()),
      ).toBe('zc1\n\nc2\n\nc3\n\nc4\n\nc5\n\nc6\n\nc7\n\nc8\n\nc9\n\nafter');
    });
  },
);
