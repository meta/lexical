/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {MdastExportHandler, MdastImportHandler} from './types';
import type {AlignType, Table, TableCell, TableRow} from 'mdast';

import {configExtension} from '@lexical/extension';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableCellHeaderStates,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $getState,
  $isElementNode,
  $setState,
  createState,
  defineExtension,
} from 'lexical';
import {gfmTableFromMarkdown, gfmTableToMarkdown} from 'mdast-util-gfm-table';
import {gfmTable} from 'micromark-extension-gfm-table';

import {$append} from './handlers';
import {MdastImportExtension} from './MdastImportExtension';

/** The per-column alignment (`| :-: |`) a table's delimiter row declared. */
const tableAlignState = createState('mdastTableAlign', {
  parse: (v): AlignType[] =>
    Array.isArray(v)
      ? v.map(a => (a === 'center' || a === 'left' || a === 'right' ? a : null))
      : [],
  resetOnCopyNode: true,
});

const $importTable: MdastImportHandler<Table> = (node, ctx) => {
  const table = $createTableNode();
  if (node.align && node.align.some(a => a != null)) {
    $setState(table, tableAlignState, node.align);
  }
  node.children.forEach((row, rowIndex) => {
    const rowNode = $createTableRowNode();
    for (const cell of row.children) {
      const cellNode = $createTableCellNode(
        rowIndex === 0
          ? TableCellHeaderStates.ROW
          : TableCellHeaderStates.NO_STATUS,
      );
      const paragraph = $createParagraphNode();
      $append(paragraph, ctx.importChildren(cell));
      $append(cellNode, [paragraph]);
      $append(rowNode, [cellNode]);
    }
    $append(table, [rowNode]);
  });
  return table;
};

const $exportTable: MdastExportHandler = (node, ctx) => {
  if (!$isTableNode(node)) {
    return null;
  }
  const rows: TableRow[] = [];
  for (const row of node.getChildren()) {
    // Structural iteration bypasses the walk's selection filter, so rows a
    // selection export does not reach are skipped here. Cells stay: dropping
    // one would shift the remaining cells into other columns.
    if (!$isTableRowNode(row) || !ctx.isIncluded(row)) {
      continue;
    }
    const cells: TableCell[] = [];
    for (const cell of row.getChildren()) {
      if (!$isTableCellNode(cell)) {
        continue;
      }
      const children: TableCell['children'] = [];
      for (const child of cell.getChildren()) {
        if ($isElementNode(child)) {
          // GFM cells hold a single line of phrasing content; multiple block
          // children (paragraphs from Enter inside the cell) are joined with
          // hard breaks, which gfm-table serializes as spaces inside the cell.
          if (children.length > 0) {
            children.push({type: 'break'});
          }
          children.push(...ctx.exportInline(child));
        }
      }
      cells.push({children, type: 'tableCell'});
    }
    rows.push({children: cells, type: 'tableRow'});
  }
  return {
    align: $getState(node, tableAlignState),
    children: rows,
    type: 'table',
  };
};

/**
 * GFM tables, mapped to `@lexical/table` nodes. Opt-in (not part of
 * {@link MdastCommonMarkExtension}) because it pulls in the `@lexical/table`
 * nodes it ships. The first table row is treated as the header row in both
 * directions.
 *
 * @example
 * ```ts
 * import {MdastShortcutsExtension, MdastTableExtension} from '@lexical/mdast';
 * import {buildEditorFromExtensions} from '@lexical/extension';
 * import {defineExtension} from 'lexical';
 *
 * const editor = buildEditorFromExtensions(
 *   defineExtension({
 *     dependencies: [MdastShortcutsExtension, MdastTableExtension],
 *     name: '[root]',
 *   }),
 * );
 * ```
 * @experimental
 */
export const MdastTableExtension = defineExtension({
  dependencies: [
    configExtension(MdastImportExtension, {
      exportRules: [{$export: $exportTable, type: 'table'}],
      importRules: [{$import: $importTable, type: 'table'}],
      mdastExtensions: [/* @__PURE__ */ gfmTableFromMarkdown()],
      micromarkExtensions: [/* @__PURE__ */ gfmTable()],
      toMarkdownExtensions: [/* @__PURE__ */ gfmTableToMarkdown()],
    }),
  ],
  name: '@lexical/mdast/Table',
  nodes: [TableNode, TableRowNode, TableCellNode],
});
