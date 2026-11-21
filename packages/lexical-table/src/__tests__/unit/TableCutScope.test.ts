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
  CUT_TAG,
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

/**
 * Cuts the selection, and returns the text/plain it copied, how many times it
 * wrote text/plain, whether a LOW-priority cut listener ran, and whether an
 * update was tagged as a cut, which @lexical/history keeps as its own entry.
 */
async function cut(editor: LexicalEditorWithDispose): Promise<{
  copied: string;
  lowListenerRan: boolean;
  plainTextWrites: number;
  tagged: boolean;
}> {
  const lowListener = vi.fn(() => false);
  let tagged = false;
  const unregister = [
    editor.registerCommand(CUT_COMMAND, lowListener, COMMAND_PRIORITY_LOW),
    editor.registerUpdateListener(({tags}) => {
      tagged ||= tags.has(CUT_TAG);
    }),
  ];
  const clipboardData = new DataTransfer();
  const setData = vi.spyOn(clipboardData, 'setData');
  editor.dispatchCommand(
    CUT_COMMAND,
    new ClipboardEvent('cut', {clipboardData}),
  );
  await flush();
  unregister.forEach(f => f());
  return {
    copied: clipboardData.getData('text/plain'),
    lowListenerRan: lowListener.mock.calls.length > 0,
    plainTextWrites: setData.mock.calls.filter(
      ([type]) => type === 'text/plain',
    ).length,
    tagged,
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

// A table answers the cuts that are wholly its own: a table selection, or a
// range in it. A range with an end outside it is the editor's, as it would be
// with no table in the document (#9281), and a range with one end in the table
// takes the whole table first.
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

      const {lowListenerRan, tagged} = await cut(editor);

      expect(readOutline(editor)).toEqual([['paragraph', []]]);
      expect(lowListenerRan).toBe(true);
      expect(tagged).toBe(true);
    },
  );

  test.for([
    {
      $build: () => [
        $createHeadingNode('h1').append($createTextNode('Title')),
        $table(),
      ],
      document: 'a heading and a table',
    },
    {
      $build: () => [
        $table(),
        $createParagraphNode().append($createTextNode('x y')),
      ],
      document: 'a table and a paragraph',
    },
  ])(
    'select all over $document leaves an empty paragraph',
    async ({$build}) => {
      using editor = createEditor();
      setUp(editor, $build, () => $selectAll());

      const {lowListenerRan, plainTextWrites, tagged} = await cut(editor);

      expect(readOutline(editor)).toEqual([['paragraph', []]]);
      expect(plainTextWrites).toBe(1);
      expect(lowListenerRan).toBe(true);
      expect(tagged).toBe(true);
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

      const {copied, lowListenerRan, plainTextWrites, tagged} =
        await cut(editor);

      expect(copied).toBe('x');
      expect(plainTextWrites).toBe(1);
      expect(lowListenerRan).toBe(true);
      expect(tagged).toBe(true);
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

  test.for([
    {
      from: 'outside',
      outline: [['paragraph', ['text:x after']]],
      range: 'from before the table into a cell',
    },
    {
      from: 'cell',
      outline: [['paragraph', ['text:x yter']]],
      range: 'from a cell to after the table',
    },
  ] as const)(
    'a range $range takes the whole table, and the editor cuts it',
    async ({from, outline: expected}) => {
      using editor = createEditor();
      setUp(
        editor,
        () => [
          $createParagraphNode().append($createTextNode('x y')),
          $table(),
          $createParagraphNode().append($createTextNode('after')),
        ],
        () => {
          const cellText = $assertNodeType(
            $firstTable().getFirstDescendant(),
            $isTextNode,
          );
          if (from === 'outside') {
            const selection = $assertNodeType(
              $getRoot().getFirstDescendant(),
              $isTextNode,
            ).select(2, 2);
            selection.focus.set(cellText.getKey(), 1, 'text');
          } else {
            const after = $assertNodeType(
              $getRoot().getLastDescendant(),
              $isTextNode,
            );
            cellText.select(1, 1).focus.set(after.getKey(), 2, 'text');
          }
        },
      );

      const {copied, lowListenerRan, plainTextWrites, tagged} =
        await cut(editor);

      expect(readOutline(editor)).toEqual(expected);
      expect(copied).toContain('ab');
      expect(plainTextWrites).toBe(1);
      expect(lowListenerRan).toBe(true);
      expect(tagged).toBe(true);
    },
  );

  test('a range from a cell of one table into a cell of another takes both tables', async () => {
    using editor = createEditor();
    setUp(
      editor,
      () => [
        $createParagraphNode().append($createTextNode('x y')),
        $table(),
        $createParagraphNode().append($createTextNode('between')),
        $table(),
        $createParagraphNode().append($createTextNode('after')),
      ],
      () => {
        const [first, second] = $getRoot()
          .getChildren()
          .filter($isTableNode)
          .map(table =>
            $assertNodeType(table.getFirstDescendant(), $isTextNode),
          );
        first.select(1, 1).focus.set(second.getKey(), 1, 'text');
      },
    );

    const {copied, lowListenerRan, plainTextWrites, tagged} = await cut(editor);

    expect(readOutline(editor)).toEqual([['paragraph', ['text:x yafter']]]);
    expect(copied).toContain('between');
    expect(plainTextWrites).toBe(1);
    expect(lowListenerRan).toBe(true);
    expect(tagged).toBe(true);
  });
});
