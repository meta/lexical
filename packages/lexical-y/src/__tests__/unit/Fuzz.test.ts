/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Deterministic randomized runs: 3 peers, every delivery mode, typing,
// formats, links, comments, lists, tables, containers, undo and redo. Each
// seed checks convergence, a fresh reader, canonical shape, the self-check,
// and that no typed text is lost or duplicated.
//
// Longer runs: FUZZ_SEED_START=1 FUZZ_SEEDS=10000 FUZZ_GC_SEEDS=2500.
// One seed with its op trace: FUZZ_SEED=123 (add FUZZ_GC=1 for gc).
// Differential: the same scripts on the default v2 layout of @lexical/yjs
// (Yjs 13): FUZZ_DIFF=1 with the same seed variables. Two checks per seed:
// - absolute, on @lexical/y's full script: no divergence, exception,
//   fragmented token, self-check warning, fresh-reader mismatch or recovered
//   read or write;
// - relative: @lexical/y never loses or duplicates more tokens, diverges,
//   throws or splits a token where v2 does not. Ops pick their targets in
//   the current document, so the pair is compared on the script cut before
//   the first op the two runs resolved differently. Text typed into a
//   container a peer removed, which v2 keeps only by bringing back deleted
//   content, is not counted as lost (resurrectionExcuse).
// Run the relative check with FUZZ_NO_MOVE=1 (add FUZZ_GC=1 for gc): with
// block moves on, the move limit below makes @lexical/y worse than v2 on
// about 0.5% of seeds, while the absolute check still holds.
//
// Not checked here (documented limits): block moves (a move is a delete and
// a reinsert, so a concurrent edit of the moved block can duplicate or lose
// it), and text typed inside a container a peer removed (delete wins).

import {describe, expect, test} from 'vitest';

import {
  absoluteFindings,
  genScript,
  runLayouts,
  runScript,
  worseThanV2,
} from '../utils/fuzz';

const START = Number(process.env.FUZZ_SEED_START ?? 1);
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 300);
const GC_SEEDS = Number(process.env.FUZZ_GC_SEEDS ?? 100);
// Seeds per test: a test stays well under 30 s on a slow CI runner.
const CHUNK = 25;

// Seeds whose finding is shared by @lexical/yjs's v2 layout (the same
// tokens are lost there), skipped so a regression elsewhere fails.
const KNOWN_OPEN = new Map<number, string>([
  // Documented limits, shared with the Yjs 13 layouts or where they diverge
  // (seen in runs of 2,000 seeds; triaged on the minimized scripts):
  // two peers turn the same paragraph into a number list and a bullet list
  // in the same round: both lists keep it, so its text shows twice
  // (#9386 and v2 duplicate it too).
  [347, 'one paragraph made a list by two peers at once (dup)'],
  // A table inserted into a box while a peer makes the box's paragraph a
  // list, which replaces the box: the table goes with the box (delete wins;
  // #9386 and v2 lose the same tokens).
  [1045, 'a block inserted into a container a peer removes'],
]);

function allowed(sig: string): boolean {
  return (
    sig.startsWith('limit:') ||
    sig.startsWith('nit:') ||
    sig === 'loss(container)'
  );
}

function runSeeds(from: number, to: number, gc: boolean): string[] {
  const prev = process.env.FUZZ_GC;
  process.env.FUZZ_GC = gc ? '1' : '';
  const found: string[] = [];
  try {
    for (let seed = from; seed < to; seed++) {
      if (KNOWN_OPEN.has(seed)) {
        continue;
      }
      const res = runScript(genScript(seed, {moves: false}));
      const sigs = res.failures.map(f => f.sig).filter(s => !allowed(s));
      if (sigs.length > 0) {
        found.push(`seed ${seed}${gc ? ' (gc)' : ''}: ${sigs.join(', ')}`);
      }
    }
  } finally {
    process.env.FUZZ_GC = prev;
  }
  return found;
}

function chunks(start: number, count: number): [number, number][] {
  const out: [number, number][] = [];
  for (let s = start; s < start + count; s += CHUNK) {
    out.push([s, Math.min(s + CHUNK, start + count)]);
  }
  return out;
}

// Seeds where @lexical/y does worse than v2 in a documented limit, skipped
// by the relative check (the absolute check still runs on them).
const KNOWN_WORSE_THAN_V2 = new Map<number, string>([
  // Every token @lexical/y loses was typed into a table a peer removed
  // (delete wins); v2 keeps some of them and duplicates another.
  [5789, 'loss: delete wins in a removed container'],
]);

if (process.env.FUZZ_DIFF === '1') {
  test('differential', () => {
    const worse: string[] = [];
    for (let seed = START; seed < START + SEEDS; seed++) {
      const runs = runLayouts(genScript(seed));
      // Absolute: @lexical/y's own full-script run.
      const own = absoluteFindings(runs);
      if (own.length > 0) {
        worse.push(`seed ${seed}: ${own.join(', ')} (full script)`);
      }
      // Relative: each pair on its cut script.
      const cats = worseThanV2(runs);
      if (cats.length > 0 && !KNOWN_WORSE_THAN_V2.has(seed)) {
        worse.push(`seed ${seed}: worse than v2 in ${cats.join(', ')}`);
      }
    }
    expect(worse).toEqual([]);
  }, 3_600_000);
} else if (process.env.FUZZ_SEED !== undefined) {
  test('one seed with its trace', () => {
    const res = runScript(
      genScript(Number(process.env.FUZZ_SEED), {moves: false}),
      true,
    );
    // eslint-disable-next-line no-console
    console.log(
      [...(res.trace ?? []), ...res.failures.map(f => f.detail)].join('\n'),
    );
    expect(res.failures.map(f => f.sig).filter(s => !allowed(s))).toEqual([]);
  });
} else {
  describe('@lexical/y fuzz', () => {
    test.each(chunks(START, SEEDS))(
      'seeds %i..%i',
      (from, to) => {
        expect(runSeeds(from, to, false)).toEqual([]);
      },
      600_000,
    );
    test.each(chunks(START, GC_SEEDS))(
      'gc seeds %i..%i',
      (from, to) => {
        expect(runSeeds(from, to, true)).toEqual([]);
      },
      600_000,
    );
  });
}
