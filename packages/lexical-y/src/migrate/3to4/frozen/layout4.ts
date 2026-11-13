/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// FROZEN (@lexical/y/migrate/3to4): never edited after release; a change to
// what it writes or reads is a new revision of the step, with new golden
// fixtures.

/*
 * Layout 4's paired grammar for whole containers, as the 3to4 step writes
 * and reads it. Self-contained and pure: it imports only @y/y, keeps no
 * module state (no caches, maps, latches or warnings), reads no time or
 * randomness, and iterates keys sorted by code unit.
 *
 * Countable: a live item whose content Yjs counts, `item.length` times
 * (each UTF-16 unit of a string, `\n` and `\t` included; each child type;
 * each embed). values[i] belongs to the i-th countable unit of the
 * container.
 *
 * Canonical form (full-map): the units split into maximal runs of units
 * whose covered values are all equal (the same keys, each with an equal
 * stored value); each run gets, for each key it holds, an opener
 * `{key: value}` right before its first unit and an end `{key: [d]}` right
 * after its last unit (`d`: the end's clock minus its opener's, both this
 * client's). Where runs meet, the ends of the run ending there come first,
 * then the openers of the run starting there, each in key order (see
 * runBoundary). The openers at the container's start go before its first
 * item; everything else goes right after the unit before it.
 *
 * Reserved shapes (a non-empty array that is no well-formed end: another
 * length, an element that is not such an integer, a nested array) are kept
 * where they are: they name no run, so among paired runs they change
 * nothing a unit shows.
 */

import {
  ContentFormat,
  createID,
  getItemCleanStart,
  Item,
  type Node as YNode,
  type Transaction,
} from '@y/y';

/** Covered key → stored value for one countable unit. */
export type StoredFormats = ReadonlyMap<string, unknown>;

/**
 * Whether `key` is governed by layout 4's paired grammar, every name the
 * binding writes on text: `t` and `k` (a text node's type and segment
 * key), `f:` text format bits, `p:` fields on text, `w:` wrappers, and
 * `s:` NodeState (a flat value, or a member entry of a set).
 */
export function isCoveredKey(key: string): boolean {
  if (key.length === 1) {
    return key === 't' || key === 'k';
  }
  if (key.charCodeAt(1) !== 58 /* : */) {
    return false;
  }
  switch (key.charCodeAt(0)) {
    case 102: // f
    case 112: // p
    case 115: // s
    case 119: // w
      return true;
    default:
      return false;
  }
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const unencodable = () =>
  new Error('@lexical/y: a format value JSON cannot encode');

/**
 * JSON of a value JSON.parse made (plain objects, arrays, strings, finite
 * numbers, booleans, null), object keys sorted by code unit.
 */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stable).join(',') + ']';
  }
  const parts: string[] = [];
  for (const k of Object.keys(value).sort(byCodeUnit)) {
    parts.push(
      JSON.stringify(k) + ':' + stable((value as Record<string, unknown>)[k]),
    );
  }
  return '{' + parts.join(',') + '}';
}

/**
 * The value stored for `value`, as Yjs encodes a format value
 * (JSON.stringify: toJSON honoured, an array's holes and undefined elements
 * null, an object's undefined and function properties left out): that JSON
 * read back, and a raw array as `{json}` of it (keys sorted). Throws where
 * JSON gives no value (undefined, a function or symbol at the top, a
 * toJSON that returns undefined), gives null (null is no value: a closer),
 * or throws (a bigint, a cycle).
 */
function storedValue(value: unknown): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw unencodable();
  }
  if (json === undefined) {
    throw unencodable();
  }
  const plain: unknown = JSON.parse(json);
  if (plain === null) {
    throw unencodable();
  }
  return Array.isArray(plain) ? {json: stable(plain)} : plain;
}

/** The countable length of `container` (live units only). */
function countableLength(container: YNode): number {
  let n = 0;
  for (let it = container._start; it !== null; it = it.right as Item | null) {
    if (!it.deleted && it.countable) {
      n += it.length;
    }
  }
  return n;
}

