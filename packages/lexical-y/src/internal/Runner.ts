/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  applyUpdate,
  ContentFormat,
  ContentType,
  createIdSet,
  decodeUpdate,
  diffUpdate,
  type Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  encodeStateVectorFromUpdate,
  intersectUpdateWithContentIds,
  Item,
  iterateStructsByIdSet,
  type Node as YNode,
  type Transaction,
} from '@y/y';

import {type ClientIDRange} from './ClientID';
import {
  DEFAULT_ROOT_NAME,
  EPOCH_KEY,
  LAYOUT_PREFIX,
  LAYOUT_VERSION,
  MIN_LAYOUT,
} from './constants';
import {
  epochOf,
  epochRecordOf,
  existingRoot,
  layoutRecordOf,
  type YMigrationEpoch,
} from './Layouts';
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

// The layout migration runner (see @lexical/y/migrate). Never imported by
// the binding: a server imports it with its steps (or loads only those it
// needs, see loadYMigrationSteps).
//
// Invariant: nothing is written to the caller's document or returned as a
// migrated state unless every step of every root ran and passed every check
// on an observer-free copy. Why: an authority stores the result (D102); a
// step that loses or changes content must fail closed, with the stored state
// untouched.
//
// Invariant: a step's writes are a function of its inputs alone (the
// re-encoded state, the root's name, the step's id and revision, the target
// layout, gc): the client id is hashed from them (migrationClientID) and the
// step is pure. Why: two authorities that migrate the same bytes write the
// same update, which merges as one copy. Different inputs can hash to one
// client id; that is harmless only because one result per document is ever
// published (an authority that wants a guaranteed-unique id passes its own
// allocator, `clientID`).

/**
 * @experimental A frozen layout migration step: one root from layout `from`
 * to `from + 1`, in place (see @lexical/y/migrate). The runner owns the
 * traversal and calls the step per container (the root, nested containers,
 * attribute-held types). Pure (no clock, randomness, app code, binding or
 * editor) and frozen: it imports `@y/y` and its own copies of what it reads
 * and writes, never the live binding. Any change to what it writes bumps
 * `revision`.
 */
export interface YLayoutMigration {
  /** `lexical-y/layout/<from>to<to>`. */
  readonly id: string;
  /** From 1; bumped on any change to what the step writes (hashed into the client). */
  readonly revision: number;
  /** The layout the step migrates from. */
  readonly from: number;
  /** `from + 1`, always. */
  readonly to: number;
  /**
   * Migrate one container's own sequence, inside the runner's transaction
   * on an observer-free copy (the runner records the layout before the
   * first container and the epoch after the last). Returns what it wrote
   * and deleted (informational; the receipt counts the transaction).
   */
  migrateContainer(
    tr: Transaction,
    container: YNode,
  ): {readonly written: number; readonly deleted: number};
  /**
   * Frozen read of layout `from`: one normalized string per live countable
   * unit of the container's own sequence, in order (each UTF-16 code unit
   * of a string item, each embed or type item once). Compared with
   * `readAfter` of the result unit by unit, so item splits and merges do
   * not matter.
   */
  readBefore(container: YNode): readonly string[];
  /** Frozen read of layout `to`, in the same shape as `readBefore`. */
  readAfter(container: YNode): readonly string[];
  /**
   * The target layout's own invariants on one migrated container (problems;
   * none: empty), so a step that only stamps the record cannot pass on
   * equal reads.
   */
  checkAfter(container: YNode): readonly string[];
  /**
   * The format keys the step rewrites. Every other format item, and every
   * attribute, is untouched.
   */
  rewrites(key: string): boolean;
}

/**
 * @experimental The codes of {@link YMigrationError} this version throws.
 * Codes are never renamed or reused; a later version may add codes (see
 * YMigrationErrorCode).
 */
export type YKnownMigrationErrorCode =
  /** No step links two layouts of the chain (or no loader gives it). */
  | 'missing-step'
  /**
   * The steps are ill-formed: duplicate ids, two steps from one layout, a
   * step that is not N to N + 1, misnamed, without a positive revision, or
   * not a step.
   */
  | 'invalid-steps'
  /** A root has content and no layout record. */
  | 'missing'
  /** A root's layout record or epoch is malformed. */
  | 'malformed'
  /** migrateYDoc on a document holding pending material or skipped ranges. */
  | 'pending'
  /** A step failed a check on the copy (or threw); nothing was written. */
  | 'post-condition'
  /** migrateYDoc was called inside a transaction of the document. */
  | 'in-transaction';

/**
 * @experimental The code of a {@link YMigrationError}: one this version
 * throws (YKnownMigrationErrorCode) or one a later version adds. Open on
 * purpose: handle the codes you know and keep a fallback.
 */
export type YMigrationErrorCode =
  | YKnownMigrationErrorCode
  | (string & {});

/**
 * @experimental A migration refused or failed. Nothing was written: the
 * caller's document and stored state are as they were.
 */
export class YMigrationError extends Error {
  readonly code: YMigrationErrorCode;
  /** Every problem found (for `'post-condition'`, every failed check). */
  readonly problems: readonly string[];
  /** The root concerned, null when the whole document is. */
  readonly root: string | null;
  constructor(
    code: YMigrationErrorCode,
    message: string,
    problems: readonly string[] = [],
    root: string | null = null,
  ) {
    super(message);
    this.name = 'YMigrationError';
    this.code = code;
    this.problems = problems;
    this.root = root;
  }
}

/** @experimental One step a migration ran on one root. */
export interface YMigrationStepReceipt {
  readonly id: string;
  readonly revision: number;
  /** The client id the step wrote with. */
  readonly client: number;
  /** Items the step's transaction wrote (the record and epoch included). */
  readonly written: number;
  /** Items it deleted (an earlier epoch included). */
  readonly deleted: number;
}

/** @experimental What a migration did to one root. */
export interface YMigrationRootReceipt {
  readonly root: string;
  /** The layout found, null for a pristine root (no record, no content). */
  readonly from: number | null;
  /** The layout after the migration (`from` when nothing ran). */
  readonly to: number | null;
  readonly changed: boolean;
  readonly steps: readonly YMigrationStepReceipt[];
  /** The epoch the last step recorded, null when none ran. */
  readonly epoch: YMigrationEpoch | null;
}

