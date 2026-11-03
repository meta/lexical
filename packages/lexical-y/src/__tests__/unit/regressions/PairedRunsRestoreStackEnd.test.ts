/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $selectIn,
  expectConverged,
  freshReader,
  setup,
  WITH_GC,
} from '../../utils/harness';
import {setFormatIdentityWrites} from '../../utils/noSwitch';

// A value from an unpaired item (one written before paired runs, or an
// opener whose end has not arrived yet) outlives paired runs nested above it.
// A format change that deletes such an item inside its range and restores
// its value after the range must end the restore where the reader's stack
// rules end that value, not at the next item of its key; otherwise the
// author's editor keeps the value on text after the range while its document
// (and every peer) no longer has it.

async function legacyBoldThenPaired(ids: number[]) {
  // Written the way documents were before paired runs (no layout 3 yet).
  const t = await setup(
    () => {
      $getRoot().append(
        $createParagraphNode().append(
          $createTextNode('a'),
          $createTextNode('bcdef').setFormat('bold'),
        ),
      );
    },
    {gc: WITH_GC, ids},
  );
  for (const peer of t.peers) {
    setFormatIdentityWrites(peer.doc, true);
  }
  return t;
}

describe.each([
  [1, 2],
  [2, 1],
])('client ids %i, %i', (first, second) => {
  test('a restore of a deleted unpaired value ends where its run ends, past a nested paired run', async () => {
    const t = await legacyBoldThenPaired([first, second]);
    // b makes "d" plain: a paired run nested in the unpaired bold run.
    t.b.update(() => {
      $selectIn([0], 3, 4).formatText('bold', 0);
      $setSelection(null);
    });
    await t.sync();
    await expectConverged(t.peers, 'paragraph("a" "bc"{1} "d" "ef"{1})');
    // a makes "b" plain: the unpaired opener before "b" is inside the range.
    t.a.update(() => {
      $selectIn([0], 1, 2).formatText('bold', 0);
      $setSelection(null);
    });
    const expected = 'paragraph("ab" "c"{1} "d" "ef"{1})';
    expect(t.a.describe()).toBe(expected);
    expect((await freshReader(t.a)).describe()).toBe(expected);
    await t.sync();
    await expectConverged(t.peers, expected);
  });

  test('a deleted unpaired value under a paired run that opens right after the range comes back after that run', async () => {
    const t = await legacyBoldThenPaired([first, second]);
    // b makes "c" plain, right after the range a makes plain next.
    t.b.update(() => {
      $selectIn([0], 2, 3).formatText('bold', 0);
      $setSelection(null);
    });
    await t.sync();
    await expectConverged(t.peers, 'paragraph("a" "b"{1} "c" "def"{1})');
    t.a.update(() => {
      $selectIn([0], 1, 2).formatText('bold', 0);
      $setSelection(null);
    });
    const expected = 'paragraph("abc" "def"{1})';
    expect(t.a.describe()).toBe(expected);
    expect((await freshReader(t.a)).describe()).toBe(expected);
    await t.sync();
    await expectConverged(t.peers, expected);
  });
});
