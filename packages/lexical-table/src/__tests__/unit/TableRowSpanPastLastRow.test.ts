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
  $computeTableCellRectBoundary,
  $computeTableMap,
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $createTableSelectionFrom,
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableNode,
  $mergeCells,
  $unmergeCell,
  TableCellNode,
  TableExtension,
  type TableNode,
  type TableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $setSelection,
  defineExtension,
  KEY_ARROW_UP_COMMAND,
  KEY_DELETE_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// A cell whose row span reaches past the table's last row (#9759): the table
// commands keep spans within the table, but a remote update or imported JSON
// can leave one. The table map stops at the last row, and so must the
// rectangle a table selection covers.

function build(): {editor: LexicalEditor; errors: string[]} {
  const errors: string[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      afterRegistration(ed) {
        const root = document.createElement('div');
        root.contentEditable = 'true';
        document.body.append(root);
        ed.setRootElement(root);
        return () => root.remove();
      },
      dependencies: [TableExtension],
      name: '[table-row-span-past-last-row]',
      onError(e: Error) {
        errors.push(e.message);
      },
    }),
  );
  // Four rows; the first cell spans two columns and five rows. Built without
  // transforms, as a remote update applies it.
  editor.update(
    () => {
      const table = $createTableNode();
      const big = $createTableCellNode()
        .setColSpan(2)
        .setRowSpan(5)
        .append($createParagraphNode().append($createTextNode('big')));
      table.append(
        $createTableRowNode().append(
          big,
          $createTableCellNode().append(
            $createParagraphNode().append($createTextNode('c')),
          ),
        ),
      );
      for (let i = 1; i < 4; i++) {
        table.append(
          $createTableRowNode().append(
            $createTableCellNode().append(
              $createParagraphNode().append($createTextNode('r' + i)),
            ),
          ),
        );
      }
      $getRoot().clear().append(table, $createParagraphNode());
    },
    {discrete: true, skipTransforms: true},
  );
  return {editor, errors};
}

function $table(): TableNode {
  return $getRoot().getChildren().find($isTableNode) as TableNode;
}

function $bigCell(): TableCellNode {
  const row = $table().getFirstChildOrThrow() as TableRowNode;
  return row.getFirstChildOrThrow() as TableCellNode;
}

function $lastCell(): TableCellNode {
  const row = $table().getLastChildOrThrow() as TableRowNode;
  return row.getLastChildOrThrow() as TableCellNode;
}

const SELECTIONS = {
  'the big cell': () => $bigCell(),
  'the big cell to the last row': () => $lastCell(),
} as const;

function run(
  selection: keyof typeof SELECTIONS,
  op: (editor: LexicalEditor) => void,
): {editor: LexicalEditor; errors: string[]} {
  const built = build();
  built.editor.update(
    () => {
      $setSelection(
        $createTableSelectionFrom(
          $table(),
          $bigCell(),
          SELECTIONS[selection](),
        ),
      );
      op(built.editor);
    },
    {discrete: true},
  );
  return built;
}

describe('a table selection on a cell whose row span reaches past the last row', () => {
  for (const selection of Object.keys(
    SELECTIONS,
  ) as (keyof typeof SELECTIONS)[]) {
    describe(selection, () => {
      test('can be set', () => {
        const {errors} = run(selection, () => {});
        expect(errors).toEqual([]);
      });

      test('getNodes returns the selected cells', () => {
        let texts: string[] = [];
        const {errors} = run(selection, () => {
          texts = $getSelection()!
            .getNodes()
            .filter(node => node instanceof TableCellNode)
            .map(node => node.getTextContent());
        });
        expect(errors).toEqual([]);
        expect(texts).toEqual(
          selection === 'the big cell'
            ? ['big']
            : ['big', 'c', 'r1', 'r2', 'r3'],
        );
      });

      test('Delete clears the selected cells', () => {
        const {editor, errors} = run(selection, ed => {
          ed.dispatchCommand(KEY_DELETE_COMMAND, new KeyboardEvent('keydown'));
        });
        expect(errors).toEqual([]);
        editor.read(() => {
          if (selection === 'the big cell') {
            expect($bigCell().getTextContent()).toBe('');
            expect($table().getTextContent()).toContain('r3');
          } else {
            // The selection covers the whole table, so Delete removes it.
            expect($table()).toBe(undefined);
          }
        });
      });

      test('copy holds the selected cells', () => {
        let html = '';
        const {errors} = run(selection, () => {
          html =
            $getClipboardDataFromSelection($getSelection())['text/html'] || '';
        });
        expect(errors).toEqual([]);
        expect(html).toContain('big');
      });

      for (const [name, op] of [
        ['insert column after', () => $insertTableColumnAtSelection(true)],
        ['delete column', () => $deleteTableColumnAtSelection()],
      ] as const) {
        test(`${name} does not throw`, () => {
          const {errors} = run(selection, () => {
            op();
          });
          expect(errors).toEqual([]);
        });
      }

      // These operations read the overlong span in their own code; what such
      // a span means for them (clamp it, or create the missing rows) is not
      // decided yet (#9759).
      const stillThrowing: [string, (ed: LexicalEditor) => void][] = [
        [
          'plain paste',
          ed => {
            const data = new DataTransfer();
            data.setData('text/plain', 'x\ty\nz\tw');
            $insertDataTransferForRichText(data, $getSelection()!, ed);
          },
        ],
        ['insert row after', () => $insertTableRowAtSelection(true)],
        ['unmerge', () => $unmergeCell()],
        ['merge', () => $mergeCells([$bigCell(), $lastCell()])],
      ];
      if (selection === 'the big cell') {
        stillThrowing.push(['delete row', () => $deleteTableRowAtSelection()]);
      } else {
        test('delete row does not throw', () => {
          const {errors} = run(selection, () => {
            $deleteTableRowAtSelection();
          });
          expect(errors).toEqual([]);
        });
      }
      for (const [name, op] of stillThrowing) {
        test.fails(`${name} still throws (#9759)`, () => {
          const {errors} = run(selection, op);
          expect(errors).toEqual([]);
        });
      }
    });
  }
});

