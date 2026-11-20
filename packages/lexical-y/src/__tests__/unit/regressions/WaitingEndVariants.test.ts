/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Variants of an end that waits for its opener in the document's index of
// ends and is collected before the opener arrives (see
// WaitingEndCollected.test.ts): gc on and off on the receiver, and with the
// receiver's own runs kept or not. Every variant applies the opener's update
// and reads as a fresh reader does.

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

for (const gc of [false, true]) {
  for (const kept of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      test(`an end removed while it waits for its opener leaves the opener's update readable (ids ${ids}, gc ${gc}, kept ${kept})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('one two three')),
            ),
          {gc, ids: [ids[0]]},
        );
        const {a} = t;
        const app = kept
          ? new Y.UndoManager(a.doc, {
              captureTimeout: 0,
              trackedOrigins: new Set(['provider']),
            })
          : null;
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
        expect(() =>
          Y.applyUpdate(a.doc, openerUpdate, 'provider'),
        ).not.toThrow();
        expect(a.errors).toEqual([]);
        expect(a.read(() => $getRoot().getTextContent())).toBe('one two three');
        app?.destroy();
      });
    }
  }
}
