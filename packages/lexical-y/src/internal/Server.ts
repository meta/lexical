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
import {
  epochRecordOf,
  existingRoot,
  layoutRecordOf,
  readRequirements,
  SUPPORTED_FEATURES,
} from './Layouts';
import {integrateHeldBehindGaps} from './LoadFully';
import {createRawYDoc, type YDoc, type YDocOptions} from './RawYDoc';
import {canonicalJSON, Sha256} from './RecordHash';
import {PUBLISHED_STEPS} from './StepTable';
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
 * @experimental The generation of a document's state over the roots an
 * authority serves, by version 1 of the algorithm (frozen):
 * `'g1:' + JSON.stringify([incarnation, entries])`, where `entries` has one
 * `[root, transition]` pair per served root (every one, sorted by code units,
 * each once): `transition` is the `[client, clock]` of the root's epoch (the
 * identity of the transition that last migrated it), or null when it has
 * none. The epoch's layout and other fields are not part of it. A served
 * root whose epoch is malformed has no generation: the result is then
 * UNKNOWN_GENERATION, which never matches (fail closed). `incarnation` is
 * the room's (a new one on every recreation, restore and fresh-document
 * migration), so a copy from an earlier incarnation never matches.
 * Opaque: compare and persist it; never parse it (carry the incarnation
 * explicitly where it is needed).
 */
export function getYGeneration(
  doc: Doc,
  incarnation: string,
  roots: readonly string[] = [DEFAULT_ROOT_NAME],
): string {
  const entries: [string, [number, number] | null][] = [];
  for (const name of [...new Set(roots)].sort()) {
    const root = existingRoot(doc, name);
    const record = root === null ? null : epochRecordOf(root);
    if (record !== null && record.kind === 'malformed') {
      return UNKNOWN_GENERATION;
    }
    entries.push([
      name,
      record !== null && record.kind === 'epoch'
        ? [record.epoch.client, record.epoch.clock]
        : null,
    ]);
  }
  return `g1:${JSON.stringify([incarnation, entries])}`;
}

