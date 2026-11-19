/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $generateNodesFromSerializedNodes,
  $getClipboardDataFromSelection,
  $insertDataTransferForRichText,
} from '@lexical/clipboard';
import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $computeTableMapSkipCellCheck,
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $createTableSelectionFrom,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  getTableObserverFromTableElement,
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
  type ElementNode,
  FORMAT_ELEMENT_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {assert, expect, test} from 'vitest';

import {
  $computeTableCellRectBoundary,
  $insertTableIntoGrid,
} from '../../LexicalTableUtils';

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
      name: '[table-selection-covered-rows]',
      // Lexical clipboard data pastes into an editor of the same namespace.
      namespace: 'table-selection-covered-rows',
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

const $texts = () =>
  $table()
    .getChildren()
    .map(row =>
      (row as TableRowNode).getChildren().map(cell => cell.getTextContent()),
    );

const COVERED: Spec = [
  [
    ['A', 1, 2],
    ['B', 1, 2],
  ],
  [],
  ['E', 'F'],
];

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  for (const [label, spec, anchor, focus, rowCounts] of [
    ['middle row', COVERED, 'A', 'F', [2, 0, 2]],
    [
      'partial column with unselected physical cells',
      [['KEEP0', ['B', 1, 3]], ['KEEP1'], ['KEEP2'], ['KEEP3', 'F']],
      'B',
      'F',
      [1, 0, 0, 1],
    ],
  ] as [string, Spec, string, string, number[]][]) {
    test(`${label} survives standalone copy and paste (${mime})`, () => {
      using source = build(spec);
      using target = build([['DISCARD']]);
      select(source, anchor, focus);
      const copied = source.read(() =>
        $getClipboardDataFromSelection($getSelection()!),
      );
      const counts =
        mime === 'application/x-lexical-editor'
          ? JSON.parse(copied[mime]!).nodes[0].children.map(
              (r: {children: unknown[]}) => r.children.length,
            )
          : [
              ...new DOMParser()
                .parseFromString(copied[mime]!, 'text/html')
                .querySelectorAll('tr'),
            ].map(r => r.querySelectorAll('td,th').length);
      expect(counts).toEqual(rowCounts);
      target.update(
        () => {
          $getRoot().clear().append($createParagraphNode());
          const selection = (
            $getRoot().getFirstChildOrThrow() as ElementNode
          ).selectStart();
          const data = new DataTransfer();
          data.setData(mime, copied[mime as keyof typeof copied]!);
          $insertDataTransferForRichText(data, selection);
        },
        {discrete: true},
      );
      target.read(() => {
        expect(
          $table()
            .getChildren()
            .map(r => (r as TableRowNode).getChildrenSize()),
        ).toEqual(rowCounts);
        expect(
          $table()
            .getAllTextNodes()
            .map(t => t.getTextContent()),
        ).toEqual(
          source.read(() =>
            $getSelection()!
              .getNodes()
              .filter($isTableCellNode)
              .flatMap(c => c.getAllTextNodes().map(t => t.getTextContent())),
          ),
        );
      });
    });
  }

  test(`cut whole covered-row rectangle and paste into a growing target (${mime})`, () => {
    using source = build(COVERED);
    using target = build([['KEEP', 'START']]);
    select(source, 'A', 'F');
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
    target.update(
      () => {
        const only = new DataTransfer();
        only.setData(mime, data.getData(mime));
        $insertDataTransferForRichText(only, $cell('START').selectStart());
      },
      {discrete: true},
    );
    expect(target.read($texts)).toEqual([
      ['KEEP', 'A', 'B'],
      [''],
      ['', 'E', 'F'],
    ]);
  });
}

