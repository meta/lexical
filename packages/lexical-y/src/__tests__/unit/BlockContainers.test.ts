/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$insertList} from '@lexical/list';
import {$createQuoteNode} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  ElementNode,
  INTERNAL_isNodeStructureEnforced,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $createBoxNode,
  $p,
  expectConverged,
  NODES,
  setup,
} from '../utils/harness';

// A block container that declares `children: 'block'` (a callout): with the
// node structure enforced, as in every @lexical/y editor, turning one of its
// paragraphs into a list converts that paragraph in place, so what a
// collaborator types in it at the same time is kept. A container that
// declares nothing is replaced by the list (y.md, Limits: Moves), unless it
// holds a block a list item cannot hold.
class DeclaredBoxNode extends ElementNode {
  $config() {
    return this.config('test_declared_box', {
      children: 'block',
      extends: ElementNode,
    });
  }
  createDOM(): HTMLElement {
    throw new Error('headless');
  }
  updateDOM(): boolean {
    return false;
  }
}

const nodes = [...NODES, DeclaredBoxNode];

describe('@lexical/y list conversion in a block container', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`paragraph -> list in a declared container ‖ type in it keeps the text (${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $create(DeclaredBoxNode).append($p('Alpha'), $p('Gamma')),
          ),
        {ids, nodes},
      );
      expect(INTERNAL_isNodeStructureEnforced(t.a.editor)).toBe(true);
      t.offline();
      t.a.update(() => {
        $block([0, 0]).selectStart();
        $insertList('bullet');
      });
      t.b.update(() => {
        $block([0, 0]).selectEnd().insertText('X');
      });
      await t.sync();
      await expectConverged(
        t.peers,
        'test_declared_box(list[bullet](listitem("AlphaX")) paragraph("Gamma"))',
      );
    });

    test(`formatted paragraph -> list in a declared container ‖ type in it keeps the text (${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $create(DeclaredBoxNode).append(
              $createParagraphNode().append(
                $createTextNode('Al'),
                $createTextNode('pha').toggleFormat('bold'),
              ),
              $p('Gamma'),
            ),
          ),
        {ids, nodes},
      );
      t.offline();
      t.a.update(() => {
        $block([0, 0]).selectStart();
        $insertList('bullet');
      });
      t.b.update(() => {
        $block([0, 0]).selectEnd().insertText('X');
      });
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toContain('X');
      expect(t.a.describe()).toMatch(/^test_declared_box\(list\[bullet\]/);
    });

    test(`quote -> list in a container that declares nothing ‖ type in it keeps the text (${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createBoxNode('o').append(
              $createQuoteNode().append($createTextNode('Alpha')),
              $p('Gamma'),
            ),
          ),
        {ids, nodes},
      );
      t.offline();
      t.a.update(() => {
        $block([0, 0]).selectStart();
        $insertList('bullet');
      });
      t.b.update(() => {
        $block([0, 0]).selectEnd().insertText('X');
      });
      await t.sync();
      // The box holds a block a list item cannot hold (the quote): the quote
      // is converted in place, so the typing is kept.
      await expectConverged(
        t.peers,
        'test_box[o](list[bullet](listitem("AlphaX")) paragraph("Gamma"))',
      );
    });

    test(`paragraph -> list in a container that declares nothing ‖ type in it loses the typing, a documented limit (${ids})`, async () => {
      const t = await setup(
        () => $getRoot().append($createBoxNode('o').append($p('Alpha'))),
        {ids, nodes},
      );
      t.offline();
      t.a.update(() => {
        $block([0, 0]).selectStart();
        $insertList('bullet');
      });
      t.b.update(() => {
        $block([0, 0]).selectEnd().insertText('X');
      });
      await t.sync();
      await expectConverged(t.peers);
      // The box is replaced by the list, a move: the typing is lost.
      expect(t.a.describe()).toBe('list[bullet](listitem("Alpha"))');
    });
  }
});
