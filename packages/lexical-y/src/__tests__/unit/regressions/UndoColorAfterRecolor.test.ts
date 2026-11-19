/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Undoing a color while a collaborator recolors part of its range: A colors
// "abc" red, B recolors "b" blue, A undoes its color. On main the value B's
// change restated after "b" (red) stays on "c" (DECISIONS D64); with paired
// runs A's undo removes exactly its own run, so "c" ends plain and "b" keeps
// B's blue, in both client id orders, gc off and on.

import {$patchStyleText} from '@lexical/selection';
import {$getRoot, $getSelection, $setSelection} from 'lexical';
import {expect, test} from 'vitest';

import {$p, $selectIn, expectConverged, setup} from '../../utils/harness';

const color =
  (path: number[], start: number, end: number, value: string) => () => {
    $selectIn(path, start, end);
    $patchStyleText($getSelection()!, {color: value});
    $setSelection(null);
  };

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`undoing a color after a collaborator recolored part of it leaves the rest plain (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
      const t = await setup(() => $getRoot().append($p('x abc y')), {gc, ids});
      t.a.update(color([0], 2, 5, 'red'));
      await t.sync();
      t.b.update(color([0], 3, 4, 'blue'));
      await t.sync();
      t.a.undo();
      await t.sync();
      await expectConverged(t.peers);
      const styles = t.a.read(() =>
        $getRoot()
          .getAllTextNodes()
          .map(n => [n.getTextContent(), n.getStyle()]),
      );
      expect(styles).toEqual([
        ['x a', ''],
        ['b', 'color: blue;'],
        ['c y', ''],
      ]);
    });
  }
}
