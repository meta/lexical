/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @lexical/y/migrate/3to4: the frozen step from layout 3 to layout 4 (flat
// NodeState on text stored as paired runs, D120). EXPERIMENTAL. FROZEN: a
// change to what it writes bumps `revision` and adds golden fixtures; the
// existing ones are never regenerated. It takes no parameters: for fixed
// input bytes it writes fixed output bytes. It imports `@y/y` and frozen
// sources only.
//
// Per container (the runner owns traversal), step 0: a container that holds
// no live item of a flat NodeState name (`s:<key>` without U+001F, any
// value) and already meets layout 4's pairing invariant (see
// pairedRunProblems) is skipped: it is valid layout 4 and reads the same
// under both layouts, so it keeps its bytes. Every other container is rewritten: the frozen layout 3 read
// (./3to4/frozen/read3) gives each countable unit's stored value for every
// name layout 4 covers, flat NodeState (`s:<key>`) by the plain fold it had
// in layout 3; the frozen layout 4 writer (./3to4/frozen/layout4) deletes
// every live format item of a covered name but the reserved shapes, which
// stay where they are, and writes the canonical paired runs that reproduce
// those values. So a run that was left dangling (an opener whose end is
// gone, an end naming nothing) is migrated by what it showed: a value that
// read as open to the end of its container is a paired run ending at the
// container's last unit. Content, format items of any other name and every
// attribute (marker attributes included) are untouched.
//
// Equality is defined once: readBefore and readAfter give, per countable
// unit (each UTF-16 unit of a string, each type or embed), the JSON of
// {covered name: value} as the writer stores it (its storedUnit: JSON's
// value, a raw array as `{json}`), on both sides. checkAfter asserts layout
// 4's own invariants, so a step that only records the layout cannot pass on
// equal reads. A skipped container (no live flat item left after the step)
// is checked against the pairing invariant only, not the canonical form: it
// keeps whatever history its writers left that the invariant allows (a
// paired `[]` opener, ends naming deleted or collected openers, several ends
// for one opener).

import type {YLayoutMigration} from '../internal/Runner';

import {
  ContentDeleted,
  ContentFormat,
  type Item,
  type Node as YNode,
  type Transaction,
} from '@y/y';

import {
  endTargetOf,
  isCoveredKey,
  isReserved,
  readLayout4Formats,
  storedUnit,
  writeLayout4Formats,
} from './3to4/frozen/layout4';
import {isFlatStateKey, readLayout3Units} from './3to4/frozen/read3';

/**
 * One unit's read: {covered name: value} as the writer stores it (the
 * frozen writer's storedUnit: JSON's value, a raw array as `{json}`), names
 * in code-unit order, each value as its stable JSON.
 */
function readOf(values: ReadonlyMap<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, [signature]] of storedUnit(values)) {
    parts.push(JSON.stringify(key) + ':' + signature);
  }
  return '{' + parts.join(',') + '}';
}

function readBefore(container: YNode): string[] {
  return readLayout3Units(container).map(readOf);
}

function readAfter(container: YNode): string[] {
  return readLayout4Formats(container).map(readOf);
}

