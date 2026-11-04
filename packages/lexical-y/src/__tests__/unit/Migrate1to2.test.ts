/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The frozen step @lexical/y/migrate/1to2 over the catalog: every node shape
// alone, catalog documents with random edits (layout 1 without MarkState,
// layout 1 or 2 with it), gc off and on. A layout 1 document reads the same
// after the stamp (the runner's frozen renders, and the binding's own read
// of the editor JSON), keeps every id, stays editable, and is migrated
// once; a layout 2 document is returned as is. Golden fixtures pin the
// bytes the step writes; the frozen sources are pinned by hash.

import {$addMarkID} from '@lexical/mark';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
} from 'lexical';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {createYDoc} from '../..';
import {
  createYWriter,
  editYState,
  readYState,
  seedYState,
} from '../../headless';
import {MIN_LAYOUT} from '../../internal/constants';
import {migrateYDoc} from '../../internal/Runner';
import {layoutEpoch, migrateYState, recordedLayout} from '../../migrate';
import step1to2 from '../../migrate/1to2';
import {$snapshot, catalogHeadlessConfig, seedShapes} from '../catalog/bind';
import {type CatalogConfig} from '../catalog/configs';
import {$appendShapes, NODE_SHAPES, shapesWith} from '../catalog/nodes';
import {CORE_OPS} from '../catalog/ops';
import {mulberry32} from '../utils/fuzz';
import {SEED} from '../utils/migrateSteps';

type Cfg = Pick<CatalogConfig, 'blockIds'> &
  Partial<Pick<CatalogConfig, 'marks'>>;

const PLAIN: Cfg = {blockIds: 'absent'};
const MARKS: Cfg = {blockIds: 'absent', marks: 'mark-state'};
const IDS: Cfg = {blockIds: 'enabled'};

const read = (state: Uint8Array, cfg: Cfg) =>
  readYState(state, catalogHeadlessConfig(cfg), $snapshot);

/** Catalog shapes plus `edits` random core edits by one headless writer. */
function edited(seed: number, cfg: Cfg, edits: number): Uint8Array {
  const rand = mulberry32(seed);
  const pick = () => NODE_SHAPES[Math.floor(rand() * NODE_SHAPES.length)];
  let state = seedShapes([pick(), pick(), pick()], cfg);
  const writer = createYWriter(`m12-${seed}`);
  if (cfg.marks === 'mark-state') {
    // A comment: MarkState's member entries record layout 2.
    try {
      state = editYState(
        state,
        catalogHeadlessConfig(cfg),
        () => {
          const text = $getRoot()
            .getAllTextNodes()
            .find(t => t.isSimpleText() && t.getTextContentSize() > 2);
          if (text !== undefined) {
            const s = $createRangeSelection();
            s.anchor.set(text.getKey(), 1, 'text');
            s.focus.set(text.getKey(), text.getTextContentSize() - 1, 'text');
            $addMarkID(`c${seed}`, s);
          }
        },
        {writer},
      ).state;
    } catch (e) {
      if (!String(e).includes('nothing')) {
        throw e;
      }
    }
  }
  for (let i = 0; i < edits; i++) {
    const op = CORE_OPS[Math.floor(rand() * CORE_OPS.length)];
    try {
      state = editYState(
        state,
        catalogHeadlessConfig(cfg),
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

/** The ids, lengths and parents of every live countable item. */
function liveItems(doc: Y.Doc): string[] {
  const out: string[] = [];
  for (const structs of doc.store.clients.values()) {
    for (const s of structs) {
      if (
        s instanceof Y.Item &&
        !s.deleted &&
        s.countable &&
        s.parentSub === null
      ) {
        const parent = (s.parent as Y.Node)._item;
        out.push(
          `${s.id.client}.${s.id.clock}+${s.length}<${parent === null ? 'top' : `${parent.id.client}.${parent.id.clock}`}`,
        );
      }
    }
  }
  return out.sort();
}

/**
 * Migrate `state` with 1to2 and check everything a stamp must keep;
 * returns whether it was layout 1 (migrated).
 */
function checkStamp(state: Uint8Array, cfg: Cfg, gc: boolean): boolean {
  const before = createYDoc(state, {gc});
  const layout = recordedLayout(before);
  const result = migrateYState(state, [step1to2], {gc, to: 2});
  if (layout !== 1) {
    expect(layout).toBe(2);
    expect(result.receipt.changed).toBe(false);
    expect(result.state).toBe(state);
    return false;
  }
  expect(result.receipt.changed).toBe(true);
  expect(result.receipt.roots[0].steps).toMatchObject([
    {deleted: 0, id: 'lexical-y/layout/1to2', revision: 1, written: 2},
  ]);
  const after = createYDoc(result.state, {gc});
  expect(recordedLayout(after)).toBe(2);
  expect(layoutEpoch(after)).toMatchObject({layout: 2, v: 1});
  expect(liveItems(after)).toEqual(liveItems(before));
  // The binding reads the same editor state, and can write it.
  expect(read(result.state, cfg)).toEqual(read(createYDocState(before), cfg));
  const appended = editYState(
    result.state,
    catalogHeadlessConfig(cfg),
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode('z')));
    },
    {writer: null},
  ).state;
  expect(recordedLayout(createYDoc(appended, {gc}))).toBe(2);
  // Migrated once.
  expect(migrateYState(result.state, [step1to2], {gc, to: 2}).state).toBe(
    result.state,
  );
  return true;
}

const createYDocState = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc);

