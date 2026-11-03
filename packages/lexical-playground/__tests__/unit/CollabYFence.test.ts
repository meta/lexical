/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  createYWriter,
  editYState,
  readYState,
  seedYState,
} from '@lexical/y/headless';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type ElementNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  handshakeOf,
  layoutOf,
  StoredRoom,
} from '../../scripts/collab-y-fence.mjs';

// The fence of the playground's collab Y relay (scripts/collab-y-fence.mjs):
// the verdict of each handshake row, the migration when a room loads, and
// the handoff (stored once, acknowledged by hash, replayed once).

const config = {schemaVersion: 1};

function seed(text: string): Uint8Array {
  return seedYState(config, () => {
    $getRoot().append($createParagraphNode().append($createTextNode(text)));
  });
}

function append(
  state: Uint8Array,
  text: string,
  index = 0,
  writer: ReturnType<typeof createYWriter> | null = null,
): Uint8Array {
  const {update} = editYState(
    state,
    config,
    () => {
      ($getRoot().getChildAtIndex(index) as ElementNode).append(
        $createTextNode(text),
      );
    },
    {writer},
  );
  return Y.mergeUpdates([state, update!] as Uint8Array<ArrayBuffer>[]);
}

/** Every client id that wrote in `state`: the replica's own here. */
const clientsOf = (state: Uint8Array) => [
  ...Y.decodeStateVector(Y.encodeStateVectorFromUpdate(state)).keys(),
];

const textOf = (state: Uint8Array) =>
  readYState(state, config, () => $getRoot().getTextContent());

const hs = (
  generation: string | null,
  material: boolean,
  layouts: [number, number] = [1, 2],
) => ({generation, layouts, material, seed: 1});

describe('the relay fence', () => {
  test('the handshake comes from the connection URL', () => {
    expect(handshakeOf(new URLSearchParams(''))).toBe(null);
    expect(
      handshakeOf(new URLSearchParams('g=null&m=1&lo=2&hi=2&seed=1')),
    ).toEqual({generation: null, layouts: [2, 2], material: true, seed: 1});
  });

  test('verdicts: bootstrap, admit, stale, refuse-layout, legacy', () => {
    const room = new StoredRoom('r', {floor: 1});
    const empty = room.load();
    expect(room.verdict(empty, hs(null, false))).toMatchObject({
      initialize: true,
      verdict: 'bootstrap',
    });
    room.state = seed('base');
    const doc = room.load();
    const g = room.generation;
    expect(room.verdict(doc, hs(g, true)).verdict).toBe('admit');
    expect(room.verdict(doc, hs(null, false)).verdict).toBe('bootstrap');
    expect(room.verdict(doc, hs('other/-', true)).verdict).toBe('stale');
    expect(room.verdict(doc, hs(null, false, [2, 2])).verdict).toBe(
      'refuse-layout',
    );
    expect(room.verdict(doc, hs(g, true, [2, 2])).verdict).toBe('stale');
    // A room made after the fence: a client without a handshake is captured.
    expect(room.verdict(doc, null).verdict).toBe('legacy');
  });

  test('a room below its floor migrates when it loads, and keeps the base', () => {
    const room = new StoredRoom('r', {floor: 1});
    const stored = seed('base');
    room.state = stored;
    expect(layoutOf(room.load())).toBe(1);
    const g0 = room.generation;
    room.floor = 2;
    const doc = room.load();
    expect(layoutOf(doc)).toBe(2);
    expect(room.generation).not.toBe(g0);
    expect(room.bases.get(g0)).toEqual(stored);
    // Loading again migrates nothing and stores nothing.
    const version = room.version;
    room.load();
    expect(room.version).toBe(version);
    expect(textOf(Y.encodeStateAsUpdate(doc))).toBe('base');
  });

  test('a stale handoff is stored once, acknowledged by hash and replayed once', () => {
    const room = new StoredRoom('r', {floor: 1});
    room.state = seed('base');
    room.load();
    const g0 = room.generation;
    const replica = append(room.state, ' offline');
    room.floor = 2;
    const doc = room.load();
    const input = {
      clients: clientsOf(replica),
      draft: null,
      generation: g0,
      peers: false,
      snapshot: replica,
    };
    const first = room.handoff(input, doc);
    expect(first.replay).toMatchObject({conflicts: 0, eligible: true});
    expect(first.replay!.applied).toBeGreaterThan(0);
    // A retry of the same bytes: the same record, nothing applied again.
    const again = room.handoff(input, doc);
    expect(again).toBe(first);
    expect(room.records).toHaveLength(1);
    expect(textOf(Y.encodeStateAsUpdate(doc))).toBe('base offline');
    expect(room.list()).toMatchObject([
      {actionable: true, kind: 'handoff', source: g0},
    ]);
  });

  test('a client from before the fence is captured: its document is kept, never applied, and it gets the signal', () => {
    const room = new StoredRoom('r', {floor: 1});
    room.state = seed('base');
    const doc = room.load();
    const entry = room.capture();
    const replica = append(room.state, ' legacy');
    entry.capture!.add(replica);
    const signal = entry.capture!.signal(1);
    expect(signal).not.toBe(null);
    expect(textOf(Y.encodeStateAsUpdate(doc))).toBe('base');
    expect(room.list()).toMatchObject([
      {kind: 'capture', preview: 'base legacy', source: 'unknown'},
    ]);
  });

  test('the split material of a migration is a pending record, replayed, and its listing renders the cut text', () => {
    const room = new StoredRoom('r', {floor: 1});
    const S0 = seedYState(config, () => {
      $getRoot().append(
        $createParagraphNode().append($createTextNode('one')),
        $createParagraphNode().append($createTextNode('two')),
      );
    });
    // One writer edits the second block, then the first; the room received
    // the second update only (a skipped range before it).
    const writer = createYWriter('client');
    const first = append(S0, ' MISSING', 1, writer);
    const second = append(first, ' LATE', 0, writer);
    const late = Y.diffUpdate(
      second as Uint8Array<ArrayBuffer>,
      Y.encodeStateVectorFromUpdate(first as Uint8Array<ArrayBuffer>),
    );
    room.state = Y.mergeUpdates([S0, late] as Uint8Array<ArrayBuffer>[]);
    room.floor = 2;
    const doc = room.load();
    expect(layoutOf(doc)).toBe(2);
    const listed = room.list();
    expect(listed.map(r => r.kind)).toEqual(['pending']);
    expect(listed[0].preview).toContain('LATE');
    expect(textOf(Y.encodeStateAsUpdate(doc))).toContain('LATE');
  });

  test('a handoff from a generation without a base is kept, not replayed', () => {
    const room = new StoredRoom('r', {floor: 1});
    room.state = seed('base');
    const doc = room.load();
    const entry = room.handoff(
      {draft: null, generation: 'elsewhere/-', snapshot: seed('other')},
      doc,
    );
    expect(entry.replay).toMatchObject({eligible: false});
    expect(textOf(Y.encodeStateAsUpdate(doc))).toBe('base');
    expect(room.list()[0].preview).toBe('other');
  });
});
