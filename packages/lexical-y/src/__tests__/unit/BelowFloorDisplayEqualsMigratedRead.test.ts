/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A document below the floor (layout 1 or 2) opens read only, and the live
// reader shows it as it is: the layout 3 reader holds no code for older
// layouts, as an older document holds no run ends. Pinned here: what it
// shows equals a fresh read of the same document after 2to3 by a bound
// editor, gc off and on. (A headless read refuses a document
// it cannot write: `readYState` throws a `'read-only'` YHeadlessError
// there, pinned too.)
//
// Inputs: every layout 1 and 2 state of the 2to3 golden fixtures; and,
// where BELOW_FLOOR_CORPORA lists corpus directories (the stored corpora of
// Migrate2to3Corpora), every BELOW_FLOOR_EVERY-th entry (default 10, by
// sorted file name) that records a layout below 3.

import {buildEditorFromExtensions} from '@lexical/extension';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {createYCollabConfig, createYDoc} from '../..';
import {type HeadlessYConfig, readYState, YHeadlessError} from '../../headless';
import {migrateYState} from '../../migrate';
import step1to2 from '../../migrate/1to2';
import step2to3 from '../../migrate/2to3';
import {$snapshot, catalogHeadlessConfig, snapshot} from '../catalog/bind';
import {flush} from '../utils/harness';
import {type CorpusConfig, corpusConfig} from '../utils/noteApp';

const STEPS = [step1to2, step2to3];

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
const GOLDEN = path.join(__dirname, 'golden', 'migrate-2to3-r1.json');

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

function corpusInputs(): Input[] {
  const out: Input[] = [];
  for (const dir of DIRS) {
    const files = fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.main.json'))
      .sort();
    for (let i = 0; i < files.length; i += EVERY) {
      const file = files[i];
      const entry = JSON.parse(
        fs.readFileSync(path.join(dir, file), 'utf8'),
      ) as Entry;
      if (entry.layout === null || entry.layout >= 3) {
        continue;
      }
      out.push({
        config: corpusConfig(entry.cfg),
        gcs: entry.gc === null ? [false, true] : [entry.gc],
        layout: entry.layout,
        name: `${path.basename(dir)}/${entry.name}`,
        root: entry.root ?? 'lexical-y',
        state: new Uint8Array(
          fs.readFileSync(
            path.join(dir, file.replace(/\.main\.json$/, '.bin')),
          ),
        ),
      });
    }
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

describe('a document below the floor shows what 2to3 would make of it', () => {
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

  test.skipIf(DIRS.length === 0)(
    'a sample of the stored corpora',
    {timeout: 3_600_000},
    async () => {
      const inputs = corpusInputs();
      const {n, failures} = await run(inputs);
      if (process.env.BELOW_FLOOR_REPORT !== undefined) {
        fs.writeFileSync(
          process.env.BELOW_FLOOR_REPORT,
          JSON.stringify({failures, inputs: inputs.length, n}) + '\n',
        );
      }
      expect({failures: failures.slice(0, 20), n}).toEqual({failures: [], n});
    },
  );
});