/**
 * @experimental What a migration did. Its format version is `v` (1); the
 * root and step receipts inside it are of the same version. An app may
 * persist a receipt: a reader keeps fields it does not know, and shows a
 * receipt of a version it does not know as it is, without acting on it.
 * `from` and `to` are layout numbers in every version. The counts
 * (`written`, `deleted`, the byte sizes) and `ms` are diagnostics: neither
 * an identity of the migration nor a proof of what it did.
 */
export interface YMigrationReceipt {
  /** The receipt's format version. */
  readonly v: 1;
  /** One per root, sorted by name. */
  readonly roots: readonly YMigrationRootReceipt[];
  /** Whether any root changed. */
  readonly changed: boolean;
  /** The encoded state's size before and after, in bytes. */
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly ms: number;
}

/** @experimental What a step writes with, for a `clientID` allocator. */
export interface YMigrationStepInput {
  readonly root: string;
  readonly step: string;
  readonly revision: number;
  readonly to: number;
}

/** @experimental Options of migrateYDoc. */
export interface YMigrateOptions {
  /**
   * The roots to migrate (default `['lexical-y']`), run sorted by name and
   * de-duplicated. Each must have a layout record or be pristine.
   */
  readonly roots?: readonly string[];
  /**
   * The layout to migrate to (default: MIN_LAYOUT of this build, so only
   * roots below the floor migrate).
   */
  readonly to?: number;
  /**
   * The range of the hashed client ids (default `'uint53'`; `'uint32'` for
   * servers that read client ids as 32-bit numbers).
   */
  readonly clientIDRange?: ClientIDRange;
  /**
   * An allocator of guaranteed-unique client ids, one per step run (default:
   * the hash of the inputs). Its id must not be one the document holds.
   */
  readonly clientID?: (input: YMigrationStepInput) => number;
}

/** @experimental Options of migrateYState. */
export interface YMigrateStateOptions extends YMigrateOptions {
  /**
   * Yjs garbage collection of the document (default true, as clients store
   * one): must equal the authority's stored documents' setting.
   */
  readonly gc?: boolean;
}

/** @experimental What migrateYState returns. */
export interface YMigrationResult {
  /**
   * The migrated state (update format V1), without pending material; the
   * input bytes themselves when nothing ran (store nothing then).
   */
  readonly state: Uint8Array;
  /** The update from the input's integrated state to `state`; null when nothing ran. */
  readonly update: Uint8Array | null;
  /**
   * The input's pending structs and pending delete set (V1), for the
   * quarantine: never in `state`. Null when there are none or nothing ran.
   */
  readonly pending: Uint8Array | null;
  readonly receipt: YMigrationReceipt;
}

/**
 * @internal (not exported from @lexical/y/migrate). The origin of the
 * transaction that applies a migration to a
 * document (migrateYDoc). A registered symbol, so every copy of the package
 * (the binding's bundle and the runner's) names the same one.
 */
export const MIGRATION_ORIGIN: unique symbol = Symbol.for(
  '@lexical/y/migration',
);

/**
 * @experimental Loaders of steps by the layout they migrate from, e.g.
 * `{1: () => import('@lexical/y/migrate/1to2')}`. A loader may resolve to
 * the step or to its module (default export). Other keys are ignored.
 */
export type YMigrationLoaders = {
  readonly [from: number]: () => Promise<unknown>;
};

const MAX_UINT32 = 0xffffffff;

/**
 * FNV-1a, 32 bits, from `basis` (frozen: part of the wire contract), over
 * the seed (4 bytes, little endian), the encoded state, a 0 byte, and
 * `text`.
 */
function fnv1a32(
  basis: number,
  seed: number,
  state: Uint8Array,
  text: Uint8Array,
): number {
  let h = basis;
  const mix = (byte: number) => {
    h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  };
  for (let i = 0; i < 4; i++) {
    mix((seed >>> (8 * i)) & 0xff);
  }
  for (let i = 0; i < state.length; i++) {
    mix(state[i]);
  }
  mix(0);
  for (let i = 0; i < text.length; i++) {
    mix(text[i]);
  }
  return h >>> 0;
}

/**
 * @internal The client id a step writes with: a hash of every input (the
 * copy's re-encoded state; the UTF-8 JSON of `[root, step id, revision,
 * target layout, gc]`). `'uint53'`: two FNV-1a 32 hashes (bases 0x811c9dc5
 * and 0x050c5d1f), the second's high 21 bits above the first's 32;
 * `'uint32'`: the first. Hashed again with the next seed while it is 0 or a
 * client the document holds (`taken`).
 */
export function migrationClientID(
  state: Uint8Array,
  input: {
    readonly root: string;
    readonly id: string;
    readonly revision: number;
    readonly to: number;
    readonly gc: boolean;
  },
  range: ClientIDRange,
  taken: (client: number) => boolean,
): number {
  const text = new TextEncoder().encode(
    JSON.stringify([input.root, input.id, input.revision, input.to, input.gc]),
  );
  for (let seed = 0; ; seed++) {
    const low = fnv1a32(0x811c9dc5, seed, state, text);
    const client =
      range === 'uint32'
        ? low
        : (fnv1a32(0x050c5d1f, seed, state, text) >>> 11) * 0x100000000 + low;
    if (client !== 0 && !taken(client)) {
      return client;
    }
  }
}

function isStep(value: unknown): value is YLayoutMigration {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    Number.isSafeInteger(s.revision) &&
    Number.isSafeInteger(s.from) &&
    Number.isSafeInteger(s.to) &&
    typeof s.migrateContainer === 'function' &&
    typeof s.readBefore === 'function' &&
    typeof s.readAfter === 'function' &&
    typeof s.checkAfter === 'function' &&
    typeof s.rewrites === 'function'
  );
}

