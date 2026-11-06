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
  $createTableNodeWithDimensions,
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
  CUT_COMMAND,
  defineExtension,
  FORMAT_ELEMENT_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

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
      dependencies: [TableExtension],
      name: '[ragged-table-selection-commands]',
      // Lexical clipboard data pastes into an editor of the same namespace.
      namespace: 'ragged-table-selection-commands',
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

const $selectedCells = () =>
  $getSelection()!
    .getNodes()
    .filter($isTableCellNode)
    .map(cell => cell.getTextContent());

// A to G holds every row's first two cells, but not KEEP.
const HOLE_ROWS: Spec = [['A', 'B'], ['C'], ['D', 'E', 'KEEP'], ['F', 'G']];

describe('commands on a table selection in a ragged table', () => {
  for (const [label, command] of [
    ['delete', KEY_DELETE_COMMAND],
    ['backspace', KEY_BACKSPACE_COMMAND],
  ] as const) {
    test(`${label} clears the selected cells and keeps a cell outside the selection`, () => {
      using editor = build(HOLE_ROWS);
      select(editor, 'A', 'G');
      editor.update(
        () => editor.dispatchCommand(command, new KeyboardEvent('keydown')),
        {discrete: true},
      );
      expect(
        editor.read(() =>
          $table()
            .getAllTextNodes()
            .map(node => node.getTextContent())
            .filter(text => text !== ''),
        ),
      ).toEqual(['KEEP']);
    });
  }

  test('cut copies the selected cells and keeps a cell outside the selection', () => {
    using editor = build(HOLE_ROWS);
    select(editor, 'A', 'G');
    const data = new DataTransfer();
    editor.update(
      () =>
        editor.dispatchCommand(
          CUT_COMMAND,
          new ClipboardEvent('cut', {clipboardData: data}),
        ),
      {discrete: true},
    );
    for (const mime of [
      'text/plain',
      'text/html',
      'application/x-lexical-editor',
    ]) {
      expect(data.getData(mime)).toContain('G');
      expect(data.getData(mime)).not.toContain('KEEP');
    }
    expect(editor.read(() => $getRoot().getTextContent())).toContain('KEEP');
  });

  test('delete removes the table when the selection holds every cell', () => {
    using editor = build([['A', 'B'], ['C'], ['D', 'E']]);
    select(editor, 'A', 'E');
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

  test('delete removes a table with a nested table when the selection holds every cell', () => {
    using editor = build([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    editor.update(
      () => {
        $cell('B').append($createTableNodeWithDimensions(2, 2, false));
      },
      {discrete: true},
    );
    select(editor, 'A', 'D');
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

  test('a merged cell beyond a short first row is held whole', () => {
    using editor = build([
      ['A'],
      ['B', 'C', ['M', 2, 1]],
      ['D', 'E', 'F', 'G'],
    ]);
    select(editor, 'C', 'F');
    expect(editor.read($selectedCells)).toEqual(['C', 'M', 'E', 'F', 'G']);
    editor.update(
      () => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center'),
      {discrete: true},
    );
    expect(editor.read(() => $cell('G').getFormatType())).toBe('center');
  });

  function copyAndPaste(
    source: LexicalEditor,
    target: LexicalEditor,
    anchor: string,
    focus: string,
  ) {
    select(source, anchor, focus);
    const copied = source.read(() =>
      $getClipboardDataFromSelection($getSelection()!),
    );
    const data = new DataTransfer();
    data.setData(
      'application/x-lexical-editor',
      copied['application/x-lexical-editor']!,
    );
    target.update(
      () => $insertDataTransferForRichText(data, $cell('A').selectStart()),
      {discrete: true},
    );
  }

  test('pasting a copied ragged selection leaves the cell at its missing position alone', () => {
    using source = build([['X', 'Y'], ['Z'], ['Q', 'R']]);
    using target = build([
      ['A', 'B'],
      ['C', 'D'],
      ['E', 'F'],
    ]);
    copyAndPaste(source, target, 'X', 'R');
    expect(
      target.read(() =>
        $table()
          .getAllTextNodes()
          .map(node => node.getTextContent()),
      ),
    ).toEqual(['X', 'Y', 'Z', 'D', 'Q', 'R']);
  });

  test('pasting a copied selection with a short first row pastes the longer rows whole', () => {
    using source = build([['X'], ['Y', 'Z']]);
    using target = build([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    copyAndPaste(source, target, 'X', 'Z');
    expect(
      target.read(() =>
        $table()
          .getAllTextNodes()
          .map(node => node.getTextContent()),
      ),
    ).toEqual(['X', 'B', 'Y', 'Z']);
  });
});
