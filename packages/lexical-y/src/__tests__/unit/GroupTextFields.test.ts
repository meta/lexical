/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

import {$createListItemNode, $createListNode, $isListNode} from '@lexical/list';
import {
  $addUpdateTag,
  $createTextNode,
  $getRoot,
  $isElementNode,
  SKIP_COLLAB_TAG,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {expectConverged, type Peer, setup} from '../utils/harness';

/**
 * What Lexical's DOM reconciler does when it reconciles a list: it sets the
 * list's textFormat/textStyle (and a wrapper item's) from the first text it
 * renders under it, so clients that reconcile different parts of a list
 * hold different values, and none of them is an edit. Headless, the same
 * values set in an update the binding does not write.
 */
function reconcileDerived(peer: Peer, format: number, style: string) {
  peer.editor.update(
    () => {
      $addUpdateTag(SKIP_COLLAB_TAG);
      const list = $assertNodeType($getRoot().getFirstChild(), $isListNode);
      list.setTextFormat(format);
      list.setTextStyle(style);
      const wrapper = $assertNodeType(list.getLastChild(), $isElementNode);
      wrapper.setTextFormat(format);
    },
    {discrete: true},
  );
}

const selfChecks = (peer: Peer) =>
  peer.warnings.filter(w => w.includes('self-check'));

describe("a list's textFormat and textStyle derived by the reconciler", () => {
  test('are not compared by the self-check', async () => {
    const {a, b, peers, sync} = await setup(() =>
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('one')),
          $createListItemNode().append(
            $createListNode('bullet').append(
              $createListItemNode().append($createTextNode('two')),
            ),
          ),
        ),
      ),
    );
    // As a reconcile of each commit that changes the list would: right
    // after a remote change is read, before the binding compares it.
    for (const [peer, format] of [
      [a, 2],
      [b, 1],
    ] as const) {
      peer.editor.registerUpdateListener(({tags}) => {
        if (tags.has('collaboration')) {
          reconcileDerived(peer, format, format === 2 ? 'color: red' : '');
        }
      });
      reconcileDerived(peer, format, '');
    }
    // A structural edit in the list on each client: the other client's
    // read of it compares the whole list.
    a.update(() => {
      const list = $assertNodeType($getRoot().getFirstChild(), $isElementNode);
      $assertNodeType(list.getFirstChild(), $isElementNode).insertAfter(
        $createListItemNode().append($createTextNode('A')),
      );
    });
    await sync();
    b.update(() => {
      const list = $assertNodeType($getRoot().getFirstChild(), $isElementNode);
      $assertNodeType(list.getFirstChild(), $isElementNode).insertBefore(
        $createListItemNode().append($createTextNode('B')),
      );
    });
    await sync();
    for (const peer of peers) {
      expect(selfChecks(peer)).toEqual([]);
      expect(peer.describe()).toBe(a.describe());
    }
  });

  test('a list formatted as part of an edit still reaches every client', async () => {
    const {a, peers, sync} = await setup(() =>
      $getRoot().append(
        $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('one')),
        ),
      ),
    );
    a.update(() => {
      $assertNodeType($getRoot().getFirstChild(), $isListNode).setTextFormat(1);
    });
    await sync();
    await expectConverged(peers);
    for (const peer of peers) {
      expect(
        peer.editor
          .getEditorState()
          .read(() =>
            $assertNodeType(
              $getRoot().getFirstChild(),
              $isListNode,
            ).getTextFormat(),
          ),
      ).toBe(1);
    }
  });
});
