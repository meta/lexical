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
// TEMPORARY: this module is our workaround for a @y/y bug, yjs/yjs#824
// (https://github.com/yjs/yjs/issues/824), whose upstream fix is
// yjs/yjs#827 (https://github.com/yjs/yjs/pull/827). It exists only until
// a @y/y release that contains that fix (or an equivalent one) is the
// version @lexical/y supports; then drop it in favor of @y/y's own decode.
// Removal steps:
//
// 1. Before the bump, keep bytes stored the old way: under @y/y
//    14.0.0-rc.29, write the stored states of the outcome cases of
//    src/__tests__/unit/regressions/LoadAcrossGap.test.ts (states with a
//    gap) and what the repaired load shows to fixtures, since those cases
//    generate their states with whichever @y/y is installed.
// 2. Bump @y/y to the fixed release in all three pins:
//    packages/lexical-y/package.json's peerDependencies and
//    devDependencies, and packages/lexical-playground/package.json's
//    dependencies; then `pnpm install` (refreshing pnpm-lock.yaml) and
//    `pnpm run update-version` (which regenerates SupportedYjs.ts). "the
//    supported version" test in YjsContract.test.ts checks that the pins
//    and the installed @y/y agree. The signal that the fix is in: the test
//    "the installed @y/y still needs the loader repair" in
//    src/__tests__/unit/YjsContract.test.ts fails, and the development
//    probe (YjsContract's probeGapLoad) logs GAP_REPAIR_RETIRABLE_WARNING
//    instead of refusing that @y/y (D114).
// 3. Check D112's removal condition before deleting anything: the fixed
//    @y/y must load the states already stored with the old batching as this
//    repair does. Load the fixtures from step 1, unchanged, with a plain
//    `applyUpdate`, and check each shows what the repaired load showed;
//    keep that as a plain-load regression test.
// 4. Delete this module and its mechanism tests:
//    - src/internal/LoadFully.ts;
//    - the rest of src/__tests__/unit/regressions/LoadAcrossGap.test.ts
//      (everything that uses what it imports from LoadFully:
//      applyStoredState, GapRepairYjs, integrateHeldBehindGapsWith,
//      LOAD_COUNTERS, LOAD_PLAN_COUNTERS, LOAD_TEST_HOOKS,
//      MAX_SUFFIX_APPLIES, MAX_TRIAL_VISITS, planGapRepairForTests);
//    - src/__tests__/unit/regressions/FixedYjsNotRefused.test.ts (it builds
//      a fixed @y/y from this module's repair);
//    - in src/internal/YjsContract.ts: probeGapLoad and its call in
//      probeMembers, GAP_PROBE_KINDS and the `!__DEV__ &&
//      GAP_PROBE_KINDS.has(kind)` skip in probeMembers' check of every kind,
//      GapRepairStatus, the `gapRepair` variable, getGapRepairStatus,
//      GAP_REPAIR_RETIRABLE_WARNING, the import from './LoadFully', and the
//      `'StructStore.pendingStructs'` and `decodeUpdateV2` member kinds if
//      nothing else uses them (YjsContract.test's "lists exactly what the
//      sources use of @y/y" says which entries to drop);
//    - in src/__tests__/unit/YjsContract.test.ts: the describe block "the
//      gap repair's part of the contract (LoadFully)" and the imports only
//      it uses (encodeGapStateVector, integrateHeldBehindGaps,
//      GAP_REPAIR_RETIRABLE_WARNING, getGapRepairStatus).
//    Then `pnpm run tsc` names anything left.
// 5. Replace the entry points with plain applies:
//    `applyStoredState(doc, state)` becomes `applyUpdate(doc, state)` in
//    YDoc.ts, RawYDoc.ts, HeadlessEditor.ts and Runner.ts, and Server.ts
//    drops its `integrateHeldBehindGaps(doc)` call. Check that the
//    migration goldens (src/__tests__/unit/golden/migrate-*-r1.json) are
//    unchanged.
// 6. Docs: remove the paragraph on the loaders' repair ("Causal order
//    includes each client's own order") from
//    packages/lexical-website/docs/collaboration/y.md, mark D112 and D114
//    in DECISIONS.md as replaced by the @y/y release (rows are never
//    deleted), and add a changeset.
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
  ContentFormat,
  ContentType,
  decodeUpdateV2,
  diffUpdateV2,
  Doc,
  encodeStateAsUpdateV2,
  type Item,
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
  /** The most bytes of pending updates one repair held at a time. */
  keptBytes: 0,
  repairs: 0,
};

/**
 * Counters of the plan (plain increments, in every build): checks that
 * failed (they never should), loads checked (see choosePlan) and those
 * whose copy was not exact, loads that applied the maximal plan as it is;
 * checked loads that did not apply the first candidate; cuts the format
 * rule held back; cuts whose apply did not integrate what the plan
 * predicted (Yjs no longer behaving as the contract says, or an observer
 * supplying a dependency); and which candidate each checked load applied.
 */
