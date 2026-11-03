/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// An undo that brings back two values ending at the same place writes an end
// of its own for each where a collaborator's end is gone (closeRestoredRuns).
// A bolds and italicizes "word"; B removes both in one step; A's bold end is
// deleted (by id, as the other restore-end tests do), its italic end stays;
// B undoes. The second key must not read the first key's new null as a
// change of the gap and skip its own: when A's italic end goes later, italic
// would run on over " plain tail".

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {$block, $selectIn, freshReader, setup} from '../../utils/harness';

for (const gc of [false, true]) {
  test(`an undo restoring two values at one place ends both (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('word plain tail')),
        ),
      {ids: [1001, 1002, 1003]},
    );
    t.peers.forEach(p => (p.doc.gc = gc));
    const $formats = () =>
      ($block([0]).getAllTextNodes() as TextNode[]).map(n => [
        n.getTextContent(),
        n.getFormat(),
      ]);
    try {
      t.a.update(() => {
        const s = $selectIn([0], 0, 4);
        s.formatText('bold', 1);
        s.formatText('italic', 2);
        $setSelection(null);
      });
      await t.sync();
      let boldEnd: Y.ID | null = null;
      let italicEnd: Y.ID | null = null;
      for (let it = t.a.doc.get('lexical-y')._start; it; it = it.right) {
        if (
          it.content instanceof Y.ContentFormat &&
          it.content.value === null
        ) {
          if (it.content.key === 'f:bold') {
            boldEnd = it.id;
          } else if (it.content.key === 'f:italic') {
            italicEnd = it.id;
          }
        }
      }
      expect(boldEnd).not.toBeNull();
      expect(italicEnd).not.toBeNull();
      t.b.update(() => {
        const s = $selectIn([0], 0, 4);
        s.formatText('bold', 0);
        s.formatText('italic', 0);
        $setSelection(null);
      });
      await t.sync();
      t.a.doc.transact(tr =>
        (t.a.doc.store.getItem(boldEnd!) as Y.Item).delete(tr),
      );
      await t.sync();
      t.b.undo();
      await t.sync();
      t.a.doc.transact(tr =>
        (t.a.doc.store.getItem(italicEnd!) as Y.Item).delete(tr),
      );
      await t.sync();
      for (const peer of t.peers) {
        expect(peer.read($formats)).toEqual([
          ['word', 3],
          [' plain tail', 0],
        ]);
      }
      const fresh = await freshReader(t.b);
      expect(fresh.read($formats)).toEqual([
        ['word', 3],
        [' plain tail', 0],
      ]);
      fresh.stop();
    } finally {
      t.peers.forEach(p => p.stop());
    }
  });
}