test('covered rows do not add cells to highlight, text, alignment or clearText', () => {
  using editor = build([
    ['KEEP0', ['B', 1, 3]],
    ['KEEP1'],
    ['KEEP2'],
    ['KEEP3', 'F'],
  ]);
  select(editor, 'F', 'B');
  editor.read(() => {
    const selection = $getSelection()!;
    expect(selection.getTextContent()).toBe('B\n\n\nF\n');
    expect(selection.getNodes().filter($isTableRowNode)).toEqual(
      $table().getChildren(),
    );
    expect(new Set(selection.getNodes().map(n => n.getKey())).size).toBe(
      selection.getNodes().length,
    );
  });
  expect(
    [...editor.getRootElement()!.querySelectorAll('td.selected')].map(
      c => c.textContent,
    ),
  ).toEqual(['B', 'F']);
  editor.update(() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'right'), {
    discrete: true,
  });
  editor.read(() => {
    expect($cell('B').getFormatType()).toBe('right');
    expect($cell('F').getFormatType()).toBe('right');
    for (const name of ['KEEP0', 'KEEP1', 'KEEP2', 'KEEP3']) {
      expect($cell(name).getFormatType()).toBe('');
    }
  });
  editor.update(
    () => {
      const element = editor.getRootElement()!.querySelector('table')!;
      const observer = getTableObserverFromTableElement(element);
      assert(observer);
      observer.$clearText();
    },
    {discrete: true},
  );
  expect(editor.read($texts)).toEqual([
    ['KEEP0', ''],
    ['KEEP1'],
    ['KEEP2'],
    ['KEEP3', ''],
  ]);
});

for (const reversed of [false, true]) {
  test(`insertNodes uses focus despite a trailing covered row (reversed=${reversed})`, () => {
    using editor = build(COVERED);
    select(editor, reversed ? 'F' : 'A', reversed ? 'A' : 'F');
    editor.update(
      () =>
        $getSelection()!.insertNodes([
          $createParagraphNode().append($createTextNode('NEW')),
        ]),
      {discrete: true},
    );
    expect(editor.read($texts)).toEqual(
      reversed
        ? [['NEW', 'B'], [], ['E', 'F']]
        : [['A', 'B'], [], ['E', 'NEW']],
    );
  });
}

test('insertTableIntoGrid with a physically empty template row preserves its target', () => {
  using template = build([['X', 'Y'], [], ['Z', 'W']]);
  using target = build([['A', 'B'], ['KEEP0', ['KEEP1', 1, 2]], ['C']]);
  const json = template.getEditorState().toJSON().root.children[0];
  target.update(
    () => {
      const [node] = $generateNodesFromSerializedNodes([json]);
      assert($isTableNode(node));
      expect($insertTableIntoGrid(node, $cell('A').selectStart())).toBe(true);
    },
    {discrete: true},
  );
  expect(target.read($texts)).toEqual([
    ['X', 'Y'],
    ['KEEP0', 'KEEP1'],
    ['Z', 'W'],
  ]);
});

