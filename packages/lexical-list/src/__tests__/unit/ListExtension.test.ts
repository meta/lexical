/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  CheckListExtension,
  ListExtension,
} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {$createTextNode, $getRoot, INSERT_PARAGRAPH_COMMAND} from 'lexical';
import {invariant} from 'lexical/src/__tests__/utils';
import {describe, expect, it} from 'vitest';

// TODO: write more tests here
describe('ListExtension', () => {
  const extension = defineExtension({
    $initialEditorState: () => {
      $getRoot().append(
        $createListNode('number').append(
          $createListItemNode().append($createTextNode('item 1')),
          $createListItemNode().append($createTextNode('item 2')),
        ),
      );
    },
    dependencies: [ListExtension, RichTextExtension],
    name: '[root]',
  });
  it('Creates the list', () => {
    using editor = buildEditorFromExtensions(extension);
    editor.update(
      () => {
        const ol = $getRoot().getFirstChildOrThrow();
        expect($isListNode(ol)).toBe(true);
      },
      {discrete: true},
    );
  });
});
describe('CheckListExtension', () => {
  const extension = defineExtension({
    $initialEditorState: () => {
      $getRoot().append(
        $createListNode('check').append(
          $createListItemNode(true).append($createTextNode('checked')),
          $createListItemNode(false).append($createTextNode('unchecked')),
        ),
      );
    },
    dependencies: [CheckListExtension, RichTextExtension],
    name: '[root]',
  });

  it('Preserves numbering when configured via extension', () => {
    const ConfiguredListExtension = {
      ...ListExtension,
      config: {
        hasStrictIndent: false,
        shouldPreserveNumbering: true, // The override
      },
    };

    const configuredExtension = defineExtension({
      $initialEditorState: () => {
        const list = $createListNode('number');
        const item1 = $createListItemNode().append($createTextNode('A'));
        const emptyItem = $createListItemNode();
        const item2 = $createListItemNode().append($createTextNode('B'));
        list.append(item1, emptyItem, item2);
        $getRoot().append(list);
      },
      dependencies: [ConfiguredListExtension, RichTextExtension],
      name: '[root-configured]',
    });

    using editor = buildEditorFromExtensions(configuredExtension);

    editor.update(() => {
      const root = $getRoot();
      const list = root.getFirstChildOrThrow();
      if ($isListNode(list)) {
        const emptyItem = list.getChildAtIndex(1);

        invariant(
          $isListItemNode(emptyItem),
          'Expected second child to be a list item',
        );

        emptyItem.select();
      }
    });

    editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND);

    editor.update(() => {
      const root = $getRoot();
      const children = root.getChildren();

      // We expect 3 children now: List, Paragraph, List
      expect(children).toHaveLength(3);

      const secondList = children[2];
      invariant($isListNode(secondList), 'Expected third child to be a list');

      // Since we split at Item 1 (index 0), the next list should start at 2
      // Item 1 stays in List 1. Item 2 moves to List 2.
      expect(secondList.getStart()).toBe(2);
    });
  });

  it('Creates the list', () => {
    using editor = buildEditorFromExtensions(extension);
    editor.update(
      () => {
        const ul = $getRoot().getFirstChildOrThrow();
        expect($isListNode(ul)).toBe(true);
      },
      {discrete: true},
    );
  });
});