export const LOAD_PLAN_COUNTERS = {
  checkFailed: 0,
  checks: 0,
  copyInexact: 0,
  direct: 0,
  formatFallback: 0,
  heldBack: 0,
  mispredicted: 0,
  /** Struct visits of the format rule's trials (see MAX_TRIAL_VISITS). */
  trialVisits: 0,
  /** V built on the held result that differs from V on its own (tests). */
  vMismatch: 0,
  wins: {held: 0, maximal: 0, plain: 0},
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
 *
 * Temporary, until a supported @y/y release contains yjs/yjs#827 (the fix
 * for yjs/yjs#824): then every caller uses a plain `applyUpdate(doc,
 * update, origin)` instead. Removal steps: this module's header.
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
 *
 * Temporary, until a supported @y/y release contains yjs/yjs#827 (the fix
 * for yjs/yjs#824): then @y/y's own apply integrates these structs and the
 * call is dropped. Removal steps: this module's header.
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
 * Temporary like the rest of this module (yjs/yjs#824, fixed upstream by
 * yjs/yjs#827; removal steps in this module's header).
 *
 * Work: P decoded once; passes over its structs, each check a binary
 * search of the store; at most `budget` suffix apply attempts (normally each
 * integrates at least one struct), then one apply of the kept pending
 * updates, merged. A suffix is cut from the whole of P, so a load with very
 * many separately integrable stretches does work that grows with their
 * number times P's size: about 1 s for 1,024 stretches in a 19 KB state.
 * A load whose plan holds a cut back, or overwrites an entry the document
 * shows, also copies the document and repairs the copy first (see
 * choosePlan); any other applies the maximal plan as it is, at its cost.
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
  /** The view rules and check (see choosePlan); off only to measure them. */
  formatRule: boolean = true,
): GapRepairResult {
  const first = doc.store.pendingStructs;
  if (first === null) {
    return NOTHING;
  }
  LOAD_COUNTERS.repairs++;
  const update = first.update;
  let runs: Runs;
  let plan: Plan;
  let chosen: View | null = null;
  let scope: Scope | null = null;
  try {
    runs = clientRuns(y, update);
    const maximal = simulate(y, doc, runs, budget, new Set());
    plan = maximal.plan;
    if (formatRule && plan.cuts.length > 0) {
      // A plan the budget cut short takes no holds: a hold could free
      // budget for cuts the maximal repair never applies, and the check's V
      // is built on the held result.
      const held = plan.exhausted
        ? {hold: new Set<Struct>(), sim: maximal}
        : planHolding(y, doc, runs, budget, maximal, new Set());
      LOAD_PLAN_COUNTERS.heldBack += held.hold.size;
      if (held.hold.size === 0 && !overwritesVisible(doc, runs, plan)) {
        // Nothing held back and no entry shown overwritten: the maximal
        // plan, applied as it is, passes the check (see choosePlan).
        LOAD_PLAN_COUNTERS.direct++;
        const hook = LOAD_TEST_HOOKS.direct;
        if (hook !== null) {
          hook(() => checkPasses(doc, update, runs, maximal));
        }
      } else {
        const choice = choosePlan(doc, update, runs, maximal, held.sim.plan);
        plan = choice.plan;
        chosen = choice.view;
        scope = choice.scope;
      }
    }
  } catch (error) {
    if (rethrow) {
      throw error;
    }
    return NOTHING;
  }
  // Transactions while the plan applies: more than its own applies means
  // something else wrote (an observer may), and the document is no longer
  // the copy's to compare with.
  let transactions = 0;
  const count = () => {
    transactions++;
  };
  const appliesBefore = LOAD_COUNTERS.applies;
  if (chosen !== null) {
    doc.on('afterTransaction', count);
  }
  let result: ReturnType<typeof applyPlan>;
  try {
    result = applyPlan(y, doc, update, runs, plan.cuts, origin, rethrow);
  } finally {
    if (chosen !== null) {
      doc.off('afterTransaction', count);
    }
  }
  LOAD_COUNTERS.failedCuts += result.failedCuts;
  if (plan.exhausted) {
    LOAD_COUNTERS.exhausted++;
  }
  // The document shows what the chosen candidate showed on its copy (what
  // an observer wrote meanwhile aside).
  if (
    rethrow &&
    chosen !== null &&
    scope !== null &&
    result.planHeld &&
    transactions <= LOAD_COUNTERS.applies - appliesBefore &&
    !sameView(viewOf(doc, scope), chosen)
  ) {
    throw new Error(
      '@lexical/y: the load repair shows otherwise than the plan it chose did on a copy',
    );
  }
  return {
    exhausted: plan.exhausted,
    failedCuts: result.failedCuts,
    suffixApplies: result.suffixApplies,
  };
}

/**
 * For tests: called on each load that applies the maximal plan without the
 * check, with a function that runs the check on a copy and says whether it
 * passes.
 */
export const LOAD_TEST_HOOKS: {
  direct: ((wouldPass: () => boolean) => void) | null;
  /** Called inside the check (a test makes it throw). */
  check: (() => void) | null;
  /**
   * Whether the check also builds V on a copy of its own, and counts a V
   * built on the held result that differs (`vMismatch`).
   */
  verifyV: boolean;
} = {check: null, direct: null, verifyV: false};

type Runs = Map<number, {structs: Struct[]; end: number}>;

/**
 * Applies `cuts` to `doc` (each suffix alone, nothing pending, checked
 * against the plan), then the cleared pending updates merged, whole. When an
 * apply throws, the kept pending updates are restored and the error is
 * rethrown with `rethrow` only.
 */
function applyPlan(
  y: GapRepairYjs,
  doc: Doc,
  update: Uint8Array,
  runs: Runs,
  cuts: readonly Cut[],
  origin: unknown,
  rethrow: boolean,
  /** Whether the applies count (not on a copy, see choosePlan). */
  count = true,
  /**
   * Whether a stop that integrated breaks the plan (not when the cuts
   * finish a plan another one started, see choosePlan).
   */
  checkStop = true,
): {suffixApplies: number; failedCuts: number; planHeld: boolean} {
  // P, plus whatever else was pending when the repair cleared it: a pending
  // update a suffix leaves is part of P (dropped), anything outside P (an
  // observer's update) is merged in. So it stays about P's size however many
  // suffixes run, and never loses material.
  let kept: PendingStructs | null = null;
  const held = heldRanges(runs);
  const takePending = () => {
    const pending = doc.store.pendingStructs;
    if (pending === null) {
      return;
    }
    // Kept before the slot is cleared, so a throw here loses nothing.
    if (kept === null) {
      kept = pending;
    } else if (!heldBy(y, pending.update, held)) {
      kept = unionPending(y, kept, pending);
    }
    doc.store.pendingStructs = null;
    if (count) {
      LOAD_COUNTERS.keptBytes = Math.max(
        LOAD_COUNTERS.keptBytes,
        kept.update.length,
      );
    }
  };
  let suffixApplies = 0;
  let failedCuts = 0;
  let planHeld = true;
  try {
    for (const cut of cuts) {
      suffixApplies++;
      const vector: [number, number][] = [[cut.client, cut.from.id.clock]];
      for (const [other, otherRun] of runs) {
        if (other !== cut.client) {
          vector.push([other, otherRun.end]);
        }
      }
      takePending();
      LOAD_COUNTERS.applies += count ? 1 : 0;
      y.applyUpdateV2(
        doc,
        y.diffUpdateV2(update, encodeStateVector(vector)),
        origin,
      );
      // What the plan predicted: the run integrated, and the struct that
      // ends it not. A run that did not integrate means @y/y integrates
      // otherwise (thrown in development); a stop that did means something
      // supplied its dependency (an observer may). Either way the rest of
      // the plan no longer holds.
      const integrated = cut.run.every(struct =>
        structIntegrated(y, doc, struct.id),
      );
      if (
        !integrated ||
        (checkStop &&
          cut.stop !== null &&
          structIntegrated(y, doc, cut.stop.id))
      ) {
        failedCuts++;
        LOAD_PLAN_COUNTERS.mispredicted += count ? 1 : 0;
        planHeld = false;
        if (!integrated && rethrow) {
          throw new Error(
            `@lexical/y: the load repair's plan did not hold at ${cut.client}:${cut.from.id.clock} (the @y/y it runs on integrates otherwise)`,
          );
        }
        break;
      }
    }
    // No cut: nothing was cleared, and what is pending is P as it was.
    if (suffixApplies > 0) {
      // Everything cleared, back whole: what is still blocked is pending
      // again.
      takePending();
      // Read through a cast: TypeScript does not see the closure assign it.
      const all = kept as PendingStructs | null;
      if (all !== null) {
        LOAD_COUNTERS.applies += count ? 1 : 0;
        y.applyUpdateV2(doc, all.update, origin);
      }
    }
  } catch (error) {
    planHeld = false;
    restorePending(y, doc, kept, origin);
    if (rethrow) {
      throw error;
    }
  }
  return {failedCuts, planHeld, suffixApplies};
}

