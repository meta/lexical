/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import * as Y from '@y/y';
import {$createTextNode, $getRoot, $isElementNode} from 'lexical';
import {describe, expect, test} from 'vitest';

import {LAYOUT_VERSION} from '../..';
import {createYWriter, editYState, readYState} from '../../headless';
import step1to2 from '../../migrate/1to2';
import {
  captureYSession,
  createYDoc,
  pendingYRecord,
  prepareYRoom,
  quarantineRecord,
  recoveryYState,
} from '../../server';
import {$snapshot, catalogHeadlessConfig, seedShapes} from '../catalog/bind';
import {NODE_SHAPES, shapesWith} from '../catalog/nodes';

// recoveryYState: the state a recovery view renders for a quarantine record
// (y-server.md, "Quarantine, capture and the handoff"): its source view
// migrated on a scratch copy through any gap.

const CFG = {blockIds: 'absent'} as const;
const config = catalogHeadlessConfig(CFG);
const steps = [step1to2];
const ROOT = 'lexical-y';

const source = {
  generation: 'inc-1/-',
  incarnation: 'inc-1',
  layouts: [1, 2] as [number, number],
  renderer: null,
  schemaVersion: 1,
};

function layoutOf(state: Uint8Array): number | null {
  const doc = createYDoc(state);
  try {
    let layout: number | null = null;
    for (const key of Object.keys(doc.get(ROOT).getAttrs())) {
      const m = /^lexical-y:(\d+)$/.exec(key);
      if (m !== null) {
        layout = Math.max(layout ?? 0, Number(m[1]));
      }
    }
    return layout;
  } finally {
    doc.destroy();
  }
}

const read = (state: Uint8Array) => readYState(state, config, $snapshot).json;
const text = (state: Uint8Array) =>
  readYState(state, config, () => $getRoot().getTextContent());

/**
 * The update that appends `str` to block `index` of `state`, written as
 * `writer` (a writer continues its client id across calls).
 */
function append(
  state: Uint8Array,
  index: number,
  str: string,
  writer: ReturnType<typeof createYWriter> | null = null,
): Uint8Array {
  const {update} = editYState(
    state,
    config,
    () => {
      const block = $getRoot().getChildAtIndex(index);
      if (!$isElementNode(block)) {
        throw new Error(`block ${index} is not an element`);
      }
      block.append($createTextNode(str));
    },
    {writer},
  );
  return update!;
}

const merge = (a: Uint8Array, b: Uint8Array) =>
  Y.mergeUpdates([a, b] as Uint8Array<ArrayBuffer>[]);

function isWhole(state: Uint8Array): boolean {
  const doc = createYDoc(state, {gc: false});
  try {
    return (
      doc.store.skips.isEmpty() &&
      doc.store.pendingStructs === null &&
      doc.store.pendingDs === null
    );
  } finally {
    doc.destroy();
  }
}

describe.each([false, true])('gc %s', gc => {
  test('a capture record at layout 1 renders at the current layout, its signal left out', () => {
    const stored = seedShapes([NODE_SHAPES[0], shapesWith('table')[0]], CFG);
    expect(layoutOf(stored)).toBe(1);
    // The legacy client's document: the stored state, then its own edit (a
    // delta it sends after its snapshot).
    const client = createYDoc(stored, {gc});
    const capture = captureYSession();
    capture.add(Y.encodeStateAsUpdate(client));
    const signal = capture.signal(1);
    expect(signal).not.toBe(null);
    // The client edits before the signal reaches it, then applies it (it
    // turns read only); what it sends later carries the signal's item back.
    const vector = Y.encodeStateVector(client);
    const delta = append(Y.encodeStateAsUpdate(client), 0, ' legacy edit');
    Y.applyUpdate(client, delta);
    Y.applyUpdate(client, signal!.update);
    capture.add(Y.encodeStateAsUpdate(client, vector));
    const record = quarantineRecord({
      ...capture.material(),
      kind: 'capture',
      receivedAt: 0,
      source: {...source, generation: 'unknown', incarnation: null},
    });
    const view = recoveryYState(record, steps);
    expect(layoutOf(view)).toBe(LAYOUT_VERSION);
    expect(isWhole(view)).toBe(true);
    // Reads as the client's own document read at layout 1 (without the
    // signal, which a reader of a newer schema version would refuse).
    const own = createYDoc(Y.encodeStateAsUpdate(client), {gc: false});
    own.transact(() => own.get(ROOT).deleteAttr(signal!.key));
    expect(read(view)).toEqual(read(Y.encodeStateAsUpdate(own)));
    own.destroy();
    expect(text(view)).toContain('legacy edit');
    // The signal's "newer version" is not in the view.
    const doc = createYDoc(view);
    expect(
      Object.keys(doc.get(ROOT).getAttrs()).filter(k =>
        k.startsWith('lexical-y-schema:'),
      ),
    ).toEqual(['lexical-y-schema:1']);
    doc.destroy();
  });

  test('a pending record with a skipped range shows the items the migration cut, in place', () => {
    const S0 = seedShapes([NODE_SHAPES[0], NODE_SHAPES[0]], CFG);
    // One writer edits the second block, then the first: two updates of one
    // client id, the second anchored in the seed only.
    const writer = createYWriter('client');
    const first = append(S0, 1, 'MISSING', writer);
    const second = append(merge(S0, first), 0, 'LATE', writer);
    // The stored state received the second update only: LATE sits past the
    // gap of that client.
    const sparse = createYDoc(S0, {gc});
    Y.applyUpdate(sparse, second);
    expect(sparse.store.skips.isEmpty()).toBe(false);
    const stored = Y.encodeStateAsUpdate(sparse);
    expect(text(stored)).toContain('LATE');
    const prepared = prepareYRoom(stored, {
      gc,
      incarnation: 'inc-1',
      steps,
      to: 2,
    });
    expect(prepared.changed).toBe(true);
    expect(prepared.pending).not.toBe(null);
    // The migrated room lacks LATE (cut with the gap)...
    expect(text(prepared.state)).not.toContain('LATE');
    const record = pendingYRecord({
      pending: prepared.pending!,
      receivedAt: 0,
      source,
      stored,
    });
    // ...the recovery view shows it, where it was.
    const view = recoveryYState(record, steps);
    expect(layoutOf(view)).toBe(LAYOUT_VERSION);
    expect(isWhole(view)).toBe(true);
    expect(text(view)).toBe(text(stored));
    expect(read(view)).toEqual(read(stored));
  });

  test('a pending record without a snapshot is read on the base given', () => {
    const S0 = seedShapes([NODE_SHAPES[0]], CFG);
    const record = quarantineRecord({
      deltas: [append(S0, 0, 'CUT')],
      kind: 'pending',
      receivedAt: 0,
      snapshot: null,
      source,
    });
    const view = recoveryYState(record, steps, S0);
    expect(layoutOf(view)).toBe(LAYOUT_VERSION);
    expect(text(view)).toContain('CUT');
  });

  test('a record already at the current layout renders as it is, and the inputs are untouched', () => {
    const S0 = seedShapes([NODE_SHAPES[0]], CFG);
    const migrated = prepareYRoom(S0, {
      gc,
      incarnation: 'inc-1',
      steps,
      to: 2,
    }).state;
    const record = quarantineRecord({
      kind: 'handoff',
      receivedAt: 0,
      snapshot: migrated,
      source,
    });
    const before = Uint8Array.from(migrated);
    const view = recoveryYState(record, steps);
    expect(layoutOf(view)).toBe(LAYOUT_VERSION);
    expect(read(view)).toEqual(read(migrated));
    expect(migrated).toEqual(before);
  });
});
