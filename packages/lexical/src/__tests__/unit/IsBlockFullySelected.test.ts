/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $caretRangeFromSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isBlockFullySelected,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  type ElementNode,
  type RangeSelection,
  type TextNode,
} from 'lexical';
import {
  $createTestDecoratorNode,
  initializeUnitTest,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, it} from 'vitest';

function $getBlock(index: number): ElementNode {
  const node = $getRoot().getChildAtIndex(index);
  assert($isElementNode(node), `block ${index} must be an ElementNode`);
  return node;
}

function $getBlockText(index: number): TextNode {
  const text = $getBlock(index).getFirstDescendant();
  assert($isTextNode(text), `block ${index} must contain a TextNode`);
  return text;
}

function $currentSelection(): RangeSelection {
  const selection = $getSelection();
  assert($isRangeSelection(selection), 'expecting a RangeSelection');
  return selection;
}

describe('$isBlockFullySelected', () => {
  initializeUnitTest(
    testEnv => {
      it('reports whether the selection covers the block', () => {
        testEnv.editor.update(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('first')),
              $createParagraphNode().append($createTextNode('second')),
            );
            const block = $getBlock(1);
            block.select(0, block.getChildrenSize());
            const selection = $currentSelection();
            expect($isBlockFullySelected(block, selection)).toBe(true);
            expect($isBlockFullySelected($getRoot(), selection)).toBe(false);
            expect($isBlockFullySelected($getBlock(0), selection)).toBe(false);

            $getBlockText(1).select(1, 3);
            expect($isBlockFullySelected(block, $currentSelection())).toBe(
              false,
            );
          },
          {discrete: true},
        );
      });

      it('accepts a CaretRange and backward selections', () => {
        testEnv.editor.update(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('first')),
            );
            // backward selection over all of the text
            $getBlockText(0).select('first'.length, 0);
            const selection = $currentSelection();
            expect($isBlockFullySelected($getBlock(0), selection)).toBe(true);
            expect(
              $isBlockFullySelected(
                $getBlock(0),
                $caretRangeFromSelection(selection),
              ),
            ).toBe(true);
          },
          {discrete: true},
        );
      });

      it('a selection that extends beyond the block still fully selects it', () => {
        testEnv.editor.update(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('first')),
              $createParagraphNode().append($createTextNode('second')),
            );
            // whole document, text points
            const selection = $getBlockText(0).select(0, 0);
            selection.focus.set(
              $getBlockText(1).getKey(),
              'second'.length,
              'text',
            );
            expect($isBlockFullySelected($getRoot(), selection)).toBe(true);
            expect($isBlockFullySelected($getBlock(0), selection)).toBe(true);
            expect($isBlockFullySelected($getBlock(1), selection)).toBe(true);

            // mid-first to mid-second covers neither block fully
            const partial = $getBlockText(0).select(2, 2);
            partial.focus.set($getBlockText(1).getKey(), 2, 'text');
            expect($isBlockFullySelected($getBlock(0), partial)).toBe(false);
            expect($isBlockFullySelected($getBlock(1), partial)).toBe(false);
          },
          {discrete: true},
        );
      });

      it('handles element points on an ancestor', () => {
        testEnv.editor.update(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('first')),
              $createParagraphNode().append($createTextNode('second')),
            );
            // element points on the root covering only the first block
            const selection = $getRoot().select(0, 1);
            expect($isBlockFullySelected($getBlock(0), selection)).toBe(true);
            expect($isBlockFullySelected($getBlock(1), selection)).toBe(false);
            expect($isBlockFullySelected($getRoot(), selection)).toBe(false);
          },
          {discrete: true},
        );
      });

      it('handles blocks that end with a decorator', () => {
        testEnv.editor.update(
          () => {
            const block = $createParagraphNode().append(
              $createTextNode('text'),
              $createTestDecoratorNode(),
            );
            $getRoot().append(block);
            // element points on the block around all of its children
            const selection = block.select(0, block.getChildrenSize());
            expect($isBlockFullySelected(block, selection)).toBe(true);

            // stopping before the trailing decorator is not a full selection
            const partial = block.select(0, block.getChildrenSize() - 1);
            expect($isBlockFullySelected(block, partial)).toBe(false);
          },
          {discrete: true},
        );
      });

      it('an empty block is fully selected by its caret', () => {
        testEnv.editor.update(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode('first')),
              $createParagraphNode(),
            );
            const emptyBlock = $getBlock(1);
            emptyBlock.select(0, 0);
            expect($isBlockFullySelected(emptyBlock, $currentSelection())).toBe(
              true,
            );

            // a selection in another block does not select the empty block
            $getBlockText(0).select(0, 'first'.length);
            expect($isBlockFullySelected(emptyBlock, $currentSelection())).toBe(
              false,
            );
          },
          {discrete: true},
        );
      });

      it('a fully selected block fully selects its ancestor block', () => {
        testEnv.editor.update(
          () => {
            const text = $createTextNode('quoted');
            const inner = $createParagraphNode().append(text);
            const quote = $createParagraphNode().append(inner);
            $getRoot().append(quote);
            text.select(0, 'quoted'.length);
            const selection = $currentSelection();
            expect($isBlockFullySelected(inner, selection)).toBe(true);
            // the selection covers all of the ancestor's content as well
            expect($isBlockFullySelected(quote, selection)).toBe(true);

            text.select(1, 'quoted'.length);
            const partial = $currentSelection();
            expect($isBlockFullySelected(inner, partial)).toBe(false);
            expect($isBlockFullySelected(quote, partial)).toBe(false);
          },
          {discrete: true},
        );
      });
    },
    {
      namespace: 'test',
      nodes: [TestDecoratorNode],
      theme: {},
    },
  );
});
