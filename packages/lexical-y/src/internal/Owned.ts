/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Doc} from '@y/y';

// What a write itself inserted: the clock ranges of the binding's own Yjs
// mutations (each bracketed where it is made, see owned), for the writer
// running. A Yjs mutation call is synchronous (observers run at the
// transaction's cleanup), so what another binding, or an app's code, writes
// between two brackets is never in one; and what another binding writes
// inside one (in a hook the mutation runs) is taken out of it. Used to undo exactly a failed attempt
// (see Binding's recovery of a write that failed part way).

/** A writer's own clock ranges, [start, end) of its document's client. */
export type OwnedRanges = [number, number][];

let owner: object | null = null;
const collectors = new WeakMap<object, OwnedRanges>();

/** Run `fn` as `owner`'s write (a Writer's run): its mutations are its. */
export function asOwner<T>(writer: object, fn: () => T): T {
  const before = owner;
  owner = writer;
  try {
    return fn();
  } finally {
    owner = before;
  }
}

/** Collect into `ranges` the mutations made as `writer` while `fn` runs. */
export function collectOwned<T>(
  writer: object,
  ranges: OwnedRanges,
  fn: () => T,
): T {
  const before = collectors.get(writer);
  collectors.set(writer, ranges);
  try {
    return fn();
  } finally {
    if (before === undefined) {
      collectors.delete(writer);
    } else {
      collectors.set(writer, before);
    }
  }
}

/** A bracket open (see owned), and what other owners wrote inside it. */
type Open = {doc: Doc; owner: object | null; foreign: OwnedRanges};
const open: Open[] = [];

/**
 * Make one Yjs mutation (`fn`) on `doc`, bracketed for the owner running.
 * What another owner writes inside it (a binding's write nested in a hook
 * the mutation runs) is left out of the bracket.
 */
export function owned<T>(doc: Doc, fn: () => T): T {
  const ranges = owner === null ? undefined : collectors.get(owner);
  if (ranges === undefined && open.length === 0) {
    return fn();
  }
  const client = doc.clientID;
  const start = doc.store.getClock(client);
  const me: Open = {doc, foreign: [], owner};
  open.push(me);
  try {
    return fn();
  } finally {
    open.splice(open.lastIndexOf(me), 1);
    const end = doc.store.getClock(client);
    if (end > start) {
      for (const o of open) {
        if (o.doc === doc && o.owner !== me.owner) {
          o.foreign.push([start, end]);
        }
      }
      if (ranges !== undefined) {
        pushExcept(ranges, start, end, me.foreign);
      }
    }
  }
}

/** Push [start, end) to `ranges`, without the parts in `except`. */
function pushExcept(
  ranges: OwnedRanges,
  start: number,
  end: number,
  except: OwnedRanges,
): void {
  let from = start;
  for (const [s, e] of [...except].sort((x, y) => x[0] - y[0])) {
    if (e <= from || s >= end) {
      continue;
    }
    if (s > from) {
      ranges.push([from, s]);
    }
    from = Math.max(from, e);
  }
  if (from < end) {
    ranges.push([from, end]);
  }
}

/** Whether `clock` is inside one of `ranges`. */
export function isOwned(ranges: OwnedRanges, clock: number): boolean {
  for (const [start, end] of ranges) {
    if (clock >= start && clock < end) {
      return true;
    }
  }
  return false;
}
