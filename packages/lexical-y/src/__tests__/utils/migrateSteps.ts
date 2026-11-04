/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Synthetic layout migration steps and fixtures for the migration tests,
// relative to the build's constants (SEED_LAYOUT, MIN_LAYOUT,
// LAYOUT_VERSION), so the same tests run on any build: a step from the
// layout a seed records (SEED) to the next (SEED + 1), a step that rewrites
// format items from there (SEED + 1 to SEED + 2), and a floor (FLOOR) with a
// raw fixture one layout below it that a step migrates to an editable
// layout.

import * as Y from '@y/y';

import {createYDoc, LAYOUT_VERSION} from '../..';
import {seedYState} from '../../headless';
import {MIN_LAYOUT} from '../../internal/constants';
import {recordedLayout, type YLayoutMigration} from '../../migrate';

/** The layout a seed records on this build (read from a seed). */
export const SEED: number = recordedLayout(
  createYDoc(seedYState({schemaVersion: 1}, () => {})),
)!;

/**
 * A floor at or below LAYOUT_VERSION with a layout below it: MIN_LAYOUT
 * where it is above 1, otherwise 2 (raised with setMinLayoutForTests).
 */
export const FLOOR = MIN_LAYOUT > 1 ? MIN_LAYOUT : 2;

if (FLOOR > LAYOUT_VERSION) {
  throw new Error('no floor at or below LAYOUT_VERSION has a layout below it');
}

/** Every live container under `root`, depth first. */
export function containersOf(root: Y.Node): Y.Node[] {
  const out: Y.Node[] = [];
  const visit = (node: Y.Node) => {
    out.push(node);
    for (let it = node._start; it !== null; it = it.right) {
      if (!it.deleted && it.content instanceof Y.ContentType) {
        visit(it.content.type as Y.Node);
      }
    }
    for (const key of [...node._map.keys()].sort()) {
      const it = node._map.get(key)!;
      if (!it.deleted && it.content instanceof Y.ContentType) {
        visit(it.content.type as Y.Node);
      }
    }
  };
  visit(root);
  return out;
}

/** JSON with object keys sorted. */
export function stableJSON(value: unknown): string {
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

/** A step read: per live countable unit, its plain-fold format values. */
export function readItems(container: Y.Node): string[] {
  const out: string[] = [];
  const values = new Map<string, unknown>();
  for (let it = container._start; it !== null; it = it.right) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof Y.ContentFormat) {
      if (it.content.value === null) {
        values.delete(it.content.key);
      } else {
        values.set(it.content.key, it.content.value);
      }
    } else if (it.countable) {
      const read = stableJSON(Object.fromEntries([...values].sort()));
      for (let unit = 0; unit < it.length; unit++) {
        out.push(read);
      }
    }
  }
  return out;
}

export const NOTHING = {deleted: 0, written: 0};

/** A step from `from` that writes nothing (the runner records the rest). */
export function stamp(
  from: number,
  extra: Partial<YLayoutMigration> = {},
): YLayoutMigration {
  return {
    checkAfter: () => [],
    from,
    id: `lexical-y/layout/${from}to${from + 1}`,
    migrateContainer: () => NOTHING,
    readAfter: readItems,
    readBefore: readItems,
    revision: 1,
    rewrites: () => false,
    to: from + 1,
    v: 1,
    ...extra,
  };
}

/** Insert a format item right after `left`, in `node`. */
export function insertFormatAfter(
  tr: Y.Transaction,
  node: Y.Node,
  left: Y.Item,
  key: string,
  value: unknown,
): void {
  const doc = tr.doc;
  const item = new Y.Item(
    Y.createID(doc.clientID, doc.store.getClock(doc.clientID)),
    left,
    left.lastId,
    left.right,
    left.right === null ? null : left.right.id,
    node,
    null,
    new Y.ContentFormat(key, value as never),
  );
  item.integrate(tr, 0);
}

/**
 * Write every live text format item (`f:*`) of a container again right
 * after itself and delete it, so every item reads the same.
 */
export function rewriteFormats(
  tr: Y.Transaction,
  node: Y.Node,
): {written: number; deleted: number} {
  const olds: Y.Item[] = [];
  for (let it = node._start; it !== null; it = it.right) {
    if (
      !it.deleted &&
      it.content instanceof Y.ContentFormat &&
      it.content.key.startsWith('f:')
    ) {
      olds.push(it);
    }
  }
  for (const old of olds) {
    const {key, value} = old.content as Y.ContentFormat;
    insertFormatAfter(tr, node, old, key, value);
    old.delete(tr);
  }
  return {deleted: olds.length, written: olds.length};
}

/**
 * The invariant the rewrite establishes: every live text format item was
 * written by the client that recorded the root's epoch (a step that only
 * stamps the record fails it).
 */
function rewrittenByEpoch(container: Y.Node): string[] {
  let root: Y.Node = container;
  while (root.parent !== null) {
    root = root.parent as Y.Node;
  }
  const epoch = root.getAttr('lexical-y-epoch') as {client?: number} | null;
  const out: string[] = [];
  for (let it = container._start; it !== null; it = it.right) {
    if (
      !it.deleted &&
      it.content instanceof Y.ContentFormat &&
      it.content.key.startsWith('f:') &&
      (epoch === null || it.id.client !== epoch.client)
    ) {
      out.push(`format item ${it.id.client}.${it.id.clock} not rewritten`);
    }
  }
  return out;
}

/** Test-only step from SEED + 1: rewrites every text format item. */
export const REWRITE = stamp(SEED + 1, {
  checkAfter: rewrittenByEpoch,
  migrateContainer: rewriteFormats,
  rewrites: key => key.startsWith('f:'),
});

/** Test-only step from SEED: writes nothing. */
export const STAMP = stamp(SEED);

/** A step from SEED + 1 that stamps only, with REWRITE's check: must fail. */
export const NO_OP_REWRITE = stamp(SEED + 1, {
  checkAfter: rewrittenByEpoch,
  rewrites: key => key.startsWith('f:'),
});

/**
 * A raw document at `layout` (any layout's reader reads it the same: one
 * paragraph of plain text, no format items): the root records the layout
 * and schema version 1 and holds `text` then a line marker.
 */
export function rawDoc(layout: number, text = 'abc'): Uint8Array {
  const doc = new Y.Doc({gc: false});
  doc.cleanupFormatting = false;
  doc.clientID = 80;
  const root = doc.get('lexical-y');
  doc.transact(() => {
    root.setAttr('lexical-y:' + layout, true);
    root.setAttr('lexical-y-schema:1', true);
    root.insert(0, text);
    root.insert(text.length, [new Y.Node('¶')]);
  });
  return Y.encodeStateAsUpdate(doc);
}

/** Whether `root`'s record, as it is now, is one the binding writes. */
export function admitted(root: Y.Node): boolean {
  const keys = Object.keys(root.getAttrs()).filter(k =>
    k.startsWith('lexical-y:'),
  );
  const versions = keys.map(k => k.slice('lexical-y:'.length));
  if (keys.length === 0 || versions.some(v => !/^[1-9][0-9]*$/.test(v))) {
    return false;
  }
  const layout = Math.max(...versions.map(Number));
  return layout >= FLOOR && layout <= LAYOUT_VERSION;
}