/** Edits that threw while building documents (see the catch above). */
const EDIT_THROWS: string[] = [];

const SEEDS = Number(process.env.MIGRATE_SEEDS ?? 40);
const SEED_BASE = Number(process.env.MIGRATE_SEED_BASE ?? 8_000_101);

// Seeds record layout 1 and the binding reads layout 2 only on builds whose
// seeds record layout 1 and MIN_LAYOUT is at most 2 (main); later builds keep the
// golden fixtures and source pins below, and test the chain on their own
// fixtures.
const LAYOUT1_BUILD = SEED === 1 && MIN_LAYOUT <= 2;

describe.skipIf(!LAYOUT1_BUILD).each([false, true])(
  '@lexical/y/migrate/1to2, gc %s',
  gc => {
    test('every node shape alone, without and with block ids', () => {
      let migrated = 0;
      for (const shape of NODE_SHAPES) {
        for (const cfg of [PLAIN, IDS]) {
          if (checkStamp(seedShapes([shape], cfg), cfg, gc)) {
            migrated++;
          }
        }
      }
      expect(migrated).toBe(NODE_SHAPES.length * 2);
    });

    test(
      `catalog documents with random edits (${SEEDS} seeds from ${SEED_BASE})`,
      {timeout: 600_000},
      () => {
        let ones = 0;
        let twos = 0;
        for (let seed = SEED_BASE; seed < SEED_BASE + SEEDS; seed++) {
          for (const cfg of [PLAIN, MARKS]) {
            if (checkStamp(edited(seed, cfg, 8), cfg, gc)) {
              ones++;
            } else {
              twos++;
            }
          }
        }
        if (EDIT_THROWS.length > 0) {
          console.warn(
            `edits that threw: ${EDIT_THROWS.length}\n${EDIT_THROWS.join('\n')}`,
          );
        }
        expect(ones).toBeGreaterThanOrEqual(SEEDS);
        expect(twos).toBeGreaterThan(0);
      },
    );

    test('a custom root and a root nested in another shared type', () => {
      const custom = seedYState(
        catalogHeadlessConfig(PLAIN, {root: 'notes'}),
        () => $appendShapes([shapesWith('table')[0], NODE_SHAPES[0]]),
      );
      const r = migrateYState(custom, [step1to2], {
        gc,
        roots: ['notes'],
        to: 2,
      });
      expect(r.receipt.roots[0]).toMatchObject({from: 1, root: 'notes', to: 2});
      expect(recordedLayout(createYDoc(r.state, {gc}), 'notes')).toBe(2);
    });

    test('a live document: one transaction, the binding reads the same after', () => {
      const state = edited(SEED_BASE + 1000, PLAIN, 6);
      const doc = createYDoc(state, {gc});
      const before = read(Y.encodeStateAsUpdate(doc), PLAIN);
      const receipt = migrateYDoc(doc, [step1to2], {to: 2});
      expect(receipt.changed).toBe(true);
      expect(read(Y.encodeStateAsUpdate(doc), PLAIN)).toEqual(before);
    });
  },
);

