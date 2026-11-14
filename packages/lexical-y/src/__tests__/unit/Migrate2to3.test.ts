/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The frozen step @lexical/y/migrate/2to3 on its golden fixtures: one input
// per historical layout (1 and 2) and shape, written by the release before
// layout 3, with that release's own read beside it (editor JSON, derived
// fields, list numbering). Gc off and on: each migrates (chain 1to2 + 2to3)
// to its frozen bytes; reads as the release before read it; meets layout
// 3's invariants (checkAfter) where a step that only records the layout
// does not; is a no-op once migrated; gives the same bytes in another process; equals 1to2 then
// 2to3; and two roots of one document get different clients. Reads are
// compared per countable unit (a raw writer's single item mixing a tab
// and text under a tab's open range migrates unit by unit). Golden
// outputs are written once (MIGRATE_GOLDEN_WRITE=1 when a fixture has
// none) and never regenerated; the frozen sources are pinned by hash.
// Golden fixtures are pinned per revision: golden/migrate-2to3-r<N>.json
// holds revision N's bytes. The default export stays revision 1 forever; a
// correction that changes the output is a new named revision, added to
// REVISIONS with its own file.

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
import {
  blockIdsOf,
  containersOf,
  layout3Problems,
  withoutBlockIds,
} from '../utils/migrate2to3';

/** The layout `doc`'s root records (see getYLayoutInfo), or null. */
const recordedLayout = (doc: Y.Doc, root = 'lexical-y'): number | null => {
  const info = getYLayoutInfo(doc, root);
  return 'layout' in info ? info.layout : null;
};
/** The migration epoch `doc`'s root records (see getYLayoutInfo), or null. */
const layoutEpoch = (doc: Y.Doc, root = 'lexical-y') => {
  const info = getYLayoutInfo(doc, root);
  return 'epoch' in info ? info.epoch : null;
};

const GOLDEN_DIR = path.join(__dirname, 'golden');
const GOLDEN = path.join(GOLDEN_DIR, 'migrate-2to3-r1.json');
/** Every revision of 2to3 the package exports, by revision. */
const REVISIONS: Readonly<Record<number, YLayoutMigration>> = {1: step2to3};
const SRC = path.join(__dirname, '..', '..');
const STEPS = [step1to2, step2to3];

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

function load(): Golden[] {
  const fixtures = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Golden[];
  if (
    process.env.MIGRATE_GOLDEN_WRITE === '1' &&
    fixtures.some(f => f.output === null && !f.name.startsWith('x-'))
  ) {
    for (const f of fixtures) {
      if (f.output === null && !f.name.startsWith('x-')) {
        const input = unb64(f.input);
        f.output = {
          gcOff: b64(migrateYState(input, STEPS, {gc: false, to: 3}).state),
          gcOn: b64(migrateYState(input, STEPS, {gc: true, to: 3}).state),
        };
      }
    }
    fs.writeFileSync(GOLDEN, JSON.stringify(fixtures, null, 2) + '\n');
  }
  return fixtures;
}

const FIXTURES = load();
const MIGRATING = FIXTURES.filter(f => !f.name.startsWith('x-'));

/**
 * What a reader of `state`'s root `root` shows, as JSON. Layout 3 is below
 * this release's floor (a headless read refuses it), so the state is read
 * after the frozen 3to4 step, which shows what layout 3 showed (see
 * Migrate3to4.test.ts).
 */
function readOf(state: Uint8Array, f: Golden, root?: string): unknown {
  return JSON.parse(
    JSON.stringify(
      readYState(
        migrateYState(state, [step3to4], {
          roots: root === undefined ? undefined : ['lexical-y', root],
        }).state,
        catalogHeadlessConfig(f.cfg, root === undefined ? {} : {root}),
        $snapshot,
      ),
    ),
  );
}