/** @experimental Options of prepareYRoom. */
export interface YPrepareRoomOptions {
  /**
   * The steps the authority runs (default: every published step,
   * statically imported with the server entry).
   */
  readonly steps?: readonly YLayoutMigration[];
  /** The room's incarnation (see getYGeneration). */
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
  /** Its generation (see getYGeneration). */
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
  const result = migrateYState(stored, options.steps ?? PUBLISHED_STEPS, {
    clientID: options.clientID,
    clientIDRange: options.clientIDRange,
    gc,
    roots,
    to: options.to ?? MIN_LAYOUT,
  });
  const generation = (state: Uint8Array) => {
    const doc = createYDoc(state, {gc});
    try {
      return getYGeneration(doc, options.incarnation, roots);
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

/**
 * @experimental A generation that never matches: a replica's material with
 * no recorded generation (from before the fence), or a state whose served
 * root has a malformed epoch (see getYGeneration).
 */
export const UNKNOWN_GENERATION = 'unknown';

/**
 * @experimental What a client sends before any sync message (version 1):
 * the generation its replica's material was made against (null: none,
 * `'unknown'`: material without a recorded generation), whether it holds
 * material (unsent edits or a cached state), the layouts its release reads
 * (`[MIN_LAYOUT, LAYOUT_VERSION]`), the layout its seed records
 * (`SEED_LAYOUT`) and the features it implements (see YRoomDescription's
 * `requires`; default none). `v` is required: a handshake without it, or
 * with another version, is malformed (refuse-layout); no handshake at all
 * (null) is the legacy route. Unknown fields are ignored: a later version
 * that needs new semantics negotiates them with a feature or a new `v`.
 */
export interface YSessionHandshake {
  readonly v: 1;
  readonly generation: string | null;
  readonly material: boolean;
  readonly layouts: readonly [number, number];
  readonly seed: number;
  readonly features?: readonly string[];
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
   * malformed), with a malformed epoch or with a malformed requirement: no
   * client reads them.
   */
  readonly unreadable: readonly string[];
  /**
   * The room's seed contract: the SEED_LAYOUT its incarnation was issued
   * under. An authority whose own SEED_LAYOUT differs replaces a pristine
   * room's incarnation before it admits anyone (see needsNewIncarnation).
   */
  readonly seedContract: number;
  /**
   * The features the served roots require (`lexical-y-require:<feature>`
   * set to true), sorted by code units, each once. A client must present
   * every one of them (see checkYSession). A malformed requirement makes
   * its root unreadable instead.
   */
  readonly requires: readonly string[];
  /**
   * Whether a served root records an epoch (a migration ran on it), or a
   * malformed one: a client from before the fence is then never admitted.
   */
  readonly hasMigration: boolean;
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
  const requires = new Set<string>();
  let hasMigration = false;
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
    const epoch = epochRecordOf(root);
    if (epoch.kind !== 'none') {
      hasMigration = true;
    }
    // Every well-formed requirement, whether this server supports the
    // feature or not: a session must present it (checkYSession).
    const requirements = readRequirements(root);
    for (const feature of requirements.required) {
      requires.add(feature);
    }
    if (
      record.kind === 'layout' &&
      epoch.kind !== 'malformed' &&
      requirements.malformed.length === 0
    ) {
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
    generation: getYGeneration(doc, options.incarnation, roots),
    hasMigration,
    incarnation: options.incarnation,
    inherited: options.inherited,
    layouts,
    pristine,
    requires: [...requires].sort(),
    seedContract: options.seedContract,
    unreadable,
  };
}

/**
 * @internal Whether an authority whose SEED_LAYOUT is `seedLayout` must
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

/**
 * @experimental checkYSession's verdict (y-server.md, the handshake table).
 * The five verdicts are permanent. `reason` is an optional explanation for
 * logs and diagnostics (open: new reasons may be added; never branch on
 * it): `'malformed-handshake'`, `'generation'`, `'layout'`, `'seed'`,
 * `'requires'`, `'unreadable'`, `'migrated'`, `'not-inherited'`.
 */
export type YSessionVerdict =
  /**
   * Sync both ways. `initialize`: the room is pristine and the client may
   * seed it.
   */
  | {
      readonly verdict: 'admit';
      readonly initialize: boolean;
      readonly reason?: string;
    }
  /**
   * A replica without material: load the room's state into a new document,
   * persist it with the generation, then bind. `initialize`: the room is
   * pristine and the client may seed it.
   */
  | {
      readonly verdict: 'bootstrap';
      readonly initialize: boolean;
      readonly reason?: string;
    }
  /**
   * A replica with material that may not sync with this room: no sync
   * either way; it hands its material off (recovery handoff) and connects
   * again once acknowledged, without material.
   */
  | {readonly verdict: 'stale'; readonly reason?: string}
  /**
   * The client cannot read, seed or meet the requirements of the room:
   * reload to another release.
   */
  | {readonly verdict: 'refuse-layout'; readonly reason?: string}
  /** No handshake on a room it may not join: capture (createYSessionCapture). */
  | {readonly verdict: 'legacy'; readonly reason?: string};

/** Whether `value` is a well-formed YSessionHandshake (version 1). */
function isHandshake(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const h = value as Record<string, unknown>;
  const layout = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 1;
  const layouts = h.layouts;
  const features = h.features;
  return (
    h.v === 1 &&
    (features === undefined ||
      (Array.isArray(features) &&
        features.every(f => typeof f === 'string'))) &&
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
 *    today when the room's incarnation is inherited, it never migrated (no
 *    epoch, `hasMigration` false) or was replaced (a new incarnation is
 *    never inherited), it requires no feature and every served root is
 *    readable; otherwise legacy.
 * 2. A handshake that is not well formed (it arrives from the network: no
 *    `v` or another version, `features` that are not strings, a generation
 *    that is neither a string nor null, a non-boolean material, layouts
 *    that are not two layouts from 1 in order, a seed that is not a
 *    layout): refuse-layout.
 * 3. Material, and any of: another generation (another token, unknown or
 *    null), a served root's layout outside the client's `layouts` (or a
 *    served root that is unreadable), a pristine room whose seed contract
 *    is not the client's `seed`, a required feature the client does not
 *    present: stale. No client holding material is refused before its
 *    material is acknowledged.
 * 4. A served root's layout outside `layouts`, or an unreadable root:
 *    refuse-layout.
 * 5. A required feature the client does not present: refuse-layout.
 * 6. A pristine room whose seed contract is not `seed`: refuse-layout.
 * 7. The room's generation: admit (`initialize` in a pristine room).
 * 8. No material: bootstrap (`initialize` in a pristine room).
 * Never sync a session whose verdict is not `'admit'`, and check every
 * update again at commit against the room's current generation.
 */
export function checkYSession(
  room: YRoomDescription,
  client: YSessionHandshake | null,
): YSessionVerdict {
  if (client === null) {
    if (!room.inherited) {
      return {reason: 'not-inherited', verdict: 'legacy'};
    }
    if (room.hasMigration) {
      return {reason: 'migrated', verdict: 'legacy'};
    }
    if (room.requires.length > 0) {
      return {reason: 'requires', verdict: 'legacy'};
    }
    if (room.unreadable.length > 0) {
      return {reason: 'unreadable', verdict: 'legacy'};
    }
    return {initialize: false, verdict: 'admit'};
  }
  if (!isHandshake(client)) {
    return {reason: 'malformed-handshake', verdict: 'refuse-layout'};
  }
  const same =
    client.generation !== null &&
    client.generation !== UNKNOWN_GENERATION &&
    room.generation !== UNKNOWN_GENERATION &&
    client.generation === room.generation;
  // Every served root inside the client's range.
  const [min, max] = client.layouts;
  const readable =
    room.unreadable.length === 0 &&
    (room.layouts === null ||
      (room.layouts[0] >= min && room.layouts[1] <= max));
  const features = new Set(client.features ?? []);
  const featured = room.requires.every(f => features.has(f));
  const seedable = !room.pristine || client.seed === room.seedContract;
  // Why a session may not join, in the order the rows test it.
  const refusal = !readable
    ? room.unreadable.length > 0
      ? 'unreadable'
      : 'layout'
    : !featured
      ? 'requires'
      : !seedable
        ? 'seed'
        : null;
  if (client.material && (!same || refusal !== null)) {
    return {reason: refusal ?? 'generation', verdict: 'stale'};
  }
  if (refusal !== null) {
    return {reason: refusal, verdict: 'refuse-layout'};
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

/** @experimental What a legacy capture sends and keeps (see createYSessionCapture). */
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
  /**
   * The material kept so far (version 1, copies): persist it as it is to
   * resume the capture later (createYSessionCapture's `resume`), or build
   * the session's record from it (createYQuarantineRecord).
   */
  material(): YSessionCaptureMaterial;
}

/**
 * @experimental A legacy capture's material, version 1: the session's
 * standalone snapshot (null until its sync step 2 arrives), its later
 * updates and the signals sent to it, all Yjs update format V1. Persist it
 * whole, `v` and `updateFormat` included: a capture resumes only material
 * of a version and format it reads, and leaves any other untouched.
 */
export interface YSessionCaptureMaterial {
  readonly v: 1;
  readonly updateFormat: 'yjs-v1';
  readonly snapshot: Uint8Array | null;
  readonly deltas: readonly Uint8Array[];
  readonly signals: readonly YLegacySignal[];
}

/**
 * @experimental The legacy capture (a session with no handshake on a room
 * it may not join): the authority answers its sync step 1 with an empty
 * sync step 2 and sends its own sync step 1 with an empty state vector, so
 * the client's sync step 2 is its whole document, a standalone snapshot
 * never merged with anything the authority holds; later updates are kept
 * as deltas. Build a record from `material()` with createYQuarantineRecord.
 * `resume`: the material (`material()`) an earlier capture of the same
 * session kept, for an authority that persists it between messages (a
 * hibernating Durable Object); the capture continues from it (its signals
 * included). Material of another version or update format is refused with
 * a TypeError before any of it is read, and left as it is (keep it, export
 * it raw).
 */
export function createYSessionCapture(
  resume: YSessionCaptureMaterial | null = null,
): YSessionCapture {
  if (resume != null) {
    const r = resume as unknown as Record<string, unknown>;
    if (r.v !== 1 || r.updateFormat !== 'yjs-v1') {
      throw new TypeError(
        `@lexical/y: cannot resume capture material of version ${String(r.v)}, update format ${String(r.updateFormat)} (this release reads version 1, 'yjs-v1')`,
      );
    }
  }
  // The capture keeps copies of what it is given and hands out copies.
  let snapshot: Uint8Array | null =
    resume == null || resume.snapshot === null
      ? null
      : copyBytes(resume.snapshot);
  const deltas: Uint8Array[] =
    resume == null ? [] : (resume.deltas ?? []).map(copyBytes);
  const signals: YLegacySignal[] =
    resume == null ? [] : (resume.signals ?? []).map(copySignal);
  const material = (): YSessionCaptureMaterial => ({
    deltas: deltas.map(copyBytes),
    signals: signals.map(copySignal),
    snapshot: snapshot === null ? null : copyBytes(snapshot),
    updateFormat: 'yjs-v1',
    v: 1,
  });
  return {
    add(update: Uint8Array): void {
      if (snapshot === null) {
        snapshot = copyBytes(update);
      } else {
        deltas.push(copyBytes(update));
      }
    },
    collisions(): YLegacySignal[] {
      const view = assembleV1({deltas, queue: [], snapshot});
      try {
        return signals
          .filter(sg => signalAt(view.doc, sg) === 'collision')
          .map(copySignal);
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
      const view = assembleV1({deltas, queue: [], snapshot});
      try {
        const signal = legacySignal(
          encodeStateAsUpdate(view.doc),
          supportedSchema,
          root,
        );
        signals.push(signal);
        return copySignal(signal);
      } finally {
        view.doc.destroy();
      }
    },
    syncStep1: emptyStateVector(),
    syncStep2: emptyUpdate(),
  };
}

/**
 * A copy of `bytes` in fresh storage. Not `.slice()`: a Node `Buffer`'s
 * slice shares its storage, so a later write to the caller's Buffer would
 * reach the copy.
 */
function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/** A copy of a legacy signal (its update's bytes included). */
function copySignal(sg: YLegacySignal): YLegacySignal {
  return {
    client: sg.client,
    clock: sg.clock,
    key: sg.key,
    root: sg.root,
    update: copyBytes(sg.update),
  };
}

/** A deep copy of a record's source (fields it does not know included). */
function copySource(source: YRecordSource): YRecordSource {
  // A deep copy, fields this release does not know included (a source is
  // JSON; canonical JSON refuses anything else, as the hash does).
  return JSON.parse(canonicalJSON(source)) as YRecordSource;
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
 * @internal The update that turns a client from before the fence read
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

/**
 * @experimental What a record holds: a stale replica's handoff, a legacy
 * session's capture, or a migration's pending material. Open: a later
 * release may add kinds; a record of a kind this release does not know is
 * kept and exported as it is (preservation only), never read, replayed or
 * judged as one it knows.
 */
export type YQuarantineRecordKind =
  | 'handoff'
  | 'capture'
  | 'pending'
  // Any other string: a kind from a later release (keeps completion).
  | (string & {});

/** The record kinds this release reads. */
const KNOWN_KINDS: ReadonlySet<string> = new Set([
  'handoff',
  'capture',
  'pending',
]);

/**
 * @experimental A per-document quarantine record (version 1; the room's
 * records are append-only).
 */
export interface YQuarantineRecord {
  /** The record format's version. */
  readonly v: 1;
  /**
   * The encoding of `snapshot`, `deltas`, `queue` and signal updates: Yjs
   * update format V1.
   */
  readonly updateFormat: 'yjs-v1';
  /** The record's id: its hash unless given. */
  readonly id: string;
  readonly session: string | null;
  readonly replica: string | null;
  readonly kind: YQuarantineRecordKind;
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
   * Features its material needs to be read (see YRoomDescription's
   * `requires`), sorted by code units, each once; none by default. A record
   * that requires a feature this release does not know is kept and
   * exported as it is, never read as one it knows.
   */
  readonly requires: readonly string[];
  /**
   * The hash of the record's canonical payload, version 1:
   * `'yr1-sha256:'` and the lowercase hex SHA-256 of its kind, source
   * (provenance, incarnation and generation included), peers, clients,
   * snapshot, deltas, queue, draft (canonical JSON, keys sorted), signal
   * transcripts, requirements and format (see y-server.md, "Records"). Not in
   * it: the id, session, replica, times and what the server derives
   * (`base`, `complete`, `actionable`, `collisions`). Equal hashes are not
   * proof of equal records: confirm the exact payload before discarding
   * either. An acknowledgement names it within its scope (see
   * YRecordAcknowledgement).
   */
  readonly hash: string;
  /** Whether the source view has every dependency (see sourceView). */
  readonly complete: boolean;
  /** Whether it holds anything new (see hasNewYEdits); true when unknown. */
  readonly actionable: boolean;
}

/**
 * @experimental The input of createYQuarantineRecord: a record's material
 * as a replica or a capture handed it over.
 */
export interface YQuarantineRecordInput {
  /**
   * The material's version and update format, when it carries them (a
   * capture's material does): only version 1, `'yjs-v1'`, is accepted, so
   * material of another format is never stamped as version 1.
   */
  readonly v?: 1;
  readonly updateFormat?: 'yjs-v1';
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
  /** Default none; kept once each, sorted. */
  readonly requires?: readonly string[];
  readonly receivedAt: number;
}

/**
 * @experimental The input of createYQuarantineRecord for a migration's
 * `pending` material (`stored` and `pending` are reserved for this form: it
 * is taken only for kind `'pending'` with both present as bytes; any other
 * kind ignores them). The form is exclusive: beside them it takes only
 * `id`, `source`, `receivedAt` and the header; any field of the material
 * form (a draft, `requires`, signals, `peers`, `clients`, a session or
 * replica, other material) is refused: give such a record in the material
 * form (prepareYRoom's or migrateYState's), stored atomically
 * with the migrated state: the record's kind is `'pending'`, its snapshot
 * the whole stored state the material was split from (which still holds
 * every cut item and what they depend on) and its queue the split bytes, so
 * its source view renders the cut material in place and a raw export
 * carries both. The stored state may itself lack updates (a skipped range):
 * the record is then incomplete until they arrive (append them as deltas).
 * Its base is the migrated state, which lacks the cut items.
 */
export interface YPendingRecordInput {
  /** As YQuarantineRecordInput's: absent, or version 1, `'yjs-v1'`. */
  readonly v?: 1;
  readonly updateFormat?: 'yjs-v1';
  readonly kind: 'pending';
  readonly id?: string;
  /** The stored state the material was split from. */
  readonly stored: Uint8Array;
  /** The split material (`pending`). */
  readonly pending: Uint8Array;
  readonly source: YRecordSource;
  readonly receivedAt: number;
}

/**
 * @experimental The durable acknowledgement of one record, version 1: the
 * server holds it only once the record is stored durably. It acknowledges
 * exactly the uploaded payload, in its scope: the room, the replica that
 * uploaded it, the generation its material was made against
 * (`source.generation`, `'unknown'` when none), the record's id and hash. A
 * replica drops its material only for an acknowledgement whose every field
 * matches what it uploaded; a bare hash, or one from another room, replica
 * or generation, acknowledges nothing, and an acknowledgement of an unknown
 * version keeps the material.
 */
export interface YRecordAcknowledgement {
  readonly v: 1;
  readonly room: string;
  readonly replica: string;
  readonly sourceGeneration: string;
  readonly record: string;
  readonly hash: string;
}

/** UTF-8 bytes of `text`. */
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The tag of a version 1 record hash: payload encoding 1, SHA-256. */
const RECORD_HASH_TAG = 'yr1-sha256:';

/**
 * The hash of a record's canonical payload, version 1: SHA-256 over
 * `'lexical-y-record:1\n'`, the header's UTF-8 length (4 bytes, big endian),
 * the header (canonical JSON of the record's kind, source, peers, clients,
 * draft, requirements, format, version, signal transcripts and the length of
 * every byte part) and then the byte parts in the header's order: snapshot,
 * deltas, queue, signal updates. Frozen.
 */
function recordHash(record: {
  readonly kind: string;
  readonly source: YRecordSource;
  readonly peers: boolean;
  readonly clients: readonly number[];
  readonly snapshot: Uint8Array | null;
  readonly deltas: readonly Uint8Array[];
  readonly queue: readonly Uint8Array[];
  readonly draft: YDraft | null;
  readonly signals: readonly YLegacySignal[];
  readonly requires: readonly string[];
}): string {
  const header = utf8(
    canonicalJSON({
      clients: record.clients,
      deltas: record.deltas.map(d => d.length),
      draft:
        record.draft === null
          ? null
          : {differs: record.draft.differs, json: record.draft.json},
      kind: record.kind,
      peers: record.peers,
      queue: record.queue.map(q => q.length),
      requires: record.requires,
      signals: record.signals.map(sg => ({
        client: sg.client,
        clock: sg.clock,
        key: sg.key,
        root: sg.root,
        update: sg.update.length,
      })),
      snapshot: record.snapshot === null ? null : record.snapshot.length,
      source: record.source,
      updateFormat: 'yjs-v1',
      v: 1,
    }),
  );
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, header.length);
  const hash = new Sha256()
    .update(utf8('lexical-y-record:1\n'))
    .update(size)
    .update(header);
  if (record.snapshot !== null) {
    hash.update(record.snapshot);
  }
  for (const part of [
    ...record.deltas,
    ...record.queue,
    ...record.signals.map(sg => sg.update),
  ]) {
    hash.update(part);
  }
  return RECORD_HASH_TAG + hash.hex();
}

type RecordMaterial = Pick<
  YQuarantineRecord,
  'snapshot' | 'deltas' | 'queue' | 'signals'
>;

/**
 * Whether this release reads a record with this header: version 1, update
 * format `'yjs-v1'`, a kind it knows (`'handoff'`, `'capture'`, `'pending'`)
 * and only features it supports. Any other record is kept and exported as
 * it is, never decoded or replayed as one it reads.
 */
function isSupportedRecord(header: {
  readonly v: unknown;
  readonly updateFormat: unknown;
  readonly kind: unknown;
  readonly requires: readonly unknown[];
}): boolean {
  return (
    header.v === 1 &&
    header.updateFormat === 'yjs-v1' &&
    typeof header.kind === 'string' &&
    KNOWN_KINDS.has(header.kind) &&
    header.requires.every(
      f => typeof f === 'string' && SUPPORTED_FEATURES.has(f),
    )
  );
}

/**
 * Version 1 material (Yjs update format V1) applied, idempotently, into one
 * scratch document. Callers have checked the version and format.
 */
function assembleV1(material: {
  readonly snapshot: Uint8Array | null;
  readonly deltas: readonly Uint8Array[];
  readonly queue: readonly Uint8Array[];
}): {doc: Doc; complete: boolean} {
  const doc = createYDoc(null, {gc: false});
  try {
    for (const part of [
      ...(material.snapshot === null ? [] : [material.snapshot]),
      ...material.deltas,
      ...material.queue,
    ]) {
      applyUpdate(doc, part);
    }
    // What the parts hold pending behind a blocked struct and the replica
    // that wrote them showed (see LoadFully): its source view, completeness
    // and collisions see the repaired document. A struct still pending
    // leaves the record incomplete.
    integrateHeldBehindGaps(doc);
  } catch (e) {
    // Malformed material (truncated or not an update): no scratch document
    // is left behind.
    doc.destroy();
    throw e;
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
 * @experimental A record's source view: its snapshot, deltas and queue
 * applied, idempotently, into one scratch document (never stored, sent or
 * merged; destroy it when done). `complete`: no update in it lacks a
 * dependency (no pending material, no skipped range). What rendering,
 * export of a readable form and replay read. It takes the record (or its
 * header and material: `v`, `updateFormat`, `kind`, `requires`) and reads
 * only a record this release reads: version 1, update format `'yjs-v1'`,
 * a kind it knows and no feature it does not support. Any other record is
 * refused with a TypeError before any of its bytes are applied: keep it
 * and export it raw.
 */
export function sourceView(
  record: Pick<
    YQuarantineRecord,
    'v' | 'updateFormat' | 'kind' | 'requires' | 'snapshot' | 'deltas' | 'queue'
  >,
): {doc: Doc; complete: boolean} {
  const r = record as unknown as Record<string, unknown>;
  if (
    !Array.isArray(r.requires) ||
    !isSupportedRecord({
      kind: r.kind,
      requires: r.requires,
      updateFormat: r.updateFormat,
      v: r.v,
    })
  ) {
    throw new TypeError(
      `@lexical/y: cannot read a record of version ${String(r.v)}, update format ${String(r.updateFormat)}, kind ${String(r.kind)}, requiring ${JSON.stringify(r.requires)}: keep it and export it raw`,
    );
  }
  return assembleV1(record);
}

/**
 * @experimental Build a quarantine record (version 1), from a replica's or
 * a capture's material (YQuarantineRecordInput) or from a migration's
 * pending material (YPendingRecordInput): its hash (of its canonical
 * payload, see YQuarantineRecord's `hash`), whether its source view is
 * complete, and, when `base` is given (the state of the base generation),
 * whether it holds anything new (a struct or a deletion the base lacks, a
 * draft marked `differs`, or a missing dependency; without a base, or when
 * it requires a feature, it counts as actionable). Throws a TypeError when
 * the draft is not JSON: keep the material and report it.
 */
export function createYQuarantineRecord(
  input: YQuarantineRecordInput | YPendingRecordInput,
  base: {readonly generation: string; readonly state: Uint8Array} | null = null,
): YQuarantineRecord {
  // The header first, on the caller's own input, before either form reads
  // anything: a supplied unsupported version or format is never restamped.
  checkRecordHeader(input);
  const pending = pendingForm(input);
  return pending === null
    ? materialRecord(input as YQuarantineRecordInput, base)
    : materialRecord(
        {
          id: pending.id,
          kind: 'pending',
          queue: [pending.pending],
          receivedAt: pending.receivedAt,
          snapshot: pending.stored,
          source: pending.source,
        },
        base,
      );
}

/**
 * Fields of the material form (YQuarantineRecordInput) the pending form does
 * not take: refused beside `stored` and `pending`. Those in NULLABLE count
 * only when not null (null is their documented absent value).
 */
const MATERIAL_ONLY = [
  'snapshot',
  'deltas',
  'queue',
  'draft',
  'signals',
  'requires',
  'peers',
  'clients',
  'session',
  'replica',
] as const;
const NULLABLE: ReadonlySet<string> = new Set(['draft', 'session', 'replica']);

/**
 * The pending form of `input`, or null for the material form. The pending
 * form is chosen only for kind `'pending'` with both `stored` and `pending`
 * bytes: those two keys are reserved for it, so a record of any other kind
 * keeps its kind and material whatever extra keys it carries. A `'pending'`
 * input with only one of them, or a value that is not bytes, is ambiguous,
 * and the form is exclusive: any material-form field beside them (see
 * MATERIAL_ONLY) is refused rather than dropped. Each is a TypeError.
 */
function pendingForm(
  input: YQuarantineRecordInput | YPendingRecordInput,
): YPendingRecordInput | null {
  if (input.kind !== 'pending') {
    return null;
  }
  const raw = input as unknown as Record<string, unknown>;
  const has = (key: string) => raw[key] !== undefined;
  if (!has('stored') && !has('pending')) {
    return null;
  }
  if (
    !(raw.stored instanceof Uint8Array) ||
    !(raw.pending instanceof Uint8Array)
  ) {
    throw new TypeError(
      '@lexical/y: a pending record input needs both `stored` and `pending` bytes',
    );
  }
  // Exclusive: beside `stored` and `pending` it takes only the id, source,
  // receivedAt and the header. Anything the material form declares would
  // be dropped, so it is refused rather than lost.
  const extra = MATERIAL_ONLY.filter(key =>
    NULLABLE.has(key) ? raw[key] != null : has(key),
  );
  if (extra.length > 0) {
    throw new TypeError(
      `@lexical/y: a pending record input takes only \`stored\`, \`pending\`, \`id\`, \`source\` and \`receivedAt\` (got ${extra.map(k => `\`${k}\``).join(', ')}): give a pending record with them in the material form`,
    );
  }
  return input as YPendingRecordInput;
}

/**
 * A record input's optional `v` and `updateFormat`: absent is version 1,
 * `'yjs-v1'` (the material this release makes); anything else supplied is
 * refused, so material of another format is never stamped as version 1.
 */
function checkRecordHeader(
  input: YQuarantineRecordInput | YPendingRecordInput,
): void {
  const header = input as unknown as Record<string, unknown>;
  if (
    (header.v !== undefined && header.v !== 1) ||
    (header.updateFormat !== undefined && header.updateFormat !== 'yjs-v1')
  ) {
    throw new TypeError(
      `@lexical/y: cannot build a version 1 record from material of version ${String(header.v)}, update format ${String(header.updateFormat)}: keep it as it is`,
    );
  }
}

/** createYQuarantineRecord's material form. */
function materialRecord(
  input: YQuarantineRecordInput,
  base: {readonly generation: string; readonly state: Uint8Array} | null = null,
): YQuarantineRecord {
  checkRecordHeader(input);
  // Copies of everything the caller handed over (bytes and arrays): an
  // acknowledged payload never changes under its hash.
  const snapshot = input.snapshot == null ? null : copyBytes(input.snapshot);
  const deltas = (input.deltas ?? []).map(copyBytes);
  const queue = (input.queue ?? []).map(copyBytes);
  const draft =
    input.draft == null
      ? null
      : {
          differs: input.draft.differs,
          // Canonical JSON refuses what is not JSON, and its parse is a deep
          // copy.
          json: JSON.parse(canonicalJSON(input.draft.json)) as unknown,
        };
  const signals = (input.signals ?? []).map(copySignal);
  const source = copySource(input.source);
  const peers = input.peers ?? true;
  // Canonical: each id once, in order.
  const clients = [...new Set(input.clients ?? [])].sort((a, b) => a - b);
  const requires = [...new Set(input.requires ?? [])].sort();
  // The provenance decides how the material may be read (see peers and
  // clients, and replay's base generation): two histories with the same
  // bytes are two records.
  const hash = recordHash({
    clients,
    deltas,
    draft,
    kind: input.kind,
    peers,
    queue,
    requires,
    signals,
    snapshot,
    source,
  });
  // A record of a kind or with a requirement this release does not know is
  // kept as it is and never decoded: nothing is derived from its bytes.
  const supported = isSupportedRecord({
    kind: input.kind,
    requires,
    updateFormat: 'yjs-v1',
    v: 1,
  });
  let collisions: YLegacySignal[] = [];
  let complete = false;
  if (supported) {
    const view = assembleV1({deltas, queue, snapshot});
    collisions = signals.filter(sg => signalAt(view.doc, sg) === 'collision');
    complete = view.complete;
    view.doc.destroy();
  }
  const record: YQuarantineRecord = {
    actionable: true,
    base: base === null ? null : base.generation,
    clients,
    collisions,
    complete,
    deltas,
    draft,
    hash,
    id: input.id ?? hash,
    kind: input.kind,
    peers,
    queue,
    receivedAt: input.receivedAt,
    replica: input.replica ?? null,
    requires,
    session: input.session ?? null,
    signals,
    snapshot,
    source,
    updateFormat: 'yjs-v1',
    v: 1,
  };
  // A record this release does not read cannot be shown to hold nothing
  // new.
  return base === null || !supported
    ? record
    : {...record, actionable: hasNewYEdits(record, base.state)};
}

/**
 * @internal Whether a quarantine record holds anything `base` (the
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
  const view = assembleV1(record);
  // Inside the try: a base that does not decode throws, and the record's
  // scratch document is destroyed all the same.
  let was: YDoc | null = null;
  try {
    was = createYDoc(base, {gc: false});
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
    if (was !== null) {
      was.destroy();
    }
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
