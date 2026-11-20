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
  CUT_COMMAND,
  defineExtension,
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
      name: '[ragged-table-selection-covered-rows]',
      // Lexical clipboard data pastes into an editor of the same namespace.
      namespace: 'ragged-table-selection-covered-rows',
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

// Valid source spans end at row 1, within the four physical rows.
// Column 1: B, B, hole, E. The copy must keep all four positions.
const OMITTED_COVERED_ROW: Spec = [['A', ['B', 1, 2]], [], ['C'], ['D', 'E']];

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  test(`copying a covered row before a hole retains all physical rows (${mime})`, () => {
    using source = build(OMITTED_COVERED_ROW);
    select(source, 'B', 'E');
    source.read(() => {
      expect(
        $getSelection()!
          .getNodes()
          .filter($isTableCellNode)
          .map(c => c.getTextContent()),
      ).toEqual(['B', 'E']);
      const data = $getClipboardDataFromSelection($getSelection()!);
      const counts =
        mime === 'application/x-lexical-editor'
          ? JSON.parse(data[mime]!).nodes[0].children.map(
              (row: {children: unknown[]}) => row.children.length,
            )
          : [
              ...new DOMParser()
                .parseFromString(data[mime]!, 'text/html')
                .querySelectorAll('tr'),
            ].map(r => r.querySelectorAll('td,th').length);
      expect(counts).toEqual([1, 0, 0, 1]);
    });
  });

  for (const header of [false, true]) {
    test(`paste keeps E below the hole and preserves KEEP (${mime}, header=${header})`, () => {
      using source = build(OMITTED_COVERED_ROW);
      if (header)
        source.update(
          () => {
            $cell('B').setHeaderStyles(TableCellHeaderStates.BOTH);
            $cell('E').setHeaderStyles(TableCellHeaderStates.BOTH);
          },
          {discrete: true, skipTransforms: true},
        );
      using target = build([['T0'], ['T1'], ['KEEP'], ['T3']]);
      paste(source, target, 'B', 'E', 'T0', undefined, mime);
      expect(target.read($texts)).toEqual([['B'], [], ['KEEP'], ['E']]);
    });
  }

  test(`cut followed by paste does not overwrite text at the hole (${mime})`, () => {
    using source = build(OMITTED_COVERED_ROW);
    select(source, 'B', 'E');
    const data = new DataTransfer();
    source.update(
      () =>
        source.dispatchCommand(
          CUT_COMMAND,
          new ClipboardEvent('cut', {clipboardData: data}),
        ),
      {discrete: true},
    );
    expect(source.read($texts)).toEqual([['A', ''], [], ['C'], ['D', '']]);
    const onlyMime = new DataTransfer();
    onlyMime.setData(mime, data.getData(mime));
    using target = build([['T0'], ['T1'], ['KEEP'], ['T3']]);
    target.update(
      () => {
        const selection = $cell('T0').selectStart();
        $insertDataTransferForRichText(onlyMime, selection);
      },
      {discrete: true},
    );
    expect(target.read($texts)).toEqual([['B'], [], ['KEEP'], ['E']]);
  });
}

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  test(`cutting the whole ragged table and pasting into a table selection keeps D (${mime})`, () => {
    using source = build([
      [
        ['A', 1, 3],
        ['B', 1, 2],
      ],
      [],
      [],
      ['C', 'D'],
    ]);
    select(source, 'A', 'D');
    const data = new DataTransfer();
    source.update(
      () =>
        source.dispatchCommand(
          CUT_COMMAND,
          new ClipboardEvent('cut', {clipboardData: data}),
        ),
      {discrete: true},
    );
    expect(source.read(() => $getRoot().getChildren().some($isTableNode))).toBe(
      false,
    );
    using target = build([
      ['T00', 'T01'],
      ['T10', 'T11'],
      ['KEEP0', 'KEEP1'],
      ['T30', 'T31'],
    ]);
    const onlyMime = new DataTransfer();
    onlyMime.setData(mime, data.getData(mime));
    target.update(
      () => {
        const selection = $createTableSelectionFrom(
          $table(),
          $cell('T00'),
          $cell('T31'),
        );
        $setSelection(selection);
        $insertDataTransferForRichText(onlyMime, selection);
      },
      {discrete: true},
    );
    expect(target.read($texts)).toEqual([
      ['A', 'B'],
      [],
      ['KEEP1'],
      ['C', 'D'],
    ]);
  });
}
