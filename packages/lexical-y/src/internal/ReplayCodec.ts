/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  ContentFormat,
  createID,
  getItemCleanStart,
  type ID,
  Item,
  type Node as YNode,
  type Transaction,
} from '@y/y';

// How the replay (Replay.ts) reads and writes a container's format values
// in the layout the current document's root records: one codec per layout.
// LAYOUT_CODECS is the registration point; a layout without a codec makes a
// record ineligible for replay (the recovery view shows it).

/** One unit's values of every key (a fold); a missing key: no value. */
export type YReplayValues = Map<string, unknown>;

/** @experimental A layout's format codec for the replay. */
export interface YReplayCodec {
  /** Per live countable unit of `container`'s own sequence, in order. */
  read(container: YNode): {id: ID; values: YReplayValues}[];
  /**
   * Make the container show `next` (one map per unit of `before`, the read
   * this call was decided on, taken in the same transaction), writing
   * under `tr.doc.clientID`. Returns whether it wrote anything.
   */
  write(
    tr: Transaction,
    container: YNode,
    before: readonly {id: ID; values: YReplayValues}[],
    next: readonly YReplayValues[],
  ): boolean;
  /** Whether two values of `key` (undefined: none) store the same. */
  same(key: string, a: unknown, b: unknown): boolean;
}

function stableJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJSON).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableJSON(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Equal as stored by the plain layouts (stable JSON). */
export const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || stableJSON(a) === stableJSON(b);

/** The plain fold (layouts 1 and 2) of a container's live countable units. */
export function plainRead(
  container: YNode,
  keep: (key: string) => boolean = () => true,
): {id: ID; values: YReplayValues}[] {
  const values: YReplayValues = new Map();
  const out: {id: ID; values: YReplayValues}[] = [];
  for (let it = container._start; it !== null; it = it.right) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof ContentFormat) {
      const {key, value} = it.content;
      if (!keep(key)) {
        continue;
      }
      if (value === null) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    } else if (it.countable) {
      for (let i = 0; i < it.length; i++) {
        out.push({
          id: createID(it.id.client, it.id.clock + i),
          values: new Map(values),
        });
      }
    }
  }
  return out;
}

function itemAt(tr: Transaction, id: ID): Item | null {
  const structs = tr.doc.store.clients.get(id.client);
  if (structs === undefined || structs.length === 0) {
    return null;
  }
  const last = structs[structs.length - 1];
  if (id.clock >= last.id.clock + last.length) {
    return null;
  }
  const s = tr.doc.store.getItem(id) as unknown;
  return s instanceof Item ? s : null;
}

/** The item starting exactly at `id` (split there when needed). */
function cleanStart(tr: Transaction, id: ID): Item {
  const it = itemAt(tr, id)!;
  return it.id.clock === id.clock
    ? it
    : (getItemCleanStart(tr, id) as unknown as Item);
}

/** The item ending exactly at `id` (split there when needed). */
function cleanEnd(tr: Transaction, id: ID): Item {
  const it = itemAt(tr, id)!;
  if (it.id.clock + it.length - 1 !== id.clock) {
    getItemCleanStart(tr, createID(id.client, id.clock + 1));
  }
  return itemAt(tr, id)!;
}

/**
 * The plain form (layouts 1 and 2) of `value` for `key` on the units
 * `first..last`: a format item before the range and one after it giving
 * back `after`, the value the last unit had (so the unit after keeps its),
 * and every live format item of `key` inside the range deleted, as Yjs's
 * own format() does: a redundant one there (which the binding keeps)
 * would otherwise cut the range.
 */
function plainRange(
  tr: Transaction,
  container: YNode,
  first: ID,
  last: ID,
  key: string,
  value: unknown,
  after: unknown,
): void {
  const doc = tr.doc;
  const insert = (left: Item | null, right: Item | null, v: unknown) => {
    const item = new Item(
      createID(doc.clientID, doc.store.getClock(doc.clientID)),
      left,
      left === null ? null : left.lastId,
      right,
      right === null ? null : right.id,
      container,
      null,
      new ContentFormat(key, (v === undefined ? null : v) as never),
    );
    item.integrate(tr, 0);
  };
  const start = cleanStart(tr, first);
  insert(start.left, start, value);
  const end = cleanEnd(tr, last);
  for (let it: Item | null = start; it !== null; it = it.right as Item | null) {
    if (
      !it.deleted &&
      it.content instanceof ContentFormat &&
      it.content.key === key
    ) {
      it.delete(tr);
    }
    if (it === end) {
      break;
    }
  }
  insert(end, end.right, after);
}

/**
 * Write, in the plain form, every key whose `next` value differs from
 * `before` (restricted to `keep`): one pair of format items per maximal
 * range of consecutive units with one new and one old value.
 */
export function plainWrite(
  tr: Transaction,
  container: YNode,
  before: readonly {id: ID; values: YReplayValues}[],
  next: readonly YReplayValues[],
  keep: (key: string) => boolean = () => true,
): boolean {
  const keys = new Set<string>();
  before.forEach((u, i) => {
    for (const k of u.values.keys()) {
      keys.add(k);
    }
    for (const k of next[i].keys()) {
      keys.add(k);
    }
  });
  let wrote = false;
  for (const key of [...keys].filter(keep).sort()) {
    let i = 0;
    while (i < before.length) {
      const was = before[i].values.get(key);
      const now = next[i].get(key);
      if (sameValue(was, now)) {
        i++;
        continue;
      }
      let j = i;
      while (
        j + 1 < before.length &&
        sameValue(next[j + 1].get(key), now) &&
        sameValue(before[j + 1].values.get(key), was) &&
        !sameValue(before[j + 1].values.get(key), next[j + 1].get(key))
      ) {
        j++;
      }
      plainRange(tr, container, before[i].id, before[j].id, key, now, was);
      wrote = true;
      i = j + 1;
    }
  }
  return wrote;
}

/** Layouts 1 and 2: the plain fold. */
export const PLAIN_CODEC: YReplayCodec = {
  read: container => plainRead(container),
  same: (_key, a, b) => sameValue(a, b),
  write: (tr, container, before, next) =>
    plainWrite(tr, container, before, next),
};

/** The codec of each layout the replay writes. */
export const LAYOUT_CODECS: Readonly<Record<number, YReplayCodec>> = {
  1: PLAIN_CODEC,
  2: PLAIN_CODEC,
};
