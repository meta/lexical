/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Text formats around tab nodes after type changes and removals.
// @vitest-environment node
import {$createCodeHighlightNode, $createCodeNode} from '@lexical/code';
import {$createListItemNode, $createListNode} from '@lexical/list';
import {$createQuoteNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTabNode,
  $createTextNode,
  $getRoot,
  type LexicalNode,
} from 'lexical';
import {describe, test} from 'vitest';

import {
  $block,
  $selectIn,
  type Delivery,
  expectConverged,
  type Setup,
  setup,
} from '../utils/harness';

const ORDERS: [number[], Delivery][] = [
  [[1, 2], 'causal'],
  [[2, 1], 'causal'],
  [[1, 2], 'sender'],
  [[2, 1], 'sender'],
];
const $li = (...c: LexicalNode[]) => $createListItemNode().append(...c);
const $t = (s: string) => $createTextNode(s);

describe('@lexical/y no text format leaks around tabs', () => {
  for (const [ids, delivery] of ORDERS) {
    test(`remove line starting with tab || join next two lines ${ids} ${delivery}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTabNode(), $t('one')),
            $createParagraphNode().append($t('t')),
            $createParagraphNode().append($t('wo')),
            $createParagraphNode().append($t('end')),
          ),
        {delivery, ids},
      );
      t.offline();
      t.a.update(() => {
        // join line 3 into line 2 (Backspace at start of line 3)
        const l2 = $block([1]);
        const l3 = $block([2]);
        l2.append(...l3.getChildren());
        l3.remove();
      });
      t.b.update(() => {
        $block([0]).remove();
      });
      await t.sync();
      await expectConverged(t.peers);
    });
  }
});

describe('@lexical/y no text format leaks around tabs, single writer', () => {
  const variants: [string, () => void, ((t: Setup) => void) | null][] = [
    [
      'quote ending with tab-text; remove next list item starting with tab',
      () =>
        $getRoot().append(
          $createQuoteNode().append(
            $t('const'),
            $createLineBreakNode(),
            $createTabNode(),
            $t('let b;'),
          ),
          $createListNode('check').append(
            $li($createTabNode(), $t('one')),
            $li($t('t')),
          ),
          $createParagraphNode().append($t('end')),
        ),
      null,
    ],
    [
      'paragraph; remove next paragraph starting with tab',
      () =>
        $getRoot().append(
          $createParagraphNode().append($t('aa')),
          $createParagraphNode().append($createTabNode(), $t('one')),
          $createParagraphNode().append($t('end')),
        ),
      null,
    ],
    [
      'paragraph ending in tab+text; remove next paragraph starting with tab',
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTabNode(), $t('aa')),
          $createParagraphNode().append($createTabNode(), $t('one')),
          $createParagraphNode().append($t('end')),
        ),
      null,
    ],
    [
      'code -> quote, then remove next list item starting with tab',
      () =>
        $getRoot().append(
          $createCodeNode('javascript').append(
            $createCodeHighlightNode('const'),
            $createLineBreakNode(),
            $createTabNode(),
            $createCodeHighlightNode('let b;'),
          ),
          $createListNode('check').append(
            $li($createTabNode(), $t('one')),
            $li($t('t')),
          ),
          $createParagraphNode().append($t('end')),
        ),
      (t: Setup) =>
        t.a.update(() => {
          $setBlocksType($selectIn([0], 0), () => $createQuoteNode());
        }),
    ],
    [
      'p(tab, code-highlight text) then p(tab, text): remove 2nd',
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createTabNode(),
            $createCodeHighlightNode('x'),
          ),
          $createParagraphNode().append($createTabNode(), $t('one')),
          $createParagraphNode().append($t('end')),
        ),
      null,
    ],
    [
      'p(tab, bold text) then p(tab, text): remove 2nd',
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createTabNode(),
            $t('x').setFormat('bold'),
          ),
          $createParagraphNode().append($createTabNode(), $t('one')),
          $createParagraphNode().append($t('end')),
        ),
      null,
    ],
    [
      'p(code-highlight text) then p(tab): remove 2nd',
      () =>
        $getRoot().append(
          $createParagraphNode().append($createCodeHighlightNode('x')),
          $createParagraphNode().append($createTabNode(), $t('one')),
          $createParagraphNode().append($t('end')),
        ),
      null,
    ],
  ];
  for (const [name, init, pre] of variants) {
    test(name, async () => {
      const t = await setup(init);
      if (pre) {
        pre(t);
        await t.sync();
        await expectConverged(t.peers);
      }
      t.a.update(() => {
        const b = $block([1]);
        (b.getType() === 'list' ? b.getFirstChild()! : b).remove();
      });
      await t.sync();
      await expectConverged(t.peers);
    });
  }
});
