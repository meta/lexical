/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Doc, Node as YNode, Transaction} from '@y/y';

import {
  DEFAULT_ROOT_NAME,
  EPOCH_KEY,
  LAYOUT_PREFIX,
  REQUIRE_PREFIX,
} from './constants';

// The layout record and the epoch as the core, the migration runner and the
// server helpers read them (see @lexical/y/migrate, @lexical/y/server).
// Small on purpose: the core and the runner each bundle a copy.

/**
 * @experimental What a migration records under `lexical-y-epoch` (see
 * @lexical/y/migrate): the transition that last changed the root. Each
 * field has one job:
 *
 * - `layout` is the destination: the layout the document is in after the
 *   migration (from 1).
 * - `step` plus `revision` is the receipt: which frozen step, at which
 *   immutable revision, wrote it (`step` is an opaque, namespaced id such
 *   as `lexical-y/layout/1to2`: readers never parse it).
 * - `client` and `clock` identify the migration's first written item: the
 *   transition identity the generation (`generationOf`) uses.
 * - `kind` names the family: `'layout'` for a layout migration, the only
 *   one this release writes. A missing kind reads as `'layout'`; readers
 *   keep any other as a label.
 * - `schema`, when present, names an app schema and its version.
 *
 * Readers accept fields they do not know and keep them in the document; an
 * epoch of another format version (`v`), or one whose known fields are not
 * well formed, closes writes (read only), as a malformed layout record
 * does.
 */
export interface YMigrationEpoch {
  readonly v: 1;
  readonly kind: string;
  readonly layout: number;
  readonly client: number;
  readonly clock: number;
  readonly step: string;
  readonly revision: number;
  readonly schema?: {readonly id: string; readonly version: number};
}

/** A root's layout records (see LAYOUT_PREFIX). */
export type LayoutRecord =
  | {readonly kind: 'none'}
  | {readonly kind: 'malformed'; readonly key: string; readonly found: unknown}
  | {readonly kind: 'layout'; readonly layout: number};

/**
 * The layout `root` records: the highest of its `lexical-y:<n>` attributes,
 * the first one that is not a version (an integer from 1 set to true), or
 * none. As the binding's layout gate reads it.
 */
export function layoutRecordOf(root: YNode): LayoutRecord {
  const attrs = root.getAttrs() as Record<string, unknown>;
  let layout = 0;
  for (const key of Object.keys(attrs).sort()) {
    if (key.startsWith(LAYOUT_PREFIX)) {
      const n = key.slice(LAYOUT_PREFIX.length);
      if (!/^[1-9][0-9]*$/.test(n) || attrs[key] !== true) {
        return {found: attrs[key], key, kind: 'malformed'};
      }
      layout = Math.max(layout, Number(n));
    }
  }
  return layout === 0 ? {kind: 'none'} : {kind: 'layout', layout};
}

/** A root's epoch (see EPOCH_KEY). */
export type EpochRecord =
  | {readonly kind: 'none'}
  | {readonly kind: 'malformed'; readonly found: unknown}
  | {readonly kind: 'epoch'; readonly epoch: YMigrationEpoch};

/**
 * The epoch `root` records (see YMigrationEpoch): `v` 1; a layout from 1, a
 * client from 1, a clock from 0, a revision from 1 and a non-empty step id;
 * a kind, when present, a non-empty string (missing: `'layout'`); a schema,
 * when present, `{id: non-empty string, version: integer from 1}`. Fields
 * it does not know are accepted (and left in the document).
 */
export function epochRecordOf(root: YNode): EpochRecord {
  return epochRecordIn(root.getAttrs() as RootAttrs);
}

/** A root's attributes, as `getAttrs()` returns them (read once, passed on). */
export type RootAttrs = Readonly<Record<string, unknown>>;

/** epochRecordOf, on attributes already read (see RootAttrs). */
export function epochRecordIn(attrs: RootAttrs): EpochRecord {
  if (!Object.prototype.hasOwnProperty.call(attrs, EPOCH_KEY)) {
    return {kind: 'none'};
  }
  const value = attrs[EPOCH_KEY];
  const malformed: EpochRecord = {found: value, kind: 'malformed'};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return malformed;
  }
  const e = value as Record<string, unknown>;
  const int = (x: unknown, min: number) =>
    Number.isSafeInteger(x) && (x as number) >= min;
  const name = (x: unknown) => typeof x === 'string' && x !== '';
  const kind = e.kind === undefined ? 'layout' : e.kind;
  if (
    e.v !== 1 ||
    !name(kind) ||
    !int(e.layout, 1) ||
    !int(e.client, 1) ||
    !int(e.clock, 0) ||
    !int(e.revision, 1) ||
    !name(e.step)
  ) {
    return malformed;
  }
  let schema: YMigrationEpoch['schema'];
  if (e.schema !== undefined) {
    const sc = e.schema as Record<string, unknown> | null;
    if (
      sc === null ||
      typeof sc !== 'object' ||
      Array.isArray(sc) ||
      !name(sc.id) ||
      !int(sc.version, 1)
    ) {
      return malformed;
    }
    schema = {id: sc.id as string, version: sc.version as number};
  }
  const epoch: YMigrationEpoch = {
    client: e.client as number,
    clock: e.clock as number,
    kind: kind as string,
    layout: e.layout as number,
    revision: e.revision as number,
    step: e.step as string,
    v: 1,
  };
  return {
    epoch: schema === undefined ? epoch : {...epoch, schema},
    kind: 'epoch',
  };
}

