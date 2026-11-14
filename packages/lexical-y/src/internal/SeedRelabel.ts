/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {ContentFormat, createID, type Doc, Item} from '@y/y';

import {INSTANCE_KEY, SEGMENT_KEY, WRAPPER_PREFIX} from './Schema';

/**
 * For tests: `enabled` false writes every seed twice, as before relabeling
 * (to compare the two); `relabeled` counts the seeds relabeled.
 */
export const SEED_RELABEL_TEST_HOOKS: {enabled: boolean; relabeled: number} = {
  enabled: true,
  relabeled: 0,
};

/**
 * Give everything a seed wrote into the scratch document `doc` under the
 * client id `from` the client id `to`, in place, as if it had been written
 * under `to`: the items' ids and origins, and the segment and instance keys
 * the writer derived from the client id (see State#newSegment). The writer
 * gives the same items for the same input under any client id (a seed's
 * clocks start at 0 either way, and every other value it stores is relative
 * to its own clocks), so encoding `doc` afterwards gives the bytes a second
 * write under `to` would. Returns false, changing nothing, where `doc` holds
 * anything else (another client's structs, pending updates, a struct that
 * is not an item): the seed is then written again under `to`.
 */
export function relabelSeed(doc: Doc, from: number, to: number): boolean {
  const store = doc.store;
  const structs = store.clients.get(from);
  if (
    !SEED_RELABEL_TEST_HOOKS.enabled ||
    structs === undefined ||
    store.clients.size !== 1 ||
    store.pendingStructs !== null ||
    store.pendingDs !== null ||
    !structs.every(s => s instanceof Item && s.redone === null)
  ) {
    return false;
  }
  const prefix = from.toString(36) + '.';
  const next = to.toString(36) + '.';
  const relabelKey = (key: unknown): unknown =>
    typeof key === 'string' && key.startsWith(prefix)
      ? next + key.slice(prefix.length)
      : key;
  for (const struct of structs as Item[]) {
    struct.id = createID(to, struct.id.clock);
    const {origin, rightOrigin, content} = struct;
    if (origin !== null && origin.client === from) {
      struct.origin = createID(to, origin.clock);
    }
    if (rightOrigin !== null && rightOrigin.client === from) {
      struct.rightOrigin = createID(to, rightOrigin.clock);
    }
    if (content instanceof ContentFormat) {
      const {key, value} = content;
      if (key === SEGMENT_KEY) {
        content.value = relabelKey(value) as object;
      } else if (
        key.startsWith(WRAPPER_PREFIX) &&
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        INSTANCE_KEY in value
      ) {
        const instance = (value as Record<string, unknown>)[INSTANCE_KEY];
        const renamed = relabelKey(instance);
        if (renamed !== instance) {
          // Spread keeps the key order, which the encoding follows.
          content.value = {...value, [INSTANCE_KEY]: renamed};
        }
      }
    }
  }
  store.clients.delete(from);
  store.clients.set(to, structs);
  doc.clientID = to;
  SEED_RELABEL_TEST_HOOKS.relabeled++;
  return true;
}
