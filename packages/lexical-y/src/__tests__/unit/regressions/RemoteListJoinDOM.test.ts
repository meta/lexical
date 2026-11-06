/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// A collaborator joins a nested list item into the item before it. Reading
// that, the binding keeps the keys of the text and link nodes it moves between
// list items; the reconciler of an editor with a DOM threw ("DOMSlot.insertChild:
// before is not in element") and its recovery left the editor unable to take
// later changes.

import {$createLinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {
  $createLineBreakNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type ElementNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {freshReader, NODES, setup, shape} from '../../utils/harness';

test('a remote join of a nested list item into the previous item renders in a DOM editor', async () => {
  const {a, b, sync} = await setup(() => {
    const nested = $createListNode('bullet').append(
      $createListItemNode().append(
        $createTextNode('t29z t30z'),
        $createLineBreakNode(),
        $createTextNode('t31z '),
        $createLinkNode('https://x.co').append($createTextNode('t32z')),
        $createTextNode(' t33z'),
      ),
      $createListItemNode().append($createTextNode('t34z t35z')),
    );
    $getRoot().append(
      $createListNode('bullet').append(
        $createListItemNode().append(
          $createTextNode('t26z '),
          $createLinkNode('https://x.co').append($createTextNode('t27z')),
          $createTextNode(' @ '),
          $createLinkNode('https://x.co').append($createTextNode('t28z')),
        ),
        $createListItemNode().append(nested),
      ),
    );
  });
  const errors: string[] = [];
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  const prevOnError = b.editor._onError;
  b.editor._onError = (e: Error) => {
    errors.push(e.message);
    prevOnError(e);
  };
  b.editor.setRootElement(root);
  a.update(() => {
    const top = $getRoot().getFirstChildOrThrow() as ElementNode;
    const first = top.getFirstChildOrThrow() as ElementNode;
    const nestedItem = top.getChildAtIndex(1) as ElementNode;
    const nestedList = nestedItem.getFirstChildOrThrow() as ElementNode;
    const item = nestedList.getFirstChildOrThrow() as ElementNode;
    first.append(...item.getChildren());
    item.remove();
  });
  await sync();
  const f = await freshReader(a);
  expect(errors).toEqual([]);
  expect(shape(b)).toEqual(shape(f));
  // b's DOM is the DOM a fresh editor renders for the same state.
  const fresh = createEditor({
    namespace: 'remote-list-join-fresh',
    nodes: NODES,
    onError: (e: Error) => {
      throw e;
    },
  });
  const freshRoot = document.createElement('div');
  freshRoot.contentEditable = 'true';
  document.body.appendChild(freshRoot);
  fresh.setRootElement(freshRoot);
  fresh.setEditorState(
    fresh.parseEditorState(JSON.stringify(b.editor.getEditorState().toJSON())),
  );
  expect(root.innerHTML).toBe(freshRoot.innerHTML);
  freshRoot.remove();
  root.remove();
});
