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
  $createTableSelectionFrom,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableExtension,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

type CellSpec = {
  text: string;
  colSpan?: number;
  rowSpan?: number;
  nested?: string;
};

function $createCell({text, colSpan = 1, rowSpan = 1, nested}: CellSpec) {
  const cell = $createTableCellNode()
    .setColSpan(colSpan)
    .setRowSpan(rowSpan)
    .append($createParagraphNode().append($createTextNode(text)));
  if (nested !== undefined) {
    cell.append(
      $createTableNode().append(
        $createTableRowNode().append(
          $createTableCellNode().append(
            $createParagraphNode().append($createTextNode(nested)),
          ),
        ),
      ),
    );
  }
  return cell;
}

function buildEditor(rows: CellSpec[][]) {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [configExtension(TableExtension, {hasNestedTables: true})],
      name: '[nested-table-selection-text]',
      onError: (error: Error) => {
        throw error;
      },
    }),
  );
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createTableNode().append(
            ...rows.map(specs =>
              $createTableRowNode().append(...specs.map($createCell)),
            ),
          ),
        );
    },
    {discrete: true, skipTransforms: true},
  );
  return editor;
}

function $selectionBetween(first: string, last: string) {
  const table = $getRoot().getFirstChild();
  assert($isTableNode(table));
  const cells = table
    .getChildren()
    .filter($isTableRowNode)
    .flatMap(row => row.getChildren().filter($isTableCellNode));
  const cellWithText = (text: string) => {
    const cell = cells.find(
      node => node.getFirstChildOrThrow().getTextContent() === text,
    );
    assert(cell !== undefined);
    return cell;
  };
  return $createTableSelectionFrom(
    table,
    cellWithText(first),
    cellWithText(last),
  );
}

function textBetween(editor: LexicalEditor, first: string, last: string) {
  return editor.read(() => $selectionBetween(first, last).getTextContent());
}

function occurrences(haystack: string | undefined, needle: string) {
  return (haystack || '').split(needle).length - 1;
}

describe('the plain text of a table selection holding a nested table (#9755)', () => {
  test('has the nested text once in every clipboard format of the copy', () => {
    const editor = buildEditor([
      [{nested: 'INNER', text: 'A'}, {text: 'B'}],
      [{text: 'C'}, {text: 'D'}],
    ]);
    editor.read(() => {
      const data = $getClipboardDataFromSelection($selectionBetween('A', 'D'));
      expect(data['text/plain']).toBe('A\n\nINNER\tB\nC\tD\n');
      expect(occurrences(data['text/html'], 'INNER')).toBe(1);
      expect(occurrences(data['application/x-lexical-editor'], 'INNER')).toBe(
        1,
      );
    });
  });

  test('has the nested text once in a cell that spans columns', () => {
    const editor = buildEditor([
      [{colSpan: 2, nested: 'INNER', text: 'A'}],
      [{text: 'C'}, {text: 'D'}],
    ]);
    expect(textBetween(editor, 'A', 'D')).toBe('A\n\nINNER\nC\tD\n');
  });

  test('has the nested text once in a cell that spans rows', () => {
    const editor = buildEditor([
      [{nested: 'INNER', rowSpan: 2, text: 'A'}, {text: 'B'}],
      [{text: 'C'}],
    ]);
    expect(textBetween(editor, 'A', 'C')).toBe('A\n\nINNER\tB\nC\n');
  });

  test('has the nested text once in a ragged table', () => {
    const editor = buildEditor([
      [{nested: 'INNER', text: 'A'}, {text: 'B'}],
      [{text: 'C'}],
    ]);
    expect(textBetween(editor, 'A', 'C')).toBe('A\n\nINNER\nC\n');
  });

  test('has no nested text when the selection leaves the nested cell out', () => {
    const editor = buildEditor([
      [{nested: 'INNER', text: 'A'}, {text: 'B'}],
      [{text: 'C'}, {text: 'D'}],
    ]);
    expect(textBetween(editor, 'C', 'D')).toBe('C\tD\n');
  });
});
