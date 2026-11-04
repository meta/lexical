/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  applyUpdate,
  ContentAny,
  type Doc,
  encodeStateAsUpdate,
  findIndexSS,
  Item,
  Skip,
} from '@y/y';

// Through the public entry (external in the build): one runner and one
// YMigrationError class for an app that imports both entries.
import {
  migrateYState,
  type YLayoutMigration,
  type YMigrationReceipt,
} from '../migrate';
import {type ClientIDRange} from './ClientID';
import {DEFAULT_ROOT_NAME, MIN_LAYOUT, SCHEMA_PREFIX} from './constants';
import {epochRecordOf, existingRoot, layoutRecordOf} from './Layouts';
import {createRawYDoc, type YDoc, type YDocOptions} from './RawYDoc';
import {assertSupportedMigrationYjs} from './YjsMigrationContract';

/**
 * A scratch document (Yjs only, see RawYDoc), once @y/y is checked against
 * the core's contract and this module's part of it.
 */
function createYDoc(state?: Uint8Array | null, options?: YDocOptions): YDoc {
  assertSupportedMigrationYjs();
  return createRawYDoc(state, options);
}

// The authority's side of layout migrations and the generation fence
// (@lexical/y/server; D102, y-server.md "Migrating stored documents"): the
// load-time migration, the generation, the handshake verdict, the legacy
// capture, quarantine records and whether one holds anything new. No
// Lexical: a relay or Durable Object imports it with its steps.

/**
 * @experimental The generation of a document's state, over the roots an
 * authority serves: `` `${incarnation}/${epochs}` `` where `epochs` lists,
 * in root-name order, `encodeURIComponent(root)=layout.client.clock` for
 * each root with an epoch (`=?` for a malformed one), joined by `,`, or `-`
 * when none has one. Opaque: only equality matters. `incarnation` is the
 * room's (a new one on every recreation, restore and fresh-document
 * migration), so a copy from an earlier incarnation never matches.
 */
export function generationOf(
  doc: Doc,
  incarnation: string,
  roots: readonly string[] = [DEFAULT_ROOT_NAME],
): string {
  const parts: string[] = [];
  for (const name of [...new Set(roots)].sort()) {
    const root = existingRoot(doc, name);
    if (root === null) {
      continue;
    }
    const record = epochRecordOf(root);
    if (record.kind === 'epoch') {
      const {layout, client, clock} = record.epoch;
      parts.push(`${encodeURIComponent(name)}=${layout}.${client}.${clock}`);
    } else if (record.kind === 'malformed') {
      parts.push(`${encodeURIComponent(name)}=?`);
    }
  }
  return `${incarnation}/${parts.length === 0 ? '-' : parts.join(',')}`;
}

/** @experimental Options of prepareYRoom. */
export interface YPrepareRoomOptions {
  /** The steps the authority ships (statically imported). */
  readonly steps: readonly YLayoutMigration[];
  /** The room's incarnation (see generationOf). */
  readonly incarnation: string;
  /** The roots it serves (default `['lexical-y']`). */
  readonly roots?: readonly string[];
  /** Garbage collection of its stored documents (default true). */
  readonly gc?: boolean;
  /** The target (default MIN_LAYOUT: only roots below the floor migrate). */
  readonly to?: number;
  readonly clientIDRange?: ClientIDRange;
  readonly clientID?: (input: {
    readonly root: string;
    readonly step: string;
    readonly revision: number;
    readonly to: number;
  }) => number;
}

/** @experimental What prepareYRoom returns. */
export interface YPreparedRoom {
  /** Whether the state was migrated (store the result) or not (store nothing). */
  readonly changed: boolean;
  /** The state to serve: the stored bytes themselves when nothing changed. */
  readonly state: Uint8Array;
  /** Its generation (see generationOf). */
  readonly generation: string;
  /**
   * When changed: the stored state and its generation, to keep as the
   * immutable base of that generation (`bases[generation] = state`).
   */
  readonly base: {
    readonly generation: string;
    readonly state: Uint8Array;
  } | null;
  /** Pending material split out of the stored state, for a `pending` record. */
  readonly pending: Uint8Array | null;
  readonly receipt: YMigrationReceipt;
}

