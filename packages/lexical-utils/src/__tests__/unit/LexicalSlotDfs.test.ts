/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {$dfsWithSlots, $reverseDfsWithSlots} from '@lexical/utils';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSlot,
  $getSlotNames,
  $isElementNode,
  $setSlot,
  type LexicalNode,
  type NodeKey,
} from 'lexical';
import {
  $createTestDecoratorNode,
  $createTestShadowRootNode,
  TestDecoratorNode,
  TestShadowRootNode,
} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

// Slots-first preorder traversal: the shape a slot-aware $dfs must produce.
function* $slotAwareDfs(
  depth: number,
  node: LexicalNode,
): Iterable<{depth: number; key: NodeKey}> {
  yield {depth, key: node.getKey()};
  if ($isElementNode(node)) {
    const childDepth = depth + 1;
    for (const name of $getSlotNames(node)) {
      const slot = $getSlot(node, name);
      if (slot !== null) {
        yield* $slotAwareDfs(childDepth, slot);
      }
    }
    for (const child of node.getChildren()) {
      yield* $slotAwareDfs(childDepth, child);
    }
  }
}

// Right-to-left mirror: children in reverse, then slots in reverse.
function* $reverseSlotAwareDfs(
  depth: number,
  node: LexicalNode,
): Iterable<{depth: number; key: NodeKey}> {
  yield {depth, key: node.getKey()};
  if ($isElementNode(node)) {
    const childDepth = depth + 1;
    const children = node.getChildren();
    for (let i = children.length - 1; i >= 0; i--) {
      yield* $reverseSlotAwareDfs(childDepth, children[i]);
    }
    const names = $getSlotNames(node);
    for (let i = names.length - 1; i >= 0; i--) {
      const slot = $getSlot(node, names[i]);
      if (slot !== null) {
        yield* $reverseSlotAwareDfs(childDepth, slot);
      }
    }
  }
}

describe('named-slots: $dfs traversal', () => {
  // host -> (slot title: shadow root -> para -> "Title") + (child body -> "Body")
  const keys: Record<string, NodeKey> = {};
  function $buildTree(): void {
    const host = $createParagraphNode();
    const title = $createTestShadowRootNode();
    const titlePara = $createParagraphNode();
    const titleText = $createTextNode('Title');
    titlePara.append(titleText);
    title.append(titlePara);
    const body = $createParagraphNode();
    const bodyText = $createTextNode('Body');
    body.append(bodyText);
    $getRoot().append(host);
    host.append(body);
    $setSlot(host, 'title', title);
    keys.host = host.getKey();
    keys.title = title.getKey();
    keys.titlePara = titlePara.getKey();
    keys.titleText = titleText.getKey();
    keys.body = body.getKey();
    keys.bodyText = bodyText.getKey();
  }

  const slotTreeExtension = defineExtension({
    $initialEditorState: $buildTree,
    name: '[slot-dfs]',
    nodes: [TestShadowRootNode],
  });

  test('$dfsWithSlots visits slot subtrees, slots-first, ahead of children', () => {
    using editor = buildEditorFromExtensions(slotTreeExtension);

    editor.read(() => {
      const host = $getRoot().getFirstChild()!;
      const visited = $dfsWithSlots(host).map(({depth, node}) => ({
        depth,
        key: node.getKey(),
      }));
      // depth is absolute from root: host(1) -> title slot subtree
      // (shadow root 2 -> para 3 -> text 4) -> body child subtree(2,3)
      expect(visited).toEqual([
        {depth: 1, key: keys.host},
        {depth: 2, key: keys.title},
        {depth: 3, key: keys.titlePara},
        {depth: 4, key: keys.titleText},
        {depth: 2, key: keys.body},
        {depth: 3, key: keys.bodyText},
      ]);
    });
  });

  test('$dfsWithSlots slot traversal matches the reference slots-first walk', () => {
    using editor = buildEditorFromExtensions(slotTreeExtension);

    editor.read(() => {
      const host = $getRoot().getFirstChild()!;
      const fromDfs = $dfsWithSlots(host).map(({depth, node}) => ({
        depth,
        key: node.getKey(),
      }));
      // host sits at absolute depth 1 (direct child of root)
      const reference = [...$slotAwareDfs(1, host)];
      expect(fromDfs).toEqual(reference);
    });
  });

  test('$reverseDfsWithSlots visits slots-last, mirroring $dfsWithSlots (#7112 invariant)', () => {
    using editor = buildEditorFromExtensions(slotTreeExtension);

    editor.read(() => {
      const host = $getRoot().getFirstChild()!;
      const visited = $reverseDfsWithSlots(host).map(({depth, node}) => ({
        depth,
        key: node.getKey(),
      }));
      // host(1) -> body child reverse(2,3) -> title slot reverse
      // (shadow root 2 -> para 3 -> text 4)
      expect(visited).toEqual([
        {depth: 1, key: keys.host},
        {depth: 2, key: keys.body},
        {depth: 3, key: keys.bodyText},
        {depth: 2, key: keys.title},
        {depth: 3, key: keys.titlePara},
        {depth: 4, key: keys.titleText},
      ]);
      // matches the reference right-to-left mirror
      expect(visited).toEqual([...$reverseSlotAwareDfs(1, host)]);
    });
  });

  // endNode is an inclusive stop: $dfs never visits the endNode's children,
  // so the slot-aware variants must not splice in its slot subtrees either —
  // in either direction (#7112 mirror invariant under truncation).
  test('endNode slot subtrees are not emitted past the inclusive stop', () => {
    using editor = buildEditorFromExtensions(slotTreeExtension);

    editor.read(() => {
      const root = $getRoot();
      const host = root.getFirstChild()!;
      const truncated = [
        {depth: 0, key: root.getKey()},
        {depth: 1, key: keys.host},
      ];
      expect(
        $dfsWithSlots(root, host).map(({depth, node}) => ({
          depth,
          key: node.getKey(),
        })),
      ).toEqual(truncated);
      expect(
        $reverseDfsWithSlots(root, host).map(({depth, node}) => ({
          depth,
          key: node.getKey(),
        })),
      ).toEqual(truncated);
    });
  });

  test('reconciler text cache includes slot text (RootNode.__cachedText)', () => {
    using editor = buildEditorFromExtensions(slotTreeExtension);

    editor.read(() => {
      const root = $getRoot();
      const host = root.getFirstChild()!;
      // the uncached element walk is slot-aware (slots-first)
      expect(host.getTextContent()).toBe('TitleBody');
      // RootNode.getTextContent() returns the reconciler-built cache,
      // which now folds slot text in slots-first, matching the walk.
      expect(root.getTextContent()).toBe('TitleBody');
    });
  });
});

