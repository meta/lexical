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
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof Y.ContentString) {
      out += it.content.str;
    } else if (it.content instanceof Y.ContentType) {
      out += textOf(it.content.type as Y.Node);
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

/** The migration's own clients: those that wrote the record and epoch. */
function epochClients(doc: Y.Doc): Set<number> {
  const out = new Set<number>();
  doc.share.forEach(type => {
    const node = type as Y.Node;
    const epoch = node.getAttr('lexical-y-epoch') as {client?: number} | null;
    if (epoch !== null && typeof epoch === 'object' && epoch.client) {
      out.add(epoch.client);
    }
  });
  return out;
}

/** Where an item lives: its root's name or its parent item's id, and key. */
function placeOf(doc: Y.Doc, item: Y.Item): string {
  const parent = item.parent as Y.Node;
  const parentItem = parent._item;
  let where: string;
  if (parentItem === null) {
    where = 'root?';
    doc.share.forEach((type, name) => {
      if (type === parent) {
        where = `root:${name}`;
      }
    });
  } else {
    where = `${parentItem.id.client}.${parentItem.id.clock}`;
  }
  return item.parentSub === null ? where : `${where}#${item.parentSub}`;
}

/**
 * Every id unit of every client but the migration's, with what it holds:
 * `deleted`, or its place (root or parent item, key) and value (a code unit
 * of a string, a format, an embed, a type's name). Item splits and GC
 * structs compare equal; text, formats, attributes, ids and deletions are
 * all in it.
 */
export function unitDump(doc: Y.Doc): Map<string, string> {
  const skip = epochClients(doc);
  const out = new Map<string, string>();
  for (const [client, structs] of doc.store.clients) {
    if (skip.has(client)) {
      continue;
    }
    for (const s of structs) {
      if (s instanceof Y.Skip) {
        continue;
      }
      for (let i = 0; i < s.length; i++) {
        const key = `${client}.${s.id.clock + i}`;
        if (!(s instanceof Y.Item) || s.deleted) {
          out.set(key, 'deleted');
          continue;
        }
        const c = s.content;
        let value: string;
        if (c instanceof Y.ContentString) {
          value = JSON.stringify(c.str[i]);
        } else if (c instanceof Y.ContentFormat) {
          value = `format ${c.key}=${JSON.stringify(c.value)}`;
        } else if (c instanceof Y.ContentType) {
          value = `type ${(c.type as Y.Node).name}`;
        } else {
          value = JSON.stringify(c.getContent()[i]);
        }
        out.set(key, `${placeOf(doc, s)} ${value}`);
      }
    }
  }
  return out;
}
