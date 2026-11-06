/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
} from 'lexical';
import {expect, test} from 'vitest';

import {$block, $selectIn, flush, freshReader, setup} from '../utils/harness';

for (const ids of [
  [1, 2],
  [2, 1],
]) {
  for (const peerOp of ['delete-surviving-z', 'delete-discarded-tail']) {
    test(`split merge, later caret delete; ${peerOp}; ids=${ids}`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Title')),
            $createParagraphNode().append(
              $createTextNode('x z z '),
              $createTextNode('cut ').toggleFormat('bold'),
              $createTextNode('q z '),
              $createTextNode('end').toggleFormat('italic'),
            ),
          ),
        {ids},
      );
      t.offline();
      const wrote = {deleted: '', inserted: ''};
      t.a.doc.on('afterTransaction', (tr: Y.Transaction) => {
        if (!tr.local) return;
        Y.iterateStructsByIdSet(tr, tr.deleteSet, s => {
          if (s instanceof Y.Item && s.content instanceof Y.ContentString)
            wrote.deleted += s.content.str;
        });
        Y.iterateStructsByIdSet(tr, tr.insertSet, s => {
          if (s instanceof Y.Item && s.content instanceof Y.ContentString)
            wrote.inserted += s.content.str;
        });
      });
      let commits = 0;
      const off = t.a.editor.registerUpdateListener(({dirtyLeaves}) => {
        if (dirtyLeaves.size) commits++;
      });
      t.a.editor.update(() => {
        const ns = $selectIn([1], 4, 12).extract();
        $setSelection(null);
        for (const n of ns) n.remove();
      });
      t.a.editor.update(() => {
        $selectIn([1], 4, 6).removeText();
      });
      await flush();
      off();
      const pre = t.a.read(() => $block([1]).getTextContent());
      t.b.update(() => {
        if (peerOp === 'delete-surviving-z') $selectIn([1], 2, 3).removeText();
        else $selectIn([1], 12, 14).removeText();
      });
      await t.sync();
      const f = await freshReader(t.a);
      const result = {
        author: t.a.read(() => $block([1]).getTextContent()),
        commits,
        fresh: f.read(() => $block([1]).getTextContent()),
        peer: t.b.read(() => $block([1]).getTextContent()),
        pre,
        wrote,
      };
      expect(commits).toBe(1);
      expect(result.author).toBe(
        peerOp === 'delete-surviving-z' ? 'x  end' : 'x z end',
      );
      expect(result.peer).toBe(result.author);
      expect(result.fresh).toBe(result.author);
      for (const p of [...t.peers, f]) p.stop();
    });
  }
}
