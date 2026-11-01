/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A write that fails part way is recovered from: the document is rewritten
// from the editor. The rewrite wrote a changed line through the keystroke
// fast path, which writes the text edits Lexical recorded against the
// previous editor state; where the failed write had already stored such an
// edit, the rewrite stored it again: the other client showed the inserted
// text twice, and the author's editor no longer matched its own document.
// The rewrite diffs each line against the document instead. The failure is
// injected (the second item a cursor writes throws).

import {$getRoot} from 'lexical';
import {expect, test} from 'vitest';

import {Cursor} from '../../../internal/Cursor';
import {$p, $selectIn, freshReader, setup} from '../../utils/harness';

for (const ids of [
  [1, 2],
  [2, 1],
]) {
  test(`the rewrite after a failed write does not repeat what it stored (ids ${ids})`, async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $p('one alpha beta'),
          $p('two gamma delta'),
          $p('untouched words here'),
        ),
      {ids},
    );
    const proto = Cursor.prototype as unknown as {
      newItem: (...args: unknown[]) => unknown;
    };
    const newItem = proto.newItem;
    let calls = 0;
    proto.newItem = function (this: unknown, ...args: unknown[]) {
      if (++calls === 2) {
        throw new Error('injected failure');
      }
      return newItem.apply(this, args);
    };
    try {
      t.a.update(() => {
        $selectIn([0], 3).insertText(' INSERT');
        $selectIn([1], 3).insertText(' CHANGE');
      });
    } finally {
      proto.newItem = newItem;
    }
    expect(
      t.a.warnings.filter(w => w.includes('could not be written')),
    ).toHaveLength(1);
    await t.sync();
    const expected =
      'paragraph("one INSERT alpha beta") / paragraph("two CHANGE gamma delta") / paragraph("untouched words here")';
    for (const peer of t.peers) {
      expect(peer.describe()).toBe(expected);
      const fresh = await freshReader(peer);
      expect(fresh.describe()).toBe(expected);
      fresh.stop();
    }
    t.a.undo();
    await t.sync();
    for (const peer of t.peers) {
      expect(peer.describe()).toBe(
        'paragraph("one alpha beta") / paragraph("two gamma delta") / paragraph("untouched words here")',
      );
    }
  });
}

// The failed write and its rewrite are two transactions: a rewrite slower
// than the undo manager's capture timeout (a very long line) makes one edit
// two undo steps. An open question (D97): accept it as a limit, or join the
// two at the transaction level. A capture timeout of 0 stands for a rewrite
// slower than any timeout.
for (const ids of [
  [1, 2],
  [2, 1],
]) {
  test.fails(
    `D97: the rewrite after a failed write is in the same undo step (ids ${ids})`,
    async () => {
      const t = await setup(
        () => $getRoot().append($p('one alpha beta'), $p('two gamma delta')),
        {ids},
      );
      const um = t.a.binding.undoManager!;
      um.captureTimeout = 0;
      const steps = um.undoStack.length;
      const proto = Cursor.prototype as unknown as {
        newItem: (...args: unknown[]) => unknown;
      };
      const newItem = proto.newItem;
      let calls = 0;
      proto.newItem = function (this: unknown, ...args: unknown[]) {
        if (++calls === 2) {
          throw new Error('injected failure');
        }
        return newItem.apply(this, args);
      };
      try {
        t.a.update(() => {
          $selectIn([0], 3).insertText(' INSERT');
          $selectIn([1], 3).insertText(' CHANGE');
        });
      } finally {
        proto.newItem = newItem;
      }
      expect(
        t.a.warnings.filter(w => w.includes('could not be written')),
      ).toHaveLength(1);
      expect(um.undoStack.length).toBe(steps + 1);
    },
  );
}