/**
 * @experimental The load-time migration of a stored document, minus
 * storage (y-server.md "Migrating stored documents", steps 2 to 4): run it
 * behind the room's barrier with every session out, then store `{state,
 * generation}`, `bases[base.generation] = base.state` and a `pending`
 * record, atomically, compare-and-set on the version read. Throws a
 * YMigrationError when a root is refused or a check fails: store nothing,
 * leave the room stuck (it applies nothing) and alert.
 */
export function prepareYRoom(
  stored: Uint8Array,
  options: YPrepareRoomOptions,
): YPreparedRoom {
  const roots = options.roots ?? [DEFAULT_ROOT_NAME];
  const gc = options.gc ?? true;
  const result = migrateYState(stored, options.steps, {
    clientID: options.clientID,
    clientIDRange: options.clientIDRange,
    gc,
    roots,
    to: options.to ?? MIN_LAYOUT,
  });
  const generation = (state: Uint8Array) => {
    const doc = createYDoc(state, {gc});
    try {
      return generationOf(doc, options.incarnation, roots);
    } finally {
      doc.destroy();
    }
  };
  if (!result.receipt.changed) {
    return {
      base: null,
      changed: false,
      generation: generation(stored),
      pending: null,
      receipt: result.receipt,
      state: stored,
    };
  }
  return {
    base: {generation: generation(stored), state: stored},
    changed: true,
    generation: generation(result.state),
    pending: result.pending,
    receipt: result.receipt,
    state: result.state,
  };
}

/** @experimental A generation a replica cannot name (material from before the fence). */
export const UNKNOWN_GENERATION = 'unknown';

/**
 * @experimental What a client sends before any sync message: the
 * generation its replica's material was made against (null: none,
 * `'unknown'`: material without a recorded generation), whether it holds
 * material (unsent edits or a cached state), the layouts its release reads
 * (`[MIN_LAYOUT, LAYOUT_VERSION]`) and the layout its seed records
 * (`SEED_LAYOUT`).
 */
export interface YSessionHandshake {
  readonly generation: string | null;
  readonly material: boolean;
  readonly layouts: readonly [number, number];
  readonly seed: number;
}

/** @experimental The room as checkYSession sees it (see describeYRoom). */
export interface YRoomDescription {
  readonly generation: string;
  readonly incarnation: string;
  /**
   * Whether the incarnation was inherited: assigned to a room that already
   * existed when the fence was deployed.
   */
  readonly inherited: boolean;
  /** Whether the room has no state at all (never seeded). */
  readonly pristine: boolean;
  /**
   * The lowest and highest layouts the served roots record, null when none
   * does. A client must read every served root: both bounds inside its
   * `layouts`.
   */
  readonly layouts: readonly [number, number] | null;
  /**
   * Served roots with content but no well-formed layout record (missing or
   * malformed) or with a malformed epoch: no client reads them.
   */
  readonly unreadable: readonly string[];
  /**
   * The room's seed contract: the SEED_LAYOUT its incarnation was issued
   * under. An authority whose own SEED_LAYOUT differs replaces a pristine
   * room's incarnation before it admits anyone (see needsNewIncarnation).
   */
  readonly seedContract: number;
}

/** @experimental Describe a room's document for checkYSession. */
export function describeYRoom(
  doc: Doc,
  options: {
    readonly incarnation: string;
    readonly inherited: boolean;
    /** The SEED_LAYOUT the room's incarnation was issued under. */
    readonly seedContract: number;
    readonly roots?: readonly string[];
  },
): YRoomDescription {
  const roots = options.roots ?? [DEFAULT_ROOT_NAME];
  let layouts: [number, number] | null = null;
  const unreadable: string[] = [];
  let pristine = true;
  for (const name of [...roots].sort()) {
    const root = existingRoot(doc, name);
    // Live content only, as the runner reads a root: a root whose items and
    // attributes were all deleted holds nothing to serve.
    if (
      root === null ||
      (root.length === 0 && Object.keys(root.getAttrs()).length === 0)
    ) {
      continue;
    }
    pristine = false;
    const record = layoutRecordOf(root);
    if (record.kind === 'layout' && epochRecordOf(root).kind !== 'malformed') {
      layouts =
        layouts === null
          ? [record.layout, record.layout]
          : [
              Math.min(layouts[0], record.layout),
              Math.max(layouts[1], record.layout),
            ];
    } else {
      unreadable.push(name);
    }
  }
  return {
    generation: generationOf(doc, options.incarnation, roots),
    incarnation: options.incarnation,
    inherited: options.inherited,
    layouts,
    pristine,
    seedContract: options.seedContract,
    unreadable,
  };
}

