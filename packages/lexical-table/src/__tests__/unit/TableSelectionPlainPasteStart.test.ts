/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$insertDataTransferForRichText} from '@lexical/clipboard';
import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $computeTableMapSkipCellCheck,
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $createTableSelectionFrom,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  type TableCellNode,
  TableExtension,
  type TableNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $findMatchingParent,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

// Plain text pasted into a table selection is spread over the cells as tab-
// and newline-separated values, starting at the selection's top-left cell
// (and growing the table when the text has more rows or columns). A
// selection can be made from any corner: one made right to left or upwards
// must start at the same cell as one made the other way.

// Cells are `[text, colSpan, rowSpan]` or a text.
type Spec = (string | [string, number, number])[][];

function build(rows: Spec): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      afterRegistration(ed) {
        const root = document.createElement('div');
        document.body.append(root);
        ed.setRootElement(root);
        return () => root.remove();
      },
      dependencies: [TableExtension],
      name: '[table-selection-plain-paste-start]',
      onError(error: Error) {
        throw error;
      },
      theme: {tableScrollableWrapper: 'table-scrollable-wrapper'},
    }),
  );
  editor.update(
    () => {
      const table = $createTableNode();
      for (const specs of rows) {
        const row = $createTableRowNode();
        for (const spec of specs) {
          const [text, colSpan, rowSpan] =
            typeof spec === 'string' ? [spec, 1, 1] : spec;
          row.append(
            $createTableCellNode()
              .setColSpan(colSpan)
              .setRowSpan(rowSpan)
              .append($createParagraphNode().append($createTextNode(text))),
          );
        }
        table.append(row);
      }
      $getRoot().clear().append(table, $createParagraphNode());
    },
    // As a remote update applies it (a ragged table stays ragged).
    {discrete: true, skipTransforms: true},
  );
  return editor;
}

const $table = () => $getRoot().getChildren().find($isTableNode) as TableNode;
const $cellAt = (row: number, column: number) =>
  $computeTableMapSkipCellCheck($table(), null, null)[0][row][column]
    .cell as TableCellNode;
const $texts = () =>
  $table()
    .getChildren()
    .filter($isTableRowNode)
    .map(row => row.getChildren().map(cell => cell.getTextContent()));

function pastePlain(
  editor: LexicalEditor,
  anchor: readonly [number, number],
  focus: readonly [number, number],
  text: string,
  mime: string = 'text/plain',
) {
  editor.update(
    () => {
      const selection = $createTableSelectionFrom(
        $table(),
        $cellAt(...anchor),
        $cellAt(...focus),
      );
      $setSelection(selection);
      const dataTransfer = new DataTransfer();
      dataTransfer.setData(mime, text);
      $insertDataTransferForRichText(dataTransfer, selection, editor);
    },
    {discrete: true},
  );
  return editor.read($texts);
}

const GRID: Spec = [
  ['a', 'b', 'c', 'd'],
  ['e', 'f', 'g', 'h'],
  ['i', 'j', 'k', 'l'],
];

