/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Test-only helpers for the 2to3 step's tests: every container under a
// root (the runner's order), the step's own invariants on a migrated
// document, and editor JSON without block ids.

import * as Y from '@y/y';

import step2to3 from '../../migrate/2to3';

/**
 * Every container under `root`, depth first, in the runner's order: the
 * root, each live type of its sequence, then each live type its attributes
 * hold (keys in code-unit order).
 */
export function containersOf(root: Y.Node): Y.Node[] {
  const out: Y.Node[] = [];
  const visit = (node: Y.Node) => {
    out.push(node);
    for (let it = node._start; it !== null; it = it.right as Y.Item | null) {
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

/** checkAfter over every container of `root` in `state` (problems). */
export function layout3Problems(
  state: Uint8Array,
  gc: boolean,
  root = 'lexical-y',
): string[] {
  const doc = new Y.Doc({gc});
  Y.applyUpdate(doc, state);
  return containersOf(doc.get(root)).flatMap(c => [...step2to3.checkAfter(c)]);
}

/** A copy of editor JSON (or any JSON) with every `blockId` field removed. */
export function withoutBlockIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutBlockIds);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k !== 'blockId') {
        out[k] = withoutBlockIds(v);
      }
    }
    return out;
  }
  return value;
}

/** Every `blockId` value in document order. */
export function blockIdsOf(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    value.forEach(v => blockIdsOf(v, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'blockId') {
        out.push(v);
      } else {
        blockIdsOf(v, out);
      }
    }
  }
  return out;
}
