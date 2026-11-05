/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A wrapper whose class declares a JSON field named `0` (see
// catalog/coveredValues) stores its value as `{"0": 3}`, an object keyed by
// an array index. Only an array is an end, so it is a value: seeded, or
// written by an edit that wraps a word, the wrapper and its field reach
// every peer and a fresh reader, Layout3's pure reader shows the stored
// value over the word, and a peer's typing inside it keeps it (gc off and
// on, both client id orders).

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
} from 'lexical';
import {expect, test} from 'vitest';

import {
  $createNumericFieldWrapper,
  NumericFieldWrapperNode,
} from '../../catalog/coveredValues';
import {
  $selectIn,
  expectConverged,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../../utils/harness';
import {pureRead, rootOf} from '../../utils/rawFormats';

const KEY = 'w:numeric_field_wrapper';

/** The stored values of the wrapper's key in `peer`'s root, live ones. */
function storedValues(peer: Peer): unknown[] {
  const out: unknown[] = [];
  for (let it = rootOf(peer)._start; it; it = it.right) {
    if (
      !it.deleted &&
      it.content instanceof Y.ContentFormat &&
      it.content.key === KEY
    ) {
      out.push(it.content.value);
    }
  }
  return out;
}

/** The wrapper's field `0` in `peer`'s editor, or null without one. */
const zeroOf = (peer: Peer): number | null =>
  peer.read(() => {
    const wrapper = $getRoot()
      .getAllTextNodes()
      .map(n => n.getParent())
      .find(p => p instanceof NumericFieldWrapperNode);
    return wrapper instanceof NumericFieldWrapperNode
      ? wrapper.getLatest().__zero
      : null;
  });

for (const construction of ['seed', 'edit'] as const) {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      test(`a wrapper with a numeric field name round-trips (${construction}, gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                ...(construction === 'seed'
                  ? [
                      $createTextNode('before '),
                      $createNumericFieldWrapper($createTextNode('abc')),
                      $createTextNode(' after'),
                    ]
                  : [$createTextNode('before abc after')]),
              ),
            ),
          {gc, ids, nodes: [...NODES, NumericFieldWrapperNode]},
        );
        if (construction === 'edit') {
          t.a.update(() => {
            const [, word] = $getRoot().getAllTextNodes()[0].splitText(7, 10);
            const wrapper = $createNumericFieldWrapper();
            word.insertBefore(wrapper);
            wrapper.append(word);
            $setSelection(null);
          });
          await t.sync();
        }
        const expected =
          'paragraph("before " numeric_field_wrapper("abc") " after")';
        // Stored as an object keyed by an array index: an opener, read as
        // the wrapper's value over "abc".
        expect(storedValues(t.a).map(v => JSON.stringify(v))).toContain(
          '{"0":3}',
        );
        const read = pureRead(rootOf(t.a));
        for (const unit of [7, 8, 9]) {
          expect(read[unit][KEY]).toEqual({0: 3});
        }
        expect(read[6][KEY]).toBeUndefined();
        expect(read[10][KEY]).toBeUndefined();
        const fresh = await freshReader(t.a);
        for (const peer of [...t.peers, fresh]) {
          expect(peer.describe()).toBe(expected);
          expect(zeroOf(peer)).toBe(3);
        }
        expect(t.a.warnings.filter(w => /self-check/.test(w))).toEqual([]);
        await expectConverged([...t.peers, fresh], expected);
        // A peer types inside the wrapper: it keeps it.
        t.b.update(() => {
          $selectIn([0], 8, 8).insertText('X');
          $setSelection(null);
        });
        await t.sync();
        await expectConverged(
          t.peers,
          'paragraph("before " numeric_field_wrapper("aXbc") " after")',
        );
        for (const peer of t.peers) {
          expect(zeroOf(peer)).toBe(3);
        }
      });
    }
  }
}
