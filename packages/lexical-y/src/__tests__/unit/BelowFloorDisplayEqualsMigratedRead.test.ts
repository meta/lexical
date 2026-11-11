/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A document below the floor (layout 1, 2 or 3) opens read only, and the
// live reader shows it as it is: the layout 4 reader holds no code for older
// layouts, as a layout 1 or 2 document holds no run ends and a layout 3
// document's flat NodeState items have none (they read as unpaired values,
// which is how layout 3 read them). Pinned here: what it shows equals a
// fresh read of the same document after the migration (1to2, 2to3, 3to4) by
// a bound editor, gc off and on. (A headless
// read refuses a document it cannot write: `readYState` throws a
// `'read-only'` YHeadlessError there, pinned too.)
//
// Inputs: every layout 1 and 2 state of the 2to3 golden fixtures, and of
// the 1to2 golden fixtures (their inputs, and the layout 2 states 1to2 makes
// of them, gc off and on); every layout 3 state of the 3to4 golden
// fixtures; and, where BELOW_FLOOR_CORPORA lists corpus directories (the
// stored corpora of MigrateCorpora), of their entries that record a
// layout below 4: BELOW_FLOOR_SAMPLE of them chosen by seed
// BELOW_FLOOR_SEED (default 1), or else every BELOW_FLOOR_EVERY-th (default
// 10, by sorted file name).

import {buildEditorFromExtensions} from '@lexical/extension';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {createYCollabConfig, createYDoc} from '../..';
import {type HeadlessYConfig, readYState, YHeadlessError} from '../../headless';
import {migrateYState} from '../../migrate';
import step1to2 from '../../migrate/1to2';
import step2to3 from '../../migrate/2to3';
import step3to4 from '../../migrate/3to4';
import {$snapshot, catalogHeadlessConfig, snapshot} from '../catalog/bind';
import {flush} from '../utils/harness';
import {type CorpusConfig, corpusConfig} from '../utils/noteApp';

const STEPS = [step1to2, step2to3, step3to4];

/**
 * The one exception (D103): a raw array stored under a covered name (here a
 * comment's set member, written by a raw writer, unsupported by D109) is
 * a value in layout 2, and 2to3 stores it as one (`{json}`); the layout 3
 * reader, which holds no code for older layouts, reads an array there as a
 * reserved end shape (a clearer, see D101), so the read only display shows
 * no value. Both halves are pinned below.
 */
const KNOWN: Readonly<Record<string, string>> = {
  'l2-comment-raw': 'a raw array under a covered name',
};
/**
 * The same exception at layout 3, for the name layout 4 newly covers: an
 * array a raw writer stored under a flat NodeState name is a value in layout
 * 3 (3to4 stores it as one, `{json}`), and the layout 4 reader reads an
 * array there as an end (one naming nothing: a clearer).
 */
const KNOWN_3TO4: Readonly<Record<string, string>> = {
  'raw/flat-arrays': 'a raw array under a flat NodeState name',
  'raw/reserved-shapes': 'a raw array under a flat NodeState name',
};
const GOLDEN_3TO4 = path.join(__dirname, 'golden', 'migrate-3to4-r1.json');
const GOLDEN = path.join(__dirname, 'golden', 'migrate-2to3-r1.json');
const GOLDEN_1TO2 = path.join(__dirname, 'golden', 'migrate-1to2-r1.json');
/**
 * The catalog configuration each 1to2 fixture was seeded with (see
 * Migrate1to2.test.ts): block ids absent but where named here.
 */
const CONFIG_1TO2: Readonly<
  Record<string, Parameters<typeof catalogHeadlessConfig>[0]>
> = {
  'block-ids': {blockIds: 'enabled'},
  'layout-2-marks': {blockIds: 'absent', marks: 'mark-state'},
};

type Input = {
  name: string;
  layout: number | null;
  config: HeadlessYConfig;
  root: string;
  state: Uint8Array;
  gcs: readonly boolean[];
};

const plain = (x: unknown): unknown => JSON.parse(JSON.stringify(x));

/** What a bound editor shows of `state` (read only below the floor). */
async function boundRead(input: Input, gc: boolean): Promise<unknown> {
  const doc = createYDoc(input.state, {gc});
  const editor = buildEditorFromExtensions({
    dependencies: [
      ...(input.config.extensions ?? []),
      createYCollabConfig({
        doc,
        layoutUpgrade: null,
        root: input.root === 'lexical-y' ? null : doc.get(input.root),
        schemaVersion: input.config.schemaVersion,
        synced: true,
      }),
    ],
    name: `below-floor-${input.name}`,
    onError: e => {
      throw e;
    },
    onWarn: () => {},
  });
  try {
    await flush();
    return plain(snapshot(editor));
  } finally {
    editor.dispose();
    doc.destroy();
  }
}