function buildRows(rows: [string, number, number?][][]): {
  editor: LexicalEditor;
  errors: string[];
} {
  const {editor, errors} = build();
  editor.update(
    () => {
      const table = $createTableNode();
      for (const cells of rows) {
        const row = $createTableRowNode();
        for (const [text, rowSpan, colSpan = 1] of cells) {
          row.append(
            $createTableCellNode()
              .setRowSpan(rowSpan)
              .setColSpan(colSpan)
              .append($createParagraphNode().append($createTextNode(text))),
          );
        }
        table.append(row);
      }
      $getRoot().clear().append(table, $createParagraphNode());
    },
    {discrete: true, skipTransforms: true},
  );
  return {editor, errors};
}

function $cellByText(text: string): TableCellNode {
  const cell = $table()
    .getChildren()
    .flatMap(row => (row as TableRowNode).getChildren())
    .find(node => node.getTextContent() === text);
  return cell as TableCellNode;
}

describe('the rectangle of a table selection near a row span past the last row', () => {
  test('grows to an overlong cell between its ends and stops at the last row', () => {
    // a b / c(rowSpan 9) d / e: c covers rows 1 and 2 of three.
    const {editor} = buildRows([
      [
        ['a', 1],
        ['b', 1],
      ],
      [
        ['c', 9],
        ['d', 1],
      ],
      [['e', 1]],
    ]);
    editor.read(() => {
      const [map, anchor, focus] = $computeTableMap(
        $table(),
        $cellByText('a'),
        $cellByText('d'),
      );
      expect($computeTableCellRectBoundary(map, anchor, focus)).toEqual({
        maxColumn: 1,
        maxRow: 2,
        minColumn: 0,
        minRow: 0,
      });
    });
  });

  test('Shift+Up shrinks it by the rows the overlong cell covers', () => {
    // a b / c d(rowSpan 5): d covers only the last row.
    const {editor, errors} = buildRows([
      [
        ['a', 1],
        ['b', 1],
      ],
      [
        ['c', 1],
        ['d', 5],
      ],
    ]);
    editor.update(
      () => {
        $setSelection(
          $createTableSelectionFrom(
            $table(),
            $cellByText('a'),
            $cellByText('d'),
          ),
        );
      },
      {discrete: true},
    );
    editor.update(
      () => {
        editor.dispatchCommand(
          KEY_ARROW_UP_COMMAND,
          new KeyboardEvent('keydown', {key: 'ArrowUp', shiftKey: true}),
        );
      },
      {discrete: true},
    );
    expect(errors).toEqual([]);
    editor.read(() => {
      const cells = $getSelection()!
        .getNodes()
        .filter(node => node instanceof TableCellNode)
        .map(node => node.getTextContent());
      expect(cells).toEqual(['a', 'b']);
    });
  });

  test('Shift+Up from an overlong cell on the last row keeps its corner', () => {
    // a b c / d(colSpan 2) e / f g h(rowSpan 2): h covers only the last row.
    const {editor, errors} = buildRows([
      [
        ['a', 1],
        ['b', 1],
        ['c', 1],
      ],
      [
        ['d', 1, 2],
        ['e', 1],
      ],
      [
        ['f', 1],
        ['g', 1],
        ['h', 2],
      ],
    ]);
    editor.update(
      () => {
        $setSelection(
          $createTableSelectionFrom(
            $table(),
            $cellByText('h'),
            $cellByText('b'),
          ),
        );
      },
      {discrete: true},
    );
    editor.update(
      () => {
        editor.dispatchCommand(
          KEY_ARROW_UP_COMMAND,
          new KeyboardEvent('keydown', {key: 'ArrowUp', shiftKey: true}),
        );
      },
      {discrete: true},
    );
    expect(errors).toEqual([]);
    editor.read(() => {
      const cells = $getSelection()!
        .getNodes()
        .filter(node => node instanceof TableCellNode)
        .map(node => node.getTextContent());
      expect(cells).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    });
  });

  test('a selection of an overlong cell on the last row holds only that cell', () => {
    // a / b / c(rowSpan 5)
    const {editor, errors} = buildRows([[['a', 1]], [['b', 1]], [['c', 5]]]);
    editor.update(
      () => {
        $setSelection(
          $createTableSelectionFrom(
            $table(),
            $cellByText('c'),
            $cellByText('c'),
          ),
        );
      },
      {discrete: true},
    );
    expect(errors).toEqual([]);
    editor.read(() => {
      const cells = $getSelection()!
        .getNodes()
        .filter(node => node instanceof TableCellNode)
        .map(node => node.getTextContent());
      expect(cells).toEqual(['c']);
    });
  });
});