/** One unit's covered keys → [signature, stored value], in key order. */
export type StoredUnit = ReadonlyMap<string, readonly [string, unknown]>;

/**
 * A unit's covered values as written (see storedValue), each with its
 * signature (its JSON, keys sorted), in key order. Throws, before anything
 * is written, for an uncovered key or a value JSON cannot store.
 */
export function storedUnit(values: StoredFormats): StoredUnit {
  const unit = new Map<string, [string, unknown]>();
  for (const key of [...values.keys()].sort(byCodeUnit)) {
    if (!isCoveredKey(key)) {
      throw new Error(`@lexical/y: ${JSON.stringify(key)} is not covered`);
    }
    const stored = storedValue(values.get(key));
    unit.set(key, [stable(stored), stored]);
  }
  return unit;
}

/**
 * Where a unit with values `before` meets one with values `after` (either
 * empty at a container's edge): the keys whose run ends there and the keys
 * whose run starts there, in writing order: every key of both when the
 * two differ in any key or value, none when they are equal. The canonical
 * form's one boundary rule, for whole-container rewrites and for the seed's
 * own pass alike.
 */
export function runBoundary(
  before: StoredUnit,
  after: StoredUnit,
): {ends: string[]; starts: string[]} {
  let same = before.size === after.size;
  if (same) {
    for (const [key, [sig]] of before) {
      const next = after.get(key);
      if (next === undefined || next[0] !== sig) {
        same = false;
        break;
      }
    }
  }
  return same
    ? {ends: [], starts: []}
    : {ends: [...before.keys()], starts: [...after.keys()]};
}

/**
 * Rewrite the covered format items of `container`'s own sequence as pure
 * layout 4 runs that reproduce `values`, in `tr`, under tr.doc.clientID
 * from its current clock: delete every live covered format item of the
 * container but the reserved shapes (see isReserved), then write the
 * canonical runs (see the header). Touches nothing else. Throws, before writing, when `values.length` differs from
 * the container's countable length, a key is not covered, a value cannot
 * be JSON-encoded, or the container is not in `tr.doc`.
 */
export function writeLayout4Formats(
  tr: Transaction,
  container: YNode,
  values: readonly StoredFormats[],
): {written: number; deleted: number} {
  const doc = tr.doc;
  if ((container as unknown as {doc: unknown}).doc !== doc) {
    throw new Error('@lexical/y: the container is not in the transaction');
  }
  const n = countableLength(container);
  if (values.length !== n) {
    throw new Error(
      `@lexical/y: ${values.length} values for ${n} countable units`,
    );
  }
  // Each unit's covered keys → [signature, stored value], in key order.
  const units: StoredUnit[] = [];
  for (const map of values) {
    units.push(storedUnit(map));
  }
  // Delete every live covered format item but the reserved shapes.
  let deleted = 0;
  for (let it = container._start; it !== null; it = it.right as Item | null) {
    if (
      !it.deleted &&
      it.content instanceof ContentFormat &&
      isCoveredKey(it.content.key) &&
      !isReserved(it)
    ) {
      it.delete(tr);
      deleted++;
    }
  }
  // At each place p (0..n, before unit p): the keys whose run ends there
  // and the keys whose run starts there (see runBoundary).
  const none: StoredUnit = new Map();
  const ends: string[][] = [];
  const starts: string[][] = [];
  for (let p = 0; p <= n; p++) {
    const b = runBoundary(p > 0 ? units[p - 1] : none, p < n ? units[p] : none);
    ends.push(b.ends);
    starts.push(b.starts);
  }
  const isBoundary = (p: number) => ends[p].length > 0 || starts[p].length > 0;
  const client = doc.clientID;
  let written = 0;
  // Each open run's opener, by key.
  const open = new Map<string, Item>();
  const insert = (
    left: Item | null,
    key: string,
    value: (clock: number) => unknown,
  ): Item => {
    const right = (
      left === null ? container._start : left.right
    ) as Item | null;
    const clock = doc.store.getClock(client);
    const item = new Item(
      createID(client, clock),
      left,
      left && left.lastId,
      right,
      right && right.id,
      container,
      null,
      new ContentFormat(key, value(clock) as object),
    );
    item.integrate(tr, 0);
    written++;
    return item;
  };
  // At place `p`, after `left`: the ends of the runs ending there, then the
  // openers of the runs starting there. Returns the last item written.
  const writeAt = (p: number, left: Item | null): Item | null => {
    let at = left;
    for (const key of ends[p]) {
      const opener = open.get(key)!;
      open.delete(key);
      // The end names its opener by clock distance.
      at = insert(at, key, clock => [clock - opener.id.clock]);
    }
    for (const key of starts[p]) {
      const stored = units[p].get(key)![1];
      const opener = insert(at, key, () => stored);
      open.set(key, opener);
      at = opener;
    }
    return at;
  };
  if (isBoundary(0)) {
    writeAt(0, null);
  }
  let pos = 0;
  for (
    let it = container._start as Item | null;
    it !== null;
    it = it.right as Item | null
  ) {
    if (it.deleted || !it.countable) {
      continue;
    }
    // A boundary inside this item: split it there.
    for (let b = pos + 1; b < pos + it.length; b++) {
      if (isBoundary(b)) {
        getItemCleanStart(tr, createID(it.id.client, it.id.clock + (b - pos)));
        break;
      }
    }
    pos += it.length;
    if (isBoundary(pos)) {
      it = writeAt(pos, it) as Item;
    }
  }
  return {deleted, written};
}

