/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Test-only helpers for the 3to4 step's tests: the step's own invariants on
// a migrated document, and the live format items of a document by id.

import * as Y from '@y/y';

import step3to4 from '../../migrate/3to4';
import {isReserved} from '../../migrate/3to4/frozen/layout4';
import {containersOf} from './migrate2to3';

/** checkAfter over every container of `root` in `state` (problems). */
export function layout4Problems(
  state: Uint8Array,
  gc: boolean,
  root = 'lexical-y',
): string[] {
  const doc = new Y.Doc({gc});
  Y.applyUpdate(doc, state);
  return containersOf(doc.get(root)).flatMap(c => [...step3to4.checkAfter(c)]);
}

/** One live format item of `state`: its id, name and value, and its kind. */
export type FormatItem = {
  id: string;
  key: string;
  value: unknown;
  /** Whether the step rewrites its name (a covered name). */
  covered: boolean;
  /** Whether it holds a reserved shape (kept by the step). */
  reserved: boolean;
};

/** Every live format item under `root`, in container then item order. */
export function formatItems(
  state: Uint8Array,
  root = 'lexical-y',
): FormatItem[] {
  const doc = new Y.Doc({gc: false});
  Y.applyUpdate(doc, state);
  const out: FormatItem[] = [];
  for (const c of containersOf(doc.get(root))) {
    for (let it = c._start; it !== null; it = it.right as Y.Item | null) {
      if (!it.deleted && it.content instanceof Y.ContentFormat) {
        const covered = step3to4.rewrites(it.content.key);
        out.push({
          covered,
          id: `${it.id.client}.${it.id.clock}`,
          key: it.content.key,
          reserved: covered && isReserved(it),
          value: it.content.value,
        });
      }
    }
  }
  return out;
}

/** Every live countable unit under `root`: "client.clock=content". */
export function contentIds(state: Uint8Array, root = 'lexical-y'): string[] {
  const doc = new Y.Doc({gc: false});
  Y.applyUpdate(doc, state);
  const out: string[] = [];
  for (const c of containersOf(doc.get(root))) {
    for (let it = c._start; it !== null; it = it.right as Y.Item | null) {
      if (it.deleted || !it.countable) {
        continue;
      }
      const str = it.content instanceof Y.ContentString ? it.content.str : null;
      for (let i = 0; i < it.length; i++) {
        out.push(
          `${it.id.client}.${it.id.clock + i}=${str === null ? '[node]' : JSON.stringify(str[i])}`,
        );
      }
    }
  }
  return out;
}