/**
 * The types a load can change (see scopeOf), by key (a root as `r:` and
 * its name, canonical, a type as `i:` and its item's id): `types`, only
 * their own list and map; `deep`, types whose whole subtree counts (the
 * value of an entry a struct of P may overwrite).
 */
type TypeRef = {readonly name: string} | {readonly id: StructId};

interface Scope {
  readonly types: ReadonlyMap<string, TypeRef>;
  readonly deep: ReadonlyMap<string, TypeRef>;
}

/**
 * The types the structs of P can change: each struct's parent (its own, or
 * that of the item it is inserted next to, in the document or in P), and,
 * for a map entry whose key holds a visible entry whose value is a type,
 * that type's subtree (an overwrite deletes it). A struct whose parent
 * cannot be resolved has a dependency neither holds, so nothing integrates
 * it. Every other type keeps what it shows: integrating an item changes
 * only its parent's list and map, and the attributes of a unit come from
 * the format items of its own list. The walks are iterative and memoized:
 * work linear in P's structs, whatever their dependency chains.
 */
function scopeOf(doc: Doc, runs: Runs): Scope {
  const names = new Map<unknown, string>();
  doc.share.forEach((type, name) => names.set(type, name));
  const refs = new Map<string, TypeRef>();
  const rootKey = (name: string) => {
    const key = `r:${name.length}:${name}`;
    refs.set(key, {name});
    return key;
  };
  const itemKey = (id: StructId) => {
    const key = `i:${id.client}:${id.clock}`;
    refs.set(key, {id});
    return key;
  };
  const keyOfType = (type: {_item?: Item | null}): string | null => {
    const owner = type._item;
    if (owner !== undefined && owner !== null) {
      return itemKey(owner.id);
    }
    const name = names.get(type);
    return name === undefined ? null : rootKey(name);
  };
  const inP = (id: StructId): Struct | null => {
    const run = runs.get(id.client);
    const i = run === undefined ? -1 : structAt(run.structs, id.clock);
    return i === -1 ? null : run!.structs[i];
  };
  // A struct's parent key, null when it cannot be resolved; `next` is the
  // struct of P it takes its parent from, when that is one.
  const resolved = new Map<Struct, string | null>();
  const step = (struct: Struct): {key: string | null; next: Struct | null} => {
    const item = struct as {
      origin?: StructId | null;
      rightOrigin?: StructId | null;
      parent?: unknown;
    };
    if (typeof item.parent === 'string') {
      return {key: rootKey(item.parent), next: null};
    }
    if (isId(item.parent)) {
      return {key: itemKey(item.parent), next: null};
    }
    const via = item.origin || item.rightOrigin;
    if (!via) {
      return {key: null, next: null};
    }
    const neighbor = itemAt(doc, via);
    if (neighbor !== null) {
      return {key: keyOfType(neighbor.parent as never), next: null};
    }
    return {key: null, next: inP(via)};
  };
  const parentOf = (start: Struct): string | null => {
    const chain: Struct[] = [];
    const onChain = new Set<Struct>();
    let current: Struct | null = start;
    let key: string | null = null;
    while (current !== null) {
      if (resolved.has(current)) {
        key = resolved.get(current)!;
        break;
      }
      if (onChain.has(current)) {
        key = null;
        break;
      }
      onChain.add(current);
      chain.push(current);
      const next = step(current);
      key = next.key;
      current = next.next;
      if (current === null) {
        break;
      }
    }
    for (const struct of chain) {
      resolved.set(struct, key);
    }
    return key;
  };
  const targets = entryTargets(doc, runs);
  const types = new Map<string, TypeRef>();
  const deep = new Map<string, TypeRef>();
  for (const run of runs.values()) {
    for (const struct of run.structs) {
      const key = parentOf(struct);
      if (key !== null) {
        types.set(key, refs.get(key)!);
      }
      const target = targets(struct);
      if (target !== null) {
        const entry = target.type._map.get(target.key);
        if (
          entry !== undefined &&
          !entry.deleted &&
          entry.content instanceof ContentType
        ) {
          deep.set(`i:${entry.id.client}:${entry.id.clock}`, {id: entry.id});
        }
      }
    }
  }
  return {deep, types};
}

function isId(value: unknown): value is StructId {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StructId).client === 'number' &&
    typeof (value as StructId).clock === 'number' &&
    !('_map' in value)
  );
}

type MapType = {_map: Map<string, Item>};

/**
 * The map and key each decoded struct is an entry of: its own parent and
 * key, or those of the item it overwrites (its origin, in the document or,
 * in turn, in P); null for a struct of a list. Iterative and memoized.
 */
