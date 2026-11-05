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
import {createHash} from 'node:crypto';
import {describe, expect, test} from 'vitest';

import {LAYOUT_VERSION, SEED_LAYOUT} from '../..';
import {readYState} from '../../headless';
import {migrateYDoc} from '../../internal/Runner';
import {
  hasNewYEdits,
  needsNewIncarnation,
  replayYRecovery,
} from '../../internal/Server';
import {YMigrationError} from '../../migrate';
import {
  checkYSession,
  createYDoc,
  createYQuarantineRecord,
  createYSessionCapture,
  describeYRoom,
  getYGeneration,
  prepareYRoom,
  sourceView,
  UNKNOWN_GENERATION,
  type YLegacySignal,
  type YQuarantineRecordKind,
  type YRecordAcknowledgement,
  type YRoomDescription,
  type YSessionHandshake,
  type YSessionVerdict,
} from '../../server';
import {$snapshot, catalogHeadlessConfig, seedShapes} from '../catalog/bind';
import {NODE_SHAPES, shapesWith} from '../catalog/nodes';
import {SEED, STAMP} from '../utils/migrateSteps';

const CFG = {blockIds: 'absent'} as const;
/** A seeded document (at SEED_LAYOUT). */
const LAYOUT1 = seedShapes([NODE_SHAPES[0], shapesWith('table')[0]], CFG);
const INC = 'inc-1';
/** The generation of INC's room before any migration. */
const G0 = 'g1:["inc-1",[["lexical-y",null]]]';

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

  test('getYGeneration (g1): the incarnation and every served root, in code-unit order, with its epoch transition identity or null', () => {
    const doc = docOf(LAYOUT1);
    expect(getYGeneration(doc, INC)).toBe('g1:["inc-1",[["lexical-y",null]]]');
    expect(getYGeneration(doc, 'inc-2')).toBe(
      'g1:["inc-2",[["lexical-y",null]]]',
    );
    // The incarnation is JSON: any string, never confused with the roots.
    expect(getYGeneration(doc, 'a"/b')).toBe(
      'g1:["a\\"/b",[["lexical-y",null]]]',
    );
    const receipt = migrateYDoc(doc, [STAMP], {to: SEED + 1});
    const {client, clock} = receipt.roots[0].epoch!;
    expect(getYGeneration(doc, INC)).toBe(
      `g1:["inc-1",[["lexical-y",[${client},${clock}]]]]`,
    );
    // Every served root, each once, sorted by code units (an absent root and
    // one without an epoch are null); names are JSON strings, not encoded.
    const epoch = (c: number, layout: number) => ({
      client: c,
      clock: 3,
      layout,
      revision: 1,
      step: `lexical-y/layout/${layout - 1}to${layout}`,
      v: 1,
    });
    doc.get('a b').setAttr('lexical-y-epoch', epoch(7, 2) as never);
    doc.get('Z|z').setAttr('lexical-y-epoch', epoch(9, 2) as never);
    doc.get('\u00e9').insert(0, 'x');
    expect(
      getYGeneration(doc, INC, [
        'none',
        'lexical-y',
        'a b',
        'Z|z',
        '\u00e9',
        'a b',
      ]),
    ).toBe(
      `g1:["inc-1",[["Z|z",[9,3]],["a b",[7,3]],["lexical-y",[${client},${clock}]],["none",null],["\u00e9",null]]]`,
    );
    // The transition identity, not the layout: another layout at the same
    // item is the same generation; another item is another.
    const at = (layout: number, c: number) => {
      const d = docOf(LAYOUT1);
      d.get('lexical-y').setAttr('lexical-y-epoch', epoch(c, layout) as never);
      return getYGeneration(d, INC);
    };
    expect(at(2, 5)).toBe(at(3, 5));
    expect(at(2, 5)).not.toBe(at(2, 6));
    // A malformed epoch on a served root fails closed: no generation.
    for (const bad of [
      'broken',
      {...epoch(5, 2), v: 2},
      {...epoch(5, 2), client: 0},
    ]) {
      const d = docOf(LAYOUT1);
      d.get('lexical-y').setAttr('lexical-y-epoch', bad as never);
      expect(getYGeneration(d, INC)).toBe(UNKNOWN_GENERATION);
      // Not served: ignored.
      expect(getYGeneration(d, INC, ['other'])).toBe(
        'g1:["inc-1",[["other",null]]]',
      );
    }
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
    expect(none.generation).toBe(G0);
    const room = prepareYRoom(LAYOUT1, {
      gc,
      incarnation: INC,
      steps: [STAMP],
      to: SEED + 1,
    });
    expect(room.changed).toBe(true);
    expect(room.base).toEqual({generation: G0, state: LAYOUT1});
    expect(room.generation).toBe(getYGeneration(docOf(room.state), INC));
    expect(room.generation).not.toBe(G0);
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
    bad.get('lexical-y').setAttr('lexical-y:x', true);
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
      hasMigration: true,
      incarnation: INC,
      inherited: false,
      layouts: [2, 2],
      pristine: false,
      requires: [],
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
      v: 1,
      ...over,
    });
    /** The verdict without its (diagnostic) reason. */
    const check = (
      r: YRoomDescription,
      c: YSessionHandshake | null,
    ): YSessionVerdict => {
      const {reason: _reason, ...verdict} = checkYSession(r, c);
      return verdict;
    };
    const OTHERS = [
      null,
      UNKNOWN_GENERATION,
      'inc-1/-',
      'inc-0/lexical-y=2.5.0',
    ];
    const PRISTINE = {
      generation: 'inc-1/-',
      hasMigration: false,
      layouts: null,
      pristine: true,
    };

    test('row 1: no handshake: admit on an inherited room that never migrated or was replaced, else legacy', () => {
      const unmigrated = {generation: 'inc-1/-', hasMigration: false};
      expect(check(room({...unmigrated, inherited: true}), null)).toEqual({
        initialize: false,
        verdict: 'admit',
      });
      expect(check(room({inherited: true}), null)).toEqual({
        verdict: 'legacy',
      });
      expect(check(room(unmigrated), null)).toEqual({
        verdict: 'legacy',
      });
      // Replaced: a new incarnation (never inherited) in the generation.
      expect(
        check(
          room({
            generation: 'inc-2/-',
            hasMigration: false,
            incarnation: 'inc-2',
            inherited: false,
          }),
          null,
        ),
      ).toEqual({verdict: 'legacy'});
      // Before every other row: whatever the layout, seed or pristine.
      expect(
        check(
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
        expect(check(room(), client({generation}))).toEqual({
          verdict: 'stale',
        });
        expect(check(room({layouts: [3, 3]}), client({generation}))).toEqual({
          verdict: 'stale',
        });
      }
      // The room's generation, but a layout it cannot read: stale, not
      // refused (its material is acknowledged first).
      expect(check(room({layouts: [3, 3]}), client())).toEqual({
        verdict: 'stale',
      });
      // The room's generation, pristine under another seed contract.
      expect(
        check(
          room({...PRISTINE, seedContract: 3}),
          client({generation: 'inc-1/-'}),
        ),
      ).toEqual({verdict: 'stale'});
      // A token that happens to read 'unknown' never matches.
      expect(
        check(
          room({generation: UNKNOWN_GENERATION}),
          client({generation: UNKNOWN_GENERATION}),
        ),
      ).toEqual({verdict: 'stale'});
    });

    test('row 3: no material and a layout outside the client layouts: refuse-layout', () => {
      expect(check(room({layouts: [3, 3]}), client({material: false}))).toEqual(
        {verdict: 'refuse-layout'},
      );
      expect(
        check(
          room({layouts: [1, 1]}),
          client({generation: null, layouts: [2, 3], material: false}),
        ),
      ).toEqual({verdict: 'refuse-layout'});
    });

    test('row 4: no material and a pristine room under another seed contract: refuse-layout, before admit and bootstrap', () => {
      for (const generation of [null, 'inc-1/-']) {
        expect(
          check(
            room({...PRISTINE, seedContract: 3}),
            client({generation, material: false}),
          ),
        ).toEqual({verdict: 'refuse-layout'});
      }
    });

    test('row 5: the room generation: admit, with initialize in a pristine room', () => {
      expect(check(room(), client())).toEqual({
        initialize: false,
        verdict: 'admit',
      });
      expect(check(room(), client({material: false}))).toEqual({
        initialize: false,
        verdict: 'admit',
      });
      expect(check(room(PRISTINE), client({generation: 'inc-1/-'}))).toEqual({
        initialize: true,
        verdict: 'admit',
      });
    });

    test('row 6: no material: bootstrap, with initialize in a pristine room', () => {
      for (const generation of OTHERS) {
        expect(check(room(), client({generation, material: false}))).toEqual({
          initialize: false,
          verdict: 'bootstrap',
        });
      }
      expect(
        check(room(PRISTINE), client({generation: null, material: false})),
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
                        hasMigration: roomGeneration !== 'g/-',
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
                      const got = check(r, c);
                      expect(got).toEqual(want);
                      if (material) {
                        expect(got.verdict).not.toBe('refuse-layout');
                      }
                      expect(check(r, null)).toEqual(
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

    test('a malformed handshake (from the network): refuse-layout', () => {
      const bad: unknown[] = [
        {},
        'hello',
        {...client(), generation: 7},
        {...client(), material: 'yes'},
        {...client(), layouts: [2]},
        {...client(), layouts: [3, 2]},
        {...client(), layouts: [0, 2]},
        {...client(), layouts: [1, 2.5]},
        {...client(), layouts: '1,2'},
        {...client(), seed: null},
        {...client(), seed: 0},
      ];
      for (const handshake of bad) {
        expect(check(room(), handshake as YSessionHandshake)).toEqual({
          verdict: 'refuse-layout',
        });
      }
      // Extra fields are fine.
      expect(
        check(room(), {...client(), extra: 1} as YSessionHandshake),
      ).toEqual({initialize: false, verdict: 'admit'});
    });

    test('version 1: a handshake without v, with another v or with features that are not strings is malformed (refuse-layout, with or without material); null stays the legacy route', () => {
      const {v: _v, ...unversioned} = client();
      for (const material of [false, true]) {
        for (const bad of [
          {...unversioned, material},
          {...client({material}), v: 2},
          {...client({material}), v: '1'},
          {...client({material}), v: 0},
          {...client({material}), v: null},
          {...client({material}), features: 'x'},
          {...client({material}), features: [1]},
          {...client({material}), features: {x: true}},
          [],
        ]) {
          expect(checkYSession(room(), bad as YSessionHandshake)).toEqual({
            reason: 'malformed-handshake',
            verdict: 'refuse-layout',
          });
        }
      }
      expect(check(room(), client({features: []}))).toEqual({
        initialize: false,
        verdict: 'admit',
      });
      expect(check(room({hasMigration: false, inherited: true}), null)).toEqual(
        {initialize: false, verdict: 'admit'},
      );
    });

    test('requirements: every required feature presented admits; one missing is stale with material, else refuse-layout; a client from before the fence is never admitted', () => {
      const req = room({requires: ['a', 'b']});
      for (const features of [
        ['a', 'b'],
        ['b', 'a', 'c'],
        ['a', 'b', 'b'],
      ]) {
        expect(check(req, client({features}))).toEqual({
          initialize: false,
          verdict: 'admit',
        });
        expect(
          check(req, client({features, generation: null, material: false})),
        ).toEqual({initialize: false, verdict: 'bootstrap'});
      }
      for (const features of [undefined, [], ['a'], ['A', 'b'], ['a ', 'b']]) {
        expect(checkYSession(req, client({features}))).toEqual({
          reason: 'requires',
          verdict: 'stale',
        });
        // Even at the room's generation: its material is acknowledged first.
        expect(checkYSession(req, client({features, material: false}))).toEqual(
          {reason: 'requires', verdict: 'refuse-layout'},
        );
      }
      // Before the fence: whatever else, never admitted to a room with
      // requirements or an unreadable root.
      const inherited = {hasMigration: false, inherited: true};
      expect(
        checkYSession(room({...inherited, requires: ['a']}), null),
      ).toEqual({reason: 'requires', verdict: 'legacy'});
      expect(
        checkYSession(room({...inherited, unreadable: ['lexical-y']}), null),
      ).toEqual({reason: 'unreadable', verdict: 'legacy'});
    });

    test('reasons: why a session was not admitted, in the order the rows test it', () => {
      const cases: [YRoomDescription, YSessionHandshake | null, string][] = [
        [room(), null, 'not-inherited'],
        [room({inherited: true}), null, 'migrated'],
        [room(), client({generation: 'other'}), 'generation'],
        [room({layouts: [3, 3]}), client(), 'layout'],
        [room({layouts: [3, 3]}), client({material: false}), 'layout'],
        [room({unreadable: ['x']}), client(), 'unreadable'],
        [room({requires: ['f']}), client(), 'requires'],
        [
          room({...PRISTINE, seedContract: 3}),
          client({generation: 'inc-1/-'}),
          'seed',
        ],
        [
          room({...PRISTINE, seedContract: 3}),
          client({material: false}),
          'seed',
        ],
        [
          room({layouts: [3, 3], requires: ['f']}),
          client({material: false}),
          'layout',
        ],
      ];
      for (const [r, c, reason] of cases) {
        expect(checkYSession(r, c).reason).toBe(reason);
      }
      expect(checkYSession(room(), client()).reason).toBeUndefined();
    });

    test('a room whose generation reads unknown never admits on it', () => {
      expect(
        check(
          room({generation: UNKNOWN_GENERATION}),
          client({generation: UNKNOWN_GENERATION, material: false}),
        ),
      ).toEqual({initialize: false, verdict: 'bootstrap'});
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
        generation: G0,
        hasMigration: false,
        incarnation: INC,
        inherited: true,
        layouts: [SEED, SEED],
        pristine: false,
        requires: [],
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
        generation: G0,
        hasMigration: false,
        incarnation: INC,
        inherited: false,
        layouts: null,
        pristine: true,
        requires: [],
        seedContract: SEED_LAYOUT,
        unreadable: [],
      });
    });

    test('describeYRoom reads requirements: every well-formed feature once, in code-unit order; a malformed one makes its root unreadable', () => {
      const describeRoom = (doc: Y.Doc, roots?: string[]) =>
        describeYRoom(doc, {
          incarnation: INC,
          inherited: false,
          roots,
          seedContract: SEED_LAYOUT,
        });
      const doc = docOf(LAYOUT1);
      const root = doc.get('lexical-y');
      root.setAttr('lexical-y-require:zeta', true);
      root.setAttr('lexical-y-require:Beta', true);
      root.setAttr('lexical-y-require:a/b c', true);
      // Other lexical-y-* keys are not requirements.
      root.setAttr('lexical-y-requirement', 'x' as never);
      root.setAttr('lexical-y-other', 1 as never);
      const other = doc.get('other');
      other.setAttr('lexical-y:1', true);
      other.setAttr('lexical-y-require:zeta', true);
      other.setAttr('lexical-y-require:\u00e9', true);
      expect(describeRoom(doc)).toMatchObject({
        requires: ['Beta', 'a/b c', 'zeta'],
        unreadable: [],
      });
      expect(describeRoom(doc, ['other', 'lexical-y'])).toMatchObject({
        layouts: [SEED, SEED],
        requires: ['Beta', 'a/b c', 'zeta', '\u00e9'],
        unreadable: [],
      });
      // Malformed: a value other than true, or an empty feature.
      for (const [key, value] of [
        ['lexical-y-require:zeta', false],
        ['lexical-y-require:zeta', 'true'],
        ['lexical-y-require:zeta', 1],
        ['lexical-y-require:zeta', null],
        ['lexical-y-require:', true],
      ] as [string, unknown][]) {
        const bad = docOf(LAYOUT1);
        bad.get('lexical-y').setAttr(key, value as never);
        const described = describeRoom(bad);
        expect(described.unreadable).toEqual(['lexical-y']);
        expect(described.layouts).toBeNull();
        expect(described.requires).toEqual([]);
      }
      // A requirement alone is content: the room is not pristine.
      const only = createYDoc(null, {gc});
      only.get('lexical-y').setAttr('lexical-y-require:x', true);
      expect(describeRoom(only)).toMatchObject({
        pristine: false,
        requires: ['x'],
        unreadable: ['lexical-y'],
      });
    });

    test('the core SEED_LAYOUT is what initialize() records', () => {
      expect(SEED_LAYOUT).toBe(SEED);
    });
  });

  test('createYSessionCapture: an empty sync step 2, a sync step 1 with an empty state vector, the client document as a standalone snapshot', () => {
    const capture = createYSessionCapture();
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

  test('createYSessionCapture resumes from persisted material: later deltas, its signals and their collisions continue', () => {
    const legacy = docOf(LAYOUT1);
    const node = textContainers(legacy.get('lexical-y'))[0];
    node.insert(firstTextIndex(node), 'OFFLINE ');
    const first = createYSessionCapture();
    first.add(Y.encodeStateAsUpdate(legacy, first.syncStep1));
    const signal = first.signal(SEED)!;
    // Persisted, then the authority comes back without the object.
    const persisted = first.material();
    const resumed = createYSessionCapture(persisted);
    expect(resumed.material()).toEqual(persisted);
    expect([...resumed.syncStep1]).toEqual([0]);
    // A later update is a delta, not a new snapshot.
    const sv = Y.encodeStateVector(legacy);
    node.insert(0, 'later ');
    resumed.add(Y.encodeStateAsUpdate(legacy, sv));
    expect(resumed.material().snapshot).toEqual(persisted.snapshot);
    expect(resumed.material().deltas).toHaveLength(1);
    expect(resumed.material().signals).toEqual([signal]);
    // The next signal is built on the snapshot and the delta (signals are
    // never applied to the material): the same schema key, a fresh client.
    const next = resumed.signal(SEED)!;
    expect(next.key).toBe(signal.key);
    expect(next.client).not.toBe(signal.client);
    expect(resumed.material().signals).toEqual([signal, next]);
    // A collision with a resumed signal is still found: the session wrote
    // other content at its id.
    const author = docOf(LAYOUT1);
    author.clientID = signal.client;
    author.get('lexical-y').setAttr('other', 1 as never);
    const colliding = createYSessionCapture({
      deltas: [Y.encodeStateAsUpdate(author)],
      signals: [signal],
      snapshot: persisted.snapshot,
      updateFormat: 'yjs-v1',
      v: 1,
    });
    expect(colliding.collisions()).toEqual([signal]);
    // Resuming copies: the persisted arrays are not appended to.
    expect(persisted.deltas).toHaveLength(0);
    expect(persisted.signals).toHaveLength(1);
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
      kind: 'handoff',
      queue: more.queue ?? [],
      requires: [] as string[],
      signals: more.signals ?? [],
      snapshot,
      updateFormat: 'yjs-v1' as const,
      v: 1 as const,
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
      const capture = createYSessionCapture();
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
      const r = record(snapshot, {
        deltas: [...deltas, signal.update],
        signals: [...signals],
      });
      expect(hasNewYEdits(r, snapshot!)).toBe(false);
      expect(hasNewYEdits(r, base())).toBe(true);
      expect(
        createYQuarantineRecord({
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
      const capture = createYSessionCapture();
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
      const r = createYQuarantineRecord(
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

    test('createYQuarantineRecord: a stable hash of the material, the id, complete, and actionable against a base', () => {
      const input = {
        kind: 'handoff' as const,
        receivedAt: 1,
        replica: 'r1',
        session: 's1',
        snapshot: replica(insert),
        source: SOURCE,
      };
      const a = createYQuarantineRecord(input);
      const b = createYQuarantineRecord({...input, receivedAt: 2});
      expect(a.hash).toMatch(/^yr1-sha256:[0-9a-f]{64}$/);
      expect(a).toMatchObject({requires: [], updateFormat: 'yjs-v1', v: 1});
      expect(b.hash).toBe(a.hash);
      expect(a.id).toBe(a.hash);
      expect(a.actionable).toBe(true);
      expect(a.complete).toBe(true);
      expect(a.signals).toEqual([]);
      expect(a.collisions).toEqual([]);
      expect(a.base).toBeNull();
      expect(
        createYQuarantineRecord({...input, snapshot: replica(remove)}).hash,
      ).not.toBe(a.hash);
      expect(
        createYQuarantineRecord({...input, kind: 'capture'}).hash,
      ).not.toBe(a.hash);
      expect(
        createYQuarantineRecord({
          ...input,
          draft: {differs: false, json: {a: 1}},
        }).hash,
      ).not.toBe(a.hash);
      const withBase = createYQuarantineRecord(input, {
        generation: 'inc-1/-',
        state: base(),
      });
      expect(withBase).toMatchObject({actionable: true, base: 'inc-1/-'});
      const nothing = createYQuarantineRecord(
        {...input, snapshot: replica(() => {})},
        {generation: 'inc-1/-', state: base()},
      );
      expect(nothing.actionable).toBe(false);
    });

    test('createYQuarantineRecord: peers (default true, unknown provenance) and clients (default none) are kept, in the hash and the default id, and change nothing it reads', () => {
      const input = {
        kind: 'handoff' as const,
        receivedAt: 1,
        snapshot: replica(insert),
        source: SOURCE,
      };
      const plain = createYQuarantineRecord(input, {
        generation: 'inc-1/-',
        state: base(),
      });
      expect(plain).toMatchObject({clients: [], peers: true});
      const declared = createYQuarantineRecord(
        {...input, clients: [7, 9], peers: false},
        {generation: 'inc-1/-', state: base()},
      );
      expect(declared).toMatchObject({clients: [7, 9], peers: false});
      // Another history with the same bytes: another record.
      expect(declared.hash).not.toBe(plain.hash);
      expect(declared.id).not.toBe(plain.id);
      // Canonical: the same ids in another order or twice, the same record.
      const again = createYQuarantineRecord(
        {...input, clients: [9, 7, 9], peers: false},
        {generation: 'inc-1/-', state: base()},
      );
      expect(again.clients).toEqual([7, 9]);
      expect(again.hash).toBe(declared.hash);
      expect(
        createYQuarantineRecord({...input, clients: [7, 9], peers: true}).hash,
      ).not.toBe(declared.hash);
      expect(declared.actionable).toBe(plain.actionable);
      expect(declared.complete).toBe(plain.complete);
      const none = {...input, snapshot: replica(() => {})};
      expect(
        createYQuarantineRecord(
          {...none, clients: [1], peers: false},
          {generation: 'inc-1/-', state: base()},
        ).actionable,
      ).toBe(false);
    });
    test('the record hash (version 1) is SHA-256 over the documented canonical payload, and covers exactly the payload', () => {
      const signal: YLegacySignal = {
        client: 99,
        clock: 0,
        key: 'lexical-y-schema:9',
        root: 'lexical-y',
        update: new Uint8Array([1, 2, 3]),
      };
      // Valid updates for the byte parts (each part is applied when the
      // source view is built).
      const updates: Uint8Array[] = [];
      const author = new Y.Doc({gc});
      author.clientID = 500;
      author.on('update', (u: Uint8Array) => updates.push(u));
      author.get('x').insert(0, 'a');
      author.get('x').insert(1, 'b');
      author.get('x').insert(2, 'c');
      const input = {
        clients: [9, 3, 9],
        deltas: [updates[0], updates[1]],
        // Keys out of order on purpose: the hash sorts them.
        // eslint-disable-next-line sort-keys-fix/sort-keys-fix
        draft: {differs: true, json: {b: [1, 'x'], a: {d: null, c: true}}},
        kind: 'handoff' as const,
        peers: false,
        queue: [updates[2]],
        receivedAt: 1,
        replica: 'r1',
        requires: ['z', 'a', 'z'],
        session: 's1',
        signals: [signal],
        snapshot: replica(insert),
        source: SOURCE,
      };
      const built = createYQuarantineRecord(input);
      // An independent build of the payload the docs describe.
      const header = JSON.stringify({
        clients: [3, 9],
        deltas: [updates[0].length, updates[1].length],
        draft: {differs: true, json: {a: {c: true, d: null}, b: [1, 'x']}},
        kind: 'handoff',
        peers: false,
        queue: [updates[2].length],
        requires: ['a', 'z'],
        signals: [
          {
            client: 99,
            clock: 0,
            key: 'lexical-y-schema:9',
            root: 'lexical-y',
            update: 3,
          },
        ],
        snapshot: input.snapshot.length,
        source: Object.fromEntries(
          Object.entries(SOURCE).sort(([x], [y]) => (x < y ? -1 : 1)),
        ),
        updateFormat: 'yjs-v1',
        v: 1,
      });
      const size = Buffer.alloc(4);
      size.writeUInt32BE(Buffer.byteLength(header));
      const want = createHash('sha256')
        .update('lexical-y-record:1\n')
        .update(size)
        .update(header)
        .update(input.snapshot)
        .update(input.deltas[0])
        .update(input.deltas[1])
        .update(input.queue[0])
        .update(signal.update)
        .digest('hex');
      expect(built.hash).toBe(`yr1-sha256:${want}`);
      expect(built).toMatchObject({clients: [3, 9], requires: ['a', 'z']});
      // Not in it: the id, session, replica and times; a draft's key order.
      for (const same of [
        {...input, id: 'other'},
        {...input, session: 's2'},
        {...input, replica: 'r2'},
        {...input, receivedAt: 2},
        {
          ...input,
          // eslint-disable-next-line sort-keys-fix/sort-keys-fix
          draft: {differs: true, json: {a: {d: null, c: true}, b: [1, 'x']}},
        },
        {...input, requires: ['a', 'z']},
      ]) {
        expect(createYQuarantineRecord(same).hash).toBe(built.hash);
      }
      // In it: the source (generation and incarnation), the signal
      // transcripts, the requirements, every byte part and its split.
      for (const other of [
        {...input, source: {...SOURCE, generation: 'another'}},
        {...input, source: {...SOURCE, incarnation: 'another'}},
        {...input, source: {...SOURCE, renderer: 'another'}},
        {...input, signals: []},
        {...input, signals: [{...signal, clock: 1}]},
        {...input, signals: [{...signal, update: new Uint8Array([1, 2, 4])}]},
        {...input, requires: ['a']},
        {...input, deltas: [updates[1], updates[0]]},
        {
          ...input,
          deltas: [input.deltas[0]],
          queue: [input.deltas[1], ...input.queue],
        },
        {...input, draft: {differs: false, json: input.draft.json}},
        {...input, draft: null},
        {...input, snapshot: null},
      ]) {
        expect(createYQuarantineRecord(other).hash).not.toBe(built.hash);
      }
      // A draft that is not JSON is refused: keep the material.
      for (const json of [
        {a: undefined, b: NaN},
        {a: () => 1},
        {a: BigInt(1)},
        {a: new Date(0)},
        // eslint-disable-next-line no-sparse-arrays
        [1, , 2],
      ]) {
        expect(() =>
          createYQuarantineRecord({...input, draft: {differs: true, json}}),
        ).toThrow(TypeError);
      }
    });

    test('a record and a capture copy what they are given: changing the inputs afterwards changes nothing', () => {
      const snapshot = replica(insert);
      const delta = replica(remove);
      const signal: YLegacySignal = {
        client: 99,
        clock: 0,
        key: 'lexical-y-schema:9',
        root: 'lexical-y',
        update: new Uint8Array([1, 2, 3]),
      };
      const draftJson = {a: [1], b: {c: 'x'}};
      const source = {...SOURCE, layouts: [1, 2] as [number, number]};
      const input = {
        clients: [3, 1],
        deltas: [delta],
        draft: {differs: true, json: draftJson},
        kind: 'handoff' as const,
        queue: [] as Uint8Array[],
        receivedAt: 1,
        requires: ['f'],
        signals: [signal],
        snapshot,
        source,
      };
      const built = createYQuarantineRecord(input);
      const copy = JSON.stringify({
        ...built,
        deltas: built.deltas.map(d => [...d]),
        signals: built.signals.map(sg => ({...sg, update: [...sg.update]})),
        snapshot: [...built.snapshot!],
      });
      snapshot[snapshot.length - 1] ^= 0xff;
      delta[0] ^= 0xff;
      signal.update[0] = 9;
      input.deltas.push(new Uint8Array([0]));
      input.signals.push(signal);
      input.clients.push(7);
      input.requires.push('g');
      draftJson.a.push(2);
      draftJson.b.c = 'changed';
      source.layouts[1] = 9;
      expect(
        JSON.stringify({
          ...built,
          deltas: built.deltas.map(d => [...d]),
          signals: built.signals.map(sg => ({...sg, update: [...sg.update]})),
          snapshot: [...built.snapshot!],
        }),
      ).toBe(copy);
      // A capture keeps copies too, and hands out copies.
      const update = replica(insert);
      const capture = createYSessionCapture();
      capture.add(update);
      const kept = [...update];
      update[0] ^= 0xff;
      const material = capture.material();
      expect([...material.snapshot!]).toEqual(kept);
      material.snapshot![0] ^= 0xff;
      (material.deltas as Uint8Array[]).push(new Uint8Array([0]));
      expect([...capture.material().snapshot!]).toEqual(kept);
      expect(capture.material().deltas).toHaveLength(0);
    });

    test('a source with fields this release does not know is deep-copied, and collisions() hands out copies', () => {
      const extension = {nested: {list: [1, 2]}, note: 'x'};
      const source = {...SOURCE, extension};
      const built = createYQuarantineRecord({
        kind: 'handoff',
        receivedAt: 1,
        snapshot: replica(insert),
        source,
      });
      const before = JSON.stringify(built.source);
      extension.nested.list.push(3);
      extension.note = 'changed';
      expect(JSON.stringify(built.source)).toBe(before);
      expect(built.source).toMatchObject({
        extension: {nested: {list: [1, 2]}, note: 'x'},
      });
      // A source that is not JSON is refused, as the hash refuses it.
      expect(() =>
        createYQuarantineRecord({
          kind: 'handoff',
          receivedAt: 1,
          source: {...SOURCE, extension: new Date(0)} as never,
        }),
      ).toThrow(TypeError);
      // collisions(): copies, like material().
      const legacy = docOf(LAYOUT1);
      const capture = createYSessionCapture();
      capture.add(Y.encodeStateAsUpdate(legacy, capture.syncStep1));
      const signal = capture.signal(SEED)!;
      legacy.clientID = signal.client;
      legacy.get('lexical-y').setAttr('other', 1 as never);
      capture.add(
        Y.encodeStateAsUpdate(
          legacy,
          Y.encodeStateVector(docOf(capture.material().snapshot!)),
        ),
      );
      const found = capture.collisions();
      expect(found).toEqual([signal]);
      found[0].update[0] ^= 0xff;
      (found as YLegacySignal[]).push(signal);
      expect(capture.collisions()).toEqual([signal]);
    });

    test('record kinds are open: a kind from a later release is kept as it is, preservation only', () => {
      const kind: YQuarantineRecordKind = 'a-later-kind';
      const input = {
        kind,
        receivedAt: 1,
        snapshot: replica(() => {}),
        source: SOURCE,
      };
      const later = createYQuarantineRecord(input, {
        generation: G0,
        state: base(),
      });
      // Never judged as a known kind: it cannot be shown to hold nothing.
      expect(later).toMatchObject({actionable: true, kind: 'a-later-kind'});
      const known = createYQuarantineRecord(
        {...input, kind: 'handoff'},
        {generation: G0, state: base()},
      );
      expect(known.actionable).toBe(false);
      expect(later.hash).not.toBe(known.hash);
    });

    test('a record requiring a feature is kept as it is and counts as actionable', () => {
      const input = {
        kind: 'handoff' as const,
        receivedAt: 1,
        snapshot: replica(() => {}),
        source: SOURCE,
      };
      const known = createYQuarantineRecord(input, {
        generation: G0,
        state: base(),
      });
      expect(known.actionable).toBe(false);
      const required = createYQuarantineRecord(
        {...input, requires: ['future']},
        {generation: G0, state: base()},
      );
      expect(required).toMatchObject({actionable: true, requires: ['future']});
      expect(required.hash).not.toBe(known.hash);
    });

    test('a durable acknowledgement names the room, the replica, the source generation, the record and its hash', () => {
      const stored = createYQuarantineRecord({
        kind: 'handoff',
        receivedAt: 1,
        replica: 'r1',
        snapshot: replica(insert),
        source: SOURCE,
      });
      const ack: YRecordAcknowledgement = {
        hash: stored.hash,
        record: stored.id,
        replica: stored.replica!,
        room: 'room-1',
        sourceGeneration: stored.source.generation ?? UNKNOWN_GENERATION,
        v: 1,
      };
      expect(ack).toEqual({
        hash: stored.hash,
        record: stored.id,
        replica: 'r1',
        room: 'room-1',
        sourceGeneration: SOURCE.generation,
        v: 1,
      });
    });
  });

  test('replayYRecovery (internal) is not implemented yet', () => {
    expect(() =>
      replayYRecovery(
        createYQuarantineRecord({
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