// Golden fixtures: written once (MIGRATE_GOLDEN_WRITE=1 when the file does
// not exist), never regenerated. Each holds an input state and the exact
// bytes 1to2 writes for it with gc off and on.
const GOLDEN = path.join(__dirname, 'golden', 'migrate-1to2.json');

type Golden = {
  name: string;
  layout: number;
  input: string;
  output: {gcOff: string; gcOn: string};
};

function goldenInputs(): {name: string; state: Uint8Array}[] {
  return [
    {name: 'paragraph', state: seedShapes([NODE_SHAPES[0]], PLAIN)},
    {name: 'table', state: seedShapes(shapesWith('table').slice(0, 1), PLAIN)},
    {name: 'list', state: seedShapes(shapesWith('list').slice(0, 1), PLAIN)},
    {name: 'slots', state: seedShapes(shapesWith('slots').slice(0, 1), PLAIN)},
    {name: 'block-ids', state: seedShapes(NODE_SHAPES.slice(0, 4), IDS)},
    {name: 'edited', state: edited(8_000_901, PLAIN, 12)},
    {name: 'layout-2-marks', state: layout2(8_000_902)},
  ];
}

/** The first catalog document from `seed` on that records layout 2. */
function layout2(seed: number): Uint8Array {
  for (let s = seed; s < seed + 50; s++) {
    const state = edited(s, MARKS, 12);
    if (recordedLayout(createYDoc(state)) === 2) {
      return state;
    }
  }
  throw new Error('no layout 2 document');
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

describe('@lexical/y/migrate/1to2 golden fixtures', () => {
  if (!fs.existsSync(GOLDEN) && process.env.MIGRATE_GOLDEN_WRITE === '1') {
    const fixtures: Golden[] = goldenInputs().map(({name, state}) => ({
      input: b64(state),
      layout: recordedLayout(createYDoc(state)) ?? 0,
      name,
      output: {
        gcOff: b64(migrateYState(state, [step1to2], {gc: false, to: 2}).state),
        gcOn: b64(migrateYState(state, [step1to2], {gc: true, to: 2}).state),
      },
    }));
    fs.mkdirSync(path.dirname(GOLDEN), {recursive: true});
    fs.writeFileSync(GOLDEN, JSON.stringify(fixtures, null, 2) + '\n');
  }

  test('every fixture migrates to its frozen bytes', () => {
    const fixtures = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Golden[];
    expect(fixtures.map(f => [f.name, f.layout])).toEqual([
      ['paragraph', 1],
      ['table', 1],
      ['list', 1],
      ['slots', 1],
      ['block-ids', 1],
      ['edited', 1],
      ['layout-2-marks', 2],
    ]);
    for (const f of fixtures) {
      const input = unb64(f.input);
      for (const gc of [false, true]) {
        const out = migrateYState(input, [step1to2], {gc, to: 2}).state;
        expect(b64(out)).toBe(gc ? f.output.gcOn : f.output.gcOff);
      }
    }
  });

  test('the frozen sources and fixtures are unchanged (a change is a new revision)', () => {
    const src = path.join(__dirname, '..', '..', 'migrate');
    const sha = (file: string) =>
      createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    expect({
      fixtures: sha(GOLDEN),
      read: sha(path.join(src, '1to2', 'frozen', 'read.ts')),
      step: sha(path.join(src, '1to2.ts')),
    }).toMatchInlineSnapshot(`
      {
        "fixtures": "f88c2f328503ff0c7de8c68ba7ad9ca03ec227cff066a1c43865086a1cb8b30d",
        "read": "87e4170109df818d96e500100fd09f0e15d7292bb2c0128d9417adfdb768a3ac",
        "step": "00936211b610a4dfc6ee69cd9e36756c52f3f18f722456cd268ebd481eb86098",
      }
    `);
    expect(step1to2).toMatchObject({
      from: 1,
      id: 'lexical-y/layout/1to2',
      revision: 1,
      to: 2,
    });
  });
});