/**
 * @experimental Whether an authority whose SEED_LAYOUT is `seedLayout` must
 * replace the room's incarnation (a new token, the new seed contract)
 * before it admits anyone: the room is pristine and was issued under
 * another seed contract. A replica that seeded under the old contract and
 * never reached storage then presents another generation and hands off its
 * material, instead of being admitted or refused.
 */
export function needsNewIncarnation(
  room: YRoomDescription,
  seedLayout: number,
): boolean {
  return room.pristine && room.seedContract !== seedLayout;
}

/** @experimental checkYSession's verdict (y-server.md, the handshake table). */
export type YSessionVerdict =
  /**
   * Sync both ways. `initialize`: the room is pristine and the client may
   * seed it.
   */
  | {readonly verdict: 'admit'; readonly initialize: boolean}
  /**
   * A replica without material: load the room's state into a new document,
   * persist it with the generation, then bind. `initialize`: the room is
   * pristine and the client may seed it.
   */
  | {readonly verdict: 'bootstrap'; readonly initialize: boolean}
  /**
   * A replica with material that may not sync with this room: no sync
   * either way; it hands its material off (recovery handoff) and connects
   * again once acknowledged, without material.
   */
  | {readonly verdict: 'stale'}
  /** The client cannot read or seed the room: reload to another release. */
  | {readonly verdict: 'refuse-layout'}
  /** No handshake on a room it may not join: capture (captureYSession). */
  | {readonly verdict: 'legacy'};

/** Whether `value` is a well-formed YSessionHandshake. */
function isHandshake(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const h = value as Record<string, unknown>;
  const layout = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 1;
  const layouts = h.layouts;
  return (
    (h.generation === null || typeof h.generation === 'string') &&
    typeof h.material === 'boolean' &&
    Array.isArray(layouts) &&
    layouts.length === 2 &&
    layout(layouts[0]) &&
    layout(layouts[1]) &&
    (layouts[0] as number) <= (layouts[1] as number) &&
    layout(h.seed)
  );
}

/**
 * @experimental The handshake verdict for a session (y-server.md
 * "Migrating stored documents"): the first row that matches wins.
 * 1. No handshake (`client` null, a release before the fence): admit as
 *    today when the room's incarnation is inherited and it never migrated
 *    (no epoch) or was replaced (a new incarnation is never inherited);
 *    otherwise legacy.
 * 2. Material, and any of: another generation (another token, unknown or
 *    null), a served root's layout outside the client's `layouts` (or a
 *    served root without a well-formed record), a pristine
 *    room whose seed contract is not the client's `seed`: stale. No client
 *    holding material is refused before its material is acknowledged.
 * 3. A served root's layout outside `layouts`: refuse-layout.
 * 4. A pristine room whose seed contract is not `seed`: refuse-layout.
 * 5. The room's generation: admit (`initialize` in a pristine room).
 * 6. No material: bootstrap (`initialize` in a pristine room).
 * A handshake that is not well formed (it arrives from the network: a
 * generation that is neither a string nor null, a non-boolean material,
 * layouts that are not two layouts from 1 in order, a seed that is not a
 * layout) is `'refuse-layout'`.
 * Never sync a session whose verdict is not `'admit'`, and check every
 * update again at commit against the room's current generation.
 */