/** What is wrong with a list of steps as a whole. */
function stepProblems(steps: readonly unknown[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const step of steps) {
    if (!isStep(step)) {
      problems.push('not a layout migration step');
      continue;
    }
    if (step.from < 1 || step.to !== step.from + 1) {
      problems.push(`${step.id} links ${step.from} to ${step.to}`);
    }
    if (step.id !== `lexical-y/layout/${step.from}to${step.to}`) {
      problems.push(`${step.id} is not named lexical-y/layout/<from>to<to>`);
    }
    if (step.revision < 1) {
      problems.push(`${step.id} has revision ${step.revision}`);
    }
    if (ids.has(step.id)) {
      problems.push(`two steps are named ${step.id}`);
    }
    ids.add(step.id);
  }
  return problems;
}

/**
 * The steps from `from` to `to`, one per layout, or a 'missing-step' error:
 * every step links N to N + 1 under its own id, and each link has exactly
 * one step.
 */
function chainOf(
  steps: readonly YLayoutMigration[],
  from: number,
  to: number,
  root: string | null,
): YLayoutMigration[] {
  const invalid = stepProblems(steps);
  const missing: string[] = [];
  const out: YLayoutMigration[] = [];
  for (let n = from; n < to && invalid.length === 0; n++) {
    const links = steps.filter(s => s.from === n);
    if (links.length === 0) {
      missing.push(`no step from layout ${n}`);
    } else if (links.length > 1) {
      invalid.push(`${links.length} steps from layout ${n}`);
    } else {
      out.push(links[0]);
    }
  }
  if (invalid.length > 0) {
    throw new YMigrationError(
      'invalid-steps',
      `@lexical/y: the steps are ill-formed: ${invalid.join('; ')}`,
      invalid,
      root,
    );
  }
  if (missing.length > 0) {
    throw new YMigrationError(
      'missing-step',
      `@lexical/y: no chain of steps from layout ${from} to ${to}: ${missing.join('; ')}`,
      missing,
      root,
    );
  }
  return out;
}

/**
 * @experimental Load the steps a root at layout `from` needs to reach `to`
 * (default LAYOUT_VERSION), only those, in parallel. Rejects with a
 * 'missing-step' YMigrationError when a link has no loader or a loader gives
 * something else than the step from that layout.
 */
export async function loadYMigrationSteps(
  loaders: YMigrationLoaders,
  from: number,
  to: number = LAYOUT_VERSION,
): Promise<YLayoutMigration[]> {
  const wanted: number[] = [];
  for (let n = from; n < to; n++) {
    wanted.push(n);
  }
  const steps = await Promise.all(
    wanted.map(async n => {
      const load = (loaders as Record<number, unknown>)[n];
      if (typeof load !== 'function') {
        return 'missing';
      }
      const loaded = (await load()) as unknown;
      const step =
        loaded !== null &&
        typeof loaded === 'object' &&
        'default' in loaded &&
        isStep((loaded as {default: unknown}).default)
          ? (loaded as {default: YLayoutMigration}).default
          : loaded;
      return isStep(step) && step.from === n ? step : 'invalid';
    }),
  );
  for (const kind of ['missing', 'invalid'] as const) {
    const problems = wanted
      .filter((n, i) => steps[i] === kind)
      .map(n =>
        kind === 'missing'
          ? `no loader for layout ${n}`
          : `the loader for layout ${n} gave something else than the step from it`,
      );
    if (problems.length > 0) {
      throw new YMigrationError(
        kind === 'missing' ? 'missing-step' : 'invalid-steps',
        `@lexical/y: cannot load the steps from layout ${from} to ${to}: ${problems.join('; ')}`,
        problems,
      );
    }
  }
  chainOf(steps as YLayoutMigration[], from, to, null);
  return steps as YLayoutMigration[];
}

/** What a root needs: the layout found and the steps to run (maybe none). */
type RootPlan = {
  root: string;
  from: number | null;
  steps: YLayoutMigration[];
};

/**
 * Check every root and the steps before anything runs, and select each
 * root's chain (any refusal refuses the whole migration: no partial
 * migration).
 */
function planOf(
  doc: Doc,
  steps: readonly YLayoutMigration[],
  options: YMigrateOptions,
): RootPlan[] {
  const to = options.to ?? MIN_LAYOUT;
  if (!Number.isSafeInteger(to) || to < 1) {
    throw new RangeError(`@lexical/y: ${String(to)} is not a layout`);
  }
  const listProblems = stepProblems(steps);
  if (listProblems.length > 0) {
    throw new YMigrationError(
      'invalid-steps',
      `@lexical/y: the steps are ill-formed: ${listProblems.join('; ')}`,
      listProblems,
    );
  }
  const names = [...new Set(options.roots ?? [DEFAULT_ROOT_NAME])].sort();
  return names.map(name => {
    const root = existingRoot(doc, name);
    if (root === null) {
      return {from: null, root: name, steps: []};
    }
    const record = layoutRecordOf(root);
    if (record.kind === 'malformed') {
      throw new YMigrationError(
        'malformed',
        `@lexical/y: root ${name}'s layout record ${record.key} is not a version`,
        [`${record.key} = ${JSON.stringify(record.found)}`],
        name,
      );
    }
    const epoch = epochRecordOf(root);
    if (epoch.kind === 'malformed') {
      throw new YMigrationError(
        'malformed',
        `@lexical/y: root ${name}'s epoch (${EPOCH_KEY}) is malformed`,
        [`${EPOCH_KEY} = ${JSON.stringify(epoch.found)}`],
        name,
      );
    }
    if (record.kind === 'none') {
      if (root.length > 0 || Object.keys(root.getAttrs()).length > 0) {
        throw new YMigrationError(
          'missing',
          `@lexical/y: root ${name} has content and no layout record`,
          [],
          name,
        );
      }
      return {from: null, root: name, steps: []};
    }
    // At or above the target, even above this build's LAYOUT_VERSION (a
    // rollback, or a server upgraded after its clients), a root needs no
    // step and stays as it is; only a root below it needs a chain.
    const from = record.layout;
    return {
      from,
      root: name,
      steps: from >= to ? [] : chainOf(steps, from, to, name),
    };
  });
}

const idOf = (it: Item): string => `${it.id.client}.${it.id.clock}`;

/** A container's identity: `root`, or the id of the item that holds it. */
const keyOf = (node: YNode, root: YNode): string =>
  node === root ? 'root' : idOf(node._item!);

