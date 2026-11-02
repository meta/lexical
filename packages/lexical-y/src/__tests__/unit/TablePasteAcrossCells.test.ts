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
} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getEditor,
  $getRoot,
  $setSelection,
  configExtension,
  defineExtension,
  type TextNode,
} from 'lexical';
import {assert, expect, test} from 'vitest';

import {createYDoc, YCollabExtension, type YDoc} from '../..';
import {readYState} from '../../headless';

const EXTENSIONS = [
  NodeStructureExtension,
  RichTextExtension,
  ListExtension,
  configExtension(TableExtension, {hasHorizontalScroll: false}),
];

function buildEditor(doc: YDoc | null) {
  return buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        ...EXTENSIONS,
        ...(doc
          ? [
              configExtension(YCollabExtension, {
                doc,
                schemaVersion: 1,
                synced: true,
              }),
            ]
          : []),
      ],
      name: 'table-paste-across-cells',
      onError: e => {
        throw e;
      },
    }),
  );
}

// A 3x3 table; each cell holds a bullet list with one item "rNcM text".
function $init() {
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

// Select from offset 2 of `from` to offset 2 of `to` and paste rich HTML.
const $paste = (from: string, to: string) => () => {
  const texts = $getRoot().getAllTextNodes();
  const find = (prefix: string) =>
    texts.find((t: TextNode) => t.getTextContent().startsWith(prefix))!;
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
};

function $cellsPerRow() {
  const table = $getRoot().getFirstChild();
  assert($isTableNode(table), 'expected a TableNode at the root');
  return table
    .getChildren()
    .filter($isTableRowNode)
    .map(row => row.getChildrenSize())
    .join(',');
}

test.each([
  ['r0c1', 'r1c1'],
  ['r0c2', 'r1c1'],
])(
  'a rich paste over a selection from %s to %s across table cells holding lists gives the same document with and without collaboration',
  (from, to) => {
    const doc = createYDoc();
    const [alone, bound] = [null, doc].map(d => {
      const editor = buildEditor(d);
      editor.update($init, {discrete: true});
      editor.update($paste(from, to), {discrete: true});
      return editor;
    });
    expect(bound.read($cellsPerRow)).toBe('3,3,3');
    expect(bound.getEditorState().toJSON()).toEqual(
      alone.getEditorState().toJSON(),
    );
    // The padding cells are stored: a fresh reader of the document shows them
    expect(
      readYState(
        Y.encodeStateAsUpdate(doc),
        {extensions: EXTENSIONS, schemaVersion: 1},
        () => $getEditor().getEditorState().toJSON(),
      ),
    ).toEqual(bound.getEditorState().toJSON());
  },
);
