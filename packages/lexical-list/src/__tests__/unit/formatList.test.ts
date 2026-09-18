/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  $insertList,
  $isListItemNode,
  $isListNode,
  ListExtension,
  ListItemNode,
  ListNode,
  type ListType,
  registerList,
} from '@lexical/list';
import {registerRichText} from '@lexical/rich-text';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
} from '@lexical/table';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $nodesOfType,
  $selectAll,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalNode,
} from 'lexical';
import {
  $assertNodeType,
  $createTestDecoratorNode,
  initializeUnitTest,
  invariant,
} from 'lexical/src/__tests__/utils';
import {describe, expect, test} from 'vitest';

import {$handleIndent, $handleOutdent} from '../../formatList';

class ExtendedTestListNode extends ListNode {
  $config() {
    return this.config('extended-test-list', {extends: ListNode});
  }
}

function $createExtendedTestListNode(listType: ListType): ExtendedTestListNode {
  return new ExtendedTestListNode(listType);
}

function $isExtendedTestListNode(node?: LexicalNode | null) {
  return node instanceof ExtendedTestListNode;
}

class ExtendedTestListItemNode extends ListItemNode {
  $config() {
    return this.config('extended-test-list-item', {extends: ListItemNode});
  }
}

function $createExtendedTestListItemNode(): ExtendedTestListItemNode {
  return new ExtendedTestListItemNode();
}

function $isExtendedTestListItemNode(node?: LexicalNode | null) {
  return node instanceof ExtendedTestListItemNode;
}

const initOptions = {
  nodes: [ExtendedTestListNode, ExtendedTestListItemNode],
};

describe('insertList', () => {
  initializeUnitTest(testEnv => {
    test('inserting with empty root selection', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        $getRoot().select();
      });

      await editor.update(() => {
        $insertList('number');
      });

      editor.read(() => {
        const root = $getRoot();

        expect(root.getChildrenSize()).toBe(1);

        const firstChild = root.getFirstChildOrThrow();

        expect($isListNode(firstChild)).toBe(true);
      });
    });

    test('inserting in root selection with existing child', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        $getRoot().select();
        $getRoot().append(
          $createParagraphNode().append($createTextNode('hello')),
        );
      });

      await editor.update(() => {
        $insertList('number');
      });

      editor.read(() => {
        const root = $getRoot();

        expect(root.getChildrenSize()).toBe(1);

        const firstChild = root.getFirstChildOrThrow();

        expect($isListNode(firstChild)).toBe(true);
      });
    });

    test('inserting with empty shadow root selection', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const table = $createTableNode();
        const row = $createTableRowNode();
        const cell = $createTableCellNode();
        $getRoot().append(table.append(row.append(cell)));
        cell.select();
      });

      await editor.update(() => {
        $insertList('number');
      });

      editor.read(() => {
        const table = $assertNodeType($getRoot().getFirstChild(), $isTableNode);
        const row = $assertNodeType(table.getFirstChild(), $isTableRowNode);
        const cell = $assertNodeType(row.getFirstChild(), $isTableCellNode);

        expect(cell.getChildrenSize()).toBe(1);

        const firstChild = cell.getFirstChildOrThrow();

        expect($isListNode(firstChild)).toBe(true);
      });
    });

    test('formatting empty list items', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        $getRoot().append(
          $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('Level 1')),
            $createListItemNode().append(
              $createListNode('bullet').append($createListItemNode()),
            ),
          ),
        );
      });

      await editor.update(() => {
        $selectAll();
        $insertList('number');
      });

      editor.read(() => {
        const lists = $nodesOfType(ListNode).filter(
          node => node.getListType() === 'number',
        );
        expect(lists.length).toBe(2);
      });
    });

    test('preserves element-anchored selection when converting paragraph with linebreak to list', async () => {
      const {editor} = testEnv;

      // Create a paragraph with text followed by a linebreak node and select the paragraph
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const textNode = $createTextNode('Item 1');
        const lineBreak = $createLineBreakNode();

        paragraph.append(textNode, lineBreak);
        $getRoot().append(paragraph);

        paragraph.select();
      });

      // Convert to list
      await editor.update(() => {
        $insertList('bullet');
      });

      // Verify the list was created and selection is correctly preserved
      editor.read(() => {
        const selection = $getSelection();
        const list = $getRoot().getFirstChildOrThrow();

        expect($isListNode(list)).toBe(true);

        if ($isListNode(list)) {
          const listItem = list.getFirstChildOrThrow();
          expect($isListItemNode(listItem)).toBe(true);

          // Verify selection is valid and anchored to the listItem, not the list
          if ($isRangeSelection(selection)) {
            expect(selection.anchor.key).toBe(listItem.getKey());
            expect(selection.focus.key).toBe(listItem.getKey());
            expect(selection.anchor.offset).toBe(2);
            expect(selection.focus.offset).toBe(2);
            expect(selection.anchor.type).toBe('element');
            expect(selection.focus.type).toBe('element');
          }
        }
      });
    });
  });
});