export function checkYSession(
  room: YRoomDescription,
  client: YSessionHandshake | null,
): YSessionVerdict {
  if (client !== null && !isHandshake(client)) {
    return {verdict: 'refuse-layout'};
  }
  if (client === null) {
    return room.inherited && room.generation === `${room.incarnation}/-`
      ? {initialize: false, verdict: 'admit'}
      : {verdict: 'legacy'};
  }
  const same =
    client.generation !== null &&
    client.generation !== UNKNOWN_GENERATION &&
    client.generation === room.generation;
  // Every served root inside the client's range.
  const [min, max] = client.layouts;
  const readable =
    room.unreadable.length === 0 &&
    (room.layouts === null ||
      (room.layouts[0] >= min && room.layouts[1] <= max));
  const seedable = !room.pristine || client.seed === room.seedContract;
  if (client.material && (!same || !readable || !seedable)) {
    return {verdict: 'stale'};
  }
  if (!readable || !seedable) {
    return {verdict: 'refuse-layout'};
  }
  if (same) {
    return {initialize: room.pristine, verdict: 'admit'};
  }
  return {initialize: room.pristine, verdict: 'bootstrap'};
}

/** An update holding nothing (V1). */
const emptyUpdate = (): Uint8Array => new Uint8Array([0, 0]);
/** An empty state vector. */
const emptyStateVector = (): Uint8Array => new Uint8Array([0]);

/** y-protocols' sync message types. */
const MESSAGE_SYNC = 0;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;

