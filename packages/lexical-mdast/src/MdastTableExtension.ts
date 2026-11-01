/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  MdastExportContext,
  MdastExportHandler,
  MdastImportHandler,
  MdastNode,
} from './types';
import type {
  AlignType,
  Parent,
  PhrasingContent,
  Root,
  Table,
  TableCell,
} from 'mdast';
import type {
  Handle,
  Options as ToMarkdownExtension,
} from 'mdast-util-to-markdown';

import {configExtension} from '@lexical/extension';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $findTableNode,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $isTableSelection,
  TableCellHeaderStates,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $getSlotHost,
  $isElementNode,
  $isLineBreakNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  defineExtension,
  type ElementFormatType,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {gfmTableFromMarkdown, gfmTableToMarkdown} from 'mdast-util-gfm-table';
import {gfmTable} from 'micromark-extension-gfm-table';

import {$append, $isBlockLevelNode, inlineMarker} from './handlers';
import {MdastExtension} from './MdastExtension';

/**
 * An inline HTML `<br>` tag (or `</br>`, which HTML reads as one) on its
 * own, the line break a GFM cell can hold. Raw HTML with more in it is
 * imported as any other raw HTML is.
 */
const BR_RE =
  /^[ \t\n\f\r]*<\/?br(?:[ \t\n\f\r/](?:[^>"']|"[^"]*"|'[^']*')*)?>[ \t\n\f\r]*$/i;

/** The column alignment GFM writes for an element format. */
function gfmAlign(format: ElementFormatType): AlignType {
  return format === 'left' || format === 'center' || format === 'right'
    ? format
    : null;
}

/**
 * Replaces each node for which `replace` returns an array with that array,
 * maps the children of every node the same way, and returns `nodes` itself
 * when nothing changed.
 */
function mapPhrasing(
  nodes: readonly MdastNode[],
  replace: (node: MdastNode) => MdastNode[] | undefined,
): PhrasingContent[] {
  let changed = false;
  const mapped = nodes.flatMap(node => {
    const replaced = replace(node);
    const result = (replaced || [node]).map(child => {
      const children =
        'children' in child && mapPhrasing(child.children, replace);
      return children && children !== child.children
        ? ({...child, children} as MdastNode)
        : child;
    });
    changed = changed || replaced !== undefined || result[0] !== node;
    return result;
  });
  return (changed ? mapped : nodes) as PhrasingContent[];
}

/** The host the node is in a named slot of, or else its parent. */
function $slotHostOrParent(node: LexicalNode): LexicalNode | null {
  return $getSlotHost(node) || node.getParent();
}

/** The cell of `table` that `node` is in, through named slots too. */
function $cellIn(node: LexicalNode, table: TableNode): TableCellNode | null {
  for (let n: LexicalNode | null = node; n; n = $slotHostOrParent(n)) {
    if ($isTableCellNode(n) && table.is($findTableNode(n))) {
      return n;
    }
  }
  return null;
}

/** Whether `value` is only Markdown whitespace (not, say, a no-break space). */
function isBlank(value: string): boolean {
  return /^[ \t\r\n]*$/.test(value);
}

/** The first inline node in `node` with content that passes `test`, if any. */
function $firstContent(
  node: ElementNode,
  test: (content: LexicalNode) => boolean = () => true,
): LexicalNode | null {
  for (const child of node.getChildren()) {
    const found = $isElementNode(child)
      ? $firstContent(child, test)
      : $isLineBreakNode(child) ||
          $isBlockLevelNode(child) ||
          ($isTextNode(child) && isBlank(child.getTextContent())) ||
          !test(child)
        ? null
        : child;
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * The format of the text in a cell: that of the block its first inline node
 * with content is in (or its first element block, when it has none), or of the
 * nearest block around it in the cell that has one, or else the cell's.
 * Blocks in a nested table count for nothing (the nested table has its own
 * alignment). A start or end format (as pasted HTML often has) takes no GFM
 * alignment.
 */
function $cellFormat(cell: TableCellNode): ElementFormatType {
  let format: ElementFormatType = '';
  for (
    let node: LexicalNode | null | undefined =
      $firstContent(cell) || cell.getChildren().find($isElementNode);
    node && !node.is(cell);
    node = node.getParent()
  ) {
    // Text in a nested table has that table's alignment, not this one's,
    // and the table's own format places it.
    format = $isTableNode(node)
      ? ''
      : format || ($isElementNode(node) ? node.getFormatType() : '');
  }
  return format || cell.getFormatType();
}

/** A cell at a row and column of a table, which a merged cell spans. */
interface GridCell {
  cell: TableCellNode;
  /** Whether the cell starts at this row and column. */
  origin: boolean;
}

/**
 * The rows and columns `cell` spans from `rowIndex` in a table of
 * `rowCount` rows: a row span of 0 (as in HTML) or past the last row runs
 * to the last row, and any other span below 1 is 1.
 */
function $cellSpans(
  cell: TableCellNode,
  rowIndex: number,
  rowCount: number,
): [number, number] {
  const rowSpan = cell.getRowSpan();
  return [
    rowSpan === 0
      ? rowCount - rowIndex
      : Math.min(Math.max(1, rowSpan), rowCount - rowIndex),
    Math.max(1, cell.getColSpan()),
  ];
}

/**
 * The table rows of `table`, and the cells of each by column (a sparse
 * array where a row has no cell). Children that aren't table rows or cells
 * are skipped. Unlike `$computeTableMap`, this reads any table, whatever
 * transforms the editor has.
 */
function $tableGrid(table: TableNode): {
  grid: GridCell[][];
  rows: TableRowNode[];
} {
  const rows = table.getChildren().filter($isTableRowNode);
  const grid: GridCell[][] = rows.map(() => []);
  rows.forEach((row, rowIndex) => {
    let column = 0;
    for (const cell of row.getChildren().filter($isTableCellNode)) {
      while (grid[rowIndex][column]) {
        column++;
      }
      const [rowSpan, colSpan] = $cellSpans(cell, rowIndex, rows.length);
      for (let i = rowIndex; i < rowIndex + rowSpan; i++) {
        for (let j = column; j < column + colSpan; j++) {
          grid[i][j] = {cell, origin: i === rowIndex && j === column};
        }
      }
    }
  });
  return {grid, rows};
}

/** A line ending, as Markdown reads one. */
const LINE_ENDING = /\r?\n|\r/g;

/** mdast nodes that hold phrasing content, which is a line of a cell. */
const PHRASING_PARENTS = /* @__PURE__ */ new Set(['heading', 'paragraph']);

/**
 * mdast containers whose blocks are lines: of flow content, and of a nested
 * table's rows.
 */
const CONTAINERS = /* @__PURE__ */ new Set([
  'blockquote',
  'list',
  'listItem',
  'table',
  'tableRow',
]);

/**
 * mdast flow content (of CommonMark, GFM, frontmatter, math and raw HTML
 * embedding Markdown) with no form in a cell, which is written after the
 * table.
 */
const AFTER = /* @__PURE__ */ new Set([
  'definition',
  'footnoteDefinition',
  'htmlBlock',
  'math',
  'thematicBreak',
  'yaml',
]);

/**
 * The content of a cell as its export rules write it, as lines of phrasing
 * content: a run of phrasing content (any node that isn't flow content) is
 * a line, a code block's lines are code, raw HTML between blocks is a line
 * of its own, an empty paragraph or heading is an empty line, and each cell
 * of a nested table is a line (none for one of only empty lines). Also
 * returns the flow content with no form in a cell (such as thematic
 * breaks), which is written after the table.
 */
function $cellContent(
  cell: TableCellNode,
  ctx: MdastExportContext,
): {after: MdastNode[]; lines: PhrasingContent[][]} {
  const lines: PhrasingContent[][] = [];
  const after: MdastNode[] = [];
  const visitAll = (nodes: readonly MdastNode[], phrasing: boolean) => {
    let line: PhrasingContent[] | undefined;
    for (const node of nodes) {
      if (node.type === 'tableCell') {
        // A nested table's cell is a line, and one of only empty lines
        // (which its table writes as breaks) is none, as where it pads a
        // short row or a merged cell spans.
        if (!node.children.every(({type}) => type === 'break')) {
          visitAll(node.children, true);
        }
      } else if (PHRASING_PARENTS.has(node.type)) {
        const first = lines.length;
        const firstAfter = after.length;
        visitAll((node as Parent).children as MdastNode[], true);
        // An empty one is an empty line; one of flow content written after
        // the table is none.
        if (lines.length === first && after.length === firstAfter) {
          lines.push([]);
        }
      } else if (CONTAINERS.has(node.type)) {
        visitAll((node as Parent).children as MdastNode[], false);
      } else if (node.type === 'code') {
        for (const value of node.value.split(LINE_ENDING)) {
          lines.push(value ? [{type: 'inlineCode', value}] : []);
        }
      } else if (AFTER.has(node.type)) {
        after.push(node);
      } else if (!phrasing && node.type === 'html') {
        // Raw HTML between blocks.
        lines.push([node]);
      } else {
        if (!line) {
          lines.push((line = []));
        }
        line.push(node as PhrasingContent);
        continue;
      }
      // Flow content ends a run of phrasing content.
      line = undefined;
    }
  };
  if (!ctx.isIncluded(cell)) {
    return {after, lines};
  }
  visitAll(ctx.exportBlocks(cell), false);
  // A cell of only flow content written after the table is an empty line,
  // unless a selection export reaches none of its inline content.
  if (
    lines.length === 0 &&
    (!$firstContent(cell) || $firstContent(cell, ctx.isIncluded))
  ) {
    lines.push([]);
  }
  return {after, lines};
}

/**
 * Unescapes a pipe GFM reads as escaped before anything else, which
 * micromark leaves escaped in raw HTML and in autolinks.
 */
function unescapePipes(value: string): string {
  return value.replace(/\\\|/g, '|');
}

/** Unescapes the pipes in raw HTML in a cell in or below `node`. */
function unescapeCellHtml(node: MdastNode, inCell: boolean): void {
  if (inCell && (node.type === 'html' || node.type === 'htmlInline')) {
    node.value = unescapePipes(node.value);
  }
  // A table is flow content, so outside one only flow content holds one.
  if ('children' in node && (inCell || !PHRASING_PARENTS.has(node.type))) {
    for (const child of node.children) {
      unescapeCellHtml(child, inCell || node.type === 'tableCell');
    }
  }
}

/**
 * Unescapes the pipes micromark leaves escaped in raw HTML in a cell, which
 * GFM reads as escaped before anything else, as the tree is parsed: a tree
 * supplied to the import holds them as they are.
 */
const gfmTableHtmlFromMarkdown = {
  transforms: [
    (tree: Root) => {
      unescapeCellHtml(tree, false);
    },
  ],
};

const $importTable: MdastImportHandler<Table> = (node, ctx) => {
  const align = node.align || [];
  const replace = (child: MdastNode): MdastNode[] | undefined => {
    if (child.type === 'html' || child.type === 'htmlInline') {
      return BR_RE.test(child.value) ? [{type: 'break'}] : undefined;
    }
    // An autolink, `<…>` or literal, rather than `[text](url)`, which reads
    // its escapes as text does. Its text is its URL, as written.
    if (
      child.type === 'link' &&
      (inlineMarker(ctx, child) || '[') !== '[' &&
      child.url.includes('\\|')
    ) {
      return [
        {
          ...child,
          children: child.children.map(text =>
            text.type === 'text'
              ? {...text, value: unescapePipes(text.value)}
              : text,
          ),
          url: unescapePipes(child.url),
        },
      ];
    }
  };
  // The children of a table or a row, but whitespace between them.
  const partsOf = (parent: MdastNode): MdastNode[] =>
    (('children' in parent && parent.children) || []).filter(
      (child: MdastNode) =>
        child.type !== 'text' || !isBlank(child.value || ''),
    );
  // A supplied tree can hold cells or phrasing content outside a row, each
  // run of which is read as a row of cells.
  const rows: MdastNode[][] = [];
  let loose: MdastNode[] | undefined;
  let firstLoose: MdastNode[] | undefined;
  let width = 0;
  for (const part of partsOf(node)) {
    if (part.type === 'tableRow') {
      const cells = partsOf(part);
      rows.push(cells);
      width = width || cells.length;
      loose = undefined;
    } else {
      if (!loose) {
        rows.push((loose = []));
        firstLoose = firstLoose || loose;
      }
      loose.push(part);
    }
  }
  // Each row has the header row's cells, as GFM reads it: those past them
  // are dropped and missing ones are empty. In a supplied tree, they are
  // those of its first row with cells, or else of its first run outside one.
  width = width || (firstLoose ? firstLoose.length : 0);
  if (width === 0) {
    return [];
  }
  return $append(
    $createTableNode(),
    rows.map((row, rowIndex) =>
      $append(
        $createTableRowNode(),
        Array.from({length: width}, (_, column) => {
          const cell: MdastNode | undefined = row[column];
          return $append(
            $createTableCellNode(
              rowIndex === 0
                ? TableCellHeaderStates.ROW
                : TableCellHeaderStates.NO_STATUS,
            ),
            [
              $append(
                $createParagraphNode().setFormat(
                  // Only the alignments GFM has.
                  gfmAlign(align[column] as ElementFormatType) || '',
                ),
                cell
                  ? ctx.importChildren({
                      children: mapPhrasing(
                        cell.type === 'tableCell'
                          ? cell.children || []
                          : [cell],
                        replace,
                      ),
                      type: 'tableCell',
                    })
                  : [],
              ),
            ],
          );
        }),
      ),
    ),
  );
};

const $exportTable: MdastExportHandler = (node, ctx) => {
  if (!$isTableNode(node)) {
    return null;
  }
  // A selection export that starts and ends in one cell of the table (or
  // selects nodes in it) writes the cell's nodes as they are, as copying in
  // a cell does; a table selection of its cells writes a table.
  const {selection} = ctx;
  const ends = $isNodeSelection(selection)
    ? selection.getNodes()
    : $isRangeSelection(selection) ||
        ($isTableSelection(selection) && selection.tableKey !== node.getKey())
      ? [selection.anchor.getNode(), selection.focus.getNode()]
      : [];
  const endCell = ends.length > 0 ? $cellIn(ends[0], node) : null;
  if (endCell && ends.every(end => endCell.is($cellIn(end, node)))) {
    return ctx.exportBlocks(endCell);
  }
  // A merged cell is written where it starts, with empty cells where it
  // spans, and every row as wide as the widest. Flow content with no form
  // in a cell is written after the table.
  const {grid, rows} = $tableGrid(node);
  const after: MdastNode[] = [];
  // The lines of a cell (those a selection export reaches); the flow
  // content written after the table is collected.
  const cellsLines = new Map<TableCellNode, PhrasingContent[][]>();
  const $linesOf = (cell: TableCellNode) => {
    let cached = cellsLines.get(cell);
    if (!cached) {
      const content = $cellContent(cell, ctx);
      cached = content.lines;
      cellsLines.set(cell, cached);
      after.push(...content.after);
    }
    return cached;
  };
  const written: GridCell[][] = [];
  let from = Infinity;
  let to = -1;
  rows.forEach((row, rowIndex) => {
    // Structural iteration bypasses the walk's selection filter, so rows a
    // selection export does not reach are skipped here, as are rows where no
    // cell it reaches has a line.
    if (!ctx.isIncluded(row)) {
      return;
    }
    const cells = grid[rowIndex];
    // The cells that start in the row, if any, else those spanning it.
    const own = cells.some(({origin}) => origin);
    if (
      cells.length > 0 &&
      !cells.some(
        ({cell, origin}) => (origin || !own) && $linesOf(cell).length > 0,
      )
    ) {
      return;
    }
    cells.forEach(({cell}, column) => {
      if ($linesOf(cell).length > 0) {
        from = Math.min(from, column);
        to = Math.max(to, column);
      }
    });
    written.push(cells);
  });
  if (to < 0) {
    return after;
  }
  // The columns from the first a selection export reaches to the last.
  const columns = <T>(map: (column: number) => T) =>
    Array.from({length: to - from + 1}, (_, i) => map(from + i));
  return [
    {
      // A column has the alignment of the content of its header cell (one a
      // merged header cell spans, that cell's), as GFM writes it under that
      // cell.
      align: columns(column => {
        const header = grid.length > 0 && grid[0][column];
        return header ? gfmAlign($cellFormat(header.cell)) : null;
      }),
      children: written.map(cells => ({
        children: columns(
          (column): TableCell => ({
            children:
              cells[column] && cells[column].origin
                ? // The lines of the cell, separated by breaks (which the
                  // cell writer below writes as `<br>`).
                  $linesOf(cells[column].cell).flatMap(
                    (line, i): PhrasingContent[] =>
                      i > 0 ? [{type: 'break'}, ...line] : line,
                  )
                : [],
            type: 'tableCell',
          }),
        ),
        type: 'tableRow',
      })),
      type: 'table',
    },
    // Written after the cells, in document order.
    ...after,
  ];
};

/** A space or tab as a character reference. */
const encodeSpace = (space: string) => `&#x${space === ' ' ? 20 : 9};`;

/** A node of Markdown that the table handler writes as it is. */
const CELL_LINE = 'lexicalTableCellLine';
const cellLine = (value: string) =>
  ({type: CELL_LINE, value}) as unknown as PhrasingContent;

/**
 * `gfmTableToMarkdown`, with the content of each cell written as one line:
 * as it would be outside a table, with a line break written as `<br>`,
 * line endings as spaces, a space or tab at either edge (which GFM trims)
 * encoded, and each pipe GFM would end the cell at escaped (one after an
 * even run of backslashes, as GFM reads a backslash and a pipe in a cell
 * as a pipe before anything else). That covers raw HTML, code and
 * autolinks, which `gfmTableToMarkdown` writes as their handlers do
 * (percent-encoding a pipe in an autolink) or splits the cell in. A
 * backslash before a pipe in code or raw HTML has no form in a cell (GFM
 * reads the pair as a pipe whatever is written), so it is lost.
 *
 * @__NO_SIDE_EFFECTS__
 */
function gfmTableCellsToMarkdown(): ToMarkdownExtension {
  const extension = gfmTableToMarkdown();
  const handlers = extension.handlers || {};
  const handleTable = handlers.table as Handle;
  const table: Handle = (node: Table, parent, state, info) => {
    const exit = state.enter('phrasing');
    const children = node.children.map(row => ({
      ...row,
      children: row.children.map(cell => {
        const line = cellLine(
          state
            .containerPhrasing(
              {
                ...cell,
                // A line ending in text is written as the space it reads
                // as, before the text is escaped for where it is.
                children: mapPhrasing(cell.children, child =>
                  child.type === 'break'
                    ? [cellLine('<br>')]
                    : child.type === 'text' && /[\r\n]/.test(child.value)
                      ? [
                          {
                            ...child,
                            value: child.value.replace(LINE_ENDING, ' '),
                          },
                        ]
                      : undefined,
                ),
              },
              {...info, after: ' ', before: ' '},
            )
            .replace(LINE_ENDING, ' ')
            .replace(/^[\t ]/, encodeSpace)
            // A backslash before the last space would escape its `&`.
            .replace(
              /(\\*)([\t ])$/,
              (_, slashes: string, space: string) =>
                `${slashes}${slashes.length % 2 ? '\\' : ''}${encodeSpace(space)}`,
            )
            .replace(/(\\*)\|/g, (pipe, slashes: string) =>
              slashes.length % 2 ? pipe : `${slashes}\\|`,
            ),
        );
        return {...cell, children: [line]};
      }),
    }));
    exit();
    return handleTable({...node, children}, parent, state, info);
  };
  return {
    ...extension,
    handlers: {
      ...handlers,
      [CELL_LINE]: (node: {value: string}) => node.value,
      table,
    } as typeof handlers,
  };
}

/**
 * GFM tables, mapped to `@lexical/table` nodes. Opt-in (not part of
 * {@link MdastCommonMarkExtension}) because it pulls in the `@lexical/table`
 * nodes it ships.
 *
 * Import reads a table as GFM does: the first row is the header row, each row
 * has the header row's cells, and an escaped pipe, which micromark leaves
 * escaped, is a pipe in raw HTML (as its parse extension reads it; a supplied
 * tree holds it as it is) and in autolinks imported from Markdown source (an
 * mdast tree without it can't tell an autolink from `[text](url)`). Column alignment is set on the paragraph of each cell of
 * the column as its element format, and a raw HTML `<br>` in a
 * cell, which export writes for a line break, is read as one.
 * Export writes any table as near as GFM allows: the blocks a cell's content
 * exports as (by its export rules), and their line breaks, as lines separated
 * by `<br>` (a code block's lines as inline code), a merged cell with empty
 * cells where it spans, flow content with no form in a cell (such as a
 * thematic break) after the table, and as a column's alignment, that of the
 * content of its header cell (the format of the block its first inline
 * content is in, or of the nearest block around it with one, or, when the
 * cell has no inline content, of its first element block, or else of the
 * cell, where blocks in a nested table count for nothing and start and end
 * are none; a merged header cell's for each column it spans), none for one
 * GFM can't express. The alignment of other cells has no form in GFM.
 *
 * @example
 * ```ts
 * import {MdastTableExtension} from '@lexical/mdast';
 * import {buildEditorFromExtensions} from '@lexical/extension';
 * import {TableExtension} from '@lexical/table';
 * import {defineExtension} from 'lexical';
 *
 * const editor = buildEditorFromExtensions(
 *   defineExtension({
 *     // TableExtension adds table editing: commands and table selection.
 *     dependencies: [MdastTableExtension, TableExtension],
 *     name: '[root]',
 *   }),
 * );
 * ```
 * @experimental
 */
export const MdastTableExtension = defineExtension({
  dependencies: [
    configExtension(MdastExtension, {
      exportRules: [{$export: $exportTable, type: TableNode}],
      importRules: [{$import: $importTable, type: 'table'}],
      mdastExtensions: [
        /* @__PURE__ */ gfmTableFromMarkdown(),
        gfmTableHtmlFromMarkdown,
      ],
      micromarkExtensions: [/* @__PURE__ */ gfmTable()],
      toMarkdownExtensions: [gfmTableCellsToMarkdown()],
    }),
  ],
  name: '@lexical/mdast/Table',
  nodes: [TableNode, TableRowNode, TableCellNode],
});
