/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Stored states whose migration splits material out (see
// migrateYState's `pending`).

import * as Y from '@y/y';
import {expect} from 'vitest';

import {createYDoc} from '../../server';

export function docAt(client: number, gc: boolean, state?: Uint8Array): Y.Doc {
  const d = createYDoc(state ?? null, {gc});
  d.clientID = client;
  return d;
}

export function textOf(node: Y.Node): string {
  let out = '';
  for (let it = node._start; it !== null; it = it.right) {
    if (!it.deleted && it.content instanceof Y.ContentString) {
      out += it.content.str;
    }
  }
  return out;
}

/**
 * The right-origin split of code review round 1: G (client 333) has its
 * left origin in client 100 and its right origin in client 222's suffix
 * past a gap (client 222's first update, `missing`, never arrived); S is a
 * later item of 333 in another root. The stored state and the missing
 * prefix.
 */
export function rightOriginSplit(gc: boolean): {
  stored: Uint8Array;
  missing: Uint8Array;
  docs: Y.Doc[];
} {
  const base = docAt(100, gc);
  const root = base.get('lexical-y');
  root.setAttr('lexical-y:2', true);
  root.setAttr('lexical-y-schema:1', true);
  root.insert(0, 'base');
  const start = Y.encodeStateAsUpdate(base);
  const c = docAt(222, gc, start);
  const cu: Uint8Array[] = [];
  c.on('update', (u: Uint8Array) => cu.push(u));
  c.get('unseen').insert(0, 'missing');
  c.get('lexical-y').insert(4, 'LATE');
  const stored = docAt(300, gc, start);
  Y.applyUpdate(stored, cu[1]);
  const d = docAt(333, gc, Y.encodeStateAsUpdate(stored));
  const du: Uint8Array[] = [];
  d.on('update', (u: Uint8Array) => du.push(u));
  d.get('lexical-y').insert(4, 'G');
  d.get('side').insert(0, 'S');
  du.forEach(u => Y.applyUpdate(stored, u));
  const g = stored.store.getItem(Y.createID(333, 0));
  expect(g.origin?.client).toBe(100);
  expect(g.rightOrigin?.client).toBe(222);
  return {
    docs: [base, c, stored, d],
    missing: cu[0],
    stored: Y.encodeStateAsUpdate(stored),
  };
}
