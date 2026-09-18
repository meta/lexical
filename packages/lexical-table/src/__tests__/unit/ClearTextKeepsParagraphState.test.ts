/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $computeTableMapSkipCellCheck,
  $createTableNodeWithDimensions,
  $createTableSelectionFrom,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableExtension,
} from '@lexical/table';
import {
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  $setSelection,
  defineExtension,
  KEY_BACKSPACE_COMMAND,
  type LexicalEditorWithDispose,
} from 'lexical';
import {afterEach, assert, beforeEach, describe, expect, test} from 'vitest';

let container: HTMLDivElement;
let editor: LexicalEditorWithDispose;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [TableExtension],
      name: 'clear-text-host',
      theme: {tableScrollableWrapper: ''},
    }),
  );
  // The table selection observer only registers its key handlers once the
  // editor has a root element in the document.
  editor.setRootElement(container);
});

afterEach(() => {
  editor.dispose();
  document.body.removeChild(container);
});

function $firstRowParagraphState() {
  const table = $getRoot().getFirstChild();
  assert($isTableNode(table), 'expected a TableNode at the root');
  const firstRow = table.getChildren().filter($isTableRowNode)[0];
  return firstRow
    .getChildren()
    .filter($isTableCellNode)
    .map(cell => {
      const paragraph = cell.getFirstChild();
      assert($isParagraphNode(paragraph), 'expected a ParagraphNode in a cell');
      return {
        direction: paragraph.getDirection(),
        format: paragraph.getFormatType(),
        style: paragraph.getStyle(),
        text: cell.getTextContent(),
      };
    });
}

describe('clearing a table selection', () => {
  test('keeps the paragraph format, style and direction of each cell', () => {
    editor.update(
      () => {
        const table = $createTableNodeWithDimensions(2, 2, false);
        $getRoot().clear().append(table);
        const [map] = $computeTableMapSkipCellCheck(table, null, null);
        for (const {cell} of map[0]) {
          const paragraph = cell.getFirstChild();
          assert($isParagraphNode(paragraph), 'expected a ParagraphNode');
          paragraph
            .setFormat('center')
            .setDirection('rtl')
            .setStyle('line-height: 2;');
          paragraph.append($createTextNode('text'));
        }
        $setSelection(
          $createTableSelectionFrom(table, map[0][0].cell, map[0][1].cell),
        );
      },
      {discrete: true},
    );

    // Backspace over a multi-cell selection routes to TableObserver.$clearText.
    // The selection covers only the first row, so the table itself survives.
    editor.update(
      () => {
        editor.dispatchCommand(
          KEY_BACKSPACE_COMMAND,
          new KeyboardEvent('keydown', {key: 'Backspace'}),
        );
      },
      {discrete: true},
    );

    editor.read('latest', () => {
      expect($firstRowParagraphState()).toEqual([
        {
          direction: 'rtl',
          format: 'center',
          style: 'line-height: 2;',
          text: '',
        },
        {
          direction: 'rtl',
          format: 'center',
          style: 'line-height: 2;',
          text: '',
        },
      ]);
    });
  });
});
