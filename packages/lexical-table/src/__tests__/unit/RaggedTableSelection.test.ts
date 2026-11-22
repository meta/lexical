/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$getClipboardDataFromSelection} from '@lexical/clipboard';
import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $createTableSelection,
  $isTableCellNode,
  $isTableNode,
  $padTableRows,
  TableExtension,
  type TableNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $setSelection,
  defineExtension,
  type ElementNode,
  FORMAT_ELEMENT_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// A table whose rows have different lengths, as a merge of concurrent row and
// column inserts by collaborators can leave it (remote updates skip the table
// transform, and the transform leaves rows it did not change alone). Cells
// are named `r<row>c<index>`; `rowSpan` cells are `[text, rowSpan]`.
type Spec = (string | [string, number])[][];

function buildEditor(rows: Spec) {
  const built = buildEditorFromExtensions(
    defineExtension({
      afterRegistration(editor) {
        // The table selection observer, which handles FORMAT_ELEMENT_COMMAND,
        // needs the editor to have a root element.
        const container = document.createElement('div');
        document.body.appendChild(container);
        editor.setRootElement(container);
        return () => document.body.removeChild(container);
      },
      dependencies: [TableExtension],
      name: '[ragged-table-selection]',
      onError: (error: Error) => {
        throw error;
      },
    }),
  );
  built.update(
    () => {
      const table = $createTableNode();
      for (const cells of rows) {
        const row = $createTableRowNode();
        for (const spec of cells) {
          const [text, rowSpan] = typeof spec === 'string' ? [spec, 1] : spec;
          row.append(
            $createTableCellNode()
              .setRowSpan(rowSpan)
              .append($createParagraphNode().append($createTextNode(text))),
          );
        }
        table.append(row);
      }
      $getRoot().clear().append(table, $createParagraphNode());
    },
    // As a remote update applies it: without the table transform.
    {discrete: true, skipTransforms: true},
  );
  return built;
}

const $table = () => $getRoot().getChildren().find($isTableNode) as TableNode;
const $cellNamed = (name: string) =>
  $table()
    .getAllTextNodes()
    .find(node => node.getTextContent() === name)!
    .getParentOrThrow()
    .getParentOrThrow();
const names = (rows: Spec) =>
  rows.flat().map(spec => (typeof spec === 'string' ? spec : spec[0]));

// The texts of the cells a table selection from `anchor` to `focus` holds.
function selectedCells(
  editor: LexicalEditor,
  anchor: string,
  focus: string,
): string[] {
  let cells: string[] = [];
  editor.update(
    () => {
      const selection = $createTableSelection();
      selection.set(
        $table().getKey(),
        $cellNamed(anchor).getKey(),
        $cellNamed(focus).getKey(),
      );
      $setSelection(selection);
      const tableSelection = $getSelection()!;
      cells = tableSelection
        .getNodes()
        .filter($isTableCellNode)
        .map(cell => cell.getTextContent());
      // Copying it reads the same nodes.
      const copied = $getClipboardDataFromSelection(tableSelection);
      expect(Object.keys(copied).length).toBeGreaterThan(0);
    },
    {discrete: true},
  );
  return cells;
}

const SHAPES: [string, Spec][] = [
  [
    'a short middle row',
    [
      ['r0c0', 'r0c1', 'r0c2', 'r0c3'],
      ['r1c0', 'r1c1'],
      ['r2c0', 'r2c1', 'r2c2', 'r2c3'],
    ],
  ],
  [
    'a short first row',
    [
      ['r0c0', 'r0c1'],
      ['r1c0', 'r1c1', 'r1c2', 'r1c3'],
      ['r2c0', 'r2c1', 'r2c2'],
    ],
  ],
  [
    'a short last row under a row span',
    [['r0c0', ['r0c1', 2], 'r0c2'], ['r1c0', 'r1c1'], ['r2c0']],
  ],
];

describe('a table selection in a ragged table', () => {
  for (const [label, rows] of SHAPES) {
    test(`holds the cells it holds once the table is padded: ${label}`, () => {
      const ragged = buildEditor(rows);
      const padded = buildEditor(rows);
      padded.update(() => $padTableRows($table()), {discrete: true});
      for (const anchor of names(rows)) {
        for (const focus of names(rows)) {
          const expected = selectedCells(padded, anchor, focus).filter(
            text => text !== '',
          );
          expect(selectedCells(ragged, anchor, focus)).toEqual(expected);
        }
      }
      ragged.dispose();
      padded.dispose();
    });

    test(`aligns every cell it holds: ${label}`, () => {
      for (const anchor of names(rows)) {
        for (const focus of names(rows)) {
          const editor = buildEditor(rows);
          const cells = selectedCells(editor, anchor, focus);
          editor.update(
            () => {
              editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center');
            },
            {discrete: true},
          );
          const centered = editor.read(() =>
            $table()
              .getAllTextNodes()
              .filter(node => {
                const paragraph = node.getParentOrThrow();
                const cell = paragraph.getParentOrThrow() as ElementNode;
                // The cell and the paragraph in it are both aligned.
                return (
                  cell.getFormatType() === 'center' &&
                  paragraph.getFormatType() === 'center'
                );
              })
              .map(node => node.getTextContent()),
          );
          if (editor.read(() => $table().getFormatType()) === 'center') {
            // A selection spanning the table's first row and every row
            // formats the table itself.
            expect(centered).toEqual([]);
          } else {
            expect(centered.sort()).toEqual([...cells].sort());
          }
          editor.dispose();
        }
      }
    });
  }
});