/** Whether `type` is `root` or inside it (by parents, deleted or not). */
function isUnder(type: YNode | null, root: YNode): boolean {
  for (let t: YNode | null = type; t !== null; t = t.parent as YNode | null) {
    if (t === root) {
      return true;
    }
  }
  return false;
}

/**
 * Every container under `root`, depth first: the root, then each live type
 * of its sequence, then each live type its attributes hold (in code-unit
 * order of their keys), each followed by its own.
 */
function traverse(root: YNode): YNode[] {
  const out: YNode[] = [];
  const visit = (node: YNode) => {
    out.push(node);
    for (let it = node._start; it !== null; it = it.right) {
      if (!it.deleted && it.content instanceof ContentType) {
        visit(it.content.type as YNode);
      }
    }
    for (const key of [...node._map.keys()].sort()) {
      const it = node._map.get(key)!;
      if (!it.deleted && it.content instanceof ContentType) {
        visit(it.content.type as YNode);
      }
    }
  };
  visit(root);
  return out;
}

/**
 * The keys of every container under `root` found by a scan of the store
 * (each live type whose holding items up to the root are live): the
 * cross-check of `traverse`.
 */
function scannedContainers(doc: Doc, root: YNode): Set<string> {
  const out = new Set<string>(['root']);
  const live = (type: YNode): boolean => {
    for (let t: YNode | null = type; t !== null; t = t.parent as YNode | null) {
      if (t === root) {
        return true;
      }
      if (t._item === null || t._item.deleted) {
        return false;
      }
    }
    return false;
  };
  for (const structs of doc.store.clients.values()) {
    for (const s of structs) {
      if (
        s instanceof Item &&
        !s.deleted &&
        s.content instanceof ContentType &&
        live(s.content.type as YNode)
      ) {
        out.add(idOf(s));
      }
    }
  }
  return out;
}

/** One unit of an item's content, for equality only. */
function unitsOf(it: Item): string[] {
  // The content's kind (Yjs's own code for it: string, any, binary, embed,
  // format, JSON, type, document), so that one kind replaced by another
  // with the same values shows.
  const kind = contentKind(it);
  if (it.content instanceof ContentType) {
    const type = it.content.type as YNode & {name?: unknown};
    return [`${kind}<${typedValue(type.name ?? '')}>`];
  }
  const content = it.content.getContent();
  const out: string[] = [];
  for (let i = 0; i < it.length; i++) {
    out.push(`${kind}:${typedValue(content[i])}`);
  }
  return out;
}

/** The kind code of an item's content (see unitsOf). */
function contentKind(it: Item): number {
  const content: Item['content'] = it.content;
  return content.getRef();
}

/**
 * A value as a string that keeps its type, for equality only: unlike JSON,
 * a byte array, an undefined, -0, NaN, a bigint, a Date or a class instance
 * reads differently from the plain object or number it would turn into
 * (keys in their own order, as Yjs stores them). Complete at any depth;
 * arrays by index with their length, a hole read as undefined, as Yjs
 * encodes it. A value that contains itself (which Yjs cannot store either)
 * is a post-condition failure, never compared equal.
 */
function typedValue(value: unknown): string {
  const open = new Set<object>();
  const visit = (v: unknown): string => {
    switch (typeof v) {
      case 'undefined':
        return 'u';
      case 'boolean':
        return v ? 'T' : 'F';
      case 'number':
        return Object.is(v, -0) ? 'n-0' : `n${String(v)}`;
      case 'bigint':
        return `i${String(v)}`;
      case 'string':
        return `s${JSON.stringify(v)}`;
      case 'object':
        break;
      default:
        return `?${typeof v}`;
    }
    if (v === null) {
      return 'N';
    }
    if (v instanceof Uint8Array) {
      let hex = '';
      for (let i = 0; i < v.length; i++) {
        hex += v[i].toString(16).padStart(2, '0');
      }
      return `b${hex}`;
    }
    if (open.has(v)) {
      throw new YMigrationError(
        'post-condition',
        '@lexical/y: a value of the document contains itself, so it cannot be compared (or stored)',
        ['a value contains itself'],
      );
    }
    open.add(v);
    try {
      if (Array.isArray(v)) {
        const parts: string[] = [];
        for (let i = 0; i < v.length; i++) {
          parts.push(visit(v[i]));
        }
        return `[${v.length}:${parts.join(',')}]`;
      }
      const proto = Object.getPrototypeOf(v);
      const plain = proto === Object.prototype || proto === null;
      let tag = '';
      if (!plain) {
        const ctor = (proto as {constructor?: {name?: unknown}}).constructor;
        tag = ctor === undefined ? '?' : String(ctor.name);
      }
      const body = Object.keys(v)
        .map(
          k =>
            `${JSON.stringify(k)}:${visit((v as Record<string, unknown>)[k])}`,
        )
        .join(',');
      return `${tag}{${body}}`;
    } finally {
      open.delete(v);
    }
  };
  return visit(value);
}

/** What a container must keep (see the checks in runStep). */
type ContainerState = {
  /** Live countable units in order: `client.clock=content`. */
  units: string[];
  /** Live format items of keys the step does not rewrite. */
  formats: Set<string>;
  /** Live attributes (the root's but its layout records and epoch). */
  attrs: Map<string, string>;
  /** The read per unit. */
  read: string[];
  /** Problems with the read's shape, and the step's checkAfter problems. */
  problems: string[];
};

function containerState(
  node: YNode,
  root: YNode,
  rewrites: (key: string) => boolean,
  read: ((container: YNode) => readonly string[]) | null,
  check: ((container: YNode) => readonly string[]) | null,
): ContainerState {
  const units: string[] = [];
  const formats = new Set<string>();
  const attrs = new Map<string, string>();
  for (let it = node._start; it !== null; it = it.right) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof ContentFormat) {
      if (!rewrites(it.content.key)) {
        formats.add(
          `${idOf(it)}|${JSON.stringify(it.content.key)}=${typedValue(it.content.value)}`,
        );
      }
    } else if (it.countable) {
      unitsOf(it).forEach((u, i) =>
        units.push(`${it.id.client}.${it.id.clock + i}=${u}`),
      );
    }
  }
  for (const [key, it] of node._map) {
    if (
      !it.deleted &&
      !(node === root && (key.startsWith(LAYOUT_PREFIX) || key === EPOCH_KEY))
    ) {
      attrs.set(key, `${idOf(it)}|${unitsOf(it).join(',')}`);
    }
  }
  const problems: string[] = [];
  const perUnit: string[] = [];
  if (read !== null) {
    const strings = read(node);
    if (strings.length !== units.length) {
      problems.push(
        `the read of container ${keyOf(node, root)} gave ${strings.length} strings for ${units.length} units`,
      );
    }
    perUnit.push(...strings);
  }
  if (check !== null) {
    for (const problem of check(node)) {
      problems.push(`container ${keyOf(node, root)}: ${problem}`);
    }
  }
  return {attrs, formats, problems, read: perUnit, units};
}

