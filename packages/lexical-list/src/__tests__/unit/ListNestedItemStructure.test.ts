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
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListExtension,
  type ListItemNode,
  type ListNode,
} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
  OUTDENT_CONTENT_COMMAND,
  type TextNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test} from 'vitest';

function buildEditor(structure: boolean) {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        RichTextExtension,
        ListExtension,
        ...(structure ? [NodeStructureExtension] : []),
      ],
      name: 'nested-list-item-structure',
      onError: e => {
        throw e;
      },
    }),
  );
}

/** Lists as `{listType: items}`, items as arrays of their children. */
function $shape(node: LexicalNode): unknown {
  if ($isListNode(node)) {
    return {[node.getListType()]: node.getChildren().map($shape)};
  }
  if ($isListItemNode(node)) {
    return node.getChildren().map($shape);
  }
  if ($isLineBreakNode(node)) {
    return '\n';
  }
  if ($isElementNode(node)) {
    return {[node.getType()]: node.getChildren().map($shape)};
  }
  return node.getTextContent();
}

function shape(editor: LexicalEditor): unknown {
  return editor.read(() => $getRoot().getChildren().map($shape));
}

function $text(text: string): TextNode {
  const node = $getRoot()
    .getAllTextNodes()
    .find(t => t.getTextContent() === text);
  assert($isTextNode(node), `no text node ${JSON.stringify(text)}`);
  return node;
}

function $item(...children: LexicalNode[]): ListItemNode {
  return $createListItemNode().append(...children);
}

function $list(
  listType: 'bullet' | 'number',
  ...items: ListItemNode[]
): ListNode {
  return $createListNode(listType).append(...items);
}

/** bullet [ "top", [ number ["one", "two", "three"], "stray" ] ] */
function $strayAfterNestedList(): void {
  $getRoot()
    .clear()
    .append(
      $list(
        'bullet',
        $item($createTextNode('top')),
        $item(
          $list(
            'number',
            $item($createTextNode('one')),
            $item($createTextNode('two')),
            $item($createTextNode('three')),
          ),
          $createTextNode('stray'),
        ),
      ),
    );
}

function outdent(editor: LexicalEditor, text: string): void {
  editor.update(
    () => {
      $text(text).select(1, 1);
      editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
    },
    {discrete: true},
  );
}