describe('named-slots: $dfs traversal into a decorator host', () => {
  // A DecoratorNode can host slots too, but the slot-descent gate used to test
  // $isElementNode, so a decorator host's slots were silently skipped by
  // $dfsWithSlots / $reverseDfsWithSlots. Gate on $isSlotHost instead.
  // decorator host -> (slot media: shadow root -> para -> "Eq")
  const keys: Record<string, NodeKey> = {};
  function $buildTree(): void {
    const host = $createTestDecoratorNode().setIsInline(false);
    const media = $createTestShadowRootNode();
    const mediaPara = $createParagraphNode();
    const mediaText = $createTextNode('Eq');
    mediaPara.append(mediaText);
    media.append(mediaPara);
    $getRoot().append(host);
    $setSlot(host, 'media', media);
    keys.host = host.getKey();
    keys.media = media.getKey();
    keys.mediaPara = mediaPara.getKey();
    keys.mediaText = mediaText.getKey();
  }

  const decoratorSlotExtension = defineExtension({
    $initialEditorState: $buildTree,
    name: '[slot-dfs-decorator]',
    nodes: [TestShadowRootNode, TestDecoratorNode],
  });

  test("$dfsWithSlots descends into a decorator host's slots", () => {
    using editor = buildEditorFromExtensions(decoratorSlotExtension);

    editor.read(() => {
      const host = $getRoot().getFirstChild()!;
      const visited = $dfsWithSlots(host).map(({depth, node}) => ({
        depth,
        key: node.getKey(),
      }));
      // host(1) -> media slot subtree (shadow root 2 -> para 3 -> text 4)
      expect(visited).toEqual([
        {depth: 1, key: keys.host},
        {depth: 2, key: keys.media},
        {depth: 3, key: keys.mediaPara},
        {depth: 4, key: keys.mediaText},
      ]);
    });
  });

  test("$reverseDfsWithSlots descends into a decorator host's slots", () => {
    using editor = buildEditorFromExtensions(decoratorSlotExtension);

    editor.read(() => {
      const host = $getRoot().getFirstChild()!;
      const visited = $reverseDfsWithSlots(host).map(({depth, node}) => ({
        depth,
        key: node.getKey(),
      }));
      expect(visited).toEqual([
        {depth: 1, key: keys.host},
        {depth: 2, key: keys.media},
        {depth: 3, key: keys.mediaPara},
        {depth: 4, key: keys.mediaText},
      ]);
    });
  });
});
