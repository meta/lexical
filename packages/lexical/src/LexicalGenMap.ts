/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

const TOMBSTONE = null;
const GEN_MAP_SIZE_THRESHOLD = 1000;

/**
 * @internal
 *
 * Create a copy of the given Map, returning either a fresh Map or a clone
 * of a copy-on-write GenMap depending on the source type and size.
 *
 * - If the source is already a GenMap, returns `map.clone()` (O(1)).
 * - If the source is a plain Map below the threshold, returns
 *   `new Map(map)` to avoid the GenMap overhead on small docs.
 * - Otherwise wraps a fresh GenMap around the source.
 */
export function cloneMap<K, V>(
  map: Map<K, V>,
  minGenMapSize: number = GEN_MAP_SIZE_THRESHOLD,
): Map<K, V> {
  if (map instanceof GenMap) {
    return map.clone();
  }
  if (map.size < minGenMapSize) {
    return new Map(map);
  }
  return new GenMap<K, V>().init(new Map(map), undefined, map.size);
}

/**
 * @internal
 *
 * A copy-on-write Map suitable for cloning large collections cheaply.
 *
 * Before being written to, a GenMap shares its `_old` and `_nursery` Maps
 * with the GenMap it was cloned from. On first write it either compacts
 * (folds `_nursery` into a new `_old`) or shallow-copies `_nursery`,
 * isolating subsequent writes from sibling clones.
 *
 * `_old` is the immutable snapshot from the most recent compaction;
 * `_nursery` holds writes since the last compaction (deletions stored as
 * `TOMBSTONE`). `_mutable` tracks whether `_nursery` may be written to
 * directly or must first be cloned.
 *
 * Implements the full `Map<K, V>` interface; methods not documented
 * individually behave as their native `Map` counterparts.
 */
export class GenMap<K, V> implements Map<K, V> {
  _mutable: boolean = false;
  _old: undefined | ReadonlyMap<K, V> = undefined;
  _nursery: undefined | Map<K, typeof TOMBSTONE | V> = undefined;
  _size: number = 0;

  /**
   * Returns a new GenMap that initially shares `_old` and `_nursery`
   * with this one. Marks both as not-mutable so the next write on either
   * side triggers a copy-on-write of the nursery before mutating.
   */
  clone(): GenMap<K, V> {
    this._mutable = false;
    return new GenMap<K, V>().init(this._old, this._nursery, this._size);
  }

  init(
    old: undefined | ReadonlyMap<K, V>,
    nursery: undefined | Map<K, typeof TOMBSTONE | V>,
    size: number,
  ): this {
    this._old = old;
    this._nursery = nursery;
    this._size = size;
    return this;
  }

  get size(): number {
    return this._size;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Returns the raw value for `key`, including TOMBSTONE for keys deleted
   * since the last compaction. Used internally to distinguish "missing"
   * from "deleted" without doing a second lookup.
   */
  getWithTombstone(key: K): undefined | typeof TOMBSTONE | V {
    const v = this._nursery && this._nursery.get(key);
    if (v !== undefined) {
      return v;
    }
    return this._old && this._old.get(key);
  }

  get(key: K): undefined | V {
    const v = this.getWithTombstone(key);
    return v === TOMBSTONE ? undefined : v;
  }

  shouldCompact(): boolean {
    return this._nursery !== undefined && this._nursery.size * 2 > this._size;
  }

  /**
   * Returns the nursery for in-place writes. If this GenMap is currently
   * sharing its nursery with an ancestor clone, this either compacts (if
   * the nursery has grown large enough) or makes a shallow copy.
   */
  getNursery(): Map<K, typeof TOMBSTONE | V> {
    if (!this._mutable || !this._nursery) {
      this.compact();
      this._nursery = new Map(this._nursery);
      this._mutable = true;
    }
    return this._nursery;
  }

  /**
   * Fold the nursery into a new `_old` snapshot when it has grown large
   * enough that lookup overhead outweighs the savings from sharing.
   * Triggered automatically from `getNursery` once `_nursery.size * 2 >
   * _size`; can be forced via `compact(true)`.
   */
  compact(force: boolean = false): this {
    if (
      this._nursery &&
      this._nursery.size > 0 &&
      (force || this.shouldCompact())
    ) {
      const compact = new Map(this._old);
      for (const [k, v] of this._nursery) {
        if (v !== TOMBSTONE) {
          compact.set(k, v as V);
        } else {
          compact.delete(k);
        }
      }
      this._old = compact;
      this._nursery = undefined;
    }
    this._mutable = false;
    return this;
  }

  set(key: K, value: V): this {
    const v = this.getWithTombstone(key);
    if (v === value) {
      return this;
    }
    const nursery = this.getNursery();
    if (v === TOMBSTONE || v === undefined) {
      this._size++;
      if (v === TOMBSTONE) {
        // Match native Map semantics where `delete(k); set(k, v)`
        // re-inserts the key at the end of iteration order.
        nursery.delete(key);
      }
    }
    nursery.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    const deleted = this.has(key);
    if (deleted) {
      this.getNursery().set(key, TOMBSTONE);
      this._size--;
    }
    return deleted;
  }

  getOrInsert(key: K, defaultValue: V): V {
    const existing = this.get(key);
    if (existing !== undefined) {
      return existing;
    }
    this.set(key, defaultValue);
    return defaultValue;
  }

  getOrInsertComputed(key: K, computer: (k: K) => V): V {
    const existing = this.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const value = computer(key);
    this.set(key, value);
    return value;
  }

  clear(): void {
    this._mutable = false;
    this._old = undefined;
    this._nursery = undefined;
    this._size = 0;
  }

  *keys(): MapIterator<K> {
    for (const pair of this.entries()) {
      yield pair[0];
    }
  }

  *values(): MapIterator<V> {
    for (const pair of this.entries()) {
      yield pair[1];
    }
  }

  *entries(): MapIterator<[K, V]> {
    const nursery = this._nursery;
    const old = this._old;
    // Skip per-entry override checks for an unmodified snapshot.
    if (!nursery) {
      if (old) {
        yield* old;
      }
      return;
    }
    if (old) {
      for (const pair of old) {
        const k = pair[0];
        const v = nursery.get(k);
        if (v === TOMBSTONE) {
          continue;
        } else if (v !== undefined) {
          pair[1] = v;
        }
        yield pair;
      }
    }
    for (const pair of nursery) {
      if (pair[1] !== TOMBSTONE && !(old && old.has(pair[0]))) {
        yield pair as [K, V];
      }
    }
  }

  forEach(
    callbackfn: (value: V, key: K, map: Map<K, V>) => void,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    thisArg?: any,
  ): void {
    if (thisArg !== undefined) {
      callbackfn = callbackfn.bind(thisArg);
    }
    for (const [k, v] of this.entries()) {
      callbackfn(v, k, this);
    }
  }

  get [Symbol.toStringTag](): string {
    return 'GenMap';
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}