/** Check one input under one gc setting; returns a failure, or null. */
async function check(input: Input, gc: boolean): Promise<string | null> {
  const id = `${input.name} gc ${gc ? 'on' : 'off'}`;
  const config = {...input.config, root: input.root};
  const migrated = migrateYState(input.state, STEPS, {
    gc,
    roots: [input.root],
  }).state;
  // A fresh bound reader of the migrated document (a headless read leaves a
  // decorator's nested editor empty where a bound editor's holds its
  // initial paragraph).
  const fresh = await boundRead({...input, state: migrated}, gc);
  const freshHeadless = plain(readYState(migrated, config, $snapshot));
  let refused = false;
  try {
    readYState(input.state, config, $snapshot);
  } catch (e) {
    refused = e instanceof YHeadlessError && e.code === 'read-only';
  }
  if (!refused) {
    return `${id}: a headless read did not refuse it as read only`;
  }
  const bound = await boundRead(input, gc);
  if (JSON.stringify(bound) !== JSON.stringify(fresh)) {
    return `${id}: the bound editor's read only display differs from the migrated read`;
  }
  if (freshHeadless === null) {
    return `${id}: no headless read of the migrated document`;
  }
  return null;
}

type Golden = {
  name: string;
  layout: number;
  cfg: Parameters<typeof catalogHeadlessConfig>[0];
  input: string;
  /** The release before layout 3's read (see Migrate2to3). */
  main: unknown;
};

function goldenInputs(): Input[] {
  const fixtures = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Golden[];
  return fixtures
    .filter(f => f.layout < 3)
    .map(f => ({
      config: catalogHeadlessConfig(f.cfg),
      gcs: [false, true],
      layout: f.layout,
      name: f.name,
      root: 'lexical-y',
      state: new Uint8Array(Buffer.from(f.input, 'base64')),
    }));
}

/** The 3to4 golden fixtures: every input, layout 3. */
function goldenInputs3to4(): Input[] {
  const fixtures = JSON.parse(fs.readFileSync(GOLDEN_3TO4, 'utf8')) as Golden[];
  return fixtures.map(f => ({
    config: catalogHeadlessConfig(f.cfg),
    gcs: [false, true],
    layout: f.layout,
    name: f.name,
    root: 'lexical-y',
    state: new Uint8Array(Buffer.from(f.input, 'base64')),
  }));
}

type Golden1to2 = {
  name: string;
  layout: number;
  input: string;
  output: {gcOff: string; gcOn: string};
};

/**
 * The 1to2 golden fixtures: each input (layout 1, one at layout 2), gc off
 * and on, and the layout 2 state 1to2 writes for it with gc off and with gc
 * on, each read with that setting.
 */
function goldenInputs1to2(): Input[] {
  const fixtures = JSON.parse(
    fs.readFileSync(GOLDEN_1TO2, 'utf8'),
  ) as Golden1to2[];
  const state = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
  return fixtures.flatMap(f => {
    const config = catalogHeadlessConfig(
      CONFIG_1TO2[f.name] ?? {blockIds: 'absent'},
    );
    const at = (
      name: string,
      layout: number,
      b64: string,
      gcs: readonly boolean[],
    ): Input => ({
      config,
      gcs,
      layout,
      name,
      root: 'lexical-y',
      state: state(b64),
    });
    return [
      at(`1to2/${f.name}`, f.layout, f.input, [false, true]),
      at(`1to2/${f.name} (layout 2, gc off)`, 2, f.output.gcOff, [false]),
      at(`1to2/${f.name} (layout 2, gc on)`, 2, f.output.gcOn, [true]),
    ];
  });
}

type Entry = {
  name: string;
  cfg: CorpusConfig;
  gc: boolean | null;
  layout: number | null;
  root?: string;
};

const DIRS = (process.env.BELOW_FLOOR_CORPORA ?? '')
  .split(',')
  .filter(d => d !== '');
const EVERY = Number(process.env.BELOW_FLOOR_EVERY ?? 10);
const SAMPLE =
  process.env.BELOW_FLOOR_SAMPLE === undefined
    ? null
    : Number(process.env.BELOW_FLOOR_SAMPLE);
const SEED = Number(process.env.BELOW_FLOOR_SEED ?? 1);