describe('TableSelection.insertRawText: where the pasted grid starts', () => {
  test.each([
    ['left to right', [0, 0], [0, 2]],
    ['right to left', [0, 2], [0, 0]],
  ] as const)('a row selected %s', (_, anchor, focus) => {
    expect(pastePlain(build(GRID), anchor, focus, 'X\tY\tZ')).toEqual([
      ['X', 'Y', 'Z', 'd'],
      ['e', 'f', 'g', 'h'],
      ['i', 'j', 'k', 'l'],
    ]);
  });

  test.each([
    ['downwards', [0, 1], [2, 1]],
    ['upwards', [2, 1], [0, 1]],
  ] as const)('a column selected %s', (_, anchor, focus) => {
    expect(pastePlain(build(GRID), anchor, focus, 'X\nY\nZ')).toEqual([
      ['a', 'X', 'c', 'd'],
      ['e', 'Y', 'g', 'h'],
      ['i', 'Z', 'k', 'l'],
    ]);
  });

  test.each([
    ['from the top left', [0, 1], [1, 2]],
    ['from the bottom right', [1, 2], [0, 1]],
    ['from the top right', [0, 2], [1, 1]],
    ['from the bottom left', [1, 1], [0, 2]],
  ] as const)('a block selected %s', (_, anchor, focus) => {
    expect(pastePlain(build(GRID), anchor, focus, 'W\tX\nY\tZ')).toEqual([
      ['a', 'W', 'X', 'd'],
      ['e', 'Y', 'Z', 'h'],
      ['i', 'j', 'k', 'l'],
    ]);
  });

  test('a selection made right to left that starts on a merged cell', () => {
    // t2 spans two columns; the selection runs from t2 back to t0.
    const editor = build([
      ['t0', 't1', ['t2', 2, 1], 't3'],
      ['t4', 't5', 't6', 't7', 't8'],
    ]);
    expect(pastePlain(editor, [0, 2], [0, 0], 'X\tY\tZ')).toEqual([
      ['X', 'Y', 'Z', '', 't3'],
      ['t4', 't5', 't6', 't7', 't8'],
    ]);
  });

  test('a selection made upwards in a ragged table', () => {
    const editor = build([['a', 'b', 'c'], ['d'], ['g', 'h', 'i', 'j']]);
    expect(pastePlain(editor, [2, 1], [0, 0], 'P\tQ\nR\tS\nT\tU')).toEqual([
      ['P', 'Q', 'c', ''],
      ['R', 'S', '', ''],
      ['T', 'U', 'i', 'j'],
    ]);
  });

  test('a selection whose rectangle a row span stretches upwards starts at its top-left', () => {
    // SPAN starts in row 0 and covers (1, 2), so a selection from (1, 0) to
    // (2, 2) holds rows 0 to 2.
    const editor = build([
      ['a', 'b', ['SPAN', 1, 2]],
      ['d', 'e'],
      ['g', 'h', 'i'],
    ]);
    expect(pastePlain(editor, [1, 0], [2, 2], 'P\tQ\nR\tS')).toEqual([
      ['P', 'Q', 'SPAN'],
      ['R', 'S'],
      ['g', 'h', 'i'],
    ]);
  });

  test('a grid larger than a selection made upwards is pasted whole', () => {
    // Plain text that reaches past the selection is still pasted whole from
    // its top-left, as for a selection made from its top-left.
    expect(
      pastePlain(build(GRID), [1, 1], [0, 0], 'A\tB\tC\nD\tE\tF\nG\tH\tI'),
    ).toEqual([
      ['A', 'B', 'C', 'd'],
      ['D', 'E', 'F', 'h'],
      ['G', 'H', 'I', 'l'],
    ]);
  });

  test('the caret lands at the start of the pasted grid after a paste from the bottom right', () => {
    const editor = build(GRID);
    pastePlain(editor, [1, 2], [0, 1], 'W\tX\nY\tZ');
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected a range selection');
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.offset).toBe(0);
      expect(
        $findMatchingParent(selection.anchor.getNode(), $isTableCellNode)!.is(
          $cellAt(0, 1),
        ),
      ).toBe(true);
      expect($cellAt(0, 1).getTextContent()).toBe('W');
    });
  });

  test('a single value goes to the cell the selection was started from', () => {
    expect(pastePlain(build(GRID), [1, 2], [0, 1], 'X')).toEqual([
      ['a', 'b', 'c', 'd'],
      ['e', 'f', 'X', 'h'],
      ['i', 'j', 'k', 'l'],
    ]);
  });

  test('pasted HTML without a table is placed as plain text is', () => {
    // A single formatted word goes to the cell the selection started from;
    // several paragraphs are laid over the selection from its top-left.
    expect(
      pastePlain(build(GRID), [0, 2], [0, 0], '<p><b>X</b></p>', 'text/html'),
    ).toEqual([
      ['a', 'b', 'X', 'd'],
      ['e', 'f', 'g', 'h'],
      ['i', 'j', 'k', 'l'],
    ]);
    expect(
      pastePlain(
        build(GRID),
        [2, 1],
        [0, 1],
        '<p>X</p><p>Y</p><p>Z</p>',
        'text/html',
      ),
    ).toEqual([
      ['a', 'X', 'c', 'd'],
      ['e', 'Y', 'g', 'h'],
      ['i', 'Z', 'k', 'l'],
    ]);
  });

  test('a single selected cell still starts the grid there', () => {
    expect(pastePlain(build(GRID), [1, 2], [1, 2], 'X\tY\nZ\tW')).toEqual([
      ['a', 'b', 'c', 'd'],
      ['e', 'f', 'X', 'Y'],
      ['i', 'j', 'Z', 'W'],
    ]);
  });
});