function varUint(n: number, out: number[]): void {
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

/** A y-protocols sync message (`messageSync`, then the step and its payload). */
function syncMessage(step: number, payload: Uint8Array): Uint8Array {
  const head: number[] = [MESSAGE_SYNC, step];
  varUint(payload.length, head);
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

/**
 * @experimental A legacy signal as sent (see legacySignal): its exact
 * payload, and the one item it writes (`client`, `clock`), on `root`'s
 * attribute `key`, with the value true.
 */
export interface YLegacySignal {
  readonly update: Uint8Array;
  readonly client: number;
  readonly clock: number;
  readonly root: string;
  readonly key: string;
}

/** @experimental What a legacy capture sends and keeps (see captureYSession). */
export interface YSessionCapture {
  /**
   * The answer to the client's sync step 1: an empty update (it receives
   * nothing of the room).
   */
  readonly syncStep2: Uint8Array;
  /**
   * The authority's own sync step 1: an empty state vector, so the client's
   * sync step 2 is its whole document (a standalone snapshot).
   */
  readonly syncStep1: Uint8Array;
  /** The same two as y-websocket messages (`messageSync` framing), in order. */
  readonly messages: readonly Uint8Array[];
  /**
   * Keep an update the session sent: its sync step 2 (the snapshot) first,
   * then every later update (deltas). Never apply them to the room.
   */
  add(update: Uint8Array): void;
  /**
   * The update that turns the legacy client read only (see legacySignal),
   * built on its snapshot and deltas once the snapshot has arrived (null
   * before), kept with the capture. Send it to the client only. Call it
   * again when `collisions()` names one: another fresh client id.
   */
  signal(supportedSchema: number, root?: string): YLegacySignal | null;
  /**
   * Signals whose id the session wrote other content at (its own client
   * had the same id): each was not a signal; send another.
   */
  collisions(): YLegacySignal[];
  /** The snapshot, deltas and signals kept so far. */
  material(): {
    snapshot: Uint8Array | null;
    deltas: Uint8Array[];
    signals: YLegacySignal[];
  };
}

/**
 * @experimental The legacy capture (a session with no handshake on a room
 * it may not join): the authority answers its sync step 1 with an empty
 * sync step 2 and sends its own sync step 1 with an empty state vector, so
 * the client's sync step 2 is its whole document, a standalone snapshot
 * never merged with anything the authority holds; later updates are kept
 * as deltas. Build a record from `material()` with quarantineRecord.
 */
export function captureYSession(): YSessionCapture {
  let snapshot: Uint8Array | null = null;
  const deltas: Uint8Array[] = [];
  const signals: YLegacySignal[] = [];
  const material = () => ({
    deltas: [...deltas],
    signals: [...signals],
    snapshot,
  });
  return {
    add(update: Uint8Array): void {
      if (snapshot === null) {
        snapshot = update;
      } else {
        deltas.push(update);
      }
    },
    collisions(): YLegacySignal[] {
      const view = sourceView({deltas, queue: [], snapshot});
      try {
        return signals.filter(sg => signalAt(view.doc, sg) === 'collision');
      } finally {
        view.doc.destroy();
      }
    },
    material,
    messages: [
      syncMessage(SYNC_STEP_2, emptyUpdate()),
      syncMessage(SYNC_STEP_1, emptyStateVector()),
    ],
    signal(supportedSchema: number, root: string = DEFAULT_ROOT_NAME) {
      if (snapshot === null) {
        return null;
      }
      const view = sourceView({deltas, queue: [], snapshot});
      try {
        const signal = legacySignal(
          encodeStateAsUpdate(view.doc),
          supportedSchema,
          root,
        );
        signals.push(signal);
        return signal;
      } finally {
        view.doc.destroy();
      }
    },
    syncStep1: emptyStateVector(),
    syncStep2: emptyUpdate(),
  };
}

/** A random client id (32 bits, from 1) that `taken` does not hold. */
function randomClient(taken: (client: number) => boolean): number {
  const c = globalThis.crypto;
  for (;;) {
    let n: number;
    if (c !== undefined && typeof c.getRandomValues === 'function') {
      const a = new Uint32Array(1);
      c.getRandomValues(a);
      n = a[0];
    } else {
      n = Math.floor(Math.random() * 0xffffffff) + 1;
    }
    if (n !== 0 && !taken(n)) {
      return n;
    }
  }
}

/**
 * @experimental The update that turns a client from before the fence read
 * only with its existing "newer version" state: built on that client's own
 * standalone `snapshot`, under a fresh random client id, it records
 * `lexical-y-schema:<n>` on `root`, `n` above the highest schema version the
 * snapshot records and above `supportedSchema`. It adds no deletion the
 * replica does not have. Never apply it to the room, and never build it on
 * the room's state (that would bring the room's deletions into the
 * client's offline text). Keep the returned signal with the record: its
 * item is excluded only where id, parent, key and content all match.
 */
export function legacySignal(
  snapshot: Uint8Array,
  supportedSchema: number,
  root: string = DEFAULT_ROOT_NAME,
): YLegacySignal {
  const doc = createYDoc(snapshot, {gc: false});
  try {
    const yroot = doc.get(root);
    let highest = supportedSchema;
    for (const key of Object.keys(yroot.getAttrs())) {
      if (key.startsWith(SCHEMA_PREFIX)) {
        const n = Number(key.slice(SCHEMA_PREFIX.length));
        if (Number.isSafeInteger(n)) {
          highest = Math.max(highest, n);
        }
      }
    }
    const key = `${SCHEMA_PREFIX}${highest + 1}`;
    const client = randomClient(c => doc.store.clients.has(c));
    let update: Uint8Array | null = null;
    doc.once('update', (u: Uint8Array) => {
      update = u;
    });
    doc.clientID = client;
    doc.transact(() => {
      yroot.setAttr(key, true);
    });
    return {client, clock: 0, key, root, update: update!};
  } finally {
    doc.destroy();
  }
}

/** An item's content values (through AbstractContent's reader). */
const contentOf = (it: Item): unknown[] => {
  const content: Item['content'] = it.content;
  return content.getContent();
};

/**
 * What a signal's id holds in `doc`: the signal itself (same parent, key
 * and content), another item (`'collision'`: the replica's own), or
 * nothing.
 */
function signalAt(
  doc: Doc,
  signal: YLegacySignal,
): 'signal' | 'collision' | 'none' {
  const structs = doc.store.clients.get(signal.client);
  if (structs === undefined) {
    return 'none';
  }
  for (const s of structs) {
    if (s.id.clock <= signal.clock && signal.clock < s.id.clock + s.length) {
      if (
        s instanceof Item &&
        s.id.clock === signal.clock &&
        s.length === 1 &&
        s.parent === existingRoot(doc, signal.root) &&
        s.parentSub === signal.key &&
        s.content instanceof ContentAny &&
        contentOf(s)[0] === true
      ) {
        return 'signal';
      }
      return 'collision';
    }
  }
  return 'none';
}

/** @experimental Where a quarantine record's material came from (null: unknown). */
export interface YRecordSource {
  readonly incarnation: string | null;
  readonly generation: string | null;
  /** The layouts the source's release reads (`[MIN_LAYOUT, LAYOUT_VERSION]`). */
  readonly layouts: readonly [number, number] | null;
  readonly schemaVersion: number | null;
  /** The app's renderer (a release name) that can show the source. */
  readonly renderer: string | null;
}

/**
 * @experimental What the editor held that could not be committed (see
 * `binding.quiesce()`): its state as JSON, and whether it differs from the
 * document's own read.
 */
export interface YDraft {
  readonly json: unknown;
  readonly differs: boolean;
}

/** @experimental A per-document quarantine record (append-only). */
export interface YQuarantineRecord {
  /** The record's id: its hash unless given. */
  readonly id: string;
  readonly session: string | null;
  readonly replica: string | null;
  readonly kind: 'handoff' | 'capture' | 'pending';
  /**
   * Whether any channel other than the authority could have delivered
   * updates to the replica since its last sync with the authority (a
   * property of the material's history, persisted with the replica's
   * partition; unknown is true). A replica with peers can hold a deletion
   * the authority never saw.
   */
  readonly peers: boolean;
  /**
   * Every client id the replica wrote under since its last sync with the
   * authority (persisted with its partition; ids Yjs switched to after a
   * collision and those of writers sharing its document included). What
   * the replica wrote under another id is not proved its own.
   */
  readonly clients: readonly number[];
  readonly source: YRecordSource;
  /** The replica's whole document (V1), standalone. */
  readonly snapshot: Uint8Array | null;
  /** Later updates of a captured session. */
  readonly deltas: readonly Uint8Array[];
  /** The replica's queue of unsent updates. */
  readonly queue: readonly Uint8Array[];
  readonly draft: YDraft | null;
  /** The generation of the base it can be compared with, null: none. */
  readonly base: string | null;
  /**
   * Legacy signals the authority built for this session (exact payloads):
   * their items are ignored where id, parent, key and content all match.
   */
  readonly signals: readonly YLegacySignal[];
  /** Signals whose id holds other content (the replica's own): kept. */
  readonly collisions: readonly YLegacySignal[];
  readonly receivedAt: number;
  /**
   * A hash of the record's kind, material (snapshot, deltas, queue, draft)
   * and provenance (peers, clients): what an acknowledgement names. The
   * source, session, replica and times are not in it.
   */
  readonly hash: string;
  /** Whether the source view has every dependency (see sourceView). */
  readonly complete: boolean;
  /** Whether it holds anything new (see hasNewYEdits); true when unknown. */
  readonly actionable: boolean;
}

/** @experimental The input of quarantineRecord. */
export interface YQuarantineRecordInput {
  readonly id?: string;
  readonly session?: string | null;
  readonly replica?: string | null;
  readonly kind: YQuarantineRecord['kind'];
  /** Default true (unknown provenance). */
  readonly peers?: boolean;
  /** Default none; kept once each, in order. */
  readonly clients?: readonly number[];
  readonly source: YRecordSource;
  readonly snapshot?: Uint8Array | null;
  readonly deltas?: readonly Uint8Array[];
  readonly queue?: readonly Uint8Array[];
  readonly draft?: YDraft | null;
  readonly signals?: readonly YLegacySignal[];
  readonly receivedAt: number;
}

/** FNV-1a 32 over `bytes`, continuing `h`. */
function fnv(h: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
  }
  return h;
}

/** UTF-8 bytes of `text`. */
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * A 64-bit hash (two FNV-1a 32) of a record's material, in hex: each part
 * length-prefixed, so different splits of the same bytes differ.
 */
function materialHash(parts: readonly Uint8Array[]): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (const part of parts) {
    const len = utf8(`${part.length}:`);
    a = fnv(fnv(a, len), part);
    b = fnv(fnv(b, len), part);
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

type RecordMaterial = Pick<
  YQuarantineRecord,
  'snapshot' | 'deltas' | 'queue' | 'signals'
>;

/**
 * @experimental A record's source view: its snapshot, deltas and queue
 * applied, idempotently, into one scratch document (never stored, sent or
 * merged; destroy it when done). `complete`: no update in it lacks a
 * dependency (no pending material, no skipped range). What actionability,
 * rendering, export and replay read.
 */
export function sourceView(
  record: Pick<YQuarantineRecord, 'snapshot' | 'deltas' | 'queue'>,
): {doc: Doc; complete: boolean} {
  const doc = createYDoc(null, {gc: false});
  for (const part of [
    ...(record.snapshot === null ? [] : [record.snapshot]),
    ...record.deltas,
    ...record.queue,
  ]) {
    applyUpdate(doc, part);
  }
  const store = doc.store;
  return {
    complete:
      store.pendingStructs === null &&
      store.pendingDs === null &&
      store.skips.isEmpty(),
    doc,
  };
}

/**
 * @experimental Build a quarantine record: its hash (of the kind, snapshot,
 * deltas, queue and draft), whether its source view is complete, and, when
 * `base` is given (the state of the base generation), whether it holds
 * anything new (hasNewYEdits; without a base, it counts as actionable).
 */
export function quarantineRecord(
  input: YQuarantineRecordInput,
  base: {readonly generation: string; readonly state: Uint8Array} | null = null,
): YQuarantineRecord {
  const snapshot = input.snapshot ?? null;
  const deltas = input.deltas ?? [];
  const queue = input.queue ?? [];
  const draft = input.draft ?? null;
  const signals = input.signals ?? [];
  const peers = input.peers ?? true;
  // Canonical: each id once, in order.
  const clients = [...new Set(input.clients ?? [])].sort((a, b) => a - b);
  const hash = materialHash([
    utf8(input.kind),
    snapshot ?? new Uint8Array(0),
    ...deltas,
    utf8('|'),
    ...queue,
    utf8(
      draft === null ? '' : `${draft.differs}:${JSON.stringify(draft.json)}`,
    ),
    // The provenance decides how the material may be read (see peers and
    // clients): two histories with the same bytes are two records.
    utf8(`${peers ? 1 : 0}:${clients.join(',')}`),
  ]);
  const view = sourceView({deltas, queue, snapshot});
  const collisions = signals.filter(
    sg => signalAt(view.doc, sg) === 'collision',
  );
  view.doc.destroy();
  const record: YQuarantineRecord = {
    actionable: true,
    base: base === null ? null : base.generation,
    clients,
    collisions,
    complete: view.complete,
    deltas,
    draft,
    hash,
    id: input.id ?? hash,
    kind: input.kind,
    peers,
    queue,
    receivedAt: input.receivedAt,
    replica: input.replica ?? null,
    session: input.session ?? null,
    signals,
    snapshot,
    source: input.source,
  };
  return base === null
    ? record
    : {...record, actionable: hasNewYEdits(record, base.state)};
}

/**
 * @experimental The quarantine record of a migration's `pending` material
 * (prepareYRoom's or migrateYState's), stored atomically with the migrated
 * state: kind `'pending'`, its snapshot the whole stored state it was split
 * from (which still holds every cut item and what they depend on) and its
 * queue the split bytes, so its source view renders the cut material in
 * place, and a raw export of the record carries both. The stored state may
 * itself lack updates (a skipped range): the record is then incomplete
 * until they arrive (append them as deltas). `base`, as for
 * quarantineRecord: the migrated state, which lacks the cut items.
 */
export function pendingYRecord(
  input: {
    readonly id?: string;
    /** The stored state the material was split from. */
    readonly stored: Uint8Array;
    /** The split material (`pending`). */
    readonly pending: Uint8Array;
    readonly source: YRecordSource;
    readonly receivedAt: number;
  },
  base: {readonly generation: string; readonly state: Uint8Array} | null = null,
): YQuarantineRecord {
  return quarantineRecord(
    {
      id: input.id,
      kind: 'pending',
      queue: [input.pending],
      receivedAt: input.receivedAt,
      snapshot: input.stored,
      source: input.source,
    },
    base,
  );
}

/**
 * @experimental Whether a quarantine record holds anything `base` (the
 * state of the generation it was made against) lacks, read from its source
 * view (Yjs only, no Lexical): a struct the base lacks (not a legacy
 * signal's own item), a deletion of an item the base holds live, a draft the
 * client marked `differs`, or an incomplete view (a missing dependency: it
 * cannot be shown to hold nothing). Only then should an app prompt; every
 * record stays listable.
 */
export function hasNewYEdits(
  record: RecordMaterial & Pick<YQuarantineRecord, 'draft'>,
  base: Uint8Array,
): boolean {
  if (record.draft !== null && record.draft.differs) {
    return true;
  }
  const view = sourceView(record);
  const was = createYDoc(base, {gc: false});
  try {
    if (!view.complete) {
      return true;
    }
    // The signals' own items (exact matches) are the authority's, not the
    // replica's.
    const ignored = new Set<string>();
    for (const sg of record.signals) {
      if (signalAt(view.doc, sg) === 'signal') {
        ignored.add(`${sg.client}.${sg.clock}`);
      }
    }
    // An incomplete base (a skipped range or pending material): what the
    // record holds cannot be told apart from what the base lacks.
    if (!isWhole(was)) {
      return true;
    }
    for (const [client, structs] of view.doc.store.clients) {
      for (const s of structs) {
        // A struct the base lacks (an item; a GC struct is content made and
        // removed while apart, which shows nothing; a skip is not held).
        if (
          s instanceof Item &&
          !(s.length === 1 && ignored.has(`${client}.${s.id.clock}`)) &&
          !holdsRange(was, client, s.id.clock, s.length)
        ) {
          return true;
        }
      }
    }
    // A deletion (a deleted item or a GC struct) of an item the base holds
    // live, for ids both hold.
    for (const [client, structs] of view.doc.store.clients) {
      for (const s of structs) {
        if (s instanceof Skip || (s instanceof Item && !s.deleted)) {
          continue;
        }
        if (liveIn(was, client, s.id.clock, s.length)) {
          return true;
        }
      }
    }
    return false;
  } finally {
    was.destroy();
    view.doc.destroy();
  }
}

/** Whether `doc` holds no skipped range and no pending material. */
function isWhole(doc: Doc): boolean {
  const store = doc.store;
  return (
    store.skips.isEmpty() &&
    store.pendingStructs === null &&
    store.pendingDs === null
  );
}

/** A struct of a document's store (an item, a GC struct or a skip). */
type Struct = NonNullable<ReturnType<Doc['store']['clients']['get']>>[number];

/**
 * The struct of `doc` holding `client`'s `clock` (a skip holds nothing),
 * or null.
 */
function structAt(doc: Doc, client: number, clock: number): Struct | null {
  const structs = doc.store.clients.get(client);
  if (structs === undefined || structs.length === 0) {
    return null;
  }
  const last = structs[structs.length - 1];
  if (clock < structs[0].id.clock || clock >= last.id.clock + last.length) {
    return null;
  }
  const s = structs[findIndexSS(structs, clock)];
  return s instanceof Skip ? null : s;
}

/** Whether `doc` holds every id of `client` from `clock`, `length` of them. */
function holdsRange(
  doc: Doc,
  client: number,
  clock: number,
  length: number,
): boolean {
  for (let k = clock; k < clock + length; ) {
    const s = structAt(doc, client, k);
    if (s === null) {
      return false;
    }
    k = s.id.clock + s.length;
  }
  return true;
}

/**
 * Whether `doc` holds, live, an item at one of `client`'s ids from `clock`,
 * `length` of them (ids it does not hold are skipped). Walks `doc`'s own
 * structs over that range, never the missing clocks one by one.
 */
function liveIn(
  doc: Doc,
  client: number,
  clock: number,
  length: number,
): boolean {
  const structs = doc.store.clients.get(client);
  if (structs === undefined || structs.length === 0) {
    return false;
  }
  const last = structs[structs.length - 1];
  const from = Math.max(clock, structs[0].id.clock);
  const to = Math.min(clock + length, last.id.clock + last.length);
  if (from >= to) {
    return false;
  }
  for (let i = findIndexSS(structs, from); i < structs.length; i++) {
    const s = structs[i];
    if (s.id.clock >= to) {
      break;
    }
    if (s instanceof Item && !s.deleted) {
      return true;
    }
  }
  return false;
}

/**
 * @internal NOT IMPLEMENTED YET, and not exported: the replay of a
 * quarantine record's own changes onto the current document, at the
 * authority, as a checked edit (design: the three-way replay). Throws.
 */
export function replayYRecovery(
  _record: YQuarantineRecord,
  _base: Uint8Array,
  _current: Doc,
  _config?: unknown,
): never {
  throw new Error('@lexical/y: replayYRecovery is not implemented yet');
}
