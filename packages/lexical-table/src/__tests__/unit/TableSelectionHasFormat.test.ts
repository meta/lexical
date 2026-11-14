/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $createTableSelectionFrom,
  $isTableCellNode,
  type TableNode,
  type TableSelection,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  $setSelection,
  type LexicalNode,
  TEXT_TYPE_TO_FORMAT,
  type TextFormatType,
} from 'lexical';
import {initializeUnitTest} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

/**
 * A toolbar reads `TableSelection.hasFormat` to decide whether Bold shows as
 * pressed while table cells are selected, and the table's own formatting path
 * (`TableObserver.$formatCells`, driven by FORMAT_TEXT_COMMAND) relies on the
 * same notion of "what format is in these cells" to decide which way to toggle.
 * So `hasFormat` has to report the formats present in the selected cells.
 */
describe('TableSelection.hasFormat', () => {
  initializeUnitTest(testEnv => {
    /** A one-row table whose cells are built by `cells`, all of them selected. */
    function buildAndSelect(...cells: (() => LexicalNode[])[]): TableSelection {
      let selection!: TableSelection;
      testEnv.editor.update(() => {
        const rowNode = $createTableRowNode();
        const tableNode: TableNode = $createTableNode().append(rowNode);
        $getRoot().clear().append(tableNode);
        const cellNodes = cells.map(build => {
          const cellNode = $createTableCellNode();
          cellNode.append(...build());
          rowNode.append(cellNode);
          return cellNode;
        });
        selection = $createTableSelectionFrom(
          tableNode,
          cellNodes[0],
          cellNodes[cellNodes.length - 1],
        );
        $setSelection(selection);
      });
      return selection;
    }

    function hasFormat(
      selection: TableSelection,
      type: TextFormatType,
    ): boolean {
      let value = false;
      testEnv.editor.read(() => {
        value = selection.hasFormat(type);
      });
      return value;
    }

    function $boldParagraph(text: string): LexicalNode[] {
      return [
        $createParagraphNode().append(
          $createTextNode(text).setFormat('bold'),
          $createTextNode(' done'),
        ),
      ];
    }

    function $plainParagraph(text: string): LexicalNode[] {
      return [$createParagraphNode().append($createTextNode(text))];
    }

    /** A paragraph whose caret format is bold, while its text is plain. */
    function $boldTypingParagraph(text: string): LexicalNode[] {
      const paragraph = $createParagraphNode().append($createTextNode(text));
      paragraph.setTextFormat(TEXT_TYPE_TO_FORMAT.bold);
      return [paragraph];
    }

    test('reports bold on text in a selected cell', () => {
      const selection = buildAndSelect(() => $boldParagraph('Hello'));

      expect(hasFormat(selection, 'bold')).toBe(true);
    });

    test('reports bold in any paragraph of a selected cell', () => {
      const selection = buildAndSelect(() => [
        ...$plainParagraph('plain first'),
        ...$boldParagraph('Bold second'),
      ]);

      expect(hasFormat(selection, 'bold')).toBe(true);
    });

    test('reports bold from any cell of a multi-cell selection', () => {
      const selection = buildAndSelect(
        () => $plainParagraph('plain'),
        () => $boldParagraph('World'),
      );

      expect(hasFormat(selection, 'bold')).toBe(true);
    });

    test('keeps reporting the format a selected block would type in', () => {
      // The behavior this method already had, which the wider walk preserves:
      // a paragraph's own text format counts even when its text is plain.
      const selection = buildAndSelect(() => $boldTypingParagraph('typed'));

      expect(hasFormat(selection, 'bold')).toBe(true);
      expect(hasFormat(selection, 'italic')).toBe(false);
    });

    test('reports the bold that the table formatting path just applied', () => {
      const selection = buildAndSelect(
        () => $plainParagraph('one'),
        () => $plainParagraph('two'),
      );

      // The same walk `TableObserver.$formatCells` performs when the toolbar's
      // Bold button dispatches FORMAT_TEXT_COMMAND over a cell selection.
      testEnv.editor.update(() => {
        const formatSelection = $createRangeSelection();
        const cells = selection.getNodes().filter($isTableCellNode);
        const paragraph = cells[0].getFirstChild();
        const alignFormatWith = $isParagraphNode(paragraph)
          ? paragraph.getFormatFlags('bold', null)
          : null;
        for (const cellNode of cells) {
          formatSelection.anchor.set(cellNode.getKey(), 0, 'element');
          formatSelection.focus.set(
            cellNode.getKey(),
            cellNode.getChildrenSize(),
            'element',
          );
          formatSelection.formatText('bold', alignFormatWith);
        }
      });

      // Precondition: the formatting really did land on the cells' text.
      testEnv.editor.read(() => {
        expect(
          selection
            .getNodes()
            .filter($isTableCellNode)
            .flatMap(cell => cell.getAllTextNodes())
            .map(node => node.hasFormat('bold')),
        ).toEqual([true, true]);
      });

      expect(hasFormat(selection, 'bold')).toBe(true);
    });

    test('reports false for a format no selected cell has', () => {
      const selection = buildAndSelect(
        () => $plainParagraph('one'),
        () => $boldParagraph('Two'),
      );

      expect(hasFormat(selection, 'bold')).toBe(true);
      expect(hasFormat(selection, 'italic')).toBe(false);
    });
  });
});