type RootState = Map<string, ContainerState>;

/** Every container's state, by key; problems where traversal and scan differ. */
function rootState(
  doc: Doc,
  root: YNode,
  rewrites: (key: string) => boolean,
  read: ((container: YNode) => readonly string[]) | null,
  check: ((container: YNode) => readonly string[]) | null,
  problems: string[],
  what: string,
): RootState {
  const out: RootState = new Map();
  for (const node of traverse(root)) {
    out.set(
      keyOf(node, root),
      containerState(node, root, rewrites, read, check),
    );
  }
  const scanned = scannedContainers(doc, root);
  const missed = [...scanned].filter(k => !out.has(k));
  const extra = [...out.keys()].filter(k => !scanned.has(k));
  if (missed.length > 0 || extra.length > 0) {
    problems.push(
      `${what}: the traversal and the store scan differ (${missed.length} not reached, ${extra.length} not found)`,
    );
  }
  return out;
}

/**
 * The differences between two states of a root. `reads`: compare the read
 * of `a` with the read of `b`.
 */
function stateProblems(
  a: RootState,
  b: RootState,
  what: string,
  reads: boolean,
): string[] {
  const out: string[] = [];
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const key of [...keys].sort()) {
    const x = a.get(key);
    const y = b.get(key);
    if (x === undefined || y === undefined) {
      out.push(
        `${what}: container ${key} ${x === undefined ? 'appeared' : 'is gone'}`,
      );
      continue;
    }
    out.push(...y.problems.map(p => `${what}: ${p}`));
    if (x.units.join('\n') !== y.units.join('\n')) {
      const i = x.units.findIndex((u, n) => y.units[n] !== u);
      out.push(
        `${what}: container ${key}'s countable content changed (ids, content or order): unit ${i === -1 ? x.units.length : i} ${x.units[i] ?? 'none'} -> ${y.units[i === -1 ? x.units.length : i] ?? 'none'}`,
      );
    }
    const gone = [...x.formats].filter(f => !y.formats.has(f));
    const added = [...y.formats].filter(f => !x.formats.has(f));
    if (gone.length > 0 || added.length > 0) {
      out.push(
        `${what}: container ${key}'s format items of keys the step does not rewrite changed: ${gone.length} gone, ${added.length} new`,
      );
    }
    for (const k of [
      ...new Set([...x.attrs.keys(), ...y.attrs.keys()]),
    ].sort()) {
      if (x.attrs.get(k) !== y.attrs.get(k)) {
        out.push(`${what}: container ${key}'s attribute ${k} changed`);
      }
    }
    if (reads) {
      if (x.read.length !== y.read.length) {
        out.push(
          `${what}: container ${key} reads ${x.read.length} units -> ${y.read.length}`,
        );
      } else {
        const i = x.read.findIndex((r, n) => y.read[n] !== r);
        if (i >= 0) {
          out.push(
            `${what}: container ${key} reads differently at unit ${i}: ${x.read[i]} -> ${y.read[i]}`,
          );
        }
      }
    }
  }
  return out;
}

/**
 * Every item the step's transaction wrote or deleted outside what it may:
 * format items of keys it rewrites under the root, the root's layout
 * record (written) and its epoch (written, an earlier one deleted).
 */
function outsideWrites(
  tr: Transaction,
  client: number,
  root: YNode,
  step: YLayoutMigration,
): {written: number; deleted: number; problems: string[]} {
  const problems: string[] = [];
  const allowed = (it: Item, deleting: boolean): boolean => {
    const parent = it.parent as YNode | null;
    if (parent === null || typeof parent !== 'object') {
      return false;
    }
    if (typeof it.parentSub === 'string') {
      return (
        parent === root &&
        (it.parentSub === EPOCH_KEY ||
          (!deleting && it.parentSub === LAYOUT_PREFIX + step.to))
      );
    }
    return (
      it.content instanceof ContentFormat &&
      isUnder(parent, root) &&
      step.rewrites(it.content.key)
    );
  };
  let written = 0;
  let deleted = 0;
  iterateStructsByIdSet(tr, tr.insertSet, s => {
    if (s instanceof Item) {
      written++;
      if (s.id.client !== client) {
        problems.push(`an item of client ${s.id.client} was written`);
      } else if (!allowed(s, false)) {
        problems.push(`item ${idOf(s)} was written outside the step's keys`);
      }
    }
  });
  iterateStructsByIdSet(tr, tr.deleteSet, s => {
    if (s instanceof Item) {
      deleted++;
      // An item this transaction wrote and deleted was checked as written.
      if (
        !(s.id.client === client && tr.insertSet.hasId(s.id)) &&
        !allowed(s, true)
      ) {
        problems.push(`item ${idOf(s)} was deleted outside the step's keys`);
      }
    }
  });
  return {deleted, problems: problems.slice(0, 20), written};
}

/** An item's content as a string: a format's key and value, else its units. */
function valueOf(it: Item): string {
  if (it.content instanceof ContentFormat) {
    return `format ${JSON.stringify(it.content.key)}=${typedValue(
      it.content.value,
    )}`;
  }
  return unitsOf(it).join(',');
}

/**
 * Every container of every top-level type of `doc` but `except`, by
 * `<type name>/<container key>`: its live items in order and its live
 * attributes, each with its id and content as strings (JSON values read
 * deep, so a value changed in place shows). What a step must leave alone
 * outside the root it migrates, and what a returned update must reproduce.
 */
