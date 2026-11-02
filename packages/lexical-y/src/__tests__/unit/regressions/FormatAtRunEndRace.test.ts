/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// D100 (accepted limit, #9589): B bolds "bcde" of "abcdefgh". Offline, A
// removes bold from "bc" (or types plain "X" inside the run) while C bolds
// "fg", starting where B's bold ends. A's write ends the run's value right
// after its end, and C's opener has the same neighbours; Yjs orders the two
// by client id, so with A's id above C's, "fg" loses C's bold on every
// client. No text is lost. `test.fails` marks the orders that lose it.
import {$getRoot, $setSelection, type TextNode} from 'lexical';
import {expect, test} from 'vitest';

import {$p, $selectIn, expectConverged, setup} from '../../utils/harness';

const IDS = [
  [1, 2, 3],
  [3, 2, 1],
  [2, 3, 1],
  [1, 3, 2],
  [2, 1, 3],
  [3, 1, 2],
];

for (const how of ['remove', 'type'] as const) {
  for (const ids of IDS) {
    for (const gc of [false, true]) {
      // ids are [A, B, C]
      const loses = ids[0] > ids[2];
      (loses ? test.fails : test)(
        `C's bold after B's run, A ${how === 'remove' ? 'unbolds part of the run' : 'types plain text in the run'} (ids ${ids}, gc ${gc ? 'on' : 'off'})`,
        async () => {
          const t = await setup(() => $getRoot().append($p('abcdefgh')), {
            gc,
            ids,
          });
          try {
            const [a, b, c] = t.peers;
            b.update(() => {
              $selectIn([0], 1, 5).formatText('bold');
              $setSelection(null);
            });
            await t.sync();
            t.offline();
            a.update(() => {
              if (how === 'remove') {
                const s = $selectIn([0], 1, 3);
                s.format = 1;
                s.formatText('bold');
              } else {
                const s = $selectIn([0], 3, 3);
                s.format = 0;
                s.insertText('X');
              }
              $setSelection(null);
            });
            c.update(() => {
              $selectIn([0], 5, 7).formatText('bold');
              $setSelection(null);
            });
            await t.sync();
            await expectConverged(t.peers);
            const fg = a.read(() =>
              $getRoot()
                .getAllTextNodes()
                .filter((n: TextNode) => /[fg]/.test(n.getTextContent())),
            );
            expect(fg.length).toBeGreaterThan(0);
            expect(a.read(() => fg.every(n => n.hasFormat('bold')))).toBe(true);
          } finally {
            t.peers.forEach(p => p.stop());
          }
        },
      );
    }
  }
}
