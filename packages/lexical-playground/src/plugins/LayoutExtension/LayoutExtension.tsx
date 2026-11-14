/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {defineImportRule, DOMImportExtension, sel} from '@lexical/html';
import {
  $insertNodeToNearestRoot,
  $onEscapeDown,
  $onEscapeUp,
} from '@lexical/utils';
import {
  $createParagraphNode,
  $getNodeByKey,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_LOW,
  configExtension,
  createCommand,
  defineExtension,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  type LexicalCommand,
  mergeRegister,
  type NodeKey,
} from 'lexical';

import {
  $createLayoutContainerNode,
  $isLayoutContainerNode,
  LayoutContainerNode,
} from '../../nodes/LayoutContainerNode';
import {
  $createLayoutItemNode,
  $isLayoutItemNode,
  LayoutItemNode,
} from '../../nodes/LayoutItemNode';

export const INSERT_LAYOUT_COMMAND: LexicalCommand<string> =
  createCommand<string>();

export const UPDATE_LAYOUT_COMMAND: LexicalCommand<{
  template: string;
  nodeKey: NodeKey;
}> = createCommand<{template: string; nodeKey: NodeKey}>();

function getItemsCountFromTemplate(template: string): number {
  return template.trim().split(/\s+/).length;
}

const LayoutContainerImportRule = defineImportRule({
  $import: (ctx, el) => [
    $createLayoutContainerNode(el.style.gridTemplateColumns).splice(
      0,
      0,
      ctx.$importChildren(el),
    ),
  ],
  match: sel.tag('div').attr('data-lexical-layout-container', true),
  name: '@lexical/playground/layout-container',
});

const LayoutItemImportRule = defineImportRule({
  $import: (ctx, el) => [
    $createLayoutItemNode().splice(0, 0, ctx.$importChildren(el)),
  ],
  match: sel.tag('div').attr('data-lexical-layout-item', true),
  name: '@lexical/playground/layout-item',
});

const $fillLayoutItemIfEmpty = (node: LayoutItemNode) => {
  if (node.isEmpty()) {
    node.append($createParagraphNode());
  }
};

const $removeIsolatedLayoutItem = (node: LayoutItemNode): boolean => {
  const parent = node.getParent();
  if (!$isLayoutContainerNode(parent)) {
    const children = node.getChildren();
    for (const child of children) {
      node.insertBefore(child);
    }
    node.remove();
    return true;
  }
  return false;
};

export const LayoutExtension = defineExtension({
  dependencies: [
    configExtension(DOMImportExtension, {
      rules: [LayoutContainerImportRule, LayoutItemImportRule],
    }),
  ],
  name: '@lexical/playground/Layout',
  nodes: [LayoutContainerNode, LayoutItemNode],
  register: editor =>
    mergeRegister(
      // When layout is the last child pressing down/right arrow will insert
      // a paragraph below it, mirroring `$insertBlockNode`. Continues to
      // work even if a trailing paragraph is accidentally deleted.
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        event => $onEscapeDown($isLayoutContainerNode, event),
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        KEY_ARROW_RIGHT_COMMAND,
        event => $onEscapeDown($isLayoutContainerNode, event),
        COMMAND_PRIORITY_LOW,
      ),
      // Inverse: leading paragraph escape on up/left.
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        event => $onEscapeUp($isLayoutContainerNode, event),
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        KEY_ARROW_LEFT_COMMAND,
        event => $onEscapeUp($isLayoutContainerNode, event),
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        INSERT_LAYOUT_COMMAND,
        template => {
          const container = $createLayoutContainerNode(template);
          const itemsCount = getItemsCountFromTemplate(template);

          for (let i = 0; i < itemsCount; i++) {
            container.append(
              $createLayoutItemNode().append($createParagraphNode()),
            );
          }

          $insertNodeToNearestRoot(container);
          container.selectStart();

          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      editor.registerCommand(
        UPDATE_LAYOUT_COMMAND,
        ({template, nodeKey}) => {
          const container = $getNodeByKey(nodeKey);

          if (!$isLayoutContainerNode(container)) {
            return true;
          }

          const itemsCount = getItemsCountFromTemplate(template);
          const prevItemsCount = getItemsCountFromTemplate(
            container.getTemplateColumns(),
          );

          // Add or remove columns to match the new template.
          if (itemsCount > prevItemsCount) {
            for (let i = prevItemsCount; i < itemsCount; i++) {
              container.append(
                $createLayoutItemNode().append($createParagraphNode()),
              );
            }
          } else if (itemsCount < prevItemsCount) {
            for (let i = prevItemsCount - 1; i >= itemsCount; i--) {
              const layoutItem = container.getChildAtIndex(i);

              if ($isLayoutItemNode(layoutItem)) {
                layoutItem.remove();
              }
            }
          }

          container.setTemplateColumns(template);

          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),

      // Structure-enforcing transforms. If nesting isn't `Container > Item`,
      // unwrap and treat the content as regular blocks.
      editor.registerNodeTransform(LayoutItemNode, node => {
        const isRemoved = $removeIsolatedLayoutItem(node);

        if (!isRemoved) {
          // Layout items should never be empty; backfill with a paragraph.
          $fillLayoutItemIfEmpty(node);
        }
      }),
      editor.registerNodeTransform(LayoutContainerNode, node => {
        const children = node.getChildren();
        if (!children.every($isLayoutItemNode)) {
          for (const child of children) {
            node.insertBefore(child);
          }
          node.remove();
        }
      }),
    ),
});
