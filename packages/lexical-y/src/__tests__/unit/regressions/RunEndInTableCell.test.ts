/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$patchStyleText} from '@lexical/selection';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import * as Y from '@y/y';
import {$getRoot, $setSelection} from 'lexical';
import {expect, test, vi} from 'vitest';

import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  setup,
} from '../../utils/harness';

// #9694: a format write that restated another client's run at its range's
// end gave the run an end of its own after the end that client's change gave
// it, found by a clock-order scan that could return an item in another
// container. A colors the end of a table cell's text, clears one character
// there and colors a word in a paragraph; B then recolors part of the cell.
// No item the writer builds may have a neighbour in another container: it is
// checked as each item is integrated, so a write that throws cannot hide it.
for (const ids of [
  [1, 2],
  [2, 1],
]) {
  test(`#9694: a style write in a table cell links no item into another container (ids ${ids})`, async () => {
    const t = await setup(
      () => {
        $getRoot().append(
          $p('alpha one two three four five'),
          $p('gamma one two three four five'),
          $createTableNode().append(
            $createTableRowNode().append(
              $createTableCellNode(0).append($p('cell one')),
              $createTableCellNode(0).append($p('cell two three four five')),
            ),
          ),
        );
      },
      {ids},
    );
    const mismatches: string[] = [];
    const integrate = Y.Item.prototype.integrate;
    const spy = vi
      .spyOn(Y.Item.prototype, 'integrate')
      .mockImplementation(function (
        this: Y.Item,
        tr: Y.Transaction,
        offset: number,
      ) {
        // Inspect local insertions before Yjs can infer/replace their parent
        // from a neighbor. A post-transaction check misses that normalization.
        if (this.id.client === tr.doc.clientID) {
          for (const neighbor of [this.left, this.right]) {
            if (neighbor !== null && neighbor.parent !== this.parent) {
              mismatches.push(`${this.id.client}:${this.id.clock}`);
            }
          }
        }
        return integrate.call(this, tr, offset);
      });
    const $color = (
      path: number[],
      from: number,
      to: number,
      value: string | null,
    ) => {
      $patchStyleText($selectIn(path, from, to), {color: value});
      $setSelection(null);
    };
    try {
      t.offline();
      // A colors the second cell from offset 1 through its end.
      t.a.update(() =>
        $color(
          [2, 0, 1, 0],
          1,
          $block([2, 0, 1, 0]).getTextContentSize(),
          'blue',
        ),
      );
      // A clears the color on the "v" in the second cell's "five".
      t.a.update(() => $color([2, 0, 1, 0], 22, 23, null));
      // A colors "mma" in paragraph 1 (zero-based).
      t.a.update(() => $color([1], 2, 5, 'blue'));
      await t.sync();
      // B colors " fiv" in the second cell green.
      t.b.update(() => $color([2, 0, 1, 0], 19, 23, 'green'));
      await t.sync();
      expect(spy).toHaveBeenCalled();
      expect(mismatches).toEqual([]);
      await expectConverged(t.peers);
    } finally {
      spy.mockRestore();
      t.peers.forEach(peer => peer.stop());
    }
  });
}
