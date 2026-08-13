/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$createLinkNode, LinkExtension} from '@lexical/link';
import {$isAtEdgeOfElement} from '@lexical/selection';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSlot,
  type LexicalNode,
  type Point,
} from 'lexical';
import {
  $createTestShadowRootNode,
  TestShadowRootNode,
} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

function $pointAt(
  node: LexicalNode,
  offset: number,
  type: 'text' | 'element',
): Point {
  const selection = $createRangeSelection();
  selection.anchor.set(node.getKey(), offset, type);
  return selection.anchor;
}

function runInEditor(
  fn: () => void,
  spec: Parameters<typeof buildEditorFromExtensions>[0] = {
    name: '@isAtEdgeOfElement-test',
  },
): void {
  using editor = buildEditorFromExtensions(spec);
  editor.update(fn, {discrete: true});
}

describe('$isAtEdgeOfElement', () => {
  test('text point at the start/end of a block', async () => {
    runInEditor(() => {
      const block = $createParagraphNode();
      const text = $createTextNode('hello');
      $getRoot().append(block.append(text));

      // Start of the block.
      expect(
        $isAtEdgeOfElement($pointAt(text, 0, 'text'), block, 'previous'),
      ).toBe(true);
      expect($isAtEdgeOfElement($pointAt(text, 0, 'text'), block, 'next')).toBe(
        false,
      );
      // End of the block.
      expect($isAtEdgeOfElement($pointAt(text, 5, 'text'), block, 'next')).toBe(
        true,
      );
      expect(
        $isAtEdgeOfElement($pointAt(text, 5, 'text'), block, 'previous'),
      ).toBe(false);
      // Middle of the text is at neither edge.
      expect(
        $isAtEdgeOfElement($pointAt(text, 2, 'text'), block, 'previous'),
      ).toBe(false);
      expect($isAtEdgeOfElement($pointAt(text, 2, 'text'), block, 'next')).toBe(
        false,
      );
    });
  });

  test('a sibling between the point and the edge disqualifies it', async () => {
    runInEditor(() => {
      const block = $createParagraphNode();
      const a = $createTextNode('a');
      const b = $createTextNode('b');
      $getRoot().append(block.append(a, b));

      // offset 0 of b is not the start (a precedes it).
      expect(
        $isAtEdgeOfElement($pointAt(b, 0, 'text'), block, 'previous'),
      ).toBe(false);
      // end of b is the end of the block.
      expect($isAtEdgeOfElement($pointAt(b, 1, 'text'), block, 'next')).toBe(
        true,
      );
      // end of a is not the end (b follows it).
      expect($isAtEdgeOfElement($pointAt(a, 1, 'text'), block, 'next')).toBe(
        false,
      );
      // start of a is the start of the block.
      expect(
        $isAtEdgeOfElement($pointAt(a, 0, 'text'), block, 'previous'),
      ).toBe(true);
    });
  });

  test('descends through nested inline elements', async () => {
    runInEditor(
      () => {
        const block = $createParagraphNode();
        const link = $createLinkNode('https://lexical.dev');
        const text = $createTextNode('link');
        $getRoot().append(block.append(link.append(text)));

        // The point is at the edge of both the inline link and the block.
        expect(
          $isAtEdgeOfElement($pointAt(text, 0, 'text'), block, 'previous'),
        ).toBe(true);
        expect(
          $isAtEdgeOfElement($pointAt(text, 0, 'text'), link, 'previous'),
        ).toBe(true);
        expect(
          $isAtEdgeOfElement($pointAt(text, 4, 'text'), block, 'next'),
        ).toBe(true);
        expect(
          $isAtEdgeOfElement($pointAt(text, 4, 'text'), link, 'next'),
        ).toBe(true);
      },
      {dependencies: [LinkExtension], name: '@isAtEdgeOfElement-test'},
    );
  });

  test('an empty element is at both of its edges', async () => {
    runInEditor(() => {
      const block = $createParagraphNode();
      $getRoot().append(block);

      // This is the geometric answer that backs $isAtStartOfNode /
      // $isAtEndOfNode; the block-aware $setBlocksType path layers an empty
      // guard on top of it.
      expect(
        $isAtEdgeOfElement($pointAt(block, 0, 'element'), block, 'previous'),
      ).toBe(true);
      expect(
        $isAtEdgeOfElement($pointAt(block, 0, 'element'), block, 'next'),
      ).toBe(true);
    });
  });

  test('element points at the leading/trailing child edge', async () => {
    runInEditor(() => {
      const block = $createParagraphNode();
      const a = $createTextNode('a');
      const b = $createTextNode('b');
      $getRoot().append(block.append(a, b));

      // Before the first child / after the last child.
      expect(
        $isAtEdgeOfElement($pointAt(block, 0, 'element'), block, 'previous'),
      ).toBe(true);
      expect(
        $isAtEdgeOfElement($pointAt(block, 2, 'element'), block, 'next'),
      ).toBe(true);
      // Between the two children is at neither edge.
      expect(
        $isAtEdgeOfElement($pointAt(block, 1, 'element'), block, 'previous'),
      ).toBe(false);
      expect(
        $isAtEdgeOfElement($pointAt(block, 1, 'element'), block, 'next'),
      ).toBe(false);
    });
  });

  test('a point outside the element is never at its edge', async () => {
    runInEditor(() => {
      const block1 = $createParagraphNode();
      const block2 = $createParagraphNode();
      const text1 = $createTextNode('one');
      const text2 = $createTextNode('two');
      $getRoot().append(block1.append(text1), block2.append(text2));

      expect(
        $isAtEdgeOfElement($pointAt(text1, 0, 'text'), block2, 'previous'),
      ).toBe(false);
      expect(
        $isAtEdgeOfElement($pointAt(text1, 3, 'text'), block2, 'next'),
      ).toBe(false);
    });
  });

  // Regression: a named slot value's up-link is __slotHost, not __parent, so a
  // CaretRange walk (which ascends via getParentCaret) stops at the slot
  // boundary and never reaches the slot value. The edge test must still resolve
  // a point inside the slot against the slot element — this backs the
  // slot-host backspace / arrow-escape behavior in @lexical/utils.
  test('resolves against a named slot value (slot boundary)', async () => {
    runInEditor(
      () => {
        const host = $createParagraphNode();
        const slot = $createTestShadowRootNode();
        const slotPara = $createParagraphNode();
        const slotText = $createTextNode('slotted');
        slotPara.append(slotText);
        slot.append(slotPara);
        host.append($createTextNode('body'));
        $getRoot().append(host);
        $setSlot(host, 'title', slot);

        // Start / end of the slot's content, against the slot value itself.
        expect(
          $isAtEdgeOfElement($pointAt(slotText, 0, 'text'), slot, 'previous'),
        ).toBe(true);
        expect(
          $isAtEdgeOfElement($pointAt(slotText, 7, 'text'), slot, 'next'),
        ).toBe(true);
        // Not at the opposite edges.
        expect(
          $isAtEdgeOfElement($pointAt(slotText, 0, 'text'), slot, 'next'),
        ).toBe(false);
        expect(
          $isAtEdgeOfElement($pointAt(slotText, 7, 'text'), slot, 'previous'),
        ).toBe(false);
        // Mid-text is at neither edge.
        expect(
          $isAtEdgeOfElement($pointAt(slotText, 3, 'text'), slot, 'previous'),
        ).toBe(false);
        expect(
          $isAtEdgeOfElement($pointAt(slotText, 3, 'text'), slot, 'next'),
        ).toBe(false);
      },
      {name: '@isAtEdgeOfElement-test', nodes: [TestShadowRootNode]},
    );
  });
});
