/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ListType} from './LexicalListNode';

import invariant from '@lexical/internal/invariant';
import {$getNearestNodeOfType} from '@lexical/utils';
import {
  $copyNode,
  $createParagraphNode,
  $getChildCaret,
  $getSelection,
  $getSlotHost,
  $isElementNode,
  $isLeafNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $isTextNode,
  $normalizeCaret,
  $setPointFromCaret,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
  type ParagraphNode,
} from 'lexical';

import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  type ListNode,
} from './';
import {
  $getAllListItems,
  $getNewListStart,
  $getTopListNode,
  $isNestedListNode,
  $removeHighestEmptyListParent,
} from './utils';

function $isSelectingEmptyListItem(
  anchorNode: ListItemNode | LexicalNode,
  nodes: LexicalNode[],
): boolean {
  return (
    $isListItemNode(anchorNode) &&
    (nodes.length === 0 ||
      (nodes.length === 1 &&
        anchorNode.is(nodes[0]) &&
        anchorNode.getChildrenSize() === 0))
  );
}

/**
 * Inserts a new ListNode. If the selection's anchor node is an empty ListItemNode and is a child of
 * the root/shadow root, it will replace the ListItemNode with a ListNode and the old ListItemNode.
 * Otherwise it will replace its parent with a new ListNode and re-insert the ListItemNode and any previous children.
 * If the selection's anchor node is not an empty ListItemNode, it will add a new ListNode or merge an existing ListNode,
 * unless the node is a leaf node, in which case it will attempt to find a ListNode up the branch and replace it with
 * a new ListNode, or create a new ListNode at the nearest root/shadow root.
 * @param listType - The type of list, "number" | "bullet" | "check".
 */
export function $insertList(listType: ListType): void {
  const selection = $getSelection();

  if (selection !== null) {
    let nodes = selection.getNodes();
    if ($isRangeSelection(selection)) {
      const [anchor] = selection.getStartEndPoints();
      const anchorNode = anchor.getNode();
      const anchorNodeParent = anchorNode.getParent();

      if ($isRootOrShadowRoot(anchorNode)) {
        const firstChild = anchorNode.getFirstChild();
        if (firstChild) {
          nodes = firstChild.selectStart().getNodes();
        } else {
          const paragraph = $createParagraphNode();
          anchorNode.append(paragraph);
          nodes = paragraph.select().getNodes();
        }
      } else if ($isSelectingEmptyListItem(anchorNode, nodes)) {
        const list = $createListNode(listType);

        if ($isRootOrShadowRoot(anchorNodeParent)) {
          anchorNode.replace(list);
          const listItem = $createListItemNode();
          if ($isElementNode(anchorNode)) {
            listItem.setFormat(anchorNode.getFormatType());
            listItem.setIndent(anchorNode.getIndent());
          }
          list.append(listItem);
        } else if ($isListItemNode(anchorNode)) {
          const parent = anchorNode.getParentOrThrow();
          // A named-slot value has no __parent (its up-link is __slotHost);
          // its slot assignment is managed by the node or extension that
          // owns the slot, so converting it is a no-op rather than a
          // replace (which would throw).
          if ($getSlotHost(parent) === null) {
            append(list, parent.getChildren());
            parent.replace(list);
          }
        }

        return;
      }
    }

    const handled = new Set();
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];

      if (
        $isElementNode(node) &&
        node.isEmpty() &&
        !$isListItemNode(node) &&
        // A named-slot value's slot assignment is managed by the node or
        // extension that owns the slot, so it is not eligible for list
        // conversion (see $setBlocksType).
        $getSlotHost(node) === null &&
        !handled.has(node.getKey())
      ) {
        $createListOrMerge(node, listType);
        continue;
      }

      let parent = $isLeafNode(node)
        ? node.getParent()
        : $isListItemNode(node) && node.isEmpty()
          ? node
          : null;

      while (parent != null) {
        const parentKey = parent.getKey();

        if ($isListNode(parent)) {
          // A list occupying a named slot is left as-is — its slot
          // assignment is managed by the node or extension that owns the
          // slot.
          if (!handled.has(parentKey) && $getSlotHost(parent) === null) {
            const newListNode = $createListNode(listType);
            append(newListNode, parent.getChildren());
            parent.replace(newListNode);
            handled.add(parentKey);
          }

          break;
        } else {
          const nextParent = parent.getParent();

          if ($isRootOrShadowRoot(nextParent) && !handled.has(parentKey)) {
            handled.add(parentKey);
            $createListOrMerge(parent, listType);
            break;
          }

          parent = nextParent;
        }
      }
    }
  }
}

