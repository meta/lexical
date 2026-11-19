/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Randomized concurrent edits across nested containers (a collapsible with a
// list, a collapsible in a table cell, a box in a box): three peers, causal
// and per-sender delivery; every round all peers and a fresh reader agree
// (expectConverged also fails on any development self-check warning).
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  type ListItemNode,
} from '@lexical/list';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {
  $create,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  $createBoxNode,
  $p,
  ColContainerNode,
  ColContentNode,
  ColTitleNode,
  expectConverged,
  setup,
} from '../utils/harness';

const $li = (t: string) => $createListItemNode().append($createTextNode(t));
const $col = (title: string, ...c: LexicalNode[]) =>
  $create(ColContainerNode).append(
    $create(ColTitleNode).append($createTextNode(title)),
    $create(ColContentNode).append(...c),
  );

function $lines(): ElementNode[] {
  const out: ElementNode[] = [];
  const visit = (n: LexicalNode) => {
    if ($isElementNode(n)) {
      const kids = n.getChildren();
      if (
        !n.isInline() &&
        kids.length > 0 &&
        kids.every(k => $isTextNode(k)) &&
        n.getType() !== 'test_col_title'
      ) {
        out.push(n);
      }
      kids.forEach(visit);
    }
  };
  visit($getRoot());
  return out;
}

test.each(Array.from({length: 20}, (_, i) => i + 1))(
  'nested seed %i',
  async seed => {
    let x = seed * 2654435761;
    const rnd = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
    const t = await setup(
      () => {
        $getRoot().append(
          $p('Top Aa1 line'),
          $col(
            'Title',
            $p('Col Bb2 one'),
            $createListNode('bullet').append($li('Item Cc3'), $li('Item Dd4')),
            $p('Col Ee5 two'),
          ),
          $createTableNode().append(
            $createTableRowNode().append(
              $createTableCellNode().append($p('Cell Ff6 x')),
              $createTableCellNode().append($col('In', $p('Deep Gg7 y'))),
            ),
          ),
          $createBoxNode('o').append(
            $createBoxNode('i').append($p('Box Hh8 z'), $p('Box Ii9 w')),
          ),
          $p('End Jj0 line'),
        );
      },
      {
        delivery: seed % 2 ? 'causal' : 'sender',
        ids: seed % 3 ? [1, 2, 3] : [3, 1, 2],
      },
    );
    for (let round = 0; round < 4; round++) {
      t.offline();
      for (const peer of t.peers) {
        const n = 1 + Math.floor(rnd() * 2);
        for (let k = 0; k < n; k++) {
          const r = rnd();
          const r2 = rnd();
          const r3 = rnd();
          peer.update(() => {
            const lines = $lines();
            if (lines.length === 0) {
              return;
            }
            const line = lines[Math.floor(r2 * lines.length)];
            const text = line.getFirstChild();
            if (!$isTextNode(text)) {
              return;
            }
            const len = text.getTextContentSize();
            const off = Math.floor(r3 * (len + 1));
            const sel = $createRangeSelection();
            sel.anchor.set(text.getKey(), off, 'text');
            sel.focus.set(text.getKey(), off, 'text');
            $setSelection(sel);
            if (r < 0.35) {
              sel.insertText('xy');
            } else if (r < 0.5) {
              sel.insertParagraph();
            } else if (
              r < 0.6 &&
              lines.length > 3 &&
              line.getParent()!.getChildrenSize() > 1
            ) {
              line.remove();
            } else if (r < 0.7 && !$isListItemNode(line)) {
              $setBlocksType(sel, () =>
                rnd() < 0.5 ? $createHeadingNode('h2') : $createQuoteNode(),
              );
            } else if (r < 0.8 && $isListItemNode(line)) {
              (line as ListItemNode).setIndent(Math.floor(rnd() * 3));
            } else if (len > 1) {
              sel.anchor.set(text.getKey(), 0, 'text');
              sel.focus.set(text.getKey(), Math.min(2, len), 'text');
              sel.formatText('bold');
            }
          });
        }
      }
      await t.sync();
      await expectConverged(t.peers);
      const all = t.a.read(() => $getRoot().getTextContent());
      expect(all).not.toContain('\u2029');
    }
  },
);