/** The epoch `root` records, null when none or malformed. */
export function epochOf(root: YNode): YMigrationEpoch | null {
  const record = epochRecordOf(root);
  return record.kind === 'epoch' ? record.epoch : null;
}

/** A root's feature requirements (see readRequirements). */
export interface YRequirements {
  /** Every feature the root requires (well formed), sorted. */
  readonly required: readonly string[];
  /** Those the reader does not support, sorted. */
  readonly unknown: readonly string[];
  /** Requirements that are not well formed, by key order. */
  readonly malformed: readonly {
    readonly key: string;
    readonly found: unknown;
  }[];
}

/** The features this release supports (none yet). */
export const SUPPORTED_FEATURES: ReadonlySet<string> = new Set();

/**
 * The feature requirements `root` records (`lexical-y-require:<feature> =
 * true`, see REQUIRE_PREFIX), against the features `supported` (default:
 * this release's). A root may be written only when `unknown` and
 * `malformed` are both empty; otherwise it is read only (shown, kept, never
 * rewritten). The binding, headless editing and the server's admission all
 * read it here.
 */
export function readRequirements(
  root: YNode,
  supported: ReadonlySet<string> = SUPPORTED_FEATURES,
): YRequirements {
  return requirementsIn(root.getAttrs() as RootAttrs, supported);
}

/** readRequirements, on attributes already read (see RootAttrs). */
export function requirementsIn(
  attrs: RootAttrs,
  supported: ReadonlySet<string> = SUPPORTED_FEATURES,
): YRequirements {
  const required: string[] = [];
  const malformed: {key: string; found: unknown}[] = [];
  for (const key of Object.keys(attrs).sort()) {
    if (key.startsWith(REQUIRE_PREFIX)) {
      const feature = key.slice(REQUIRE_PREFIX.length);
      if (feature === '' || attrs[key] !== true) {
        malformed.push({found: attrs[key], key});
      } else {
        required.push(feature);
      }
    }
  }
  return {
    malformed,
    required,
    unknown: required.filter(f => !supported.has(f)),
  };
}

/**
 * Whether `key` is a root attribute the layout gate reads: a layout record,
 * the epoch or a feature requirement.
 */
export function isGateKey(key: string): boolean {
  return (
    key.startsWith(LAYOUT_PREFIX) ||
    key === EPOCH_KEY ||
    key.startsWith(REQUIRE_PREFIX)
  );
}

/**
 * The top-level root `name` of `doc` when the document has one, without
 * creating it (`doc.get` would add a shared type).
 */
export function existingRoot(doc: Doc, name: string): YNode | null {
  const type = doc.share.get(name);
  return type === undefined ? null : (type as YNode);
}

/**
 * @experimental Call `fn` once every transaction listener of a transaction
 * that changed `root`'s epoch (a migration) has run, an
 * UndoManager's capture included (in `afterAllTransactions`). The hook for
 * an app's own UndoManagers: clear them there, since their stacks name
 * items the migration replaced (the binding clears its own). `fn` gets the
 * epoch, null when it is malformed. `root`: a root's name (default
 * `'lexical-y'`) or the root itself. Returns a function that stops
 * listening.
 */
export function onYMigrationEpoch(
  doc: Doc,
  fn: (epoch: YMigrationEpoch | null) => void,
  root: string | YNode = DEFAULT_ROOT_NAME,
): () => void {
  const target = typeof root === 'string' ? (doc.get(root) as YNode) : root;
  let changed = false;
  const after = (tr: Transaction) => {
    // Typed: @y/y declares `changed` with a type it does not import.
    const subs = (tr.changed as Map<unknown, Set<string | null>>).get(target);
    if (subs !== undefined && subs.has(EPOCH_KEY)) {
      changed = true;
    }
  };
  const afterAll = () => {
    if (changed) {
      changed = false;
      fn(epochOf(target));
    }
  };
  doc.on('afterTransaction', after);
  doc.on('afterAllTransactions', afterAll);
  return () => {
    doc.off('afterTransaction', after);
    doc.off('afterAllTransactions', afterAll);
  };
}