function append(node: ElementNode, nodesToAppend: LexicalNode[]) {
  node.splice(node.getChildrenSize(), 0, nodesToAppend);
}

function $createListOrMerge(node: ElementNode, listType: ListType): ListNode {
  if ($isListNode(node)) {
    return node;
  }

  const previousSibling = node.getPreviousSibling();
  const nextSibling = node.getNextSibling();
  const listItem = $createListItemNode();
  append(listItem, node.getChildren());

  let targetList;
  if (
    $isListNode(previousSibling) &&
    listType === previousSibling.getListType()
  ) {
    previousSibling.append(listItem);
    // if the same type of list is on both sides, merge them.
    if ($isListNode(nextSibling) && listType === nextSibling.getListType()) {
      append(previousSibling, nextSibling.getChildren());
      nextSibling.remove();
    }
    targetList = previousSibling;
  } else if (
    $isListNode(nextSibling) &&
    listType === nextSibling.getListType()
  ) {
    nextSibling.getFirstChildOrThrow().insertBefore(listItem);
    targetList = nextSibling;
  } else {
    const list = $createListNode(listType);
    list.append(listItem);
    node.replace(list);
    targetList = list;
  }
  // listItem needs to be attached to root prior to setting indent
  listItem.setFormat(node.getFormatType());
  listItem.setIndent(node.getIndent());

  // Preserve element-anchored selections by updating them to anchor to the listItem instead of the listNode.
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    if (targetList.getKey() === selection.anchor.key) {
      selection.anchor.set(
        listItem.getKey(),
        selection.anchor.offset,
        'element',
      );
    }
    if (targetList.getKey() === selection.focus.key) {
      selection.focus.set(listItem.getKey(), selection.focus.offset, 'element');
    }
  }

  node.remove();

  return targetList;
}

/**
 * A recursive function that goes through each list and their children, including nested lists,
 * appending list2 children after list1 children and updating ListItemNode values.
 * @param list1 - The first list to be merged.
 * @param list2 - The second list to be merged.
 */
export function mergeLists(list1: ListNode, list2: ListNode): void {
  const listItem1 = list1.getLastChild();
  const listItem2 = list2.getFirstChild();

  if (
    listItem1 &&
    listItem2 &&
    $isNestedListNode(listItem1) &&
    $isNestedListNode(listItem2)
  ) {
    mergeLists(listItem1.getFirstChild(), listItem2.getFirstChild());
    listItem2.remove();
  }

  const toMerge = list2.getChildren();
  if (toMerge.length > 0) {
    list1.append(...toMerge);
  }

  list2.remove();
}

/**
 * Searches for the nearest ancestral ListNode and removes it. If selection is an empty ListItemNode
 * it will remove the whole list, including the ListItemNode. For each ListItemNode in the ListNode,
 * removeList will also generate new ParagraphNodes in the removed ListNode's place. Any child node
 * inside a ListItemNode will be appended to the new ParagraphNodes.
 */
export function $removeList(): void {
  const selection = $getSelection();

  if ($isRangeSelection(selection)) {
    const listNodes = new Set<ListNode>();
    const nodes = selection.getNodes();
    const anchorNode = selection.anchor.getNode();

    if ($isSelectingEmptyListItem(anchorNode, nodes)) {
      listNodes.add($getTopListNode(anchorNode));
    } else {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];

        if ($isLeafNode(node)) {
          const listItemNode = $getNearestNodeOfType(node, ListItemNode);

          if (listItemNode != null) {
            listNodes.add($getTopListNode(listItemNode));
          }
        }
      }
    }

    for (const listNode of listNodes) {
      // A list occupying a named slot is left as-is: unwinding it would
      // insert siblings through the tree API (which would throw) and vacate
      // a slot whose assignment is managed by the node or extension that
      // owns it.
      if ($getSlotHost(listNode) !== null) {
        continue;
      }
      let insertionPoint: ListNode | ParagraphNode = listNode;

      const listItems = $getAllListItems(listNode);

      for (const listItemNode of listItems) {
        const paragraph = $createParagraphNode()
          .setTextStyle(selection.style)
          .setTextFormat(selection.format);

        append(paragraph, listItemNode.getChildren());

        insertionPoint.insertAfter(paragraph);
        insertionPoint = paragraph;

        // When the anchor and focus fall on the textNode
        // we don't have to change the selection because the textNode will be appended to
        // the newly generated paragraph.
        // When selection is in empty nested list item, selection is actually on the listItemNode.
        // When the corresponding listItemNode is deleted and replaced by the newly generated paragraph
        // we should manually set the selection's focus and anchor to the newly generated paragraph.
        if (listItemNode.__key === selection.anchor.key) {
          $setPointFromCaret(
            selection.anchor,
            $normalizeCaret($getChildCaret(paragraph, 'next')),
          );
        }
        if (listItemNode.__key === selection.focus.key) {
          $setPointFromCaret(
            selection.focus,
            $normalizeCaret($getChildCaret(paragraph, 'next')),
          );
        }

        listItemNode.remove();
      }
      listNode.remove();
    }
  }
}

