/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Render equivalence of the migration chain over stored corpora:
// each state was written by an earlier release (layout 1, 2 or 3), and its
// `<name>.main.json` holds that release's own read (editor JSON, derived
// fields, list numbering), the configuration it used and its layout root.
// The chain 1to2 + 2to3 + 3to4 migrates it in place from the layout it
// records (the runner's checks pass: ids, content, order, parents,
// attributes, per-unit reads, checkAfter, re-read); the migrated state then
// reads the same here, block ids compared separately; layout 4's invariants
// hold on every container; a second migration is a no-op. An entry whose
// read is null (an app whose nodes are not here) is checked by the runner
// alone. MIGRATE_CORPORA (or MIGRATE_2TO3_CORPORA, its name while the floor
// was 3) lists directories (comma separated); with none, the test is
// skipped. MIGRATE_2TO3_OUT writes one JSON line per state (timings and
// sizes, of the last step that ran); MIGRATE_2TO3_SHARD/SHARDS split the
// entries.

import * as Y from '@y/y';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {readYState} from '../../headless';
import {createRawYDoc} from '../../internal/RawYDoc';
import {getYLayoutInfo, migrateYState} from '../../migrate';
import step1to2 from '../../migrate/1to2';
import step2to3 from '../../migrate/2to3';
import step3to4 from '../../migrate/3to4';
import step4to5 from '../../migrate/4to5';
import {$snapshot} from '../catalog/bind';
import {blockIdsOf, withoutBlockIds} from '../utils/migrate2to3';
import {layout4Problems} from '../utils/migrate3to4';
import {type CorpusConfig, corpusConfig} from '../utils/noteApp';

/** The layout `doc`'s root records (see getYLayoutInfo), or null. */
const recordedLayout = (doc: Y.Doc, root = 'lexical-y'): number | null => {
  const info = getYLayoutInfo(doc, root);
  return 'layout' in info ? info.layout : null;
};

const DIRS = (
  process.env.MIGRATE_CORPORA ??
  process.env.MIGRATE_2TO3_CORPORA ??
  ''
)
  .split(',')
  .filter(d => d !== '');
const OUT = process.env.MIGRATE_2TO3_OUT ?? null;
const SHARD = Number(process.env.MIGRATE_2TO3_SHARD ?? 0);
const SHARDS = Number(process.env.MIGRATE_2TO3_SHARDS ?? 1);
const STEPS = [step1to2, step2to3, step3to4, step4to5];

type Entry = {
  name: string;
  cfg: CorpusConfig;
  /** The gc setting the state was written with; null: run both. */
  gc: boolean | null;
  layout: number | null;
  /** The release before's read; null: checked by the runner alone. */
  main: unknown;
  /** The layout root (default `lexical-y`). */
  root?: string;
};

type Line = {
  id: string;
  from: number | null;
  gc: boolean;
  ms: number;
  bytesBefore: number;
  bytesBaseline: number;
  bytesAfter: number;
  written: number | null;
  deleted: number | null;
  same: boolean | null;
};

/** Check one entry under one gc setting; returns its line or a failure. */
function check(
  entry: Entry,
  state: Uint8Array,
  gc: boolean,
  id: string,
): Line | string {
  const root = entry.root ?? 'lexical-y';
  const t0 = performance.now();
  let result;
  try {
    result = migrateYState(state, STEPS, {gc, roots: [root]});
  } catch (e) {
    return `${id}: migrate threw ${String(e).slice(0, 400)}`;
  }
  const ms = performance.now() - t0;
  if (recordedLayout(createRawYDoc(result.state, {gc}), root) !== 4) {
    return `${id}: not at layout 4 after the migration`;
  }
  const problems = layout4Problems(result.state, gc, root);
  if (problems.length > 0) {
    return `${id}: checkAfter ${problems.slice(0, 3).join('; ')}`;
  }
  const again = migrateYState(result.state, STEPS, {gc, roots: [root]});
  if (again.receipt.changed || again.update !== null) {
    return `${id}: a second migration changed it`;
  }
  const step = result.receipt.roots[0]?.steps.find(s => s.id === step3to4.id);
  const line: Line = {
    bytesAfter: result.receipt.bytesAfter,
    bytesBaseline: Y.encodeStateAsUpdate(createRawYDoc(state, {gc})).length,
    bytesBefore: result.receipt.bytesBefore,
    deleted: step?.deleted ?? null,
    from: entry.layout,
    gc,
    id,
    ms,
    same: null,
    written: step?.written ?? null,
  };
  if (entry.main === null) {
    return line;
  }
  let after: unknown;
  try {
    after = readYState(
      result.state,
      corpusConfig(entry.cfg, {root}),
      $snapshot,
    );
  } catch (e) {
    return `${id}: read threw ${String(e).slice(0, 300)}`;
  }
  const main = JSON.parse(JSON.stringify(entry.main));
  const mine = JSON.parse(JSON.stringify(after));
  if (
    JSON.stringify(withoutBlockIds(mine)) !==
    JSON.stringify(withoutBlockIds(main))
  ) {
    return `${id}: editor read differs`;
  }
  if (JSON.stringify(blockIdsOf(mine)) !== JSON.stringify(blockIdsOf(main))) {
    return `${id}: block ids differ`;
  }
  line.same = true;
  return line;
}

describe.skipIf(DIRS.length === 0)(
  'the migration chain over stored corpora',
  () => {
    test(
      'migrated states read as the release that wrote them read them',
      {timeout: 3_600_000},
      () => {
        const failures: string[] = [];
        const lines: Line[] = [];
        let n = 0;
        let k = 0;
        for (const dir of DIRS) {
          for (const file of fs.readdirSync(dir).sort()) {
            if (!file.endsWith('.main.json') || k++ % SHARDS !== SHARD) {
              continue;
            }
            const entry = JSON.parse(
              fs.readFileSync(path.join(dir, file), 'utf8'),
            ) as Entry;
            const state = new Uint8Array(
              fs.readFileSync(
                path.join(dir, file.replace(/\.main\.json$/, '.bin')),
              ),
            );
            for (const gc of entry.gc === null ? [false, true] : [entry.gc]) {
              n++;
              const id = `${path.basename(dir)}/${entry.name} gc ${gc ? 'on' : 'off'}`;
              const out = check(entry, state, gc, id);
              if (typeof out === 'string') {
                failures.push(out);
              } else {
                lines.push(out);
              }
            }
          }
        }
        if (OUT !== null) {
          fs.writeFileSync(
            OUT,
            lines.map(l => JSON.stringify(l)).join('\n') + '\n',
          );
        }
        expect({
          failures: failures.slice(0, 40),
          n,
          nFailed: failures.length,
        }).toEqual({failures: [], n, nFailed: 0});
      },
    );
  },
);