describe('$handleListInsertParagraph', () => {
  initializeUnitTest(testEnv => {
    test('exits list when list item is completely empty', async () => {
      const {editor} = testEnv;
      registerList(editor);

      let emptyListItemKey: string;
      await editor.update(() => {
        const listItemWithContent = $createListItemNode();
        const listItemEmpty = $createListItemNode();
        emptyListItemKey = listItemEmpty.getKey();
        const listNode = $createListNode('bullet');
        listItemWithContent.append($createTextNode('item'));
        listNode.append(listItemWithContent, listItemEmpty);
        $getRoot().append(listNode);
        listItemEmpty.select();
        editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND);
      });

      editor.read(() => {
        const children = $getRoot().getChildren();
        expect(children.length).toBe(2);
        expect($isListNode(children[0])).toBe(true);
        expect($isParagraphNode(children[1])).toBe(true);
        expect((children[0] as ListNode).getChildrenSize()).toBe(1);
        expect($getNodeByKey(emptyListItemKey)).toBeNull();
      });
    });

    test('exits list when list item contains only whitespace', async () => {
      const {editor} = testEnv;
      registerList(editor);

      let whitespaceListItemKey: string;
      await editor.update(() => {
        const listItemWithContent = $createListItemNode();
        const listItemWhitespace = $createListItemNode();
        whitespaceListItemKey = listItemWhitespace.getKey();
        const whitespaceTextNode = $createTextNode(' ');
        const listNode = $createListNode('bullet');
        listItemWithContent.append($createTextNode('item'));
        listItemWhitespace.append(whitespaceTextNode);
        listNode.append(listItemWithContent, listItemWhitespace);
        $getRoot().append(listNode);
        whitespaceTextNode.select();
        editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND);
      });

      editor.read(() => {
        const children = $getRoot().getChildren();
        expect(children.length).toBe(2);
        expect($isListNode(children[0])).toBe(true);
        expect($isParagraphNode(children[1])).toBe(true);
        expect((children[0] as ListNode).getChildrenSize()).toBe(1);
        expect($getNodeByKey(whitespaceListItemKey)).toBeNull();
      });
    });

    test('extends list when list item contains non-whitespace content', async () => {
      const {editor} = testEnv;
      registerRichText(editor);
      registerList(editor);

      await editor.update(() => {
        const listItem1 = $createListItemNode();
        listItem1.append($createTextNode('item 1'));
        const listItem2 = $createListItemNode();
        const textNode = $createTextNode('item 2');
        listItem2.append(textNode);
        const listNode = $createListNode('bullet');
        listNode.append(listItem1, listItem2);
        $getRoot().append(listNode);
        textNode.selectEnd();
        editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND);
      });

      editor.read(() => {
        const children = $getRoot().getChildren();
        expect(children.length).toBe(1);
        expect($isListNode(children[0])).toBe(true);
        expect((children[0] as ListNode).getChildrenSize()).toBe(3);
      });
    });

    test('extends list when list item contains a decorator node', async () => {
      const {editor} = testEnv;
      registerRichText(editor);
      registerList(editor);

      await editor.update(() => {
        const listItem1 = $createListItemNode();
        listItem1.append($createTextNode('item 1'));
        const listItem2 = $createListItemNode();
        const decoratorNode = $createTestDecoratorNode();
        listItem2.append(decoratorNode);
        const listNode = $createListNode('bullet');
        listNode.append(listItem1, listItem2);
        $getRoot().append(listNode);
        listItem2.select();
        editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND);
      });

      editor.read(() => {
        const children = $getRoot().getChildren();
        expect(children.length).toBe(1);
        expect($isListNode(children[0])).toBe(true);
        expect((children[0] as ListNode).getChildrenSize()).toBe(3);
      });
    });

    test('splits list when the empty element is not the last one', async () => {
      const {editor} = testEnv;
      registerList(editor);

      let emptyListItemKey: string;
      await editor.update(() => {
        const firstListItemWithContent = $createExtendedTestListItemNode();
        const secondListItemWithContent = $createExtendedTestListItemNode();
        const listItemEmpty = $createExtendedTestListItemNode();
        emptyListItemKey = listItemEmpty.getKey();
        const listNode = $createExtendedTestListNode('bullet');
        firstListItemWithContent.append($createTextNode('item1'));
        secondListItemWithContent.append($createTextNode('item2'));
        listNode.append(
          firstListItemWithContent,
          listItemEmpty,
          secondListItemWithContent,
        );
        $getRoot().append(listNode);
        listItemEmpty.select();
        editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND);
      });

      editor.read(() => {
        const children = $getRoot().getChildren();
        const firstList = children[0] as ExtendedTestListNode;
        const secondList = children[2] as ExtendedTestListNode;

        expect(children.length).toBe(3);
        expect($isListNode(children[0])).toBe(true);
        expect($isParagraphNode(children[1])).toBe(true);
        expect($isListNode(children[2])).toBe(true);
        expect(firstList.getChildrenSize()).toBe(1);
        expect(secondList.getChildrenSize()).toBe(1);
        expect($getNodeByKey(emptyListItemKey)).toBeNull();
        // check that the new list is of the same type
        expect(secondList).toBeInstanceOf(firstList.constructor);
        expect(firstList.getListType()).toBe(secondList.getListType());
      });
    });
  }, initOptions);
});

