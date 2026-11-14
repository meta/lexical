/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The mutation observer's own callback, in a real browser: a DOM change
// recorded before an update made with skipTransforms is reported before the
// commit that update queues, and its revert joins the pending state. It runs
// no transforms over what that update changed; without skipTransforms it
// runs them.

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  ParagraphNode,
  TextNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

function settle(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mount() {
  const editor = createEditor({
    namespace: 'skip-transforms-mutation-revert',
    nodes: [ParagraphNode, TextNode],
    onError: e => {
      throw e;
    },
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  const seen: string[] = [];
  const unregister = editor.registerNodeTransform(TextNode, node => {
    seen.push(node.getTextContent());
  });
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createTextNode('start')));
    },
    {discrete: true},
  );
  seen.length = 0;
  onTestFinished(() => {
    unregister();
    editor.setRootElement(null);
    root.remove();
  });
  return {editor, root, seen};
}

describe("the mutation observer's revert, before a queued commit", () => {
  test.each([true, false])(
    'runs transforms only when the update did not skip them (skipTransforms: %s)',
    async skipTransforms => {
      const {editor, root, seen} = mount();
      const stray = document.createElement('span');
      stray.className = 'stray';
      root.appendChild(stray);
      editor.update(
        () =>
          ($getRoot().getFirstDescendant() as TextNode).setTextContent('next'),
        skipTransforms ? {skipTransforms} : {},
      );
      await settle();
      expect(root.querySelector('.stray')).toBe(null);
      expect(editor.read(() => $getRoot().getTextContent())).toBe('next');
      if (skipTransforms) {
        expect(seen).toEqual([]);
      } else {
        expect(seen).toContain('next');
      }
    },
  );
});