/**
 * Takes the value of a child ListItemNode and makes it the value the ListItemNode
 * should be if it isn't already. Also ensures that checked is undefined if the
 * parent does not have a list type of 'check'.
 * @param list - The list whose children are updated.
 */
export function updateChildrenListItemValue(list: ListNode): void {
  const isNotChecklist = list.getListType() !== 'check';
  let value = list.getStart();
  for (const child of list.getChildren()) {
    if ($isListItemNode(child)) {
      if (child.getValue() !== value) {
        child.setValue(value);
      }
      if (isNotChecklist && child.getLatest().__checked != null) {
        child.setChecked(undefined);
      }
      if (!$isListNode(child.getFirstChild())) {
        value++;
      }
    }
  }
}

/**
 * Merge the next sibling list if same type.
 * <ul> will merge with <ul>, but NOT <ul> with <ol>.
 * @param list - The list whose next sibling should be potentially merged
 */
export function mergeNextSiblingListIfSameType(list: ListNode): void {
  const nextSibling = list.getNextSibling();
  if (
    $isListNode(nextSibling) &&
    list.getListType() === nextSibling.getListType()
  ) {
    mergeLists(list, nextSibling);
  }
}

/**
 * Adds an empty ListNode/ListItemNode chain at listItemNode, so as to
 * create an indent effect. Won't indent ListItemNodes that have a ListNode as
 * a child, but does merge sibling ListItemNodes if one has a nested ListNode.
 * @param listItemNode - The ListItemNode to be indented.
 */
export function $handleIndent(listItemNode: ListItemNode): void {
  // go through each node and decide where to move it.
  const removed = new Set<NodeKey>();

  if ($isNestedListNode(listItemNode) || removed.has(listItemNode.getKey())) {
    return;
  }

  const parent = listItemNode.getParent();

  const nextSibling = listItemNode.getNextSibling();
  const previousSibling = listItemNode.getPreviousSibling();
  // if there are nested lists on either side, merge them all together.

  if ($isNestedListNode(nextSibling) && $isNestedListNode(previousSibling)) {
    const innerList = previousSibling.getFirstChild();

    if ($isListNode(innerList)) {
      innerList.append(listItemNode);
      const nextInnerList = nextSibling.getFirstChild();

      if ($isListNode(nextInnerList)) {
        const children = nextInnerList.getChildren();
        append(innerList, children);
        nextSibling.remove();
        removed.add(nextSibling.getKey());
      }
    }
  } else if ($isNestedListNode(nextSibling)) {
    // if the ListItemNode is next to a nested ListNode, merge them
    const innerList = nextSibling.getFirstChild();

    if ($isListNode(innerList)) {
      const firstChild = innerList.getFirstChild();

      if (firstChild !== null) {
        firstChild.insertBefore(listItemNode);
      }
    }
  } else if ($isNestedListNode(previousSibling)) {
    const innerList = previousSibling.getFirstChild();

    if ($isListNode(innerList)) {
      innerList.append(listItemNode);
    }
  } else {
    // otherwise, we need to create a new nested ListNode

    if ($isListNode(parent)) {
      const newListItem = $copyNode(listItemNode);
      const newList = $copyNode(parent);
      newListItem.append(newList);
      newList.append(listItemNode);

      if (previousSibling) {
        previousSibling.insertAfter(newListItem);
      } else if (nextSibling) {
        nextSibling.insertBefore(newListItem);
      } else {
        parent.append(newListItem);
      }
    }
  }
}

/**
 * Removes an indent by removing an empty ListNode/ListItemNode chain. An indented ListItemNode
 * has a great grandparent node of type ListNode, which is where the ListItemNode will reside
 * within as a child.
 * @param listItemNode - The ListItemNode to remove the indent (outdent).
 */
