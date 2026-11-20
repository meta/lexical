/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A, whose editor renders, composes `abc` in an inline container in a list
// item (or straight in the item's text); B types R in it, which A's hold
// keeps back. A's local edit moves the item, into the other list, nested,
// or unwraps the container. The binding refuses the edit before it writes
// anything (it would delete R, or leave it behind) and A's editor reads the
// document again: the edit is undone on A, and A's editor state equals every
// peer's and a fresh reader's, in full JSON, with R where it was, once the
// composition ends.

import {$create, $createTextNode, $getRoot, $setCompositionKey} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

import {
  $composed,
  $listDocument,
  $relocate,
  composing,
  GCS,
  held,
  HoldBox,
  ORDERS,
  type Relocation,
} from '../../utils/composeHold';
import {freshReader, shape} from '../../utils/harness';

const CASES: [Relocation, 'box' | 'line'][] = [
  ['move', 'box'],
  ['other list', 'box'],
  ['nest', 'box'],
  ['unwrap', 'box'],
  ['move', 'line'],
  ['other list', 'line'],
  ['nest', 'line'],
];

describe('a refused edit under a composer hold reverts on the editing client', () => {
  for (const gc of GCS) {
    for (const ids of ORDERS) {
      for (const [relocation, where] of CASES) {
        test(`the refused ${relocation} (${where}) is undone on the editing client, which then equals every peer and a fresh reader in full (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await composing(
            () =>
              $listDocument(() => [
                where === 'box'
                  ? $create(HoldBox).append($createTextNode('abc'))
                  : $createTextNode('abc'),
              ]),
            gc,
            ids,
          );
          await held(t, () => $composed().spliceText(1, 0, 'R'));
          const before = shape(t.b);
          t.a.update(() => $relocate(relocation));
          await t.sync();
          expect(t.a.warnings).toHaveLength(1);
          expect(t.a.warnings[0]).toContain(
            'would delete or leave behind text a collaborator wrote in the line being composed',
          );
          t.a.warnings.length = 0;
          // The edit is undone; once the composition ends (while it lasts,
          // A keeps the composed node at its length, see Reader#composedAt),
          // A's editor state is what is stored.
          const text = (p: typeof t.a) =>
            p.read(() => $getRoot().getTextContent());
          expect(text(t.a)).toBe(text(t.b));
          t.a.update(() => $setCompositionKey(null));
          await t.sync();
          expect(shape(t.a)).toEqual(before);
          for (const p of t.peers) {
            expect(shape(p)).toEqual(before);
          }
          const fresh = await freshReader(t.a);
          onTestFinished(() => fresh.stop());
          expect(shape(fresh)).toEqual(before);
          expect(t.a.describe()).toContain('aRbc');
          expect(t.a.warnings).toEqual([]);
        });
      }
    }
  }
});
