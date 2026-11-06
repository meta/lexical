/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {$createHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createTableNodeWithDimensions,
  $createTableSelectionFrom,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableExtension,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  $isTextNode,
  $selectAll,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  CUT_COMMAND,
  type LexicalEditorWithDispose,
  type LexicalNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, onTestFinished, test, vi} from 'vitest';

const ext = defineExtension({
  dependencies: [RichTextExtension, TableExtension],
  name: '[9281-cut]',
});

function createEditor(): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(ext);
  const container = document.createElement('div');
  document.body.appendChild(container);
  editor.setRootElement(container);
  onTestFinished(() => {
    editor.setRootElement(null);
    container.remove();
  });
  return editor;
}

/** The document as nested `[type, children]` pairs, with text spelled out. */
function outline(node: LexicalNode): unknown {
  return $isElementNode(node)
    ? [node.getType(), node.getChildren().map(outline)]
    : `${node.getType()}:${node.getTextContent()}`;
}

function readOutline(editor: LexicalEditorWithDispose): unknown {
  return editor.read(() => $getRoot().getChildren().map(outline));
}

// The rich-text cut awaits copyToClipboard before removing the text, so let
// the microtask/timer queue drain before asserting.
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** Cuts the selection, and returns the text/plain it copied and whether a LOW-priority cut listener ran. */
async function cut(
  editor: LexicalEditorWithDispose,
): Promise<{copied: string; lowListenerRan: boolean}> {
  const lowListener = vi.fn(() => false);
  const unregister = editor.registerCommand(
    CUT_COMMAND,
    lowListener,
    COMMAND_PRIORITY_LOW,
  );
  const clipboardData = new DataTransfer();
  editor.dispatchCommand(
    CUT_COMMAND,
    new ClipboardEvent('cut', {clipboardData}),
  );
  await flush();
  unregister();
  return {
    copied: clipboardData.getData('text/plain'),
    lowListenerRan: lowListener.mock.calls.length > 0,
  };
}

/** A one-row, two-cell table whose first cell holds `ab`. */
function $table() {
  const table = $createTableNodeWithDimensions(1, 2, false);
  const row = $assertNodeType(table.getFirstChild(), $isTableRowNode);
  const cell = $assertNodeType(row.getFirstChild(), $isTableCellNode);
  $assertNodeType(cell.getFirstChild(), $isParagraphNode).append(
    $createTextNode('ab'),
  );
  return table;
}

/** Writes a document, then selects in it once its tables have mounted, as a user would. */
function setUp(
  editor: LexicalEditorWithDispose,
  $build: () => LexicalNode[],
  $select: () => void,
): void {
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append(...$build());
    },
    {discrete: true},
  );
  editor.update($select, {discrete: true});
}

function $firstTable() {
  return $assertNodeType(
    $getRoot().getChildren().find($isTableNode),
    $isTableNode,
  );
}

// A table answers the cuts that concern it: a table selection, or a range with
// an end in the table. A range with neither end in it is the editor's own, as
// it would be with no table in the document (#9281).
describe('the cuts a table answers (#9281)', () => {
  test.for([{withTable: false}, {withTable: true}])(
    'select all over a heading, a table and a paragraph leaves an empty paragraph (withTable: $withTable)',
    async ({withTable}) => {
      using editor = createEditor();
      setUp(
        editor,
        () => [
          $createHeadingNode('h1').append($createTextNode('Title')),
          ...(withTable ? [$table()] : []),
          $createParagraphNode().append($createTextNode('x y')),
        ],
        () => $selectAll(),
      );

      const {lowListenerRan} = await cut(editor);

      expect(readOutline(editor)).toEqual([['paragraph', []]]);
      expect(lowListenerRan).toBe(true);
    },
  );

  test.for([{withTable: false}, {withTable: true}])(
    'a range outside the table is copied once and cut by the editor (withTable: $withTable)',
    async ({withTable}) => {
      using editor = createEditor();
      setUp(
        editor,
        () => [
          $createParagraphNode().append($createTextNode('x y')),
          ...(withTable ? [$table()] : []),
          $createParagraphNode().append($createTextNode('after')),
        ],
        () =>
          $assertNodeType($getRoot().getFirstDescendant(), $isTextNode).select(
            0,
            1,
          ),
      );

      const {copied, lowListenerRan} = await cut(editor);

      expect(copied).toBe('x');
      expect(lowListenerRan).toBe(true);
      expect(
        editor.read(() => $getRoot().getFirstChildOrThrow().getTextContent()),
      ).toBe(' y');
    },
  );

  test('a range in a cell is the table’s', async () => {
    using editor = createEditor();
    setUp(
      editor,
      () => [$createParagraphNode().append($createTextNode('x y')), $table()],
      () =>
        $assertNodeType($firstTable().getFirstDescendant(), $isTextNode).select(
          0,
          1,
        ),
    );

    const {copied, lowListenerRan} = await cut(editor);

    expect(copied).toBe('a');
    expect(lowListenerRan).toBe(false);
    expect(
      editor.read(() => $firstTable().getFirstDescendant()?.getTextContent()),
    ).toBe('b');
  });

  test('a table selection is the table’s', async () => {
    using editor = createEditor();
    setUp(
      editor,
      () => [$createParagraphNode().append($createTextNode('x y')), $table()],
      () => {
        const table = $firstTable();
        const row = $assertNodeType(table.getFirstChild(), $isTableRowNode);
        const cell = $assertNodeType(row.getFirstChild(), $isTableCellNode);
        $setSelection($createTableSelectionFrom(table, cell, cell));
      },
    );

    const {copied, lowListenerRan} = await cut(editor);

    expect(copied.trim()).toBe('ab');
    expect(lowListenerRan).toBe(false);
    expect(
      editor.read(() => $firstTable().getFirstDescendant()?.getTextContent()),
    ).toBe('');
  });

  test('a range from outside the table into a cell is the table’s', async () => {
    using editor = createEditor();
    setUp(
      editor,
      () => [
        $createParagraphNode().append($createTextNode('x y')),
        $table(),
        $createParagraphNode().append($createTextNode('after')),
      ],
      () => {
        const selection = $assertNodeType(
          $getRoot().getFirstDescendant(),
          $isTextNode,
        ).select(2, 2);
        const cellText = $assertNodeType(
          $firstTable().getFirstDescendant(),
          $isTextNode,
        );
        selection.focus.set(cellText.getKey(), 1, 'text');
      },
    );

    const {lowListenerRan} = await cut(editor);

    expect(lowListenerRan).toBe(false);
    expect(readOutline(editor)).toEqual([['paragraph', ['text:x after']]]);
  });
});
