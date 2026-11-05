/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Loading stored Yjs bytes so that the document shows what the document they
// were encoded from showed (D112).
//
// Works around an upstream @y/y problem, "encodeStateAsUpdate drops text the
// doc shows after it integrated a struct across a clock gap" (@y/y
// 14.0.0-rc.29): a struct that arrives in an update of its own is
// integrated past an earlier struct of the same client that is still
// missing a dependency (Yjs leaves a Skip placeholder for the gap), but
// encodeStateAsUpdate merges the document's pending structs into that
// client's run, so the same structs reach a fresh document in one update,
// where the later ones wait behind the blocked one. The text the document
// showed (and anything typed after it, which depends on it) is then missing
// from every document loaded from those bytes.
//
// The repair integrates maximally, by dependencies: every struct whose
// dependencies are present is integrated, whatever blocked structs of its
// own client precede it, as Yjs integrates it when it arrives on its own.
// It decodes the pending update P once. A cut is a struct of P that is not
// integrated while its dependencies (origin, right origin, and its parent
// when that is an item) all are, read from the document's store. Applying
// that client's suffix of P from the cut alone (every other client cut past
// its end in P), with nothing pending, integrates the cut and the structs
// after it up to the next blocked one. Passes over the clients repeat until
// one finds no cut, so every apply integrates at least one struct, and none
// is spent on a struct known to be blocked. A cut an apply does not
// integrate (Yjs no longer behaving as the contract says) is skipped. A
// budget of suffix applies (MAX_SUFFIX_APPLIES) bounds pathological input
// only: past it, what is not integrated stays pending, and integrates when
// its missing updates arrive.
//
// The pending structs are cleared before each apply, and every cleared one
// is kept: the repair ends by applying them all, merged, whole, so what is
// truly blocked (and anything an observer supplied meanwhile) is pending
// again. On a throw the same union is restored, never an older subset of
// it. A document with nothing pending (the common case) costs one apply.
//
// The @y/y internals this reads and writes (StructStore#pendingStructs, its
// `update` in Yjs update format V2 and its `missing`, clearing it, a
// client's structs in StructStore#clients, diffUpdateV2's cut by a state
// vector in format V1, mergeUpdatesV2, a Skip placeholder) are listed in the
// core's Yjs contract (YjsContract), whose development builds' probe runs
// this repair on scratch documents.

import {
  applyUpdate,
  applyUpdateV2,
  decodeUpdateV2,
  diffUpdateV2,
  type Doc,
  mergeUpdatesV2,
  Skip,
} from '@y/y';

const __DEV__ = process.env.NODE_ENV !== 'production';

/** The most suffix applies one repair makes (pathological input only). */
export const MAX_SUFFIX_APPLIES = 1024;

/**
 * Counters for tests (plain increments, in every build): every apply this
 * module makes, how many loads needed the repair, the cuts an apply did not
 * integrate, and the repairs that ran out of budget.
 */
export const LOAD_COUNTERS = {
  applies: 0,
  exhausted: 0,
  failedCuts: 0,
  repairs: 0,
};

/** The @y/y functions the repair calls (the contract's probe passes its own). */
export interface GapRepairYjs {
  readonly applyUpdateV2: typeof applyUpdateV2;
  readonly decodeUpdateV2: typeof decodeUpdateV2;
  readonly diffUpdateV2: typeof diffUpdateV2;
  readonly mergeUpdatesV2: typeof mergeUpdatesV2;
  readonly Skip: typeof Skip;
}

const Y: GapRepairYjs = {
  Skip,
  applyUpdateV2,
  decodeUpdateV2,
  diffUpdateV2,
  mergeUpdatesV2,
};

type PendingStructs = NonNullable<Doc['store']['pendingStructs']>;
type Struct = ReturnType<typeof decodeUpdateV2>['structs'][number];
interface StructId {
  readonly client: number;
  readonly clock: number;
}

/**
 * Apply stored bytes (Yjs update format V1) to `doc`, under `origin`, then
 * integrate what they hold pending behind a blocked struct (see above).
 * Each apply is a transaction of its own under `origin`, as applyUpdate's,
 * joining an enclosing one when there is one.
 */
