/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// The update that ends a held composition, against the reference (see
// utils/composeReference.ts): every cell of the table, a number of seeds
// each, with garbage collection off and on. Off by default (a run of a few
// seeds per cell takes minutes); set COMPOSE_REF_SEEDS to run it. No history
// may diverge, error, fail a storage check or duplicate text, and text may be
// lost only
// where a collaborator deleted a line holding composing text it had received
// (D122) or as the indent of a line Enter made from the line the composing
// editor showed (D119).
//
// Env: COMPOSE_REF_SEEDS (per cell), COMPOSE_REF_START (default 1),
// COMPOSE_REF_CELLS (comma-separated cell ids, default all), COMPOSE_REF_GC
// (0, 1, default both), COMPOSE_REF_SHARD=k/n, COMPOSE_REF_FIX (fixed
// dimensions, e.g. `bSaw=0,endFmt=none,allPeers=1`), COMPOSE_REF_OUT (a JSONL
// file, one row per history), COMPOSE_REF_TRACE=1.

import * as fs from 'node:fs';
import {expect, test} from 'vitest';

import {
  CELLS,
  type Cfg,
  compareWithReference,
  generate,
  textOf,
} from '../utils/composeReference';

const env = process.env;
const SEEDS = Number(env.COMPOSE_REF_SEEDS ?? 0);
const START = Number(env.COMPOSE_REF_START ?? 1);
const CELL_LIST =
  env.COMPOSE_REF_CELLS === undefined || env.COMPOSE_REF_CELLS === 'all'
    ? CELLS
    : env.COMPOSE_REF_CELLS.split(',');
const GCS =
  env.COMPOSE_REF_GC === '0'
    ? [false]
    : env.COMPOSE_REF_GC === '1'
      ? [true]
      : [false, true];
const [SHARD, NSHARD] = (env.COMPOSE_REF_SHARD ?? '0/1').split('/').map(Number);
const OUT = env.COMPOSE_REF_OUT;

/** `cfg` with the dimensions COMPOSE_REF_FIX names fixed. */
function fix(cfg: Cfg): Cfg {
  const out = {...cfg} as Record<string, unknown>;
  for (const pair of (env.COMPOSE_REF_FIX ?? '').split(',')) {
    const [k, v] = pair.split('=');
    if (k === undefined || v === undefined || !(k in out)) {
      continue;
    }
    out[k] = v === '0' ? false : v === '1' ? true : v;
  }
  return out as Cfg;
}

test.skipIf(SEEDS === 0)(
  'the update that ends a held composition, against the reference',
  async () => {
    const bad: string[] = [];
    let k = 0;
    for (const cell of CELL_LIST) {
      for (let seed = START; seed < START + SEEDS; seed++) {
        for (const gc of GCS) {
          if (k++ % NSHARD !== SHARD) {
            continue;
          }
          const cfg = fix(generate(cell, seed));
          const {outcome, ref} = await compareWithReference(cfg, gc);
          if (OUT !== undefined) {
            const row = {
              cell,
              cfg,
              gc,
              outcome,
              ref:
                outcome.cls === 'ref-bad'
                  ? {bad: true, findings: ref.findings.slice(0, 3)}
                  : {text: textOf(ref.views[ref.views.length - 1])},
              seed,
            };
            fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
          }
          const lostIndent =
            outcome.cls === 'text-loss' &&
            cfg.end === 'enter' &&
            / missing " +" extra ""$/.test(outcome.detail);
          if (
            outcome.cls === 'divergence' ||
            outcome.cls === 'error' ||
            outcome.cls === 'storage' ||
            outcome.cls === 'text-dup' ||
            (outcome.cls === 'text-loss' &&
              !(cfg.collab === 'delete' && cfg.bSaw) &&
              !lostIndent)
          ) {
            bad.push(`${cell} seed ${seed} gc ${gc}: ${outcome.detail}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  },
  6 * 60 * 60 * 1000,
);