describe('a list item holding a nested list holds nothing else', () => {
  test('with NodeStructureExtension, content after the nested list moves into a following item', () => {
    using editor = buildEditor(true);
    editor.update($strayAfterNestedList, {discrete: true});
    expect(shape(editor)).toEqual([
      {
        bullet: [['top'], [{number: [['one'], ['two'], ['three']]}], ['stray']],
      },
    ]);
  });

  test('with NodeStructureExtension, content before the nested list stays in the item and the list moves into a following one', () => {
    using editor = buildEditor(true);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $list(
              'number',
              $item(
                $createTextNode('before'),
                $list('bullet', $item($createTextNode('inner'))),
              ),
              $item($createTextNode('next')),
            ),
          );
      },
      {discrete: true},
    );
    expect(shape(editor)).toEqual([
      {number: [['before'], [{bullet: [['inner']]}], ['next']]},
    ]);
    // Numbered as indent builds it: the item that only wraps the list has no
    // number of its own.
    expect(
      editor.read(() =>
        ($getRoot().getFirstChildOrThrow() as ListNode)
          .getChildren()
          .map(item => (item as ListItemNode).getValue()),
      ),
    ).toEqual([1, 2, 2]);
  });

  test('with NodeStructureExtension, two nested lists and the text between them each get their own item, in order', () => {
    using editor = buildEditor(true);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $list(
              'bullet',
              $item(
                $createTextNode('a'),
                $list('number', $item($createTextNode('one'))),
                $createTextNode('b'),
                $createLineBreakNode(),
                $createTextNode('c'),
                $list('bullet', $item($createTextNode('two'))),
              ),
            ),
          );
      },
      {discrete: true},
    );
    expect(shape(editor)).toEqual([
      {
        bullet: [
          ['a'],
          [{number: [['one']]}],
          ['b', '\n', 'c'],
          [{bullet: [['two']]}],
        ],
      },
    ]);
  });

  test('with NodeStructureExtension, a later edit that adds content next to a nested list (or a list next to content) is repaired', () => {
    using editor = buildEditor(true);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $list(
              'bullet',
              $item($createTextNode('text')),
              $item($list('bullet', $item($createTextNode('inner')))),
            ),
          );
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const list = $assertNodeType(
          $getRoot().getFirstChildOrThrow(),
          $isListNode,
        );
        $assertNodeType(list.getLastChildOrThrow(), $isListItemNode).append(
          $createTextNode('x'),
        );
        $assertNodeType(list.getFirstChildOrThrow(), $isListItemNode).append(
          $list('number', $item($createTextNode('n'))),
        );
      },
      {discrete: true},
    );
    expect(shape(editor)).toEqual([
      {
        bullet: [['text'], [{number: [['n']]}], [{bullet: [['inner']]}], ['x']],
      },
    ]);
  });

  test('with NodeStructureExtension, a check state stays on the item that keeps it, and moved content starts unchecked', () => {
    using editor = buildEditor(true);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createListNode('check').append(
              $createListItemNode(true).append(
                $createTextNode('done'),
                $list('bullet', $item($createTextNode('inner'))),
                $createTextNode('after'),
              ),
            ),
          );
      },
      {discrete: true},
    );
    expect(
      editor.read(() =>
        ($getRoot().getFirstChildOrThrow() as ListNode)
          .getChildren()
          .map(item => [
            (item as ListItemNode).getTextContent(),
            (item as ListItemNode).getChecked(),
          ]),
      ),
    ).toEqual([
      ['done', true],
      ['inner', false],
      ['after', false],
    ]);
  });

  test('with NodeStructureExtension, an element point in the item follows the content it was next to', () => {
    using editor = buildEditor(true);
    editor.update(
      () => {
        const wrapper = $item(
          $list('number', $item($createTextNode('one'))),
          $createTextNode('stray'),
        );
        $getRoot().clear().append($list('bullet', wrapper));
        const selection = $createRangeSelection();
        // Before "stray" to the end of the item.
        selection.anchor.set(wrapper.getKey(), 1, 'element');
        selection.focus.set(wrapper.getKey(), 2, 'element');
        $setSelection(selection);
      },
      {discrete: true},
    );
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      // The normalization puts the points in the text they were next to.
      expect(selection.getTextContent()).toBe('stray');
      expect([selection.anchor.getNode(), selection.anchor.offset]).toEqual([
        $text('stray'),
        0,
      ]);
      expect([selection.focus.getNode(), selection.focus.offset]).toEqual([
        $text('stray'),
        'stray'.length,
      ]);
    });
  });

  test('with NodeStructureExtension, a shape the document already holds is kept by an unrelated edit', () => {
    using editor = buildEditor(true);
    // A document stored that way (written without the normalization).
    editor.update($strayAfterNestedList, {
      discrete: true,
      skipTransforms: true,
    });
    // Typing elsewhere in the list, and in the item that holds the shape.
    for (const [text, offset] of [
      ['top', 3],
      ['stray', 5],
      ['two', 3],
    ] as const) {
      editor.update(
        () => {
          $text(text).select(offset, offset);
          $getSelection()!.insertText('!');
        },
        {discrete: true},
      );
    }
    expect(shape(editor)).toEqual([
      {
        bullet: [
          ['top!'],
          [{number: [['one'], ['two!'], ['three']]}, 'stray!'],
        ],
      },
    ]);
  });

  test('without NodeStructureExtension, the shape is kept as it is', () => {
    using editor = buildEditor(false);
    editor.update($strayAfterNestedList, {discrete: true});
    expect(shape(editor)).toEqual([
      {
        bullet: [['top'], [{number: [['one'], ['two'], ['three']]}, 'stray']],
      },
    ]);
  });

  for (const structure of [true, false]) {
    test(`a paste of paragraphs at the end of a nested list item, then an outdent, keeps every word (NodeStructureExtension: ${structure})`, () => {
      using editor = buildEditor(structure);
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append(
              $list(
                'bullet',
                $item($createTextNode('one')),
                $item(
                  $list(
                    'bullet',
                    $item($createTextNode('two')),
                    $item($createTextNode('three')),
                  ),
                ),
              ),
            );
        },
        {discrete: true},
      );
      editor.update(
        () => {
          $text('three').select(5, 5);
          $insertGeneratedNodes(
            editor,
            [
              $createParagraphNode().append($createTextNode('pasted one')),
              $createParagraphNode().append($createTextNode('pasted two')),
            ],
            $getSelection()!,
          );
        },
        {discrete: true},
      );
      // Lexical's paste puts the last paragraph into the wrapper item, after
      // its nested list (NodeStructureExtension unwraps it to its text); the
      // rule moves that text into a following item.
      expect(shape(editor)).toEqual([
        {
          bullet: [
            ['one'],
            ...(structure
              ? [[{bullet: [['two'], ['threepasted one']]}], ['pasted two']]
              : [
                  [
                    {bullet: [['two'], ['threepasted one']]},
                    {paragraph: ['pasted two']},
                  ],
                ]),
          ],
        },
      ]);
      // The caret stays at the end of the pasted text.
      editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection) && selection.isCollapsed());
        expect(selection.anchor.getNode().getTextContent()).toBe('pasted two');
        expect(selection.anchor.offset).toBe('pasted two'.length);
      });
      outdent(editor, 'two');
      expect(editor.read(() => $getRoot().getTextContent())).toBe(
        'one\n\ntwo\n\nthreepasted one\n\npasted two',
      );
    });
  }
});

