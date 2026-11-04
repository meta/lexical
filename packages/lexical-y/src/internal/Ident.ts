/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/*
 * Paired format runs (layout IDENTITY_LAYOUT_VERSION).
 *
 * For covered keys (see covered) a write's run is an opener and an end tied
 * by id:
 * - an opener is a plain value, or `[]` for a run that shows no value (text
 *   made plain inside a run);
 * - an end is `[d]` (it names the item `d` clocks before itself, by the same
 *   client) or `[client, clock]`;
 * - a plain null keeps its meaning.
 *
 * Reader: per covered key a stack of open runs (kept in the formats map under
 * a shadow key, so copies and comparisons of formats maps carry it). A live
 * opener a live end names is paired: it pushes its run. Any other item
 * (plain value, plain null, an opener whose end is gone or has not arrived)
 * is unpaired: it replaces the unpaired runs at the top and pushes itself. A
 * live end removes the run it names and every unpaired run above it; one
 * whose run is not open does nothing. The top run's value is shown. A
 * document without ends (every document written before this layout) reads
 * exactly as with plain values: every item is unpaired, so the stack holds
 * the last item's run.
 */

import {
  ContentFormat,
  createID,
  type Doc,
  type ID,
  Item,
  iterateStructsByIdSet,
  Node as YNode,
  Skip,
  type Transaction,
} from '@y/y';

import {
  BASE_LAYOUT_VERSION,
  IDENTITY_LAYOUT_VERSION,
  LAYOUT_PREFIX,
  LAYOUT_VERSION,
} from './constants';
import {runBoundary, type StoredUnit} from './Layout3';
import {markBindingWrite} from './RawWrites';
import {isGone} from './Seen';

/**
 * Whether writes into `doc` store covered keys as paired runs: always, but
 * while the document is seeded (see withSeeding). Layout 3 only: every
 * document this binding writes records layout IDENTITY_LAYOUT_VERSION (a
 * document below it binds read only, see YBinding#evaluate).
 */
export function writesPairedRuns(
  doc: Doc,
  _root?: {getAttr: (k: string) => unknown},
): boolean {
  return !seedingDocs.has(doc);
}

/**
 * Seeding a pristine root (binding initialization, seedYState; D22, under
 * layout 3): content and uncovered formats as main writes them, covered
 * formats as canonical layout 3 runs, interleaved with the content in the
 * seed's own pass (see seedRunsOf, Cursor#insert): every client derives the
 * same seed bytes, and so the same seed client id, for the same content,
 * and a client that seeded it differently would write it a second time.
 * The seed bytes are pinned by golden tests: a change to them at layout 3
 * needs a seed-format bump. Scoped to `doc`: a write to another document
 * during the seed (an app listener that edits another room) writes as that
 * document says.
 */
const seedingDocs = new Map<Doc, number>();
export function withSeeding<T>(doc: Doc, fn: () => T): T {
  seedingDocs.set(doc, (seedingDocs.get(doc) ?? 0) + 1);
  try {
    return fn();
  } finally {
    const n = (seedingDocs.get(doc) ?? 1) - 1;
    if (n > 0) {
      seedingDocs.set(doc, n);
    } else {
      seedingDocs.delete(doc);
      seedRuns.delete(doc);
    }
  }
}

/**
 * A container's covered runs while it is seeded: the values of the last
 * unit written (see Layout3's storedUnit), the opener of each run still
 * open, and the last unit's item (where the runs open at the end close).
 */
export type SeedRuns = {
  unit: StoredUnit;
  openers: Map<string, Item>;
  last: Item | null;
};
const seedRuns = new Map<Doc, Map<YNode, SeedRuns>>();

/** The seed's runs in `container` (see SeedRuns), made on first use. */
export function seedRunsOf(container: YNode): SeedRuns {
  const doc = (container as unknown as {doc: Doc}).doc;
  let byContainer = seedRuns.get(doc);
  if (byContainer === undefined) {
    byContainer = new Map();
    seedRuns.set(doc, byContainer);
  }
  let runs = byContainer.get(container);
  if (runs === undefined) {
    runs = {last: null, openers: new Map(), unit: new Map()};
    byContainer.set(container, runs);
  }
  return runs;
}

/**
 * The seed's last step, in `tr`: close every run still open, right after
 * its container's last unit, ends in key order (Layout3's runBoundary), as
 * writeLayout3Formats places them.
 */
export function finishSeedRuns(tr: Transaction): void {
  const byContainer = seedRuns.get(tr.doc);
  seedRuns.delete(tr.doc);
  if (byContainer === undefined) {
    return;
  }
  const client = tr.doc.clientID;
  for (const [container, runs] of byContainer) {
    let left = runs.last;
    for (const key of runBoundary(runs.unit, new Map()).ends) {
      const opener = runs.openers.get(key)!;
      const right = (
        left === null ? container._start : left.right
      ) as Item | null;
      const clock = tr.doc.store.getClock(client);
      const end = new Item(
        createID(client, clock),
        left,
        left && left.lastId,
        right,
        right && right.id,
        container,
        null,
        new ContentFormat(key, [clock - opener.id.clock] as unknown as object),
      );
      end.integrate(tr, 0);
      left = end;
    }
  }
}

/**
 * Write the layout IDENTITY_LAYOUT_VERSION record on `root` (inside the
 * running transaction), even where it is present.
 */
export function writeIdentityRecord(root: YNode): void {
  root.setAttr(LAYOUT_PREFIX + IDENTITY_LAYOUT_VERSION, true);
}

/**
 * Before a client's first paired item in a transaction, in a document under
 * `root` that has no live layout IDENTITY_LAYOUT_VERSION record: write the
 * record first, in the same transaction, right before that item (its clock
 * precedes every paired item of the transaction, so no prefix delivers them
 * without it). A write that stores no paired item writes no record, so a
 * write that changes nothing stays empty and no follow-up on the
 * remote-apply path writes one. A client that sees the record writes none:
 * it writes after it causally (D92). The record is then written again in a
 * transaction no UndoManager tracks (see protectRecordAfter).
 */
export function ensureIdentityRecord(root: YNode): void {
  if (!recordsIdentityLayout(root)) {
    writeIdentityRecord(root);
    const doc = (root as unknown as {doc: Doc | null}).doc;
    const tr = doc === null ? null : doc._transaction;
    if (tr !== null) {
      protectRecordAfter(tr, root);
    }
  }
}

/**
 * The origin of the transaction in which a layout 3 record is written again
 * (see protectRecordAfter, YBinding#keepIdentityRecord): an instance of a
 * class nothing outside this package holds, so no UndoManager tracks it
 * (Yjs matches tracked origins by identity and by `origin.constructor`).
 */
