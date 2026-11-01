/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $getBlockId,
  BlockIdExtension,
  buildEditorFromExtensions,
} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $isListNode,
  ListExtension,
} from '@lexical/list';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $parseSerializedNode,
  configExtension,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {expect, test} from 'vitest';

// A copy of a block lands where it is not an identified block (a number
// list pasted into a nested item of a bullet list nests there): it keeps no
// id, so the block it was copied from stays the only holder of its id.

const all = (n: LexicalNode): LexicalNode[] => [
  n,
  ...($isElementNode(n) ? n.getChildren().flatMap(all) : []),
];

test('a list copied into a nested list item (where it nests) keeps no block id', () => {
  let n = 0;
  using editor = buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      ListExtension,
      configExtension(BlockIdExtension, {generateId: () => `g${++n}`}),
    ],
    name: 'test',
    onError: e => {
      throw e;
    },
  });
  editor.update(
    () => {
      $getRoot().append(
        $createListNode('number').append(
          $createListItemNode().append($createTextNode('one')),
          $createListItemNode().append($createTextNode('two')),
        ),
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('top')),
          $createListItemNode().append(
            $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('nested')),
            ),
          ),
        ),
      );
    },
    {discrete: true},
  );
  const listId = editor.read(() => $getBlockId($getRoot().getFirstChild()!));
  expect(listId).not.toBeNull();
  // A paste of the whole number list into the nested item: its JSON, with
  // the list's NodeState, parsed into a new node.
  editor.update(
    () => {
      const source = $assertNodeType(
        $getRoot().getFirstChildOrThrow(),
        $isListNode,
      );
      const copy = $parseSerializedNode(source.exportJSON()) as ElementNode;
      for (const item of source.getChildren()) {
        copy.append($parseSerializedNode((item as ElementNode).exportJSON()));
      }
      const nestedList = $assertNodeType(
        $assertNodeType(
          $assertNodeType(
            $getRoot().getLastChildOrThrow(),
            $isElementNode,
          ).getLastChildOrThrow(),
          $isElementNode,
        ).getFirstChildOrThrow(),
        $isElementNode,
      );
      $assertNodeType(nestedList.getFirstChildOrThrow(), $isElementNode).append(
        copy,
      );
    },
    {discrete: true},
  );
  editor.read(() => {
    const holders = all($getRoot()).filter(
      node => $isListNode(node) && $getBlockId(node) === listId,
    );
    expect(holders.length).toBe(1);
    expect(holders[0].is($getRoot().getFirstChild())).toBe(true);
  });
});
