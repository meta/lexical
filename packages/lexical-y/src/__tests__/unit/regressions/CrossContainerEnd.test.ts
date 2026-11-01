/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A format write that restates another client's run at the end of its range
// gives that run an end of its own, after the end that client's change gave
// it (see changeEnd). That client's next item of the key, in its clock order,
// can be in another container: here A colors text in a table cell and then
// in the paragraph before the table, and B recolors part of the cell. B's
// write linked its end after A's item in the root while naming the cell as
// its parent: B's own document held an item in the wrong list (every other
// client placed it in the cell), and later changes next to it made B's
// editor stop reading part of the document, for good. A run cannot end in
// another container: changeEnd only looks in the run's own, and no item is
// written next to an item of another container.

import {$patchStyleText} from '@lexical/selection';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {expectConverged, setup} from '../../utils/harness';
import {misLinkedItems} from '../../utils/structure';

function $paragraphs(): ElementNode[] {
  const out: ElementNode[] = [];
  const walk = (n: LexicalNode) => {
    if ($isParagraphNode(n)) {
      out.push(n);
    } else if ($isElementNode(n)) {
      n.getChildren().forEach(walk);
    }
  };
  walk($getRoot());
  return out;
}

/**
 * Color offsets `from` to `to` of paragraph `p` (0: the first paragraph, 1
 * and 2: the cells, 3: the last paragraph); null clears the color.
 */
function $color(
  p: number,
  from: number,
  to: number | 'end',
  color: string | null,
) {
  const texts = $paragraphs()[p].getAllTextNodes();
  const total = texts.reduce((n, t) => n + t.getTextContentSize(), 0);
  const at = (offset: number) => {
    let left = offset;
    for (const t of texts) {
      const n = t.getTextContentSize();
      if (left <= n) {
        return {o: left, t};
      }
      left -= n;
    }
    const last = texts[texts.length - 1];
    return {o: last.getTextContentSize(), t: last};
  };
  const x = at(from);
  const y = at(to === 'end' ? total : to);
  const selection = $createRangeSelection();
  selection.anchor.set(x.t.getKey(), x.o, 'text');
  selection.focus.set(y.t.getKey(), y.o, 'text');
  $setSelection(selection);
  $patchStyleText(selection, {color});
  $setSelection(null);
}

describe('a style write next to a run whose client wrote in another container', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`links no item into another container (ids ${ids})`, async () => {
      const $cell = (text: string) =>
        $createTableCellNode(0).append(
          $createParagraphNode().append($createTextNode(text)),
        );
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('alpha beta gamma')),
            $createTableNode().append(
              $createTableRowNode().append(
                $cell('one two three'),
                $cell('four five six'),
              ),
            ),
            $createParagraphNode().append(
              $createTextNode('delta epsilon zeta'),
            ),
          ),
        {ids},
      );
      t.a.update(() => $color(2, 1, 'end', '#00c'));
      t.a.update(() => $color(2, 7, 8, null));
      t.a.update(() => $color(0, 13, 17, '#00c'));
      await t.sync();
      t.b.update(() => $color(2, 4, 8, '#0a0'));
      for (const peer of t.peers) {
        expect(misLinkedItems(peer.doc)).toEqual([]);
        expect(peer.warnings).toEqual([]);
      }
      await t.sync();
      await expectConverged(t.peers);
    });
  }
});