export class IdentityLayoutOrigin {}

/** Per transaction, the roots whose layout 3 record it wrote and protects. */
const pendingRecords = new WeakMap<Transaction, Set<YNode>>();

/**
 * After transaction `tr` (which wrote `root`'s layout 3 record): write the
 * record again in a transaction of its own with an origin no UndoManager
 * tracks (IdentityLayoutOrigin), so an app UndoManager that later undoes
 * `tr` (also an app's outer transaction the write joined) deletes only the
 * overwritten item, and every update it emits keeps a live record. Scoped
 * to `tr`, by a listener of the document that removes itself when `tr`
 * ends, not by a binding: a binding disposed before `tr` ends still has its
 * record protected, and nothing is left for a later transaction to act on.
 */
export function protectRecordAfter(tr: Transaction, root: YNode): void {
  let roots = pendingRecords.get(tr);
  if (roots === undefined) {
    roots = new Set();
    pendingRecords.set(tr, roots);
    const doc = tr.doc;
    const after = (t: Transaction) => {
      if (t === tr) {
        doc.off('afterTransaction', after);
        recordAgain(t);
      }
    };
    doc.on('afterTransaction', after);
  }
  roots.add(root);
}

function recordAgain(tr: Transaction): void {
  const roots = pendingRecords.get(tr);
  if (roots === undefined) {
    return;
  }
  pendingRecords.delete(tr);
  const live = [...roots].filter(
    root => root._item === null || !root._item.deleted,
  );
  if (live.length > 0) {
    // The new transaction runs after this one's cleanup (Yjs queues it).
    tr.doc.transact((again: Transaction) => {
      // Development builds: the binding's own write (see
      // RawWrites.noteRawWrite).
      if (__DEV__) {
        markBindingWrite(again);
      }
      for (const root of live) {
        writeIdentityRecord(root);
      }
    }, new IdentityLayoutOrigin());
  }
}

/** Whether `root` records layout IDENTITY_LAYOUT_VERSION. */
export function recordsIdentityLayout(root: {
  getAttr: (k: string) => unknown;
}): boolean {
  return root.getAttr(LAYOUT_PREFIX + IDENTITY_LAYOUT_VERSION) === true;
}

const __DEV__ = process.env.NODE_ENV !== 'production';

/**
 * The view pairing is judged in (isPaired, liveEndsOf, isValidEnd, stack
 * entries): the running write's own view (Seen.isGone).
 */
const goneIn = isGone;

/**
 * The hold whose view a fold reads in (see withHeldView), or null: an end
 * it holds back pairs nothing there.
 */
let heldView: {hides(item: Item): boolean} | null = null;

/**
 * Run `fn` folding as the line being composed shows (see Hidden): an end
 * the hold holds back pairs no opener there, as it is not there for the
 * editor. What the line hands on is folded without (see Seen.isStored).
 */
export function withHeldView<T>(
  hidden: {hides(item: Item): boolean} | null,
  fn: () => T,
): T {
  const was = heldView;
  heldView = hidden;
  try {
    return fn();
  } finally {
    heldView = was;
  }
}

/** Whether end `end` pairs nothing: gone, or held back (see heldView). */
const endGone = (end: Item): boolean =>
  goneIn(end) || (heldView !== null && heldView.hides(end));

/** Test harnesses: check the whole run stack on every push (see Rule 4). */
let fullStackChecks = false;
export function setFullStackChecks(on: boolean): void {
  fullStackChecks = on;
}

/**
 * Roots bindings are bound to. A binding's root can be a nested Y.Node (the
 * `root` option): it holds the layout records, and its content reads and is
 * written by them, not by the top-level type above it.
 */
const boundRoots = new WeakSet<YNode>();
export function noteBoundRoot(root: YNode): void {
  if (!boundRoots.has(root)) {
    boundRoots.add(root);
    if (root._item !== null) {
      // Types under it may have been resolved to the type above it.
      rootOfType = new WeakMap();
    }
  }
}

/**
 * Whether `type` holds a layout record (`lexical-y:<n>`, any version: an app
 * undo can delete the layout 1 record and leave a later one).
 */
function holdsLayoutRecord(type: YNode): boolean {
  for (let v = BASE_LAYOUT_VERSION; v <= LAYOUT_VERSION; v++) {
    if (type.getAttr(LAYOUT_PREFIX + v) !== undefined) {
      return true;
    }
  }
  const attrs = type.getAttrs() as Record<string, unknown>;
  for (const key in attrs) {
    if (key.startsWith(LAYOUT_PREFIX)) {
      return true;
    }
  }
  return false;
}

/** The shared root each type is under (see pairedReadingIn). */
let rootOfType = new WeakMap<object, YNode>();
/**
 * The root `type` is under: the nearest type holding a layout record (every
 * bound root records layout 1 when it is initialized; stored, so a decoded
 * document knows its nested roots before any binding registers them), or a
 * bound root, else its top type.
 */
export function rootOf(type: YNode): YNode {
  let root = rootOfType.get(type);
  if (root === undefined) {
    root = type;
    while (
      root._item !== null &&
      !boundRoots.has(root) &&
      !holdsLayoutRecord(root)
    ) {
      root = root._item.parent as YNode;
    }
    rootOfType.set(type, root);
  }
  return root;
}

/**
 * Whether items in `type` read as paired runs: every Y.Node (layout 3 only).
 * A document written before layout 3 holds no ends, so it reads exactly as
 * with plain values (see the header); such a document binds read only.
 */
export function pairedReadingIn(type: unknown): boolean {
  return type instanceof YNode;
}

const SET_MEMBER_SEPARATOR = '\u001f';

/**
 * The keys whose runs are paired, by stored name (the frozen list, the same
 * for every reader): text formats (`f:`), wrappers (`w:`: links), fields
 * (`p:`: style, color), node type (`t`) and segment (`k`) keys, and every
 * `s:` name holding U+001F (set-valued NodeState member entries: comment
 * ids). Not covered: a NodeState value stored flat (`s:<key>` with no
 * U+001F), which apps may read and write raw, and any other name (a raw
 * writer's own keys); they keep the plain-value rules.
 */
