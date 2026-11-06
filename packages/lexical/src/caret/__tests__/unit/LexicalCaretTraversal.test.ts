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
  $createParagraphNode,
  $createTextNode,
  $getChildCaret,
  $getChildCaretAtIndex,
  $getRoot,
  $getSiblingCaret,
} from 'lexical';
import {expect, test} from 'vitest';

import {$getAdjacentNodes} from '../../LexicalCaretUtils';

const indices = [-Infinity, -1, 0, 0.5, 1, 1.5, 2, 4, 5, Infinity, NaN];

test.each(indices)(
  'child caret at %s preserves clamping and direction',
  index => {
    using editor = buildEditorFromExtensions({name: 'caret-index'});
    editor.update(
      () => {
        const children = ['a', 'b', 'c', 'd'].map(text =>
          $createTextNode(text).toggleUnmergeable(),
        );
        const parent = $createParagraphNode().append(...children);
        $getRoot().clear().append(parent);
        const offset = index > 0 ? Math.min(4, Math.ceil(index)) : 0;
        const next = $getChildCaretAtIndex(parent, index, 'next');
        const previous = $getChildCaretAtIndex(parent, index, 'previous');
        expect(next.getNodeAtCaret()).toBe(children[offset] || null);
        expect(previous.getNodeAtCaret()).toBe(children[offset - 1] || null);
        expect(next.getFlipped().isSameNodeCaret(previous)).toBe(true);
        expect(next.getParentAtCaret()).toBe(parent);
        expect(previous.getParentAtCaret()).toBe(parent);
      },
      {discrete: true},
    );
  },
);

test.each(indices)(
  'child caret in an empty element at %s stays at its boundary',
  index => {
    using editor = buildEditorFromExtensions({name: 'caret-empty-index'});
    editor.update(
      () => {
        const parent = $createParagraphNode();
        $getRoot().clear().append(parent);
        for (const direction of ['next', 'previous'] as const) {
          expect(
            $getChildCaretAtIndex(parent, index, direction).isSameNodeCaret(
              $getChildCaret(parent, direction),
            ),
          ).toBe(true);
        }
      },
      {discrete: true},
    );
  },
);

test('node collectors and retained carets follow moved siblings in document order', () => {
  using editor = buildEditorFromExtensions({name: 'caret-collect'});
  editor.update(
    () => {
      const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(text =>
        $createTextNode(text).toggleUnmergeable(),
      );
      const parent = $createParagraphNode().append(a, b, c, d);
      $getRoot().clear().append(parent);
      const start = $getChildCaret(parent, 'next');
      const end = $getChildCaret(parent, 'previous');
      b.insertBefore(d);
      expect(parent.getChildren()).toEqual([a, d, b, c]);
      expect(b.getPreviousSiblings()).toEqual([a, d]);
      expect(d.getNextSiblings()).toEqual([b, c]);
      expect($getAdjacentNodes(start)).toEqual([a, d, b, c]);
      expect($getAdjacentNodes(end)).toEqual([c, b, d, a]);
      expect($getAdjacentNodes($getSiblingCaret(b, 'previous'))).toEqual([
        d,
        a,
      ]);
      b.remove();
      expect(b.getPreviousSiblings()).toEqual([]);
      expect(b.getNextSiblings()).toEqual([]);
    },
    {discrete: true},
  );
});

test('indexed descendants distinguish child starts, document end and empty children', () => {
  using editor = buildEditorFromExtensions({name: 'caret-descendant-index'});
  editor.update(
    () => {
      const a = $createTextNode('a').toggleUnmergeable();
      const b = $createTextNode('b').toggleUnmergeable();
      const empty = $createParagraphNode();
      const root = $getRoot()
        .clear()
        .append($createParagraphNode().append(a, b), empty);
      expect(root.getDescendantByIndex(0)).toBe(a);
      expect(root.getDescendantByIndex(1)).toBe(empty);
      expect(root.getDescendantByIndex(2)).toBe(empty);
      empty.remove();
      expect(root.getDescendantByIndex(1)).toBe(b);
      expect(root.getDescendantByIndex(Infinity)).toBe(b);
      for (const index of [-1, 0.5, NaN])
        expect(root.getDescendantByIndex(index)).toBeNull();
      root.clear();
      expect(root.getDescendantByIndex(0)).toBeNull();
    },
    {discrete: true},
  );
});
