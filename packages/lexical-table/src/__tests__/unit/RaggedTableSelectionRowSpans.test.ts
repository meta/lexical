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
  FORMAT_ELEMENT_COMMAND,
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
      name: '[ragged-table-selection-row-spans]',
      // Lexical clipboard data pastes into an editor of the same namespace.
      namespace: 'ragged-table-selection-row-spans',
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

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  test(`an interior-hole row crossed by a selected rowspan keeps its position (${mime})`, () => {
    using source = build([['X', 'Y', ['SPAN', 1, 3]], ['KEEP'], ['Q', 'R']]);
    select(source, 'Y', 'SPAN');
    source.read(() => {
      const selection = $getSelection()!;
      expect(
        selection
          .getNodes()
          .filter($isTableCellNode)
          .map(c => c.getTextContent()),
      ).toEqual(['Y', 'SPAN', 'R']);
      if (mime === 'application/x-lexical-editor') {
        const json = $generateJSONFromSelectedNodes(source, selection);
        expect(json.nodes[0].children!.map(r => r.children!.length)).toEqual([
          2, 0, 1,
        ]);
        return;
      }
      const data = $getClipboardDataFromSelection(selection);
      const html = new DOMParser().parseFromString(
        data['text/html']!,
        'text/html',
      );
      expect(
        [...html.querySelectorAll('tr')].map(
          r => r.querySelectorAll('td,th').length,
        ),
      ).toEqual([2, 0, 1]);
    });
  });
}

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  test(`copy/paste does not move R into a hole beside a rowspan (${mime})`, () => {
    using source = build([['X', 'Y', ['SPAN', 1, 3]], ['KEEP'], ['Q', 'R']]);
    using target = build([
      ['A', 'B'],
      ['HOLE', 'D'],
      ['E', 'F'],
    ]);
    paste(source, target, 'Y', 'SPAN', 'A', undefined, mime);
    expect(target.read($texts)).toEqual([['Y', 'SPAN'], ['HOLE'], ['R']]);
  });
}

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  test(`an uncovered interior hole row with an unselected rowspan farther right survives (${mime})`, () => {
    using source = build([['X', 'Y', ['SPAN', 1, 3]], ['KEEP'], ['Q', 'R']]);
    using target = build([['A'], ['HOLE'], ['E']]);
    paste(source, target, 'Y', 'R', 'A', undefined, mime);
    expect(target.read($texts)).toEqual([['Y'], ['HOLE'], ['R']]);
  });
}

test('ragged selected cell texts, DOM highlight, alignment and deletion agree beside a rowspan', () => {
  using editor = build([['X', 'Y', ['SPAN', 1, 3]], ['KEEP'], ['Q', 'R']]);
  select(editor, 'Y', 'R');
  editor.read(() => {
    expect($getSelection()!.getTextContent()).toBe('Y\n\nR\n');
    expect(
      $getSelection()!
        .getNodes()
        .filter($isTableCellNode)
        .map(c => c.getTextContent()),
    ).toEqual(['Y', 'R']);
  });
  expect(
    [...editor.getRootElement()!.querySelectorAll('td.selected')].map(
      c => c.textContent,
    ),
  ).toEqual(['Y', 'R']);
  editor.update(
    () => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center'),
    {discrete: true},
  );
  editor.read(() => {
    expect($cell('Y').getFormatType()).toBe('center');
    expect($cell('R').getFormatType()).toBe('center');
    expect($cell('SPAN').getFormatType()).toBe('');
    expect($cell('KEEP').getFormatType()).toBe('');
  });
  editor.update(
    () =>
      editor.dispatchCommand(KEY_DELETE_COMMAND, new KeyboardEvent('keydown')),
    {discrete: true},
  );
  expect(editor.read($texts)).toEqual([['X', '', 'SPAN'], ['KEEP'], ['Q', '']]);
});