// Fill a rectangular grid with valid, nonoverlapping merges. Some physical
// rows have no cells, although every grid position is covered.
function rectangle(seed: number): Spec {
  let state = seed + 1;
  const random = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
  const height = 5;
  const width = 5;
  const used = Array.from({length: height}, () => Array(width).fill(false));
  const rows: Spec = [];
  for (let r = 0; r < height; r++) {
    const cells: Spec[number] = [];
    for (let c = 0; c < width; c++) {
      if (used[r][c]) continue;
      let cs = Math.min(1 + random(4), width - c);
      let rs = Math.min(1 + random(4), height - r);
      const free = () => {
        for (let y = r; y < r + rs; y++)
          for (let x = c; x < c + cs; x++) if (used[y][x]) return false;
        return true;
      };
      while (!free()) {
        if (cs > 1) cs--;
        else rs--;
      }
      cells.push([`S${seed}R${r}C${c}`, cs, rs]);
      for (let y = r; y < r + rs; y++)
        for (let x = c; x < c + cs; x++) used[y][x] = true;
    }
    rows.push(cells);
  }
  return rows;
}

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  test(`generated rectangular merged selections keep coordinates when pasted or grown (${mime})`, () => {
    let covered = 0;
    for (let seed = 0; seed < 80; seed++) {
      const spec = rectangle(seed);
      const names = spec.flat().map(s => (typeof s === 'string' ? s : s[0]));
      using source = build(spec);
      for (let pair = 0; pair < 3; pair++) {
        const a = names[(seed + pair) % names.length];
        const f = names[(names.length - 1 + pair * 3) % names.length];
        select(source, a, f);
        const expected = source.read(() => {
          const [map, am, fm] = $computeTableMapSkipCellCheck(
            $table(),
            $cell(a),
            $cell(f),
          );
          assert(am && fm);
          const b = $computeTableCellRectBoundary(map, am, fm);
          // Trailing rows covered only by row spans stay out of a copy, as
          // before: the copy ends at the last row with a cell of its own.
          let lastRow = b.minRow;
          for (let r = b.minRow; r <= b.maxRow; r++) {
            for (let c = b.minColumn; c <= b.maxColumn; c++) {
              if (map[r][c].startRow === r) {
                lastRow = r;
              }
            }
          }
          const grid: string[][] = [];
          for (let r = b.minRow; r <= lastRow; r++) {
            grid.push(
              Array.from({length: b.maxColumn - b.minColumn + 1}, (_, c) =>
                map[r][c + b.minColumn].cell.getTextContent(),
              ),
            );
            if (!spec[r].length) covered++;
          }
          return grid;
        });
        using target = build(
          pair === 0
            ? [['KEEP0', 'START']]
            : Array.from({length: 7}, (_, r) =>
                Array.from({length: 7}, (_column, c) => `KEEP${r}:${c}`),
              ),
        );
        paste(
          source,
          target,
          a,
          f,
          pair === 0 ? 'START' : 'KEEP1:1',
          undefined,
          mime,
        );
        target.read(() => {
          const [map] = $computeTableMapSkipCellCheck($table(), null, null);
          const startRow = pair === 0 ? 0 : 1;
          for (let r = 0; r < map.length; r++)
            for (let c = 0; c < map[r].length; c++) {
              const wanted =
                expected[r - startRow]?.[c - 1] ??
                (pair === 0
                  ? r === 0 && c === 0
                    ? 'KEEP0'
                    : ''
                  : `KEEP${r}:${c}`);
              expect(
                map[r][c].cell.getTextContent(),
                JSON.stringify({a, c, f, pair, r, seed, spec}),
              ).toBe(wanted);
            }
          expect(map.length).toBe(pair === 0 ? expected.length : 7);
          expect(map[0].length).toBe(pair === 0 ? expected[0].length + 1 : 7);
        });
      }
    }
    expect(covered).toBeGreaterThan(0);
  }, 30000);
}

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  test(`covered row height and direction survive selected DOM/JSON export (${mime})`, () => {
    using editor = build(COVERED);
    editor.update(
      () => {
        const row = $table().getChildAtIndex(1) as TableRowNode;
        row.setHeight(47);
        row.setDirection('rtl');
      },
      {discrete: true},
    );
    select(editor, 'A', 'F');
    editor.read(() => {
      const data = $getClipboardDataFromSelection($getSelection()!);
      if (mime === 'application/x-lexical-editor') {
        const rows = JSON.parse(data[mime]!).nodes[0].children;
        expect(rows).toHaveLength(3);
        expect(rows[1]).toMatchObject({
          children: [],
          direction: 'rtl',
          height: 47,
        });
      } else {
        const rows = new DOMParser()
          .parseFromString(data[mime]!, 'text/html')
          .querySelectorAll('tr');
        expect(rows).toHaveLength(3);
        expect(rows[1].style.height).toBe('47px');
        expect(rows[1].dir).toBe('rtl');
        expect(rows[1].children).toHaveLength(0);
      }
    });
  });
}

for (const mime of ['application/x-lexical-editor', 'text/html']) {
  for (const tableSelection of [false, true]) {
    test(`covered-row rectangle replaces a merged target without touching its neighbors (${mime}, tableSelection=${tableSelection})`, () => {
      using source = build(COVERED);
      using target = build([
        ['K00', 'K01', 'K02', 'K03'],
        ['K10', ['OLD', 2, 3], 'K13'],
        ['K20', 'K23'],
        ['K30', 'K33'],
        ['K40', 'K41', 'K42', 'K43'],
      ]);
      paste(
        source,
        target,
        'A',
        'F',
        'OLD',
        tableSelection ? 'OLD' : undefined,
        mime,
      );
      expect(target.read($texts)).toEqual([
        ['K00', 'K01', 'K02', 'K03'],
        ['K10', 'A', 'B', 'K13'],
        ['K20', 'K23'],
        ['K30', 'E', 'F', 'K33'],
        ['K40', 'K41', 'K42', 'K43'],
      ]);
      target.read(() =>
        expect(
          $getSelection()!
            .getNodes()
            .every(node => node.isAttached()),
        ).toBe(true),
      );
    });
  }
}