describe('$handleIndent', () => {
  initializeUnitTest(
    testEnv => {
      test('creates a new nested sublist', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const root = $getRoot();
          const listNode = $createExtendedTestListNode('bullet');
          const listItem1 = $createExtendedTestListItemNode();
          const listItem2 = $createExtendedTestListItemNode();

          listNode.append(listItem1, listItem2);
          root.append(listNode);

          $handleIndent(listItem2);

          // new item keeps the same type
          const newListItem2 =
            listNode.getChildren()[1] as ExtendedTestListItemNode;
          expect($isExtendedTestListItemNode(newListItem2)).toBe(true);
          expect(newListItem2.getChildren().length).toBe(1);

          // nested list contains the original list item
          const nestedList =
            newListItem2.getChildren()[0] as ExtendedTestListNode;
          expect($isExtendedTestListNode(nestedList)).toBe(true);
          expect(nestedList.getChildren().length).toBe(1);
          expect(nestedList.getChildren()[0].is(listItem2)).toBe(true);
        });
      });
    },
    {nodes: [ExtendedTestListNode, ExtendedTestListItemNode]},
  );
});

describe('$handleOutdent', () => {
  initializeUnitTest(testEnv => {
    test('removes the nested list and replaces list item', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const root = $getRoot();
        const listNode = $createExtendedTestListNode('bullet');
        const listItem1 = $createExtendedTestListItemNode();
        const listItem2 = $createExtendedTestListItemNode();
        const indentedListItem = $createExtendedTestListItemNode();

        listNode.append(
          listItem1,
          listItem2.append(
            $createExtendedTestListNode('bullet').append(indentedListItem),
          ),
        );
        root.append(listNode);

        $handleOutdent(indentedListItem);

        const children = listNode.getChildren();
        // item is outdented and doesn't have nested list
        expect(children.length).toBe(2);
        expect(children[1].is(indentedListItem)).toBe(true);
        expect(indentedListItem.getChildren().length).toBe(0);
      });
    });
  }, initOptions);
});

const collapseTestExtension = defineExtension({
  dependencies: [ListExtension],
  name: '[root]',
});

