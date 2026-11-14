/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The layout migration runner (@lexical/y/migrate) with synthetic steps:
// chain selection and loading, refusals before anything is written,
// receipts, the hashed client id, MIGRATION_ORIGIN, the refusal inside a
// transaction, every post-condition check (a step that breaks one fails
// with nothing written), idempotence and determinism. gc off and on.

import * as Y from '@y/y';
import {describe, expect, test, vi} from 'vitest';

import {createYDoc, LAYOUT_VERSION, MIN_LAYOUT} from '../..';
import {createYWriter, editYState, seedYState} from '../../headless';
import {
  layoutEpoch,
  migrateYDoc,
  MIGRATION_ORIGIN,
  migrationClientID,
  recordedLayout,
} from '../../internal/Runner';
import {
  loadYMigrationSteps,
  migrateYState,
  type YLayoutMigration,
  YMigrationError,
  type YMigrationErrorCode,
} from '../../migrate';
import step1to2 from '../../migrate/1to2';
import {catalogHeadlessConfig, seedShapes} from '../catalog/bind';
import {$appendShapes, NODE_SHAPES, shapesWith} from '../catalog/nodes';
import {CORE_OPS} from '../catalog/ops';
import {mulberry32} from '../utils/fuzz';
import {
  containersOf,
  insertFormatAfter,
  NO_OP_REWRITE,
  NOTHING,
  readItems,
  REWRITE,
  SEED,
  stableJSON,
  STAMP,
  stamp,
} from '../utils/migrateSteps';

const ROOT = 'lexical-y';
const CFG = {blockIds: 'absent'} as const;

/**
 * A whole-root rendering for tests: per container, its attributes (the
 * root's but its layout records and epoch) and every live countable item's
 * id, length, content and plain-fold format values.
 */
function renderDoc(root: Y.Node): string[] {
  return containersOf(root).map(node => {
    const content = (it: Y.Item) =>
      it.content instanceof Y.ContentType
        ? '<type>'
        : stableJSON(it.content.getContent());
    const parts: string[] = [];
    const attrs: string[] = [];
    for (const key of [...node._map.keys()].sort()) {
      const it = node._map.get(key)!;
      if (
        !it.deleted &&
        !(
          node === root &&
          (key.startsWith('lexical-y:') || key === 'lexical-y-epoch')
        )
      ) {
        attrs.push(`${key}=${it.id.client}.${it.id.clock}:${content(it)}`);
      }
    }
    parts.push(attrs.join(','));
    const items = readItems(node);
    let i = 0;
    for (let it = node._start; it !== null; it = it.right) {
      if (
        !it.deleted &&
        !(it.content instanceof Y.ContentFormat) &&
        it.countable
      ) {
        parts.push(
          `${it.id.client}.${it.id.clock}+${it.length}:${content(it)}:${items[i]}`,
        );
        i += it.length;
      }
    }
    return parts.join('|');
  });
}

/** The index of the first live text item of `node`, null when none. */
function firstTextIn(node: Y.Node): number | null {
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
  return null;
}

/** The first character of the first live text item of `node`. */
function firstCharIn(node: Y.Node): string {
  for (let it = node._start; it !== null; it = it.right) {
    if (!it.deleted && it.content instanceof Y.ContentString) {
      return it.content.str.charAt(0);
    }
  }
  return '';
}

/** A layout 1 document: catalog shapes (with tables) and random edits. */
function layout1(seed: number, edits = 6): Uint8Array {
  const rand = mulberry32(seed);
  const pick = () => NODE_SHAPES[Math.floor(rand() * NODE_SHAPES.length)];
  const shapes = [pick(), shapesWith('table')[0], pick()];
  let state = seedShapes(shapes, CFG);
  const writer = createYWriter(`runner-${seed}`);
  for (let i = 0; i < edits; i++) {
    const op = CORE_OPS[Math.floor(rand() * CORE_OPS.length)];
    try {
      state = editYState(
        state,
        catalogHeadlessConfig(CFG),
        () => {
          op.$run(rand);
        },
        {writer},
      ).state;
    } catch (e) {
      // An edit the shape refuses writes nothing; an op that throws is
      // logged (main's ops on catalog shapes, not the migration's concern).
      if (!String(e).includes('nothing')) {
        EDIT_THROWS.push(`${seed} ${op.name}: ${String(e).slice(0, 120)}`);
      }
    }
  }
  return state;
}

const STATES = new Map<number, Uint8Array>();
function stateOf(seed: number): Uint8Array {
  let s = STATES.get(seed);
  if (s === undefined) {
    s = layout1(seed);
    STATES.set(seed, s);
  }
  return s;
}

const same = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a).equals(Buffer.from(b));