export function applyStoredState(
  doc: Doc,
  update: Uint8Array,
  origin?: unknown,
): void {
  LOAD_COUNTERS.applies++;
  applyUpdate(doc, update, origin);
  integrateHeldBehindGaps(doc, origin);
}

/**
 * Integrate every struct `doc` holds pending whose dependencies are present
 * (see above). Nothing happens when nothing is pending.
 */
export function integrateHeldBehindGaps(doc: Doc, origin?: unknown): void {
  integrateHeldBehindGapsWith(Y, doc, origin);
}

/** What one repair did. */
export interface GapRepairResult {
  /**
   * Suffix applies attempted (normally each integrates at least one struct;
   * one that does not is a failed cut).
   */
  readonly suffixApplies: number;
  /** Cuts an apply did not integrate (skipped). */
  readonly failedCuts: number;
  /** Whether the budget ran out (the rest stays pending). */
  readonly exhausted: boolean;
}

const NOTHING: GapRepairResult = {
  exhausted: false,
  failedCuts: 0,
  suffixApplies: 0,
};

/**
 * integrateHeldBehindGaps with the given @y/y functions (see above).
 *
 * Work: P decoded once; passes over its structs, each check a binary
 * search of the store; at most `budget` suffix apply attempts (normally each
 * integrates at least one struct), then one apply of the kept pending
 * updates, merged. A suffix is cut from the whole of P, so a load with very
 * many separately integrable stretches does work that grows with their
 * number times P's size: about 1 s for 1,024 stretches in a 19 KB state.
 *
 * When an apply throws (an observer may), the kept pending updates are
 * restored, merged (see restorePending), the repair stops, and the error is
 * rethrown in development builds (`rethrow`) only: in production the load
 * goes on as a plain apply would have left it, never worse.
 */
export function integrateHeldBehindGapsWith(
  y: GapRepairYjs,
  doc: Doc,
  origin?: unknown,
  rethrow: boolean = __DEV__,
  budget: number = MAX_SUFFIX_APPLIES,
): GapRepairResult {
  const first = doc.store.pendingStructs;
  if (first === null) {
    return NOTHING;
  }
  LOAD_COUNTERS.repairs++;
  const update = first.update;
  const kept: PendingStructs[] = [];
  const takePending = () => {
    const pending = doc.store.pendingStructs;
    if (pending !== null) {
      kept.push(pending);
      doc.store.pendingStructs = null;
    }
  };
  let suffixApplies = 0;
  let failedCuts = 0;
  let exhausted = false;
  try {
    const runs = clientRuns(y, update);
    const failed = new Set<Struct>();
    let progress = true;
    passes: while (progress) {
      progress = false;
      for (const [client, run] of runs) {
        for (const struct of run.structs) {
          if (
            failed.has(struct) ||
            structIntegrated(y, doc, struct.id) ||
            !dependenciesIntegrated(y, doc, struct)
          ) {
            continue;
          }
          if (suffixApplies >= budget) {
            exhausted = true;
            break passes;
          }
          suffixApplies++;
          const vector: [number, number][] = [[client, struct.id.clock]];
          for (const [other, otherRun] of runs) {
            if (other !== client) {
              vector.push([other, otherRun.end]);
            }
          }
          // Nothing pending: the suffix arrives alone.
          takePending();
          LOAD_COUNTERS.applies++;
          y.applyUpdateV2(
            doc,
            y.diffUpdateV2(update, encodeStateVector(vector)),
            origin,
          );
          if (structIntegrated(y, doc, struct.id)) {
            progress = true;
          } else {
            failed.add(struct);
            failedCuts++;
          }
        }
      }
    }
    // Everything cleared, back whole: what is still blocked is pending again.
    takePending();
    LOAD_COUNTERS.applies++;
    y.applyUpdateV2(doc, y.mergeUpdatesV2(kept.map(p => p.update)), origin);
  } catch (error) {
    restorePending(y, doc, kept, origin);
    if (rethrow) {
      throw error;
    }
  }
  LOAD_COUNTERS.failedCuts += failedCuts;
  if (exhausted) {
    LOAD_COUNTERS.exhausted++;
  }
  return {exhausted, failedCuts, suffixApplies};
}

/**
 * Put back every pending update a failed repair cleared, with what is
 * pending now: their union, applied whole; if that throws too, the union
 * (merged, each client's least missing clock) is set as the pending structs
 * directly. Never an older subset: what an observer supplied is in it. A
 * struct integrated meanwhile is skipped when Yjs retries them.
 */
