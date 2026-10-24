/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {$generateHtmlFromNodes} from '@lexical/html';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $isTableNode,
  TableCellHeaderStates,
  TableCellNode,
  TableExtension,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  COLLABORATION_TAG,
  defineExtension,
  HISTORIC_TAG,
  type LexicalEditor,
  type SerializedEditorState,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

type CellSpec = {colSpan?: number; headerState?: number};
type RowSpec = (number | CellSpec)[];

// Rows are given as lists of cells; a number is shorthand for that many plain
// cells. e.g. [[3], [1]] is a table whose rows have 3 and 1 cells.
function expandRow(spec: RowSpec): CellSpec[] {
  return spec.flatMap(item =>
    typeof item === 'number'
      ? Array.from({length: item}, (): CellSpec => ({}))
      : [item],
  );
}

function serializedTable(rows: RowSpec[]): SerializedEditorState {
  const paragraph = {
    children: [],
    direction: null,
    format: '',
    indent: 0,
    textFormat: 0,
    textStyle: '',
    type: 'paragraph',
    version: 1,
  };
  return {
    root: {
      children: [
        {
          children: rows.map(spec => ({
            children: expandRow(spec).map(({colSpan = 1, headerState = 0}) => ({
              backgroundColor: null,
              children: [paragraph],
              colSpan,
              direction: null,
              format: '',
              headerState,
              indent: 0,
              rowSpan: 1,
              type: 'tablecell',
              version: 1,
              width: null,
            })),
            direction: null,
            format: '',
            indent: 0,
            type: 'tablerow',
            version: 1,
          })),
          direction: null,
          format: '',
          indent: 0,
          type: 'table',
          version: 1,
        },
        paragraph,
      ],
      direction: null,
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  } as unknown as SerializedEditorState;
}

// Inserts a ragged table in an update that skips transforms, the way a merged
// collaboration update or another skipTransforms caller would.
function insertRaggedTable(
  editor: LexicalEditor,
  rows: RowSpec[],
  tag?: string,
) {
  editor.update(
    () => {
      const table = $createTableNode();
      for (const spec of rows) {
        const row = $createTableRowNode();
        for (const {colSpan = 1, headerState = 0} of expandRow(spec)) {
          row.append(
            $createTableCellNode(headerState, colSpan).append(
              $createParagraphNode().append($createTextNode('x')),
            ),
          );
        }
        table.append(row);
      }
      $getRoot().clear().append(table, $createParagraphNode());
    },
    {discrete: true, skipTransforms: true, tag},
  );
}

// Padding runs in a follow-up update scheduled from an update listener,
// which Lexical commits asynchronously.
function flushUpdates(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// The number of grid columns each row of the first table covers.
function rowWidths(editor: LexicalEditor): number[] {
  return editor.getEditorState().read(() => {
    const table = $getRoot().getChildren().find($isTableNode);
    if (!table) {
      throw new Error('Expected a table');
    }
    return table
      .getChildren<TableRowNode>()
      .map(row =>
        row
          .getChildren<TableCellNode>()
          .reduce((acc, cell) => acc + cell.getColSpan(), 0),
      );
  });
}

function buildEditor(withTablePlugin: boolean) {
  const editor = buildEditorFromExtensions(
    defineExtension({
      name: '[ragged-table-normalization]',
      ...(withTablePlugin
        ? {dependencies: [TableExtension]}
        : {nodes: [TableNode, TableRowNode, TableCellNode]}),
    }),
  );
  onTestFinished(() => editor.dispose());
  return editor;
}

describe('Ragged table normalization (#9453)', () => {
  describe('with TableExtension', () => {
    test('JSON loaded with setEditorState is padded by the transform', () => {
      const editor = buildEditor(true);
      editor.setEditorState(
        editor.parseEditorState(serializedTable([[3], [1]])),
      );
      expect(rowWidths(editor)).toEqual([3, 3]);
    });

    test('a ragged table from an update that skipped transforms is padded', async () => {
      const editor = buildEditor(true);
      insertRaggedTable(editor, [[2], [1]]);
      await flushUpdates();
      expect(rowWidths(editor)).toEqual([2, 2]);
    });

    test('undo removes the table and its padding in one step', async () => {
      const editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [TableExtension, HistoryExtension],
          name: '[ragged-table-history]',
        }),
      );
      onTestFinished(() => editor.dispose());
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode('before')));
        },
        {discrete: true},
      );
      insertRaggedTable(editor, [[2], [1]]);
      await flushUpdates();
      expect(rowWidths(editor)).toEqual([2, 2]);

      // If the padding were an undo step of its own, this would only undo the
      // padding and leave the ragged table behind.
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      await flushUpdates();
      expect(
        editor
          .getEditorState()
          .read(() => [
            $getRoot().getChildren().some($isTableNode),
            $getRoot().getTextContent(),
          ]),
      ).toEqual([false, 'before']);
    });

    test('ragged rows with colSpan are padded to the widest row', async () => {
      const editor = buildEditor(true);
      insertRaggedTable(editor, [[{colSpan: 2}, 1], [1]]);
      await flushUpdates();
      expect(rowWidths(editor)).toEqual([3, 3]);
    });

    test('a rectangular table is left unchanged', async () => {
      const editor = buildEditor(true);
      let updates = 0;
      onTestFinished(editor.registerUpdateListener(() => updates++));
      insertRaggedTable(editor, [[{colSpan: 2}], [2]]);
      await flushUpdates();
      expect(rowWidths(editor)).toEqual([2, 2]);
      // Only the insert itself; no follow-up padding update.
      expect(updates).toBe(1);
    });

    test('collaboration updates are not padded in the model', async () => {
      const editor = buildEditor(true);
      insertRaggedTable(editor, [[2], [1]], COLLABORATION_TAG);
      await flushUpdates();
      expect(rowWidths(editor)).toEqual([2, 1]);
    });

    test('undo and redo updates are not padded in the model', async () => {
      const editor = buildEditor(true);
      insertRaggedTable(editor, [[2], [1]], HISTORIC_TAG);
      await flushUpdates();
      expect(rowWidths(editor)).toEqual([2, 1]);
    });
  });

  describe('HTML export', () => {
    function exportedRows(editor: LexicalEditor): HTMLTableRowElement[] {
      const html = editor
        .getEditorState()
        .read(() => $generateHtmlFromNodes(editor));
      const container = document.createElement('div');
      container.innerHTML = html;
      return Array.from(container.querySelectorAll('tr'));
    }

    test('a ragged model is exported as a rectangular table', () => {
      // No table transform: the model stays ragged, as in a headless editor.
      const editor = buildEditor(false);
      editor.setEditorState(
        editor.parseEditorState(serializedTable([[3], [1], [2]])),
      );
      expect(rowWidths(editor)).toEqual([3, 1, 2]);
      expect(exportedRows(editor).map(tr => tr.cells.length)).toEqual([
        3, 3, 3,
      ]);
    });

    test('padding cells in a header row are exported as <th>', () => {
      const editor = buildEditor(false);
      editor.setEditorState(
        editor.parseEditorState(
          serializedTable([[{headerState: TableCellHeaderStates.ROW}], [2]]),
        ),
      );
      const [headerRow, bodyRow] = exportedRows(editor);
      expect(Array.from(headerRow.cells, c => c.tagName)).toEqual(['TH', 'TH']);
      expect(Array.from(bodyRow.cells, c => c.tagName)).toEqual(['TD', 'TD']);
    });

    test('a ragged collaboration update still exports rectangular HTML', async () => {
      const editor = buildEditor(true);
      insertRaggedTable(editor, [[2], [1]], COLLABORATION_TAG);
      await flushUpdates();
      expect(rowWidths(editor)).toEqual([2, 1]);
      expect(exportedRows(editor).map(tr => tr.cells.length)).toEqual([2, 2]);
    });

    test('a rectangular table exports no extra cells', () => {
      const editor = buildEditor(false);
      editor.setEditorState(
        editor.parseEditorState(serializedTable([[2], [{colSpan: 2}]])),
      );
      expect(exportedRows(editor).map(tr => tr.cells.length)).toEqual([2, 1]);
    });
  });
});
