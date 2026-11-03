/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// @lexical/y/server: the generation (incarnation and epochs), the load-time
// migration (prepareYRoom), the handshake verdict over every row of the
// table and a grid of rooms and clients, the legacy capture (an empty state
// vector, so the client's sync step 2 is a standalone snapshot), quarantine
// records and hasNewYEdits (struct only, deletion only, both, none, a valid
// draft). gc off and on.

import * as Y from '@y/y';
import {describe, expect, test} from 'vitest';

import {LAYOUT_VERSION, SEED_LAYOUT} from '../..';
import {readYState} from '../../headless';
import {replayYRecovery} from '../../internal/Server';
import {migrateYDoc, YMigrationError} from '../../migrate';
import {
  captureYSession,
  checkYSession,
  createYDoc,
  describeYRoom,
  generationOf,
  hasNewYEdits,
  needsNewIncarnation,
  prepareYRoom,
  quarantineRecord,
  sourceView,
  UNKNOWN_GENERATION,
  type YLegacySignal,
  type YRoomDescription,
  type YSessionHandshake,
} from '../../server';
import {$snapshot, catalogHeadlessConfig, seedShapes} from '../catalog/bind';
import {NODE_SHAPES, shapesWith} from '../catalog/nodes';
import {SEED, STAMP} from '../utils/migrateSteps';

const CFG = {blockIds: 'absent'} as const;
/** A seeded document (at SEED_LAYOUT). */
const LAYOUT1 = seedShapes([NODE_SHAPES[0], shapesWith('table')[0]], CFG);
const INC = 'inc-1';

/** Every live text under `node`, in document order. */
function text(node: Y.Node): string {
  let out = '';
  for (let it = node._start; it !== null; it = it.right) {
    if (it.deleted) {
      continue;
    }
    if (it.content instanceof Y.ContentString) {
      out += it.content.str;
    } else if (it.content instanceof Y.ContentType) {
      out += text(it.content.type as Y.Node);
    }
  }
  return out;
}

/** The containers under `root` that hold text, depth first. */
function textContainers(root: Y.Node): Y.Node[] {
  const out: Y.Node[] = [];
  const visit = (node: Y.Node) => {
    for (let it = node._start; it !== null; it = it.right) {
      if (!it.deleted && it.content instanceof Y.ContentString) {
        out.push(node);
        break;
      }
    }
    for (let it = node._start; it !== null; it = it.right) {
      if (!it.deleted && it.content instanceof Y.ContentType) {
        visit(it.content.type as Y.Node);
      }
    }
  };
  visit(root);
  return out;
}

/** The index of the first live text unit of `node`. */
function firstTextIndex(node: Y.Node): number {
  let index = 0;
  for (let it = node._start; it !== null; it = it.right) {
    if (!it.deleted && it.content instanceof Y.ContentString) {
      return index;
    }
    if (
      !it.deleted &&
      it.countable &&
      !(it.content instanceof Y.ContentFormat)
    ) {
      index += it.length;
    }
  }
  return -1;
}

