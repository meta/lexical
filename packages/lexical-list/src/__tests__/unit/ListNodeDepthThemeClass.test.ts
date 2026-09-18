/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createListItemNode,
  $createListNode,
  type ListNode,
} from '@lexical/list';
import {$createTextNode, $getRoot} from 'lexical';
import {initializeUnitTest} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

describe('ListNode depth theme classes', () => {
  initializeUnitTest(
    testEnv => {
      test('the previous depth class is removed when a list changes depth', async () => {
        const {editor} = testEnv;
        let listKey = '';

        await editor.update(() => {
          const list = $createListNode('bullet');
          list.append($createListItemNode().append($createTextNode('a')));
          $getRoot().append(list);
          listKey = list.getKey();
        });

        expect(editor.getElementByKey(listKey)!.className).toBe(
          'my-ul-list-class depth-1',
        );

        // Nest the existing list one level deeper. The DOM element is reused,
        // so updateDOM() has to swap depth-1 for depth-2.
        await editor.update(() => {
          const list = $getRoot().getFirstChild() as ListNode;
          const outer = $createListNode('bullet');
          const listItem = $createListItemNode();
          outer.append(listItem);
          $getRoot().append(outer);
          listItem.append(list);
        });

        expect(editor.getElementByKey(listKey)!.className).toBe(
          'my-ul-list-class depth-2',
        );
      });
    },
    {
      namespace: 'test',
      theme: {
        list: {
          ul: 'my-ul-list-class',
          ulDepth: ['depth-1', 'depth-2', 'depth-3'],
        },
      },
    },
  );
});
