/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// FROZEN (@lexical/y/migrate/1to2): never edited after release; a change
// to what it reads is a new revision of the step, with new golden fixtures.
//
// The layout 1 and layout 2 read of one container, for the runner's
// equality check: for every live countable unit of its sequence (each
// UTF-16 code unit of a string item, each embed or type item once), the
// stable JSON of the value of every format key the plain fold gives it (a
// value sets its key, null removes it). Layout 2 reads every layout 1
// document the same way: the binding at layout 2 reads member entries
// (`s:<key>\u001f<member>`) whatever the record says, and branches on the
// record only in its gate (a newer layout opens read only) and in what it
// records when it writes. So one read serves both sides.

import {ContentFormat, type Node as YNode} from '@y/y';

/** JSON with object keys sorted by code unit. */
function stableJSON(value: unknown): string {
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

/** The layout 1 / layout 2 read of one container. */
export function readLayout12(container: YNode): string[] {
  const out: string[] = [];
  const values = new Map<string, unknown>();
  for (let it = container._start; it !== null; it = it.right) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof ContentFormat) {
      if (it.content.value === null) {
        values.delete(it.content.key);
      } else {
        values.set(it.content.key, it.content.value);
      }
    } else if (it.countable) {
      const shown: Record<string, unknown> = {};
      for (const key of [...values.keys()].sort()) {
        shown[key] = values.get(key);
      }
      const read = stableJSON(shown);
      for (let unit = 0; unit < it.length; unit++) {
        out.push(read);
      }
    }
  }
  return out;
}
