/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The frozen step @lexical/y/migrate/3to4 on its golden fixtures. Every
// input is layout 3 bytes with the layout 3 release's own read beside it
// (editor JSON, derived fields, list numbering; written by main 8b119693c,
// the last release whose floor was 3):
// - `from-2to3/*`: every output of the 2to3 golden fixtures (gc off);
// - `catalog/*`: documents that together hold every node shape of the
//   catalog, seeded by that release;
// - `flat/*`: flat NodeState on text (strings, numbers, booleans, objects,
//   arrays; on a line break, a token, inside a link, a list and a table),
//   seeded, and edited one update at a time (values set over overlapping
//   ranges, removed from part of one, typed into), with every tombstone
//   kept and garbage collected;
// - `raw/*`: on top of such a document, what only a raw writer stores: each
//   reserved shape under a name of each family, dangling openers (a value,
//   a `[]`, a plain null, an opener whose end is deleted), dangling ends
//   (naming no item, an item of another name, a deleted opener), arrays
//   under a flat NodeState name, and Y.Node#format's plain items.
// Gc off and on: each migrates to its frozen bytes; reads as the release
// before read it; meets layout 4's invariants (checkAfter) where a step
// that only records the layout does not; keeps every content id, every
// reserved shape and every item of a name it does not cover; is a no-op
// once migrated; gives the same bytes in another process; and the chain
// from layout 1 equals the steps one by one. Golden outputs are written
// once (MIGRATE_GOLDEN_WRITE=1 when a fixture has none) and never
// regenerated; the frozen sources are pinned by hash. Golden fixtures are
// pinned per revision: golden/migrate-3to4-r<N>.json holds revision N's
// bytes. The default export stays revision 1 forever; a correction that
// changes the output is a new named revision, added to REVISIONS with its
// own file.

import * as Y from '@y/y';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {readYState} from '../../headless';
import {createRawYDoc} from '../../internal/RawYDoc';
import {
  getYLayoutInfo,
  migrateYState,
  type YLayoutMigration,
} from '../../migrate';
import step1to2 from '../../migrate/1to2';
import step2to3 from '../../migrate/2to3';
import step3to4 from '../../migrate/3to4';
import {$snapshot, catalogHeadlessConfig} from '../catalog/bind';
import {blockIdsOf, containersOf, withoutBlockIds} from '../utils/migrate2to3';
import {contentIds, formatItems, layout4Problems} from '../utils/migrate3to4';

/** The layout `doc`'s root records (see getYLayoutInfo), or null. */
const recordedLayout = (doc: Y.Doc, root = 'lexical-y'): number | null => {
  const info = getYLayoutInfo(doc, root);
  return 'layout' in info ? info.layout : null;
};

const GOLDEN_DIR = path.join(__dirname, 'golden');
const GOLDEN = path.join(GOLDEN_DIR, 'migrate-3to4-r1.json');
const GOLDEN_2TO3 = path.join(GOLDEN_DIR, 'migrate-2to3-r1.json');
/** Every revision of 3to4 the package exports, by revision. */
const REVISIONS: Readonly<Record<number, YLayoutMigration>> = {1: step3to4};
const SRC = path.join(__dirname, '..', '..');
const STEPS = [step3to4];

type Golden = {
  name: string;
  layout: number;
  cfg: Parameters<typeof catalogHeadlessConfig>[0];
  input: string;
  main: unknown;
  mainNotes?: unknown;
  output: {gcOff: string; gcOn: string} | null;
};

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));
const sha = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const GCS = [false, true] as const;
const rootsOf = (f: Golden) =>
  f.mainNotes === undefined ? undefined : ['lexical-y', 'notes'];

function load(): Golden[] {
  const fixtures = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Golden[];
  if (
    process.env.MIGRATE_GOLDEN_WRITE === '1' &&
    fixtures.some(f => f.output === null)
  ) {
    for (const f of fixtures) {
      if (f.output === null) {
        const input = unb64(f.input);
        const roots = rootsOf(f);
        f.output = {
          gcOff: b64(migrateYState(input, STEPS, {gc: false, roots}).state),
          gcOn: b64(migrateYState(input, STEPS, {gc: true, roots}).state),
        };
      }
    }
    fs.writeFileSync(GOLDEN, JSON.stringify(fixtures, null, 2) + '\n');
  }
  return fixtures;
}

const FIXTURES = load();
const migrate = (f: Golden, gc: boolean, steps = STEPS) =>
  migrateYState(unb64(f.input), steps, {gc, roots: rootsOf(f)}).state;

