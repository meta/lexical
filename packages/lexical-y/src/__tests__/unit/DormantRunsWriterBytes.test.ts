/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Dormant runs are a representation only: the writer's bytes at each
// step of a session are pinned.
import * as Y from '@y/y';
import {$getRoot, $setSelection} from 'lexical';
import {createHash} from 'node:crypto';
import {expect, test} from 'vitest';

import {$p, $selectIn, flush, freshReader, setup} from '../utils/harness';
import {prepareMarkState} from '../utils/sizeOps';

// Layout 4: the session's documents record `lexical-y:5` alone (layout 3's
// recorded 1, 2 and 3), which moves every clock after the records. The
// writer's items are otherwise the same: layout 3's writer, made to write
// layout 4's records and nothing else, gives this digest too (it was
// 31116590…f72b8 with layout 3's records).
const DIGEST: Record<string, string> = {
  false: '90d58b2a48e7f7f31394ffff3f608f8b580bcb2eea3d8344a61b6e1b4112aae6',
  true: '90d58b2a48e7f7f31394ffff3f608f8b580bcb2eea3d8344a61b6e1b4112aae6',
};

for (const gc of [false, true])
  test(`dormant runs preserve writer output gc=${gc}`, async () => {
    const t = await setup(() => $getRoot().append($p('abcdef'), $p('uvwxyz')), {
      gc,
      ids: [101, 202],
      prepare: prepareMarkState,
    });
    const root = t.a.binding.root;
    let nullable: Y.Item | undefined;
    t.a.doc.transact(tr => {
      const right = root._start;
      let left: Y.Item | null = null;
      const keys = [
        'f:bold',
        'f:italic',
        'p:style',
        't',
        'k',
        ...Array.from({length: 350}, (_, i) => 's:markIds\u001fc' + i),
        's:markIds\u001f1d2sq0r_mqva3i',
        's:markIds\u001f6u1ymz_1ivs4e6',
      ];
      for (const key of keys) {
        const item: Y.Item = new Y.Item(
          Y.createID(101, t.a.doc.store.getClock(101)),
          left,
          left && left.lastId,
          right,
          right && right.id,
          root,
          null,
          new Y.ContentFormat(key, null as never),
        );
        item.integrate(tr, 0);
        left = item;
        if (key === 'f:bold') nullable = item;
      }
    }, 'raw');
    await t.sync();
    const snapshots: string[] = [];
    async function check() {
      await t.sync();
      const fresh = await freshReader(t.a);
      expect(fresh.describe()).toBe(t.a.describe());
      expect(t.a.describe()).toBe(t.b.describe());
      snapshots.push(
        Buffer.from(Y.encodeStateAsUpdate(t.a.doc)).toString('base64'),
      );
      fresh.binding.dispose();
    }
    await check();
    t.a.update(() => {
      $selectIn([0], 1, 4).formatText('bold');
      $setSelection(null);
    });
    await check();
    t.b.update(() => {
      $selectIn([0], 2, 3).formatText('italic');
      $setSelection(null);
    });
    await check();
    t.a.update(() => {
      $selectIn([0], 1, 1).insertText('X');
      $setSelection(null);
    });
    await check();
    t.b.update(() => {
      $selectIn([1], 0, 0).insertParagraph();
      $setSelection(null);
    });
    await check();
    t.a.undo();
    await check();
    t.a.binding.redo();
    await check();
    t.a.update(() => {
      $selectIn([0], 0, 2).removeText();
      $setSelection(null);
    });
    await check();
    t.a.undo();
    await check();
    t.a.doc.transact(tr => {
      let left = root._start!;
      while (left.right) left = left.right;
      const end = new Y.Item(
        Y.createID(101, t.a.doc.store.getClock(101)),
        left,
        left.lastId,
        null,
        null,
        root,
        null,
        new Y.ContentFormat('f:bold', [
          nullable!.id.client,
          nullable!.id.clock,
        ] as never),
      );
      end.integrate(tr, 0);
    }, 'raw');
    await check();
    const nodeState = t.a.json();
    t.a.binding.dispose();
    t.a.binding.start();
    await flush();
    expect(t.a.json()).toEqual(nodeState);
    await check();
    // The writer's bytes at each step, pinned: the same with the dormant
    // runs as with every run in its own slot (representation only).
    const digest = createHash('sha256')
      .update(JSON.stringify(snapshots))
      .digest('hex');
    expect(digest).toBe(DIGEST[String(gc)]);
    expect(t.a.warnings.filter(w => /self-check/.test(w))).toEqual([]);
    t.peers.forEach(p => p.binding.dispose());
  });
