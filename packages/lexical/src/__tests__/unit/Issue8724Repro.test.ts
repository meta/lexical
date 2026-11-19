/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListExtension,
} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isDecoratorNode,
  $isElementNode,
  $isRangeSelection,
  $isRootNode,
  type LexicalNode,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {
  $assertNodeType,
  $createTestDecoratorNode,
  $createTestElementNode,
  $createTestShadowRootNode,
  $isTestShadowRootNode,
  TestDecoratorNode,
  TestElementNode,
  TestShadowRootNode,
} from '../utils';

const ext = defineExtension({
  dependencies: [RichTextExtension],
  name: '[8724]',
  nodes: [TestDecoratorNode, TestElementNode, TestShadowRootNode],
});

const listExt = defineExtension({
  dependencies: [RichTextExtension, ListExtension],
  name: '[8724-list]',
  nodes: [TestDecoratorNode],
});

// A block DecoratorNode must never become the direct child of a ListItemNode.
function $assertNoBlockInsideListItem(node: LexicalNode): void {
  if ($isListItemNode(node)) {
    for (const child of node.getChildren()) {
      expect(
        ($isElementNode(child) || $isDecoratorNode(child)) && !child.isInline(),
        `ListItemNode should not directly hold non-inline ${child.getType()}`,
      ).toBe($isListNode(child));
    }
  }
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      $assertNoBlockInsideListItem(child);
    }
  }
}

describe('Paste normalization of non-inline nodes (#8713, #8724)', () => {
  // A non-inline ElementNode may only contain inline children (#8724). When a
  // block cursor sits on such an element that, in a malformed document, holds
  // a block-level child directly, pasting another block node used to throw
  // (#8713). It must instead split up to the nearest root/shadow root so the
  // pasted block never becomes the child of an inline-only element.
  test('block node at a block cursor inside an inline-only element splits up to the shadow root', () => {
    using editor = buildEditorFromExtensions(ext);
    let insertedKey = '';
    editor.update(
      () => {
        const shadow = $createTestShadowRootNode();
        const element = $createTestElementNode();
        // A pre-existing (malformed) block child so the block cursor lands on
        // an element point with no block ancestor.
        element.append($createTestDecoratorNode().setIsInline(false));
        shadow.append(element);
        $getRoot().clear().append(shadow);
        element.select(1, 1);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        const inserted = $createTestDecoratorNode().setIsInline(false);
        insertedKey = inserted.getKey();
        // Must not throw (#8713).
        selection.insertNodes([inserted]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const inserted = $getNodeByKey(insertedKey);
      assert(inserted !== null, 'Expected the inserted node to exist');
      // The pasted block landed in the nearest valid container (the shadow
      // root), not nested inside the inline-only element.
      expect($isTestShadowRootNode(inserted.getParent())).toBe(true);
    });
  });

  test('block node at a block cursor inside an inline-only element splits up to the root', () => {
    using editor = buildEditorFromExtensions(ext);
    let insertedKey = '';
    editor.update(
      () => {
        const element = $createTestElementNode();
        element.append($createTestDecoratorNode().setIsInline(false));
        $getRoot().clear().append(element);
        element.select(1, 1);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        const inserted = $createTestDecoratorNode().setIsInline(false);
        insertedKey = inserted.getKey();
        selection.insertNodes([inserted]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const inserted = $getNodeByKey(insertedKey);
      assert(inserted !== null, 'Expected the inserted node to exist');
      // The pasted block landed directly in the root.
      expect($isRootNode(inserted.getParent())).toBe(true);
    });
  });

  test('still inserts a block node directly at a block cursor on a shadow root (#8708)', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const shadow = $createTestShadowRootNode();
        shadow.append($createTestDecoratorNode().setIsInline(false));
        $getRoot().clear().append(shadow);
        shadow.select(1, 1);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.insertNodes([$createTestDecoratorNode().setIsInline(false)]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const shadow = $assertNodeType(
        $getRoot().getFirstChild(),
        $isTestShadowRootNode,
      );
      // Both block decorators are direct children of the shadow root.
      expect(shadow.getChildrenSize()).toBe(2);
    });
  });
});