/** Live covered format items under the default root. */
function coveredItems(state: Uint8Array): number {
  const doc = new Y.Doc({gc: false});
  Y.applyUpdate(doc, state);
  let n = 0;
  for (const c of containersOf(doc.get('lexical-y'))) {
    for (let it = c._start; it !== null; it = it.right as Y.Item | null) {
      if (
        !it.deleted &&
        it.content instanceof Y.ContentFormat &&
        step2to3.rewrites(it.content.key)
      ) {
        n++;
      }
    }
  }
  return n;
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

describe('@lexical/y/migrate/2to3 golden fixtures', () => {
  test('one fixture per historical layout and shape', () => {
    expect(FIXTURES.map(f => [f.name, f.layout])).toEqual([
      ['l1-block-ids', 1],
      ['l1-breaks-tabs', 1],
      ['l1-decorators', 1],
      ['l1-edited-formats', 1],
      ['l1-empty', 1],
      ['l1-link', 1],
      ['l1-nested', 1],
      ['l1-node-keys', 1],
      ['l1-p-fields', 1],
      ['l1-raw-arrays', 1],
      ['l1-raw-date-array', 1],
      ['l1-raw-tojson-undefined', 1],
      ['l1-slots', 1],
      ['l1-tab-merged', 1],
      ['l1-tab-open', 1],
      ['l1-table', 1],
      ['l1-text-formats', 1],
      ['l1-two-roots', 1],
      ['l2-comment-raw', 2],
      ['l2-comment-table', 2],
      ['l2-comments', 2],
    ]);
    for (const f of FIXTURES) {
      expect(recordedLayout(createRawYDoc(unb64(f.input)))).toBe(f.layout);
    }
  });

  for (const gc of GCS) {
    describe(`gc ${gc ? 'on' : 'off'}`, () => {
      test('every fixture migrates to its frozen bytes', () => {
        for (const f of MIGRATING) {
          expect(f.output, `${f.name}: no golden output yet`).not.toBeNull();
          const out = migrateYState(unb64(f.input), STEPS, {gc, to: 3}).state;
          expect(b64(out), f.name).toBe(gc ? f.output!.gcOn : f.output!.gcOff);
        }
      });

      test('the migrated fixtures read as the release before layout 3 read them, block ids too', () => {
        for (const f of MIGRATING) {
          const roots =
            f.mainNotes === undefined ? undefined : ['lexical-y', 'notes'];
          const out = migrateYState(unb64(f.input), STEPS, {
            gc,
            roots,
            to: 3,
          }).state;
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

      test('layout 3 everywhere: checkAfter is empty on every container; marker and container attributes untouched', () => {
        for (const f of MIGRATING) {
          const input = unb64(f.input);
          const out = migrateYState(input, STEPS, {gc, to: 3}).state;
          expect(recordedLayout(createRawYDoc(out, {gc})), f.name).toBe(3);
          expect(layout3Problems(out, gc), f.name).toEqual([]);
          expect(typeAttrs(out), f.name).toEqual(typeAttrs(input));
        }
        // G-marker: markers with attributes exist among the fixtures.
        expect(
          MIGRATING.flatMap(f => typeAttrs(unb64(f.input))).filter(a =>
            / p:/.test(a),
          ).length,
        ).toBeGreaterThan(0);
      });

      test('a step that only records layout 3 fails checkAfter (negative fixture)', () => {
        const noop: YLayoutMigration = {
          ...step2to3,
          migrateContainer: () => ({deleted: 0, written: 0}),
        };
        let withCovered = 0;
        for (const f of MIGRATING) {
          const input = unb64(f.input);
          if (coveredItems(input) === 0) {
            continue;
          }
          withCovered++;
          let problems: readonly string[];
          try {
            problems = layout3Problems(
              migrateYState(input, [step1to2, noop], {gc, to: 3}).state,
              gc,
            );
          } catch (e) {
            // A runner that calls checkAfter refuses it outright.
            problems = [String(e)];
          }
          expect(problems.length, f.name).toBeGreaterThan(0);
        }
        expect(withCovered).toBeGreaterThanOrEqual(12);
      });

      test('idempotent: a migrated document is a no-op', () => {
        for (const f of MIGRATING) {
          const out = migrateYState(unb64(f.input), STEPS, {gc, to: 3}).state;
          const again = migrateYState(out, STEPS, {gc, to: 3});
          expect(again.receipt.changed, f.name).toBe(false);
          expect(again.update, f.name).toBeNull();
          expect(again.state, f.name).toBe(out);
        }
      });

      test('chain: 1 to 3 in one run equals 1to2 then 2to3', () => {
        for (const f of MIGRATING.filter(x => x.layout === 1)) {
          const input = unb64(f.input);
          const two = migrateYState(input, [step1to2], {gc, to: 2}).state;
          expect(recordedLayout(createRawYDoc(two, {gc})), f.name).toBe(2);
          const three = migrateYState(two, [step2to3], {gc, to: 3}).state;
          expect(b64(three), f.name).toBe(
            b64(migrateYState(input, STEPS, {gc, to: 3}).state),
          );
        }
      });

      test('two roots of the same bytes migrate under different clients and read as before', () => {
        const f = FIXTURES.find(x => x.name === 'l1-two-roots')!;
        const result = migrateYState(unb64(f.input), STEPS, {
          gc,
          roots: ['lexical-y', 'notes'],
          to: 3,
        });
        const clients = result.receipt.roots.map(r =>
          r.steps.map(s => s.client),
        );
        expect(clients.length).toBe(2);
        expect(new Set(clients.flat()).size).toBe(4);
        const doc = createRawYDoc(result.state, {gc});
        expect(layoutEpoch(doc, 'lexical-y')?.client).not.toBe(
          layoutEpoch(doc, 'notes')?.client,
        );
        expect(readOf(result.state, f)).toEqual(f.main);
        expect(readOf(result.state, f, 'notes')).toEqual(f.mainNotes);
        expect(layout3Problems(result.state, gc, 'notes')).toEqual([]);
      });
    });
  }

  test('deterministic across processes: another process writes the same bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-2to3-'));
    const script = path.join(dir, 'run.ts');
    fs.writeFileSync(
      script,
      [
        `import * as fs from 'node:fs';`,
        `import {createHash} from 'node:crypto';`,
        `import {migrateYState} from ${JSON.stringify(path.join(SRC, 'migrate.ts'))};`,
        `import step1to2 from ${JSON.stringify(path.join(SRC, 'migrate', '1to2.ts'))};`,
        `import step2to3 from ${JSON.stringify(path.join(SRC, 'migrate', '2to3.ts'))};`,
        `const fixtures = JSON.parse(fs.readFileSync(${JSON.stringify(GOLDEN)}, 'utf8'));`,
        `const h = createHash('sha256');`,
        `for (const f of fixtures) {`,
        `  if (f.name.startsWith('x-')) continue;`,
        `  for (const gc of [false, true]) {`,
        `    h.update(migrateYState(new Uint8Array(Buffer.from(f.input, 'base64')), [step1to2, step2to3], {gc, to: 3}).state);`,
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
    for (const f of MIGRATING) {
      for (const gc of GCS) {
        h.update(migrateYState(unb64(f.input), STEPS, {gc, to: 3}).state);
      }
    }
    fs.rmSync(dir, {force: true, recursive: true});
    expect(theirs).toBe(h.digest('hex'));
  });

  test('the frozen layout 3 writer is pinned by its hash, not by the live module', () => {
    const frozen = fs.readFileSync(
      path.join(SRC, 'migrate', '2to3', 'frozen', 'layout3.ts'),
      'utf8',
    );
    // The whole file, its header included: a change to it is a new
    // revision of the step. The live module it was copied from is gone
    // (layout 4 keeps only the canonical form's rules, internal/Canonical.ts);
    // the step keeps this copy.
    expect(sha(frozen)).toBe(
      'c1f901ac7069145291d97c6506021837ea7bd21e404e6752b22e7cec109a4d8b',
    );
    // Its body is the live module as of the freeze: the hash its header
    // names.
    const body = frozen.replace(
      /\/\/ FROZEN-COPY-BEGIN\n(?:.*\n)*?\/\/ FROZEN-COPY-END\n/,
      '',
    );
    const pinned = /sha256 ([0-9a-f]{64})/.exec(frozen)?.[1];
    expect(sha(body)).toBe(pinned);
  });

  test('golden files are pinned per revision: each runs against its own revision, and the default export is revision 1', () => {
    const files = fs
      .readdirSync(GOLDEN_DIR)
      .filter(f => f.startsWith('migrate-2to3'))
      .sort();
    expect(files).toEqual(['migrate-2to3-r1.json']);
    for (const file of files) {
      const revision = Number(/-r([1-9][0-9]*)\.json$/.exec(file)?.[1]);
      const step = REVISIONS[revision];
      expect(step).toMatchObject({id: 'lexical-y/layout/2to3', revision, v: 1});
      const fixtures = JSON.parse(
        fs.readFileSync(path.join(GOLDEN_DIR, file), 'utf8'),
      ) as Golden[];
      for (const f of fixtures) {
        if (f.output === null) {
          continue;
        }
        for (const gc of GCS) {
          const out = migrateYState(unb64(f.input), [step1to2, step], {
            gc,
            to: 3,
          }).state;
          expect(b64(out), f.name).toBe(gc ? f.output.gcOn : f.output.gcOff);
        }
      }
    }
    // The default revision never moves (a correction is a new named one).
    expect(step2to3.revision).toBe(1);
  });

  test('the frozen sources and fixtures are unchanged (a change is a new revision)', () => {
    const file = (...p: string[]) => sha(fs.readFileSync(path.join(SRC, ...p)));
    expect({
      fixtures: sha(fs.readFileSync(GOLDEN)),
      fold2: file('migrate', '2to3', 'frozen', 'fold2.ts'),
      layout3: file('migrate', '2to3', 'frozen', 'layout3.ts'),
      step: file('migrate', '2to3.ts'),
    }).toMatchInlineSnapshot(`
      {
        "fixtures": "e7099d720802a37b1bf8b4d52d67b0a6c11d1ee6003ed055a4774db3b919336c",
        "fold2": "e0a7f6f661b4c784d8057b0427f0662bc7ee5356783a253ed93021918465d533",
        "layout3": "c1f901ac7069145291d97c6506021837ea7bd21e404e6752b22e7cec109a4d8b",
        "step": "6e3453450cb3fad78a2979ce0b13384c15c889edbefd4202d929edddef9b83e2",
      }
    `);
    expect(step2to3).toMatchObject({
      from: 2,
      id: 'lexical-y/layout/2to3',
      revision: 1,
      to: 3,
      v: 1,
    });
  });
});
