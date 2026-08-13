/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$wrapNodeInElement} from '@lexical/utils';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSlot,
  $getSlotHost,
  $getSlotNames,
  $isParagraphNode,
  $setSlot,
} from 'lexical';
import {
  $createTestShadowRootNode,
  $isTestShadowRootNode,
  TestShadowRootNode,
} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test} from 'vitest';

// Regression for facebook/lexical#8936: $wrapNodeInElement is implemented as
// `node.replace(wrapper); wrapper.append(node)`. replace() must not strip or
// re-home named slots — they are bound to the node — so wrapping a slot host
// preserves its slots.
describe('$wrapNodeInElement and named slots', () => {
  test('wrapping a slot host keeps its slots on the host', () => {
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        const host = $createParagraphNode();
        const slot = $createTestShadowRootNode();
        slot.append($createParagraphNode().append($createTextNode('Title')));
        $getRoot().append(host);
        $setSlot(host, 'title', slot);
      },
      name: '[wrap-slots]',
      nodes: [TestShadowRootNode],
    });

    editor.update(
      () => {
        const host = $getRoot().getFirstChildOrThrow();
        const wrapper = $wrapNodeInElement(host, $createTestShadowRootNode);

        // The wrapped host keeps its slot; the wrapper gains none.
        expect(wrapper.getFirstChild()!.is(host)).toBe(true);
        expect($getSlotNames(wrapper)).toEqual([]);
        expect($getSlot(host, 'title')).not.toBe(null);
      },
      {discrete: true},
    );

    editor.read(() => {
      const wrapper = $getRoot().getFirstChildOrThrow();
      assert($isTestShadowRootNode(wrapper));
      const host = wrapper.getFirstChildOrThrow();
      assert($isParagraphNode(host));
      expect(host.isAttached()).toBe(true);
      const slot = $getSlot(host, 'title');
      expect(slot).not.toBe(null);
      expect(slot!.getTextContent()).toBe('Title');
      expect($getSlotHost(slot!)!.is(host)).toBe(true);
    });
  });
});
