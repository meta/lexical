/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Dormant runs (a formats map's runs of no value, kept in one persistent
// map): snapshots keep colliding keys apart and pair late ends.
import * as Y from '@y/y';
import {expect, test} from 'vitest';

import {createYDoc} from '../..';
import {
  equalStacks,
  isOnStack,
  isPaired,
  isShadowKey,
  keySlice,
  stepFormat,
  STORED_FOLD,
} from '../../internal/Ident';

const A = 's:markIds\u001f1d2sq0r_mqva3i';
const B = 's:markIds\u001f6u1ymz_1ivs4e6';
function same(a: Map<string, unknown>, b: Map<string, unknown>) {
  expect(a.size).toBe(b.size);
  for (const [k, v] of a)
    expect(isShadowKey(k) ? equalStacks(v, b.get(k)) : v === b.get(k)).toBe(
      true,
    );
}
for (const gc of [false, true])
  test(`dormant snapshots retain colliding keys and late pairing gc=${gc}`, () => {
    const doc = createYDoc(null, {gc});
    doc.clientID = 17;
    const root = doc.get('c');
    root.setAttr('lexical-y:5', true);
    function append(key: string, value: unknown) {
      let result: Y.Item | undefined;
      doc.transact(tr => {
        let left = root._start;
        while (left?.right) left = left.right;
        result = new Y.Item(
          Y.createID(17, doc.store.getClock(17)),
          left,
          left && left.lastId,
          null,
          null,
          root,
          null,
          new Y.ContentFormat(key, value as object),
        );
        result.integrate(tr, 0);
      });
      return result!;
    }
    const items = [
      A,
      B,
      ...Array.from({length: 300}, (_, i) => 'f:custom' + i),
    ].map(k => append(k, null));
    const fold = () => {
      const m = new Map<string, unknown>();
      for (let it = root._start; it; it = it.right)
        if (!it.deleted && it.content instanceof Y.ContentFormat)
          stepFormat(m, it, STORED_FOLD);
      return m;
    };
    const first = fold();
    const copy = new Map(first);
    same(first, fold());
    for (const it of items) {
      expect(
        isOnStack(
          copy,
          (it.content as Y.ContentFormat).key,
          it.id.client,
          it.id.clock,
        ),
      ).toBe(true);
      expect(
        isOnStack(
          keySlice(copy, (it.content as Y.ContentFormat).key),
          (it.content as Y.ContentFormat).key,
          it.id.client,
          it.id.clock,
        ),
      ).toBe(true);
    }
    const positive = append(A, true);
    stepFormat(first, positive, STORED_FOLD);
    expect(isOnStack(first, A, items[0].id.client, items[0].id.clock)).toBe(
      false,
    );
    expect(isOnStack(first, B, items[1].id.client, items[1].id.clock)).toBe(
      true,
    );
    expect(isOnStack(copy, A, items[0].id.client, items[0].id.clock)).toBe(
      true,
    );
    same(first, fold());
    const end = append(A, [items[0].id.client, items[0].id.clock]);
    expect(isPaired(items[0], STORED_FOLD)).toBe(true);
    const sim = keySlice(copy, A);
    stepFormat(sim, positive, STORED_FOLD);
    expect(isOnStack(sim, A, items[0].id.client, items[0].id.clock)).toBe(true);
    stepFormat(sim, end, STORED_FOLD);
    expect(isOnStack(sim, A, items[0].id.client, items[0].id.clock)).toBe(
      false,
    );
    expect(isOnStack(copy, A, items[0].id.client, items[0].id.clock)).toBe(
      true,
    );
    doc.destroy();
  });
