/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  ContentAny,
  ContentFormat,
  ContentType,
  createID,
  decodeUpdate,
  type Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  type GC,
  getItemCleanStart,
  type ID,
  Item,
  type Node as YNode,
  Skip,
  type Transaction,
} from '@y/y';

import {DEFAULT_ROOT_NAME} from './constants';
import {existingRoot, layoutRecordOf} from './Layouts';
import {createRawYDoc as createYDoc} from './RawYDoc';
import {
  LAYOUT_CODECS,
  plainRead,
  type YReplayCodec,
  type YReplayValues,
} from './ReplayCodec';
import {sourceView, type YQuarantineRecord} from './Server';

export {plainRead};
export type {YReplayCodec};

// The authority's replay of a quarantine record onto the current document
// (@lexical/y/server; D102, y-server.md "Migrating stored documents").
// Yjs only: it works on the record's own Yjs changes, by
// identity, which an in-place migration keeps.
//
// - The source view: the record's snapshot, deltas and queue merged into
//   one scratch document (sourceView; a pending record on top of its base).
//   Items matching the record's signals (id, parent, key and content) are
//   ignored.
// - The record's own changes: its inserts are the view's items that are not
//   in the base's accepted id set (every integrated item: not a skipped
//   range, not pending material); its deletions are items live in the base
//   and deleted in the view, and items an earlier replay inserted for the
//   same source that the view deletes (through the ledger).
// - Inserts are authored again under client ids of the replay, at their
//   original neighbours, as Yjs places a concurrent insert. Inserts the
//   record deleted itself, and its own format items, are written as deleted
//   placeholders, so later inserts anchored to them still find their place.
//   An insert whose container is deleted or gone in the current document,
//   or whose neighbour is collected there, is a conflict, as is anything
//   anchored to it. Only the served roots are replayed.
// - Deletions delete the same item when it is still live.
// - Base values: exact only for a record declaring `peers: false` (no channel
//   but the authority could deliver updates to the replica), through the
//   replica's own superseded items to an item live in the base.
// - Formats are decided per unit (a character, an embed, a node) and key:
//   the base value is what the replica saw before its own changes, and it is
//   exact only when the format item it depends on is live in the base;
//   nothing when current already equals mine, applied when the base value is
//   exact and current still equals it, a conflict otherwise. Units the
//   record inserted take its values. Writes go through `write` (default:
//   the plain layout 1/2 form).
// - Attributes (a container's map entries): exact when the chain of entries
//   the record's writes superseded reaches one live in the base (or, for a
//   first write, the base holds no entry); applied when the current entry is
//   still that one, nothing when it already holds mine, a conflict otherwise.
// - A draft holds no identities: it is never applied, only reported.
// - The ledger: one entry per change, keyed by the source incarnation and
//   generation, the root, the change kind, the source item and the target
//   key, with its outcome and result ids. A change already in it is not
//   applied again (a retry, the same edit in two records).
//
// The authority applies the returned update as a checked edit: computed on
// the state of a version and committed with a compare-and-set on that
// version, with the receipt; on a lost race it runs again on the new state.

/** @experimental A change replay decided on. */
export interface YReplayChange {
  readonly kind: 'insert' | 'delete' | 'format' | 'attribute' | 'draft';
  /** The source item (`client:clock`, the first unit of a range). */
  readonly source: string;
  /** Its id in the current document, when applied (inserts, attributes). */
  readonly result: string | null;
  readonly status:
    | 'applied'
    | 'satisfied'
    | 'unchanged'
    | 'conflict'
    | 'skipped'
    | 'shown';
  readonly reason?: string;
  readonly key?: string;
  /** Units covered (formats), length (inserts and deletions). */
  readonly length?: number;
}

/** @experimental What replayYRecovery returns. */
export interface YReplayResult {
  /** Whether the record can be replayed (see eligibility below). */
  readonly eligible: boolean;
  readonly reason: string | null;
  /** The update to commit (null: nothing to write). */
  readonly update: Uint8Array | null;
  /** The current state with the update applied (the current bytes when none). */
  readonly state: Uint8Array;
  readonly receipt: {
    /** The replay's client ids, by source client. */
    readonly clients: readonly (readonly [number, number])[];
    readonly changes: readonly YReplayChange[];
    readonly applied: number;
    readonly conflicts: number;
    readonly skipped: number;
    /** New ledger entries (see YReplayConfig.ledger), to commit with the state. */
    readonly ledger: readonly (readonly [string, string])[];
  };
  readonly conflicts: readonly YReplayChange[];
}

/** One unit's values of every key (a fold), `undefined`: no value. */
type Values = YReplayValues;

/** @experimental Options of replayYRecovery. */
export interface YReplayConfig {
  /** The room's incarnation and current generation. */
  readonly incarnation: string;
  readonly generation: string;
  /** The generation of `base` (the record's source generation must equal it). */
  readonly baseGeneration: string;
  /**
   * Whether every transition from the base generation to the current one
   * is an in-place migration the authority recorded (false: a fresh
   * document or a restore; the record goes to the recovery view).
   */
  readonly inPlace: boolean;
  /** The roots it serves (default `['lexical-y']`). */
  readonly roots?: readonly string[];
  /** Garbage collection of the current document (default true). */
  readonly gc?: boolean;
  /**
   * The ledger of earlier replays: `<incarnation>|<generation>|<root>|<kind>|
   * <client:clock>[|<key>]` -> `<outcome>|<rclient:rclock:length>`.
   */
  readonly ledger?: ReadonlyMap<string, string>;
  /** One client id for every write (tests; default: one per source client). */
  readonly clientID?: number;
  /**
   * Client ids the replay must not take besides those of the three
   * documents: the authority passes every client of its quarantine records
   * and bases.
   */
  readonly reserved?: (client: number) => boolean;
  /**
   * Format codecs by layout, over the built-in ones (layouts 1 and 2: the
   * plain fold): how the replay reads and writes a container's format
   * values in the layout the current document's root records. A root at a
   * layout without a codec makes the record ineligible.
   */
  readonly codecs?: Readonly<Record<number, YReplayCodec>>;
}