function documentState(doc: Doc, except: YNode | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of [...doc.share.keys()].sort()) {
    const type = doc.share.get(name) as YNode;
    if (type === except) {
      continue;
    }
    for (const node of traverse(type)) {
      const parts: string[] = [];
      for (let it = node._start; it !== null; it = it.right) {
        if (!it.deleted) {
          parts.push(`${idOf(it)}=${valueOf(it)}`);
        }
      }
      for (const key of [...node._map.keys()].sort()) {
        const it = node._map.get(key)!;
        if (!it.deleted) {
          parts.push(`${JSON.stringify(key)}:${idOf(it)}=${valueOf(it)}`);
        }
      }
      out.set(`${JSON.stringify(name)}/${keyOf(node, type)}`, parts.join('\n'));
    }
  }
  return out;
}

/** The keys whose entries differ between two documentStates. */
function documentDiff(
  a: Map<string, string>,
  b: Map<string, string>,
): string[] {
  return [...new Set([...a.keys(), ...b.keys()])]
    .sort()
    .filter(k => a.get(k) !== b.get(k));
}

/**
 * The update that brings `integrated` (the input's integrated state) to
 * `copy` (the migrated copy), checked: applied to a fresh document of
 * `integrated`, it must give the same document as `copy` (same state
 * vector, every container the same). A step that changed a value in place
 * (no insertion, no deletion) leaves an update that does not; that throws
 * 'post-condition'.
 */
function checkedUpdate(
  integrated: Uint8Array,
  copy: Doc,
  vector: Uint8Array,
): Uint8Array {
  const update = encodeStateAsUpdate(copy, vector);
  const fresh = createYDoc(integrated, {gc: copy.gc});
  try {
    applyUpdate(fresh, update);
    const problems: string[] = [];
    const sv = (d: Doc) =>
      JSON.stringify(
        [...d.store.clients.keys()].sort().map(c => [c, d.store.getClock(c)]),
      );
    if (sv(fresh) !== sv(copy)) {
      problems.push(
        'the input with the update has another state vector than the result',
      );
    }
    for (const key of documentDiff(
      documentState(fresh, null),
      documentState(copy, null),
    )) {
      problems.push(
        `the input with the update differs from the result in container ${key}`,
      );
    }
    if (problems.length > 0) {
      throw new YMigrationError(
        'post-condition',
        `@lexical/y: the migration's update does not bring the input to its result: ${problems.slice(0, 5).join('; ')}`,
        problems,
      );
    }
    return update;
  } finally {
    fresh.destroy();
  }
}

/**
 * Run `step` on root `name` of `copy` (observer-free, the caller's alone)
 * in one transaction, then check the result. Throws a 'post-condition'
 * YMigrationError with every problem (the copy is then the caller's to
 * discard).
 */
function runStep(
  copy: Doc,
  name: string,
  step: YLayoutMigration,
  options: YMigrateOptions,
  reserved: ReadonlySet<number>,
): YMigrationStepReceipt & {epoch: YMigrationEpoch} {
  const root = copy.get(name) as YNode;
  const problems: string[] = [];
  const before = rootState(
    copy,
    root,
    step.rewrites,
    step.readBefore,
    null,
    problems,
    'before',
  );
  problems.push(...[...before.values()].flatMap(c => c.problems));
  const othersBefore = documentState(copy, root);
  const recordsBefore = Object.keys(root.getAttrs()).filter(k =>
    k.startsWith(LAYOUT_PREFIX),
  );
  // Every client of the complete input (split material included, which
  // the copy no longer holds) and every client an earlier step wrote: an
  // id the migration takes must name nothing of the input's history.
  const taken = (c: number) => copy.store.clients.has(c) || reserved.has(c);
  const range = options.clientIDRange ?? 'uint53';
  let client: number;
  if (options.clientID !== undefined) {
    client = options.clientID({
      revision: step.revision,
      root: name,
      step: step.id,
      to: step.to,
    });
    if (
      !Number.isSafeInteger(client) ||
      client < 1 ||
      (range === 'uint32' && client > MAX_UINT32) ||
      taken(client)
    ) {
      throw new YMigrationError(
        'post-condition',
        `@lexical/y: the clientID allocator gave ${client}, which is not a free client id of this document`,
        [`client ${client}`],
        name,
      );
    }
  } else {
    client = migrationClientID(
      encodeStateAsUpdate(copy),
      {
        gc: copy.gc,
        id: step.id,
        revision: step.revision,
        root: name,
        to: step.to,
      },
      range,
      taken,
    );
  }
  const containers = traverse(root);
  const own = copy.clientID;
  let epoch: YMigrationEpoch | null = null;
  let counts = {deleted: 0, problems: [] as string[], written: 0};
  copy.clientID = client;
  try {
    copy.transact(tr => {
      try {
        const clock = copy.store.getClock(client);
        root.setAttr(LAYOUT_PREFIX + step.to, true);
        for (const container of containers) {
          step.migrateContainer(tr, container);
        }
        epoch = {
          client,
          clock,
          kind: 'layout',
          layout: step.to,
          revision: step.revision,
          step: step.id,
          v: 1,
        };
        root.setAttr(EPOCH_KEY, epoch as never);
      } catch (error) {
        problems.push(`the step threw: ${String(error)}`);
      }
      counts = outsideWrites(tr, client, root, step);
    }, MIGRATION_ORIGIN);
  } finally {
    copy.clientID = own;
  }
  if (epoch === null) {
    throw new YMigrationError(
      'post-condition',
      `@lexical/y: step ${step.id} failed on root ${name}: ${problems.join('; ')}`,
      problems,
      name,
    );
  }
  const written: YMigrationEpoch = epoch;
  problems.push(...counts.problems);
  const after = rootState(
    copy,
    root,
    step.rewrites,
    step.readAfter,
    step.checkAfter,
    problems,
    'after',
  );
  problems.push(...stateProblems(before, after, 'result', true));
  for (const key of documentDiff(othersBefore, documentState(copy, root))) {
    problems.push(`result: container ${key} outside the root changed`);
  }
  for (const key of recordsBefore) {
    if (root.getAttr(key) !== true) {
      problems.push(`the layout record ${key} was removed`);
    }
  }
  const record = layoutRecordOf(root);
  if (record.kind !== 'layout' || record.layout !== step.to) {
    problems.push(`the root does not record layout ${step.to}`);
  }
  if (JSON.stringify(epochOf(root)) !== JSON.stringify(written)) {
    problems.push('the root does not record a well-formed epoch');
  }
  problems.push(...heldProblems(copy).map(p => `result: ${p}`));
  // The encoded result, read again by a fresh document, reads the same.
  const reread = createYDoc(encodeStateAsUpdate(copy), {gc: copy.gc});
  try {
    problems.push(...heldProblems(reread).map(p => `re-read: ${p}`));
    const rroot = reread.get(name) as YNode;
    const rstate = rootState(
      reread,
      rroot,
      () => false,
      step.readAfter,
      step.checkAfter,
      problems,
      're-read',
    );
    const astate = rootState(
      copy,
      root,
      () => false,
      step.readAfter,
      null,
      [],
      'after',
    );
    problems.push(...stateProblems(astate, rstate, 're-read', true));
    if (JSON.stringify(epochOf(rroot)) !== JSON.stringify(written)) {
      problems.push('re-read: the epoch differs');
    }
  } finally {
    reread.destroy();
  }
  if (problems.length > 0) {
    throw new YMigrationError(
      'post-condition',
      `@lexical/y: step ${step.id} failed its checks on root ${name}: ${problems.slice(0, 5).join('; ')}`,
      problems,
      name,
    );
  }
  return {
    client,
    deleted: counts.deleted,
    epoch: written,
    id: step.id,
    revision: step.revision,
    written: counts.written,
  };
}