/** What a reader of `state`'s root `root` shows, as JSON. */
function readOf(state: Uint8Array, f: Golden, root?: string): unknown {
  return JSON.parse(
    JSON.stringify(
      readYState(
        state,
        catalogHeadlessConfig(f.cfg, root === undefined ? {} : {root}),
        $snapshot,
      ),
    ),
  );
}

/** Every attribute of every type under the root, by holder id. */
function typeAttrs(state: Uint8Array, root = 'lexical-y'): string[] {
  const doc = new Y.Doc({gc: false});
  Y.applyUpdate(doc, state);
  const out: string[] = [];
  for (const c of containersOf(doc.get(root))) {
    const at =
      c._item === null ? 'root' : `${c._item.id.client}.${c._item.id.clock}`;
    for (const key of [...c._map.keys()].sort()) {
      const it = c._map.get(key)!;
      if (!it.deleted && !(c._item === null && key.startsWith('lexical-y'))) {
        out.push(
          `${at} ${key} ${it.id.client}.${it.id.clock} ${JSON.stringify(it.content.getContent())}`,
        );
      }
    }
  }
  return out;
}

/** Whether a layout 3 state holds something layout 4 does not allow. */
const needsRewrite = (f: Golden) =>
  layout4Problems(unb64(f.input), false).length > 0;