function isCoveredName(key: string): boolean {
  if (key.length === 1) {
    return key === 't' || key === 'k';
  }
  if (key.charCodeAt(1) !== 58 /* : */) {
    return false;
  }
  switch (key.charCodeAt(0)) {
    case 102: // f
    case 112: // p
    case 119: // w
      return true;
    case 115: // s
      return key.indexOf(SET_MEMBER_SEPARATOR, 2) >= 0;
    default:
      return false;
  }
}
type KeyInfo = {
  readonly covered: boolean;
  readonly shadow: string;
  /** FNV-1a of the key (see Dormant). */
  readonly hash: number;
};
/**
 * Interned key infos, bounded: set member keys carry ids (one per comment),
 * so a long-lived process would otherwise keep one entry per id it ever
 * read. Cleared whole when full; entries are cheap to make again.
 */
const KEY_INFO_LIMIT = 4096;
const keyInfos = new Map<string, KeyInfo>();
/** Test-only: how many key infos are interned. */
export const keyInfoCount = (): number => keyInfos.size;
/** A key's coverage and shadow key, interned (one lookup per step). */
let lastKey = '';
let lastInfo: KeyInfo | null = null;
function keyInfo(key: string): KeyInfo {
  // Walks step runs of one key: the last key's info is reused.
  if (key === lastKey && lastInfo !== null) {
    return lastInfo;
  }
  let info = keyInfos.get(key);
  if (info === undefined) {
    info = {
      covered: isCoveredName(key),
      hash: fnv1a(key),
      shadow: SHADOW + key,
    };
    if (keyInfos.size >= KEY_INFO_LIMIT) {
      keyInfos.clear();
    }
    keyInfos.set(key, info);
  }
  lastKey = key;
  lastInfo = info;
  return info;
}
export const covered = isCoveredName;

const SHADOW = '\u0002';
export const isShadowKey = (k: string): boolean => k.charCodeAt(0) === 2;

/**
 * Whether a covered item's value is an end, valid or not: any array but
 * `[]`. Well formed only as `[d]` (a positive safe integer) or
 * `[client, clock]` (non-negative safe integers); see storedTarget. Every
 * other array is reserved (a raw writer's, or an end of a later layout this
 * release does not read): it names no run, so it reads as an end whose run
 * is not open (a clearer, see stepPaired), and no write of the binding
 * rewrites, re-points or deletes it (see repairCopies,
 * Cursor#formatCovered). Every value that is not an array is a value, an
 * object keyed by array indices and a typed array included. Layout 3
 * stores no raw array as a value (a whole-container write stores one as
 * `{json}`, see Layout3's storedValue).
 */
export const isEndValue = (v: unknown): v is unknown[] =>
  Array.isArray(v) && v.length > 0;

const isCount = (x: unknown, min: number): boolean =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= min;

export const isNullRunValue = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 0;

/** An identity item's value: an end or a null-run opener. */
export const isIdentityValue = (v: unknown): boolean => Array.isArray(v);

export const NULL_RUN: unknown[] = [];

/** The value of an end with id `endId` that closes the run `opener` opened. */
export function endValue(endId: ID, opener: ID): number[] {
  return opener.client === endId.client
    ? [endId.clock - opener.clock]
    : [opener.client, opener.clock];
}

/** The id the stored value of end `end` names, null when malformed. */
function storedTarget(end: Item): ID | null {
  const v = (end.content as ContentFormat).value as unknown as unknown[];
  if (v.length === 1 && isCount(v[0], 1)) {
    const clock = end.id.clock - (v[0] as number);
    return clock >= 0 ? createID(end.id.client, clock) : null;
  }
  if (v.length === 2 && isCount(v[0], 0) && isCount(v[1], 0)) {
    return createID(v[0] as number, v[1] as number);
  }
  return null;
}

/**
 * The id of the opener end item `end` names, null when its value is
 * malformed. An undo's copy of an end that the fix-up has not repaired yet
 * (a read inside the transaction that made it, see beforeObservers) names
 * what the repair will make it name.
 */
export function endTarget(end: Item): ID | null {
  const value = (end.content as ContentFormat).value as unknown as object;
  const first = holderOf(value);
  if (first !== undefined && first !== end) {
    const doc = (end.parent as unknown as {doc: Doc | null}).doc;
    if (doc !== null && doc !== undefined) {
      return repairedTarget(doc, first, end);
    }
  }
  return storedTarget(end);
}

/**
 * Whether no struct holds `id` yet, or a Skip does (a merged update's gap):
 * an end naming it waits for it. Not a GC'd struct, which never arrives.
 */
function notArrived(doc: Doc, id: ID): boolean {
  if (id.clock < 0) {
    return false;
  }
  if (id.clock >= doc.store.getClock(id.client)) {
    return true;
  }
  return doc.store.getItem(id) instanceof Skip;
}

/** The struct with id `id`, or null where its client never wrote that clock. */
function itemAt(doc: Doc, id: ID): Item | null {
  if (id.clock < 0 || id.clock >= doc.store.getClock(id.client)) {
    return null;
  }
  const s: unknown = doc.store.getItem(id);
  return s instanceof Item ? s : null;
}

type Index = {
  /** The ends naming each opener, by opener item. */
  ends: Map<Item, Item[]>;
  /**
   * Ends whose target is not (yet) a struct of the document, or is a Skip,
   * by the target's `client:clock`: noted again when it arrives (see
   * repairCopies).
   */
  waiting: Map<string, Item[]>;
  /** Per client, the clock up to which its structs were scanned. */
  scanned: Map<number, number>;
};
const indexes = new WeakMap<Doc, Index>();

const FOLLOWS = Symbol('follows');
const NOT_AFTER = Symbol('notAfter');
/**
 * Whether end `end` comes after opener `target` in their container: an end
 * names an opener before it (a raw writer can store one before its target,
 * which then is a clearer, and the opener stays unpaired). Kept on the end:
 * items never change order.
 */
function endFollows(
  target: Item,
  end: Item,
  positions: Map<unknown, Map<Item, number>> | null = null,
): boolean {
  const known = (end as Item & {[FOLLOWS]?: Item})[FOLLOWS];
  if (known === target) {
    return true;
  }
  if (positions !== null) {
    // A batch (an index scan): each container's item order once,
    // not a walk per end (quadratic on a line with many items between an
    // opener and its end).
    let pos = positions.get(end.parent);
    if (pos === undefined) {
      pos = new Map();
      let n = 0;
      for (
        let it = (end.parent as unknown as {_start: Item | null})._start;
        it !== null;
        it = it.right
      ) {
        pos.set(it, n++);
      }
      positions.set(end.parent, pos);
    }
    const a = pos.get(target);
    const b = pos.get(end);
    if (a !== undefined && b !== undefined) {
      if (a < b) {
        (end as Item & {[FOLLOWS]?: Item})[FOLLOWS] = target;
        return true;
      }
      (end as Item & {[NOT_AFTER]?: Item})[NOT_AFTER] = target;
      return false;
    }
  }
  // An end before its target stays before it: kept too, so an invalid raw
  // end does not make every validity check walk its line.
  if ((end as Item & {[NOT_AFTER]?: Item})[NOT_AFTER] === target) {
    return false;
  }
  for (let it = end.left; it !== null; it = it.left) {
    if (it === target) {
      (end as Item & {[FOLLOWS]?: Item})[FOLLOWS] = target;
      return true;
    }
  }
  (end as Item & {[NOT_AFTER]?: Item})[NOT_AFTER] = target;
  return false;
}