const idKey = (client: number, clock: number) => `${client}:${clock}`;
const keyOf = (id: ID) => idKey(id.client, id.clock);

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
const same = (a: unknown, b: unknown) =>
  a === b || stableJSON(a) === stableJSON(b);

/** FNV-1a 32 over bytes then text. */
function fnv(bytes: Uint8Array, text: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  }
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ (text.charCodeAt(i) & 0xff), 0x01000193) >>> 0;
    h = Math.imul(h ^ (text.charCodeAt(i) >>> 8), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The struct holding `id` in `doc`, null when the store lacks it. */
type Struct = Item | GC | Skip;

/** A collected struct (neither an item nor a skipped range). */
const isGC = (s: Struct | null): boolean =>
  s !== null && !(s instanceof Item) && !(s instanceof Skip);

/** Content collected or made deleted (not countable, not a format). */
const isDeletedContent = (it: Item): boolean =>
  !it.countable && !(it.content instanceof ContentFormat);

function structAt(doc: Doc, id: ID): Struct | null {
  const structs = doc.store.clients.get(id.client);
  if (structs === undefined || structs.length === 0) {
    return null;
  }
  const last = structs[structs.length - 1];
  if (id.clock >= last.id.clock + last.length) {
    return null;
  }
  return doc.store.getItem(id) as unknown as Struct;
}

function itemAt(doc: Doc, id: ID): Item | null {
  const s = structAt(doc, id);
  return s instanceof Item ? s : null;
}

/** The item ending exactly at `id` (split there when needed). */
function cleanEnd(tr: Transaction, id: ID): Item | null {
  const it = itemAt(tr.doc, id);
  if (it === null) {
    return null;
  }
  if (it.id.clock + it.length - 1 !== id.clock) {
    getItemCleanStart(tr, createID(id.client, id.clock + 1));
  }
  return itemAt(tr.doc, id);
}

/** The item starting exactly at `id` (split there when needed). */
function cleanStart(tr: Transaction, id: ID): Item | null {
  const it = itemAt(tr.doc, id);
  if (it === null) {
    return null;
  }
  return it.id.clock === id.clock
    ? it
    : (getItemCleanStart(tr, id) as unknown as Item);
}

/** Whether `type` and every container holding it are live. */
function liveType(type: YNode): boolean {
  for (let t: YNode | null = type; t !== null; ) {
    const item = t._item;
    if (item === null) {
      return true;
    }
    if (item.deleted) {
      return false;
    }
    t = item.parent as YNode;
  }
  return true;
}

/** Every container under the served roots, depth first (stable order). */
function containers(doc: Doc, roots: readonly string[]): YNode[] {
  const out: YNode[] = [];
  const seen = new Set<YNode>();
  const visit = (node: YNode) => {
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    out.push(node);
    for (let it = node._start; it !== null; it = it.right) {
      if (it.content instanceof ContentType) {
        visit(it.content.type as YNode);
      }
    }
    for (const key of [...node._map.keys()].sort()) {
      for (
        let it: Item | null = node._map.get(key)!;
        it !== null;
        it = it.left
      ) {
        if (it.content instanceof ContentType) {
          visit(it.content.type as YNode);
        }
      }
    }
  };
  for (const name of [...roots].sort()) {
    const root = existingRoot(doc, name);
    if (root !== null) {
      visit(root);
    }
  }
  return out;
}

/** In a unit's unknown keys: every key (a collected item of another client). */
const ANY_KEY = '\u0000any';

/** A range of a view item's units the record inserted. */
type Ins = {item: Item; offset: number; len: number; id: ID; root: string};

/**
 * @experimental Replay a quarantine record's own changes onto the current
 * document. `base` is the immutable base of the record's
 * source generation, `current` the state of the version the authority
 * will commit against. Returns the update and its receipt; apply both
 * with a compare-and-set on that version, and run again on a lost race.
 * Throws nothing for a record it cannot replay: `eligible: false`.
 */
export function replayYRecovery(
  record: YQuarantineRecord,
  base: Uint8Array,
  current: Uint8Array,
  config: YReplayConfig,
): YReplayResult {
  // A container whose format write did not read back as intended is
  // computed again with its format changes as conflicts: never a false
  // "applied" (the replay is deterministic, so each pass holds back more).
  const held = new Set<string>();
  for (;;) {
    const {failed, result} = replayOnce(record, base, current, config, held);
    const fresh = [...failed].filter(k => !held.has(k));
    if (fresh.length === 0) {
      return result;
    }
    fresh.forEach(k => held.add(k));
  }
}

function replayOnce(
  record: YQuarantineRecord,
  base: Uint8Array,
  current: Uint8Array,
  config: YReplayConfig,
  held: ReadonlySet<string>,
): {failed: Set<string>; result: YReplayResult} {
  const failed = new Set<string>();
  const finish = (result: YReplayResult) => ({failed, result});
  const roots = config.roots ?? [DEFAULT_ROOT_NAME];
  const changes: YReplayChange[] = [];
  const ledgerOut: [string, string][] = [];
  const empty = (eligible: boolean, reason: string | null) =>
    finish({
      conflicts: [],
      eligible,
      reason,
      receipt: {
        applied: 0,
        changes,
        clients: [],
        conflicts: 0,
        ledger: [],
        skipped: 0,
      },
      state: current,
      update: null,
    });
  const src = record.source;
  if (src.incarnation === null || src.incarnation !== config.incarnation) {
    return empty(false, 'another or an unknown incarnation');
  }
  if (
    src.generation === null ||
    src.generation === 'unknown' ||
    src.generation !== config.baseGeneration
  ) {
    return empty(false, 'no base for the source generation');
  }
  if (!config.inPlace) {
    return empty(
      false,
      'the document was not migrated in place since the source generation',
    );
  }
  const scope = `${src.incarnation}|${src.generation}`;
  // Whether a channel other than the authority could deliver updates to the
  // replica (absent: true). A replica with peers proves no base value: its
  // format and attribute changes are conflicts.
  const peers = record.peers;
  // The client ids the replica wrote under since its last sync: only its
  // items under them are its own in a base-value chain.
  const ownClients = new Set(record.clients);
  if (
    record.snapshot === null &&
    record.deltas.length === 0 &&
    record.queue.length === 0
  ) {
    if (record.draft !== null && record.draft.differs) {
      changes.push({
        kind: 'draft',
        result: null,
        source: record.id,
        status: 'shown',
      });
    }
    return empty(true, null);
  }
  // The source view; a record without a snapshot (the pending material a
  // migration split out) is read on top of its base.
  const view = sourceView({
    deltas: record.deltas,
    queue: record.queue,
    snapshot: record.snapshot === null ? base : record.snapshot,
  }).doc;
  const b = createYDoc(base, {gc: false});
  const cur = createYDoc(current, {gc: config.gc ?? true});
  try {
    // The format codec of each served root, by the layout it records.
    const codecs = new Map<string, YReplayCodec>();
    for (const name of roots) {
      const root = existingRoot(cur, name);
      if (root === null) {
        continue;
      }
      const recorded = layoutRecordOf(root);
      const layout = recorded.kind === 'layout' ? recorded.layout : 1;
      const codec =
        (config.codecs !== undefined ? config.codecs[layout] : undefined) ??
        LAYOUT_CODECS[layout];
      if (codec === undefined) {
        return empty(false, `layout ${layout} has no replay codec`);
      }
      codecs.set(name, codec);
    }
    // The layout of the source view's roots: its own format values are
    // read with the plain fold (layouts 1 and 2); a view at a later layout
    // proves no base value of a format.
    let viewPlain = true;
    for (const name of roots) {
      const root = existingRoot(view, name);
      const recorded = root === null ? null : layoutRecordOf(root);
      if (
        recorded !== null &&
        recorded.kind === 'layout' &&
        recorded.layout > 2
      ) {
        viewPlain = false;
      }
    }
    // The base's accepted id set: integrated items (a skipped range or
    // pending material is not in it) that the migration kept. An in-place
    // migration keeps every id but what it split out (2.3), and the current
    // document never drops a struct, so an id of the base the current
    // document lacks is split material: replayed through its record.
    const accepted = (client: number, clock: number) => {
      const id = createID(client, clock);
      const s = structAt(b, id);
      return (s instanceof Item || isGC(s)) && structAt(cur, id) !== null;
    };
    const liveInBase = (id: ID) => {
      const it = itemAt(b, id);
      return it !== null && !it.deleted;
    };
    // The roots of the view by type, and an item's root (null: not served).
    const rootNames = new Map<YNode, string>();
    view.share.forEach((t, k) => rootNames.set(t as YNode, k));
    const baseRootNames = new Map<YNode, string>();
    b.share.forEach((t, k) => baseRootNames.set(t as YNode, k));
    const rootOf = (it: Item): string | null => {
      let p = it.parent as YNode;
      while (p._item !== null) {
        p = p._item.parent as YNode;
      }
      const name = rootNames.get(p) ?? baseRootNames.get(p);
      return name !== undefined && roots.includes(name) ? name : null;
    };
    // The signals' own items (an exact match of id, parent, key and
    // content) are the authority's, not the replica's; an id holding other
    // content (a collision) is the replica's own.
    const signal = new Set<string>();
    for (const sg of record.signals) {
      const it = itemAt(view, createID(sg.client, sg.clock));
      const content: Item['content'] | null = it === null ? null : it.content;
      if (
        it !== null &&
        content !== null &&
        it.id.clock === sg.clock &&
        it.length === 1 &&
        it.parent === existingRoot(view, sg.root) &&
        it.parentSub === sg.key &&
        content.getContent()[0] === true &&
        it.content instanceof ContentAny
      ) {
        signal.add(keyOf(it.id));
      }
    }
    const isSignal = (it: Item, clock: number): boolean =>
      signal.size > 0 && signal.has(idKey(it.id.client, clock));
    // The ledger of this source: per root and kind.
    const ledgerIn = config.ledger ?? new Map<string, string>();
    type Done = {
      clock: number;
      len: number;
      rc: number;
      rk: number;
      outcome: string;
    };
    const insertsDone = new Map<string, Done[]>();
    for (const [k, v] of ledgerIn) {
      const parts2 = k.split('|');
      if (`${parts2[0]}|${parts2[1]}` !== scope || parts2[3] !== 'insert') {
        continue;
      }
      const [c, clock] = parts2[4].split(':').map(Number);
      const [outcome, res] = v.split('|');
      if (outcome !== 'applied' && outcome !== 'placeholder') {
        // A conflict is decided again on the state of each replay.
        continue;
      }
      const [rc, rk, len] = res.split(':').map(Number);
      const list = insertsDone.get(`${parts2[2]}|${c}`) ?? [];
      list.push({clock, len, outcome, rc, rk});
      insertsDone.set(`${parts2[2]}|${c}`, list);
    }
    const insertDone = (root: string, client: number, clock: number) => {
      for (const d of insertsDone.get(`${root}|${client}`) ?? []) {
        if (clock >= d.clock && clock < d.clock + d.len) {
          return {
            id: createID(d.rc, d.rk + (clock - d.clock)),
            placeholder: d.outcome === 'placeholder',
          };
        }
      }
      return null;
    };
    const ledgerKey = (root: string, kind: string, id: ID, key?: string) =>
      `${scope}|${root}|${kind}|${keyOf(id)}${key === undefined ? '' : `|${key}`}`;
    // The record's own inserts: units of the view's items outside the
    // accepted id set, in the served roots, split where the ledger's ranges
    // start or stop.
    const inserts: Ins[] = [];
    for (const structs of view.store.clients.values()) {
      for (const s of structs) {
        if (!(s instanceof Item)) {
          continue;
        }
        const root = rootOf(s);
        if (root === null) {
          continue;
        }
        let start = -1;
        let doneState: string | null = null;
        const flush = (end: number) => {
          if (start >= 0) {
            inserts.push({
              id: createID(s.id.client, s.id.clock + start),
              item: s,
              len: end - start,
              offset: start,
              root,
            });
          }
          start = -1;
        };
        for (let i = 0; i < s.length; i++) {
          const clock = s.id.clock + i;
          const own = !accepted(s.id.client, clock) && !isSignal(s, clock);
          const done = own ? insertDone(root, s.id.client, clock) : null;
          const state = done === null ? 'new' : 'done';
          if (!own || state !== doneState) {
            flush(i);
          }
          if (own && start < 0) {
            start = i;
            doneState = state;
          }
        }
        flush(s.length);
      }
    }
    // Map: source unit id -> result unit id (re-authored), per first clock.
    const mapped = new Map<string, ID>();
    const refused = new Set<string>();
    const byClient = new Map<number, Ins[]>();
    for (const ins of inserts) {
      const list = byClient.get(ins.id.client) ?? [];
      list.push(ins);
      byClient.set(ins.id.client, list);
    }
    for (const list of byClient.values()) {
      list.sort((x, y) => x.id.clock - y.id.clock);
    }
    const insertAt = (id: ID): Ins | null => {
      const list = byClient.get(id.client);
      if (list === undefined) {
        return null;
      }
      let lo = 0;
      let hi = list.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const x = list[mid];
        if (id.clock < x.id.clock) {
          hi = mid - 1;
        } else if (id.clock >= x.id.clock + x.len) {
          lo = mid + 1;
        } else {
          return x;
        }
      }
      return null;
    };
    const resolve = (id: ID | null): ID | null | 'missing' | 'refused' => {
      if (id === null) {
        return null;
      }
      if (accepted(id.client, id.clock)) {
        return id;
      }
      const ins = insertAt(id);
      if (ins === null) {
        return 'missing';
      }
      const k = keyOf(ins.id);
      if (refused.has(k)) {
        return 'refused';
      }
      const m = mapped.get(k);
      return m === undefined
        ? 'missing'
        : createID(m.client, m.clock + (id.clock - ins.id.clock));
    };
    // The replay's client ids, one per source client: an id in the same gap
    // of the current document's clients as the source's (Yjs orders
    // concurrent inserts at one place by client id, so a re-authored insert
    // keeps its side against a concurrent current-generation insert), at a
    // hashed position, outside every client the authority knows.
    const curSV = encodeStateVector(cur);
    const taken = (c: number) =>
      c <= 0 ||
      cur.store.clients.has(c) ||
      view.store.clients.has(c) ||
      b.store.clients.has(c) ||
      (config.reserved !== undefined && config.reserved(c));
    const curClients = [...cur.store.clients.keys()];
    const used = new Set<number>();
    const replayClients = new Map<number, number>();
    const clientFor = (from: number): number => {
      if (config.clientID !== undefined) {
        return config.clientID;
      }
      const known = replayClients.get(from);
      if (known !== undefined) {
        return known;
      }
      const max = from < 2 ** 32 ? 2 ** 32 - 1 : 2 ** 53 - 1;
      let below = 0;
      let above = max + 1;
      for (const c of curClients) {
        if (c < from) {
          below = Math.max(below, c);
        } else if (c > from) {
          above = Math.min(above, c);
        }
      }
      const width = above - below - 1;
      let found = 0;
      for (let seed = 0; seed < 64 && found === 0 && width > 0; seed++) {
        const cand =
          below + 1 + (fnv(curSV, `${record.hash}:${from}`, seed) % width);
        if (!taken(cand) && !used.has(cand)) {
          found = cand;
        }
      }
      for (
        let seed = 64;
        found === 0 || taken(found) || used.has(found);
        seed++
      ) {
        found = fnv(curSV, `${record.hash}:${from}`, seed);
      }
      used.add(found);
      replayClients.set(from, found);
      return found;
    };
    const containerIn = (doc: Doc, p: YNode | ID | null): YNode | null => {
      if (p === null) {
        return null;
      }
      if ('_map' in (p as object)) {
        return p as YNode;
      }
      const it = itemAt(doc, p as ID);
      return it !== null && it.content instanceof ContentType
        ? (it.content.type as YNode)
        : null;
    };
    // A view container's counterpart in the current document.
    const target = (vc: YNode): YNode | null => {
      if (vc._item === null) {
        const name = rootNames.get(vc);
        return name === undefined ? null : cur.get(name);
      }
      const r = resolve(vc._item.id);
      return r === null || r === 'missing' || r === 'refused'
        ? null
        : containerIn(cur, r);
    };
    let wrote = false;
    const svBefore = encodeStateVector(cur);
    const own = cur.clientID;
    try {
      cur.transact(tr => {
        // 1. Inserts, in dependency order (origins and parents first).
        const todo = new Set(inserts);
        for (let progress = true; progress && todo.size > 0; ) {
          progress = false;
          for (const ins of [...todo]) {
            const it = ins.item;
            const origin =
              ins.offset > 0
                ? createID(it.id.client, it.id.clock + ins.offset - 1)
                : it.origin;
            const o = resolve(origin);
            const r = resolve(it.rightOrigin);
            const vp = it.parent as YNode;
            const p: YNode | ID | null | 'missing' | 'refused' =
              vp._item === null
                ? cur.get(rootNames.get(vp)!)
                : resolve(vp._item.id);
            if (o === 'missing' || r === 'missing' || p === 'missing') {
              continue;
            }
            todo.delete(ins);
            progress = true;
            const source = keyOf(ins.id);
            const conflict = (reason: string) => {
              refused.add(source);
              changes.push({
                kind: 'insert',
                length: ins.len,
                reason,
                result: null,
                source,
                status: 'conflict',
              });
              ledgerOut.push([
                ledgerKey(ins.root, 'insert', ins.id),
                `conflict|0:0:${ins.len}`,
              ]);
            };
            if (o === 'refused' || r === 'refused' || p === 'refused') {
              conflict('anchored to a conflicting insert');
              continue;
            }
            const parent = containerIn(cur, p);
            const done = insertDone(ins.root, ins.id.client, ins.id.clock);
            if (done !== null) {
              mapped.set(source, done.id);
              if (it.deleted && !done.placeholder) {
                // Inserted by an earlier replay, deleted by the view since.
                for (let k = 0; k < ins.len; k++) {
                  const rid = createID(done.id.client, done.id.clock + k);
                  const t = cleanStart(tr, rid);
                  if (t !== null && !t.deleted) {
                    if (t.length > 1) {
                      getItemCleanStart(
                        tr,
                        createID(rid.client, rid.clock + 1),
                      );
                    }
                    itemAt(cur, rid)!.delete(tr);
                    wrote = true;
                  }
                }
                changes.push({
                  kind: 'delete',
                  length: ins.len,
                  result: keyOf(done.id),
                  source,
                  status: 'applied',
                });
              } else {
                changes.push({
                  kind: 'insert',
                  length: ins.len,
                  result: keyOf(done.id),
                  source,
                  status: 'skipped',
                });
              }
              continue;
            }
            if (
              it.parentSub !== null &&
              parent !== null &&
              (parent._item === null ||
                accepted(parent._item.id.client, parent._item.id.clock))
            ) {
              // An attribute of a container the base holds: decided in
              // step 3; later entries anchored to it map to it.
              mapped.set(source, ins.id);
              continue;
            }
            if (parent === null) {
              conflict('its container is gone');
              continue;
            }
            const placeholder =
              it.deleted ||
              it.content instanceof ContentFormat ||
              isDeletedContent(it);
            if (!liveType(parent) && !placeholder) {
              conflict('its container was deleted since');
              continue;
            }
            let left: Item | null = null;
            let right: Item | null = null;
            if (it.parentSub === null) {
              if (o !== null) {
                left = cleanEnd(tr, o);
                if (left === null) {
                  conflict('its left neighbour is gone');
                  continue;
                }
              }
              if (r !== null) {
                right = cleanStart(tr, r);
                if (right === null) {
                  conflict('its right neighbour is gone');
                  continue;
                }
              }
              if (
                (left !== null && left.parent !== parent) ||
                (right !== null && right.parent !== parent)
              ) {
                conflict('its neighbours moved to another container');
                continue;
              }
            } else {
              left = parent._map.get(it.parentSub) ?? null;
            }
            let content = it.content.copy();
            if (ins.offset > 0) {
              content = content.splice(ins.offset);
            }
            if (it.length - ins.offset > ins.len) {
              content.splice(ins.len);
            }
            const rc = clientFor(ins.id.client);
            const item = new Item(
              createID(rc, cur.store.getClock(rc)),
              left,
              left === null ? null : left.lastId,
              right,
              right === null ? null : right.id,
              parent,
              it.parentSub,
              content,
            );
            item.integrate(tr, 0);
            if (placeholder) {
              // Deleted at once: an anchor for later inserts, nothing shown.
              item.delete(tr);
            }
            wrote = true;
            mapped.set(source, item.id);
            ledgerOut.push([
              ledgerKey(ins.root, 'insert', ins.id),
              `${placeholder ? 'placeholder' : 'applied'}|${keyOf(item.id)}:${ins.len}`,
            ]);
            if (!placeholder) {
              changes.push({
                kind: 'insert',
                length: ins.len,
                result: keyOf(item.id),
                source,
                status: 'applied',
              });
            }
          }
        }
        for (const ins of todo) {
          refused.add(keyOf(ins.id));
          changes.push({
            kind: 'insert',
            length: ins.len,
            reason: 'its dependencies are missing (incomplete record)',
            result: null,
            source: keyOf(ins.id),
            status: 'conflict',
          });
        }
        // 2. Deletions of content and containers the base holds live.
        const viewDeleted = decodeUpdate(encodeStateAsUpdate(view)).ds;
        for (const [c, structs] of b.store.clients) {
          for (const s of structs) {
            if (
              !(s instanceof Item) ||
              s.deleted ||
              s.content instanceof ContentFormat ||
              s.parentSub !== null
            ) {
              continue;
            }
            const baseRoot = rootOf(s);
            for (let i = 0; i < s.length; ) {
              const vid = createID(c, s.id.clock + i);
              const v = structAt(view, vid);
              const known = v instanceof Item || isGC(v);
              const span = known
                ? Math.min(s.length - i, v!.id.clock + v!.length - vid.clock)
                : 1;
              // Deleted in the view: a deleted item, collected (a GC struct:
              // its container went too), or, for an id the view only knows
              // through a skipped range, in its delete set.
              const gone = known
                ? (v instanceof Item && v.deleted) || isGC(v)
                : viewDeleted.hasId(vid);
              if (gone && baseRoot !== null) {
                const source = keyOf(vid);
                // Unit by unit: the current document may have split or
                // deleted part of the range since.
                let deleted = 0;
                for (let k = 0; k < span; ) {
                  const id = createID(c, vid.clock + k);
                  const t = itemAt(cur, id);
                  if (t === null) {
                    k++;
                    continue;
                  }
                  const n = Math.min(
                    t.id.clock + t.length - id.clock,
                    span - k,
                  );
                  if (!t.deleted) {
                    cleanStart(tr, id);
                    if (itemAt(cur, id)!.length > n) {
                      getItemCleanStart(tr, createID(c, id.clock + n));
                    }
                    itemAt(cur, id)!.delete(tr);
                    deleted += n;
                  }
                  k += n;
                }
                if (deleted > 0) {
                  wrote = true;
                }
                changes.push({
                  kind: 'delete',
                  length: span,
                  result: null,
                  source,
                  status: deleted > 0 ? 'applied' : 'satisfied',
                });
              }
              i += span;
            }
          }
        }
        // 3. Attributes of containers the base holds (a container the record
        // deleted goes with step 2).
        for (const vc of containers(view, roots)) {
          if (!liveType(vc)) {
            continue;
          }
          const pid = vc._item === null ? null : vc._item.id;
          if (pid !== null && !accepted(pid.client, pid.clock)) {
            continue;
          }
          const tc = target(vc);
          const bc =
            pid === null
              ? existingRoot(b, rootNames.get(vc)!)
              : containerIn(b, pid);
          let rootName = '';
          for (let p: YNode = vc; ; p = p._item!.parent as YNode) {
            if (p._item === null) {
              rootName = rootNames.get(p) ?? '';
              break;
            }
          }
          for (const [key, entry] of vc._map) {
            const mine =
              !accepted(entry.id.client, entry.id.clock) &&
              !isSignal(entry, entry.id.clock);
            const removedBase =
              !mine && entry.deleted && liveInBase(entry.id) ? entry : null;
            if (!mine && removedBase === null) {
              continue;
            }
            const source = keyOf(entry.id);
            const lk = ledgerKey(rootName, 'attribute', entry.id, key);
            const prior = ledgerIn.get(lk);
            if (prior !== undefined && !prior.startsWith('conflict|')) {
              changes.push({
                key,
                kind: 'attribute',
                result: prior.split('|')[1] ?? null,
                source,
                status: 'skipped',
              });
              continue;
            }
            const record2 = (
              status: YReplayChange['status'],
              result: string | null,
              reason?: string,
            ) => {
              changes.push({
                key,
                kind: 'attribute',
                reason,
                result,
                source,
                status,
              });
              if (status !== 'unchanged') {
                ledgerOut.push([lk, `${status}|${result ?? ''}`]);
              }
            };
            if (tc === null || !liveType(tc)) {
              record2('conflict', null, 'its container is gone or deleted');
              continue;
            }
            const now: Item | null = tc._map.get(key) ?? null;
            const nowLive = now !== null && !now.deleted;
            if (removedBase !== null) {
              if (!nowLive) {
                record2('satisfied', null);
              } else if (peers) {
                record2('conflict', null, 'the replica had peers');
              } else if (keyOf(now!.lastId) === keyOf(removedBase.lastId)) {
                now!.delete(tr);
                wrote = true;
                record2('applied', null);
              } else {
                record2('conflict', null, 'changed since');
              }
              continue;
            }
            if (entry.deleted) {
              continue;
            }
            const value = entry.content.getContent()[0];
            if (nowLive && same(now!.content.getContent()[0], value)) {
              record2('satisfied', keyOf(now!.id));
              continue;
            }
            if (peers) {
              record2('conflict', null, 'the replica had peers');
              continue;
            }
            if (!ownClients.has(entry.id.client)) {
              record2('conflict', null, 'not written by the replica');
              continue;
            }
            // Exact only when the chain of entries the record's writes
            // superseded, each the replica's own, reaches an entry live in
            // the base (a first write: the base holds no live entry).
            let superseded = entry.origin;
            let broken = false;
            while (
              superseded !== null &&
              !accepted(superseded.client, superseded.clock)
            ) {
              const prev = itemAt(view, superseded);
              if (
                prev === null ||
                prev.parentSub !== key ||
                !ownClients.has(prev.id.client)
              ) {
                broken = true;
                break;
              }
              superseded = prev.origin;
            }
            const baseNow: Item | null =
              bc === null ? null : (bc._map.get(key) ?? null);
            const exact =
              !broken &&
              (superseded === null
                ? baseNow === null || baseNow.deleted
                : liveInBase(superseded));
            if (!exact) {
              record2('conflict', null, 'base value unknown');
              continue;
            }
            const stillBase =
              superseded === null
                ? now === null ||
                  (now.deleted && accepted(now.id.client, now.id.clock))
                : now !== null && keyOf(now.lastId) === keyOf(superseded);
            if (!stillBase) {
              record2('conflict', null, 'changed since');
              continue;
            }
            const ac = clientFor(entry.id.client);
            const item = new Item(
              createID(ac, cur.store.getClock(ac)),
              now,
              now === null ? null : now.lastId,
              null,
              null,
              tc,
              key,
              entry.content.copy(),
            );
            item.integrate(tr, 0);
            wrote = true;
            record2('applied', `${keyOf(item.id)}:1`);
          }
        }
        // 4. Formats, per unit and key.
        const sources = [...byClient.keys()].sort((x, y) => x - y);
        cur.clientID = clientFor(sources.length > 0 ? sources[0] : 1);
        for (const vc of containers(view, roots)) {
          const tc = target(vc);
          if (tc === null || !liveType(tc)) {
            continue;
          }
          // Mine (the view's fold) and base (what the replica saw before its
          // own changes, with exactness per key) per view unit.
          const mineVals = new Map<string, Values>();
          const baseVals = new Map<
            string,
            {values: Values; unknown: Set<string>}
          >();
          const mv: Values = new Map();
          const bv: Values = new Map();
          const unknown = new Set<string>();
          // Keys a format item of another client (not in the base, not the
          // replica's own) set since the last base item: the value before
          // the replica's changes is not proved.
          const foreign = new Set<string>();
          const fold = (vals: Values, f: ContentFormat) => {
            if (f.value === null) {
              vals.delete(f.key);
            } else {
              vals.set(f.key, f.value);
            }
          };
          for (let it = vc._start; it !== null; it = it.right) {
            if (it.content instanceof ContentFormat) {
              if (!it.deleted) {
                fold(mv, it.content);
              }
              if (accepted(it.id.client, it.id.clock)) {
                if (!it.deleted) {
                  foreign.delete(it.content.key);
                }
              } else if (!ownClients.has(it.id.client)) {
                // Live or superseded by the replica: either way its value
                // came before the replica's own, unproved.
                foreign.add(it.content.key);
              }
              if (accepted(it.id.client, it.id.clock)) {
                const live = liveInBase(it.id);
                if (live || !it.deleted) {
                  // Live in the base and in the view, or deleted by the
                  // record itself (exact); live in the view but deleted in
                  // the base (the replica saw it: inexact).
                  fold(bv, it.content);
                  if (live) {
                    unknown.delete(it.content.key);
                  } else {
                    unknown.add(it.content.key);
                  }
                }
              }
              continue;
            }
            if (isDeletedContent(it)) {
              if (
                !accepted(it.id.client, it.id.clock) &&
                !ownClients.has(it.id.client)
              ) {
                // Collected content of another client: it may have been a
                // format item, whose key is gone.
                foreign.add(ANY_KEY);
              }
              // Collected in the view: a format item the record deleted is
              // still live, with its content, in the base.
              for (let i = 0; i < it.length; i++) {
                const id = createID(it.id.client, it.id.clock + i);
                const bi = itemAt(b, id);
                if (
                  bi !== null &&
                  !bi.deleted &&
                  bi.content instanceof ContentFormat
                ) {
                  fold(bv, bi.content);
                  unknown.delete(bi.content.key);
                }
              }
              continue;
            }
            if (!it.countable || it.deleted) {
              continue;
            }
            for (let i = 0; i < it.length; i++) {
              const k = idKey(it.id.client, it.id.clock + i);
              mineVals.set(k, new Map(mv));
              baseVals.set(k, {
                unknown: new Set([...unknown, ...foreign]),
                values: new Map(bv),
              });
            }
          }
          let rootName = '';
          for (let p: YNode = vc; ; p = p._item!.parent as YNode) {
            if (p._item === null) {
              rootName = rootNames.get(p) ?? '';
              break;
            }
          }
          const codec = codecs.get(rootName);
          if (codec === undefined) {
            continue;
          }
          // The current read (the current layout's), mapped back to view
          // units.
          const now = codec.read(tc);
          const back = new Map<string, string>();
          for (const ins of inserts) {
            const m = mapped.get(keyOf(ins.id));
            if (m !== undefined) {
              for (let i = 0; i < ins.len; i++) {
                back.set(
                  idKey(m.client, m.clock + i),
                  idKey(ins.id.client, ins.id.clock + i),
                );
              }
            }
          }
          type Want = {id: ID; key: string; value: unknown; after: unknown};
          const wants: Want[] = [];
          const conflicts = new Map<string, {first: string; n: number}>();
          const addConflict = (key: string, reason: string, vk: string) => {
            const k = `${key}\u0000${reason}`;
            const prev = conflicts.get(k);
            conflicts.set(
              k,
              prev === undefined
                ? {first: vk, n: 1}
                : {first: prev.first, n: prev.n + 1},
            );
          };
          for (let ui = 0; ui < now.length; ui++) {
            const u = now[ui];
            const vk = back.get(keyOf(u.id)) ?? keyOf(u.id);
            const mineV = mineVals.get(vk);
            if (mineV === undefined) {
              continue;
            }
            const inserted = back.has(keyOf(u.id));
            const baseV = inserted ? undefined : baseVals.get(vk);
            const keys = new Set<string>([
              ...mineV.keys(),
              ...u.values.keys(),
              ...(baseV === undefined ? [] : baseV.values.keys()),
            ]);
            for (const key of keys) {
              const m = mineV.get(key);
              const c = u.values.get(key);
              if (codec.same(key, m, c)) {
                continue;
              }
              if (inserted) {
                wants.push({after: c, id: u.id, key, value: m});
                continue;
              }
              if (baseV === undefined) {
                continue;
              }
              const bval = baseV.values.get(key);
              const unknownKey =
                !viewPlain ||
                baseV.unknown.has(key) ||
                baseV.unknown.has(ANY_KEY);
              if (!unknownKey && same(m, bval)) {
                // The record did not change it: current wins.
                continue;
              }
              if (peers) {
                addConflict(key, 'the replica had peers', vk);
              } else if (unknownKey) {
                addConflict(key, 'base value unknown', vk);
              } else if (codec.same(key, c, bval)) {
                wants.push({after: c, id: u.id, key, value: m});
              } else {
                addConflict(key, 'changed since', vk);
              }
            }
          }
          // A container whose write did not read back as intended in an
          // earlier pass: its format changes are conflicts.
          const ckey =
            vc._item === null ? `root:${rootName}` : keyOf(vc._item.id);
          if (held.has(ckey)) {
            for (const want of wants) {
              addConflict(
                want.key,
                'the write did not hold',
                back.get(keyOf(want.id)) ?? keyOf(want.id),
              );
            }
            wants.length = 0;
          }
          for (const [k, v] of conflicts) {
            const [key, reason] = k.split('\u0000');
            changes.push({
              key,
              kind: 'format',
              length: v.n,
              reason,
              result: null,
              source: v.first,
              status: 'conflict',
            });
            const [fc, fk] = v.first.split(':').map(Number);
            ledgerOut.push([
              ledgerKey(rootName, 'format', createID(fc, fk), `${key}+${v.n}`),
              'conflict|',
            ]);
          }
          // The values the container shows next: current, with the applied
          // changes; written once, in the current layout, by its codec.
          const order = new Map<string, number>();
          now.forEach((u, i) => order.set(keyOf(u.id), i));
          if (wants.length > 0) {
            const next = now.map(u => new Map(u.values) as YReplayValues);
            for (const want of wants) {
              const values = next[order.get(keyOf(want.id))!];
              if (want.value === undefined) {
                values.delete(want.key);
              } else {
                values.set(want.key, want.value);
              }
            }
            if (codec.write(tr, tc, now, next)) {
              wrote = true;
            }
            // The codec's read after the write must be `next`, unit by unit.
            const after = codec.read(tc);
            const holds =
              after.length === next.length &&
              after.every((u, i) => {
                const keys = new Set([...u.values.keys(), ...next[i].keys()]);
                for (const key of keys) {
                  if (!codec.same(key, u.values.get(key), next[i].get(key))) {
                    return false;
                  }
                }
                return true;
              });
            if (!holds) {
              failed.add(ckey);
            }
          }
          // The receipt: ranges of consecutive units with one key and value.
          const byKey = new Map<string, Want[]>();
          for (const want of wants) {
            const list = byKey.get(want.key) ?? [];
            list.push(want);
            byKey.set(want.key, list);
          }
          for (const [key, list] of [...byKey].sort(([a], [b2]) =>
            a < b2 ? -1 : a > b2 ? 1 : 0,
          )) {
            list.sort(
              (x, y) => order.get(keyOf(x.id))! - order.get(keyOf(y.id))!,
            );
            let i = 0;
            while (i < list.length) {
              let j = i;
              while (
                j + 1 < list.length &&
                order.get(keyOf(list[j + 1].id))! ===
                  order.get(keyOf(list[j].id))! + 1 &&
                codec.same(key, list[j + 1].value, list[i].value)
              ) {
                j++;
              }
              const source = back.get(keyOf(list[i].id)) ?? keyOf(list[i].id);
              changes.push({
                key,
                kind: 'format',
                length: j - i + 1,
                result: keyOf(list[i].id),
                source,
                status: 'applied',
              });
              const [sc, sk] = source.split(':').map(Number);
              ledgerOut.push([
                ledgerKey(
                  rootName,
                  'format',
                  createID(sc, sk),
                  `${key}+${j - i + 1}`,
                ),
                `applied|${keyOf(list[i].id)}:${j - i + 1}`,
              ]);
              i = j + 1;
            }
          }
        }
      });
    } finally {
      cur.clientID = own;
    }
    if (record.draft !== null && record.draft.differs) {
      changes.push({
        kind: 'draft',
        result: null,
        source: record.id,
        status: 'shown',
      });
    }
    const conflicts = changes.filter(c => c.status === 'conflict');
    return finish({
      conflicts,
      eligible: true,
      reason: null,
      receipt: {
        applied: changes.filter(c => c.status === 'applied').length,
        changes,
        clients: [...replayClients],
        conflicts: conflicts.length,
        ledger: ledgerOut,
        skipped: changes.filter(c => c.status === 'skipped').length,
      },
      state: wrote ? encodeStateAsUpdate(cur) : current,
      update: wrote ? encodeStateAsUpdate(cur, svBefore) : null,
    });
  } finally {
    view.destroy();
    b.destroy();
    cur.destroy();
  }
}