describe('@lexical/y/migrate/3to4 golden fixtures', () => {
  test('the inputs: every 2to3 output, the catalog, flat NodeState, raw shapes', () => {
    expect(FIXTURES.map(f => f.name)).toMatchInlineSnapshot(`
      [
        "from-2to3/l1-block-ids",
        "from-2to3/l1-breaks-tabs",
        "from-2to3/l1-decorators",
        "from-2to3/l1-edited-formats",
        "from-2to3/l1-empty",
        "from-2to3/l1-link",
        "from-2to3/l1-nested",
        "from-2to3/l1-node-keys",
        "from-2to3/l1-p-fields",
        "from-2to3/l1-raw-arrays",
        "from-2to3/l1-raw-date-array",
        "from-2to3/l1-raw-tojson-undefined",
        "from-2to3/l1-slots",
        "from-2to3/l1-tab-merged",
        "from-2to3/l1-tab-open",
        "from-2to3/l1-table",
        "from-2to3/l1-text-formats",
        "from-2to3/l1-two-roots",
        "from-2to3/l2-comment-raw",
        "from-2to3/l2-comment-table",
        "from-2to3/l2-comments",
        "catalog/00",
        "catalog/01",
        "catalog/02",
        "catalog/03",
        "catalog/04",
        "catalog/05",
        "catalog/06",
        "catalog/07",
        "flat/seeded",
        "flat/edited-kept",
        "flat/edited-collected",
        "raw/reserved-shapes",
        "raw/dangling-openers",
        "raw/dangling-ends",
        "raw/flat-arrays",
        "raw/plain-values",
      ]
    `);
    for (const f of FIXTURES) {
      expect(f.layout, f.name).toBe(3);
      expect(recordedLayout(createRawYDoc(unb64(f.input))), f.name).toBe(3);
    }
    // Every layout 3 fixture 2to3 writes is an input here, byte for byte.
    const from2to3 = (
      JSON.parse(fs.readFileSync(GOLDEN_2TO3, 'utf8')) as Golden[]
    ).filter(f => f.output !== null);
    expect(from2to3.length).toBeGreaterThan(0);
    for (const f of from2to3) {
      const mine = FIXTURES.find(x => x.name === `from-2to3/${f.name}`);
      expect(mine?.input, f.name).toBe(f.output!.gcOff);
    }
  });

  for (const gc of GCS) {
    describe(`gc ${gc ? 'on' : 'off'}`, () => {
      test('every fixture migrates to its frozen bytes', () => {
        for (const f of FIXTURES) {
          expect(f.output, `${f.name}: no golden output yet`).not.toBeNull();
          expect(b64(migrate(f, gc)), f.name).toBe(
            gc ? f.output!.gcOn : f.output!.gcOff,
          );
        }
      });

      test('the migrated fixtures read as the layout 3 release read them, block ids too', () => {
        for (const f of FIXTURES) {
          const out = migrate(f, gc);
          const mine = readOf(out, f);
          expect(withoutBlockIds(mine), f.name).toEqual(
            withoutBlockIds(f.main),
          );
          expect(blockIdsOf(mine), f.name).toEqual(blockIdsOf(f.main));
          if (f.mainNotes !== undefined) {
            expect(readOf(out, f, 'notes'), f.name).toEqual(f.mainNotes);
          }
        }
      });

      test('layout 4 everywhere: checkAfter is empty on every container; every content id and attribute untouched', () => {
        for (const f of FIXTURES) {
          const input = unb64(f.input);
          const out = migrate(f, gc);
          expect(recordedLayout(createRawYDoc(out, {gc})), f.name).toBe(4);
          for (const root of rootsOf(f) ?? ['lexical-y']) {
            expect(layout4Problems(out, gc, root), f.name).toEqual([]);
            expect(typeAttrs(out, root), f.name).toEqual(
              typeAttrs(input, root),
            );
            expect(contentIds(out, root), f.name).toEqual(
              contentIds(input, root),
            );
          }
        }
      });

      test('reserved shapes and items of names it does not cover stay where they are, by id', () => {
        let reserved = 0;
        let foreign = 0;
        for (const f of FIXTURES) {
          const kept = (state: Uint8Array) =>
            formatItems(state)
              .filter(it => it.reserved || !it.covered)
              .map(it => `${it.id} ${it.key}=${JSON.stringify(it.value)}`);
          const before = kept(unb64(f.input));
          expect(kept(migrate(f, gc)), f.name).toEqual(before);
          reserved += formatItems(unb64(f.input)).filter(
            it => it.reserved,
          ).length;
          foreign += formatItems(unb64(f.input)).filter(
            it => !it.covered,
          ).length;
          // Everything else it wrote itself: one client, the epoch's.
          const doc = createRawYDoc(migrate(f, gc), {gc});
          const info = getYLayoutInfo(doc, 'lexical-y');
          const client = 'epoch' in info ? info.epoch?.client : undefined;
          for (const it of formatItems(migrate(f, gc))) {
            if (it.covered && !it.reserved) {
              expect(it.id.split('.')[0], f.name).toBe(String(client));
            }
          }
        }
        expect(reserved).toBeGreaterThanOrEqual(18);
        expect(foreign).toBeGreaterThan(0);
      });

      test('no flat NodeState item is left as layout 3 stored it', () => {
        let flat = 0;
        for (const f of FIXTURES) {
          const isFlat = (key: string) =>
            key.startsWith('s:') && !key.includes('\u001f');
          const before = new Set(
            formatItems(unb64(f.input))
              .filter(it => isFlat(it.key) && !it.reserved)
              .map(it => it.id),
          );
          flat += before.size;
          for (const it of formatItems(migrate(f, gc))) {
            expect(before.has(it.id), `${f.name} ${it.id}`).toBe(false);
          }
        }
        expect(flat).toBeGreaterThan(20);
      });

      test('a step that only records layout 4 fails checkAfter where layout 3 stored what layout 4 does not (negative fixture)', () => {
        const noop: YLayoutMigration = {
          ...step3to4,
          migrateContainer: () => ({deleted: 0, written: 0}),
        };
        let rewritten = 0;
        for (const f of FIXTURES.filter(needsRewrite)) {
          rewritten++;
          let problems: readonly string[];
          try {
            problems = layout4Problems(migrate(f, gc, [noop]), gc);
          } catch (e) {
            // A runner that calls checkAfter refuses it outright.
            problems = [String(e)];
          }
          expect(problems.length, f.name).toBeGreaterThan(0);
        }
        expect(rewritten).toBeGreaterThanOrEqual(8);
      });

      test('idempotent: a migrated document is a no-op', () => {
        for (const f of FIXTURES) {
          const out = migrate(f, gc);
          const again = migrateYState(out, STEPS, {gc, roots: rootsOf(f)});
          expect(again.receipt.changed, f.name).toBe(false);
          expect(again.update, f.name).toBeNull();
          expect(again.state, f.name).toBe(out);
        }
      });
    });
  }

  for (const gc of GCS) {
    test(`chain: 1 to 4 in one run equals 1to2, 2to3 then 3to4 (gc ${gc ? 'on' : 'off'})`, () => {
      const olds = (
        JSON.parse(fs.readFileSync(GOLDEN_2TO3, 'utf8')) as Golden[]
      ).filter(f => f.output !== null);
      for (const f of olds) {
        // (The default root only: with two roots, a chain run root by root
        // and a run step by step visit them in another order, and each
        // step's client id is hashed from the document it meets.)
        const input = unb64(f.input);
        const three = migrateYState(input, [step1to2, step2to3], {
          gc,
          to: 3,
        }).state;
        const four = migrateYState(three, [step3to4], {gc}).state;
        expect(recordedLayout(createRawYDoc(four, {gc})), f.name).toBe(4);
        expect(
          b64(migrateYState(input, [step1to2, step2to3, step3to4], {gc}).state),
          f.name,
        ).toBe(b64(four));
        expect(layout4Problems(four, gc), f.name).toEqual([]);
      }
    });
  }

  test('deterministic across processes: another process writes the same bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-3to4-'));
    const script = path.join(dir, 'run.ts');
    fs.writeFileSync(
      script,
      [
        `import * as fs from 'node:fs';`,
        `import {createHash} from 'node:crypto';`,
        `import {migrateYState} from ${JSON.stringify(path.join(SRC, 'migrate.ts'))};`,
        `import step3to4 from ${JSON.stringify(path.join(SRC, 'migrate', '3to4.ts'))};`,
        `const fixtures = JSON.parse(fs.readFileSync(${JSON.stringify(GOLDEN)}, 'utf8'));`,
        `const h = createHash('sha256');`,
        `for (const f of fixtures) {`,
        `  const roots = f.mainNotes === undefined ? undefined : ['lexical-y', 'notes'];`,
        `  for (const gc of [false, true]) {`,
        `    h.update(migrateYState(new Uint8Array(Buffer.from(f.input, 'base64')), [step3to4], {gc, roots}).state);`,
        `  }`,
        `}`,
        `process.stdout.write(h.digest('hex'));`,
      ].join('\n'),
    );
    const tsx = path.join(SRC, '..', '..', '..', 'node_modules', '.bin', 'tsx');
    const theirs = execFileSync(tsx, [script], {
      cwd: path.join(SRC, '..', '..', '..'),
      encoding: 'utf8',
    }).trim();
    const h = createHash('sha256');
    for (const f of FIXTURES) {
      for (const gc of GCS) {
        h.update(migrate(f, gc));
      }
    }
    fs.rmSync(dir, {force: true, recursive: true});
    expect(theirs).toBe(h.digest('hex'));
  });

  test('golden files are pinned per revision: each runs against its own revision, and the default export is revision 1', () => {
    const files = fs
      .readdirSync(GOLDEN_DIR)
      .filter(f => f.startsWith('migrate-3to4'))
      .sort();
    expect(files).toEqual(['migrate-3to4-r1.json']);
    for (const file of files) {
      const revision = Number(/-r([1-9][0-9]*)\.json$/.exec(file)?.[1]);
      const step = REVISIONS[revision];
      expect(step).toMatchObject({id: 'lexical-y/layout/3to4', revision, v: 1});
      const fixtures = JSON.parse(
        fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8'),
      ) as Golden[];
      for (const f of fixtures) {
        if (f.output === null) {
          continue;
        }
        for (const gc of GCS) {
          expect(b64(migrate(f, gc, [step])), f.name).toBe(
            gc ? f.output.gcOn : f.output.gcOff,
          );
        }
      }
    }
    // The default revision never moves (a correction is a new named one).
    expect(step3to4.revision).toBe(1);
  });

  test('the frozen sources and fixtures are unchanged (a change is a new revision)', () => {
    const file = (...p: string[]) => sha(fs.readFileSync(path.join(SRC, ...p)));
    expect({
      fixtures: sha(fs.readFileSync(GOLDEN)),
      layout4: file('migrate', '3to4', 'frozen', 'layout4.ts'),
      read3: file('migrate', '3to4', 'frozen', 'read3.ts'),
      step: file('migrate', '3to4.ts'),
    }).toMatchInlineSnapshot(`
      {
        "fixtures": "220241a3fd30b68a431eb7ec3613e07621dd95231cc2b253e5c4606e78eceb22",
        "layout4": "87bb2e34b8e77c9dc6f387a1259708295ffcdb57ce95b5f6a49d7d008a45f352",
        "read3": "11ecea07409dfd97c05e89f86bdac92204488236df47075d9bde96e0a0868413",
        "step": "ae69551f49cb6a66b27687b9a11d3b72ee4febe198ff08c591253c14977223f1",
      }
    `);
    expect(step3to4).toMatchObject({
      from: 3,
      id: 'lexical-y/layout/3to4',
      revision: 1,
      to: 4,
      v: 1,
    });
    // No parameters: the step is its methods and nothing else.
    expect(Object.keys(step3to4).sort()).toEqual([
      'checkAfter',
      'from',
      'id',
      'migrateContainer',
      'readAfter',
      'readBefore',
      'revision',
      'rewrites',
      'to',
      'v',
    ]);
  });
});
