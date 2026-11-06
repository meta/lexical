/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// ListItemNode's transform clears `checked` on an item outside a check list
// (as updateChildrenListItemValue does for a list's children). It tested
// getChecked(), which is undefined outside a check list, so it never did: an
// item that got there with a checked value an update without transforms
// left (a collaborator's change read with skipTransforms, as @lexical/y
// reads) kept it hidden, and showed it again once its list became a check
// list: https://github.com/meta/lexical/issues/9820.

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListExtension,
  type ListItemNode,
} from '@lexical/list';
import {$createTextNode, $getRoot, defineExtension} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [ListExtension],
      name: 'list-item-checked-host',
    }),
  );
}

function $item(): ListItemNode {
  const list = $getRoot().getFirstChild();
  assert($isListNode(list), 'expected a ListNode at the root');
  const item = list.getFirstChild();
  assert($isListItemNode(item), 'expected a ListItemNode');
  return item;
}

describe('a list item outside a check list', () => {
  for (const listType of ['number', 'bullet'] as const) {
    test.fails(
      `in a ${listType} list loses a checked value once an update edits it`,
      () => {
        using editor = buildEditor();
        // As a read without transforms leaves it.
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createListNode(listType).append(
                  $createListItemNode(true).append($createTextNode('one')),
                ),
              );
          },
          {discrete: true, skipTransforms: true},
        );
        expect(editor.read(() => $item().getLatest().__checked)).toBe(true);
        editor.update(
          () => {
            // An edit of the item itself (its alignment).
            $item().setFormat('center');
          },
          {discrete: true},
        );
        expect(editor.read(() => $item().getLatest().__checked)).toBe(
          undefined,
        );
        // And it does not show checked when its list becomes a check list.
        editor.update(
          () => {
            const list = $getRoot().getFirstChild();
            assert($isListNode(list), 'expected a ListNode');
            list.setListType('check');
          },
          {discrete: true},
        );
        expect(editor.read(() => $item().getChecked())).toBe(false);
      },
    );
  }
});