describe('outdent next to other content in the wrapper item (without NodeStructureExtension)', () => {
  test('outdenting a middle item keeps the text after the nested list, in reading order', () => {
    using editor = buildEditor(false);
    editor.update($strayAfterNestedList, {discrete: true});
    outdent(editor, 'two');
    expect(shape(editor)).toEqual([
      {
        bullet: [
          ['top'],
          [{number: [['one']]}],
          ['two'],
          [{number: [['three']]}],
          ['stray'],
        ],
      },
    ]);
    // The caret stays in the outdented item.
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect(selection.anchor.getNode().getTextContent()).toBe('two');
    });
  });

  test('outdenting the first and the last item keeps the text after the nested list', () => {
    using editor = buildEditor(false);
    editor.update($strayAfterNestedList, {discrete: true});
    // The first and the last of several items move as they always did
    // (the wrapper keeps the nested list and the text); the only item left
    // takes the outdent that keeps the wrapper's text.
    outdent(editor, 'one');
    expect(shape(editor)).toEqual([
      {bullet: [['top'], ['one'], [{number: [['two'], ['three']]}, 'stray']]},
    ]);
    outdent(editor, 'three');
    expect(shape(editor)).toEqual([
      {bullet: [['top'], ['one'], [{number: [['two']]}, 'stray'], ['three']]},
    ]);
    outdent(editor, 'two');
    expect(shape(editor)).toEqual([
      {bullet: [['top'], ['one'], ['two'], ['stray'], ['three']]},
    ]);
  });

  test('text before the nested list stays before the items it preceded', () => {
    using editor = buildEditor(false);
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $list(
              'bullet',
              $item(
                $createTextNode('before'),
                $list(
                  'bullet',
                  $item($createTextNode('one')),
                  $item($createTextNode('two')),
                ),
              ),
            ),
          );
      },
      {discrete: true},
    );
    outdent(editor, 'two');
    expect(shape(editor)).toEqual([
      {bullet: [['before', {bullet: [['one']]}], ['two']]},
    ]);
    outdent(editor, 'one');
    expect(shape(editor)).toEqual([{bullet: [['before'], ['one'], ['two']]}]);
  });
});
