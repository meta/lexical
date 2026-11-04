/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
  ListItemNode,
  type ListNode,
} from '@lexical/list';
import {
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  type NodeKey,
  type NodeMutation,
} from 'lexical';
import {expect, test} from 'vitest';

// Changing a list's type makes the reconciler build the list's DOM anew. An
// item removed in the same update must leave the editor's DOM map and report
// 'destroyed' to mutation listeners.
test("an item removed in the update that changes its list's type leaves the DOM map", () => {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [ListExtension],
      name: '[list-type-change-removed-item]',
      onError: (error: Error) => {
        throw error;
      },
    }),
  );
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  const destroyed: NodeKey[] = [];
  editor.registerMutationListener(
    ListItemNode,
    (mutations: Map<NodeKey, NodeMutation>) => {
      for (const [key, mutation] of mutations) {
        if (mutation === 'destroyed') {
          destroyed.push(key);
        }
      }
    },
    {skipInitialization: true},
  );
  const keys: Record<string, NodeKey> = {};
  editor.update(
    () => {
      const kept = $createListItemNode().append($createTextNode('kept'));
      const gone = $createListItemNode().append($createTextNode('gone'));
      const list = $createListNode('bullet').append(kept, gone);
      keys.list = list.getKey();
      keys.gone = gone.getKey();
      keys.goneText = gone.getFirstChildOrThrow().getKey();
      $getRoot().clear().append(list);
    },
    {discrete: true},
  );
  editor.update(
    () => {
      ($getNodeByKey(keys.list) as ListNode).setListType('number');
      $getNodeByKey(keys.gone)!.remove();
    },
    {discrete: true},
  );
  const nodeMap = editor.getEditorState()._nodeMap;
  expect([...editor._keyToDOMMap.keys()].filter(k => !nodeMap.has(k))).toEqual(
    [],
  );
  expect(editor.getElementByKey(keys.gone)).toBe(null);
  expect(editor.getElementByKey(keys.goneText)).toBe(null);
  expect(destroyed).toEqual([keys.gone]);
  expect(root.querySelector('ol')!.textContent).toBe('kept');
  editor.dispose();
  root.remove();
});
