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

// Each anchor's selections run as their own test, so that each stays fast.
// Joined in order, their outputs give the fingerprints of the single test
// they replace: plain b62cb6f7, column span 447f760f, row span 33c3a3eb.
const EXPECTED: Record<string, Record<string, string>> = {
  'column span': {
    A: '39f16cf6',
    C: 'd98c4395',
    D: 'ee97e59f',
    E: 'c6f94ac',
    F: 'b2354392',
    G: '6c1b16b3',
    H: '5aa57a18',
    I: 'f32fd53b',
  },
  plain: {
    A: '5ab19be',
    B: 'e7022808',
    C: 'c701f8e8',
    D: 'd94fee24',
    E: 'd49b1ceb',
    F: '33577522',
    G: '8d6f2d7a',
    H: '570c9f7a',
    I: '57167d28',
  },
  // Main differs only in the copy and paste of A with G (both directions),
  // checked below.
  'row span': {
    A: '468eba6e',
    B: '1010e1a5',
    C: '4c07bceb',
    E: '17e03be8',
    F: '634eba2a',
    G: '420fb5b9',
    H: '967da8f0',
    I: '9fdba547',
  },
};

for (const [label, rows] of RECTANGULAR) {
  const names = rows
    .flat()
    .map(spec => (typeof spec === 'string' ? spec : spec[0]));
  for (const anchor of names) {
    test(`copy, delete and paste of every selection from ${anchor} are unchanged: ${label}`, () => {
      const outputs: string[] = [];
      // One source and one target, reset to their first state for each
      // selection, which is much faster than building editors for each.
      using source = build(rows);
      using target = build([
        ['T0', 'T1', 'T2'],
        ['T3', 'T4', 'T5'],
        ['T6', 'T7', 'T8'],
      ]);
      const sourceState = source.getEditorState();
      const targetState = target.getEditorState();
      for (const focus of names) {
        source.setEditorState(sourceState);
        select(source, anchor, focus);
        const copied = source.read(() =>
          $getClipboardDataFromSelection($getSelection()!),
        );
        outputs.push(JSON.stringify(copied));
        for (const mime of ['application/x-lexical-editor', 'text/html']) {
          target.setEditorState(targetState);
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
      expect(fingerprint(outputs.join('\n'))).toBe(EXPECTED[label][anchor]);
    });
  }
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
