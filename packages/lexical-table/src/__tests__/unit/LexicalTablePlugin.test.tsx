/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $isTableNode,
  INSERT_TABLE_COMMAND,
  registerTablePlugin,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import {
  $getRoot,
  $isElementNode,
  $setSelection,
  createEditor,
  type LexicalEditor,
} from 'lexical';
import {beforeEach, describe, expect, test} from 'vitest';

describe('LexicalTablePlugin', () => {
  let editor: LexicalEditor;

  beforeEach(async () => {
    const testConfig = {
      namespace: 'test',
      nodes: [TableNode, TableCellNode, TableRowNode],
      onError: (error: Error) => {
        throw error;
      },
      theme: {},
    };
    editor = createEditor(testConfig);
    editor._headless = true;
    registerTablePlugin(editor);
  });

  test('INSERT_TABLE_COMMAND inserts a table', async () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.select();
        editor.dispatchCommand(INSERT_TABLE_COMMAND, {
          columns: '3',
          rows: '2',
        });
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const root = $getRoot();
      const table = root.getFirstChild();

      expect($isTableNode(table)).toBe(true);

      if (!$isTableNode(table)) {
        throw new Error('Expected table node');
      }

      const rows = table.getChildren();
      expect(rows.length).toBe(2);
      const firstRow = rows[0];
      if (!$isElementNode(firstRow)) {
        throw new Error('Expected row node');
      }
      const firstRowCells = firstRow.getChildren();
      expect(firstRowCells.length).toBe(3);
    });
  });

  test('INSERT_TABLE_COMMAND inserts a table when the editor is blurred', async () => {
    editor.update(
      () => {
        const root = $getRoot();
        root.select();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        // Simulate a blur event
        $setSelection(null);
        editor.dispatchCommand(INSERT_TABLE_COMMAND, {
          columns: '3',
          rows: '2',
        });
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      const root = $getRoot();
      const table = root.getFirstChild();

      expect($isTableNode(table)).toBe(true);
    });
  });
});
