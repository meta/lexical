/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getClipboardDataFromSelection,
  $insertDataTransferForRichText,
} from '@lexical/clipboard';
import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $computeTableMapSkipCellCheck,
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $createTableSelectionFrom,
  $isTableCellNode,
  $isTableNode,
  TableCellHeaderStates,
  TableExtension,
  type TableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $setSelection,
  configExtension,
  defineExtension,
  KEY_DELETE_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {assert, expect, test} from 'vitest';

import {$computeTableCellRectBoundary} from '../../LexicalTableUtils';

// A table whose rows have different numbers of cells, as collaborators'
// concurrent row and column inserts can leave it (remote updates skip the
// table transform). Cells are their text, or [text, colSpan, rowSpan].
type Spec = (string | [string, number, number])[][];

function build(rows: Spec) {
  const editor = buildEditorFromExtensions(
    defineExtension({
      afterRegistration(ed) {
        // The table selection observer, which handles the commands below,
        // needs the editor to have a root element.
        const root = document.createElement('div');
        document.body.append(root);
        ed.setRootElement(root);
        return () => root.remove();
      },
      dependencies: [configExtension(TableExtension, {hasNestedTables: true})],
      name: '[ragged-table-selection-clipboard]',
      // Lexical clipboard data pastes into an editor of the same namespace.
      namespace: 'ragged-table-selection-clipboard',
      onError: (error: Error) => {
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
    {discrete: true, skipTransforms: true},
  );
  return editor;
}

function $table() {
  const table = $getRoot().getChildren().find($isTableNode);
  assert(table !== undefined, 'expected a table');
  return table;
}

function $cell(name: string) {
  const cell = $table()
    .getChildren()
    .flatMap(row => (row as TableRowNode).getChildren())
    .find(node => node.getTextContent() === name);
  assert($isTableCellNode(cell), `expected a cell ${name}`);
  return cell;
}

function select(editor: LexicalEditor, anchor: string, focus: string) {
  editor.update(
    () =>
      $setSelection(
        $createTableSelectionFrom($table(), $cell(anchor), $cell(focus)),
      ),
    {discrete: true},
  );
}

function $texts() {
  return $table()
    .getChildren()
    .map(row =>
      (row as TableRowNode).getChildren().map(cell => cell.getTextContent()),
    );
}
function paste(
  source: LexicalEditor,
  target: LexicalEditor,
  a: string,
  f: string,
  targetA: string,
  targetF?: string,
  mime = 'application/x-lexical-editor',
) {
  select(source, a, f);
  const copied = source.read(() =>
    $getClipboardDataFromSelection($getSelection()!),
  );
  const data = new DataTransfer();
  data.setData(mime, copied[mime as keyof typeof copied]!);
  target.update(
    () => {
      const selection = targetF
        ? $createTableSelectionFrom($table(), $cell(targetA), $cell(targetF))
        : $cell(targetA).selectStart();
      $setSelection(selection);
      $insertDataTransferForRichText(data, selection);
    },
    {discrete: true},
  );
}

for (const [label, rows, a, f] of [
  [
    'rectangular',
    [
      ['A', 'B'],
      ['C', 'D'],
    ],
    'A',
    'D',
  ],
  ['colspan', [[['A', 2, 1]], ['B', 'C']], 'A', 'C'],
  ['rowspan at the right edge', [['A', ['B', 1, 2]], ['C']], 'A', 'B'],
  ['one merged cell', [[['A', 2, 2]], []], 'A', 'A'],
] as [string, Spec, string, string][]) {
  test(`full ${label} selection removes the table, including header cells`, () => {
    using editor = build(rows);
    editor.update(
      () => {
        for (const row of $table().getChildren()) {
          for (const cell of (row as TableRowNode).getChildren()) {
            if ($isTableCellNode(cell))
              cell.setHeaderStyles(TableCellHeaderStates.BOTH);
          }
        }
      },
      {discrete: true, skipTransforms: true},
    );
    select(editor, a, f);
    editor.update(
      () =>
        editor.dispatchCommand(
          KEY_DELETE_COMMAND,
          new KeyboardEvent('keydown'),
        ),
      {discrete: true},
    );
    expect(editor.read(() => $getRoot().getChildren().some($isTableNode))).toBe(
      false,
    );
  });
}

test('a partial outer selection containing a whole inner table does not remove the outer table', () => {
  using editor = build([
    ['A', 'B'],
    ['C', 'D'],
  ]);
  editor.update(
    () => {
      const nested = $createTableNode();
      nested.append(
        $createTableRowNode().append(
          $createTableCellNode().append(
            $createParagraphNode().append($createTextNode('INNER')),
          ),
        ),
      );
      $cell('A').append(nested);
      const first = (
        $table().getFirstChildOrThrow() as TableRowNode
      ).getFirstChildOrThrow();
      assert($isTableCellNode(first));
      $setSelection($createTableSelectionFrom($table(), first, $cell('B')));
    },
    {discrete: true},
  );
  editor.update(
    () =>
      editor.dispatchCommand(KEY_DELETE_COMMAND, new KeyboardEvent('keydown')),
    {discrete: true},
  );
  expect(editor.read($texts)).toEqual([
    ['', ''],
    ['C', 'D'],
  ]);
});

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  test(`copy/paste keeps an entirely uncovered middle row at its original position (${mime})`, () => {
    using source = build([['A', 'B', 'C'], ['D'], ['E', 'F', 'G']]);
    using target = build([['T0'], ['KEEP'], ['T2']]);
    paste(source, target, 'B', 'F', 'T0', undefined, mime);
    expect(target.read($texts)).toEqual([['B'], ['KEEP'], ['F']]);
  });
}

test('pasting a ragged merged template next to holes preserves hole texts and resets a reversed selection', () => {
  using source = build([[['M', 2, 1]], ['X'], ['Y', 'Z']]);
  using target = build([
    ['A', 'B', 'OUT0'],
    ['C', 'KEEP', 'OUT1'],
    ['D', 'E', 'OUT2'],
  ]);
  paste(source, target, 'M', 'Z', 'E', 'A');
  expect(target.read($texts)).toEqual([
    ['M', 'OUT0'],
    ['X', 'KEEP', 'OUT1'],
    ['Y', 'Z', 'OUT2'],
  ]);
  expect(
    target.read(() =>
      $getSelection()!
        .getNodes()
        .every(n => n.isAttached()),
    ),
  ).toBe(true);
});

test('wider later rows grow the destination in both dimensions without duplicating text', () => {
  using source = build([['X'], ['Y', 'Z', 'W'], ['Q', 'R', 'S']]);
  using target = build([
    ['KEEP0', 'KEEP1'],
    ['KEEP2', 'START'],
  ]);
  paste(source, target, 'X', 'S', 'START');
  expect(target.read($texts)).toEqual([
    ['KEEP0', 'KEEP1', '', ''],
    ['KEEP2', 'X', '', ''],
    ['', 'Y', 'Z', 'W'],
    ['', 'Q', 'R', 'S'],
  ]);
});

test('a table selection smaller than a ragged merged template clips it and keeps every outside cell', () => {
  using source = build([[['M', 3, 1]], ['X'], ['Y', 'Z', 'W']]);
  using target = build([
    ['A', 'B', 'OUT0'],
    ['C', 'KEEP', 'OUT1'],
    ['OUT2', 'OUT3', 'OUT4'],
  ]);
  paste(source, target, 'M', 'W', 'A', 'KEEP');
  expect(target.read($texts)).toEqual([
    ['M', 'OUT0'],
    ['X', 'KEEP', 'OUT1'],
    ['OUT2', 'OUT3', 'OUT4'],
  ]);
});

test('an interior widest row pulled into the selection by a merge is fully pasted', () => {
  using source = build([
    ['X', 'Y'],
    ['Z', ['M', 2, 1]],
    ['Q', 'R'],
  ]);
  using target = build([
    ['A', 'B', 'KEEP0'],
    ['C', 'D', 'E'],
    ['F', 'G', 'KEEP2'],
  ]);
  paste(source, target, 'X', 'R', 'A');
  expect(target.read($texts)).toEqual([
    ['X', 'Y', 'KEEP0'],
    ['Z', 'M'],
    ['Q', 'R', 'KEEP2'],
  ]);
});

test('rect boundary expands through a finite chain of overlapping merges and stops before unrelated cells', () => {
  using editor = build([
    ['A'],
    ['B', 'C', ['M', 2, 1], 'OUT'],
    ['D', 'E', 'F', ['N', 2, 1]],
    ['G', 'H', 'I', 'J', 'K', 'OUT2'],
  ]);
  editor.read(() => {
    const [map] = $computeTableMapSkipCellCheck($table(), null, null);
    const boundary = $computeTableCellRectBoundary(map, map[1][1], map[3][2]);
    expect(boundary).toEqual({
      maxColumn: 4,
      maxRow: 3,
      minColumn: 1,
      minRow: 1,
    });
  });
});

test('a destination merge covered only by source holes keeps its cells and spans', () => {
  using source = build([['X', 'Y', 'Z'], ['Q'], ['R']]);
  using target = build([['A', 'B', 'C'], ['D', ['KEEP', 2, 2]], ['E']]);
  paste(source, target, 'Z', 'R', 'A', 'KEEP');
  expect(
    target.read(() => [$cell('KEEP').getColSpan(), $cell('KEEP').getRowSpan()]),
  ).toEqual([2, 2]);
  expect(target.read($texts)).toEqual([['X', 'Y', 'Z'], ['Q', 'KEEP'], ['R']]);
});

// The old first/last-node test incorrectly removed this rectangular grid:
// A and C are its first and last physical cells, but B spans the other column.
test('selecting first and last physical cells leaves an unselected rowspan cell intact', () => {
  using editor = build([['A', ['B', 1, 2]], ['C']]);
  select(editor, 'A', 'C');
  editor.update(
    () =>
      editor.dispatchCommand(KEY_DELETE_COMMAND, new KeyboardEvent('keydown')),
    {discrete: true},
  );
  expect(editor.read($texts)).toEqual([['', 'B'], ['']]);
});

test('a full outer selection still removes the table when its last cell contains a nested table', () => {
  using editor = build([
    ['A', 'B'],
    ['C', 'D'],
  ]);
  editor.update(
    () => {
      const last = $cell('D');
      last.append(
        $createTableNode().append(
          $createTableRowNode().append(
            $createTableCellNode().append(
              $createParagraphNode().append($createTextNode('INNER')),
            ),
          ),
        ),
      );
      $setSelection($createTableSelectionFrom($table(), $cell('A'), last));
    },
    {discrete: true},
  );
  editor.update(
    () =>
      editor.dispatchCommand(KEY_DELETE_COMMAND, new KeyboardEvent('keydown')),
    {discrete: true},
  );
  expect(editor.read(() => $getRoot().getChildren().some($isTableNode))).toBe(
    false,
  );
});

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  test(`copying a table with a row covered by row spans pastes it in place (${mime})`, () => {
    using source = build([
      [
        ['A', 1, 2],
        ['B', 1, 2],
      ],
      [],
      ['E', 'F'],
    ]);
    using target = build([
      ['T0', 'T1'],
      ['T2', 'T3'],
      ['T4', 'T5'],
    ]);
    paste(source, target, 'A', 'F', 'T0', undefined, mime);
    expect(target.read($texts)).toEqual([['A', 'B'], [], ['E', 'F']]);
  });
}
