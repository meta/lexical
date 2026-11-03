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
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $createTableSelectionFrom,
  $isTableCellNode,
  $isTableNode,
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
      name: '[rectangular-table-selection]',
      // Lexical clipboard data pastes into an editor of the same namespace.
      namespace: 'rectangular-table-selection',
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

// Tables without holes: copying, deleting and pasting every selection gives
// exactly what it gave before the ragged-table changes, except where main
// dropped a copied cell (checked separately below). EXPECTED is the
// fingerprint of those outputs on main before the changes, apart from that
// row-span table.
function fingerprint(text: string): string {
  // FNV-1a, 32 bit
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

const RECTANGULAR: [string, Spec][] = [
  [
    'plain',
    [
      ['A', 'B', 'C'],
      ['D', 'E', 'F'],
      ['G', 'H', 'I'],
    ],
  ],
  [
    'column span',
    [
      [['A', 2, 1], 'C'],
      ['D', 'E', 'F'],
      ['G', 'H', 'I'],
    ],
  ],
  [
    'row span',
    [
      [['A', 1, 2], 'B', 'C'],
      ['E', 'F'],
      ['G', 'H', 'I'],
    ],
  ],
];

const EXPECTED: Record<string, string> = {
  'column span': '447f760f',
  plain: 'b62cb6f7',
  // Main: 'b47ff14b'. It differs only in the copy and paste of A with G (both
  // directions), checked below.
  'row span': '33c3a3eb',
};

for (const [label, rows] of RECTANGULAR) {
  test(`copy, delete and paste of every selection are unchanged: ${label}`, () => {
    const names = rows
      .flat()
      .map(spec => (typeof spec === 'string' ? spec : spec[0]));
    const outputs: string[] = [];
    for (const anchor of names) {
      for (const focus of names) {
        using source = build(rows);
        select(source, anchor, focus);
        const copied = source.read(() =>
          $getClipboardDataFromSelection($getSelection()!),
        );
        outputs.push(JSON.stringify(copied));
        for (const mime of ['application/x-lexical-editor', 'text/html']) {
          using target = build([
            ['T0', 'T1', 'T2'],
            ['T3', 'T4', 'T5'],
            ['T6', 'T7', 'T8'],
          ]);
          paste(source, target, anchor, focus, 'T0', undefined, mime);
          outputs.push(JSON.stringify(target.getEditorState().toJSON()));
        }
        source.update(
          () =>
            source.dispatchCommand(
              KEY_DELETE_COMMAND,
              new KeyboardEvent('keydown'),
            ),
          {discrete: true},
        );
        outputs.push(JSON.stringify(source.getEditorState().toJSON()));
      }
    }
    const print = fingerprint(outputs.join('\n'));
    expect(print).toBe(EXPECTED[label]);
  });
}

// The row-span table: the row under A is covered within a selection from A
// to G only by A's row span. Main left it out of the copy, so the paste
// dropped G; the copy now keeps it. A copied alone still pastes into one
// cell.
const ROW_SPAN: Spec = [
  [['A', 1, 2], 'B', 'C'],
  ['E', 'F'],
  ['G', 'H', 'I'],
];
const TARGET: Spec = [
  ['T0', 'T1', 'T2'],
  ['T3', 'T4', 'T5'],
  ['T6', 'T7', 'T8'],
];

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  test(`pasting a copy of A and G puts G in its row (${mime})`, () => {
    using source = build(ROW_SPAN);
    using target = build(TARGET);
    paste(source, target, 'A', 'G', 'T0', undefined, mime);
    // Main dropped G: [['A', 'T1', 'T2'], ['T4', 'T5'], ['T6', 'T7', 'T8']].
    expect(target.read($texts)).toEqual([
      ['A', 'T1', 'T2'],
      ['T4', 'T5'],
      ['G', 'T7', 'T8'],
    ]);
  });

  test(`pasting a copy of A alone pastes it into one cell, as before (${mime})`, () => {
    using source = build(ROW_SPAN);
    using target = build(TARGET);
    paste(source, target, 'A', 'A', 'T0', undefined, mime);
    expect(target.read($texts)).toEqual([
      ['A', 'T1', 'T2'],
      ['T3', 'T4', 'T5'],
      ['T6', 'T7', 'T8'],
    ]);
  });
}
