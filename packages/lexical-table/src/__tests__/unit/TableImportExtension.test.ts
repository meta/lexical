/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {DOMImportExtension} from '@lexical/html';
import {
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  type TableCellNode,
  TableExtension,
  TableImportExtension,
  type TableNode,
  type TableRowNode,
} from '@lexical/table';
import {JSDOM} from 'jsdom';
import {
  $getEditor,
  $getRoot,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      // TableExtension registers its own import rules (and the shared
      // CoreImportExtension baseline) — no dedicated import extension
      // required.
      dependencies: [TableExtension],
      name: 'table-host',
      theme: {tableScrollableWrapper: ''},
    }),
  );
}

function $generate(html: string): LexicalNode[] {
  const editor = $getEditor();
  const dep = getExtensionDependencyFromEditor(editor, DOMImportExtension);
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  return dep.output.$generateNodesFromDOM(dom.window.document);
}

function importInto(editor: LexicalEditor, html: string): void {
  editor.update(
    () => {
      const nodes = $generate(html);
      $getRoot()
        .clear()
        .append(...nodes);
    },
    {discrete: true},
  );
}

function $rootTable(): TableNode {
  const t = $getRoot().getFirstChild();
  assert($isTableNode(t), 'expected TableNode at root');
  return t;
}

function $rows(table: TableNode): TableRowNode[] {
  return table.getChildren().filter($isTableRowNode);
}

function $cells(row: TableRowNode): TableCellNode[] {
  return row.getChildren().filter($isTableCellNode);
}

describe('TableImportExtension', () => {
  test('basic 2x2 table imports with correct structure', () => {
    using editor = buildEditor();
    importInto(
      editor,
      '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
    );
    editor.read(() => {
      const table = $rootTable();
      const rows = $rows(table);
      expect(rows).toHaveLength(2);
      const firstRowCells = $cells(rows[0]);
      expect(firstRowCells).toHaveLength(2);
      expect(firstRowCells[0].getTextContent()).toBe('a');
      expect(firstRowCells[1].getTextContent()).toBe('b');
    });
  });

  test('<th scope="col"> → header cell', () => {
    using editor = buildEditor();
    importInto(editor, '<table><tr><th scope="col">H</th></tr></table>');
    editor.read(() => {
      const cell = $cells($rows($rootTable())[0])[0];
      expect(cell.hasHeader()).toBe(true);
    });
  });

  test('table picks up <thead>/<tbody> rows via $descendantsMatching', () => {
    using editor = buildEditor();
    importInto(
      editor,
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>',
    );
    editor.read(() => {
      const rows = $rows($rootTable());
      expect(rows).toHaveLength(2);
      expect(rows[0].getFirstChild()?.getTextContent()).toBe('H');
      expect(rows[1].getFirstChild()?.getTextContent()).toBe('B');
    });
  });

  test('row picks up cells via $descendantsMatching', () => {
    using editor = buildEditor();
    importInto(editor, '<table><tr><td>a</td></tr></table>');
    editor.read(() => {
      const cell = $cells($rows($rootTable())[0])[0];
      expect(cell.getTextContent()).toBe('a');
    });
  });

  test('deprecated TableImportExtension alias still imports tables', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [TableImportExtension],
        name: 'table-alias-host',
        theme: {tableScrollableWrapper: ''},
      }),
    );
    importInto(editor, '<table><tr><td>a</td></tr></table>');
    editor.read(() => {
      const cell = $cells($rows($rootTable())[0])[0];
      expect(cell.getTextContent()).toBe('a');
    });
  });
});
