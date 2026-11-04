/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Reproductions of malformed and raw-writer shapes, as written, where the cells of the
// fixes use other shapes: item 2 (an end before its opener, then a plain
// null, an orphan end and text: the text plain) and item 4 (a raw array this
// client stored below layout 3 on an array-valued NodeState named with
// U+001F; an upgrade by formatting another paragraph: the existing editor
// and a fresh reader agree).

import * as Y from '@y/y';
import {$getRoot, $setSelection} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc} from '../../..';
import {
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';

const rootOf = (peer: Peer) => peer.doc.get('lexical-y');

const runs = (peer: Peer, line: number) =>
  (
    peer.json().root.children[line] as unknown as {
      children: {text: string; format: number}[];
    }
  ).children.map(c => [c.text, c.format]);

for (const gc of [false, true]) {
  test(`an end before its opener, a plain null, an orphan end, text (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(() => $getRoot().append($p('t'), $p('q')), {gc});
    // A paired write on the second line records layout 3.
    t.a.update(() => {
      $selectIn([1], 0, 1).formatText('italic');
      $setSelection(null);
    });
    await t.sync();
    expect(rootOf(t.a).getAttr('lexical-y:3')).toBe(true);
    // A raw writer's document (createYDoc: no Yjs format cleanup).
    const raw = createYDoc(null, {gc});
    raw.clientID = 777;
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(t.a.doc));
    const root = raw.get('lexical-y');
    // O x null t, then x deleted: O, a plain null, then "t".
    raw.transact(() => root.insert(0, 'x'));
    raw.transact(() => root.format(0, 1, {'f:bold': true}));
    raw.transact(() => root.delete(0, 1));
    let o: Y.Item | null = null;
    for (const s of raw.store.clients.get(777) ?? []) {
      if (
        s instanceof Y.Item &&
        s.content instanceof Y.ContentFormat &&
        s.content.value === true
      ) {
        o = s;
      }
    }
    expect(o).not.toBeNull();
    // An orphan end right before "t" (it names no item).
    raw.transact(() => root.format(0, 1, {'f:bold': [999999, 999]}));
    // An end before O, naming O, before a new "w" at the line's start.
    raw.transact(() => root.insert(0, 'w'));
    raw.transact(() =>
      root.format(0, 1, {'f:bold': [o!.id.client, o!.id.clock]}),
    );
    Y.applyUpdate(
      t.a.doc,
      Y.encodeStateAsUpdate(raw, Y.encodeStateVector(t.a.doc)),
    );
    await t.sync();
    // The end before O is a clearer; O is unpaired, and the null after it
    // ends its run; the orphan end is a clearer: "w" and "t" plain.
    const fresh = await freshReader(t.a);
    for (const peer of [fresh, t.a, t.b]) {
      expect(runs(peer, 0)).toEqual([['wt', 0]]);
    }
    await expectConverged([...t.peers, fresh]);
  });
}
