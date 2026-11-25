/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @lexical/y/migrate/2to3: the frozen step from layout 2 to layout 3
// (paired format runs, D101). EXPERIMENTAL. FROZEN: a change to what it
// writes bumps `revision` and adds golden fixtures; the existing ones are
// never regenerated. It imports `@y/y` and its own frozen sources only.
//
// Per container (the runner owns traversal): the frozen layout 2 read
// (./2to3/frozen/fold2) gives each countable unit's stored value for every
// covered key; the frozen copy of the layout 3 writer (./2to3/frozen/layout3)
// deletes every live covered format item of the container and writes the
// canonical paired runs that reproduce those values. Content, uncovered
// format items (flat NodeState) and every attribute (marker attributes
// included) are untouched: layout 3 stores them as layout 2 does.
//
// Equality is defined once: readBefore and readAfter give, per countable
// unit (each UTF-16 unit of a string, each type or embed), the JSON of
// {covered key: value} as the writer stores it (its storedUnit: JSON's value,
// a raw array as `{json}`), on both sides. checkAfter asserts layout 3's own
// invariants, so a step that only records the layout cannot pass on equal
// reads.

import type {YLayoutMigration} from '../internal/Runner';

import {
  ContentFormat,
  type Item,
  type Node as YNode,
  type Transaction,
} from '@y/y';

import {foldLayout2Units} from './2to3/frozen/fold2';
import {
  isCoveredKey,
  readLayout3Formats,
  storedUnit,
  writeLayout3Formats,
} from './2to3/frozen/layout3';

/**
 * One unit's read: {covered key: value} as the writer stores it (the frozen
 * writer's storedUnit: JSON's value, a raw array as `{json}`), keys in
 * code-unit order, each value as its stable JSON.
 */
function readOf(values: ReadonlyMap<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, [signature]] of storedUnit(values)) {
    parts.push(JSON.stringify(key) + ':' + signature);
  }
  return '{' + parts.join(',') + '}';
}

function readBefore(container: YNode): string[] {
  return foldLayout2Units(container).map(readOf);
}

function readAfter(container: YNode): string[] {
  return readLayout3Formats(container).map(readOf);
}

/** The opener an end names ("client:clock"), or null for any other value. */
function endTarget(it: Item, value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (
    value.length === 1 &&
    Number.isSafeInteger(value[0]) &&
    (value[0] as number) > 0
  ) {
    return `${it.id.client}:${it.id.clock - (value[0] as number)}`;
  }
  if (
    value.length === 2 &&
    Number.isSafeInteger(value[0]) &&
    Number.isSafeInteger(value[1])
  ) {
    return `${value[0]}:${value[1]}`;
  }
  return null;
}

/**
 * Layout 3's invariants on one container's own sequence: every live covered
 * format item is an opener with a value (not null, not an array) named by
 * exactly one live end of its key after it, or such an end; no `[]` opener.
 */
function checkAfter(container: YNode): string[] {
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
    if (!isCoveredKey(key)) {
      continue;
    }
    const target = endTarget(it, value);
    if (target !== null) {
      const opener = openers.get(target);
      if (opener === undefined || opener.key !== key) {
        problems.push(`invalid end: ${where(it)} names no opener before it`);
      } else {
        opener.ends++;
      }
    } else if (value === null) {
      problems.push(`unpaired null: ${where(it)}`);
    } else if (Array.isArray(value)) {
      problems.push(
        value.length === 0
          ? `[] opener: ${where(it)}`
          : `raw array: ${where(it)}`,
      );
    } else {
      openers.set(`${it.id.client}:${it.id.clock}`, {ends: 0, item: it, key});
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

const step2to3: YLayoutMigration = {
  checkAfter,
  from: 2,
  id: 'lexical-y/layout/2to3',
  migrateContainer(
    tr: Transaction,
    container: YNode,
  ): {written: number; deleted: number} {
    return writeLayout3Formats(tr, container, foldLayout2Units(container));
  },
  readAfter,
  readBefore,
  revision: 1,
  rewrites: isCoveredKey,
  to: 3,
  v: 1,
};

export default step2to3;
