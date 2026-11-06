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
  $create,
  $createParagraphNode,
  $getRoot,
  type ElementNode,
  TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

function expectLinkedChildren(parent: ElementNode) {
  const children = parent.getChildren();
  expect(children.length).toBe(parent.getChildrenSize());
  for (let i = 0; i < children.length; i++) {
    expect(children[i].getPreviousSibling()?.getKey()).toBe(
      children[i - 1]?.getKey(),
    );
    expect(children[i].getNextSibling()?.getKey()).toBe(
      children[i + 1]?.getKey(),
    );
    expect(children[i].getParent()?.getKey()).toBe(parent.getKey());
  }
}

class ObservedTextNode extends TextNode {
  $config() {
    return this.config('observed-text', {extends: TextNode});
  }
  afterCloneFrom(previous: this) {
    super.afterCloneFrom(previous);
    const parent = previous.getParent();
    if (parent !== null) expectLinkedChildren(parent);
  }
}

test('bulk removal preserves clone-hook traversal, detached links, and snapshots', () => {
  using editor = buildEditorFromExtensions({
    name: 'bulk-splice',
    nodes: [ObservedTextNode],
  });
  let parent: ElementNode;
  let nodes: TextNode[];
  editor.update(
    () => {
      nodes = Array.from('abcde', text =>
        $create(ObservedTextNode).setTextContent(text).toggleUnmergeable(),
      );
      parent = $createParagraphNode().append(...nodes);
      $getRoot().clear().append(parent);
    },
    {discrete: true},
  );
  const snapshot = editor.getEditorState();
  editor.update(
    () => {
      parent.splice(1, 3, []);
      expectLinkedChildren(parent);
      expect(parent.getTextContent()).toBe('ae');
      for (const node of nodes.slice(1, 4)) {
        expect(node.getParent()).toBeNull();
        expect(node.getPreviousSibling()).toBeNull();
        expect(node.getNextSibling()).toBeNull();
      }
      parent.splice(1, 0, nodes.slice(1, 4));
      expectLinkedChildren(parent);
    },
    {discrete: true},
  );
  snapshot.read(() => {
    expectLinkedChildren(parent);
    expect($getRoot().getTextContent()).toBe('abcde');
  });
  editor.read(() => expect(parent.getTextContent()).toBe('abcde'));
});
