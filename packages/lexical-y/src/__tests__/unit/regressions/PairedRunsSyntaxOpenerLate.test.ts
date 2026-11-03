/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Prototype A' (record-independent identity syntax), GPT window structural
// review 4: an end can integrate before the opener it names (a later update
// of the same writer merged with an earlier one around a gap, as a provider
// merging updates sends it: the missing clocks are a Skip). When the opener arrives (filling that Skip), the end pairs with it,
// which changes how everything between them reads although the arriving
// change does not touch it: the reader reads it again.

import * as Y from '@y/y';
import {$getRoot, $isTextNode, $setSelection, type TextNode} from 'lexical';
import {afterEach, beforeEach, expect, test} from 'vitest';

import {endsOf, endTarget} from '../../../internal/Ident';
import {$p, $selectIn, flush, freshReader, setup} from '../../utils/harness';
import {
  setFormatIdentityWrites,
  setFormatIdentityWritesDefault,
} from '../../utils/noSwitch';

beforeEach(() => setFormatIdentityWritesDefault(false));
afterEach(() => setFormatIdentityWritesDefault(false));

function $text(token: string): TextNode {
  const n = $getRoot()
    .getAllTextNodes()
    .find(x => x.getTextContent().includes(token));
  if (!n || !$isTextNode(n)) {
    throw new Error(`no ${token}`);
  }
  return n;
}

for (const gc of [false, true]) {
  for (const order of ['merged around a gap', 'reversed'] as const) {
    test(`a writer's later updates delivered before its earlier ones converge (${order}, gc ${gc ? 'on' : 'off'})`, async () => {
      const t = await setup(() => $getRoot().append($p('xyz'), $p('q')), {
        delivery: 'sender',
        gc,
        ids: [1, 2],
      });
      const [a, c] = t.peers;
      setFormatIdentityWrites(a.doc, true);
      // A records layout 3, bolds "xyz" (an opener and its end), then a
      // raw end on A's client names that opener after "y".
      a.update(() => {
        $selectIn([1], 0, 1).formatText('bold');
        $setSelection(null);
      });
      a.update(() => {
        $text('xyz').select(0, 3).formatText('bold');
        $setSelection(null);
      });
      // A raw end (an identity-syntax writer on A's client) naming the
      // bold's opener, after "y": it closes the run there (z is not bold).
      a.doc.transact(tr => {
        const root = a.doc.get('lexical-y');
        let text: Y.Item | null = null;
        for (let it = root._start; it !== null; it = it.right) {
          const str = (it.content as {str?: string}).str;
          if (!it.deleted && str !== undefined && str.includes('xyz')) {
            text = it;
            break;
          }
        }
        const at = (text!.content as unknown as {str: string}).str.indexOf('y');
        const left = Y.getItemCleanEnd(
          tr,
          a.doc.store,
          Y.createID(text!.id.client, text!.id.clock + at),
        );
        let opener: Y.Item | null = null;
        for (let it = root._start; it !== null && it !== left; it = it.right) {
          if (
            !it.deleted &&
            it.content instanceof Y.ContentFormat &&
            it.content.key === 'f:bold' &&
            it.content.value === true
          ) {
            opener = it;
          }
        }
        const client = a.doc.clientID;
        const clock = a.doc.store.getClock(client);
        const right = left.right;
        const end = new Y.Item(
          Y.createID(client, clock),
          left,
          left.lastId,
          right,
          right === null ? null : right.id,
          root,
          null,
          new Y.ContentFormat('f:bold', [clock - opener!.id.clock] as never),
        );
        end.integrate(tr, 0);
      }, 'raw');
      await flush();
      const list: Uint8Array[] = c.pending.get(a) ?? [];
      c.pending.delete(a);
      // Merged around a gap (as a provider that merges updates sends them):
      // A's first update and the raw end first, the bold (the opener) last.
      const updates =
        order === 'reversed'
          ? [...list].reverse()
          : [
              Y.mergeUpdates([list[0], list[list.length - 1]] as never),
              ...list.slice(1, -1),
            ];
      // C's end index exists before the end arrives (as on any client
      // that has read paired runs).
      const croot = c.doc.get('lexical-y');
      if (croot._start !== null) {
        endsOf(croot._start);
      }
      for (const u of updates) {
        Y.applyUpdate(c.doc, u, c.net);
        await flush();
      }
      // The raw end pairs with the opener that arrived after it.
      const raw = c.doc.store.clients.get(a.doc.clientID)!.at(-1) as Y.Item;
      const opener = c.doc.store.getItem(endTarget(raw)!) as Y.Item;
      expect(endsOf(opener)).toContain(raw);
      await t.sync();
      const fresh = await freshReader(c);
      expect(c.describe()).toBe(a.describe());
      expect(fresh.describe()).toBe(a.describe());
    });
  }
}