/**
 * Every client id the complete input names: the clients `doc` holds (items
 * past a skipped range included) and, in the stored bytes (pending structs
 * and the pending delete set included), every struct's client, every
 * client its origin, right origin or parent names, and every client of the
 * delete set. The migration takes no such id, even one only split material
 * or a deletion names.
 */
function inputClients(doc: Doc, state: Uint8Array): Set<number> {
  const out = new Set<number>(doc.store.clients.keys());
  const decoded = decodeUpdate(state);
  const named = (ref: unknown) => {
    if (typeof ref === 'object' && ref !== null) {
      const client = (ref as {client?: unknown}).client;
      if (typeof client === 'number') {
        out.add(client);
      }
    }
  };
  for (const s of decoded.structs) {
    out.add(s.id.client);
    if (s instanceof Item) {
      named(s.origin);
      named(s.rightOrigin);
      named(s.parent);
    }
  }
  for (const client of decoded.ds.clients.keys()) {
    out.add(client);
  }
  return out;
}

/** Pending structs, a pending delete set or skipped ranges in `doc`. */
function heldProblems(doc: Doc): string[] {
  const store = doc.store;
  const out: string[] = [];
  if (store.pendingStructs !== null) {
    out.push('pending structs');
  }
  if (store.pendingDs !== null) {
    out.push('a pending delete set');
  }
  if (!store.skips.isEmpty()) {
    out.push('skipped ranges');
  }
  return out;
}

/**
 * The part of `doc`'s state a migration runs on (V1), and what it splits
 * out (V1), null when nothing: the pending structs and pending delete set,
 * and for a skipped range (Yjs 14 integrates an item past a gap in its own
 * client's clocks) every item of that client from the first missing clock
 * on, plus every item that depends on a split item by origin, right origin
 * or parent, transitively, with its client's later items. What is kept is a
 * prefix of each client's clocks, so it holds no pending material and no
 * skip.
 */
function splitHeld(doc: Doc): {
  integrated: Uint8Array;
  pending: Uint8Array | null;
} {
  const store = doc.store;
  if (heldProblems(doc).length === 0) {
    return {integrated: encodeStateAsUpdate(doc), pending: null};
  }
  // With the pending material: Yjs merges it into the encoding.
  const full = encodeStateAsUpdate(doc);
  // From which clock on each client's items are split.
  const split = new Map<number, number>();
  store.skips.clients.forEach((ranges, client) => {
    for (const range of ranges.getIds()) {
      split.set(client, Math.min(split.get(client) ?? Infinity, range.clock));
    }
  });
  const isSplit = (id: {client: number; clock: number} | null): boolean => {
    if (id === null) {
      return false;
    }
    const from = split.get(id.client);
    return from !== undefined && id.clock >= from;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [client, structs] of store.clients) {
      for (const s of structs) {
        if (isSplit(s.id)) {
          break;
        }
        if (!(s instanceof Item)) {
          continue;
        }
        const parent = s.parent as YNode | null;
        const holder =
          parent !== null && typeof parent === 'object' ? parent._item : null;
        if (
          isSplit(s.origin) ||
          isSplit(s.rightOrigin) ||
          (holder !== null && isSplit(holder.id))
        ) {
          split.set(client, s.id.clock);
          changed = true;
          break;
        }
      }
    }
  }
  // Kept: each client's clocks below its split clock (or all of them).
  const kept = createIdSet();
  for (const [client, structs] of store.clients) {
    if (structs.length === 0) {
      continue;
    }
    const first = structs[0].id.clock;
    const last = structs[structs.length - 1];
    const end = Math.min(
      split.get(client) ?? Infinity,
      last.id.clock + last.length,
    );
    if (end > first) {
      kept.add(client, first, end - first);
    }
  }
  const integrated = intersectUpdateWithContentIds(full, {
    deletes: kept,
    inserts: kept,
  } as Parameters<typeof intersectUpdateWithContentIds>[1]);
  return {
    integrated,
    // Everything else: the split items, the pending structs, and the delete
    // set (deletions of kept items are already in `integrated`: no-ops).
    pending: diffUpdate(full, encodeStateVectorFromUpdate(integrated)),
  };
}

/**
 * Run `plans` on an observer-free copy of `integrated`; null when no root
 * has steps.
 */
