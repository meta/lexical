/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $generateJSONFromSelectedNodes,
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
  $isTableRowNode,
  TableExtension,
  type TableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $setSelection,
  configExtension,
  defineExtension,
  KEY_DELETE_COMMAND,
  type LexicalEditor,
  type LexicalNode,
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
      name: '[ragged-table-selection-rows]',
      // Lexical clipboard data pastes into an editor of the same namespace.
      namespace: 'ragged-table-selection-rows',
      onError: (error: Error) => {
        throw error;
      },
      theme: {
        tableCellSelected: 'selected',
        tableScrollableWrapper: 'table-scrollable-wrapper',
      },
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

// Unlike an uncovered row, this empty physical row has map entries from above.
test('a row fully covered by row spans belongs to the selection', () => {
  using editor = build([
    [
      ['A', 1, 2],
      ['B', 1, 2],
    ],
    [],
    ['C', 'D'],
  ]);
  select(editor, 'A', 'D');
  editor.read(() => {
    const rows = $table().getChildren();
    const nodes = $getSelection()!.getNodes();
    expect(nodes.filter($isTableRowNode)).toEqual(rows);
    expect(new Set(nodes.map(n => n.getKey())).size).toBe(nodes.length);
    expect(nodes.filter($isTableCellNode).map(n => n.getTextContent())).toEqual(
      ['A', 'B', 'C', 'D'],
    );
  });
});

test('multiple uncovered rows export in order without leaking their unselected cells', () => {
  using editor = build([
    ['A', 'B'],
    ['KEEP1'],
    ['KEEP2'],
    ['C', 'D'],
    ['KEEP3'],
    ['E', 'F'],
  ]);
  select(editor, 'B', 'F');
  editor.read(() => {
    const nodes = $getSelection()!.getNodes();
    expect(nodes.filter($isTableRowNode)).toEqual($table().getChildren());
    expect(new Set(nodes.map(n => n.getKey())).size).toBe(nodes.length);
    expect(nodes.filter($isTableCellNode).map(n => n.getTextContent())).toEqual(
      ['B', 'D', 'F'],
    );
    const json = $generateJSONFromSelectedNodes(editor, $getSelection());
    expect(json.nodes[0].children!.map(r => r.children!.length)).toEqual([
      1, 0, 0, 1, 0, 1,
    ]);
    const copied = $getClipboardDataFromSelection($getSelection());
    const dom = new DOMParser().parseFromString(
      copied['text/html']!,
      'text/html',
    );
    expect(
      [...dom.querySelectorAll('tr')].map(
        r => r.querySelectorAll('td,th').length,
      ),
    ).toEqual([1, 0, 0, 1, 0, 1]);
    expect(copied['application/x-lexical-editor']).not.toContain('KEEP');
    expect(copied['text/html']).not.toContain('KEEP');
    expect($getSelection()!.getTextContent()).toBe('B\n\n\nD\n\nF\n');
  });
  expect(editor.getRootElement()!.querySelectorAll('td.selected')).toHaveLength(
    3,
  );
  editor.update(
    () =>
      editor.dispatchCommand(KEY_DELETE_COMMAND, new KeyboardEvent('keydown')),
    {discrete: true},
  );
  expect(editor.read($texts)).toEqual([
    ['A', ''],
    ['KEEP1'],
    ['KEEP2'],
    ['C', ''],
    ['KEEP3'],
    ['E', ''],
  ]);
});

test('insertNodes still uses the focus cell when uncovered rows are selected', () => {
  using editor = build([['A', 'B'], ['KEEP'], ['C', 'D']]);
  select(editor, 'B', 'D');
  editor.update(
    () =>
      $getSelection()!.insertNodes([
        $createParagraphNode().append($createTextNode('NEW')),
      ]),
    {discrete: true},
  );
  expect(editor.read($texts)).toEqual([['A', 'B'], ['KEEP'], ['C', 'NEW']]);
});

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  for (const [label, sourceRows, targetRows, a, f, targetA, expected] of [
    [
      'colspan covered only by holes',
      [['X', 'Y', 'Z'], ['Q'], ['R', 'S', 'T']],
      [
        ['A', 'B', 'C'],
        ['D', ['KEEP', 2, 1]],
        ['E', 'F', 'G'],
      ],
      'X',
      'T',
      'A',
      [
        ['X', 'Y', 'Z'],
        ['Q', 'KEEP'],
        ['R', 'S', 'T'],
      ],
    ],
    [
      'colspan starts on a cell, ends on a hole',
      [
        ['X', 'Y', 'Z'],
        ['Q', 'R'],
        ['S', 'T', 'U'],
      ],
      [
        ['A', 'B', 'C'],
        ['D', ['OLD', 2, 1]],
        ['E', 'F', 'G'],
      ],
      'X',
      'U',
      'A',
      [
        ['X', 'Y', 'Z'],
        ['Q', 'R', ''],
        ['S', 'T', 'U'],
      ],
    ],
    [
      'rowspan starts on a hole, ends on a cell',
      [['X', 'Y'], ['Q'], ['R', 'S']],
      [['A', 'B'], ['C', ['KEEP', 1, 2]], ['D']],
      'X',
      'S',
      'A',
      [
        ['X', 'Y'],
        ['Q', 'KEEP'],
        ['R', 'S'],
      ],
    ],
    [
      'rowspan starts on a cell, ends on a hole',
      [['X', 'Y'], ['Q', 'R'], ['S']],
      [['A', 'B'], ['C', ['OLD', 1, 2]], ['D']],
      'Y',
      'S',
      'A',
      [
        ['X', 'Y'],
        ['Q', 'R'],
        ['S', ''],
      ],
    ],
    [
      'two-dimensional merge touches one pasted corner',
      [['X', 'Y', 'Z'], ['Q'], ['R', 'S']],
      [['A', 'B', 'C'], ['D', ['KEEP', 2, 2]], ['E']],
      'Z',
      'R',
      'A',
      [
        ['X', 'Y', 'Z'],
        ['Q', 'KEEP', ''],
        ['R', 'S', ''],
      ],
    ],
  ] as [string, Spec, Spec, string, string, string, string[][]][]) {
    test(`mixed overlap: ${label} (${mime})`, () => {
      using source = build(sourceRows);
      using target = build(targetRows);
      paste(source, target, a, f, targetA, undefined, mime);
      expect(target.read($texts)).toEqual(expected);
      target.read(() => {
        const [map] = $computeTableMapSkipCellCheck($table(), null, null);
        const keys = $table()
          .getChildren()
          .flatMap(r => (r as TableRowNode).getChildren().map(c => c.getKey()));
        expect(new Set(keys).size).toBe(keys.length);
        for (const row of map)
          for (const value of row) {
            expect(value.cell.isAttached()).toBe(true);
            expect(value.cell.getColSpan()).toBe(
              label === 'colspan covered only by holes' &&
                value.cell.getTextContent() === 'KEEP'
                ? 2
                : 1,
            );
            expect(value.cell.getRowSpan()).toBe(1);
          }
      });
    });
  }
}