describe('Paste normalization does not regress lists (#8724)', () => {
  test('block node pasted in a list item text splits the list (unchanged CASE 3)', () => {
    using editor = buildEditorFromExtensions(listExt);
    let insertedKey = '';
    editor.update(
      () => {
        const list = $createListNode('bullet');
        const item = $createListItemNode();
        const text = $createTextNode('hello');
        item.append(text);
        list.append(item);
        $getRoot().clear().append(list);
        text.select(2, 2);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        const inserted = $createTestDecoratorNode().setIsInline(false);
        insertedKey = inserted.getKey();
        selection.insertNodes([inserted]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const inserted = $getNodeByKey(insertedKey);
      assert(inserted !== null, 'Expected the inserted node to exist');
      // The block landed at the root (between the split lists), never inside a
      // ListItemNode.
      expect($isListItemNode(inserted.getParent())).toBe(false);
      $assertNoBlockInsideListItem($getRoot());
    });
  });

  test('block node at an element point on a list item holding a nested list does not crash', () => {
    using editor = buildEditorFromExtensions(listExt);
    let insertedKey = '';
    editor.update(
      () => {
        const list = $createListNode('bullet');
        const firstItem = $createListItemNode();
        firstItem.append($createTextNode('a'));
        const nestingItem = $createListItemNode();
        const nestedList = $createListNode('bullet');
        const nestedItem = $createListItemNode();
        nestedItem.append($createTextNode('b'));
        nestedList.append(nestedItem);
        nestingItem.append(nestedList);
        list.append(firstItem, nestingItem);
        $getRoot().clear().append(list);
        // Element point on the listitem that holds the nested list: this is an
        // INTERNAL_$isBlock=false node with no block ancestor.
        nestingItem.select(0, 0);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        const inserted = $createTestDecoratorNode().setIsInline(false);
        insertedKey = inserted.getKey();
        // The editor throws on error by default, so a crash fails the test.
        selection.insertNodes([inserted]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const inserted = $getNodeByKey(insertedKey);
      assert(inserted !== null, 'Expected the inserted node to exist');
      // The block is not nested inside a ListItemNode, and the surrounding
      // list structure remains valid.
      expect($isListItemNode(inserted.getParent())).toBe(false);
      $assertNoBlockInsideListItem($getRoot());
    });
  });
});

describe('Paste flattens non-inline nodes inside an inline-only element (#8724)', () => {
  // When the target block lives inside a non-inline element that is not a root
  // or shadow root (so it may only contain inline children, e.g. the
  // ParagraphNode inside a CollapsibleTitleNode), a pasted block cannot be
  // placed as its sibling without nesting it in the inline-only element. The
  // paste is flattened to its inline content; a block with no inline form is
  // dropped.
  test('drops a block-only paste with no inline form', () => {
    using editor = buildEditorFromExtensions(ext);
    let insertedKey = '';
    editor.update(
      () => {
        const element = $createTestElementNode();
        const paragraph = $createParagraphNode();
        const text = $createTextNode('abc');
        paragraph.append(text);
        element.append(paragraph);
        $getRoot().clear().append(element);
        text.select(3, 3);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        const inserted = $createTestDecoratorNode().setIsInline(false);
        insertedKey = inserted.getKey();
        // A block DecoratorNode has no inline form, so it is dropped.
        selection.insertNodes([inserted]);
      },
      {discrete: true},
    );

    editor.read(() => {
      // The block decorator was dropped entirely; the document is unchanged.
      expect($getNodeByKey(insertedKey)).toBe(null);
      const element = $assertNodeType(
        $getRoot().getFirstChild(),
        $isElementNode,
      );
      expect(element.getTextContent()).toBe('abc');
    });
  });

  test('keeps the inline content of a block paste', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        const element = $createTestElementNode();
        const paragraph = $createParagraphNode();
        const text = $createTextNode('abc');
        paragraph.append(text);
        element.append(paragraph);
        $getRoot().clear().append(element);
        text.select(3, 3);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        // The paragraph's inline content is kept; the block wrapper is dropped.
        selection.insertNodes([
          $createParagraphNode().append($createTextNode('def')),
        ]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const element = $assertNodeType(
        $getRoot().getFirstChild(),
        $isElementNode,
      );
      expect(element.getTextContent()).toBe('abcdef');
    });
  });
});