describe('ListItemNode.collapseAtStart', () => {
  test('top-level single item converts to paragraph', () => {
    using editor = buildEditorFromExtensions(collapseTestExtension);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const listItem = $createListItemNode().append($createTextNode('hello'));
        const listNode = $createListNode('bullet').append(listItem);
        root.append(listNode);
        const selection = listItem.select(0, 0);
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        listItem.collapseAtStart(selection);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(1);
      invariant($isParagraphNode(children[0]), 'Expected ParagraphNode');
      expect(children[0].getTextContent()).toBe('hello');
    });
  });

  test('top-level first item extracts as paragraph, keeps remaining list', () => {
    using editor = buildEditorFromExtensions(collapseTestExtension);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const firstItem = $createListItemNode().append(
          $createTextNode('first'),
        );
        const listNode = $createListNode('bullet').append(
          firstItem,
          $createListItemNode().append($createTextNode('second')),
        );
        root.append(listNode);
        const selection = firstItem.select(0, 0);
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        firstItem.collapseAtStart(selection);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(2);
      invariant($isParagraphNode(children[0]), 'Expected ParagraphNode');
      expect(children[0].getTextContent()).toBe('first');
      invariant($isListNode(children[1]), 'Expected ListNode');
      expect(children[1].getChildrenSize()).toBe(1);
    });
  });

  test('indented item outdents instead of converting to paragraph', () => {
    using editor = buildEditorFromExtensions(collapseTestExtension);

    let indentedItemKey: string;
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const indentedItem = $createListItemNode().append(
          $createTextNode('child'),
        );
        indentedItemKey = indentedItem.getKey();
        const nestedWrapper = $createListItemNode().append(
          $createListNode('bullet').append(indentedItem),
        );
        const listNode = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('parent')),
          nestedWrapper,
        );
        root.append(listNode);
        const selection = indentedItem.select(0, 0);
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        indentedItem.collapseAtStart(selection);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(1);
      invariant($isListNode(children[0]), 'Expected ListNode');
      expect(children[0].getChildrenSize()).toBe(2);
      const outdentedItem = $getNodeByKey(indentedItemKey);
      invariant($isListItemNode(outdentedItem), 'Expected ListItemNode');
      expect(outdentedItem.getTextContent()).toBe('child');
    });
  });

  test('indented item with siblings outdents without breaking list', () => {
    using editor = buildEditorFromExtensions(collapseTestExtension);

    let firstIndentedKey: string;
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const indentedItem1 = $createListItemNode().append(
          $createTextNode('child1'),
        );
        firstIndentedKey = indentedItem1.getKey();
        const nestedWrapper = $createListItemNode().append(
          $createListNode('bullet').append(
            indentedItem1,
            $createListItemNode().append($createTextNode('child2')),
          ),
        );
        const listNode = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('parent')),
          nestedWrapper,
        );
        root.append(listNode);
        const selection = indentedItem1.select(0, 0);
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        indentedItem1.collapseAtStart(selection);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(1);
      invariant($isListNode(children[0]), 'Expected ListNode');
      const outdentedItem = $getNodeByKey(firstIndentedKey);
      invariant($isListItemNode(outdentedItem), 'Expected ListItemNode');
      expect(outdentedItem.getTextContent()).toBe('child1');
      expect(
        children[0]
          .getChildren()
          .some(
            item =>
              $isListItemNode(item) && item.getTextContent().includes('child2'),
          ),
      ).toBe(true);
    });
  });

  test('middle item converts to paragraph and splits list', () => {
    using editor = buildEditorFromExtensions(collapseTestExtension);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const item2 = $createListItemNode().append($createTextNode('second'));
        const listNode = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('first')),
          item2,
          $createListItemNode().append($createTextNode('third')),
        );
        root.append(listNode);
        const selection = item2.select(0, 0);
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        item2.collapseAtStart(selection);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(3);
      invariant($isListNode(children[0]), 'Expected first ListNode');
      expect(children[0].getChildrenSize()).toBe(1);
      expect(children[0].getTextContent()).toBe('first');
      invariant($isParagraphNode(children[1]), 'Expected ParagraphNode');
      expect(children[1].getTextContent()).toBe('second');
      invariant($isListNode(children[2]), 'Expected second ListNode');
      expect(children[2].getChildrenSize()).toBe(1);
      expect(children[2].getTextContent()).toBe('third');
    });
  });

  test('split preserves list type', () => {
    using editor = buildEditorFromExtensions(collapseTestExtension);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const item2 = $createListItemNode().append($createTextNode('second'));
        const listNode = $createListNode('number').append(
          $createListItemNode().append($createTextNode('first')),
          item2,
          $createListItemNode().append($createTextNode('third')),
        );
        root.append(listNode);
        const selection = item2.select(0, 0);
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        item2.collapseAtStart(selection);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(3);
      invariant($isListNode(children[0]), 'Expected first ListNode');
      expect(children[0].getListType()).toBe('number');
      invariant($isListNode(children[2]), 'Expected second ListNode');
      expect(children[2].getListType()).toBe('number');
    });
  });

  test('last item converts to paragraph without splitting', () => {
    using editor = buildEditorFromExtensions(collapseTestExtension);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const item2 = $createListItemNode().append($createTextNode('second'));
        const listNode = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('first')),
          item2,
        );
        root.append(listNode);
        const selection = item2.select(0, 0);
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        item2.collapseAtStart(selection);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(2);
      invariant($isListNode(children[0]), 'Expected ListNode');
      expect(children[0].getChildrenSize()).toBe(1);
      expect(children[0].getTextContent()).toBe('first');
      invariant($isParagraphNode(children[1]), 'Expected ParagraphNode');
      expect(children[1].getTextContent()).toBe('second');
    });
  });

  test('empty middle item converts to empty paragraph and splits list', () => {
    using editor = buildEditorFromExtensions(collapseTestExtension);

    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const emptyItem = $createListItemNode();
        const listNode = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('first')),
          emptyItem,
          $createListItemNode().append($createTextNode('third')),
        );
        root.append(listNode);
        const selection = emptyItem.select(0, 0);
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        emptyItem.collapseAtStart(selection);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(3);
      invariant($isListNode(children[0]), 'Expected ListNode');
      expect(children[0].getChildrenSize()).toBe(1);
      expect(children[0].getFirstChildOrThrow().getTextContent()).toBe('first');
      invariant($isParagraphNode(children[1]), 'Expected ParagraphNode');
      expect(children[1].getTextContent()).toBe('');
      invariant($isListNode(children[2]), 'Expected ListNode');
      expect(children[2].getChildrenSize()).toBe(1);
      expect(children[2].getFirstChildOrThrow().getTextContent()).toBe('third');

      const selection = $getSelection();
      invariant($isRangeSelection(selection), 'Expected RangeSelection');
      expect(selection.isCollapsed()).toBe(true);
    });
  });

  test('empty indented item outdents', () => {
    using editor = buildEditorFromExtensions(collapseTestExtension);

    let emptyItemKey: string;
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const emptyItem = $createListItemNode();
        emptyItemKey = emptyItem.getKey();
        const nestedWrapper = $createListItemNode().append(
          $createListNode('bullet').append(emptyItem),
        );
        const listNode = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('parent')),
          nestedWrapper,
        );
        root.append(listNode);
        const selection = emptyItem.select(0, 0);
        invariant($isRangeSelection(selection), 'Expected RangeSelection');
        emptyItem.collapseAtStart(selection);
      },
      {discrete: true},
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(1);
      invariant($isListNode(children[0]), 'Expected ListNode');
      const outdentedItem = $getNodeByKey(emptyItemKey);
      invariant($isListItemNode(outdentedItem), 'Expected ListItemNode');
      expect(outdentedItem.getIndent()).toBe(0);
    });
  });
});

describe('mergeNextSiblingListIfSameType', () => {
  initializeUnitTest(testEnv => {
    test('does not merge nested sublists of a different listType', async () => {
      const {editor} = testEnv;

      await editor.update(
        () => {
          const $nested = (listType: ListType, text: string) =>
            $createListItemNode().append(
              $createListNode(listType).append(
                $createListItemNode().append($createTextNode(text)),
              ),
            );
          const list1 = $createListNode('bullet').append(
            $createListItemNode().append($createTextNode('a')),
            $nested('number', 'one'),
          );
          const list2 = $createListNode('bullet').append(
            $nested('bullet', 'two'),
            $createListItemNode().append($createTextNode('b')),
          );
          $getRoot().clear().append(list1, list2);
        },
        {discrete: true},
      );

      editor.read(() => {
        const [list] = $getRoot().getChildren();
        invariant($isListNode(list), 'Expected ListNode');
        // The two bullet lists merge, but their sublists stay separate.
        const sublistTypes = list
          .getChildren()
          .map(child => ($isListItemNode(child) ? child.getFirstChild() : null))
          .filter($isListNode)
          .map(sublist => sublist.getListType());
        expect(sublistTypes).toEqual(['number', 'bullet']);
      });
    });
  });
});