function restorePending(
  y: GapRepairYjs,
  doc: Doc,
  kept: PendingStructs[],
  origin: unknown,
): void {
  const take = () => {
    const pending = doc.store.pendingStructs;
    if (pending !== null) {
      kept.push(pending);
      doc.store.pendingStructs = null;
    }
  };
  take();
  if (kept.length === 0) {
    return;
  }
  try {
    LOAD_COUNTERS.applies++;
    y.applyUpdateV2(doc, y.mergeUpdatesV2(kept.map(p => p.update)), origin);
  } catch {
    take();
    const missing = new Map<number, number>();
    for (const p of kept) {
      p.missing.forEach((clock, client) => {
        const known = missing.get(client);
        missing.set(
          client,
          known === undefined ? clock : Math.min(known, clock),
        );
      });
    }
    doc.store.pendingStructs = {
      missing,
      update: y.mergeUpdatesV2(kept.map(p => p.update)),
    };
  }
}

/**
 * The structs of a pending update (Yjs update format V2), by client, sorted
 * by clock, and the clock past the last one (Skip placeholders left out).
 */
function clientRuns(
  y: GapRepairYjs,
  update: Uint8Array,
): Map<number, {structs: Struct[]; end: number}> {
  const runs = new Map<number, {structs: Struct[]; end: number}>();
  for (const struct of y.decodeUpdateV2(update).structs) {
    if (struct instanceof y.Skip) {
      continue;
    }
    const {client, clock} = struct.id;
    const end = clock + struct.length;
    const run = runs.get(client);
    if (run === undefined) {
      runs.set(client, {end, structs: [struct]});
    } else {
      run.structs.push(struct);
      run.end = Math.max(run.end, end);
    }
  }
  for (const run of runs.values()) {
    run.structs.sort((a, b) => a.id.clock - b.id.clock);
  }
  return runs;
}

/**
 * Whether `doc` holds the struct at `id`: an item or a GC struct covering
 * its clock in the client's structs (a Skip placeholder does not count).
 */
export function structIntegrated(
  y: Pick<GapRepairYjs, 'Skip'>,
  doc: Doc,
  id: StructId,
): boolean {
  const structs = doc.store.clients.get(id.client);
  if (structs === undefined) {
    return false;
  }
  let lo = 0;
  let hi = structs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const struct = structs[mid];
    if (id.clock < struct.id.clock) {
      hi = mid - 1;
    } else if (id.clock >= struct.id.clock + struct.length) {
      lo = mid + 1;
    } else {
      return !(struct instanceof y.Skip);
    }
  }
  return false;
}

/** Whether the structs `struct` depends on are in `doc` (see above). */
function dependenciesIntegrated(
  y: GapRepairYjs,
  doc: Doc,
  struct: Struct,
): boolean {
  const item = struct as {
    origin?: StructId | null;
    rightOrigin?: StructId | null;
    parent?: unknown;
  };
  if (item.origin && !structIntegrated(y, doc, item.origin)) {
    return false;
  }
  if (item.rightOrigin && !structIntegrated(y, doc, item.rightOrigin)) {
    return false;
  }
  const parent = item.parent as {client?: unknown; clock?: unknown} | null;
  if (
    parent !== null &&
    typeof parent === 'object' &&
    typeof parent.client === 'number' &&
    typeof parent.clock === 'number' &&
    !structIntegrated(y, doc, parent as StructId)
  ) {
    return false;
  }
  return true;
}

/**
 * A state vector in Yjs's format V1 (as encodeStateVector writes it: the
 * count, then each client and clock, unsigned varints), written here so that
 * no Map of this realm reaches @y/y (which tells a Map from a document by
 * its class).
 */
export function encodeStateVector(
  entries: readonly (readonly [number, number])[],
): Uint8Array {
  const bytes: number[] = [];
  const varUint = (value: number) => {
    let n = value;
    while (n > 0x7f) {
      bytes.push(0x80 | (n % 0x80));
      n = Math.floor(n / 0x80);
    }
    bytes.push(n);
  };
  varUint(entries.length);
  for (const [client, clock] of entries) {
    varUint(client);
    varUint(clock);
  }
  return new Uint8Array(bytes);
}
