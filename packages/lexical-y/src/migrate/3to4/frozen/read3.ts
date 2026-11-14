/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// FROZEN (@lexical/y/migrate/3to4): never edited after release; a change to
// what it reads is a new revision of the step, with new golden fixtures.
//
// The layout 3 read of one container's own sequence, for every name layout
// 4 covers, per countable unit, with the stored values verbatim (no
// decoding, no normalization: the step's reads normalize both sides):
//
// - the names layout 3 covers (`t`, `k`, `f:`, `p:`, `w:` and set members
//   `s:<key>\u001f<member>`) by the paired fold (./layout4's, over those
//   names: layout 3's grammar for them is layout 4's);
// - flat NodeState (`s:<key>` without U+001F), which layout 3 leaves out of
//   the paired grammar, by the plain fold: walking the live items in order,
//   a format item with a value sets its name (an array is a value there,
//   `[]` included), one with null removes it.

import {ContentFormat, type Item, type Node as YNode} from '@y/y';

import {isCoveredKey, readPairedFormats} from './layout4';

/** Whether `key` is a flat NodeState name: `s:<key>` without U+001F. */
export function isFlatStateKey(key: string): boolean {
  return (
    key.charCodeAt(0) === 115 /* s */ &&
    key.charCodeAt(1) === 58 /* : */ &&
    key.indexOf('\u001f', 2) < 0
  );
}

/** Layout 4's covered names → stored value, per countable unit. */
export function readLayout3Units(container: YNode): Map<string, unknown>[] {
  const units = readPairedFormats(
    container,
    key => isCoveredKey(key) && !isFlatStateKey(key),
  );
  const flat = new Map<string, unknown>();
  let at = 0;
  for (let it = container._start; it !== null; it = it.right as Item | null) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof ContentFormat) {
      const {key, value} = it.content;
      if (isFlatStateKey(key)) {
        if (value === null) {
          flat.delete(key);
        } else {
          flat.set(key, value);
        }
      }
    } else if (it.countable) {
      for (let i = 0; i < it.length; i++, at++) {
        for (const [key, value] of flat) {
          units[at].set(key, value);
        }
      }
    }
  }
  return units;
}
