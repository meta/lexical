/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $removeList,
  ListExtension,
  type ListItemNode,
} from '@lexical/list';
import {
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
  type ParagraphNode,
  type PointType,
} from 'lexical';
import {
  $createTestDecoratorNode,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test} from 'vitest';

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [ListExtension],
      name: 'remove-list-selection-host',
      nodes: [TestDecoratorNode],
    }),
  );
}

type NodeOffset = [node: LexicalNode, offset: number];

function $pointType(node: LexicalNode): PointType['type'] {
  return $isTextNode(node) ? 'text' : 'element';
}

function $setPoint(point: PointType, [node, offset]: NodeOffset): void {
  point.set(node.getKey(), offset, $pointType(node));
}

function $select(anchor: NodeOffset, focus: NodeOffset = anchor): void {
  const selection = $createRangeSelection();
  $setPoint(selection.anchor, anchor);
  $setPoint(selection.focus, focus);
  $setSelection(selection);
}

// `node` names the node by its text or its type, so that a failure shows
// where a point went without looking up keys.
function $describePoint(
  [node, offset]: NodeOffset,
  type: PointType['type'] = $pointType(node),
) {
  return {
    key: node.getKey(),
    node: $isTextNode(node) ? node.getTextContent() : node.getType(),
    offset,
    type,
  };
}

function $expectSelection(
  anchor: NodeOffset,
  focus: NodeOffset = anchor,
): void {
  const selection = $getSelection();
  assert($isRangeSelection(selection), 'Expected a RangeSelection');
  const points = [selection.anchor, selection.focus].map(point =>
    $describePoint([point.getNode(), point.offset], point.type),
  );
  expect(points).toEqual([$describePoint(anchor), $describePoint(focus)]);
}

function $paragraphs(): ParagraphNode[] {
  return $getRoot().getChildren().filter($isParagraphNode);
}

/** A list item holding `text` and then an inline decorator. */
function $createItemEndingInDecorator(text: string): ListItemNode {
  return $createListItemNode().append(
    $createTextNode(text),
    $createTestDecoratorNode(),
  );
}

function removeListAfter(editor: LexicalEditor, $setUp: () => void): void {
  editor.update(
    () => {
      $getRoot().clear();
      $setUp();
    },
    {discrete: true},
  );
  editor.update(() => $removeList(), {discrete: true});
}

describe('$removeList keeps the selection', () => {
  test('a caret after an inline decorator at the end of the item', () => {
    using editor = buildEditor();
    removeListAfter(editor, () => {
      const item = $createItemEndingInDecorator('ab ');
      $getRoot().append($createListNode('bullet').append(item));
      $select([item, 2]);
    });

    editor.read(() => {
      const [paragraph] = $paragraphs();
      $expectSelection([paragraph, 2]);
    });
  });

  test('a caret between the text and an inline decorator', () => {
    using editor = buildEditor();
    removeListAfter(editor, () => {
      const item = $createItemEndingInDecorator('ab ');
      $getRoot().append($createListNode('bullet').append(item));
      $select([item, 1]);
    });

    editor.read(() => {
      const [paragraph] = $paragraphs();
      $expectSelection([paragraph.getFirstChildOrThrow(), 3]);
    });
  });

  test('a forward selection with its focus after an inline decorator', () => {
    using editor = buildEditor();
    removeListAfter(editor, () => {
      const item = $createItemEndingInDecorator('ab ');
      $getRoot().append($createListNode('bullet').append(item));
      $select([item.getFirstChildOrThrow(), 1], [item, 2]);
    });

    editor.read(() => {
      const [paragraph] = $paragraphs();
      $expectSelection([paragraph.getFirstChildOrThrow(), 1], [paragraph, 2]);
    });
  });

  test('a backward selection with its anchor after an inline decorator', () => {
    using editor = buildEditor();
    removeListAfter(editor, () => {
      const item = $createItemEndingInDecorator('ab ');
      $getRoot().append($createListNode('bullet').append(item));
      $select([item, 2], [item.getFirstChildOrThrow(), 1]);
    });

    editor.read(() => {
      const [paragraph] = $paragraphs();
      $expectSelection([paragraph, 2], [paragraph.getFirstChildOrThrow(), 1]);
    });
  });

  test('a selection from one item to the next', () => {
    using editor = buildEditor();
    removeListAfter(editor, () => {
      const first = $createItemEndingInDecorator('ab ');
      const second = $createItemEndingInDecorator('xy ');
      $getRoot().append($createListNode('bullet').append(first, second));
      $select([first, 2], [second, 2]);
    });

    editor.read(() => {
      const [first, second] = $paragraphs();
      $expectSelection([first, 2], [second, 2]);
    });
  });

  test('a caret in the text', () => {
    using editor = buildEditor();
    removeListAfter(editor, () => {
      const item = $createItemEndingInDecorator('ab ');
      $getRoot().append($createListNode('bullet').append(item));
      $select([item.getFirstChildOrThrow(), 2]);
    });

    editor.read(() => {
      const [paragraph] = $paragraphs();
      $expectSelection([paragraph.getFirstChildOrThrow(), 2]);
    });
  });

  test('a caret in an empty nested item', () => {
    using editor = buildEditor();
    removeListAfter(editor, () => {
      const nested = $createListItemNode();
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('ab ')),
          $createListItemNode().append(
            $createListNode('bullet').append(nested),
          ),
        ),
      );
      $select([nested, 0]);
    });

    editor.read(() => {
      const [, paragraph] = $paragraphs();
      expect(paragraph.getChildrenSize()).toBe(0);
      $expectSelection([paragraph, 0]);
    });
  });
});
