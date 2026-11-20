/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A plain null a raw writer stored under a covered name (an unpaired
// clearer: raw writes are unsupported, D109, and read as such) can follow a
// paired run's end, before the next text. Text typed there goes past the
// end and the clearer when together they give it its formats, and writes no
// format item (Cursor#stepsToGivingPosition): also at the end of the typing
// client's own run, where it otherwise stays inside the run
// (Cursor#minimizeFormatChanges). Garbage collection on and off, both
// client id orders.

import {$createTextNode, $getRoot, $setSelection} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  setup,
} from '../../utils/harness';
import {storeBefore} from '../../utils/rawFormats';

const GC = [true, false];
const PAIRS = [
  [1, 2],
  [2, 1],
];

describe('typed text goes past a run end and a raw clearer that give it its formats', () => {
  for (const gc of GC) {
    for (const ids of PAIRS) {
      // A bolds "abcd" while B, offline, bolds "ab": B's run is inside A's.
      // A raw clearer of bold right after B's end: "cd" is not bold. A types
      // plain "Z" after "ab": past B's end (bold again, from A's run) and
      // the clearer (not bold), no item written.
      test(`plain text after another client's run end (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(() => $getRoot().append($p('abcd efgh')), {
          gc,
          ids,
        });
        const [a, b] = t.peers;
        t.offline();
        a.update(() => $selectIn([0], 0, 4).formatText('bold'));
        b.update(() => $selectIn([0], 0, 2).formatText('bold'));
        await t.sync();
        storeBefore(a, 'cd', 'f:bold', null);
        await t.sync();
        expect(a.describe()).toBe('paragraph("ab"{1} "cd efgh")');
        a.update(() => {
          $selectIn([0], 2, 2).insertNodes([$createTextNode('Z')]);
          $setSelection(null);
        });
        await t.sync();
        await expectConverged(t.peers);
        expect(a.describe()).toBe('paragraph("ab"{1} "Zcd efgh")');
        expect((await freshReader(a)).describe()).toBe(a.describe());
      });
      // "abcd" italic; B bolds "abcd" while A, offline, bolds "ab" (A's
      // own run inside B's); a raw clearer of italic right after A's end.
      // A types bold "Z" at the end of its own run: past its own end (bold,
      // from B's run) and the clearer (not italic), no item written.
      test(`bold text at the end of one's own bold run (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(() => $getRoot().append($p('abcd efgh')), {
          gc,
          ids,
        });
        const [a, b] = t.peers;
        a.update(() => $selectIn([0], 0, 4).formatText('italic'));
        await t.sync();
        t.offline();
        b.update(() => $selectIn([0], 0, 4).formatText('bold'));
        a.update(() => $selectIn([0], 0, 2).formatText('bold'));
        await t.sync();
        storeBefore(a, 'cd', 'f:italic', null);
        await t.sync();
        expect(a.describe()).toBe('paragraph("ab"{3} "cd"{1} " efgh")');
        a.update(() => {
          $selectIn([0], 2, 2).insertNodes([
            $createTextNode('Z').setFormat('bold'),
          ]);
          $setSelection(null);
        });
        await t.sync();
        await expectConverged(t.peers);
        expect(a.describe()).toBe('paragraph("ab"{3} "Zcd"{1} " efgh")');
        expect((await freshReader(a)).describe()).toBe(a.describe());
      });
    }
  }
});
