/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createHorizontalRuleNode,
  buildEditorFromExtensions,
  HorizontalRuleExtension,
  HorizontalRuleNode,
} from '@lexical/extension';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $nodesOfType,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

import {CollapsibleExtension} from '../../src/plugins/CollapsibleExtension';
import {
  $createCollapsibleContainerNode,
  $isCollapsibleContainerNode,
} from '../../src/plugins/CollapsibleExtension/CollapsibleContainerNode';
import {
  $createCollapsibleContentNode,
  $isCollapsibleContentNode,
} from '../../src/plugins/CollapsibleExtension/CollapsibleContentNode';
import {
  $createCollapsibleTitleNode,
  $isCollapsibleTitleNode,
} from '../../src/plugins/CollapsibleExtension/CollapsibleTitleNode';

const ext = defineExtension({
  $initialEditorState: null,
  dependencies: [CollapsibleExtension, HorizontalRuleExtension],
  name: '[8724-collapsible]',
});

describe('Pasting a HorizontalRuleNode into a CollapsibleTitleNode (#8724)', () => {
  // Mirrors the reported repro: insert a collapsible (focus lands in the empty
  // ParagraphNode inside the CollapsibleTitleNode) and paste a copied
  // HorizontalRuleNode. The title is inline-only and cannot hold the block, so
  // insertNodes flattens the paste to its inline content; a HorizontalRuleNode
  // has no inline form, so it is dropped and the collapsible is left intact —
  // never producing a non-inline child of the title.
  test('drops the pasted block and keeps the collapsible intact', () => {
    using editor = buildEditorFromExtensions(ext);
    editor.update(
      () => {
        // Same shape the INSERT_COLLAPSIBLE_COMMAND produces.
        const title = $createCollapsibleTitleNode();
        const titleParagraph = $createParagraphNode();
        $getRoot()
          .clear()
          .append(
            $createCollapsibleContainerNode(true).append(
              title.append(titleParagraph),
              $createCollapsibleContentNode().append($createParagraphNode()),
            ),
          );
        titleParagraph.select();
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        // Must not throw and must not nest the block inside the title.
        selection.insertNodes([$createHorizontalRuleNode()]);
      },
      {discrete: true},
    );

    editor.read(() => {
      const rootChildren = $getRoot().getChildren();
      // The collapsible is preserved intact (nothing leaked out to the root).
      expect(rootChildren).toHaveLength(1);
      const container = rootChildren[0];
      assert(
        $isCollapsibleContainerNode(container),
        'Expected a collapsible container',
      );

      const containerChildren = container.getChildren();
      expect(containerChildren).toHaveLength(2);
      expect($isCollapsibleTitleNode(containerChildren[0])).toBe(true);
      expect($isCollapsibleContentNode(containerChildren[1])).toBe(true);

      // The block had no inline form, so it was dropped entirely (never
      // nested in the inline-only title).
      expect($nodesOfType(HorizontalRuleNode)).toHaveLength(0);
    });
  });
});