export function $handleOutdent(listItemNode: ListItemNode): void {
  // go through each node and decide where to move it.

  if ($isNestedListNode(listItemNode)) {
    return;
  }
  const parentList = listItemNode.getParent();
  const grandparentListItem = parentList ? parentList.getParent() : undefined;
  const greatGrandparentList = grandparentListItem
    ? grandparentListItem.getParent()
    : undefined;
  // If it doesn't have these ancestors, it's not indented.

  if (
    $isListNode(greatGrandparentList) &&
    $isListItemNode(grandparentListItem) &&
    $isListNode(parentList)
  ) {
    // if it's the first child in it's parent list, insert it into the
    // great grandparent list before the grandparent
    const firstChild = parentList ? parentList.getFirstChild() : undefined;
    const lastChild = parentList ? parentList.getLastChild() : undefined;

    if (listItemNode.is(firstChild)) {
      grandparentListItem.insertBefore(listItemNode);

      if (parentList.isEmpty()) {
        grandparentListItem.remove();
      }
      // if it's the last child in it's parent list, insert it into the
      // great grandparent list after the grandparent.
    } else if (listItemNode.is(lastChild)) {
      grandparentListItem.insertAfter(listItemNode);

      if (parentList.isEmpty()) {
        grandparentListItem.remove();
      }
    } else {
      // otherwise, we need to split the siblings into two new nested lists
      const previousSiblingsListItem = $copyNode(listItemNode);
      const previousSiblingsList = $copyNode(parentList);
      previousSiblingsListItem.append(previousSiblingsList);
      listItemNode
        .getPreviousSiblings()
        .forEach(sibling => previousSiblingsList.append(sibling));
      const nextSiblingsListItem = $copyNode(listItemNode);
      const nextSiblingsList = $copyNode(parentList);
      nextSiblingsListItem.append(nextSiblingsList);
      append(nextSiblingsList, listItemNode.getNextSiblings());
      // put the sibling nested lists on either side of the grandparent list item in the great grandparent.
      grandparentListItem.insertBefore(previousSiblingsListItem);
      grandparentListItem.insertAfter(nextSiblingsListItem);
      // replace the grandparent list item (now between the siblings) with the outdented list item.
      grandparentListItem.replace(listItemNode);
    }
  }
}

/**
 * Attempts to insert a ParagraphNode at selection and selects the new node. The selection must contain a ListItemNode
 * or a node that does not already contain text. If its grandparent is the root/shadow root, it will get the ListNode
 * (which should be the parent node) and insert the ParagraphNode as a sibling to the ListNode. If the ListNode is
 * nested in a ListItemNode instead, it will add the ParagraphNode after the grandparent ListItemNode.
 * Throws an invariant if the selection is not a child of a ListNode.
 * @returns true if a ParagraphNode was inserted successfully, false if there is no selection
 * or the selection does not contain a ListItemNode or the node already holds text.
 */
export function $handleListInsertParagraph(
  restoreNumbering: boolean = false,
): boolean {
  const selection = $getSelection();

  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return false;
  }
  // Only run this code on empty list items (including whitespace-only)
  const anchor = selection.anchor.getNode();

  let listItem: ListItemNode | null = null;

  if ($isListItemNode(anchor) && anchor.getChildrenSize() === 0) {
    // Truly empty list item (element selection)
    listItem = anchor;
  } else if ($isTextNode(anchor)) {
    // Check if the entire list item contains only whitespace text nodes
    const parentListItem = anchor.getParent();
    if (
      $isListItemNode(parentListItem) &&
      parentListItem
        .getChildren()
        .every(node => $isTextNode(node) && node.getTextContent().trim() === '')
    ) {
      listItem = parentListItem;
    }
  }

  if (listItem === null) {
    return false;
  }

  const topListNode = $getTopListNode(listItem);
  const parent = listItem.getParent();

  invariant(
    $isListNode(parent),
    'A ListItemNode must have a ListNode for a parent.',
  );

  const grandparent = parent.getParent();

  let replacementNode: ParagraphNode | ListItemNode;

  if ($isRootOrShadowRoot(grandparent)) {
    replacementNode = $createParagraphNode();
    topListNode.insertAfter(replacementNode);
  } else if ($isListItemNode(grandparent)) {
    replacementNode = $copyNode(grandparent);
    grandparent.insertAfter(replacementNode);
  } else {
    return false;
  }
  replacementNode
    .setTextStyle(selection.style)
    .setTextFormat(selection.format)
    .select();

  const nextSiblings = listItem.getNextSiblings();

  if (nextSiblings.length > 0) {
    const newStart = restoreNumbering ? $getNewListStart(parent, listItem) : 1;
    const newList = $copyNode(parent).setStart(newStart);

    if ($isListItemNode(replacementNode)) {
      const newListItem = $copyNode(replacementNode);
      newListItem.append(newList);
      replacementNode.insertAfter(newListItem);
    } else {
      replacementNode.insertAfter(newList);
    }
    newList.append(...nextSiblings);
  }

  // Don't leave hanging nested empty lists
  $removeHighestEmptyListParent(listItem);

  return true;
}
