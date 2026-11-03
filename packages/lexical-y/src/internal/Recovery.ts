/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {type Doc, encodeStateAsUpdate, GC, type ID, Item, Skip} from '@y/y';

// Through the public entry (external in the build), as Server.ts does.
import {migrateYState, type YLayoutMigration} from '../migrate';
import {type ClientIDRange} from './ClientID';
import {DEFAULT_ROOT_NAME, LAYOUT_VERSION} from './constants';
import {existingRoot} from './Layouts';
import {sourceView, type YQuarantineRecord} from './Server';

// The recovery view's state of a quarantine record (@lexical/y/server;
// y-server.md, "Quarantine, capture and the handoff"): its source view
// migrated on a scratch copy to the current layout, for rendering only. Yjs only, no Lexical: an
// authority builds it with the steps it ships and serves it to a client
// that renders it with its own read-only editor, so no client carries
// migration code.

/** @experimental Options of recoveryYState. */
export interface YRecoveryOptions {
  /** The layout to migrate to (default LAYOUT_VERSION of this build). */
  readonly to?: number;
  /** The roots to migrate (default `['lexical-y']`). */
  readonly roots?: readonly string[];
  readonly clientIDRange?: ClientIDRange;
}

/**
 * Make `doc` whole for rendering: every skipped range becomes a collected
 * struct (a GC struct of the same length, so each client's clocks stay
 * contiguous) and pending material is dropped. Nothing integrated depends
 * on a skipped range (an item whose origin or parent is missing stays
 * pending), so every integrated item keeps its place; what stays pending
 * cannot be placed and is not shown.
 */
function fillGaps(doc: Doc): void {
  const store = doc.store;
  for (const client of [...store.skips.clients.keys()]) {
    const structs = store.clients.get(client);
    if (structs === undefined) {
      continue;
    }
    for (let i = 0; i < structs.length; i++) {
      const s = structs[i];
      if (s instanceof Skip) {
        structs[i] = new GC(s.id as ID, s.length) as unknown as Skip;
      }
    }
  }
  store.skips.clients.clear();
  store.pendingStructs = null;
  store.pendingDs = null;
}

/**
 * Delete, in the scratch copy, the items of the record's legacy signals
 * (exact matches: the signal's id, root, key and the value true), so the
 * view does not render the "newer version" the signal recorded.
 */
function dropSignals(doc: Doc, record: YQuarantineRecord): void {
  const signals = record.signals.filter(sg => {
    const structs = doc.store.clients.get(sg.client);
    if (structs === undefined) {
      return false;
    }
    const s = structs.find(
      st => st.id.clock <= sg.clock && sg.clock < st.id.clock + st.length,
    );
    if (!(s instanceof Item) || s.id.clock !== sg.clock || s.length !== 1) {
      return false;
    }
    const content: Item['content'] = s.content;
    return (
      s.parent === existingRoot(doc, sg.root) &&
      s.parentSub === sg.key &&
      content.getContent()[0] === true
    );
  });
  if (signals.length === 0) {
    return;
  }
  doc.transact(tr => {
    for (const sg of signals) {
      const s = doc.store.clients
        .get(sg.client)!
        .find(st => st.id.clock === sg.clock) as Item;
      s.delete(tr);
    }
  });
}

/**
 * @experimental The state a recovery view renders for a quarantine record:
 * its source view (a `pending` record: its snapshot, the whole stored state
 * it was split from, or `base` when it has none, plus its bytes) migrated
 * on a scratch copy to the current layout with `steps`, through any gap:
 * a skipped range becomes collected structs and pending material is
 * dropped instead of splitting what follows, so items a migration cut
 * stay visible in place. Items of the record's legacy signals are left
 * out. Throws a YMigrationError when a step refuses.
 *
 * RENDER ONLY. The result holds collected structs the record never had
 * (where its gaps were) and a migration under scratch client ids: never
 * store it, send it into a room, merge it with another state or replay
 * it. Replay works on the record itself (replayYRecovery).
 */
export function recoveryYState(
  record: YQuarantineRecord,
  steps: readonly YLayoutMigration[],
  base: Uint8Array | null = null,
  options: YRecoveryOptions = {},
): Uint8Array {
  const snapshot = record.snapshot ?? base;
  const view = sourceView({
    deltas: record.deltas,
    queue: record.queue,
    snapshot,
  }).doc;
  try {
    dropSignals(view, record);
    fillGaps(view);
    const state = encodeStateAsUpdate(view);
    return migrateYState(state, steps, {
      clientIDRange: options.clientIDRange,
      gc: false,
      roots: options.roots ?? [DEFAULT_ROOT_NAME],
      to: options.to ?? LAYOUT_VERSION,
    }).state;
  } finally {
    view.destroy();
  }
}
