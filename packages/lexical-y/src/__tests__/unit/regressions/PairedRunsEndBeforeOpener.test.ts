/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A valid end names an opener before it. The index of ends and the
// validity check tested the end's target, key and container, not its
// order: a raw writer's end stored before the opener it names made that
// opener paired, so a later plain null (which replaces unpaired runs only)
// left the run open to the end of the line.
// Such an end is a clearer, and the opener stays unpaired.

import * as Y from '@y/y';
import {$getRoot, $setSelection} from 'lexical';
import {expect, test} from 'vitest';

import {isValidEnd, liveEndsOf, STORED_FOLD} from '../../../internal/Ident';
import {
  $p,
  $selectIn,
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';

const rootOf = (peer: Peer) => peer.doc.get('lexical-y');

/** The first line's text runs: [text, format]. */
const runs = (peer: Peer) =>
  (
    peer.json().root.children[0] as unknown as {
      children: {text: string; format: number}[];
    }
  ).children.map(c => [c.text, c.format]);

for (const gc of [false, true]) {
  test(`an end stored before the opener it names is a clearer (gc ${gc ? 'on' : 'off'})`, async () => {
    const t = await setup(() => $getRoot().append($p('xyz'), $p('q')), {gc});
    // A paired write on the second line records layout 3.
    t.a.update(() => {
      $selectIn([1], 0, 1).formatText('italic');
      $setSelection(null);
    });
    await t.sync();
    expect(rootOf(t.a).getAttr('lexical-y:4')).toBe(true);
    // A raw writer: an unpaired bold opener O on "y" (with the null after
    // it), then an end before "x" that names O (with the null after "x").
    const raw = new Y.Doc({gc});
    raw.clientID = 777;
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(t.a.doc));
    const root = raw.get('lexical-y');
    raw.transact(() => root.format(1, 1, {'f:bold': true}));
    let opener: Y.Item | null = null;
    for (const s of raw.store.clients.get(777) ?? []) {
      if (
        s instanceof Y.Item &&
        s.content instanceof Y.ContentFormat &&
        s.content.value === true
      ) {
        opener = s;
      }
    }
    expect(opener).not.toBeNull();
    raw.transact(() =>
      root.format(0, 1, {'f:bold': [opener!.id.client, opener!.id.clock]}),
    );
    Y.applyUpdate(
      t.a.doc,
      Y.encodeStateAsUpdate(raw, Y.encodeStateVector(t.a.doc)),
    );
    await t.sync();
    // The end before O is no end of O: a clearer. O has no end.
    let end: Y.Item | null = null;
    let o: Y.Item | null = null;
    for (const st of t.a.doc.store.clients.get(777) ?? []) {
      if (st instanceof Y.Item && st.content instanceof Y.ContentFormat) {
        if (Array.isArray(st.content.value)) {
          end = st;
        } else if (st.content.value === true) {
          o = st;
        }
      }
    }
    expect(isValidEnd(end!, STORED_FOLD)).toBe(false);
    expect(liveEndsOf(o!, STORED_FOLD)).toEqual([]);
    // "y" in O's unpaired run; the null after it replaces that run.
    const fresh = await freshReader(t.a);
    for (const peer of [fresh, t.a, t.b]) {
      expect(runs(peer)).toEqual([
        ['x', 0],
        ['y', 1],
        ['z', 0],
      ]);
    }
    await expectConverged([...t.peers, fresh]);
  });
}