/** Record a live end in its document's index (writers call this). */
export function noteEnd(
  doc: Doc,
  end: Item,
  follows: 'written' | Map<unknown, Map<Item, number>> | null = null,
): void {
  const index = indexes.get(doc);
  if (index === undefined) {
    return;
  }
  // Valid only when it names a format item of its key in its container
  // that is not an end (a raw Yjs writer may copy `[d]` elsewhere).
  const id = endTarget(end);
  if (id !== null && follows !== 'written') {
    // Most ends sit a few items after their opener (a token's opener, its
    // text, its end): found walking left, it is the target and the end
    // follows it, with no lookup in the store and no order check.
    const near = nearOpener(end, id);
    if (near !== null) {
      if (
        near.content instanceof ContentFormat &&
        near.content.key === (end.content as ContentFormat).key &&
        !isEndValue(near.content.value)
      ) {
        (end as Item & {[FOLLOWS]?: Item})[FOLLOWS] = near;
        indexEnd(index, near, end);
      }
      return;
    }
  }
  const target = id === null ? null : itemAt(doc, id);
  if (id !== null && target === null && notArrived(doc, id)) {
    // Its opener has not arrived: noted again when it does.
    const k = id.client + ':' + id.clock;
    const list = index.waiting.get(k);
    if (list === undefined) {
      index.waiting.set(k, [end]);
    } else if (!list.includes(end)) {
      list.push(end);
    }
    return;
  }
  if (
    target === null ||
    target.parent !== end.parent ||
    !(target.content instanceof ContentFormat) ||
    target.content.key !== (end.content as ContentFormat).key ||
    isEndValue(target.content.value) ||
    // An end this client's writer just wrote follows its opener: it wrote
    // it after it.
    (follows !== 'written' &&
      !endFollows(target, end, follows === null ? null : follows))
  ) {
    return;
  }
  if (follows === 'written') {
    (end as Item & {[FOLLOWS]?: Item})[FOLLOWS] = target;
  }
  indexEnd(index, target, end);
}

function indexEnd(index: Index, target: Item, end: Item): void {
  const list = index.ends.get(target);
  endEpoch++;
  if (list === undefined) {
    index.ends.set(target, [end]);
  } else if (!list.includes(end)) {
    list.push(end);
  }
}

/** How far noteEnd looks left of an end for its opener. */
const NEAR = 16;

/** The item with id `id` among the NEAR items left of `end`, or null. */
function nearOpener(end: Item, id: ID): Item | null {
  let it = end.left;
  for (let n = 0; it !== null && n < NEAR; n++, it = it.left) {
    if (
      it.id.client === id.client &&
      id.clock >= it.id.clock &&
      id.clock < it.id.clock + it.length
    ) {
      return it;
    }
  }
  return null;
}

function isCoveredEnd(s: unknown): s is Item {
  return (
    s instanceof Item &&
    s.content instanceof ContentFormat &&
    covered(s.content.key) &&
    isEndValue(s.content.value)
  );
}

/**
 * Note the ends among the structs of `doc` that `index` has not scanned
 * (every new end is a new struct, at a clock above what was scanned).
 */
function scanNew(doc: Doc, index: Index): void {
  const positions = new Map<unknown, Map<Item, number>>();
  doc.store.clients.forEach((structs, client) => {
    const last = structs[structs.length - 1];
    const next = last.id.clock + last.length;
    const from = index.scanned.get(client) ?? 0;
    if (next <= from) {
      return;
    }
    index.scanned.set(client, next);
    // The first struct at or after `from` (structs are in clock order).
    let lo = 0;
    let hi = structs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = structs[mid];
      if (m.id.clock + m.length <= from) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    for (let i = lo; i < structs.length; i++) {
      const s = structs[i];
      if (isCoveredEnd(s)) {
        noteHolder(s);
        // Deleted ends too: a write's view keeps an end an unread change
        // deleted (see Seen.isGone), and its run is paired there (#9719).
        noteEnd(doc, s, positions);
      }
    }
  });
}

function buildIndex(doc: Doc): Index {
  endEpoch++;
  const index: Index = {
    ends: new Map(),
    scanned: new Map(),
    waiting: new Map(),
  };
  indexes.set(doc, index);
  scanNew(doc, index);
  return index;
}

function indexOf(doc: Doc): Index {
  const index = indexes.get(doc);
  if (index === undefined) {
    return buildIndex(doc);
  }
  // Not followed (no binding installed the fix-up): the structs it did not
  // see are scanned now.
  if (!followed(doc)) {
    scanNew(doc, index);
  }
  return index;
}

/**
 * Openers a writer wrote whose end it is about to write in the same
 * transaction: paired already.
 */
const pendingPaired = new WeakSet<Item>();
let pendingCount = 0;
export const markPending = (item: Item): void => {
  if (!pendingPaired.has(item)) {
    pendingPaired.add(item);
    pendingCount++;
  }
};
export const unmarkPending = (item: Item): void => {
  if (pendingPaired.delete(item)) {
    pendingCount--;
  }
};

/**
 * Whether any item of `doc` can be paired: a live or deleted end was seen,
 * or a writer holds an opener whose end it is writing. False for every
 * document written before paired runs, where readers then skip the lookups.
 */
function mayPair(doc: Doc): boolean {
  return pendingCount > 0 || indexOf(doc).ends.size > 0;
}

/**
 * Whether end `end` is valid: it names a live format item of its key, in its
 * container, that is not an end (structural validity: it does not prove the
 * end was written for that opener; raw writers must not copy relative ends).
 */
export function isValidEnd(end: Item): boolean {
  const doc = (end.parent as unknown as {doc: Doc | null}).doc;
  const id = endTarget(end);
  if (doc === null || doc === undefined || id === null) {
    return false;
  }
  const target = itemAt(doc, id);
  return (
    target !== null &&
    !goneIn(target) &&
    target.parent === end.parent &&
    target.content instanceof ContentFormat &&
    target.content.key === (end.content as ContentFormat).key &&
    !isEndValue(target.content.value) &&
    endFollows(target, end)
  );
}

