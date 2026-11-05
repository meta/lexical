/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Whether an opener is paired (an end names it) decides how the items over
// its run step: an end removes the unpaired runs above the topmost paired
// run. A raw writer's plain bold over "two three / four" holds, in the
// second line, an end naming B's bold opener in the third (written raw,
// before its opener): while the plain bold is unpaired, that end removes it
// ("r" plain). An end naming the plain bold arrives from C, after the third
// line: the plain bold is paired from then on, and the end in the second
// line, which names no run on the stack, removes nothing ("four " bold).
// The second line's start holds the same run either way, so it was not
// read again: A and B showed "fou" bold and "r" plain while a fresh read
// of the same document showed "four " bold. Every line whose start holds
// the opener's run is now read again when its pairing changes.

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type ElementNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';
import {prepareMarkState} from '../../utils/sizeOps';

type Root = {
  format(at: number, length: number, attrs: object): void;
  getAttr(key: string): unknown;
};

const root = (p: Peer) => p.doc.get('lexical-y') as unknown as Root;

/** The live bold items of `p`'s document, in order. */
function boldItems(p: Peer): Y.Item[] {
  const out: Y.Item[] = [];
  for (
    let it = p.doc.get('lexical-y')._start;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    if (
      !it.deleted &&
      it.content instanceof Y.ContentFormat &&
      it.content.key === 'f:bold'
    ) {
      out.push(it);
    }
  }
  return out;
}

for (const gc of [false, true]) {
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ]) {
    test(`a run whose opener an end pairs again reads again over every line it covers (gc ${gc}, ids ${ids})`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two three')),
            $createParagraphNode().append($createTextNode('four five six')),
            $createParagraphNode().append($createTextNode('seven eight')),
          ),
        {gc, ids, prepare: prepareMarkState},
      );
      const {b, c} = t;
      expect(root(b).getAttr('lexical-y:3')).toBe(true);
      // A raw writer bolds "two three / four" with plain values.
      b.doc.transact(() => root(b).format(7, 12, {'f:bold': true}));
      await t.sync();
      const plain = boldItems(b).find(
        it => it.content.getContent()[0] !== null,
      )!;
      expect((plain.content as Y.ContentFormat).value).toBe(true);
      c.online = false;
      // B bolds "seven e" (a paired run).
      b.update(() => {
        const line = $getRoot().getChildren()[2] as ElementNode;
        line.getAllTextNodes()[0].select(0, 7).formatText('bold');
      });
      const opener = boldItems(b).find(
        it => it !== plain && (it.content as Y.ContentFormat).value === true,
      )!;
      // C, offline, writes an end naming the plain bold, after "seven".
      c.doc.transact(() =>
        root(c).format(36, 1, {
          'f:bold': [plain.id.client, plain.id.clock],
        }),
      );
      // B writes an end naming its own opener inside "four" (before it).
      b.doc.transact(() =>
        root(b).format(17, 1, {
          'f:bold': [opener.id.client, opener.id.clock],
        }),
      );
      await t.sync();
      c.online = true;
      await t.sync();
      await expectConverged(t.peers);
      for (const p of t.peers) {
        expect((await freshReader(p)).describe()).toBe(p.describe());
      }
      for (const p of t.peers) {
        p.stop();
      }
    });
  }
}
