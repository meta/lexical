/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$insertGeneratedNodes} from '@lexical/clipboard';
import {
  buildEditorFromExtensions,
  NodeStructureExtension,
} from '@lexical/extension';
import {$generateNodesFromDOM} from '@lexical/html';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $isTableNode,
  $isTableRowNode,
  TableExtension,
  TableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getEditor,
  $getRoot,
  $setSelection,
  configExtension,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

// A 3x3 table whose cells each hold a bullet list with one item "rNcM text".
function $createListTable() {
  const table = $createTableNode();
  for (let r = 0; r < 3; r++) {
    const row = $createTableRowNode();
    for (let c = 0; c < 3; c++) {
      row.append(
        $createTableCellNode(0).append(
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode(`r${r}c${c} text`)),
          ),
        ),
      );
    }
    table.append(row);
  }
  $getRoot().clear().append(table, $createParagraphNode());
}

// Select from offset 2 of the text starting with `from` to offset 2 of the
// text starting with `to`, and paste rich HTML holding a list over it.
function $pasteAcross(from: string, to: string) {
  const texts = $getRoot().getAllTextNodes();
  const find = (prefix: string) => {
    const text = texts.find(t => t.getTextContent().startsWith(prefix));
    assert(text !== undefined, `no text starting with ${prefix}`);
    return text;
  };
  const selection = $createRangeSelection();
  selection.anchor.set(find(from).getKey(), 2, 'text');
  selection.focus.set(find(to).getKey(), 2, 'text');
  $setSelection(selection);
  const html = '<p><b>bold</b> <i>italic</i></p><ul><li>item</li></ul>';
  $insertGeneratedNodes(
    $getEditor(),
    $generateNodesFromDOM(
      $getEditor(),
      new DOMParser().parseFromString(html, 'text/html'),
    ),
    selection,
  );
}

function $cellsPerRow() {
  const table = $getRoot().getFirstChild();
  assert($isTableNode(table), 'expected a TableNode at the root');
  return table
    .getChildren()
    .filter($isTableRowNode)
    .map(row => row.getChildrenSize())
    .join(',');
}

describe.each([
  ['', []],
  [' with NodeStructureExtension', [NodeStructureExtension]],
] as const)('a paste over a selection across cells%s', (_name, extra) => {
  test.each([
    ['r0c1', 'r1c1'],
    ['r0c2', 'r1c1'],
  ])('from %s to %s keeps every row as wide as the table', (from, to) => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [
          ...extra,
          RichTextExtension,
          ListExtension,
          configExtension(TableExtension, {hasHorizontalScroll: false}),
        ],
        name: 'paste-across-cells',
        onError: e => {
          throw e;
        },
      }),
    );
    editor.update($createListTable, {discrete: true});
    editor.update(() => $pasteAcross(from, to), {discrete: true});
    expect(editor.read($cellsPerRow)).toBe('3,3,3');
  });
});

test('a change to one row pads that row only, not the other short rows', () => {
  // Rows ragged before the update (a concurrent row and column insert from
  // collaborators, merged without transforms) belong to whoever made them:
  // padding them here would race with their authors' own padding.
  using editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        configExtension(TableExtension, {hasHorizontalScroll: false}),
      ],
      name: 'pad-changed-row',
      onError: e => {
        throw e;
      },
    }),
  );
  editor.update(
    () => {
      const table = $createTableNode();
      for (const width of [3, 2, 3]) {
        const row = $createTableRowNode();
        for (let c = 0; c < width; c++) {
          row.append($createTableCellNode(0).append($createParagraphNode()));
        }
        table.append(row);
      }
      $getRoot().clear().append(table, $createParagraphNode());
    },
    {discrete: true, skipTransforms: true},
  );
  expect(editor.read($cellsPerRow)).toBe('3,2,3');
  editor.update(
    () => {
      const table = $getRoot().getFirstChild();
      assert($isTableNode(table), 'expected a TableNode at the root');
      const last = table.getLastChild();
      assert($isTableRowNode(last), 'expected a row');
      last.getLastChildOrThrow().remove();
    },
    {discrete: true},
  );
  expect(editor.read($cellsPerRow)).toBe('3,2,3');
});

test.each([false, true])(
  'an update that adds a row pads every short row, also when a row transform adds it after rows changed (in a transform: %s)',
  inTransform => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        dependencies: [
          RichTextExtension,
          configExtension(TableExtension, {hasHorizontalScroll: false}),
        ],
        name: 'pad-after-row-added',
        onError: e => {
          throw e;
        },
      }),
    );
    const $row = (width: number) => {
      const row = $createTableRowNode();
      for (let c = 0; c < width; c++) {
        row.append($createTableCellNode(0).append($createParagraphNode()));
      }
      return row;
    };
    let first = '';
    let armed = false;
    // Registered before the table exists, so that registering it does not
    // run the transforms on the ragged table.
    const remove = editor.registerNodeTransform(TableRowNode, row => {
      if (armed && row.getKey() === first) {
        armed = false;
        row.insertBefore($row(3));
      }
    });
    editor.update(
      () => {
        const table = $createTableNode();
        for (const width of [3, 3, 2]) {
          table.append($row(width));
        }
        $getRoot().clear().append(table, $createParagraphNode());
        first = table.getFirstChildOrThrow().getKey();
      },
      {discrete: true, skipTransforms: true},
    );
    expect(editor.read($cellsPerRow)).toBe('3,3,2');
    armed = inTransform;
    editor.update(
      () => {
        const table = $getRoot().getFirstChild();
        assert($isTableNode(table), 'expected a TableNode at the root');
        const row = table.getFirstChild();
        assert($isTableRowNode(row), 'expected a row');
        row.getLastChildOrThrow().remove();
        if (!inTransform) {
          row.insertBefore($row(3));
        }
      },
      {discrete: true},
    );
    remove();
    expect(editor.read($cellsPerRow)).toBe('3,3,3,3');
  },
);