describe.each([false, true])('@lexical/y/server, gc %s', gc => {
  const docOf = (state: Uint8Array) => createYDoc(state, {gc});

  test('generationOf: the incarnation, then each served root epoch in name order', () => {
    const doc = docOf(LAYOUT1);
    expect(generationOf(doc, INC)).toBe('inc-1/-');
    expect(generationOf(doc, 'inc-2')).toBe('inc-2/-');
    const receipt = migrateYDoc(doc, [STAMP], {to: SEED + 1});
    const {client, clock} = receipt.roots[0].epoch!;
    expect(generationOf(doc, INC)).toBe(
      `inc-1/lexical-y=${SEED + 1}.${client}.${clock}`,
    );
    // Roots in name order, names encoded, roots without an epoch left out.
    doc.get('a b').setAttr('lexical-y-epoch', {
      client: 7,
      clock: 0,
      layout: 2,
      revision: 1,
      step: 'lexical-y/layout/1to2',
      v: 1,
    } as never);
    doc.get('z').setAttr('lexical-y-epoch', 'broken');
    expect(generationOf(doc, INC, ['z', 'lexical-y', 'a b', 'none'])).toBe(
      `inc-1/a%20b=2.7.0,lexical-y=${SEED + 1}.${client}.${clock},z=?`,
    );
  });

  test('prepareYRoom: a root below the target migrates (state, generation, base, receipt); otherwise nothing', () => {
    const none = prepareYRoom(LAYOUT1, {
      gc,
      incarnation: INC,
      steps: [STAMP],
    });
    expect(none.changed).toBe(false);
    expect(none.state).toBe(LAYOUT1);
    expect(none.base).toBeNull();
    expect(none.generation).toBe('inc-1/-');
    const room = prepareYRoom(LAYOUT1, {
      gc,
      incarnation: INC,
      steps: [STAMP],
      to: SEED + 1,
    });
    expect(room.changed).toBe(true);
    expect(room.base).toEqual({generation: 'inc-1/-', state: LAYOUT1});
    expect(room.generation).toBe(generationOf(docOf(room.state), INC));
    expect(room.generation).not.toBe('inc-1/-');
    expect(room.receipt.roots[0]).toMatchObject({from: SEED, to: SEED + 1});
    expect(room.pending).toBeNull();
    if (SEED + 1 <= LAYOUT_VERSION) {
      expect(
        readYState(room.state, catalogHeadlessConfig(CFG), $snapshot),
      ).toEqual(readYState(LAYOUT1, catalogHeadlessConfig(CFG), $snapshot));
    }
    // Idempotent: the migrated room is served as is.
    const again = prepareYRoom(room.state, {
      gc,
      incarnation: INC,
      steps: [STAMP],
      to: SEED + 1,
    });
    expect(again.changed).toBe(false);
    expect(again.generation).toBe(room.generation);
    // A refusal throws: store nothing.
    const bad = docOf(LAYOUT1);
    bad.get('lexical-y').setAttr('lexical-y:9', true);
    expect(() =>
      prepareYRoom(Y.encodeStateAsUpdate(bad), {
        gc,
        incarnation: INC,
        steps: [STAMP],
        to: SEED + 1,
      }),
    ).toThrow(YMigrationError);
  });

  test('prepareYRoom splits pending material out of the stored state', () => {
    const author = new Y.Doc({gc});
    const updates: Uint8Array[] = [];
    author.on('update', (u: Uint8Array) => updates.push(u));
    author.get('other').insert(0, 'a');
    author.get('other').insert(1, 'b');
    const held = docOf(LAYOUT1);
    Y.applyUpdate(held, updates[1]);
    const room = prepareYRoom(Y.encodeStateAsUpdate(held), {
      gc,
      incarnation: INC,
      steps: [STAMP],
      to: SEED + 1,
    });
    expect(room.changed).toBe(true);
    expect(room.pending).not.toBeNull();
    expect(docOf(room.state).store.pendingStructs).toBeNull();
  });

  describe('checkYSession', () => {
    const room = (over: Partial<YRoomDescription> = {}): YRoomDescription => ({
      generation: 'inc-1/lexical-y=2.5.0',
      incarnation: INC,
      inherited: false,
      layouts: [2, 2],
      pristine: false,
      seedContract: 1,
      unreadable: [],
      ...over,
    });
    const client = (
      over: Partial<YSessionHandshake> = {},
    ): YSessionHandshake => ({
      generation: 'inc-1/lexical-y=2.5.0',
      layouts: [1, 2],
      material: true,
      seed: 1,
      ...over,
    });
    const OTHERS = [
      null,
      UNKNOWN_GENERATION,
      'inc-1/-',
      'inc-0/lexical-y=2.5.0',
    ];
    const PRISTINE = {
      generation: 'inc-1/-',
      layouts: null,
      pristine: true,
    };

    test('row 1: no handshake: admit on an inherited room that never migrated or was replaced, else legacy', () => {
      const unmigrated = {generation: 'inc-1/-'};
      expect(
        checkYSession(room({...unmigrated, inherited: true}), null),
      ).toEqual({initialize: false, verdict: 'admit'});
      expect(checkYSession(room({inherited: true}), null)).toEqual({
        verdict: 'legacy',
      });
      expect(checkYSession(room(unmigrated), null)).toEqual({
        verdict: 'legacy',
      });
      // Replaced: a new incarnation (never inherited) in the generation.
      expect(
        checkYSession(
          room({generation: 'inc-2/-', incarnation: 'inc-2', inherited: false}),
          null,
        ),
      ).toEqual({verdict: 'legacy'});
      // Before every other row: whatever the layout, seed or pristine.
      expect(
        checkYSession(
          room({
            ...unmigrated,
            inherited: true,
            layouts: [9, 9],
            seedContract: 7,
          }),
          null,
        ),
      ).toEqual({initialize: false, verdict: 'admit'});
    });

    test('row 2: material and another generation, an unreadable layout or a pristine room under another seed contract: stale, before any refusal', () => {
      for (const generation of OTHERS) {
        expect(checkYSession(room(), client({generation}))).toEqual({
          verdict: 'stale',
        });
        expect(
          checkYSession(room({layouts: [3, 3]}), client({generation})),
        ).toEqual({
          verdict: 'stale',
        });
      }
      // The room's generation, but a layout it cannot read: stale, not
      // refused (its material is acknowledged first).
      expect(checkYSession(room({layouts: [3, 3]}), client())).toEqual({
        verdict: 'stale',
      });
      // The room's generation, pristine under another seed contract.
      expect(
        checkYSession(
          room({...PRISTINE, seedContract: 3}),
          client({generation: 'inc-1/-'}),
        ),
      ).toEqual({verdict: 'stale'});
      // A token that happens to read 'unknown' never matches.
      expect(
        checkYSession(
          room({generation: UNKNOWN_GENERATION}),
          client({generation: UNKNOWN_GENERATION}),
        ),
      ).toEqual({verdict: 'stale'});
    });

    test('row 3: no material and a layout outside the client layouts: refuse-layout', () => {
      expect(
        checkYSession(room({layouts: [3, 3]}), client({material: false})),
      ).toEqual({verdict: 'refuse-layout'});
      expect(
        checkYSession(
          room({layouts: [1, 1]}),
          client({generation: null, layouts: [2, 3], material: false}),
        ),
      ).toEqual({verdict: 'refuse-layout'});
    });

    test('row 4: no material and a pristine room under another seed contract: refuse-layout, before admit and bootstrap', () => {
      for (const generation of [null, 'inc-1/-']) {
        expect(
          checkYSession(
            room({...PRISTINE, seedContract: 3}),
            client({generation, material: false}),
          ),
        ).toEqual({verdict: 'refuse-layout'});
      }
    });

    test('row 5: the room generation: admit, with initialize in a pristine room', () => {
      expect(checkYSession(room(), client())).toEqual({
        initialize: false,
        verdict: 'admit',
      });
      expect(checkYSession(room(), client({material: false}))).toEqual({
        initialize: false,
        verdict: 'admit',
      });
      expect(
        checkYSession(room(PRISTINE), client({generation: 'inc-1/-'})),
      ).toEqual({initialize: true, verdict: 'admit'});
    });

    test('row 6: no material: bootstrap, with initialize in a pristine room', () => {
      for (const generation of OTHERS) {
        expect(
          checkYSession(room(), client({generation, material: false})),
        ).toEqual({initialize: false, verdict: 'bootstrap'});
      }
      expect(
        checkYSession(
          room(PRISTINE),
          client({generation: null, material: false}),
        ),
      ).toEqual({initialize: true, verdict: 'bootstrap'});
    });

    test('a grid of rooms and clients: the first matching row wins, and no client with material is refused', () => {
      let count = 0;
      for (const layouts of [null, [1, 1], [2, 2], [3, 3], [1, 2], [2, 3]] as (
        | [number, number]
        | null
      )[]) {
        for (const pristine of [false, true]) {
          for (const inherited of [false, true]) {
            for (const roomGeneration of ['g/-', 'g/r=2.1.0']) {
              for (const generation of [
                null,
                UNKNOWN_GENERATION,
                'g/-',
                'g/r=2.1.0',
                'h/-',
              ]) {
                for (const material of [false, true]) {
                  for (const range of [
                    [1, 1],
                    [1, 2],
                    [2, 3],
                    [3, 3],
                  ] as [number, number][]) {
                    for (const seed of [1, 3]) {
                      const r = room({
                        generation: roomGeneration,
                        incarnation: 'g',
                        inherited,
                        layouts,
                        pristine,
                        seedContract: 1,
                        unreadable: [],
                      });
                      const c = client({
                        generation,
                        layouts: range,
                        material,
                        seed,
                      });
                      count++;
                      const same = generation === roomGeneration;
                      const readable =
                        layouts === null ||
                        (layouts[0] >= range[0] && layouts[1] <= range[1]);
                      const seedable = !pristine || seed === 1;
                      const want =
                        material && (!same || !readable || !seedable)
                          ? {verdict: 'stale'}
                          : !readable || !seedable
                            ? {verdict: 'refuse-layout'}
                            : same
                              ? {initialize: pristine, verdict: 'admit'}
                              : {initialize: pristine, verdict: 'bootstrap'};
                      const got = checkYSession(r, c);
                      expect(got).toEqual(want);
                      if (material) {
                        expect(got.verdict).not.toBe('refuse-layout');
                      }
                      expect(checkYSession(r, null)).toEqual(
                        inherited && roomGeneration === 'g/-'
                          ? {initialize: false, verdict: 'admit'}
                          : {verdict: 'legacy'},
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
      expect(count).toBe(6 * 2 * 2 * 2 * 5 * 2 * 4 * 2);
    });

    test('needsNewIncarnation: a pristine room issued under another seed contract', () => {
      expect(needsNewIncarnation(room({...PRISTINE, seedContract: 1}), 3)).toBe(
        true,
      );
      expect(needsNewIncarnation(room({...PRISTINE, seedContract: 3}), 3)).toBe(
        false,
      );
      expect(needsNewIncarnation(room({seedContract: 1}), 3)).toBe(false);
    });

    test('describeYRoom gives the generation, the incarnation, the layout, pristine and the seed contract', () => {
      expect(
        describeYRoom(docOf(LAYOUT1), {
          incarnation: INC,
          inherited: true,
          seedContract: SEED_LAYOUT,
        }),
      ).toEqual({
        generation: 'inc-1/-',
        incarnation: INC,
        inherited: true,
        layouts: [SEED, SEED],
        pristine: false,
        seedContract: SEED_LAYOUT,
        unreadable: [],
      });
      expect(
        describeYRoom(createYDoc(null, {gc}), {
          incarnation: INC,
          inherited: false,
          seedContract: SEED_LAYOUT,
        }),
      ).toEqual({
        generation: 'inc-1/-',
        incarnation: INC,
        inherited: false,
        layouts: null,
        pristine: true,
        seedContract: SEED_LAYOUT,
        unreadable: [],
      });
    });

    test('the core SEED_LAYOUT is what initialize() records', () => {
      expect(SEED_LAYOUT).toBe(SEED);
    });
  });

  test('captureYSession: an empty sync step 2, a sync step 1 with an empty state vector, the client document as a standalone snapshot', () => {
    const capture = captureYSession();
    expect([...capture.syncStep2]).toEqual([0, 0]);
    expect([...capture.syncStep1]).toEqual([0]);
    expect(capture.messages.map(m => [...m])).toEqual([
      [0, 1, 2, 0, 0],
      [0, 0, 1, 0],
    ]);
    // A legacy client: the room's old state, plus an offline edit.
    const legacy = docOf(LAYOUT1);
    const node = textContainers(legacy.get('lexical-y'))[0];
    node.insert(firstTextIndex(node), 'OFFLINE ');
    const before = Y.encodeStateAsUpdate(legacy);
    // It receives nothing of the room.
    Y.applyUpdate(legacy, capture.syncStep2);
    expect(Buffer.from(Y.encodeStateAsUpdate(legacy))).toEqual(
      Buffer.from(before),
    );
    // Its sync step 2 for an empty state vector is its whole document.
    capture.add(Y.encodeStateAsUpdate(legacy, capture.syncStep1));
    node.insert(0, 'later ');
    const delta = Y.encodeStateAsUpdate(
      legacy,
      Y.encodeStateVector(docOf(capture.material().snapshot!)),
    );
    capture.add(delta);
    const {snapshot, deltas} = capture.material();
    expect(deltas).toHaveLength(1);
    const alone = docOf(snapshot!);
    expect(alone.store.pendingStructs).toBeNull();
    expect(
      readYState(snapshot!, catalogHeadlessConfig(CFG), $snapshot),
    ).toEqual(readYState(before, catalogHeadlessConfig(CFG), $snapshot));
    Y.applyUpdate(alone, deltas[0]);
    expect(Y.encodeStateVector(alone)).toEqual(Y.encodeStateVector(legacy));
  });

  describe('quarantine records, the source view and hasNewYEdits', () => {
    /** A replica of LAYOUT1 that ran `edit` (raw Yjs) offline. */
    const replica = (edit: (root: Y.Node) => void): Uint8Array => {
      const doc = docOf(LAYOUT1);
      edit(doc.get('lexical-y'));
      return Y.encodeStateAsUpdate(doc);
    };
    const base = () => Y.encodeStateAsUpdate(docOf(LAYOUT1));
    const insert = (root: Y.Node) => {
      const node = textContainers(root)[0];
      node.insert(firstTextIndex(node), 'new ');
    };
    const remove = (root: Y.Node) => {
      const node = textContainers(root)[0];
      node.delete(firstTextIndex(node), 1);
    };
    const record = (
      snapshot: Uint8Array | null,
      more: {
        draft?: {json: unknown; differs: boolean} | null;
        deltas?: Uint8Array[];
        queue?: Uint8Array[];
        signals?: YLegacySignal[];
      } = {},
    ) => ({
      deltas: more.deltas ?? [],
      draft: more.draft ?? null,
      queue: more.queue ?? [],
      signals: more.signals ?? [],
      snapshot,
    });
    const SOURCE = {
      generation: 'inc-1/-',
      incarnation: INC,
      layouts: [1, 2] as [number, number],
      renderer: 'r1',
      schemaVersion: 1,
    };

    test('struct only, deletion only, both, none', () => {
      const b = base();
      expect(hasNewYEdits(record(replica(insert)), b)).toBe(true);
      expect(hasNewYEdits(record(replica(remove)), b)).toBe(true);
      expect(
        hasNewYEdits(
          record(
            replica(root => {
              insert(root);
              remove(root);
            }),
          ),
          b,
        ),
      ).toBe(true);
      expect(hasNewYEdits(record(replica(() => {})), b)).toBe(false);
      // A deletion the base already has is not new.
      const deleted = replica(remove);
      expect(hasNewYEdits(record(deleted), deleted)).toBe(false);
      // Material only in the queue counts too.
      const doc = docOf(LAYOUT1);
      const sv = Y.encodeStateVector(doc);
      insert(doc.get('lexical-y'));
      expect(
        hasNewYEdits(
          record(null, {queue: [Y.encodeStateAsUpdate(doc, sv)]}),
          b,
        ),
      ).toBe(true);
    });

    test('a draft marked differs counts, one that does not does not; an incomplete view counts', () => {
      const b = base();
      const same = replica(() => {});
      expect(
        hasNewYEdits(record(same, {draft: {differs: true, json: {}}}), b),
      ).toBe(true);
      expect(
        hasNewYEdits(record(same, {draft: {differs: false, json: {}}}), b),
      ).toBe(false);
      // A delta whose dependency is missing: incomplete.
      const author = new Y.Doc({gc});
      const updates: Uint8Array[] = [];
      author.on('update', (u: Uint8Array) => updates.push(u));
      author.get('other').insert(0, 'a');
      author.get('other').insert(1, 'b');
      const incomplete = record(same, {deltas: [updates[1]]});
      const view = sourceView(incomplete);
      expect(view.complete).toBe(false);
      view.doc.destroy();
      expect(hasNewYEdits(incomplete, b)).toBe(true);
      // With the dependency, the view is complete (and holds new structs).
      const whole = sourceView(
        record(same, {deltas: updates.slice().reverse()}),
      );
      expect(whole.complete).toBe(true);
      whole.doc.destroy();
    });

    test('a legacy signal: built on the snapshot, a fresh client, a schema key above recorded and supported, no deletion; the old client turns read only; its exact item is ignored', () => {
      const capture = captureYSession();
      expect(capture.signal(1)).toBeNull();
      const legacy = docOf(LAYOUT1);
      remove(legacy.get('lexical-y'));
      legacy.get('lexical-y').setAttr('lexical-y-schema:4', true);
      capture.add(Y.encodeStateAsUpdate(legacy, capture.syncStep1));
      const signal = capture.signal(2)!;
      // Above the highest recorded (4) and supported (2).
      expect(signal.key).toBe('lexical-y-schema:5');
      expect(signal).toMatchObject({clock: 0, root: 'lexical-y'});
      expect(legacy.store.clients.has(signal.client)).toBe(false);
      const decoded = Y.decodeUpdate(signal.update);
      expect(decoded.structs.map(st => st.id.client)).toEqual([signal.client]);
      // No deletion the replica lacks: applying it deletes nothing live.
      const live = text(legacy.get('lexical-y'));
      const before = readYState(
        Y.encodeStateAsUpdate(legacy),
        catalogHeadlessConfig(CFG, {schemaVersion: 4}),
        $snapshot,
      );
      Y.applyUpdate(legacy, signal.update);
      expect(text(legacy.get('lexical-y'))).toBe(live);
      expect(legacy.get('lexical-y').getAttr('lexical-y-schema:5')).toBe(true);
      expect(() =>
        readYState(
          Y.encodeStateAsUpdate(legacy),
          catalogHeadlessConfig(CFG, {schemaVersion: 4}),
          $snapshot,
        ),
      ).toThrow(/read only|newer/);
      expect(
        readYState(
          Y.encodeStateAsUpdate(legacy),
          catalogHeadlessConfig(CFG, {schemaVersion: 5}),
          $snapshot,
        ),
      ).toEqual(before);
      // Kept with the capture; an echo of it is not new material.
      const {snapshot, deltas, signals} = capture.material();
      expect(signals).toEqual([signal]);
      expect(capture.collisions()).toEqual([]);
      const r = record(snapshot, {deltas: [...deltas, signal.update], signals});
      expect(hasNewYEdits(r, snapshot!)).toBe(false);
      expect(hasNewYEdits(r, base())).toBe(true);
      expect(
        quarantineRecord({
          deltas: [signal.update],
          kind: 'capture',
          receivedAt: 0,
          signals,
          snapshot,
          source: SOURCE,
        }).collisions,
      ).toEqual([]);
    });

    test('a signal id the replica wrote other content at: kept, noted as a collision, and signalled again under another id', () => {
      const capture = captureYSession();
      const legacy = docOf(LAYOUT1);
      capture.add(Y.encodeStateAsUpdate(legacy, capture.syncStep1));
      const signal = capture.signal(1)!;
      // The replica's own client turns out to be the signal's id: it writes
      // text there (clock 0) instead of the signal's record.
      const sv = Y.encodeStateVector(legacy);
      legacy.clientID = signal.client;
      const node = textContainers(legacy.get('lexical-y'))[0];
      node.insert(firstTextIndex(node), 'own ');
      const delta = Y.encodeStateAsUpdate(legacy, sv);
      capture.add(delta);
      expect(capture.collisions()).toEqual([signal]);
      const {snapshot, deltas, signals} = capture.material();
      const r = quarantineRecord(
        {
          deltas,
          kind: 'capture',
          receivedAt: 0,
          signals,
          snapshot,
          source: SOURCE,
        },
        {generation: 'inc-1/-', state: snapshot!},
      );
      expect(r.collisions).toEqual([signal]);
      // The replica's own text at that id is new material, not ignored.
      expect(r.actionable).toBe(true);
      // Another signal, another fresh client.
      const again = capture.signal(1)!;
      expect(again.client).not.toBe(signal.client);
      expect(capture.material().signals).toEqual([signal, again]);
    });

    test('quarantineRecord: a stable hash of the material, the id, complete, and actionable against a base', () => {
      const input = {
        kind: 'handoff' as const,
        receivedAt: 1,
        replica: 'r1',
        session: 's1',
        snapshot: replica(insert),
        source: SOURCE,
      };
      const a = quarantineRecord(input);
      const b = quarantineRecord({...input, receivedAt: 2});
      expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(b.hash).toBe(a.hash);
      expect(a.id).toBe(a.hash);
      expect(a.actionable).toBe(true);
      expect(a.complete).toBe(true);
      expect(a.signals).toEqual([]);
      expect(a.collisions).toEqual([]);
      expect(a.base).toBeNull();
      expect(
        quarantineRecord({...input, snapshot: replica(remove)}).hash,
      ).not.toBe(a.hash);
      expect(quarantineRecord({...input, kind: 'capture'}).hash).not.toBe(
        a.hash,
      );
      expect(
        quarantineRecord({...input, draft: {differs: false, json: {a: 1}}})
          .hash,
      ).not.toBe(a.hash);
      const withBase = quarantineRecord(input, {
        generation: 'inc-1/-',
        state: base(),
      });
      expect(withBase).toMatchObject({actionable: true, base: 'inc-1/-'});
      const nothing = quarantineRecord(
        {...input, snapshot: replica(() => {})},
        {generation: 'inc-1/-', state: base()},
      );
      expect(nothing.actionable).toBe(false);
    });
  });

  test('replayYRecovery (internal) is not implemented yet', () => {
    expect(() =>
      replayYRecovery(
        quarantineRecord({
          kind: 'handoff',
          receivedAt: 0,
          source: {
            generation: null,
            incarnation: null,
            layouts: null,
            renderer: null,
            schemaVersion: null,
          },
        }),
        LAYOUT1,
        docOf(LAYOUT1),
      ),
    ).toThrow(/not implemented/);
  });
});
