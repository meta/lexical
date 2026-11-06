/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// An end that arrives before the opener it names waits for it in the
// document's index of ends. When that end is deleted and garbage collected
// before the opener arrives, its item no longer holds a format: noting it
// again once the opener arrives read its value as an end's and threw
// (`Cannot read properties of undefined`), from the copy repair that runs
// before every transaction's observers, so the opener's update could not be
// applied. An end collected while it waited is now passed over.

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $setSelection,
  type RangeSelection,
} from 'lexical';
import {expect, test} from 'vitest';

import {createYDoc} from '../../..';
import {$selectIn, setup} from '../../utils/harness';

for (const ids of [
  [1, 2, 3],
  [3, 2, 1],
]) {
  test(`an end collected while it waits for its opener is passed over when the opener arrives (ids ${ids})`, async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('one two three')),
        ),
      {gc: true, ids: [ids[0]]},
    );
    const {a} = t;
    // A's own paired run (A reads ends through its index of them).
    a.update(() => {
      $selectIn([0], 4, 7);
      ($getSelection() as RangeSelection).formatText('italic');
      $setSelection(null);
    });
    const writer = (client: number) => {
      const doc = createYDoc(null, {gc: false});
      doc.clientID = client;
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(a.doc));
      return doc;
    };
    const w1 = writer(ids[1]);
    const w2 = writer(ids[2]);
    const root = (doc: Y.Doc) =>
      doc.get('lexical-y') as unknown as {
        _start: Y.Item | null;
        format(at: number, length: number, attrs: object): void;
      };
    // W1 opens a bold run over "one" (its opener has not reached A).
    const before1 = Y.encodeStateVector(w1);
    root(w1).format(0, 3, {'f:bold': true});
    const opener = (() => {
      for (
        let it = root(w1)._start;
        it !== null;
        it = it.right as Y.Item | null
      ) {
        if (
          it.content instanceof Y.ContentFormat &&
          it.content.value === true
        ) {
          return it;
        }
      }
      throw new Error('no opener');
    })();
    const openerUpdate = Y.encodeStateAsUpdate(w1, before1);
    // W2 stores an end naming W1's opener, away from it: A integrates it
    // and notes it as waiting.
    let sv = Y.encodeStateVector(w2);
    root(w2).format(8, 1, {'f:bold': [opener.id.client, opener.id.clock]});
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(w2, sv), 'provider');
    // W2 deletes the end; A collects it.
    sv = Y.encodeStateVector(w2);
    w2.transact(tr => {
      for (
        let it = root(w2)._start;
        it !== null;
        it = it.right as Y.Item | null
      ) {
        if (
          it.content instanceof Y.ContentFormat &&
          Array.isArray(it.content.value)
        ) {
          it.delete(tr);
        }
      }
    });
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(w2, sv), 'provider');
    // The opener arrives.
    expect(() => Y.applyUpdate(a.doc, openerUpdate, 'provider')).not.toThrow();
    expect(a.errors).toEqual([]);
    expect(a.read(() => $getRoot().getTextContent())).toBe('one two three');
  });
}
