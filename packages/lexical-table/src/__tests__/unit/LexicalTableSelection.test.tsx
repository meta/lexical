/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$patchStyleText} from '@lexical/selection';
import {
  $computeTableMapSkipCellCheck,
  $createTableCellNode,
  $createTableNode,
  $createTableNodeWithDimensions,
  $createTableRowNode,
  $createTableSelectionFrom,
  $deleteTableRowAtSelection,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $isTableSelection,
  type TableMapType,
  type TableNode,
  type TableSelection,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $selectAll,
  $setSelection,
} from 'lexical';
import {$assertNodeType, initializeUnitTest} from 'lexical/src/__tests__/utils';
import {assert, beforeEach, describe, expect, test} from 'vitest';

describe('table selection', () => {
  initializeUnitTest(testEnv => {
    let tableNode: TableNode;
    let tableMap: TableMapType;
    let tableSelection: TableSelection;

    beforeEach(() => {
      testEnv.editor.update(() => {
        tableNode = $createTableNode();
        $getRoot()
          .clear()
          .append(
            tableNode.append(
              ...Array.from({length: 2}, (_0, row) =>
                $createTableRowNode().append(
                  ...Array.from({length: 2}, (_1, col) =>
                    $createTableCellNode().append(
                      $createParagraphNode().append(
                        $createTextNode(`${col},${row}`),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        tableMap = $computeTableMapSkipCellCheck(tableNode, null, null)[0];
        tableSelection = $createTableSelectionFrom(
          tableNode,
          tableMap.at(0)!.at(0)!.cell,
          tableMap.at(-1)!.at(-1)!.cell,
        );
        $setSelection(tableSelection);
      });
    });

    describe('regression #7076', () => {
      test('$patchStyleText works on a TableSelection', () => {
        testEnv.editor.update(
          () => {
            const length = 4;
            expect(
              $getRoot()
                .getAllTextNodes()
                .map(node => node.getStyle()),
            ).toEqual(Array.from({length}, () => ''));
            expect($isTableSelection($getSelection())).toBe(true);
            $patchStyleText($getSelection()!, {color: 'red'});
            expect($isTableSelection($getSelection())).toBe(true);
            expect(
              $getRoot()
                .getAllTextNodes()
                .map(node => node.getStyle()),
            ).toEqual(Array.from({length}, () => 'color: red;'));
          },
          {discrete: true},
        );
      });

      test('$patchStyleText applies styles to empty table cells', () => {
        testEnv.editor.update(
          () => {
            const selection = $getSelection();
            expect($isTableSelection(selection)).toBe(true);

            const emptyCell = tableMap.at(0)!.at(0)!.cell;
            const emptyParagraph = emptyCell.getFirstChild();
            if (!$isParagraphNode(emptyParagraph)) {
              throw new Error('Expected paragraph node in empty cell');
            }
            emptyParagraph.clear();
            expect(emptyParagraph.getChildrenSize()).toBe(0);

            $patchStyleText(selection!, {color: 'blue'});

            const filledCell = tableMap.at(0)!.at(1)!.cell;
            const filledParagraph = filledCell.getFirstChild();
            if (!$isParagraphNode(filledParagraph)) {
              throw new Error('Expected paragraph node in filled cell');
            }
            const textNode = filledParagraph.getFirstChild();
            if (!$isTextNode(textNode)) {
              throw new Error('Expected text node inside filled cell');
            }

            expect(textNode.getStyle()).toBe('color: blue;');
            expect(emptyParagraph.getTextStyle()).toBe('color: blue;');
          },
          {discrete: true},
        );
      });
    });

    describe('insertRawText', () => {
      function $getCellTexts(): string[][] {
        return tableNode
          .getChildren()
          .filter($isTableRowNode)
          .map(row => row.getChildren().map(cell => cell.getTextContent()));
      }

      test('fills 2x2 table with matching TSV', () => {
        testEnv.editor.update(
          () => {
            tableSelection.insertRawText('A\tB\nC\tD');
            expect($getCellTexts()).toEqual([
              ['A', 'B'],
              ['C', 'D'],
            ]);
          },
          {discrete: true},
        );
      });

      test('single value fills anchor cell only', () => {
        testEnv.editor.update(
          () => {
            tableSelection.insertRawText('hello');
            expect($getCellTexts()).toEqual([
              ['hello', '1,0'],
              ['0,1', '1,1'],
            ]);
          },
          {discrete: true},
        );
      });

      test('single row TSV fills one row with two columns', () => {
        testEnv.editor.update(
          () => {
            tableSelection.insertRawText('a\tb');
            expect($getCellTexts()).toEqual([
              ['a', 'b'],
              ['0,1', '1,1'],
            ]);
          },
          {discrete: true},
        );
      });

      test('expands rows when TSV has more rows', () => {
        testEnv.editor.update(
          () => {
            tableSelection.insertRawText('A\tB\nC\tD\nE\tF');
            const texts = $getCellTexts();
            expect(texts.length).toBe(3);
            expect(texts[0]).toEqual(['A', 'B']);
            expect(texts[1]).toEqual(['C', 'D']);
            expect(texts[2]).toEqual(['E', 'F']);
          },
          {discrete: true},
        );
      });

      test('expands columns when TSV has more columns', () => {
        testEnv.editor.update(
          () => {
            tableSelection.insertRawText('A\tB\tC\nD\tE\tF');
            const texts = $getCellTexts();
            expect(texts[0]).toEqual(['A', 'B', 'C']);
            expect(texts[1]).toEqual(['D', 'E', 'F']);
          },
          {discrete: true},
        );
      });

      test('expands both rows and columns', () => {
        testEnv.editor.update(
          () => {
            tableSelection.insertRawText('A\tB\tC\nD\tE\tF\nG\tH\tI');
            const texts = $getCellTexts();
            expect(texts).toEqual([
              ['A', 'B', 'C'],
              ['D', 'E', 'F'],
              ['G', 'H', 'I'],
            ]);
          },
          {discrete: true},
        );
      });

      test('strips trailing newline from clipboard', () => {
        testEnv.editor.update(
          () => {
            tableSelection.insertRawText('X\tY\nZ\tW\n');
            expect($getCellTexts()).toEqual([
              ['X', 'Y'],
              ['Z', 'W'],
            ]);
          },
          {discrete: true},
        );
      });

      test('paste from non-origin anchor fills offset cells', () => {
        testEnv.editor.update(
          () => {
            const offsetSelection = $createTableSelectionFrom(
              tableNode,
              tableMap.at(1)!.at(1)!.cell,
              tableMap.at(1)!.at(1)!.cell,
            );
            offsetSelection.insertRawText('X\tY\nZ\tW');
            const texts = $getCellTexts();
            // Original cells preserved, offset filled + expanded
            expect(texts[0][0]).toBe('0,0');
            expect(texts[0][1]).toBe('1,0');
            expect(texts[1][1]).toBe('X');
          },
          {discrete: true},
        );
      });

      test('unmerges and fills merged cells', () => {
        testEnv.editor.update(
          () => {
            // Build a 3x3 table where cell (0,0) spans 2 cols
            const merged = $createTableNode();
            const topLeft = $createTableCellNode().setColSpan(2);
            topLeft.append($createParagraphNode().append($createTextNode('M')));
            merged.append(
              $createTableRowNode().append(
                topLeft,
                $createTableCellNode().append(
                  $createParagraphNode().append($createTextNode('c')),
                ),
              ),
              $createTableRowNode().append(
                ...Array.from({length: 3}, () =>
                  $createTableCellNode().append(
                    $createParagraphNode().append($createTextNode('x')),
                  ),
                ),
              ),
            );
            $getRoot().clear().append(merged);
            const [mergedMap] = $computeTableMapSkipCellCheck(
              merged,
              null,
              null,
            );
            const sel = $createTableSelectionFrom(
              merged,
              mergedMap.at(0)!.at(0)!.cell,
              mergedMap.at(-1)!.at(-1)!.cell,
            );
            sel.insertRawText('A\tB\tC\nD\tE\tF');
            const texts = merged
              .getChildren()
              .filter($isTableRowNode)
              .map(row => row.getChildren().map(cell => cell.getTextContent()));
            // Merged cell is unmerged, each cell gets its TSV value
            expect(texts[0]).toEqual(['A', 'B', 'C']);
            expect(texts[1]).toEqual(['D', 'E', 'F']);
          },
          {discrete: true},
        );
      });

      test('empty string is no-op', () => {
        testEnv.editor.update(
          () => {
            tableSelection.insertRawText('');
            expect($getCellTexts()).toEqual([
              ['0,0', '1,0'],
              ['0,1', '1,1'],
            ]);
          },
          {discrete: true},
        );
      });
    });

    describe('getShape', () => {
      test('returns correct shape for non-merged table', () => {
        testEnv.editor.update(
          () => {
            const shape = tableSelection.getShape();
            expect(shape.fromX).toBe(0);
            expect(shape.fromY).toBe(0);
            expect(shape.toX).toBe(1);
            expect(shape.toY).toBe(1);
          },
          {discrete: true},
        );
      });
    });

    describe('regression #7140', () => {
      test('selection points to missing nodes after deleting table rows', () => {
        testEnv.editor.update(() => {
          const root = $getRoot();
          root.clear();
          const paragraph = $createParagraphNode().append(
            $createTextNode('Before table'),
          );
          root.append(paragraph);
          root.append(tableNode);

          const newTableMap = $computeTableMapSkipCellCheck(
            tableNode,
            null,
            null,
          )[0];
          const newTableSelection = $createTableSelectionFrom(
            tableNode,
            newTableMap.at(0)!.at(0)!.cell,
            newTableMap.at(-1)!.at(-1)!.cell,
          );
          $setSelection(newTableSelection);
        });

        // Delete table rows
        testEnv.editor.update(() => {
          const selection = $getSelection();
          expect($isTableSelection(selection)).toBe(true);
          $deleteTableRowAtSelection();
        });

        // Try to access the selection after deletion
        testEnv.editor.update(() => {
          const selection = $getSelection();
          if (selection && $isTableSelection(selection)) {
            expect(selection.isValid()).toBe(false);
            const nodes = selection.getNodes();
            expect(nodes).toEqual([]);
          }
        });
      });
    });
  });
});

describe('regression #8075', () => {
  initializeUnitTest(testEnv => {
    function $deleteForward(): void {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      selection.deleteCharacter(false);
    }

    test('forward delete removes an empty paragraph before a table', () => {
      testEnv.editor.update(
        () => {
          const paragraph = $createParagraphNode();
          $getRoot()
            .clear()
            .append(paragraph, $createTableNodeWithDimensions(2, 2, false));
          paragraph.selectStart();
        },
        {discrete: true},
      );
      testEnv.editor.update($deleteForward, {discrete: true});
      testEnv.editor.read(() => {
        const children = $getRoot().getChildren();
        expect(children).toHaveLength(1);
        expect($isTableNode(children[0])).toBe(true);
      });
    });

    test('forward delete does not merge a table into a non-empty paragraph', () => {
      testEnv.editor.update(
        () => {
          const paragraph = $createParagraphNode().append(
            $createTextNode('before'),
          );
          $getRoot()
            .clear()
            .append(paragraph, $createTableNodeWithDimensions(2, 2, false));
          paragraph.selectEnd();
        },
        {discrete: true},
      );
      testEnv.editor.update($deleteForward, {discrete: true});
      testEnv.editor.read(() => {
        const children = $getRoot().getChildren();
        expect(children).toHaveLength(2);
        expect(children[0].getTextContent()).toBe('before');
        expect($isTableNode(children[1])).toBe(true);
      });
    });

    test('forward delete from an empty paragraph in a table cell does nothing', () => {
      testEnv.editor.update(
        () => {
          const table = $createTableNodeWithDimensions(1, 2, false);
          $getRoot().clear().append(table);
          const row = table.getFirstChild();
          const cell = $assertNodeType(
            $assertNodeType(row, $isTableRowNode).getFirstChild(),
            $isTableCellNode,
          );
          const paragraph = $createParagraphNode();
          cell.clear().append(paragraph);
          paragraph.selectStart();
        },
        {discrete: true},
      );
      testEnv.editor.update($deleteForward, {discrete: true});
      testEnv.editor.read(() => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        const row = $assertNodeType(table.getFirstChild(), $isTableRowNode);
        // The next cell was not pulled into the empty one.
        expect(row.getChildrenSize()).toBe(2);
        expect(row.getFirstChildOrThrow().getTextContent()).toBe('');
      });
    });
  });
});

// A select-all scoped inside a shadow root describes "everything in this
// container". Keeping its points at the element level would leave the
// container's own structural children in the range, so the next select-all
// widens to the container's parent and a delete removes rows and cells
// instead of their text.
describe('repeated select-all inside a table cell', () => {
  initializeUnitTest(testEnv => {
    test('stays scoped to the cell and leaves the table intact', () => {
      testEnv.editor.update(
        () => {
          const table = $createTableNodeWithDimensions(2, 2, false);
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('before')),
              table,
            );
          const row = $assertNodeType(table.getFirstChild(), $isTableRowNode);
          const cell = $assertNodeType(row.getFirstChild(), $isTableCellNode);
          const paragraph = $assertNodeType(
            cell.getFirstChild(),
            $isParagraphNode,
          );
          paragraph.append($createTextNode('a1'));
          paragraph.selectEnd();
        },
        {discrete: true},
      );

      // All in one update: no DOM round-trip renormalizes the points in
      // between, which is what hid this from a per-keystroke test.
      testEnv.editor.update(
        () => {
          const initial = $getSelection();
          assert($isRangeSelection(initial));
          let selection = initial;
          for (let i = 0; i < 3; i++) {
            selection = $selectAll(selection);
            expect(selection.anchor.type).toBe('text');
            expect(selection.focus.type).toBe('text');
          }
          selection.removeText();
        },
        {discrete: true},
      );

      testEnv.editor.read(() => {
        expect($getRoot().getChildrenSize()).toBe(2);
        const table = $assertNodeType($getRoot().getLastChild(), $isTableNode);
        // Every row and cell survives, and no ParagraphNode was appended
        // directly into the table or a row.
        expect(
          table.getChildren().map(row =>
            $assertNodeType(row, $isTableRowNode)
              .getChildren()
              .map(cell =>
                $assertNodeType(cell, $isTableCellNode).getTextContent(),
              ),
          ),
        ).toEqual([
          ['', ''],
          ['', ''],
        ]);
      });
    });
  });
});
