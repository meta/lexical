/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Test-only: migrate a document written before paired runs (a capture) the way
// the migration steps do: per container, the stored values today's plain fold
// finds (covered keys), rewritten by writeLayout4Formats; then the record.

import * as Y from '@y/y';

import {
  isCoveredKey,
  writeLayout4Formats,
} from '../../migrate/3to4/frozen/layout4';

function legacyValues(container: Y.Node): Map<string, unknown>[] {
  const formats = new Map<string, unknown>();
  const out: Map<string, unknown>[] = [];
  for (
    let it = container._start as Y.Item | null;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof Y.ContentFormat) {
      const {key, value} = it.content;
      if (value === null) {
        formats.delete(key);
      } else {
        formats.set(key, value);
      }
    } else if (it.countable) {
      const m = new Map<string, unknown>();
      for (const [k, v] of formats) {
        if (isCoveredKey(k)) {
          m.set(k, v);
        }
      }
      // A tab's type and segment key apply to its `\t` only (main's
      // tabRuns): other text in its range reads as plain.
      const str = (it.content as unknown as {str?: string}).str;
      if (m.get('t') === 'tab' && str !== undefined) {
        const plain = new Map(m);
        plain.delete('t');
        plain.delete('k');
        for (const ch of str) {
          for (let u = 0; u < ch.length; u++) {
            out.push(ch === '\t' ? m : plain);
          }
        }
        continue;
      }
      for (let i = 0; i < it.length; i++) {
        out.push(m);
      }
    }
  }
  return out;
}

function containers(node: Y.Node, out: Y.Node[]): Y.Node[] {
  out.push(node);
  for (
    let it = node._start as Y.Item | null;
    it !== null;
    it = it.right as Y.Item | null
  ) {
    const c = it.content as unknown as {type?: unknown};
    if (!it.deleted && c.type instanceof Y.Node) {
      containers(c.type, out);
    }
  }
  for (const it of node._map.values()) {
    const c = it.content as unknown as {type?: unknown};
    if (!it.deleted && c.type instanceof Y.Node) {
      containers(c.type, out);
    }
  }
  return out;
}

/** Migrate `root` of `doc` to layout 4 (see the header). */
export function migrateToLayout4(doc: Y.Doc, root: Y.Node): void {
  doc.transact(tr => {
    for (const c of containers(root, [])) {
      writeLayout4Formats(tr, c, legacyValues(c));
    }
    root.setAttr('lexical-y:4', true);
  });
}

/** The client id the test-only migration writes under (see migratedState). */
export const MIGRATOR_ID = 999_999_937;

/**
 * A state captured before paired runs, migrated to layout 4 (see
 * migrateToLayout4) under MIGRATOR_ID: for repro cells that replay such a
 * capture, which the binding opens read only. Updates captured after it (a
 * legacy client's) apply on top as a raw writer's.
 */
export function migratedState(
  update: Uint8Array,
  rootName = 'lexical-y',
): Uint8Array<ArrayBuffer> {
  const doc = new Y.Doc({gc: false});
  (doc as unknown as {cleanupFormatting: boolean}).cleanupFormatting = false;
  doc.clientID = MIGRATOR_ID;
  Y.applyUpdate(doc, update);
  migrateToLayout4(doc, doc.get(rootName));
  const out = Y.encodeStateAsUpdate(doc) as Uint8Array<ArrayBuffer>;
  doc.destroy();
  return out;
}
