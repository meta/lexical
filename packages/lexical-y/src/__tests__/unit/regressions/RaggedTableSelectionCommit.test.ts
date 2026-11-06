/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A table selection across a short row of a ragged table, with TableExtension
// registered before the binding: the table's update listener reads the
// selection's nodes on every commit. When that threw, Lexical stopped calling
// the later listeners, so the binding never stored the commit (a comment the
// editor showed and the document did not).

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$addMarkID, MarkStateExtension} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $createTableSelectionFrom,
  $isTableNode,
  type TableCellNode,
  TableExtension,
  type TableNode,
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
  type ElementNode,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc, YCollabExtension} from '../../..';
import {readYState} from '../../../headless';
import {flush} from '../../utils/harness';

test('a commit while a table selection spans a short row is stored', async () => {
  const doc = createYDoc(null);
  doc.clientID = 31;
  const errors: unknown[] = [];
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        RichTextExtension,
        TableExtension,
        MarkStateExtension,
        configExtension(YCollabExtension, {doc, schemaVersion: 1}),
      ],
      name: 'ragged-table-selection-commit',
      onError: (e: Error) => {
        errors.push(e);
      },
    }),
  );
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  const $cell = (text: string) =>
    $createTableCellNode().append(
      $createParagraphNode().append($createTextNode(text)),
    );
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createTableNode().append(
            $createTableRowNode().append($cell('a1'), $cell('b1'), $cell('c1')),
            $createTableRowNode().append($cell('a2'), $cell('b2')),
            $createTableRowNode().append($cell('a3'), $cell('b3'), $cell('c3')),
          ),
          $createParagraphNode().append($createTextNode('alpha beta')),
        );
    },
    // As a remote update leaves it: the table transform does not pad it.
    {discrete: true, skipTransforms: true},
  );
  getExtensionDependencyFromEditor(
    editor,
    YCollabExtension,
  ).output.binding.initialize();
  await flush();
  editor.update(
    () => {
      const table = $getRoot().getChildren().find($isTableNode) as TableNode;
      const rows = table.getChildren() as ElementNode[];
      $setSelection(
        $createTableSelectionFrom(
          table,
          rows[0].getFirstChildOrThrow() as TableCellNode,
          rows[2].getLastChildOrThrow() as TableCellNode,
        ),
      );
    },
    {discrete: true},
  );
  await flush();
  let thrown: unknown = null;
  try {
    editor.update(
      () => {
        // The table selection stays the editor's selection.
        const paragraph = $getRoot().getLastChildOrThrow() as ElementNode;
        const text = paragraph.getFirstChildOrThrow() as TextNode;
        const range = $createRangeSelection();
        range.anchor.set(text.getKey(), 0, 'text');
        range.focus.set(text.getKey(), 5, 'text');
        $addMarkID('c7', range);
      },
      {discrete: true},
    );
  } catch (e) {
    thrown = e;
  }
  await flush();
  const mine = JSON.stringify(editor.getEditorState().toJSON());
  const fresh = JSON.stringify(
    readYState(
      Y.encodeStateAsUpdate(doc),
      {extensions: [MarkStateExtension, TableExtension], schemaVersion: 1},
      () => $getEditor().getEditorState().toJSON(),
    ),
  );
  expect(thrown).toBe(null);
  expect(mine.includes('"c7"')).toBe(true);
  expect(fresh.includes('"c7"')).toBe(true);
  editor.dispose();
  root.remove();
});