function runOnCopy(
  integrated: Uint8Array,
  gc: boolean,
  plans: readonly RootPlan[],
  options: YMigrateOptions,
  reserved: ReadonlySet<number>,
): {copy: Doc; roots: YMigrationRootReceipt[]} | null {
  if (plans.every(p => p.steps.length === 0)) {
    return null;
  }
  const copy = createYDoc(integrated, {gc});
  try {
    const roots = plans.map((plan): YMigrationRootReceipt => {
      const ran: YMigrationStepReceipt[] = [];
      let epoch: YMigrationEpoch | null = null;
      for (const step of plan.steps) {
        const {epoch: e, ...receipt} = runStep(
          copy,
          plan.root,
          step,
          options,
          reserved,
        );
        ran.push(receipt);
        epoch = e;
      }
      return {
        changed: ran.length > 0,
        epoch,
        from: plan.from,
        root: plan.root,
        steps: ran,
        to: ran.length > 0 ? plan.steps[plan.steps.length - 1].to : plan.from,
      };
    });
    return {copy, roots};
  } catch (error) {
    copy.destroy();
    if (error instanceof YMigrationError) {
      throw error;
    }
    // A step's read threw (its writes are caught inside the transaction).
    throw new YMigrationError(
      'post-condition',
      `@lexical/y: a step threw: ${String(error)}`,
      [`the step threw: ${String(error)}`],
    );
  }
}

function unchanged(plans: readonly RootPlan[]): YMigrationRootReceipt[] {
  return plans.map(p => ({
    changed: false,
    epoch: null,
    from: p.from,
    root: p.root,
    steps: [],
    to: p.from,
  }));
}

/**
 * @experimental Migrate a stored state (synchronous; for an authority with
 * every session out, behind its barrier and compare-and-set over exactly
 * these bytes). Every root below the target runs its chain of steps on an
 * observer-free copy, each step checked there; any refusal or failed check
 * throws a YMigrationError and nothing is returned. Pending structs, a
 * pending delete set and skipped ranges (with everything after the gap and
 * everything that depends on it) are split out (`pending`), never migrated
 * or kept in `state`. When no root needs a step, the input bytes come back as `state`,
 * with `update: null` and `changed: false`: store nothing.
 */
export function migrateYState(
  state: Uint8Array,
  steps: readonly YLayoutMigration[],
  options: YMigrateStateOptions = {},
): YMigrationResult {
  const t0 = Date.now();
  const gc = options.gc ?? true;
  const doc = createYDoc(state, {gc});
  try {
    const plans = planOf(doc, steps, options);
    if (plans.every(p => p.steps.length === 0)) {
      return {
        pending: null,
        receipt: {
          bytesAfter: state.length,
          bytesBefore: state.length,
          changed: false,
          ms: Date.now() - t0,
          roots: unchanged(plans),
          v: 1,
        },
        state,
        update: null,
      };
    }
    const {integrated, pending} = splitHeld(doc);
    const {copy, roots} = runOnCopy(
      integrated,
      gc,
      plans,
      options,
      inputClients(doc, state),
    )!;
    try {
      const out = encodeStateAsUpdate(copy);
      return {
        pending,
        receipt: {
          bytesAfter: out.length,
          bytesBefore: state.length,
          changed: true,
          ms: Date.now() - t0,
          roots,
          v: 1,
        },
        state: out,
        update: checkedUpdate(integrated, copy, encodeStateVector(doc)),
      };
    } finally {
      copy.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/**
 * @internal (not exported from @lexical/y/migrate: servers migrate stored
 * bytes with migrateYState). Migrate a live document in place: the steps run
 * and are
 * checked on an observer-free copy of its integrated state, and only then
 * is their update applied to `doc` in one transaction with
 * MIGRATION_ORIGIN (pending material stays pending in `doc`). Only for a
 * document no other client or server writes (or an authority's own copy
 * with every session out). Refused inside a transaction of `doc`
 * (`'in-transaction'`: an outer transaction would give the migration its
 * origin and its undo capture).
 */
export function migrateYDoc(
  doc: Doc,
  steps: readonly YLayoutMigration[],
  options: YMigrateOptions = {},
): YMigrationReceipt {
  assertSupportedMigrationYjs();
  if (doc._transaction !== null) {
    throw new YMigrationError(
      'in-transaction',
      '@lexical/y: a migration cannot run inside a transaction of the document; run it between transactions',
    );
  }
  const t0 = Date.now();
  const plans = planOf(doc, steps, options);
  const held = heldProblems(doc);
  if (held.length > 0 && plans.some(p => p.steps.length > 0)) {
    throw new YMigrationError(
      'pending',
      `@lexical/y: the document holds ${held.join(', ')}, which a live document cannot drop in place; migrate its stored state (migrateYState splits them out) or wait for the missing updates`,
      held,
    );
  }
  const integrated = encodeStateAsUpdate(doc);
  const result = runOnCopy(
    integrated,
    doc.gc,
    plans,
    options,
    inputClients(doc, integrated),
  );
  if (result === null) {
    return {
      bytesAfter: integrated.length,
      bytesBefore: integrated.length,
      changed: false,
      ms: Date.now() - t0,
      roots: unchanged(plans),
      v: 1,
    };
  }
  const {copy, roots} = result;
  try {
    applyUpdate(
      doc,
      checkedUpdate(integrated, copy, encodeStateVector(doc)),
      MIGRATION_ORIGIN,
    );
  } finally {
    copy.destroy();
  }
  return {
    bytesAfter: encodeStateAsUpdate(doc).length,
    bytesBefore: integrated.length,
    changed: true,
    ms: Date.now() - t0,
    roots,
    v: 1,
  };
}

/**
 * @experimental The layout `doc` records under `root`: the highest
 * `lexical-y:<n>` record; null when it has none (or no such root); NaN when
 * a record is not a version (the binding opens it read only).
 */
export function recordedLayout(
  doc: Doc,
  root: string = DEFAULT_ROOT_NAME,
): number | null {
  const type = existingRoot(doc, root);
  if (type === null) {
    return null;
  }
  const record = layoutRecordOf(type);
  return record.kind === 'layout'
    ? record.layout
    : record.kind === 'malformed'
      ? NaN
      : null;
}

/** @experimental The epoch `doc` records under `root`, null when none or malformed. */
export function layoutEpoch(
  doc: Doc,
  root: string = DEFAULT_ROOT_NAME,
): YMigrationEpoch | null {
  const type = existingRoot(doc, root);
  return type === null ? null : epochOf(type);
}
