/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $findMatchingParent,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_BEFORE_EDITOR,
  COMMAND_PRIORITY_LOW,
  createCommand,
  INSERT_PARAGRAPH_COMMAND,
  KEY_BACKSPACE_COMMAND,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  type NodeKey,
  TextNode,
} from 'lexical';

import {
  $handleListInsertParagraph,
  $insertList,
  $removeList,
  updateChildrenListItemValue,
} from './formatList';
import {$isListItemNode, ListItemNode} from './LexicalListItemNode';
import {$isListNode, ListNode} from './LexicalListNode';
import {$getListDepth} from './utils';

export const UPDATE_LIST_START_COMMAND: LexicalCommand<{
  listNodeKey: NodeKey;
  newStart: number;
}> = createCommand('UPDATE_LIST_START_COMMAND');
export const INSERT_UNORDERED_LIST_COMMAND: LexicalCommand<void> =
  createCommand('INSERT_UNORDERED_LIST_COMMAND');
export const INSERT_ORDERED_LIST_COMMAND: LexicalCommand<void> = createCommand(
  'INSERT_ORDERED_LIST_COMMAND',
);
export const REMOVE_LIST_COMMAND: LexicalCommand<void> = createCommand(
  'REMOVE_LIST_COMMAND',
);

export interface RegisterListOptions {
  restoreNumbering?: boolean;
}

export function registerList(
  editor: LexicalEditor,
  options?: RegisterListOptions,
): () => void {
  const removeListener = mergeRegister(
    editor.registerCommand(
      INSERT_ORDERED_LIST_COMMAND,
      () => {
        $insertList('number');
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      UPDATE_LIST_START_COMMAND,
      payload => {
        const {listNodeKey, newStart} = payload;
        const listNode = $getNodeByKey(listNodeKey);
        if (!$isListNode(listNode)) {
          return false;
        }
        if (listNode.getListType() === 'number') {
          listNode.setStart(newStart);
          updateChildrenListItemValue(listNode);
        }
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      INSERT_UNORDERED_LIST_COMMAND,
      () => {
        $insertList('bullet');
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      REMOVE_LIST_COMMAND,
      () => {
        $removeList();
        return true;
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      INSERT_PARAGRAPH_COMMAND,
      () => {
        const shouldRestore = options && options.restoreNumbering;
        return $handleListInsertParagraph(!!shouldRestore);
      },
      COMMAND_PRIORITY_LOW,
    ),
    editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      event => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }
        const {anchor} = selection;
        if (anchor.offset !== 0) {
          return false;
        }
        let current: LexicalNode = anchor.getNode();
        while (!$isListItemNode(current)) {
          if (current.getPreviousSibling() !== null) {
            return false;
          }
          const parent = current.getParent();
          if (parent === null) {
            return false;
          }
          current = parent;
        }
        if ($isListItemNode(current) && current.collapseAtStart(selection)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_BEFORE_EDITOR,
    ),
    editor.registerNodeTransform(ListItemNode, node => {
      const firstChild = node.getFirstChild();
      if (firstChild) {
        if ($isTextNode(firstChild)) {
          const style = firstChild.getStyle();
          const format = firstChild.getFormat();
          if (node.getTextStyle() !== style) {
            node.setTextStyle(style);
          }
          if (node.getTextFormat() !== format) {
            node.setTextFormat(format);
          }
        }
      } else {
        // If it's empty, check the selection
        const selection = $getSelection();
        if (
          $isRangeSelection(selection) &&
          (selection.style !== node.getTextStyle() ||
            selection.format !== node.getTextFormat()) &&
          selection.isCollapsed() &&
          node.is(selection.anchor.getNode())
        ) {
          node.setTextStyle(selection.style).setTextFormat(selection.format);
        }
      }
    }),
    editor.registerNodeTransform(TextNode, node => {
      const listItemParentNode = node.getParent();
      if (
        $isListItemNode(listItemParentNode) &&
        node.is(listItemParentNode.getFirstChild())
      ) {
        const style = node.getStyle();
        const format = node.getFormat();
        if (
          style !== listItemParentNode.getTextStyle() ||
          format !== listItemParentNode.getTextFormat()
        ) {
          listItemParentNode.setTextStyle(style).setTextFormat(format);
        }
      }
    }),
  );
  return removeListener;
}

export function registerListStrictIndentTransform(
  editor: LexicalEditor,
): () => void {
  const $formatListIndentStrict = (listItemNode: ListItemNode): void => {
    const listNode = listItemNode.getParent();
    if ($isListNode(listItemNode.getFirstChild()) || !$isListNode(listNode)) {
      return;
    }

    const startingListItemNode = $findMatchingParent(
      listItemNode,
      node =>
        $isListItemNode(node) &&
        $isListNode(node.getParent()) &&
        $isListItemNode(node.getPreviousSibling()),
    );

    if (startingListItemNode === null && listItemNode.getIndent() > 0) {
      listItemNode.setIndent(0);
    } else if ($isListItemNode(startingListItemNode)) {
      const prevListItemNode = startingListItemNode.getPreviousSibling();

      if ($isListItemNode(prevListItemNode)) {
        const endListItemNode = $findChildrenEndListItemNode(prevListItemNode);
        const endListNode = endListItemNode.getParent();

        if ($isListNode(endListNode)) {
          const prevDepth = $getListDepth(endListNode);
          const depth = $getListDepth(listNode);

          if (prevDepth + 1 < depth) {
            listItemNode.setIndent(prevDepth);
          }
        }
      }
    }
  };

  const $processListWithStrictIndent = (listNode: ListNode): void => {
    const queue: ListNode[] = [listNode];

    while (queue.length > 0) {
      const node = queue.shift();
      if (!$isListNode(node)) {
        continue;
      }

      for (const child of node.getChildren()) {
        if ($isListItemNode(child)) {
          $formatListIndentStrict(child);

          const firstChild = child.getFirstChild();
          if ($isListNode(firstChild)) {
            queue.push(firstChild);
          }
        }
      }
    }
  };

  return editor.registerNodeTransform(ListNode, $processListWithStrictIndent);
}

function $findChildrenEndListItemNode(
  listItemNode: ListItemNode,
): ListItemNode {
  let current = listItemNode;
  let firstChild = current.getFirstChild();

  while ($isListNode(firstChild)) {
    const lastChild = firstChild.getLastChild();

    if ($isListItemNode(lastChild)) {
      current = lastChild;
      firstChild = current.getFirstChild();
    } else {
      break;
    }
  }

  return current;
}