/** FNV-1a of `s` (32 bits): the seeded order of a sample. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function corpusInputs(): Input[] {
  const below: {dir: string; entry: Entry; file: string}[] = [];
  for (const dir of DIRS) {
    const files = fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.main.json'))
      .sort();
    for (let i = 0; i < files.length; i += SAMPLE === null ? EVERY : 1) {
      const file = files[i];
      const entry = JSON.parse(
        fs.readFileSync(path.join(dir, file), 'utf8'),
      ) as Entry;
      if (entry.layout !== null && entry.layout < 4) {
        below.push({dir, entry, file});
      }
    }
  }
  const rank = (x: {dir: string; file: string}) =>
    fnv1a(`${SEED}\u0000${path.basename(x.dir)}/${x.file}`);
  const chosen =
    SAMPLE === null
      ? below
      : below
          .slice()
          .sort((a, b) => rank(a) - rank(b))
          .slice(0, SAMPLE);
  const out: Input[] = [];
  for (const {dir, entry, file} of chosen) {
    out.push({
      config: corpusConfig(entry.cfg),
      gcs: entry.gc === null ? [false, true] : [entry.gc],
      layout: entry.layout,
      name: `${path.basename(dir)}/${entry.name}`,
      root: entry.root ?? 'lexical-y',
      state: new Uint8Array(
        fs.readFileSync(path.join(dir, file.replace(/\.main\.json$/, '.bin'))),
      ),
    });
  }
  return out;
}

async function run(inputs: Input[]): Promise<{n: number; failures: string[]}> {
  const failures: string[] = [];
  let n = 0;
  for (const input of inputs) {
    for (const gc of input.gcs) {
      n++;
      const failure = await check(input, gc);
      if (failure !== null) {
        failures.push(failure);
      }
    }
  }
  return {failures, n};
}

describe('a document below the floor shows what its migration would make of it', () => {
  test("its one exception, l2-comment-raw: the read only display omits the raw array's value, the migrated read keeps it", async () => {
    const fixtures = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Golden[];
    const golden = fixtures.find(f => f.name === 'l2-comment-raw')!;
    const input = goldenInputs().find(i => i.name === 'l2-comment-raw')!;
    const member = 'markIds\u001fc9';
    type Read = {
      json: {root: {children: {children: {$?: Record<string, unknown>}[]}[]}};
    };
    const valueOf = (read: unknown) =>
      (read as Read).json.root.children[0].children[0].$?.[member];
    /** `read` with the member left out (and `$` where that empties it). */
    const withoutMember = (read: unknown): unknown => {
      const copy = plain(read) as Read;
      const node = copy.json.root.children[0].children[0];
      if (node.$ !== undefined) {
        delete node.$[member];
        if (Object.keys(node.$).length === 0) {
          delete node.$;
        }
      }
      return copy;
    };
    for (const gc of [false, true]) {
      // Below the floor: the array reads as a clearer, no value, and the
      // display is otherwise all a fresh bound reader shows after 2to3, and
      // all the release before showed (only the member differs).
      const shown = await boundRead(input, gc);
      expect(valueOf(shown)).toBeUndefined();
      // After 2to3: the value, as the release before read it (the frozen
      // read the golden pins).
      const migrated = migrateYState(input.state, STEPS, {gc}).state;
      const read = plain(readYState(migrated, input.config, $snapshot));
      expect(valueOf(read)).toEqual([1, 2]);
      expect(read).toEqual(plain(golden.main));
      const fresh = await boundRead({...input, state: migrated}, gc);
      expect(valueOf(fresh)).toEqual([1, 2]);
      expect(shown).toEqual(withoutMember(fresh));
      expect(shown).toEqual(withoutMember(golden.main));
    }
  });

  test('the 2to3 golden fixtures', async () => {
    const inputs = goldenInputs();
    expect(inputs.length).toBeGreaterThan(0);
    const {n, failures} = await run(inputs);
    expect({failures, n}).toEqual({
      failures: Object.keys(KNOWN).flatMap(name =>
        [false, true].map(
          gc =>
            `${name} gc ${gc ? 'on' : 'off'}: the bound editor's read only display differs from the migrated read`,
        ),
      ),
      n: inputs.length * 2,
    });
  });

  test('the 3to4 golden fixtures (layout 3)', async () => {
    const inputs = goldenInputs3to4();
    expect(inputs.length).toBeGreaterThan(30);
    expect(inputs.every(i => i.layout === 3)).toBe(true);
    const {n, failures} = await run(inputs);
    expect({failures, n}).toEqual({
      // (In fixture order.)
      failures: inputs
        .map(i => i.name)
        .filter(name => name in KNOWN_3TO4)
        .flatMap(name =>
          [false, true].map(
            gc =>
              `${name} gc ${gc ? 'on' : 'off'}: the bound editor's read only display differs from the migrated read`,
          ),
        ),
      n: inputs.length * 2,
    });
    expect(inputs.filter(i => i.name in KNOWN_3TO4).length).toBe(
      Object.keys(KNOWN_3TO4).length,
    );
  });

  test('the 1to2 golden fixtures and the layout 2 states 1to2 makes of them', async () => {
    const inputs = goldenInputs1to2();
    expect(inputs.length).toBe(21);
    const {n, failures} = await run(inputs);
    expect({failures, n}).toEqual({failures: [], n: 28});
  });

  test.skipIf(DIRS.length === 0)(
    'a sample of the stored corpora',
    {timeout: 3_600_000},
    async () => {
      const inputs = corpusInputs();
      const {n, failures} = await run(inputs);
      if (process.env.BELOW_FLOOR_REPORT !== undefined) {
        fs.writeFileSync(
          process.env.BELOW_FLOOR_REPORT,
          JSON.stringify({
            failures,
            inputs: inputs.length,
            n,
            names: inputs.map(i => i.name),
          }) + '\n',
        );
      }
      expect({failures: failures.slice(0, 20), n}).toEqual({failures: [], n});
    },
  );
});