test('copying a selection with an interior hole beside a rowspan does not throw', () => {
  using editor = build([['X', 'Y', ['SPAN', 1, 2]], ['Q']]);
  select(editor, 'X', 'SPAN');
  editor.read(() => {
    expect(
      $getSelection()!
        .getNodes()
        .filter($isTableCellNode)
        .map(n => n.getTextContent()),
    ).toEqual(['X', 'Y', 'SPAN', 'Q']);
    expect(
      $generateJSONFromSelectedNodes(
        editor,
        $getSelection(),
      ).nodes[0].children!.map(row => row.children!.length),
    ).toEqual([3, 1]);
    expect(() => $getClipboardDataFromSelection($getSelection())).not.toThrow();
  });
});

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  test(`a truly empty physical row is retained by copy and paste (${mime})`, () => {
    using source = build([['A', 'B'], [], ['C', 'D']]);
    using target = build([
      ['T0', 'T1'],
      ['KEEP0', 'KEEP1'],
      ['T2', 'T3'],
    ]);
    paste(source, target, 'A', 'D', 'T0', undefined, mime);
    expect(target.read($texts)).toEqual([
      ['A', 'B'],
      ['KEEP0', 'KEEP1'],
      ['C', 'D'],
    ]);
  });
}

for (const [label, shape] of [
  [
    'ordinary rectangle',
    [
      ['A', 'B'],
      ['C', 'D'],
    ],
  ],
  [
    'mixed row and column spans',
    [
      ['A', ['B', 2, 2], 'C'],
      ['D', 'E'],
      ['F', 'G', 'H', 'I'],
    ],
  ],
  [
    'entire row spanned from above',
    [
      [
        ['A', 2, 2],
        ['B', 2, 2],
      ],
      [],
      ['C', 'D', 'E', 'F'],
    ],
  ],
] as [string, Spec][]) {
  test(`all anchor/focus pairs give the spanned rows and the cells in grid order: ${label}`, () => {
    using editor = build(shape);
    editor.read(() => {
      const table = $table();
      const cells = table
        .getChildren()
        .flatMap(r => (r as TableRowNode).getChildren())
        .filter($isTableCellNode);
      const [map] = $computeTableMapSkipCellCheck(table, null, null);
      const visit = (node: LexicalNode, out: Map<string, LexicalNode>) => {
        out.set(node.getKey(), node);
        if ($isElementNode(node))
          for (const child of node.getChildren()) visit(child, out);
      };
      for (const anchor of cells)
        for (const focus of cells) {
          const selection = $createTableSelectionFrom(table, anchor, focus);
          const am = map.flat().find(v => v.cell.is(anchor))!;
          const fm = map.flat().find(v => v.cell.is(focus))!;
          const boundary = $computeTableCellRectBoundary(map, am, fm);
          // Parents and cell subtrees in grid scan order.
          const expected = new Map<string, LexicalNode>([
            [table.getKey(), table],
          ]);
          // Every row up to the last one with a cell of its own in the
          // selection, also one covered only by cells spanning from above.
          let lastRow = boundary.minRow;
          for (let r = boundary.minRow; r <= boundary.maxRow; r++) {
            for (let c = boundary.minColumn; c <= boundary.maxColumn; c++) {
              if (map[r][c].startRow === r) {
                lastRow = r;
              }
            }
          }
          for (let r = boundary.minRow; r <= boundary.maxRow; r++) {
            if (r <= lastRow) {
              const rowNode = table.getChildAtIndex(r)!;
              expected.set(rowNode.getKey(), rowNode);
            }
            for (let c = boundary.minColumn; c <= boundary.maxColumn; c++) {
              const cell = map[r][c].cell;
              const row = cell.getParentOrThrow();
              expected.set(row.getKey(), row);
              visit(cell, expected);
            }
          }
          expect(selection.getNodes()).toEqual([...expected.values()]);
        }
    });
  });
}
