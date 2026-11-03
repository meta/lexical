/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Doc, Node as YNode, Transaction} from '@y/y';

import {DEFAULT_ROOT_NAME, EPOCH_KEY, LAYOUT_PREFIX} from './constants';

// The layout record and the epoch as the core, the migration runner and the
// server helpers read them (see @lexical/y/migrate, @lexical/y/server).
// Small on purpose: the core and the runner each bundle a copy.

/**
 * @experimental What a layout migration records under `lexical-y-epoch`
 * (see @lexical/y/migrate): the layout it migrated the root to, the id of
 * its transaction's first item (`client`, `clock`: the layout record), and
 * the step that ran.
 */
export interface YLayoutEpoch {
  readonly v: 1;
  readonly layout: number;
  readonly client: number;
  readonly clock: number;
  readonly step: string;
  readonly revision: number;
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
  | {readonly kind: 'epoch'; readonly epoch: YLayoutEpoch};

const EPOCH_FIELDS = 'client,clock,layout,revision,step,v';

/**
 * The epoch `root` records, parsed strictly: exactly the fields of
 * YLayoutEpoch, `v` 1, a layout from 2, a client from 1, a clock from 0, a
 * revision from 1 and the step's id.
 */
export function epochRecordOf(root: YNode): EpochRecord {
  const attrs = root.getAttrs() as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(attrs, EPOCH_KEY)) {
    return {kind: 'none'};
  }
  const value = attrs[EPOCH_KEY];
  const e = value as Record<string, unknown>;
  const int = (x: unknown, min: number) =>
    Number.isSafeInteger(x) && (x as number) >= min;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(e).sort().join(',') !== EPOCH_FIELDS ||
    e.v !== 1 ||
    !int(e.layout, 2) ||
    !int(e.client, 1) ||
    !int(e.clock, 0) ||
    !int(e.revision, 1) ||
    typeof e.step !== 'string' ||
    !/^lexical-y\/layout\/[1-9][0-9]*to[1-9][0-9]*$/.test(e.step)
  ) {
    return {found: value, kind: 'malformed'};
  }
  return {
    epoch: {
      client: e.client as number,
      clock: e.clock as number,
      layout: e.layout as number,
      revision: e.revision as number,
      step: e.step,
      v: 1,
    },
    kind: 'epoch',
  };
}

/** The epoch `root` records, null when none or malformed. */
export function epochOf(root: YNode): YLayoutEpoch | null {
  const record = epochRecordOf(root);
  return record.kind === 'epoch' ? record.epoch : null;
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
 * that changed `root`'s epoch (a layout migration) has run, an
 * UndoManager's capture included (in `afterAllTransactions`). The hook for
 * an app's own UndoManagers: clear them there, since their stacks name
 * items the migration replaced (the binding clears its own). `fn` gets the
 * epoch, null when it is malformed. `root`: a root's name (default
 * `'lexical-y'`) or the root itself. Returns a function that stops
 * listening.
 */
export function onLayoutEpoch(
  doc: Doc,
  fn: (epoch: YLayoutEpoch | null) => void,
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