function entryTargets(
  doc: Doc,
  runs: Runs,
): (struct: Struct) => {type: MapType; key: string} | null {
  type Target = {type: MapType; key: string} | null;
  const memo = new Map<Struct, Target>();
  const own = (struct: Struct): {target: Target; next: Struct | null} => {
    const item = struct as {
      origin?: StructId | null;
      parent?: unknown;
      parentSub?: string | null;
    };
    if (item.parentSub != null) {
      const parent = item.parent;
      let type: unknown;
      if (typeof parent === 'string') {
        type = doc.share.get(parent);
      } else if (isId(parent)) {
        const owner = itemAt(doc, parent);
        type =
          owner !== null && owner.content instanceof ContentType
            ? owner.content.type
            : undefined;
      } else {
        type = parent;
      }
      return {
        next: null,
        target:
          type !== undefined && type !== null && '_map' in (type as object)
            ? {key: item.parentSub, type: type as MapType}
            : null,
      };
    }
    if (!item.origin) {
      return {next: null, target: null};
    }
    const left = itemAt(doc, item.origin);
    if (left !== null) {
      return {
        next: null,
        target:
          left.parentSub !== null
            ? {key: left.parentSub, type: left.parent as unknown as MapType}
            : null,
      };
    }
    const run = runs.get(item.origin.client);
    const i = run === undefined ? -1 : structAt(run.structs, item.origin.clock);
    return {next: i === -1 ? null : run!.structs[i], target: null};
  };
  return start => {
    const chain: Struct[] = [];
    const onChain = new Set<Struct>();
    let current: Struct | null = start;
    let target: Target = null;
    while (current !== null) {
      if (memo.has(current)) {
        target = memo.get(current)!;
        break;
      }
      if (onChain.has(current)) {
        target = null;
        break;
      }
      onChain.add(current);
      chain.push(current);
      const next = own(current);
      target = next.target;
      current = next.next;
    }
    for (const struct of chain) {
      memo.set(struct, target);
    }
    return target;
  };
}

/**
 * Whether a run of `plan` carries a map entry whose key holds a visible
 * entry: the only way integrating can delete what the document shows (the
 * entry it overwrites, and what that entry holds).
 */
function overwritesVisible(doc: Doc, runs: Runs, plan: Plan): boolean {
  const targets = entryTargets(doc, runs);
  for (const cut of plan.cuts) {
    for (const struct of cut.run) {
      const target = targets(struct);
      if (target !== null) {
        const entry = target.type._map.get(target.key);
        if (entry !== undefined && !entry.deleted) {
          return true;
        }
      }
    }
  }
  return false;
}

/** The item of `doc` holding `id`, null when none (or a GC struct). */
function itemAt(doc: Doc, id: StructId): Item | null {
  const structs = doc.store.clients.get(id.client);
  if (structs === undefined) {
    return null;
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
      return 'content' in struct && 'parentSub' in struct
        ? (struct as Item)
        : null;
    }
  }
  return null;
}

/**
 * What a document shows in a scope, at the Yjs level, by the items that
 * supply it: `units`, by client, the clock ranges of its countable items (a
 * character, an embed, a type) not deleted, each with its attributes as the
 * format items in effect (key and item id; a null value removes the key),
 * sorted and merged; and `entries`, its map entries not deleted, by type key
 * and key, as the id of the item that holds the value. The copies and the
 * document share struct ids, so the same id means the same value; a
 * different item with an equal value counts as different (stricter). A
 * scope's types count their own list and map; its deep types, their whole
 * subtree, walked iteratively.
 */
interface View {
  readonly units: Map<number, [number, number, string][]>;
  readonly entries: Map<string, string>;
}

function viewOf(doc: Doc, scope: Scope): View {
  const units = new Map<number, [number, number, string][]>();
  const entries = new Map<string, string>();
  const seen = new Set<string>();
  const typeOf = (ref: TypeRef): unknown => {
    if ('name' in ref) {
      return doc.share.get(ref.name);
    }
    const item = itemAt(doc, ref.id);
    return item !== null && !item.deleted && item.content instanceof ContentType
      ? item.content.type
      : undefined;
  };
  type Walk = {
    type: {_start: Item | null; _map?: Map<string, Item>};
    key: string;
    deep: boolean;
  };
  const pending: Walk[] = [];
  const visit = ({type, key, deep}: Walk) => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const attrs = new Map<string, string>();
    let supplied = '';
    for (let it = type._start; it !== null; it = it.right) {
      if (it.deleted) {
        continue;
      }
      const content = it.content;
      const {client, clock} = it.id;
      if (content instanceof ContentFormat) {
        if (content.value === null) {
          attrs.delete(content.key);
        } else {
          attrs.set(content.key, `${client}:${clock}`);
        }
        supplied = [...attrs]
          .sort((x, z) => (x[0] < z[0] ? -1 : 1))
          .map(([k, id]) => `${k.length}:${k}=${id}`)
          .join(',');
        continue;
      }
      if (it.countable) {
        let list = units.get(client);
        if (list === undefined) {
          list = [];
          units.set(client, list);
        }
        list.push([clock, clock + it.length, supplied]);
      }
      if (deep && content instanceof ContentType) {
        pending.push({
          deep: true,
          key: `i:${client}:${clock}`,
          type: content.type as never,
        });
      }
    }
    if (type._map !== undefined) {
      type._map.forEach((item, name) => {
        if (item.deleted) {
          return;
        }
        const {client, clock} = item.id;
        entries.set(`${key}|${name.length}:${name}`, `${client}:${clock}`);
        if (deep && item.content instanceof ContentType) {
          pending.push({
            deep: true,
            key: `i:${client}:${clock}`,
            type: item.content.type as never,
          });
        }
      });
    }
  };
  for (const [key, ref] of scope.deep) {
    const type = typeOf(ref);
    if (type !== undefined) {
      pending.push({deep: true, key, type: type as never});
    }
    while (pending.length > 0) {
      visit(pending.pop()!);
    }
  }
  for (const [key, ref] of scope.types) {
    const type = typeOf(ref);
    if (type !== undefined) {
      visit({deep: false, key, type: type as never});
    }
  }
  for (const list of units.values()) {
    list.sort((x, z) => x[0] - z[0]);
    let n = 0;
    for (const range of list) {
      const last = n > 0 ? list[n - 1] : null;
      if (last !== null && last[1] === range[0] && last[2] === range[2]) {
        last[1] = range[1];
      } else {
        list[n++] = range;
      }
    }
    list.length = n;
  }
  return {entries, units};
}