/**
 * What the paired grammar shows of `container`'s own sequence for the names
 * `keys` covers, per countable unit: name → stored value, exactly as the
 * binding reads a covered name (Ident's stepPaired), outside any
 * transaction:
 * - an end is any non-empty array; it names an opener when it is `[d]`
 *   (this client's clock − d) or `[client, clock]`, else it names nothing;
 * - an opener (any other value, `[]` and null included) is paired when a
 *   live end after it, in this container, of its key, names it (a null
 *   still pushes as an unpaired run);
 * Per key a stack of runs:
 * - an opener on an empty stack pushes its run; a paired opener pushes its
 *   run; any other opener first drops the unpaired runs above the topmost
 *   paired run, then pushes its run;
 * - an end does nothing on an empty stack; one that names the top run pops
 *   it; otherwise it drops the unpaired runs above the topmost paired run,
 *   and where it names a run below, that run goes too, with the unpaired
 *   runs between it and the top (the paired runs above it stay).
 * The top run's value shows; null and `[]` show none.
 */
export function readPairedFormats(
  container: YNode,
  keys: (key: string) => boolean,
): Map<string, unknown>[] {
  // Pass 1: the paired openers ("client:clock").
  const before = new Map<string, Item>();
  const paired = new Set<string>();
  for (let it = container._start; it !== null; it = it.right as Item | null) {
    if (it.deleted || !(it.content instanceof ContentFormat)) {
      continue;
    }
    const {key, value} = it.content;
    if (!keys(key)) {
      continue;
    }
    if (isEnd(value)) {
      const target = endTargetOf(it);
      const opener = target === null ? undefined : before.get(target);
      if (
        opener !== undefined &&
        (opener.content as ContentFormat).key === key
      ) {
        paired.add(target!);
      }
    } else {
      before.set(`${it.id.client}:${it.id.clock}`, it);
    }
  }
  // Pass 2: the fold.
  type Run = {
    id: string;
    value: unknown;
    paired: boolean;
    below: Run | null;
  };
  const stacks = new Map<string, Run | null>();
  const belowPaired = (top: Run | null): Run | null => {
    let r = top;
    while (r !== null && !r.paired) {
      r = r.below;
    }
    return r;
  };
  const out: Map<string, unknown>[] = [];
  const shown = (): Map<string, unknown> => {
    const m = new Map<string, unknown>();
    for (const key of [...stacks.keys()].sort(byCodeUnit)) {
      const top = stacks.get(key);
      if (top !== null && top !== undefined && top.value !== null) {
        m.set(key, top.value);
      }
    }
    return m;
  };
  for (let it = container._start; it !== null; it = it.right as Item | null) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof ContentFormat) {
      const {key, value} = it.content;
      if (!keys(key)) {
        continue;
      }
      const top = stacks.get(key) ?? null;
      if (isEnd(value)) {
        if (top === null) {
          continue;
        }
        const target = endTargetOf(it);
        if (target !== null && top.id === target) {
          stacks.set(key, top.below);
          continue;
        }
        const firstPaired = belowPaired(top);
        let own: Run | null = target === null ? null : firstPaired;
        while (own !== null && own.id !== target) {
          own = own.below;
        }
        if (own === null) {
          stacks.set(key, firstPaired);
          continue;
        }
        // The paired runs strictly above `own`, re-pushed onto its below.
        const above: Run[] = [];
        for (let r: Run | null = firstPaired; r !== own; r = r!.below) {
          if (r!.paired) {
            above.push(r!);
          }
        }
        let rebuilt = own.below;
        for (let i = above.length - 1; i >= 0; i--) {
          rebuilt = {...above[i], below: rebuilt};
        }
        stacks.set(key, rebuilt);
        continue;
      }
      const id = `${it.id.client}:${it.id.clock}`;
      // (A null an end names is pushed as unpaired, yet counts as paired
      // afterwards, as in the binding's fold.)
      const pushesPaired = value !== null && paired.has(id);
      const base = top === null || pushesPaired ? top : belowPaired(top);
      stacks.set(key, {
        below: base,
        id,
        paired: paired.has(id),
        value: value === null || Array.isArray(value) ? null : value,
      });
    } else if (it.countable) {
      const m = shown();
      for (let i = 0; i < it.length; i++) {
        out.push(i === 0 ? m : new Map(m));
      }
    }
  }
  return out;
}

