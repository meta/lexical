/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Three rows of three cells; an update removes a cell from the first two,
// and a transform that runs later in the same update widens the third row
// (it appends two cells, or raises a cell's span). The rows that lost
// cells are padded to the width the table has once the update is done:
// every row covers five grid positions.

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $computeTableMapSkipCellCheck,
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  type TableCellNode,
  TableExtension,
  type TableNode,
  TableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
} from 'lexical';
import {expect, test} from 'vitest';

const $cell = () =>
  $createTableCellNode().append(
    $createParagraphNode().append($createTextNode('x')),
  );

const $widths = () => {
  const [map] = $computeTableMapSkipCellCheck(
    $getRoot().getFirstChildOrThrow() as TableNode,
    null,
    null,
  );
  return map.map(row => row.length);
};

for (const change of ['append', 'span'] as const) {
  test(`rows that lost cells are padded to a width another row reaches later in the update (${change})`, () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [TableExtension],
        name: 'table-row-pad-later',
        onError: e => {
          throw e;
        },
      }),
    );
    let first = '';
    let active = false;
    let changed = false;
    editor.registerNodeTransform(TableRowNode, row => {
      if (active && !changed && row.getKey() === first) {
        changed = true;
        const table = row.getParent() as TableNode;
        const last = table.getLastChildOrThrow() as TableRowNode;
        if (change === 'append') {
          last.append($cell(), $cell());
        } else {
          (last.getFirstChildOrThrow() as TableCellNode).setColSpan(3);
        }
      }
    });
    editor.update(
      () => {
        const table = $createTableNode();
        for (let i = 0; i < 3; i++) {
          const row = $createTableRowNode().append($cell(), $cell(), $cell());
          if (i === 0) {
            first = row.getKey();
          }
          table.append(row);
        }
        $getRoot().append(table);
      },
      {discrete: true},
    );
    expect(editor.read($widths)).toEqual([3, 3, 3]);
    active = true;
    editor.update(
      () => {
        const rows = (
          $getRoot().getFirstChildOrThrow() as TableNode
        ).getChildren() as TableRowNode[];
        rows[0].getLastChildOrThrow().remove();
        rows[1].getLastChildOrThrow().remove();
      },
      {discrete: true},
    );
    expect(editor.read($widths)).toEqual([5, 5, 5]);
  });
}
