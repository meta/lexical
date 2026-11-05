/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {YRawYjsWriteData} from './Warnings';

import {
  ContentFormat,
  type Doc,
  Item,
  iterateStructsByIdSet,
  type Node as YNode,
  type Transaction,
  UndoManager,
} from '@y/y';

// Raw Yjs writes under a binding's root (development builds only, see
// RAW_YJS_WRITE_WARNING): the Yjs encoding under the root is private to
// the binding, so a local transaction of another origin that changes it is
// a programmer mistake the binding reports, never a supported write. The
// binding calls in here only behind its development check, so production
// builds leave the whole module out.

/**
 * The migration runner's transaction origin (MIGRATION_ORIGIN, a registered
 * symbol): the binding never imports the runner.
 */
const MIGRATION_ORIGIN_KEY = Symbol.for('@lexical/y/migration');

/**
 * Every binding's transaction origins (the binding and its tagged origins):
 * another binding of the same root writes with them, never raw.
 */
const BINDING_ORIGINS = new WeakSet<object>();

/**
 * The transactions a binding wrote in (its admitted writes and pins, a
 * seed into a pristine root, a recovery, an undo or redo that popped an item
 * or threw part way, and run ends), even when they joined an app's
 * transaction and carry its origin: never raw writes. A binding call that
 * writes nothing (refused, not pristine, an empty stack) marks nothing, so
 * it never hides an app's raw write in the same transaction.
 */
const BINDING_WRITES = new WeakSet<Transaction>();

/** Mark `tr` as one a binding writes in (once it is known to write). */
export function markBindingWrite(tr: Transaction): void {
  BINDING_WRITES.add(tr);
}

/** The origins each binding has reported (once per binding and origin). */
const REPORTED = new WeakMap<object, Set<unknown>>();

/** Register a binding's own transaction origins. */
export function registerBindingOrigins(origins: readonly object[]): void {
  for (const origin of origins) {
    BINDING_ORIGINS.add(origin);
  }
}

/** What a raw write changed first under the root. */
export interface RawChange {
  /** `'format'` (a text format key), `'attribute'` (a node attribute) or `'content'`. */
  readonly kind: 'format' | 'attribute' | 'content';
  /** The format or attribute key; null for content. */
  readonly key: string | null;
}

/** Whether `type` is `root` or lies under it. */
function under(type: unknown, root: YNode): boolean {
  let t = type as {_item?: {parent?: unknown} | null} | null | undefined;
  for (let depth = 0; t != null && depth < 10_000; depth++) {
    if (t === (root as unknown)) {
      return true;
    }
    const item = t._item;
    t = item == null ? null : (item.parent as typeof t);
  }
  return false;
}

/**
 * What `tr` changed under `root`, first: a format key it inserted, an
 * attribute it set, or other content; null when it changed nothing under
 * the root.
 */
export function rawChangeOf(tr: Transaction, root: YNode): RawChange | null {
  // Typed: @y/y declares `changed` with a type it does not import.
  const changed = tr.changed as Map<unknown, Set<string | null>>;
  let attribute: string | null = null;
  let content = false;
  for (const [type, keys] of changed) {
    if (!under(type, root)) {
      continue;
    }
    for (const key of keys) {
      if (key === null) {
        content = true;
      } else if (attribute === null) {
        attribute = key;
      }
    }
  }
  if (attribute === null && !content) {
    return null;
  }
  if (content) {
    let format: string | null = null;
    iterateStructsByIdSet(tr, tr.insertSet, s => {
      if (
        format === null &&
        s instanceof Item &&
        s.content instanceof ContentFormat &&
        under(s.parent, root)
      ) {
        format = s.content.key;
      }
    });
    if (format !== null) {
      return {key: format, kind: 'format'};
    }
  }
  return attribute !== null
    ? {key: attribute, kind: 'attribute'}
    : {key: null, kind: 'content'};
}

/** A transaction origin's constructor name, for the warning. */
export function originName(origin: unknown): string {
  if (origin === null || origin === undefined) {
    return String(origin);
  }
  if (typeof origin === 'object' || typeof origin === 'function') {
    const ctor = (origin as {constructor?: {name?: unknown}}).constructor;
    return typeof ctor === 'function' && typeof ctor.name === 'string'
      ? ctor.name || 'anonymous'
      : 'Object';
  }
  return typeof origin;
}

/**
 * Report `tr` through `warn` when it is a local transaction of another
 * origin (not a binding's, not a Y.UndoManager's, not a migration's) that
 * changed the content under `root`, once per `binding` and origin. A
 * transaction a binding also wrote in (markBindingWrite) is not checked,
 * whatever its origin: an editor edit or a binding undo inside an app's
 * `doc.transact` joins the app's transaction. So an app's raw write in that
 * same transaction goes unreported: this diagnostic may miss a raw write,
 * never report the binding's own.
 */
export function noteRawWrite(
  tr: Transaction,
  binding: object,
  doc: Doc,
  root: YNode,
  pending: boolean,
  warn: (message: string, data: YRawYjsWriteData) => void,
): void {
  const origin = tr.origin;
  let reported = REPORTED.get(binding);
  if (
    !tr.local ||
    pending ||
    BINDING_WRITES.has(tr) ||
    BINDING_ORIGINS.has(origin as object) ||
    origin instanceof UndoManager ||
    origin === MIGRATION_ORIGIN_KEY ||
    (reported !== undefined && reported.has(origin))
  ) {
    return;
  }
  const change = rawChangeOf(tr, root);
  if (change === null) {
    return;
  }
  if (reported === undefined) {
    reported = new Set();
    REPORTED.set(binding, reported);
  }
  reported.add(origin);
  let rootName = '(a nested type)';
  for (const [name, type] of doc.share) {
    if ((type as unknown) === root) {
      rootName = name;
    }
  }
  const name = originName(origin);
  warn(
    `a transaction with origin ${name} changed the document under the binding's root (${change.kind}${change.key === null ? '' : ` ${change.key}`}): the Yjs content under the root is private to the binding and unsupported for direct writes; change it through the editor or editYState`,
    {...change, origin: name, reason: 'raw-write', root: rootName},
  );
}