/**
 * What a layout 4 read of `container`'s own sequence shows, per countable
 * unit: covered name → stored value (see readPairedFormats).
 */
export function readLayout4Formats(container: YNode): Map<string, unknown>[] {
  return readPairedFormats(container, isCoveredKey);
}

/** Whether a stored value is an end (any non-empty array). */
const isEnd = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/**
 * Whether format item `it` holds a reserved shape: a non-empty array that
 * is neither `[d]` (d a positive safe integer) nor `[client, clock]`
 * (non-negative safe integers).
 */
export function isReserved(it: Item): boolean {
  const v = (it.content as ContentFormat).value as unknown;
  if (!Array.isArray(v) || v.length === 0) {
    return false;
  }
  const count = (x: unknown, min: number) =>
    typeof x === 'number' && Number.isSafeInteger(x) && x >= min;
  return !(
    (v.length === 1 && count(v[0], 1)) ||
    (v.length === 2 && count(v[0], 0) && count(v[1], 0))
  );
}

/**
 * The opener an end names ("client:clock"), or null where its value is
 * malformed: `[d]` (d a positive safe integer, this client's clock − d,
 * not below 0) or `[client, clock]` (non-negative safe integers).
 */
export function endTargetOf(it: Item): string | null {
  const v = (it.content as ContentFormat).value as unknown as unknown[];
  const count = (x: unknown, min: number) =>
    typeof x === 'number' && Number.isSafeInteger(x) && x >= min;
  if (v.length === 1 && count(v[0], 1)) {
    const clock = it.id.clock - (v[0] as number);
    return clock >= 0 ? `${it.id.client}:${clock}` : null;
  }
  if (v.length === 2 && count(v[0], 0) && count(v[1], 0)) {
    return `${v[0]}:${v[1]}`;
  }
  return null;
}