/** Whether `container` holds a live item of a flat NodeState name. */
function holdsFlatState(container: YNode): boolean {
  for (let it = container._start; it !== null; it = it.right as Item | null) {
    if (
      !it.deleted &&
      it.content instanceof ContentFormat &&
      isFlatStateKey(it.content.key)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Layout 4's pairing invariant on one container's own sequence, for its
 * covered names: every live opener (a value, or `[]`) is named by a live
 * end of its name after it; every live end names an opener of its name
 * before it in this container, live or deleted, or an item before it in
 * this container whose content was collected (`ContentDeleted`: its name is
 * gone); no plain `null`. Reserved shapes name nothing and are left out.
 * Only the container's own sequence is read, so an end naming any other
 * item (text, an end, another container's item, or nothing) is a problem.
 */
function pairedRunProblems(container: YNode): string[] {
  const problems: string[] = [];
  const where = (it: Item) =>
    `${(it.content as ContentFormat).key} at ${it.id.client}.${it.id.clock}`;
  // Openers before the cursor, live or deleted, by "client:clock".
  const before = new Map<string, string>();
  // Collected items before the cursor: [client, first clock, end clock).
  const collected: [number, number, number][] = [];
  const isCollected = (target: string): boolean => {
    const colon = target.indexOf(':');
    const client = Number(target.slice(0, colon));
    const clock = Number(target.slice(colon + 1));
    return collected.some(
      ([c, from, to]) => c === client && clock >= from && clock < to,
    );
  };
  const named = new Set<string>();
  const openers: Item[] = [];
  for (let it = container._start; it !== null; it = it.right as Item | null) {
    if (it.content instanceof ContentDeleted) {
      collected.push([it.id.client, it.id.clock, it.id.clock + it.length]);
      continue;
    }
    if (!(it.content instanceof ContentFormat)) {
      continue;
    }
    const {key, value} = it.content;
    if (!isCoveredKey(key)) {
      continue;
    }
    const id = `${it.id.client}:${it.id.clock}`;
    const isOpener = !Array.isArray(value) || value.length === 0;
    if (it.deleted) {
      if (isOpener && value !== null) {
        before.set(id, key);
      }
      continue;
    }
    if (isReserved(it)) {
      continue;
    }
    if (value === null) {
      problems.push(`unpaired null: ${where(it)}`);
    } else if (isOpener) {
      before.set(id, key);
      openers.push(it);
    } else {
      const target = endTargetOf(it);
      const opener = target === null ? undefined : before.get(target);
      if (opener === key) {
        named.add(target!);
      } else if (opener !== undefined) {
        problems.push(`invalid end: ${where(it)} names another name`);
      } else if (target === null || !isCollected(target)) {
        problems.push(`invalid end: ${where(it)} names no opener before it`);
      }
    }
  }
  for (const it of openers) {
    if (!named.has(`${it.id.client}:${it.id.clock}`)) {
      problems.push(`unpaired opener: ${where(it)}`);
    }
  }
  return problems;
}

/** Step 0: whether the step leaves `container` as it is (see the header). */
function skips(container: YNode): boolean {
  return (
    !holdsFlatState(container) && pairedRunProblems(container).length === 0
  );
}

/**
 * Layout 4's invariants on one container's own sequence: every live format
 * item of a covered name is an opener with a value (not null, not an
 * array) named by exactly one live end of its name after it, such an end,
 * or a reserved shape. So no covered name holds a plain null, a `[]`
 * opener, an unpaired value or an end naming nothing.
 */
function checkAfter(container: YNode): string[] {
  // A skipped container: the pairing invariant only (the runner checks
  // read equality).
  if (!holdsFlatState(container)) {
    const i3 = pairedRunProblems(container);
    if (i3.length === 0) {
      return i3;
    }
  }
  const problems: string[] = [];
  const where = (it: Item) =>
    `${(it.content as ContentFormat).key} at ${it.id.client}.${it.id.clock}`;
  // Openers seen so far (live, covered, with a value), by "client:clock".
  const openers = new Map<string, {key: string; item: Item; ends: number}>();
  for (let it = container._start; it !== null; it = it.right as Item | null) {
    if (it.deleted || !(it.content instanceof ContentFormat)) {
      continue;
    }
    const {key, value} = it.content;
    if (!isCoveredKey(key) || isReserved(it)) {
      continue;
    }
    if (value === null) {
      problems.push(`unpaired null: ${where(it)}`);
    } else if (!Array.isArray(value)) {
      openers.set(`${it.id.client}:${it.id.clock}`, {ends: 0, item: it, key});
    } else if (value.length === 0) {
      problems.push(`[] opener: ${where(it)}`);
    } else {
      const target = endTargetOf(it);
      const opener = target === null ? undefined : openers.get(target);
      if (opener === undefined || opener.key !== key) {
        problems.push(`invalid end: ${where(it)} names no opener before it`);
      } else {
        opener.ends++;
      }
    }
  }
  for (const {item, ends} of openers.values()) {
    if (ends !== 1) {
      problems.push(
        ends === 0
          ? `unpaired opener: ${where(item)}`
          : `${ends} ends name ${where(item)}`,
      );
    }
  }
  return problems;
}

const step3to4: YLayoutMigration = {
  checkAfter,
  from: 3,
  id: 'lexical-y/layout/3to4',
  migrateContainer(
    tr: Transaction,
    container: YNode,
  ): {written: number; deleted: number} {
    if (skips(container)) {
      return {deleted: 0, written: 0};
    }
    return writeLayout4Formats(tr, container, readLayout3Units(container));
  },
  readAfter,
  readBefore,
  revision: 1,
  rewrites: isCoveredKey,
  to: 4,
  v: 1,
};

export default step3to4;
