/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Item, Node as YNode} from '@y/y';

/*
 * Every write of Yjs's `Item.keep`, in one place.
 *
 * Yjs does not collect the content of a deleted item whose `keep` is set.
 * It is one flag per item, with no count: Yjs's UndoManager sets it for the
 * items a step deleted, and this package for two things of its own.
 *
 * - Undo (D88; UndoKeeps): the format items of the changes on a binding's
 *   undo stacks and the ends of the runs they deleted, which an undo reads
 *   after a collaborator deleted them. Several bindings (and listening
 *   lifetimes of one binding) can keep one item; it is released when the
 *   last of them releases it, and only if nothing else kept it first.
 * - The composition hold (keepShown, unkeepShown): the format items a held
 *   change deleted, which the line being composed goes on showing (see
 *   Hidden#keep). The hold remembers which flags it set and clears those.
 *
 * The two do not know of each other: an item the hold kept first is one
 * "kept already" to the undo registry (`external`), which then never
 * releases it, and the hold's release clears the flag whether or not an
 * undo step has come to rely on it since. Both rules are as they were
 * before they moved here.
 */

/**
 * The lifetimes that keep an item from garbage collection (D88), per item,
 * and whether it was kept already when the first of them did (by an
 * UndoManager's step): the item is released when the last of them releases
 * it, and only if nothing else kept it before.
 */
const keepOwners = new WeakMap<
  Item,
  {external: boolean; owners: Set<object>}
>();

/**
 * The items bindings kept again after their UndoManager let them go (a clear
 * of a stack releases what its steps kept, parents included), with the
 * binding lifetimes (the owners in keepOwners) that hold each such keep: the
 * lifetimes that kept it again, or relied on it when another had, or held
 * it when the last of those stopped. The keep is released when the last of
 * them stops. And per lifetime, the items it holds so.
 */
const rekeepHolders = new WeakMap<Item, Set<object>>();
const rekeptByOwner = new WeakMap<object, Set<Item>>();

/** Lifetime `by` holds the keep of `it` that was set again (see rekeepHolders). */
function hold(it: Item, by: object): void {
  let holders = rekeepHolders.get(it);
  if (holders === undefined) {
    holders = new Set();
    rekeepHolders.set(it, holders);
  }
  holders.add(by);
  const theirs = rekeptByOwner.get(by);
  if (theirs !== undefined) {
    theirs.add(it);
  }
}

/**
 * What one listening lifetime of a binding keeps for its undo stacks: a
 * binding started again after a dispose owns its keeps anew, apart from a
 * release the old one queued.
 */
export class UndoKeeps {
  private readonly kept = new Set<Item>();
  private readonly rekept = new Set<Item>();

  constructor() {
    rekeptByOwner.set(this, this.rekept);
  }

  /** Whether this lifetime keeps an item. */
  get keepsAny(): boolean {
    return this.kept.size > 0;
  }

  /** Whether this lifetime holds a keep that was set again (see rekept). */
  get rekeepsAny(): boolean {
    return this.rekept.size > 0;
  }

  /** Keep `item` and the items of the shared nodes it is in. */
  keep(item: Item | null): void {
    for (let it = item; it !== null; it = (it.parent as YNode)._item) {
      let entry = keepOwners.get(it);
      if (entry === undefined) {
        // `external`: kept already (by an UndoManager's step), which
        // this leaves to whoever kept it.
        entry = {external: it.keep, owners: new Set()};
        keepOwners.set(it, entry);
      } else if (entry.owners.has(this)) {
        // Its parents are this lifetime's already.
        break;
      }
      entry.owners.add(this);
      it.keep = true;
      this.kept.add(it);
    }
  }

  /**
   * Release what this lifetime keeps: an item another lifetime keeps too,
   * or that was kept before any did, stays kept.
   */
  release(): void {
    for (const it of this.kept) {
      const entry = keepOwners.get(it);
      if (entry !== undefined) {
        entry.owners.delete(this);
        if (entry.owners.size > 0) {
          continue;
        }
        keepOwners.delete(it);
        if (entry.external) {
          continue;
        }
      }
      // A keep this lifetime set again after a clear goes with it; one
      // another lifetime holds stays.
      const holders = rekeepHolders.get(it);
      if (holders !== undefined) {
        holders.delete(this);
        this.rekept.delete(it);
        if (holders.size > 0) {
          continue;
        }
        rekeepHolders.delete(it);
      }
      it.keep = false;
    }
    this.kept.clear();
  }

  /**
   * When this lifetime ends: each keep it holds goes to the other
   * lifetimes that hold it, or that keep the item for a step of theirs,
   * or is released by the last of them.
   */
  releaseRekept(): void {
    for (const it of this.rekept) {
      const holders = rekeepHolders.get(it);
      if (holders !== undefined) {
        holders.delete(this);
        if (holders.size > 0) {
          continue;
        }
        rekeepHolders.delete(it);
      }
      const entry = keepOwners.get(it);
      if (entry !== undefined && entry.owners.size > 0) {
        for (const other of entry.owners) {
          hold(it, other);
        }
        continue;
      }
      it.keep = false;
    }
    this.rekept.clear();
  }

  /**
   * A clear of one stack makes the UndoManager release what that stack's
   * steps kept, parents included: keep what this lifetime still relies on
   * (another UndoManager on the document may rely on it too: Yjs's keep is
   * one flag). Released when this lifetime stops (see releaseRekept), not
   * before.
   */
  keepAgain(): void {
    for (const it of this.kept) {
      if (!it.keep) {
        it.keep = true;
        hold(it, this);
      } else if (rekeepHolders.has(it)) {
        // Kept again by another binding: held by this one too.
        hold(it, this);
      }
    }
  }
}

/**
 * Keep `item`, a deleted format item a composition hold goes on showing
 * (see Hidden#keep), from garbage collection. Returns whether this set the
 * flag: one set already is left to whoever set it.
 */
export function keepShown(item: Item): boolean {
  if (item.keep) {
    return false;
  }
  item.keep = true;
  return true;
}

/** Clear the flag a keepShown of `item` set. */
export function unkeepShown(item: Item): void {
  item.keep = false;
}