function sameView(a: View, b: View): boolean {
  if (a.units.size !== b.units.size || a.entries.size !== b.entries.size) {
    return false;
  }
  for (const [client, list] of a.units) {
    const other = b.units.get(client);
    if (
      other === undefined ||
      other.length !== list.length ||
      list.some(
        (r, i) =>
          r[0] !== other[i][0] || r[1] !== other[i][1] || r[2] !== other[i][2],
      )
    ) {
      return false;
    }
  }
  for (const [key, value] of a.entries) {
    if (b.entries.get(key) !== value) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a candidate's result R may be shown, given what the plain load
 * shows (P) and what the maximal repair shows (V): (a) R shows every unit P
 * shows (never less than a plain load); (b) every unit R shows, P or V
 * shows; (c) each unit's attributes are P's or V's (of those that show
 * it); (d) each map entry's value, absent included, is P's or V's. Units
 * compare by clock range: each elementary range between the views'
 * boundaries once.
 */
function accepts(p: View, r: View, v: View): boolean {
  const clients = new Set([
    ...p.units.keys(),
    ...r.units.keys(),
    ...v.units.keys(),
  ]);
  for (const client of clients) {
    const lists = [p, r, v].map(view => view.units.get(client) ?? []);
    const bounds: number[] = [];
    for (const list of lists) {
      for (const [start, end] of list) {
        bounds.push(start, end);
      }
    }
    bounds.sort((x, z) => x - z);
    const at = [0, 0, 0];
    // Attributes of `list` at `clock` (undefined where it shows nothing).
    const attrsAt = (k: number, clock: number): string | undefined => {
      const list = lists[k];
      while (at[k] < list.length && list[at[k]][1] <= clock) {
        at[k]++;
      }
      const range = list[at[k]];
      return range !== undefined && range[0] <= clock ? range[2] : undefined;
    };
    for (let i = 0; i < bounds.length; i++) {
      const clock = bounds[i];
      if (i > 0 && clock === bounds[i - 1]) {
        continue;
      }
      const plain = attrsAt(0, clock);
      const shown = attrsAt(1, clock);
      const maximal = attrsAt(2, clock);
      if (plain !== undefined && shown === undefined) {
        return false;
      }
      if (shown !== undefined && shown !== plain && shown !== maximal) {
        return false;
      }
    }
  }
  for (const map of [p.entries, v.entries, r.entries]) {
    for (const key of map.keys()) {
      const value = r.entries.get(key);
      if (value !== p.entries.get(key) && value !== v.entries.get(key)) {
        return false;
      }
    }
  }
  return true;
}

/** Which candidate each checked load applied (see choosePlan). */
type Candidate = 'held' | 'maximal' | 'plain';

const PLAIN: Plan = {cuts: [], exhausted: false, heldBack: 0};

/**
 * The check, on a load whose plan holds a cut back or overwrites an entry
 * the document shows. On one exact copy of the document (no apply can be
 * undone), it applies the held plan and reads what it shows (R), then the
 * maximal plan's cuts whose runs are not integrated, in its order, which
 * gives the maximal repair's result (V), and reads it. It applies to the
 * document the held plan when R passes (see accepts), else the maximal plan
 * when V shows all the document showed before (P), else no cut (the plain
 * load, which always passes; also chosen when the copy is not exact). Views
 * cover only the types the load can change (see scopeOf).
 */
function choosePlan(
  doc: Doc,
  update: Uint8Array,
  runs: Runs,
  maximal: Simulation,
  held: Plan,
): {plan: Plan; view: View | null; scope: Scope} {
  LOAD_PLAN_COUNTERS.checks++;
  const scope = scopeOf(doc, runs);
  const choose = (name: Candidate, plan: Plan, view: View | null) => {
    LOAD_PLAN_COUNTERS.wins[name]++;
    if (name !== 'held') {
      LOAD_PLAN_COUNTERS.formatFallback++;
    }
    return {plan, scope, view};
  };
  let p: View;
  let results: {r: View | null; v: View | null} | null;
  try {
    p = viewOf(doc, scope);
    results = candidateViews(doc, update, runs, maximal, held, scope, p);
    const hook = LOAD_TEST_HOOKS.check;
    if (hook !== null) {
      hook();
    }
  } catch {
    // An exception means the reasoning about the document was wrong: the
    // plain load, the one result that needs none.
    LOAD_PLAN_COUNTERS.checkFailed++;
    return choose('plain', PLAIN, null);
  }
  if (results === null) {
    LOAD_PLAN_COUNTERS.copyInexact++;
    return choose('plain', PLAIN, p);
  }
  const {r, v} = results;
  if (r !== null && v !== null && accepts(p, r, v)) {
    return choose('held', held, r);
  }
  if (v !== null && accepts(p, v, v)) {
    return choose('maximal', maximal.plan, v);
  }
  return choose('plain', PLAIN, p);
}

/**
 * R and V on one copy of the document (see choosePlan), null for one whose
 * plan did not hold there; null when the copy is not exact. The copy is
 * made and repaired with the installed @y/y (Y): this module's own work,
 * not the caller's.
 */
function candidateViews(
  doc: Doc,
  update: Uint8Array,
  runs: Runs,
  maximal: Simulation,
  held: Plan,
  scope: Scope,
  p: View,
): {r: View | null; v: View | null} | null {
  const copy = exactCopy(doc, scope, p);
  if (copy === null) {
    return null;
  }
  try {
    const first = applyPlan(
      Y,
      copy,
      update,
      runs,
      held.cuts,
      undefined,
      false,
      false,
    );
    if (!first.planHeld) {
      return {r: null, v: null};
    }
    const r = viewOf(copy, scope);
    const rest = maximal.plan.cuts.filter(
      cut => !cut.run.every(struct => structIntegrated(Y, copy, struct.id)),
    );
    const second = applyPlan(
      Y,
      copy,
      update,
      runs,
      rest,
      undefined,
      false,
      false,
      false,
    );
    const v = second.planHeld ? viewOf(copy, scope) : null;
    if (LOAD_TEST_HOOKS.verifyV && v !== null) {
      const own = exactCopy(doc, scope, p);
      if (own !== null) {
        try {
          applyPlan(
            Y,
            own,
            update,
            runs,
            maximal.plan.cuts,
            undefined,
            false,
            false,
          );
          if (!sameView(viewOf(own, scope), v)) {
            LOAD_PLAN_COUNTERS.vMismatch++;
          }
        } finally {
          own.destroy();
        }
      }
    }
    return {r, v};
  } finally {
    copy.destroy();
  }
}

/**
 * Whether the check (see choosePlan) passes the maximal plan as it is: for
 * tests, on loads that skip it (LOAD_TEST_HOOKS).
 */
function checkPasses(
  doc: Doc,
  update: Uint8Array,
  runs: Runs,
  maximal: Simulation,
): boolean {
  const scope = scopeOf(doc, runs);
  const p = viewOf(doc, scope);
  const results = candidateViews(
    doc,
    update,
    runs,
    maximal,
    maximal.plan,
    scope,
    p,
  );
  return (
    results !== null &&
    results.r !== null &&
    results.v !== null &&
    sameView(results.r, results.v) &&
    accepts(p, results.r, results.v)
  );
}

/**
 * A copy of `doc` as it is: a new document with the same store (its own
 * encoding without the pending parts, which keeps its Skip placeholders)
 * and the same pending parts. Null when it is not exact: its clocks or
 * pending parts differ, or it shows otherwise in `scope`.
 */
function exactCopy(doc: Doc, scope: Scope, view: View): Doc | null {
  const storeOnly = withoutPending(doc, () => encodeStateAsUpdateV2(doc));
  const pendingStructs = doc.store.pendingStructs;
  const pendingDs = doc.store.pendingDs;
  const copy = new Doc({gc: doc.gc});
  copy.cleanupFormatting = false;
  try {
    Y.applyUpdateV2(copy, storeOnly);
    if (pendingDs !== null) {
      Y.applyUpdateV2(copy, pendingDs);
    }
    if (pendingStructs !== null) {
      Y.applyUpdateV2(copy, pendingStructs.update);
    }
    const copied = copy.store;
    const exact =
      (copied.pendingStructs === null) === (pendingStructs === null) &&
      (pendingStructs === null ||
        sameBytes(copied.pendingStructs!.update, pendingStructs.update)) &&
      sameBytes(
        copied.pendingDs ?? new Uint8Array(),
        pendingDs ?? new Uint8Array(),
      ) &&
      sameClocks(copied, doc.store) &&
      sameView(viewOf(copy, scope), view);
    if (exact) {
      return copy;
    }
  } catch {
    // Not exact.
  }
  copy.destroy();
  return null;
}

/** Whether two stores hold the same clients up to the same clocks. */
function sameClocks(a: Doc['store'], b: Doc['store']): boolean {
  if (a.clients.size !== b.clients.size) {
    return false;
  }
  for (const client of a.clients.keys()) {
    if (a.getClock(client) !== b.getClock(client)) {
      return false;
    }
  }
  return true;
}

/** `read` with the document's pending parts set aside (put back after). */
function withoutPending<T>(doc: Doc, read: () => T): T {
  const store = doc.store;
  const pendingStructs = store.pendingStructs;
  const pendingDs = store.pendingDs;
  store.pendingStructs = null;
  store.pendingDs = null;
  try {
    return read();
  } finally {
    store.pendingStructs = pendingStructs;
    store.pendingDs = pendingDs;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** A suffix the repair applies, and what the plan predicts it integrates. */
interface Cut {
  readonly client: number;
  /** The struct the suffix starts at (P's structs of `client` from it on). */
  readonly from: Struct;
  /** The structs it integrates, in clock order. */
  readonly run: readonly Struct[];
  /** The struct that ends the run (still blocked), null when none does. */
  readonly stop: Struct | null;
}

/** What the repair will apply (see planHolding). */
interface Plan {
  readonly cuts: readonly Cut[];
  /** Whether the budget ran out (the rest stays pending). */
  readonly exhausted: boolean;
  /** Cuts the format rule held back. */
  readonly heldBack: number;
}

/**
 * The most format-only cuts one plan tries holding back, and the most
 * struct visits those trials make in all (see planHolding), every pass's
 * and every run's counted, a trial stopped where the bound falls: past
 * either, the rest integrate. Each trial simulates the plan again, so the
 * trials cost about their number times P's structs times the passes:
 * measured before the bound, 256 trials took 64 ms with 768 pending
 * structs, 3.3 s with 80,768, and 2.7 s with 1,025 in one client's long
 * runs; the bound stops them after about 4,000,000 visits.
 */
const MAX_HOLD_TRIALS = 256;
export const MAX_TRIAL_VISITS = 4_000_000;

/** A simulated plan, which of P's structs it integrates, and its work. */
interface Simulation {
  readonly plan: Plan;
  readonly planned: Map<number, boolean[]>;
  /** Structs the simulation looked at (each pass's and each run's). */
  readonly visits: number;
  /** Whether it stopped at its visit limit (the plan is incomplete). */
  readonly aborted: boolean;
}

/**
 * The cuts the repair applies, in order, planned exactly before any is
 * applied, as @y/y 14.0.0-rc.29 integrates them (`integrateStructs` and its
 * `getMissing`): an item is missing while its origin, right origin, or its
 * parent when that is an item, is not in the document (an item or a GC
 * struct; a Skip placeholder does not count, the same client included). A
 * client's suffix applied alone, with nothing pending, integrates its
 * structs in clock order (an integrated one is left out) until the first
 * that is missing; the rest of that client is pending again.
 *
 * The plan simulates the repair's loop on the document's store plus what
 * the planned cuts integrate: passes over the clients, each client's
 * structs in clock order, a cut at each struct that is not integrated
 * while its dependencies are, until a pass finds none (see simulate).
 *
 * The format rule: a run that carries only format items (no content: no
 * text, embed or type) is held back while a format item with one of its
 * keys stays pending after the repair, unless holding it back would keep
 * content from integrating. Such a run, integrated alone, could open (or
 * close) a format whose other end stays blocked, and the format would run
 * on over text the encoding document showed otherwise; a plain load holds
 * both back. Starting from the maximal plan, each such run is tried held
 * back in turn (the plan simulated again), and kept held back only when the
 * content the plan integrates stays the same; the runs to try are found
 * again while the keys left pending grow. The content is compared by
 * struct, so a hold that frees budget for other content is not kept. A run
 * that carries content integrates even when a format of its own stays
 * unpaired, so the repair recovers all the text the maximal plan does.
 * Trials are bounded (MAX_HOLD_TRIALS, MAX_TRIAL_VISITS; pathological input
 * only); past the bound the rest integrate. A load whose plan holds a cut
 * back is then checked, with the other candidates (see choosePlan).
 */
function planHolding(
  y: GapRepairYjs,
  doc: Doc,
  runs: Runs,
  budget: number,
  base: Simulation,
  baseHold: ReadonlySet<Struct>,
): {sim: Simulation; hold: Set<Struct>} {
  // The content the base plan integrates, by struct (identity: a hold that
  // frees budget for other content does not keep the same).
  const content: [number, number][] = [];
  for (const [client, run] of runs) {
    const marks = base.planned.get(client)!;
    run.structs.forEach((struct, i) => {
      if (marks[i] && isContent(struct)) {
        content.push([client, i]);
      }
    });
  }
  const sameContent = (next: Simulation) =>
    contentOf(runs, next.planned) === content.length &&
    content.every(([client, i]) => next.planned.get(client)![i]);
  const hold = new Set<Struct>(baseHold);
  const tried = new Set<Struct>();
  let current = base;
  let trials = 0;
  let visits = 0;
  trying: for (;;) {
    const keys = pendingFormatKeys(y, doc, runs, current.planned);
    const candidates = current.plan.cuts.filter(
      cut =>
        !tried.has(cut.from) &&
        !cut.run.some(isContent) &&
        cut.run.some(struct => {
          const key = formatKey(struct);
          return key !== null && keys.has(key);
        }),
    );
    if (candidates.length === 0) {
      break;
    }
    for (const cut of candidates) {
      if (trials >= MAX_HOLD_TRIALS || visits >= MAX_TRIAL_VISITS) {
        break trying;
      }
      trials++;
      tried.add(cut.from);
      hold.add(cut.from);
      const next = simulate(
        y,
        doc,
        runs,
        budget,
        hold,
        MAX_TRIAL_VISITS - visits,
      );
      visits += next.visits;
      LOAD_PLAN_COUNTERS.trialVisits += next.visits;
      if (next.aborted) {
        hold.delete(cut.from);
        break trying;
      }
      if (sameContent(next)) {
        current = next;
      } else {
        hold.delete(cut.from);
      }
    }
  }
  return {hold, sim: current};
}

/**
 * For tests: the plan the repair would apply to `doc` (nothing applied),
 * each cut with whether its run carries content and its format keys, the
 * format keys it leaves pending, and how much of P's content it integrates;
 * `hold` holds back, besides, the cuts starting at those ids.
 */
export function planGapRepairForTests(
  doc: Doc,
  hold: readonly StructId[] = [],
): {
  cuts: {from: StructId; content: boolean; keys: string[]}[];
  pendingKeys: string[];
  content: number;
} | null {
  const pending = doc.store.pendingStructs;
  if (pending === null) {
    return null;
  }
  const runs = clientRuns(Y, pending.update);
  const maximal = simulate(Y, doc, runs, MAX_SUFFIX_APPLIES, new Set());
  const base = planHolding(
    Y,
    doc,
    runs,
    MAX_SUFFIX_APPLIES,
    maximal,
    new Set(),
  );
  let sim = base.sim;
  if (hold.length > 0) {
    const held = new Set(base.hold);
    for (const id of hold) {
      const run = runs.get(id.client);
      const i = run === undefined ? -1 : structAt(run.structs, id.clock);
      if (i !== -1) {
        held.add(run!.structs[i]);
      }
    }
    sim = simulate(Y, doc, runs, MAX_SUFFIX_APPLIES, held);
  }
  return {
    content: contentOf(runs, sim.planned),
    cuts: sim.plan.cuts.map(cut => ({
      content: cut.run.some(isContent),
      from: cut.from.id,
      keys: cut.run.map(formatKey).filter((k): k is string => k !== null),
    })),
    pendingKeys: [...pendingFormatKeys(Y, doc, runs, sim.planned)],
  };
}

/** Whether a struct is content: an item in a node's list that counts. */
function isContent(struct: Struct): boolean {
  const item = struct as {
    parentSub?: unknown;
    content?: {isCountable?: () => boolean};
  };
  return (
    item.parentSub == null &&
    item.content !== undefined &&
    typeof item.content.isCountable === 'function' &&
    item.content.isCountable()
  );
}

/** How many of P's content structs a plan integrates. */
function contentOf(
  runs: Map<number, {structs: Struct[]; end: number}>,
  planned: Map<number, boolean[]>,
): number {
  let n = 0;
  for (const [client, run] of runs) {
    const marks = planned.get(client)!;
    run.structs.forEach((struct, i) => {
      if (marks[i] && isContent(struct)) {
        n++;
      }
    });
  }
  return n;
}

/** The keys of the format items of P a plan leaves pending. */
function pendingFormatKeys(
  y: GapRepairYjs,
  doc: Doc,
  runs: Map<number, {structs: Struct[]; end: number}>,
  planned: Map<number, boolean[]>,
): Set<string> {
  const keys = new Set<string>();
  for (const [client, run] of runs) {
    const marks = planned.get(client)!;
    run.structs.forEach((struct, i) => {
      const key = formatKey(struct);
      if (key !== null && !marks[i] && !structIntegrated(y, doc, struct.id)) {
        keys.add(key);
      }
    });
  }
  return keys;
}

/**
 * One simulation of the repair's loop (see planHolding): a cut that starts at a
 * struct of `hold` is held back (its structs stay pending, and a later cut
 * may integrate the ones after it).
 */
function simulate(
  y: GapRepairYjs,
  doc: Doc,
  runs: Map<number, {structs: Struct[]; end: number}>,
  budget: number,
  hold: ReadonlySet<Struct>,
  /** The most visits before it stops, incomplete (see planHolding). */
  limit: number = Infinity,
): Simulation {
  const planned = new Map<number, boolean[]>();
  for (const [client, run] of runs) {
    planned.set(
      client,
      run.structs.map(() => false),
    );
  }
  // Whether the document holds `id` once the cuts so far are applied.
  const has = (id: StructId): boolean => {
    if (structIntegrated(y, doc, id)) {
      return true;
    }
    const run = runs.get(id.client);
    if (run === undefined) {
      return false;
    }
    const i = structAt(run.structs, id.clock);
    return i !== -1 && planned.get(id.client)![i];
  };
  const cuts: Cut[] = [];
  const held = new Set<Struct>();
  let exhausted = false;
  let progress = true;
  let visits = 0;
  let aborted = false;
  passes: while (progress) {
    progress = false;
    for (const [client, clientRun] of runs) {
      const marks = planned.get(client)!;
      const structs = clientRun.structs;
      for (let i = 0; i < structs.length; i++) {
        const from = structs[i];
        if (++visits > limit) {
          aborted = true;
          break passes;
        }
        if (
          held.has(from) ||
          marks[i] ||
          structIntegrated(y, doc, from.id) ||
          !dependenciesIn(has, from)
        ) {
          continue;
        }
        if (hold.has(from)) {
          held.add(from);
          continue;
        }
        if (cuts.length >= budget) {
          exhausted = true;
          break passes;
        }
        // The run: this client's structs from here, in clock order, until
        // the first that is missing (each one integrated counts for those
        // after it).
        const integrates: Struct[] = [];
        let stop: Struct | null = null;
        for (let j = i; j < structs.length; j++) {
          const struct = structs[j];
          if (++visits > limit) {
            aborted = true;
            break passes;
          }
          if (marks[j] || structIntegrated(y, doc, struct.id)) {
            continue;
          }
          if (!dependenciesIn(has, struct)) {
            stop = struct;
            break;
          }
          marks[j] = true;
          integrates.push(struct);
        }
        cuts.push({client, from, run: integrates, stop});
        progress = true;
      }
    }
  }
  return {
    aborted,
    plan: {cuts, exhausted, heldBack: held.size},
    planned,
    visits,
  };
}

/** The key of a format item, null for any other struct. */
function formatKey(struct: Struct): string | null {
  const content = (struct as {content?: unknown}).content;
  return content instanceof ContentFormat ? content.key : null;
}

/** The index of the struct of `structs` (sorted) covering `clock`, or -1. */
function structAt(structs: readonly Struct[], clock: number): number {
  let lo = 0;
  let hi = structs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const struct = structs[mid];
    if (clock < struct.id.clock) {
      hi = mid - 1;
    } else if (clock >= struct.id.clock + struct.length) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

/** Whether `has` holds the structs `struct` depends on (see planHolding). */
function dependenciesIn(
  has: (id: StructId) => boolean,
  struct: Struct,
): boolean {
  const item = struct as {
    origin?: StructId | null;
    rightOrigin?: StructId | null;
    parent?: unknown;
  };
  if (item.origin && !has(item.origin)) {
    return false;
  }
  if (item.rightOrigin && !has(item.rightOrigin)) {
    return false;
  }
  const parent = item.parent as {client?: unknown; clock?: unknown} | null;
  if (
    parent !== null &&
    typeof parent === 'object' &&
    typeof parent.client === 'number' &&
    typeof parent.clock === 'number' &&
    !has(parent as StructId)
  ) {
    return false;
  }
  return true;
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
  kept: PendingStructs | null,
  origin: unknown,
): void {
  let all = kept;
  const take = () => {
    const pending = doc.store.pendingStructs;
    if (pending !== null) {
      all = all === null ? pending : unionPending(y, all, pending);
      doc.store.pendingStructs = null;
    }
  };
  take();
  if (all === null) {
    return;
  }
  const union: PendingStructs = all;
  try {
    LOAD_COUNTERS.applies++;
    y.applyUpdateV2(doc, union.update, origin);
  } catch {
    take();
    doc.store.pendingStructs = all;
  }
}

/** Two pending sets as one: their updates merged, each client's least
 * missing clock. */
function unionPending(
  y: GapRepairYjs,
  a: PendingStructs,
  b: PendingStructs,
): PendingStructs {
  const missing = new Map<number, number>(a.missing);
  b.missing.forEach((clock, client) => {
    const known = missing.get(client);
    missing.set(client, known === undefined ? clock : Math.min(known, clock));
  });
  return {missing, update: y.mergeUpdatesV2([a.update, b.update])};
}

/** Each client's clock ranges in P, sorted and merged. */
function heldRanges(
  runs: Map<number, {structs: Struct[]; end: number}>,
): Map<number, [number, number][]> {
  const held = new Map<number, [number, number][]>();
  for (const [client, run] of runs) {
    const ranges: [number, number][] = [];
    for (const struct of run.structs) {
      const start = struct.id.clock;
      const end = start + struct.length;
      const last = ranges[ranges.length - 1];
      if (last !== undefined && start <= last[1]) {
        last[1] = Math.max(last[1], end);
      } else {
        ranges.push([start, end]);
      }
    }
    held.set(client, ranges);
  }
  return held;
}

/** Whether every struct of `update` (format V2) lies in P's ranges. */
function heldBy(
  y: GapRepairYjs,
  update: Uint8Array,
  held: Map<number, [number, number][]>,
): boolean {
  for (const struct of y.decodeUpdateV2(update).structs) {
    if (struct instanceof y.Skip) {
      continue;
    }
    const ranges = held.get(struct.id.client);
    if (ranges === undefined) {
      return false;
    }
    const start = struct.id.clock;
    const end = start + struct.length;
    let lo = 0;
    let hi = ranges.length - 1;
    let inside = false;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (start < ranges[mid][0]) {
        hi = mid - 1;
      } else if (start >= ranges[mid][1]) {
        lo = mid + 1;
      } else {
        inside = end <= ranges[mid][1];
        break;
      }
    }
    if (!inside) {
      return false;
    }
  }
  return true;
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