/** Every end (live or deleted) the index holds that names opener `item`. */
export function endsOf(item: Item): Item[] {
  const doc = (item.parent as unknown as {doc: Doc | null}).doc;
  if (doc === null || doc === undefined) {
    return [];
  }
  return [...(indexOf(doc).ends.get(item) ?? [])];
}

/** The live ends that name opener `item`. */
export function liveEndsOf(item: Item): Item[] {
  const doc = (item.parent as unknown as {doc: Doc | null}).doc;
  if (doc === null || doc === undefined) {
    return [];
  }
  const list = indexOf(doc).ends.get(item);
  return list === undefined ? [] : list.filter(e => !goneIn(e));
}

/** Whether a live end names live opener `item`. */
export function isPaired(item: Item): boolean {
  if (pendingCount > 0 && pendingPaired.has(item)) {
    return true;
  }
  return liveEndOf(item) !== null;
}

/** The first live end in the index that names opener `item`, or null. */
function liveEndOf(item: Item): Item | null {
  const doc = (item.parent as unknown as {doc: Doc | null}).doc;
  if (doc === null || doc === undefined) {
    return null;
  }
  // The live end found last for this opener, while it stays live (never
  // under a gone view: what is gone there differs), and openers no end in
  // the index names (a seeded item in main's bytes), per end epoch.
  const cached = (item as Cached)[LIVE_END];
  if (cached !== undefined && !endGone(cached)) {
    return cached;
  }
  const index = indexOf(doc);
  if ((item as Cached)[NO_END] === endEpoch) {
    return null;
  }
  const list = index.ends.get(item);
  if (list === undefined) {
    (item as Cached)[NO_END] = endEpoch;
    return null;
  }
  for (const end of list) {
    if (!endGone(end)) {
      (item as Cached)[LIVE_END] = end;
      return end;
    }
  }
  return null;
}
const LIVE_END = Symbol('liveEnd');
/** Bumped whenever an end enters any index or an index is built. */
let endEpoch = 0;
const NO_END = Symbol('noEnd');
/** An opener with what liveEndOf found for it (symbol properties). */
type Cached = Item & {[LIVE_END]?: Item; [NO_END]?: number};

export const stats = {
  copiesFixed: 0,
  endNoops: 0,
  entries: 0,
  unpairedPushes: 0,
};

/**
 * The item that first held each end value array. `ContentFormat#copy` (an
 * undo or redo restoring an item) shares the value object, and values
 * decoded from updates are fresh arrays: an end that holds an array another
 * item holds is a local copy of one in that item's redo chain.
 */
const HOLDER = Symbol('holder');
type Held = {[HOLDER]?: Item};
/**
 * Holders kept off the array: an array a client froze (or sealed), and every
 * array of a document below layout 3, whose values are left untouched (a raw
 * writer's own arrays, as main keeps them).
 */
const heldBy = new WeakMap<object, Item>();
/** The item that first held value array `v` (see noteHolder), if noted. */
const holderOf = (v: object): Item | undefined =>
  (v as Held)[HOLDER] ?? heldBy.get(v);
export const noteHolder = (item: Item): void => {
  const v = (item.content as ContentFormat).value as unknown;
  if (!Array.isArray(v) || holderOf(v) !== undefined) {
    return;
  }
  // A non-enumerable symbol property on the array itself (a WeakMap entry
  // per end cost a hash insertion per incoming end): Yjs encodes values as
  // JSON, which never sees it, and equality checks skip it.
  // On the array only in a document that records layout 3: an array a raw
  // writer stored elsewhere stays as stored.
  if (
    Object.isExtensible(v) &&
    item.parent instanceof YNode &&
    recordsIdentityLayout(rootOf(item.parent))
  ) {
    Object.defineProperty(v, HOLDER, {value: item});
  } else {
    heldBy.set(v, item);
  }
};

/** The item whose redo copy `copy` is, found along the chain from `first`. */
function originalOf(doc: Doc, first: Item, copy: Item): Item | null {
  let it: Item | null = first;
  for (let steps = 0; it !== null && steps < 1024; steps++) {
    const r: ID | null = it.redone;
    if (r === null) {
      return null;
    }
    if (r.client === copy.id.client && r.clock === copy.id.clock) {
      return it;
    }
    it = itemAt(doc, r);
  }
  return null;
}

/**
 * What a copy of an end (an undo or redo restored it; it shares its value
 * array with `first`, the item that first held it) names once repaired: the
 * latest copy of its original's opener (or that opener, live), where the
 * original's `redone` chain reaches this very copy; otherwise (a raw copy)
 * the absolute id `first` names, so it pairs only with that opener.
 */
function repairedTarget(doc: Doc, first: Item, copy: Item): ID | null {
  const original = originalOf(doc, first, copy);
  if (original === null) {
    return storedTarget(first);
  }
  const id = storedTarget(original);
  let target = id === null ? null : itemAt(doc, id);
  while (target !== null && target.redone !== null) {
    target = itemAt(doc, target.redone);
  }
  return target === null ? id : target.id;
}

/** Whether changed attribute names `keys` hold a layout record's. */
function hasLayoutKey(keys: Set<string | null>): boolean {
  for (const key of keys) {
    if (key !== null && key.startsWith(LAYOUT_PREFIX)) {
      return true;
    }
  }
  return false;
}

function beforeObservers(tr: Transaction): void {
  for (const [type, keys] of tr.changed) {
    // A nested type whose layout records change may start or stop being a
    // root of its own (see rootOf): types under it may have been resolved
    // to another type.
    if (type._item !== null && hasLayoutKey(keys)) {
      rootOfType = new WeakMap();
    }
  }
  repairCopies(tr);
}

/**
 * Before a write inside a transaction that may have inserted copies of ends
 * (an undo or redo inside an app's outer transaction): repair them now, so
 * that pairing queries, cursor seeds and opener steps see them repaired
 * (an opener whose end copy is not repaired yet reads as unpaired, and a
 * fold that replaced unpaired runs with it cannot recover them later).
 * Idempotent: beforeObserverCalls runs it again.
 */
export function repairPendingCopies(doc: Doc): void {
  const tr = doc._transaction;
  if (tr !== null) {
    repairCopies(tr);
  }
}

/** Documents where an opener arrived after an end naming it. */
const pairingChanged = new WeakSet<Doc>();

/**
 * Whether an opener arrived after an end naming it since the last call (the
 * end now pairs with it, which changes how everything between them reads);
 * clears it.
 */
export function takePairingChanges(doc: Doc): boolean {
  return pairingChanged.delete(doc);
}

