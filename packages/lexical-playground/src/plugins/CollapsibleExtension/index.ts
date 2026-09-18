/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './Collapsible.css';

import {
  BlockSchema,
  defineImportRule,
  DOMImportExtension,
  sel,
} from '@lexical/html';
import {$insertNodeToNearestRoot} from '@lexical/utils';
import {
  $createParagraphNode,
  $findMatchingParent,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  configExtension,
  createCommand,
  defineExtension,
  INSERT_PARAGRAPH_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  type LexicalNode,
  mergeRegister,
} from 'lexical';

import {
  $createCollapsibleContainerNode,
  $isCollapsibleContainerNode,
  CollapsibleContainerNode,
} from './CollapsibleContainerNode';
import {
  $createCollapsibleContentNode,
  $isCollapsibleContentNode,
  CollapsibleContentNode,
} from './CollapsibleContentNode';
import {
  $createCollapsibleTitleNode,
  $isCollapsibleTitleNode,
  CollapsibleTitleNode,
} from './CollapsibleTitleNode';

const SummaryRule = defineImportRule({
  $import: (ctx, el) => [
    $createCollapsibleTitleNode().splice(0, 0, ctx.$importChildren(el)),
  ],
  match: sel.tag('summary'),
  name: '@lexical/playground/summary',
});

const CollapsibleContentRule = defineImportRule({
  $import: (ctx, el) => [
    $createCollapsibleContentNode().splice(
      0,
      0,
      ctx.$importChildren(el, {schema: BlockSchema}),
    ),
  ],
  match: sel.tag('div').attr('data-lexical-collapsible-content', true),
  name: '@lexical/playground/collapsible-content',
});

const DetailsRule = defineImportRule({
  $import: (ctx, el) => {
    let titleNode: CollapsibleTitleNode | null = null;
    // BlockSchema wraps inline runs in paragraphs, and `$onChild` siphons
    // the synthesized CollapsibleTitleNode out before it ever reaches the
    // ContentNode below. CollapsibleContentNode is itself block-level so
    // BlockSchema leaves it intact in `bodyNodes`.
    const bodyNodes = ctx.$importChildren(el, {
      $onChild: child => {
        if (titleNode === null && $isCollapsibleTitleNode(child)) {
          titleNode = child;
          return null;
        }
        return child;
      },
      schema: BlockSchema,
    });
    let contentNode: CollapsibleContentNode | null = null;
    const restBody: LexicalNode[] = [];
    for (const child of bodyNodes) {
      if ($isCollapsibleContentNode(child)) {
        if (contentNode === null) {
          contentNode = child;
        } else {
          // Multiple content nodes (rare): fold the extras into restBody so
          // they get appended to the canonical one below.
          for (const grand of child.getChildren()) {
            restBody.push(grand);
          }
        }
      } else {
        restBody.push(child);
      }
    }
    if (titleNode === null) {
      titleNode = $createCollapsibleTitleNode();
    }
    if (contentNode === null) {
      contentNode = $createCollapsibleContentNode();
    }
    for (const node of restBody) {
      contentNode.append(node);
    }
    return [
      $createCollapsibleContainerNode(el.open).append(titleNode, contentNode),
    ];
  },
  match: sel.tag('details'),
  name: '@lexical/playground/details',
});

export const INSERT_COLLAPSIBLE_COMMAND = createCommand<void>(
  'INSERT_COLLAPSIBLE_COMMAND',
);

const $onEscapeUp = () => {
  const selection = $getSelection();
  if (
    $isRangeSelection(selection) &&
    selection.isCollapsed() &&
    selection.anchor.offset === 0
  ) {
    const container = $findMatchingParent(
      selection.anchor.getNode(),
      $isCollapsibleContainerNode,
    );

    if ($isCollapsibleContainerNode(container)) {
      const parent = container.getParent();
      if (
        parent !== null &&
        parent.getFirstChild() === container &&
        selection.anchor.key === container.getFirstDescendant()?.getKey()
      ) {
        container.insertBefore($createParagraphNode());
      }
    }
  }

  return false;
};

