/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// FROZEN (@lexical/y/migrate/2to3): never edited after release; a change to
// what it reads is a new revision of the step, with new golden fixtures.
//
// The layout 1 and layout 2 read of one container's own sequence, as the
// binding read it before layout 3 (the plain fold): walking the live items
// in order, a format item with a value sets its key, one with null removes
// it; each live countable unit shows the keys set where it stands. Only
// covered keys (./layout3 isCoveredKey) are kept, with their stored values
// verbatim: no decoding, no normalization (the writer turns a raw array
// into `{json}`; the step's reads normalize both sides).
//
// One rule on top of the fold, as the binding read it: a tab's type
// (`t: 'tab'`) and its segment key `k` apply to `\t` units only; any other
// unit inside a tab's range (an opener left open) reads as plain text, so
// it shows neither.

import {
  ContentFormat,
  ContentString,
  type Item,
  type Node as YNode,
} from '@y/y';

import {isCoveredKey} from './layout3';

/** The values one unit shows: `t`/`k` of a tab only on `\t` (see above). */
function unitValues(
  current: ReadonlyMap<string, unknown>,
  unit: string | null,
): Map<string, unknown> {
  const out = new Map(current);
  if (out.get('t') === 'tab' && unit !== '\t') {
    out.delete('t');
    out.delete('k');
  }
  return out;
}

/** Covered key → stored value, per countable unit (the writer's input). */
export function foldLayout2Units(container: YNode): Map<string, unknown>[] {
  const current = new Map<string, unknown>();
  const out: Map<string, unknown>[] = [];
  for (let it = container._start; it !== null; it = it.right as Item | null) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof ContentFormat) {
      const {key, value} = it.content;
      if (!isCoveredKey(key)) {
        continue;
      }
      if (value === null) {
        current.delete(key);
      } else {
        current.set(key, value);
      }
    } else if (it.countable) {
      const str = it.content instanceof ContentString ? it.content.str : null;
      for (let i = 0; i < it.length; i++) {
        out.push(unitValues(current, str === null ? null : str[i]));
      }
    }
  }
  return out;
}