function expectRefused(
  run: () => unknown,
  code: YMigrationErrorCode,
  problem?: string,
): YMigrationError {
  let error: unknown = null;
  try {
    run();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(YMigrationError);
  const e = error as YMigrationError;
  expect(e.code).toBe(code);
  if (problem !== undefined) {
    expect([e.message, ...e.problems].join('\n')).toContain(problem);
  }
  return e;
}

/** A live document's transactions while `run` runs. */
function transactionsOf(doc: Y.Doc, run: () => void): unknown[] {
  const origins: unknown[] = [];
  const f = (tr: Y.Transaction) => origins.push(tr.origin);
  doc.on('afterTransaction', f);
  try {
    run();
  } finally {
    doc.off('afterTransaction', f);
  }
  return origins;
}

/** Edits that threw while building documents (see the catch above). */
const EDIT_THROWS: string[] = [];

/** The first random seed (catalog documents). */
const RSEED = 8_000_001;
const TO2 = {to: SEED + 1};

describe.each([false, true])('migration runner, gc %s', gc => {
  const docOf = (state: Uint8Array) => createYDoc(state, {gc});

  describe('chains', () => {
    test('the default target is MIN_LAYOUT (nothing runs on a seed); one layout up runs the stamp, two run the stamp then the rewrite', () => {
      const state = stateOf(RSEED);
      expect(recordedLayout(docOf(state))).toBe(SEED);
      const none = migrateYState(state, [REWRITE, STAMP], {gc});
      expect(none.state).toBe(state);
      expect(none.update).toBeNull();
      expect(none.pending).toBeNull();
      expect(none.receipt).toMatchObject({changed: false});
      const two = migrateYState(state, [REWRITE, STAMP], {
        gc,
        to: SEED + 1,
      });
      expect(two.receipt.roots.map(r => r.steps.map(s => s.id))).toEqual([
        [`lexical-y/layout/${SEED}to${SEED + 1}`],
      ]);
      expect(recordedLayout(docOf(two.state))).toBe(SEED + 1);
      const three = migrateYState(state, [REWRITE, STAMP], {
        gc,
        to: SEED + 2,
      });
      expect(three.receipt.roots[0]).toMatchObject({
        changed: true,
        from: SEED,
        root: ROOT,
        to: SEED + 2,
      });
      expect(three.receipt.roots[0].steps.map(s => s.id)).toEqual([
        `lexical-y/layout/${SEED}to${SEED + 1}`,
        `lexical-y/layout/${SEED + 1}to${SEED + 2}`,
      ]);
      expect(recordedLayout(docOf(three.state))).toBe(SEED + 2);
      // The order the steps are given in does not matter.
      const again = migrateYState(state, [STAMP, REWRITE], {
        gc,
        to: SEED + 2,
      });
      expect(same(again.state, three.state)).toBe(true);
    });

    test('a chain of two writes the same bytes as each step in turn', () => {
      for (const seed of [RSEED, RSEED + 1, RSEED + 2]) {
        const state = stateOf(seed);
        const chained = migrateYState(state, [STAMP, REWRITE], {
          gc,
          to: SEED + 2,
        });
        const first = migrateYState(state, [STAMP], {gc, to: SEED + 1});
        const second = migrateYState(first.state, [REWRITE], {
          gc,
          to: SEED + 2,
        });
        expect(same(second.state, chained.state)).toBe(true);
        expect(second.receipt.roots[0].epoch).toEqual(
          chained.receipt.roots[0].epoch,
        );
      }
    });

    test("a step whose target layout needs a rewrite fails through the step's checkAfter when it only stamps, the re-read included", () => {
      const state = stateOf(RSEED + 3);
      expectRefused(
        () => migrateYState(state, [STAMP, NO_OP_REWRITE], {gc, to: SEED + 2}),
        'post-condition',
        'not rewritten',
      );
      // Passes the result's checkAfter, fails the re-read's: a check that
      // reads state the encoding does not keep.
      const marked = new WeakSet<object>();
      const flaky = stamp(SEED, {
        checkAfter: node => (marked.has(node) ? [] : ['not marked']),
        migrateContainer: (tr, node) => {
          marked.add(node);
          return NOTHING;
        },
      });
      const e = expectRefused(
        () => migrateYState(state, [flaky], {gc, to: SEED + 1}),
        'post-condition',
        're-read: container',
      );
      expect(e.problems.some(p => p.startsWith('result:'))).toBe(false);
      expect(
        migrateYState(state, [STAMP, REWRITE], {gc, to: SEED + 2}).receipt
          .changed,
      ).toBe(true);
    });

    test('a missing link or an ill-formed list of steps throws missing-step before anything runs', () => {
      const state = stateOf(RSEED);
      const cases: [YLayoutMigration[], number, YMigrationErrorCode, string][] =
        [
          [[REWRITE], SEED + 2, 'missing-step', `no step from layout ${SEED}`],
          [
            [STAMP, stamp(SEED)],
            SEED + 1,
            'invalid-steps',
            'two steps are named',
          ],
          [
            [
              STAMP,
              stamp(SEED, {id: `lexical-y/layout/${SEED}to${SEED + 1}b`}),
            ],
            SEED + 1,
            'invalid-steps',
            'is not named',
          ],
          [
            [
              stamp(SEED, {
                id: `lexical-y/layout/${SEED}to${SEED + 2}`,
                to: SEED + 2,
              }),
            ],
            SEED + 2,
            'invalid-steps',
            `links ${SEED} to ${SEED + 2}`,
          ],
          [
            [stamp(SEED, {revision: 0})],
            SEED + 1,
            'invalid-steps',
            'has revision 0',
          ],
          [
            [{id: 'x'} as unknown as YLayoutMigration],
            SEED + 1,
            'invalid-steps',
            'not a layout',
          ],
        ];
      for (const [steps, to, code, problem] of cases) {
        expectRefused(
          () => migrateYState(state, steps, {gc, to}),
          code,
          problem,
        );
      }
      // Two well-formed steps from one layout cannot be named apart:
      // checked on the chain.
      const doc = docOf(state);
      const bytes = Y.encodeStateAsUpdate(doc);
      const origins = transactionsOf(doc, () =>
        expectRefused(
          () => migrateYDoc(doc, [REWRITE], {to: SEED + 2}),
          'missing-step',
        ),
      );
      expect(origins).toEqual([]);
      expect(same(Y.encodeStateAsUpdate(doc), bytes)).toBe(true);
    });

    test('a root at or above the target is not migrated (the same bytes back)', () => {
      const state = stateOf(RSEED);
      const once = migrateYState(state, [STAMP], {gc, to: SEED + 1});
      expect(once.update).not.toBeNull();
      const twice = migrateYState(once.state, [STAMP], {gc, to: SEED + 1});
      expect(twice.state).toBe(once.state);
      expect(twice.update).toBeNull();
      expect(twice.receipt).toMatchObject({changed: false});
      expect(twice.receipt.roots[0]).toMatchObject({
        from: SEED + 1,
        to: SEED + 1,
      });
    });

    test('a step of another contract version (v) is refused before the runner calls anything; a migrateContainer may return nothing', async () => {
      const calls: string[] = [];
      const later = {
        ...stamp(SEED, {
          checkAfter: () => {
            calls.push('checkAfter');
            return [];
          },
          migrateContainer: () => {
            calls.push('migrateContainer');
          },
          readAfter: c => {
            calls.push('readAfter');
            return readItems(c);
          },
          readBefore: c => {
            calls.push('readBefore');
            return readItems(c);
          },
          rewrites: () => {
            calls.push('rewrites');
            return false;
          },
        }),
        v: 3,
      } as unknown as YLayoutMigration;
      const state = stateOf(RSEED);
      expectRefused(
        () => migrateYState(state, [later], {gc, ...TO2}),
        'invalid-steps',
        'step contract 3',
      );
      await expect(
        loadYMigrationSteps(SEED, SEED + 1, {
          loaders: {[SEED]: async () => later},
        }),
      ).rejects.toMatchObject({code: 'invalid-steps'});
      expect(calls).toEqual([]);
      // Returning nothing (void) is a step's ordinary shape.
      const quiet = stamp(SEED, {migrateContainer: () => undefined});
      const out = migrateYState(state, [quiet], {gc, ...TO2});
      expect(out.receipt.changed).toBe(true);
      expect(recordedLayout(docOf(out.state))).toBe(SEED + 1);
    });

    test('loadYMigrationSteps loads only the links a root needs', async () => {
      const first = vi.fn(async () => ({default: STAMP}));
      const second = vi.fn(async () => REWRITE);
      const loaders = {
        [SEED]: first,
        [SEED + 1]: second,
        runner: async () => ({}),
      };
      expect(
        await loadYMigrationSteps(SEED + 1, SEED + 2, {loaders: loaders}),
      ).toEqual([REWRITE]);
      expect(first).not.toHaveBeenCalled();
      expect(
        await loadYMigrationSteps(SEED, SEED + 2, {loaders: loaders}),
      ).toEqual([STAMP, REWRITE]);
      expect(
        await loadYMigrationSteps(SEED + 1, SEED + 1, {loaders: loaders}),
      ).toEqual([]);
      // Default target: MIN_LAYOUT (nothing to load from the floor).
      expect(
        await loadYMigrationSteps(MIN_LAYOUT, undefined, {
          loaders: {[MIN_LAYOUT]: second},
        }),
      ).toEqual([]);
      // Default loaders: the published steps, each its own entry.
      expect(await loadYMigrationSteps(1, 2)).toEqual([step1to2]);
      await expect(
        loadYMigrationSteps(SEED, SEED + 2, {loaders: {[SEED + 1]: second}}),
      ).rejects.toMatchObject({code: 'missing-step'});
      await expect(
        loadYMigrationSteps(SEED, SEED + 1, {
          loaders: {[SEED]: async () => REWRITE},
        }),
      ).rejects.toMatchObject({code: 'invalid-steps'});
      await expect(
        loadYMigrationSteps(SEED, SEED + 1, {
          loaders: {[SEED]: async () => ({default: {}})},
        }),
      ).rejects.toMatchObject({code: 'invalid-steps'});
    });
  });

  describe('refusals before anything is written', () => {
    test('content without a layout record: missing; a pristine or absent root: unchanged', () => {
      const raw = new Y.Doc({gc});
      raw.get(ROOT).insert(0, 'text');
      expectRefused(
        () => migrateYState(Y.encodeStateAsUpdate(raw), [STAMP], {gc, ...TO2}),
        'missing',
      );
      const pinned = new Y.Doc({gc});
      pinned.get(ROOT).setAttr('k:paragraph', 'element');
      expectRefused(
        () =>
          migrateYState(Y.encodeStateAsUpdate(pinned), [STAMP], {
            gc,
            ...TO2,
          }),
        'missing',
      );
      const other = new Y.Doc({gc});
      other.get('other').insert(0, 'x');
      const absent = migrateYState(Y.encodeStateAsUpdate(other), [STAMP], {
        gc,
        ...TO2,
      });
      expect(absent.receipt.changed).toBe(false);
      expect(absent.receipt.roots[0]).toMatchObject({from: null, to: null});
      // A root whose content was all deleted, with no record: pristine.
      const emptied = new Y.Doc({gc});
      emptied.get(ROOT).insert(0, 'x');
      emptied.get(ROOT).delete(0, 1);
      expect(
        migrateYState(Y.encodeStateAsUpdate(emptied), [STAMP], {
          gc,
          ...TO2,
        }).receipt.changed,
      ).toBe(false);
    });

    test('a malformed record or epoch: malformed; a record at or above the target, even above LAYOUT_VERSION: unchanged', () => {
      const bad: [string, unknown][] = [
        ['lexical-y:x', true],
        ['lexical-y:02', true],
        [`lexical-y:${SEED}`, 'yes'],
        ['lexical-y-epoch', 'x'],
        ['lexical-y-epoch', {v: 1}],
        [
          'lexical-y-epoch',
          {
            client: 1,
            clock: 0,
            layout: 2,
            revision: 1,
            step: `lexical-y/layout/${SEED}to${SEED + 1}`,
            v: 2,
          },
        ],
        [
          'lexical-y-epoch',
          {
            client: 0,
            clock: 0,
            layout: 2,
            revision: 1,
            step: `lexical-y/layout/${SEED}to${SEED + 1}`,
            v: 1,
          },
        ],
      ];
      for (const [key, value] of bad) {
        const doc = docOf(stateOf(RSEED));
        doc.get(ROOT).setAttr(key, value as never);
        expectRefused(
          () =>
            migrateYState(Y.encodeStateAsUpdate(doc), [STAMP], {
              gc,
              ...TO2,
            }),
          'malformed',
          key,
        );
      }
      // A rollback from a newer release, or a server upgraded after its
      // clients: no step, nothing written, the same bytes.
      const doc = docOf(stateOf(RSEED));
      doc.get(ROOT).setAttr(`lexical-y:${LAYOUT_VERSION + 7}`, true);
      const newer = Y.encodeStateAsUpdate(doc);
      for (const steps of [[], [STAMP], [STAMP, REWRITE]]) {
        const result = migrateYState(newer, steps, {gc, to: SEED + 2});
        expect(result.update).toBeNull();
        expect(Buffer.from(result.state)).toEqual(Buffer.from(newer));
        expect(result.receipt.roots[0]).toMatchObject({
          from: LAYOUT_VERSION + 7,
          steps: [],
        });
      }
      const live = docOf(newer);
      expect(migrateYDoc(live, [], {to: SEED + 2}).changed).toBe(false);
      expect(recordedLayout(live)).toBe(LAYOUT_VERSION + 7);
    });

    test('inside a transaction of the document: in-transaction, nothing written', () => {
      const doc = docOf(stateOf(RSEED));
      const bytes = Y.encodeStateAsUpdate(doc);
      doc.transact(() => {
        expectRefused(() => migrateYDoc(doc, [STAMP], TO2), 'in-transaction');
      });
      expect(same(Y.encodeStateAsUpdate(doc), bytes)).toBe(true);
      expect(recordedLayout(doc)).toBe(SEED);
    });
  });

  describe('pending material', () => {
    /** Updates of a writer of another type: insert a, insert b, delete a. */
    function laterUpdates(): Uint8Array[] {
      const author = new Y.Doc({gc});
      const updates: Uint8Array[] = [];
      author.on('update', (u: Uint8Array) => updates.push(u));
      author.get('other').insert(0, 'a');
      author.get('other').insert(1, 'b');
      author.get('other').delete(0, 1);
      return updates;
    }

    test('pending structs and a pending delete set are split out of the state, never migrated', () => {
      const updates = laterUpdates();
      const held = docOf(stateOf(RSEED));
      Y.applyUpdate(held, updates[1]);
      Y.applyUpdate(held, updates[2]);
      expect(held.store.pendingStructs).not.toBeNull();
      expect(held.store.pendingDs).not.toBeNull();
      const input = Y.encodeStateAsUpdate(held);
      const r = migrateYState(input, [STAMP], {gc, ...TO2});
      expect(r.receipt.changed).toBe(true);
      expect(r.pending).not.toBeNull();
      const out = docOf(r.state);
      expect(out.store.pendingStructs).toBeNull();
      expect(out.store.pendingDs).toBeNull();
      expect(recordedLayout(out)).toBe(SEED + 1);
      // The pending material, then its missing update, completes the
      // writer's change on the migrated state.
      Y.applyUpdate(out, r.pending!);
      Y.applyUpdate(out, updates[0]);
      expect(out.store.pendingStructs).toBeNull();
      expect(out.store.pendingDs).toBeNull();
      expect(out.get('other').toString()).toBe('b');
      // A live document cannot drop it in place: refused.
      const origins = transactionsOf(held, () =>
        expectRefused(() => migrateYDoc(held, [STAMP], TO2), 'pending'),
      );
      expect(origins).toEqual([]);
      expect(recordedLayout(held)).toBe(SEED);
      // A document that does not migrate is a no-op whatever it holds.
      const none = migrateYState(input, [STAMP], {gc});
      expect(none.state).toBe(input);
      expect(none.pending).toBeNull();
    });

    /** Two text containers of `root`, the first holding text. */
    const twoTexts = (root: Y.Node): [Y.Node, Y.Node] => {
      const nodes = containersOf(root).filter(n => firstTextIn(n) !== null);
      expect(nodes.length).toBeGreaterThanOrEqual(2);
      return [nodes[0], nodes[1]];
    };

    /**
     * A relay of the document that received, of client 22's two updates
     * (one per container), only the second: Yjs integrates it past the gap
     * in client 22's clocks (a skipped range). `dependent`: client 33 then
     * writes once elsewhere and once right after 22's second insert, and
     * the relay gets both.
     */
    function skipped(dependent: boolean) {
      const state = stateOf(RSEED + 3);
      const author = docOf(state);
      author.clientID = 22;
      const updates: Uint8Array[] = [];
      author.on('update', (u: Uint8Array) => updates.push(u));
      const [a, b] = twoTexts(author.get(ROOT));
      a.insert(firstTextIn(a)!, 'X');
      b.insert(firstTextIn(b)!, 'Y');
      const relay = docOf(state);
      Y.applyUpdate(relay, updates[1]);
      const full = docOf(state);
      Y.applyUpdate(full, updates[0]);
      Y.applyUpdate(full, updates[1]);
      const later: Uint8Array[] = [];
      if (dependent) {
        const other = docOf(state);
        other.clientID = 33;
        Y.applyUpdate(other, updates[1]);
        other.on('update', (u: Uint8Array) => later.push(u));
        const [, b2] = twoTexts(other.get(ROOT));
        const [a2] = twoTexts(other.get(ROOT));
        a2.insert(0, 'W');
        b2.insert(firstTextIn(b2)! + 1, 'Z');
        for (const u of later) {
          Y.applyUpdate(relay, u);
          Y.applyUpdate(full, u);
        }
      }
      return {full, relay, updates};
    }

    test.each([false, true])(
      'a skipped range (dependent writer %s): the gap and everything after or on it split out, the rest migrated',
      dependent => {
        const {relay, updates, full} = skipped(dependent);
        expect(relay.store.skips.isEmpty()).toBe(false);
        expect(relay.store.pendingStructs).toBeNull();
        const input = Y.encodeStateAsUpdate(relay);
        const r = migrateYState(input, [STAMP], {gc, ...TO2});
        expect(r.receipt.changed).toBe(true);
        expect(r.pending).not.toBeNull();
        const out = docOf(r.state);
        expect(out.store.skips.isEmpty()).toBe(true);
        expect(out.store.pendingStructs).toBeNull();
        expect(out.store.pendingDs).toBeNull();
        expect(recordedLayout(out)).toBe(SEED + 1);
        // Client 22 starts at the gap: nothing of it is kept. Client 33's
        // first write is kept, the one on 22's item split out.
        expect(out.store.clients.has(22)).toBe(false);
        const sv = Y.decodeStateVector(Y.encodeStateVector(out));
        expect(sv.get(33)).toBe(dependent ? 1 : undefined);
        // The split material and the missing update complete the document.
        Y.applyUpdate(out, r.pending!);
        Y.applyUpdate(out, updates[0]);
        expect(out.store.skips.isEmpty()).toBe(true);
        expect(out.store.pendingStructs).toBeNull();
        const want = Y.decodeStateVector(Y.encodeStateVector(full));
        const got = Y.decodeStateVector(Y.encodeStateVector(out));
        for (const [client, clock] of want) {
          expect(got.get(client)).toBe(clock);
        }
        const text = (d: Y.Doc) =>
          renderDoc(d.get(ROOT)).map(line => line.replace(/\d+\.\d+[+=]/g, ''));
        expect(text(out)).toEqual(text(full));
        // A live document holding the skip: refused.
        expectRefused(() => migrateYDoc(relay, [STAMP], TO2), 'pending');
      },
    );

    test('a skipped range and pending structs together', () => {
      const {relay, updates, full} = skipped(false);
      const author = new Y.Doc({gc});
      const more: Uint8Array[] = [];
      author.on('update', (u: Uint8Array) => more.push(u));
      author.get('other').insert(0, 'a');
      author.get('other').insert(1, 'b');
      Y.applyUpdate(relay, more[1]);
      expect(relay.store.pendingStructs).not.toBeNull();
      expect(relay.store.skips.isEmpty()).toBe(false);
      const r = migrateYState(Y.encodeStateAsUpdate(relay), [STAMP], {
        gc,
        ...TO2,
      });
      const out = docOf(r.state);
      expect(out.store.skips.isEmpty()).toBe(true);
      expect(out.store.pendingStructs).toBeNull();
      Y.applyUpdate(out, r.pending!);
      Y.applyUpdate(out, updates[0]);
      Y.applyUpdate(out, more[0]);
      expect(out.store.pendingStructs).toBeNull();
      expect(out.store.skips.isEmpty()).toBe(true);
      expect(out.get('other').toString()).toBe('ab');
      const want = Y.decodeStateVector(Y.encodeStateVector(full));
      const got = Y.decodeStateVector(Y.encodeStateVector(out));
      for (const [client, clock] of want) {
        expect(got.get(client)).toBe(clock);
      }
    });
  });

  describe('receipts, origin, epoch', () => {
    test('a receipt per root; the update brings the input to the output', () => {
      const state = stateOf(RSEED + 3);
      const {
        state: out,
        update,
        receipt,
      } = migrateYState(state, [STAMP, REWRITE], {gc, to: SEED + 2});
      expect(receipt.v).toBe(1);
      expect(receipt.changed).toBe(true);
      expect(receipt.bytesBefore).toBe(state.length);
      expect(receipt.bytesAfter).toBe(out.length);
      expect(receipt.ms).toBeGreaterThanOrEqual(0);
      const [root] = receipt.roots;
      expect(root.steps).toHaveLength(2);
      const [s1, s2] = root.steps;
      expect(s1).toMatchObject({
        deleted: 0,
        id: `lexical-y/layout/${SEED}to${SEED + 1}`,
        revision: 1,
        written: 2,
      });
      expect(s2.id).toBe(`lexical-y/layout/${SEED + 1}to${SEED + 2}`);
      // The document holds text formats, each written again.
      expect(s2.written).toBeGreaterThan(2);
      // The rewrite replaced the stamp's epoch and each text format item.
      expect(s2.deleted).toBe(s2.written - 2 + 1);
      expect(s1.client).not.toBe(s2.client);
      for (const s of [s1, s2]) {
        expect(Number.isSafeInteger(s.client) && s.client > 0).toBe(true);
      }
      expect(root.epoch).toEqual({
        client: s2.client,
        clock: 0,
        kind: 'layout',
        layout: SEED + 2,
        revision: 1,
        step: `lexical-y/layout/${SEED + 1}to${SEED + 2}`,
        v: 1,
      });
      const doc = docOf(state);
      Y.applyUpdate(doc, update!);
      expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVector(docOf(out)));
      expect(renderDoc(doc.get(ROOT))).toEqual(renderDoc(docOf(out).get(ROOT)));
      expect(layoutEpoch(doc)).toEqual(root.epoch);
      expect(recordedLayout(doc)).toBe(SEED + 2);
      expect(doc.get(ROOT).getAttr(`lexical-y:${SEED}`)).toBe(true);
      expect(doc.get(ROOT).getAttr(`lexical-y:${SEED + 1}`)).toBe(true);
    });

    test('migrateYDoc applies one transaction with MIGRATION_ORIGIN', () => {
      expect(MIGRATION_ORIGIN).toBe(Symbol.for('@lexical/y/migration'));
      const doc = docOf(stateOf(RSEED));
      let receipt;
      const origins = transactionsOf(doc, () => {
        receipt = migrateYDoc(doc, [STAMP], TO2);
      });
      expect(origins).toEqual([MIGRATION_ORIGIN]);
      expect(receipt).toMatchObject({changed: true});
      expect(recordedLayout(doc)).toBe(SEED + 1);
      expect(transactionsOf(doc, () => migrateYDoc(doc, [STAMP], TO2))).toEqual(
        [],
      );
    });

    test('several roots: each its own chain, sorted by name, all or nothing', () => {
      const a = stateOf(RSEED);
      const b = seedYState(catalogHeadlessConfig(CFG, {root: 'B'}), () =>
        $appendShapes([NODE_SHAPES[3], shapesWith('table')[0]]),
      );
      const both = Y.mergeUpdates([a, b] as Uint8Array<ArrayBuffer>[]);
      const r = migrateYState(both, [STAMP], {
        gc,
        roots: [ROOT, 'B', ROOT],
        ...TO2,
      });
      expect(r.receipt.roots.map(x => [x.root, x.from, x.to])).toEqual([
        ['B', SEED, SEED + 1],
        [ROOT, SEED, SEED + 1],
      ]);
      const doc = docOf(r.state);
      expect(recordedLayout(doc, 'B')).toBe(SEED + 1);
      expect(recordedLayout(doc)).toBe(SEED + 1);
      // A refusal of one root refuses both.
      const bad = docOf(both);
      bad.get('B').setAttr('lexical-y:x', true);
      expectRefused(
        () =>
          migrateYState(Y.encodeStateAsUpdate(bad), [STAMP], {
            gc,
            roots: [ROOT, 'B'],
            ...TO2,
          }),
        'malformed',
      );
    });
  });

  describe('the client id', () => {
    test('a hash of every input, 53 or 32 bits, re-hashed while taken', () => {
      const state = new Uint8Array([1, 2, 3]);
      const input = {
        gc: true,
        id: 'lexical-y/layout/1to2',
        revision: 1,
        root: ROOT,
        to: 2,
      };
      const none = () => false;
      const id = migrationClientID(state, input, none);
      // Frozen (wire contract).
      expect(id).toMatchInlineSnapshot(`2477915295484220`);
      expect(migrationClientID(state.slice(), input, none)).toBe(id);
      const others = [
        migrationClientID(new Uint8Array([1, 2, 4]), input, none),
        migrationClientID(state, {...input, root: 'B'}, none),
        migrationClientID(state, {...input, id: 'x'}, none),
        migrationClientID(state, {...input, revision: 2}, none),
        migrationClientID(state, {...input, to: 3}, none),
        migrationClientID(state, {...input, gc: false}, none),
      ];
      expect(new Set([id, ...others]).size).toBe(7);
      const next = migrationClientID(state, input, c => c === id);
      expect(next).not.toBe(id);
      expect(
        migrationClientID(state, input, c => c === id || c === next),
      ).not.toBe(next);
      for (const c of [id, next, ...others]) {
        expect(Number.isSafeInteger(c) && c > 0).toBe(true);
      }
    });

    test("a clientID allocator's free id is used, a taken one refused", () => {
      const state = stateOf(RSEED);
      const seen: unknown[] = [];
      const own = migrateYState(state, [STAMP, REWRITE], {
        clientID: input => {
          seen.push(input);
          return 1000 + seen.length;
        },
        gc,
        to: SEED + 2,
      });
      expect(own.receipt.roots[0].steps.map(s => s.client)).toEqual([
        1001, 1002,
      ]);
      expect(seen).toEqual([
        {
          revision: 1,
          root: ROOT,
          step: `lexical-y/layout/${SEED}to${SEED + 1}`,
          to: SEED + 1,
        },
        {
          revision: 1,
          root: ROOT,
          step: `lexical-y/layout/${SEED + 1}to${SEED + 2}`,
          to: SEED + 2,
        },
      ]);
      const taken = [...docOf(state).store.clients.keys()][0];
      expectRefused(
        () =>
          migrateYState(state, [STAMP], {
            clientID: () => taken,
            gc,
            ...TO2,
          }),
        'post-condition',
        'allocator',
      );
      expectRefused(
        () =>
          migrateYState(state, [STAMP], {
            clientID: () => 0.5,
            gc,
            ...TO2,
          }),
        'post-condition',
        'allocator',
      );
    });

    test('two roots of the same bytes migrate under different clients, and merge (r16-4)', () => {
      const a = stateOf(RSEED + 4);
      const b = seedYState(catalogHeadlessConfig(CFG, {root: 'B'}), () =>
        $appendShapes([NODE_SHAPES[3], NODE_SHAPES[5]]),
      );
      const both = Y.mergeUpdates([a, b] as Uint8Array<ArrayBuffer>[]);
      const m1 = docOf(both);
      const m2 = docOf(both);
      const r1 = migrateYDoc(m1, [STAMP, REWRITE], {to: SEED + 2});
      const r2 = migrateYDoc(m2, [STAMP, REWRITE], {
        roots: ['B'],
        to: SEED + 2,
      });
      const c1 = r1.roots[0].steps.map(s => s.client);
      const c2 = r2.roots[0].steps.map(s => s.client);
      expect(c1.some(c => c2.includes(c))).toBe(false);
      Y.applyUpdate(m1, Y.encodeStateAsUpdate(m2, Y.encodeStateVector(m1)));
      expect(recordedLayout(m1)).toBe(SEED + 2);
      expect(recordedLayout(m1, 'B')).toBe(SEED + 2);
      const fresh = docOf(both);
      const itemsOf = (root: Y.Node) =>
        renderDoc(root).map(r => r.replace(/\d+\.\d+\+/g, ''));
      expect(itemsOf(m1.get(ROOT))).toEqual(itemsOf(fresh.get(ROOT)));
      expect(itemsOf(m1.get('B'))).toEqual(itemsOf(fresh.get('B')));
    });
  });

  describe('determinism and idempotence', () => {
    test('the same bytes give the same bytes; two authorities write one copy', () => {
      for (const seed of [RSEED + 5, RSEED + 6, RSEED + 7]) {
        const state = stateOf(seed);
        const steps = [STAMP, REWRITE];
        const x = migrateYState(state, steps, {gc, to: SEED + 2});
        const y = migrateYState(state.slice(), steps, {gc, to: SEED + 2});
        expect(same(x.state, y.state)).toBe(true);
        const a = docOf(state);
        const b = docOf(state);
        migrateYDoc(a, steps, {to: SEED + 2});
        migrateYDoc(b, steps, {to: SEED + 2});
        expect(same(Y.encodeStateAsUpdate(a), x.state)).toBe(true);
        Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
        expect(same(Y.encodeStateAsUpdate(a), x.state)).toBe(true);
        expect(same(Y.encodeStateAsUpdate(b), x.state)).toBe(true);
        // A migrated document writes nothing.
        const again = migrateYState(x.state, steps, {gc, to: SEED + 2});
        expect(again.state).toBe(x.state);
      }
    });

    test('reads are per countable unit: units of one item may read differently, and a change to one unit fails', () => {
      // A raw writer's single string item mixing a tab with other units.
      const raw = new Y.Doc({gc});
      raw.cleanupFormatting = false;
      const root = raw.get(ROOT);
      raw.transact(() => {
        root.setAttr(`lexical-y:${SEED}`, true);
        root.insert(0, 'a\tb');
        root.insert(3, [new Y.Node('¶')]);
      });
      const state = Y.encodeStateAsUpdate(raw);
      const unitRead =
        (marked: (unit: number) => boolean) => (node: Y.Node) => {
          const out: string[] = [];
          for (let it = node._start; it !== null; it = it.right) {
            if (!it.deleted && it.countable) {
              const text =
                it.content instanceof Y.ContentString ? it.content.str : null;
              for (let u = 0; u < it.length; u++) {
                out.push(
                  text !== null && text[u] === '\t' ? '{"t":"tab"}' : '{}',
                );
                if (marked(out.length - 1)) {
                  out[out.length - 1] += '!';
                }
              }
            }
          }
          return out;
        };
      const faithful = unitRead(() => false);
      expect(
        migrateYState(
          state,
          [stamp(SEED, {readAfter: faithful, readBefore: faithful})],
          {gc, to: SEED + 1},
        ).receipt.changed,
      ).toBe(true);
      expectRefused(
        () =>
          migrateYState(
            state,
            [
              stamp(SEED, {
                readAfter: unitRead(u => u === 1),
                readBefore: faithful,
              }),
            ],
            {gc, to: SEED + 1},
          ),
        'post-condition',
        'reads differently at unit 1',
      );
      // One string per item is the wrong shape.
      expectRefused(
        () =>
          migrateYState(
            state,
            [
              stamp(SEED, {
                readAfter: node => faithful(node).slice(0, 2),
                readBefore: node => faithful(node).slice(0, 2),
              }),
            ],
            {gc, to: SEED + 1},
          ),
        'post-condition',
        '2 strings for 4 units',
      );
    });

    test('splitting a countable item is not a change (units are compared)', () => {
      // Insert a rewritten key's null (a no-op for the fold) in the middle
      // of the first text item of more than one character.
      const split = stamp(SEED, {
        migrateContainer: (tr, node) => {
          for (let it = node._start; it !== null; it = it.right) {
            if (
              !it.deleted &&
              it.content instanceof Y.ContentString &&
              it.length > 1
            ) {
              const right = Y.getItemCleanStart(
                tr,
                Y.createID(it.id.client, it.id.clock + 1),
              );
              insertFormatAfter(tr, node, right.left!, 'f:zz', null);
              return {deleted: 0, written: 1};
            }
          }
          return NOTHING;
        },
        rewrites: key => key === 'f:zz',
      });
      const state = stateOf(RSEED);
      const r = migrateYState(state, [split], {gc, ...TO2});
      expect(r.receipt.roots[0].steps[0].written).toBeGreaterThan(2);
    });
  });

  describe('a step that breaks a post-condition fails with nothing written', () => {
    const nested = () => stateOf(RSEED + 3);
    /** A step whose first call on a container with text runs `f`. */
    const once = (
      f: (tr: Y.Transaction, node: Y.Node) => void,
      extra: Partial<YLayoutMigration> = {},
    ) => {
      let done = false;
      return stamp(SEED, {
        migrateContainer: (tr, node) => {
          if (!done && firstTextIn(node) !== null) {
            done = true;
            f(tr, node);
          }
          return NOTHING;
        },
        ...extra,
      });
    };
    const cases: [string, () => YLayoutMigration, string][] = [
      [
        'deletes a character',
        () => once((tr, node) => node.delete(firstTextIn(node)!, 1)),
        'countable content changed',
      ],
      [
        'moves a character',
        () =>
          once((tr, node) => {
            const at = firstTextIn(node)!;
            const ch = firstCharIn(node);
            node.delete(at, 1);
            node.insert(at + 1, ch);
          }),
        'countable content changed',
      ],
      [
        'writes a format key it does not rewrite',
        () =>
          once(
            (tr, node) =>
              insertFormatAfter(tr, node, node._start!, 's:flat', 'x'),
            {
              rewrites: key => key.startsWith('f:'),
            },
          ),
        "outside the step's keys",
      ],
      [
        'deletes a format item of a key it does not rewrite',
        () =>
          stamp(SEED, {
            migrateContainer: (tr, node) => {
              for (let it = node._start; it !== null; it = it.right) {
                if (!it.deleted && it.content instanceof Y.ContentFormat) {
                  it.delete(tr);
                  return {deleted: 1, written: 0};
                }
              }
              return NOTHING;
            },
            rewrites: key => key === 'nothing',
          }),
        "deleted outside the step's keys",
      ],
      [
        'writes a root attribute',
        () =>
          stamp(SEED, {
            migrateContainer: (tr, node) => {
              node.setAttr('extra', 1);
              return NOTHING;
            },
          }),
        'attribute extra changed',
      ],
      [
        'removes a layout record',
        () =>
          stamp(SEED, {
            migrateContainer: (tr, node) => {
              if (node.getAttr(`lexical-y:${SEED}`) === true) {
                node.deleteAttr(`lexical-y:${SEED}`);
              }
              return NOTHING;
            },
          }),
        `lexical-y:${SEED} was removed`,
      ],
      [
        'writes another top-level type',
        () =>
          stamp(SEED, {
            migrateContainer: tr => {
              tr.doc.get('other').insert(0, 'x');
              return NOTHING;
            },
          }),
        "outside the step's keys",
      ],
      [
        'writes an attribute of a nested container, even of a key it rewrites',
        () =>
          once((tr, node) => node.setAttr('zz', 1), {
            rewrites: key => key === 'zz',
          }),
        'attribute zz changed',
      ],
      [
        'removes a nested container',
        () =>
          stamp(SEED, {
            migrateContainer: (tr, node) => {
              for (let it = node._start; it !== null; it = it.right) {
                if (!it.deleted && it.content instanceof Y.ContentType) {
                  it.delete(tr);
                  return {deleted: 1, written: 0};
                }
              }
              return NOTHING;
            },
          }),
        'is gone',
      ],
      [
        'reads a wrong number of strings',
        () => stamp(SEED, {readAfter: node => [...readItems(node), '{}']}),
        'strings for',
      ],
      [
        'reads differently after',
        () =>
          stamp(SEED, {readAfter: node => readItems(node).map(r => r + '!')}),
        'reads differently',
      ],
      [
        'reads state the encoding does not keep',
        () => {
          const marked = new WeakSet<object>();
          return stamp(SEED, {
            migrateContainer: (tr, node) => {
              marked.add(node);
              return NOTHING;
            },
            readAfter: node =>
              readItems(node).map(r => (marked.has(node) ? r : r + '?')),
          });
        },
        're-read: container',
      ],
      [
        'throws',
        () =>
          stamp(SEED, {
            migrateContainer: () => {
              throw new Error('boom');
            },
          }),
        'the step threw: Error: boom',
      ],
      [
        'throws in its read',
        () =>
          stamp(SEED, {
            readBefore: () => {
              throw new Error('bad read');
            },
          }),
        'bad read',
      ],
    ];
    test.each(cases)('a step that %s', (_name, make, problem) => {
      const state = nested();
      expectRefused(
        () => migrateYState(state, [make()], {gc, ...TO2}),
        'post-condition',
        problem,
      );
      const doc = docOf(state);
      const bytes = Y.encodeStateAsUpdate(doc);
      const origins = transactionsOf(doc, () =>
        expectRefused(
          () => migrateYDoc(doc, [make()], TO2),
          'post-condition',
          problem,
        ),
      );
      expect(origins).toEqual([]);
      expect(same(Y.encodeStateAsUpdate(doc), bytes)).toBe(true);
      // A later step's failure leaves the earlier step unwritten too.
      const late = {
        ...make(),
        from: SEED + 1,
        id: `lexical-y/layout/${SEED + 1}to${SEED + 2}`,
        to: SEED + 2,
      };
      expectRefused(
        () => migrateYDoc(doc, [STAMP, late], {to: SEED + 2}),
        'post-condition',
      );
      expect(same(Y.encodeStateAsUpdate(doc), bytes)).toBe(true);
    });
  });
});