/**
 * Before observers, the UndoManager's capture, gc and the update's
 * encoding: in roots that record layout 3, each copy of an end the transaction
 * inserted (see repairedTarget) gets new content naming its repaired target
 * (never the shared array: a new ContentFormat); then the transaction's ends
 * go into the index.
 */
function repairCopies(tr: Transaction): void {
  const doc = tr.doc;
  const index = indexes.get(doc);
  iterateStructsByIdSet(tr, tr.insertSet, s => {
    if (
      index !== undefined &&
      index.waiting.size > 0 &&
      s instanceof Item &&
      s.content instanceof ContentFormat &&
      covered(s.content.key)
    ) {
      const k = s.id.client + ':' + s.id.clock;
      const waiting = index.waiting.get(k);
      if (waiting !== undefined) {
        index.waiting.delete(k);
        for (const end of waiting) {
          // Not an end collected since it was noted (gc replaces a deleted
          // item's content): nothing names the opener through it.
          if (isCoveredEnd(end)) {
            noteEnd(doc, end);
          }
        }
        pairingChanged.add(doc);
      }
    }
    if (!isCoveredEnd(s)) {
      return;
    }
    const value = (s.content as ContentFormat).value as unknown as object;
    const first = holderOf(value);
    if (first === undefined || first === s) {
      noteHolder(s);
    } else if (
      s.parent instanceof YNode &&
      recordsIdentityLayout(rootOf(s.parent))
    ) {
      // A copy of an end (an undo's), in a root that records layout 3 (a
      // root below it is left as stored, as main keeps it; nested roots by
      // their own record).
      const target = repairedTarget(doc, first, s);
      if (target !== null) {
        const {key} = s.content as ContentFormat;
        s.content = new ContentFormat(
          key,
          endValue(s.id, target) as unknown as object,
        );
        noteHolder(s);
        stats.copiesFixed++;
      }
    }
    if (index !== undefined && !s.deleted) {
      noteEnd(doc, s);
    }
  });
}

/**
 * Documents made by createYDoc: their copy fix-up (see beforeObservers) is
 * installed before anything is applied to them (before any observer an app
 * adds) and kept for their lifetime, as an app UndoManager can redo into a
 * document no binding uses any more, and the update it sends must hold
 * repaired ends.
 */
const repairedForLife = new WeakSet<Doc>();
export function installCopyRepair(doc: Doc): void {
  if (!repairedForLife.has(doc)) {
    repairedForLife.add(doc);
    doc.on('beforeObserverCalls', beforeObservers);
  }
}

const installs = new WeakMap<Doc, number>();
/**
 * Install the copy fix-up and the index of ends (see beforeObservers) on a
 * document while a binding uses it: returns the uninstall, and the last one
 * removes the listener and drops the index (rebuilt from the document when
 * next needed), so a document no binding uses holds nothing of this.
 */
export function installIdentity(doc: Doc): () => void {
  const n = installs.get(doc) ?? 0;
  installs.set(doc, n + 1);
  if (n === 0) {
    if (!repairedForLife.has(doc)) {
      doc.on('beforeObserverCalls', beforeObservers);
    }
    // From here the listener notes new ends; first those it did not see.
    const index = indexes.get(doc);
    if (index !== undefined) {
      scanNew(doc, index);
    }
  }
  let done = false;
  return () => {
    if (done) {
      return;
    }
    done = true;
    const m = (installs.get(doc) ?? 1) - 1;
    if (m > 0) {
      installs.set(doc, m);
      return;
    }
    installs.delete(doc);
    if (!repairedForLife.has(doc)) {
      doc.off('beforeObserverCalls', beforeObservers);
    }
    indexes.delete(doc);
  };
}

/** The size of each document's index after its last pruning. */
const prunedSize = new WeakMap<Doc, number>();

/**
 * Drop from the index of `doc` what no reader can need any more: deleted
 * ends, and the entries of deleted openers or of openers left with no end.
 * The binding calls this after a transaction it has read, with no unread
 * change and no hold (an unread or held view can treat a deleted end as
 * live, #9719), and only while it is the document's one binding. Items the
 * transaction itself deleted stay (the D88 keep of that transaction reads
 * them, see YBinding's keepFormats). Amortized: it runs once the index has
 * doubled since the last pruning.
 */
export function pruneEnds(doc: Doc, tr: Transaction): void {
  const index = indexes.get(doc);
  if (index === undefined || installs.get(doc) !== 1) {
    return;
  }
  const size = index.ends.size;
  if (size < 256 || size < 2 * (prunedSize.get(doc) ?? 0)) {
    return;
  }
  const now = (x: Item) => tr.deleteSet.hasId(x.id);
  for (const [opener, list] of index.ends) {
    if (now(opener) || list.some(now)) {
      continue;
    }
    const live = opener.deleted ? [] : list.filter(e => !e.deleted);
    if (live.length === 0) {
      index.ends.delete(opener);
    } else if (live.length !== list.length) {
      index.ends.set(opener, live);
    }
  }
  prunedSize.set(doc, index.ends.size);
}

/** Test-only: the number of openers the index of `doc` holds ends for. */
export function indexedOpeners(doc: Doc): number {
  const index = indexes.get(doc);
  return index === undefined ? 0 : index.ends.size;
}

/**
 * Whether the index of `doc` follows its transactions (a binding installed
 * the fix-up): otherwise readers build it again from the document each
 * time they need it.
 */
const followed = (doc: Doc): boolean => installs.has(doc);

/**
 * A key's open runs, top first: a persistent linked stack (shared by the
 * format maps a reader snapshots, never mutated), so a push or a pop is O(1)
 * however deeply runs nest at one place.
 */
class Entry {
  /**
   * The opener (null for a run folded before paired reading): a private
   * field, so formats maps stay plain values for the code that compares and
   * prints them by value (an Item would pull its whole document into those
   * walks).
   */
  readonly #opener: Item | null;
  /**
   * A live end that named the opener when last asked (see entryPaired): an
   * end in the index always names its opener, so while it stays live the run
   * is paired, whatever else changed.
   */
  #end: Item | null = null;
  constructor(
    readonly below: Entry | null,
    readonly client: number,
    readonly clock: number,
    readonly value: unknown,
    opener: Item | null,
  ) {
    stats.entries++;
    this.#opener = opener;
  }
  get opener(): Item | null {
    return this.#opener;
  }
  get end(): Item | null {
    return this.#end;
  }
  set end(end: Item | null) {
    this.#end = end;
  }
}