const $onEscapeDown = () => {
  const selection = $getSelection();
  if ($isRangeSelection(selection) && selection.isCollapsed()) {
    const container = $findMatchingParent(
      selection.anchor.getNode(),
      $isCollapsibleContainerNode,
    );

    if ($isCollapsibleContainerNode(container)) {
      const parent = container.getParent();
      if (parent !== null && parent.getLastChild() === container) {
        const titleParagraph = container.getFirstDescendant();
        const contentParagraph = container.getLastDescendant();

        if (
          (contentParagraph !== null &&
            selection.anchor.key === contentParagraph.getKey() &&
            selection.anchor.offset ===
              contentParagraph.getTextContentSize()) ||
          (titleParagraph !== null &&
            selection.anchor.key === titleParagraph.getKey() &&
            selection.anchor.offset === titleParagraph.getTextContentSize() &&
            !container.getOpen())
        ) {
          container.insertAfter($createParagraphNode());
        }
      }
    }
  }

  return false;
};

export const CollapsibleExtension = defineExtension({
  dependencies: [
    configExtension(DOMImportExtension, {
      rules: [DetailsRule, SummaryRule, CollapsibleContentRule],
    }),
  ],
  name: '@lexical/playground/Collapsible',
  nodes: [
    CollapsibleContainerNode,
    CollapsibleTitleNode,
    CollapsibleContentNode,
  ],
  register: editor =>
    mergeRegister(
      // Structure enforcing transformers for each node type. In case nesting structure is not
      // "Container > Title + Content" it'll unwrap nodes and convert it back
      // to regular content.
      editor.registerNodeTransform(CollapsibleContentNode, node => {
        const parent = node.getParent();
        if (!$isCollapsibleContainerNode(parent)) {
          const children = node.getChildren();
          for (const child of children) {
            node.insertBefore(child);
          }
          node.remove();
        } else if (node.isEmpty()) {
          node.append($createParagraphNode());
        }
      }),

      editor.registerNodeTransform(CollapsibleTitleNode, node => {
        const parent = node.getParent();
        if (!$isCollapsibleContainerNode(parent)) {
          node.replace($createParagraphNode().append(...node.getChildren()));
        }
      }),

      editor.registerNodeTransform(CollapsibleContainerNode, node => {
        const children = node.getChildren();
        if (
          children.length !== 2 ||
          !$isCollapsibleTitleNode(children[0]) ||
          !$isCollapsibleContentNode(children[1])
        ) {
          for (const child of children) {
            node.insertBefore(child);
          }
          node.remove();
        }
      }),

      // When collapsible is the last child pressing down/right arrow will insert paragraph
      // below it to allow adding more content. It's similar what $insertBlockNode
      // (mainly for decorators), except it'll always be possible to continue adding
      // new content even if trailing paragraph is accidentally deleted
      editor.registerCommand(
        KEY_ARROW_DOWN_COMMAND,
        $onEscapeDown,
        COMMAND_PRIORITY_LOW,
      ),

      editor.registerCommand(
        KEY_ARROW_RIGHT_COMMAND,
        $onEscapeDown,
        COMMAND_PRIORITY_LOW,
      ),

      // When collapsible is the first child pressing up/left arrow will insert paragraph
      // above it to allow adding more content. It's similar what $insertBlockNode
      // (mainly for decorators), except it'll always be possible to continue adding
      // new content even if leading paragraph is accidentally deleted
      editor.registerCommand(
        KEY_ARROW_UP_COMMAND,
        $onEscapeUp,
        COMMAND_PRIORITY_LOW,
      ),

      editor.registerCommand(
        KEY_ARROW_LEFT_COMMAND,
        $onEscapeUp,
        COMMAND_PRIORITY_LOW,
      ),

      // Enter goes from Title to Content rather than a new line inside Title
      editor.registerCommand(
        INSERT_PARAGRAPH_COMMAND,
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const titleNode = $findMatchingParent(
              selection.anchor.getNode(),
              node => $isCollapsibleTitleNode(node),
            );

            if ($isCollapsibleTitleNode(titleNode)) {
              const container = titleNode.getParent();
              if (container && $isCollapsibleContainerNode(container)) {
                if (!container.getOpen()) {
                  container.toggleOpen();
                }
                titleNode.getNextSibling()?.selectEnd();
                return true;
              }
            }
          }

          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        INSERT_COLLAPSIBLE_COMMAND,
        () => {
          editor.update(() => {
            const title = $createCollapsibleTitleNode();
            const paragraph = $createParagraphNode();
            $insertNodeToNearestRoot(
              $createCollapsibleContainerNode(true).append(
                title.append(paragraph),
                $createCollapsibleContentNode().append($createParagraphNode()),
              ),
            );
            paragraph.select();
          });
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    ),
});
