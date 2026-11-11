/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, configExtension} from '@lexical/extension';
import {$generateHtmlFromNodes} from '@lexical/html';
import {
  $createTableNodeWithDimensions,
  $isTableNode,
  TableExtension,
  type TableNode,
} from '@lexical/table';
import {$getRoot, defineExtension} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function buildEditor(hasHorizontalScroll: boolean) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [configExtension(TableExtension, {hasHorizontalScroll})],
      name: 'table-export-attributes-host',
      theme: {tableScrollableWrapper: 'scroll-wrapper'},
    }),
  );
}

/**
 * Export a one-cell table set up by `$configureTable`.
 *
 * With `hasHorizontalScroll` on, `createDOM` returns the scroll wrapper, so
 * everything `ElementNode.exportDOM` writes lands on a element the export
 * throws away. Both settings have to produce the same `<table>`.
 */
function exportTable(
  hasHorizontalScroll: boolean,
  $configureTable: (table: TableNode) => void,
): string {
  using editor = buildEditor(hasHorizontalScroll);
  editor.update(
    () => {
      const table = $createTableNodeWithDimensions(1, 1, false);
      $configureTable(table);
      $getRoot().clear().append(table);
    },
    {discrete: true},
  );
  return editor.read(() => {
    const table = $getRoot().getFirstChild();
    assert($isTableNode(table), 'expected a TableNode at the root');
    return $generateHtmlFromNodes(editor);
  });
}

describe('TableNode.exportDOM direction', () => {
  test('exports dir with scrollable tables active', () => {
    expect(exportTable(true, table => table.setDirection('rtl'))).toContain(
      '<table dir="rtl">',
    );
  });

  test('exports dir without scrollable tables', () => {
    expect(exportTable(false, table => table.setDirection('rtl'))).toContain(
      '<table dir="rtl">',
    );
  });
});

describe('TableNode.exportDOM indent', () => {
  // The padding renders the indent outside of Lexical and data-lexical-indent
  // records it exactly; both are written by ElementNode.exportDOM and both used
  // to be lost to the scroll wrapper. Note that neither comes back on import —
  // $convertTableElement restores the direction but nothing restores a table's
  // indent, which is a gap that predates this.
  test('exports the indent with scrollable tables active', () => {
    const html = exportTable(true, table => table.setIndent(2));
    expect(html).toContain('data-lexical-indent="2"');
    expect(html).toContain('padding-inline-start: 80px');
  });

  test('exports the indent without scrollable tables', () => {
    const html = exportTable(false, table => table.setIndent(2));
    expect(html).toContain('data-lexical-indent="2"');
    expect(html).toContain('padding-inline-start: 80px');
  });

  test('writes nothing for an unindented table', () => {
    expect(exportTable(true, () => {})).not.toContain('data-lexical-indent');
  });
});
