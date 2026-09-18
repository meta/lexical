/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createTableNodeWithDimensions,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $mergeCells,
  $unmergeCellNode,
  type TableCellNode,
  TableExtension,
} from '@lexical/table';
import {$getRoot, defineExtension} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [TableExtension],
      name: 'unmerge-styles-host',
      theme: {tableScrollableWrapper: ''},
    }),
  );
}

function $cells(): TableCellNode[][] {
  const table = $getRoot().getFirstChild();
  assert($isTableNode(table), 'expected a TableNode at the root');
  return table
    .getChildren()
    .filter($isTableRowNode)
    .map(row => row.getChildren().filter($isTableCellNode));
}

describe('$unmergeCellNode keeps the cell presentation', () => {
  test('the cells a merged cell splits into keep its backgroundColor and verticalAlign', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createTableNodeWithDimensions(2, 2, false));
        const rows = $cells();
        const merged = $mergeCells([
          rows[0][0],
          rows[0][1],
          rows[1][0],
          rows[1][1],
        ]);
        assert(merged !== null, 'expected the cells to merge');
        merged.setBackgroundColor('rgb(255, 0, 0)').setVerticalAlign('middle');
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const merged = $cells()[0][0];
        expect(merged.getColSpan()).toBe(2);
        expect(merged.getRowSpan()).toBe(2);
        $unmergeCellNode(merged);
      },
      {discrete: true},
    );

    editor.read(() => {
      const rows = $cells();
      expect(rows.map(row => row.length)).toEqual([2, 2]);
      for (const row of rows) {
        for (const cell of row) {
          expect(cell.getColSpan()).toBe(1);
          expect(cell.getRowSpan()).toBe(1);
          expect(cell.getBackgroundColor()).toBe('rgb(255, 0, 0)');
          expect(cell.getVerticalAlign()).toBe('middle');
        }
      }
    });
  });

  test('the split cells keep the element format, style and direction', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createTableNodeWithDimensions(2, 2, false));
        const rows = $cells();
        const merged = $mergeCells([
          rows[0][0],
          rows[0][1],
          rows[1][0],
          rows[1][1],
        ]);
        assert(merged !== null, 'expected the cells to merge');
        merged.setFormat('center');
        merged.setStyle('color: red;');
        merged.setDirection('rtl');
      },
      {discrete: true},
    );

    editor.update(() => $unmergeCellNode($cells()[0][0]), {discrete: true});

    editor.read(() => {
      // Every cell, not only the one that was already there: a split that
      // formats the original differently from the cells beside it is the bug.
      for (const row of $cells()) {
        for (const cell of row) {
          expect(cell.getFormatType()).toBe('center');
          expect(cell.getStyle()).toBe('color: red;');
          expect(cell.getDirection()).toBe('rtl');
        }
      }
    });
  });

  test('the split cells take no width, which the merged cell measured wide', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createTableNodeWithDimensions(1, 2, false));
        const rows = $cells();
        const merged = $mergeCells([rows[0][0], rows[0][1]]);
        assert(merged !== null, 'expected the cells to merge');
        expect(merged.getColSpan()).toBe(2);
        merged.setWidth(240);
      },
      {discrete: true},
    );

    editor.update(() => $unmergeCellNode($cells()[0][0]), {discrete: true});

    editor.read(() => {
      // The cell that was measured at 240px still is; the cell split off from
      // it must not claim that width for a single column as well, and like
      // every other cell created in LexicalTableUtils it leaves its width to
      // the table's colWidths.
      expect($cells()[0].map(cell => cell.getWidth())).toEqual([
        240,
        undefined,
      ]);
    });
  });

  test('an unstyled merged cell still splits into unstyled cells', () => {
    using editor = buildEditor();

    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createTableNodeWithDimensions(1, 2, false));
        const rows = $cells();
        const merged = $mergeCells([rows[0][0], rows[0][1]]);
        assert(merged !== null, 'expected the cells to merge');
      },
      {discrete: true},
    );

    editor.update(
      () => {
        $unmergeCellNode($cells()[0][0]);
      },
      {discrete: true},
    );

    editor.read(() => {
      for (const cell of $cells()[0]) {
        expect(cell.getBackgroundColor()).toBe(null);
        expect(cell.getVerticalAlign()).toBe(undefined);
      }
    });
  });
});