function fnv1a(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Stacks that are one run of no value (a null, or `[]`, on nothing): a
 * document of plain values holds one per key it ever closed, and every unit
 * start copies its formats map. They live in one persistent map
 * (a hash trie, path-copied on change) under DORMANT_KEY, so a copy of a
 * formats map copies one reference for all of them. Representation only:
 * the entries are the same objects, read wherever a key's stack is (see
 * topOf, setStack, keySlice, isOnStack, equalStacks).
 */
const DORMANT_KEY = '\u0002\u0000';
type DLeaf = {
  readonly hash: number;
  readonly items: readonly (readonly [string, Entry])[];
};
class Dormant {
  constructor(
    readonly bitmap: number,
    readonly children: readonly (Dormant | DLeaf)[],
  ) {}
}
const popcount = (n: number): number => {
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
function dormantGet(
  node: Dormant,
  key: string,
  hash: number,
): Entry | undefined {
  for (let shift = 0; ; shift += 5) {
    const bit = 1 << ((hash >>> shift) & 31);
    if ((node.bitmap & bit) === 0) {
      return undefined;
    }
    const child = node.children[popcount(node.bitmap & (bit - 1))];
    if (child instanceof Dormant) {
      node = child;
      continue;
    }
    if (child.hash !== hash) {
      return undefined;
    }
    for (const [k, e] of child.items) {
      if (k === key) {
        return e;
      }
    }
    return undefined;
  }
}
/** `node` with `key` set to `value` (null: removed); null when empty. */
function dormantSet(
  node: Dormant | null,
  key: string,
  hash: number,
  value: Entry | null,
  shift = 0,
): Dormant | null {
  const bitmap = node === null ? 0 : node.bitmap;
  const children = node === null ? [] : node.children;
  const bit = 1 << ((hash >>> shift) & 31);
  const pos = popcount(bitmap & (bit - 1));
  if ((bitmap & bit) === 0) {
    if (value === null) {
      return node;
    }
    const next = children.slice();
    next.splice(pos, 0, {hash, items: [[key, value]]});
    return new Dormant(bitmap | bit, next);
  }
  const child = children[pos];
  let replaced: Dormant | DLeaf | null;
  if (child instanceof Dormant) {
    replaced = dormantSet(child, key, hash, value, shift + 5);
  } else if (child.hash === hash) {
    const items = child.items.filter(([k]) => k !== key);
    if (value !== null) {
      items.push([key, value]);
    }
    replaced = items.length === 0 ? null : {hash, items};
  } else if (value === null) {
    return node;
  } else {
    // Two hashes in one slot: a level below holds both.
    let sub: Dormant | null = null;
    for (const [k, e] of child.items) {
      sub = dormantSet(sub, k, child.hash, e, shift + 5);
    }
    replaced = dormantSet(sub, key, hash, value, shift + 5);
  }
  if (replaced === child) {
    return node;
  }
  const next = children.slice();
  if (replaced === null) {
    next.splice(pos, 1);
    const left = bitmap & ~bit;
    return left === 0 ? null : new Dormant(left, next);
  }
  next[pos] = replaced;
  return new Dormant(bitmap, next);
}
function dormantEntries(node: Dormant, out: Map<string, Entry>): void {
  for (const child of node.children) {
    if (child instanceof Dormant) {
      dormantEntries(child, out);
    } else {
      for (const [k, e] of child.items) {
        out.set(k, e);
      }
    }
  }
}
function equalDormant(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (!(a instanceof Dormant) || !(b instanceof Dormant)) {
    return false;
  }
  const x = new Map<string, Entry>();
  const y = new Map<string, Entry>();
  dormantEntries(a, x);
  dormantEntries(b, y);
  if (x.size !== y.size) {
    return false;
  }
  for (const [k, e] of x) {
    const f = y.get(k);
    if (f === undefined || !equalStacks(e, f)) {
      return false;
    }
  }
  return true;
}

/** The top of `key`'s stack in `formats`, wherever it is kept. */
function topOf(
  formats: Map<string, unknown>,
  info: KeyInfo,
  key: string,
): Entry | undefined {
  const top = formats.get(info.shadow) as Entry | undefined;
  if (top !== undefined) {
    return top;
  }
  const dormant = formats.get(DORMANT_KEY) as Dormant | undefined;
  return dormant === undefined
    ? undefined
    : dormantGet(dormant, key, info.hash);
}

function setStack(
  formats: Map<string, unknown>,
  key: string,
  shadow: string,
  top: Entry | null,
): void {
  const dormant = formats.get(DORMANT_KEY) as Dormant | undefined;
  const hash =
    dormant !== undefined ||
    (top !== null && top.below === null && top.value === null)
      ? keyInfo(key).hash
      : 0;
  if (top !== null && top.below === null && top.value === null) {
    formats.delete(shadow);
    formats.delete(key);
    const next = dormantSet(dormant ?? null, key, hash, top);
    if (next !== null) {
      formats.set(DORMANT_KEY, next);
    }
    return;
  }
  if (dormant !== undefined) {
    const next = dormantSet(dormant, key, hash, null);
    if (next !== dormant) {
      if (next === null) {
        formats.delete(DORMANT_KEY);
      } else {
        formats.set(DORMANT_KEY, next);
      }
    }
  }
  if (top === null) {
    formats.delete(shadow);
    formats.delete(key);
    return;
  }
  formats.set(shadow, top);
  if (top.value === null) {
    formats.delete(key);
  } else {
    formats.set(key, top.value);
  }
}

/**
 * Whether two stack tops (the shadow values of one key in two formats maps)
 * hold the same runs: the same entry objects, or entries naming the same
 * openers down both chains (runs folded without a stack, which name none,
 * by value). Never walks values as JSON.
 */
export function equalStacks(a: unknown, b: unknown): boolean {
  if (a instanceof Dormant || b instanceof Dormant) {
    return equalDormant(a, b);
  }
  let x = a instanceof Entry ? a : null;
  let y = b instanceof Entry ? b : null;
  if (x === null || y === null) {
    return a === b;
  }
  while (x !== null && y !== null) {
    if (x === y) {
      return true;
    }
    if (x.client !== y.client || x.clock !== y.clock) {
      return false;
    }
    if (x.client < 0 && x.value !== y.value) {
      return (
        JSON.stringify(x.value) === JSON.stringify(y.value) &&
        equalStacks(x.below, y.below)
      );
    }
    x = x.below;
    y = y.below;
  }
  return x === y;
}

/** Whether the opener of stack entry `e` is paired (looked up on demand). */
function entryPaired(doc: Doc, e: Entry): boolean {
  const item = e.opener;
  if (item === null || goneIn(item)) {
    return false;
  }
  const known = e.end;
  if (known !== null && !endGone(known)) {
    return true;
  }
  if (!mayPair(doc)) {
    return false;
  }
  if (pendingCount > 0 && pendingPaired.has(item)) {
    return true;
  }
  const end = liveEndOf(item);
  e.end = end;
  return end !== null;
}

function entry(below: Entry | null, opener: Item, value: unknown): Entry {
  return new Entry(below, opener.id.client, opener.id.clock, value, opener);
}

/**
 * A run the formats map gives `key` without a stack (folded before the
 * document read paired runs, see pairedReadingIn): there every item was
 * unpaired, so its stack was the one run of the last item, whose id no end
 * can name.
 */
function plainRun(formats: Map<string, unknown>, key: string): Entry | null {
  const value = formats.get(key);
  return value === undefined ? null : new Entry(null, -1, -1, value, null);
}

/**
 * Step `formats` over format item `it` (see the header): every fold site
 * calls this. Uncovered keys fold as plain values.
 */
export function stepFormat(formats: Map<string, unknown>, it: Item): void {
  stepPaired(formats, it);
}

/**
 * The fold: run stacks for covered keys, plain values for every other key.
 */
export function stepPaired(formats: Map<string, unknown>, it: Item): void {
  const content = it.content as ContentFormat;
  const key = content.key;
  // The fold's own slots (a key's run stack, the dormant runs) live under
  // names starting with U+0002 (see isShadowKey). A stored key in that
  // namespace (a raw writer's) would overwrite them, and no reader shows
  // one (they read formats without shadow keys), so the fold leaves it out:
  // no stored key can name an internal slot.
  if (key.charCodeAt(0) === 2) {
    return;
  }
  const value = content.value as unknown;
  const info = keyInfo(key);
  if (!info.covered) {
    if (value === null) {
      formats.delete(key);
    } else {
      formats.set(key, value);
    }
    return;
  }
  const shadow = info.shadow;
  const top = topOf(formats, info, key) ?? plainRun(formats, key);
  const doc = (it.parent as unknown as {doc: Doc}).doc;
  if (isEndValue(value)) {
    // Rule 2: any end, valid or not, removes the unpaired runs above the
    // topmost paired run (as a null does to a plain value); one that names
    // a run on the stack removes that run too, with the unpaired runs above
    // it, and the paired runs above it stay.
    if (top === null) {
      stats.endNoops++;
      return;
    }
    const target = endTarget(it);
    if (
      target !== null &&
      top.clock === target.clock &&
      top.client === target.client
    ) {
      setStack(formats, key, shadow, top.below);
      return;
    }
    let firstPaired: Entry | null = top;
    while (firstPaired !== null && !entryPaired(doc, firstPaired)) {
      firstPaired = firstPaired.below;
    }
    let own: Entry | null = target === null ? null : firstPaired;
    while (
      own !== null &&
      (own.clock !== target!.clock || own.client !== target!.client)
    ) {
      own = own.below;
    }
    if (own === null) {
      if (firstPaired !== top) {
        setStack(formats, key, shadow, firstPaired);
      } else {
        stats.endNoops++;
      }
      return;
    }
    setStack(
      formats,
      key,
      shadow,
      rebuildOnto(firstPaired!, own, own.below, doc),
    );
    return;
  }
  const shown = value === null || Array.isArray(value) ? null : value;
  // Rule 4: an opener is never on the stack twice. Every fold starts after
  // what its seed holds (see Seen.frontierOf), so a reader's or writer's
  // walk meets each item once. Development builds check the top entry; test
  // harnesses check the whole stack (setFullStackChecks).
  if (__DEV__ && top !== null) {
    for (
      let e: Entry | null = top;
      e !== null;
      e = fullStackChecks ? e.below : null
    ) {
      if (e.clock === it.id.clock && e.client === it.id.client) {
        throw new Error(
          `@lexical/y: format item ${it.id.client}:${it.id.clock} (${key}) stepped twice: a fold re-stepped items its seed holds`,
        );
      }
    }
  }
  if (top === null) {
    setStack(formats, key, shadow, entry(null, it, shown));
    return;
  }
  // Rule 1: a paired opener pushes its run; an unpaired item replaces the
  // unpaired runs above the topmost paired run and pushes itself. The live
  // end found here stays with the new entry (see entryPaired), so later
  // steps that ask whether this run is paired skip the index.
  let base: Entry | null = top;
  let end: Item | null = null;
  const paired =
    value !== null &&
    ((pendingCount > 0 && pendingPaired.has(it)) ||
      (mayPair(doc) && (end = liveEndOf(it)) !== null));
  if (!paired) {
    stats.unpairedPushes++;
    while (base !== null && !entryPaired(doc, base)) {
      base = base.below;
    }
  }
  const pushed = entry(base, it, shown);
  pushed.end = end;
  setStack(formats, key, shadow, pushed);
}

/** The paired entries strictly above `own` (from `top`), re-pushed onto `base`. */
function rebuildOnto(
  top: Entry,
  own: Entry,
  base: Entry | null,
  doc: Doc,
): Entry | null {
  const above: Entry[] = [];
  for (let e: Entry | null = top; e !== own && e !== null; e = e.below) {
    above.push(e);
  }
  let out = base;
  for (let i = above.length - 1; i >= 0; i--) {
    const e = above[i];
    if (entryPaired(doc, e)) {
      // paired, so it has its opener
      out = entry(out, e.opener!, e.value);
    }
  }
  return out;
}

/**
 * A map with only what `formats` holds for `key` (its value and its stack):
 * a fold of that key's items alone needs nothing else.
 */
export function keySlice(
  formats: Map<string, unknown>,
  key: string,
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const value = formats.get(key);
  if (value !== undefined) {
    out.set(key, value);
  }
  const info = keyInfo(key);
  const stack = topOf(formats, info, key);
  if (stack !== undefined) {
    setStack(out, key, info.shadow, stack);
  }
  return out;
}

/** Whether the stack of `key` in `formats` holds the run `client`:`clock` opened. */
export function isOnStack(
  formats: Map<string, unknown>,
  key: string,
  client: number,
  clock: number,
): boolean {
  for (
    let e = topOf(formats, keyInfo(key), key) ?? null;
    e !== null;
    e = e.below
  ) {
    if (e.client === client && e.clock === clock) {
      return true;
    }
  }
  return false;
}

/** The item with id `client`:`clock` in `doc`, or null. */
export const itemAtId = (doc: Doc, client: number, clock: number) =>
  itemAt(doc, createID(client, clock));

/** Attrs a reader hands on: no shadow keys. */
export function attrsOf(
  formats: Map<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of formats) {
    if (!isShadowKey(k)) {
      out[k] = v;
    }
  }
  return out;
}

export type {Entry};
