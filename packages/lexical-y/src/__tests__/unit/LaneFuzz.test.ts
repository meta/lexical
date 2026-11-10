/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// Randomized lanes for the composition hold and what runs when it ends, each
// checked on this tree alone (no comparison with another build). See
// utils/lanes/ for what each lane generates and checks:
// - blockconv: a collaborator converts the block A composes in; A's ending
//   update runs transforms (entities, code highlighting, app transforms,
//   including ones that restructure or rewrite the held heading);
// - carry: NodeState changes in the ending update on a code line a
//   collaborator joined or converted, through a NodeState-preserving or the
//   stock code tokenizer;
// - nohold: the same NodeState changes and tokenizers with no composition.
// Every lane checks editor errors, self-check and recovered-write warnings,
// the storage structure and paired-run grammar of every document, and
// convergence of every peer and a fresh reader, plus its own invariants.
//
// The default is a smoke slice (2 histories per lane and gc setting, about a
// second) that runs with the unit tests; .github/workflows/y-lanes-nightly.yml
// runs thousands per lane from a seed range that changes every night. A
// failure prints its seed and a minimized repro with the command that
// replays it. Env:
// - LANE_SEEDS: histories per lane and gc setting (default 2);
// - LANE_SEED_START (default 1);
// - LANES: comma-separated lane names (default all);
// - LANE_GC: 0 or 1 for one gc setting (default both);
// - LANE_SHRINK: the shrinker's run budget per failure (default 80, 0: off);
// - LANE_OUT: where minimized repros are written (default a temp
//   directory); when set, also findings.jsonl, one line per history with a
//   finding, known open ones included;
// - LANE_STRICT=1: known-open classes fail too (otherwise a run of at least
//   500 histories per lane and gc setting fails only when one grows past its
//   ceiling, see KNOWN_OPEN);
// - LANE_REPLAY=<file>: replay one repro (a JSON history this file wrote).

import {loadCodeLanguage, loadCodeTheme} from '@lexical/code-shiki';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, expect, test} from 'vitest';

import {blockConvLane} from '../utils/lanes/blockconv';
import {carryLane, noHoldLane} from '../utils/lanes/carry';
import {
  type Finding,
  type Lane,
  type LaneHistory,
  runSafe,
  shrink,
} from '../utils/lanes/common';

// Each lane's history type is its own; the runner only passes a lane's own
// histories back to it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLane = Lane<any>;
type AnyHistory = LaneHistory<unknown>;
const LANES: AnyLane[] = [blockConvLane, carryLane, noHoldLane];

/** A decimal integer env var (at least `min`), or `fallback` when unset. */
function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const n = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(n) || n < min) {
    throw new Error(
      `${name} must be a decimal integer of at least ${min}, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

const START = intEnv('LANE_SEED_START', 1, 1);
const SEEDS = intEnv('LANE_SEEDS', 2, 1);
const ONLY = process.env.LANES?.split(',').map(s => s.trim());
const GCS =
  process.env.LANE_GC === '0'
    ? [false]
    : process.env.LANE_GC === '1'
      ? [true]
      : [false, true];
const SHRINK = intEnv('LANE_SHRINK', 80, 0);
const STRICT = process.env.LANE_STRICT === '1';
const OUT =
  process.env.LANE_OUT ?? path.join(os.tmpdir(), 'lexical-y-lane-repros');
// Histories per test, so a test stays well under its timeout on CI.
const CHUNK = 25;
// Failures shrunk per test (the rest are listed with their seeds).
const SHRINK_PER_TEST = 3;

/**
 * Finding classes that reproduce on main, per lane: counted and printed, not
 * failed one by one (LANE_STRICT=1 fails them too). Each says what was seen
 * and its rate on main: histories per 1,000 that show it (`per1000`,
 * measured on main at 8c369d793 over 13,000 histories per gc setting, seeds
 * 100001 to 110000 and 300001 to 303000, the higher of the two). A run of at least
 * CEILING_MIN_HISTORIES fails when a class grows past its ceiling (see
 * `ceiling`), so growth fails instead of hiding behind the class name. Lower
 * `per1000` with a fix that reduces a class, and remove the entry with the
 * fix that brings it to zero.
 *
 * Triage: these classes share one root cause, in the writer's marker
 * matching when the ending update of a held composition is written over a
 * block a collaborator changed; its fix is planned as a separate pull
 * request. The rates are measured with #9835 (a code highlighter's
 * re-tokenization of a held code line kept off a block a collaborator made
 * of it) and #9832 (the highlighter keeps the NodeState of the text it
 * tokenizes again), which reduced the carry lane's classes most.
 */
const KNOWN_OPEN = new Map<string, {seen: string; per1000: number}>([
  [
    'blockconv:ending-phase-other-block',
    {
      per1000: 26.5,
      seen: "the composer's highlighter re-tokenizes a collaborator's untouched code block in the ending update, dropping its format and NodeState",
    },
  ],
  [
    'blockconv:untouched-block-changed',
    {
      per1000: 26.3,
      seen: "the composer's highlighter re-tokenizes a collaborator's untouched code block in the ending update, dropping its format and NodeState",
    },
  ],
  [
    'blockconv:ending-phase-code-highlight-outside-code',
    {
      per1000: 9.2,
      seen: 'the ending update writes code highlight tokens onto a block a collaborator converted out of code',
    },
  ],
  [
    'blockconv:ending-phase-text',
    {
      per1000: 8.6,
      seen: 'text the ending update writes lands in another block, for example what it types at the end of the held line lands in the block after it',
    },
  ],
  [
    'blockconv:ending-phase-format',
    {
      per1000: 7.8,
      seen: 'the ending update writes a format nothing asked for onto the held line, for example a parent-dependent transform run against the block type the line had, written onto the line a collaborator joined it into',
    },
  ],
  [
    'blockconv:ending-phase-boundary',
    {
      per1000: 0.1,
      seen: 'the ending phase adds a block boundary nothing accounts for (seen once in 26,000 histories: a release transform that splits the held line, which the collaborator deleted)',
    },
  ],
  [
    'carry:ending-phase-code-highlight-outside-code',
    {
      per1000: 196.5,
      seen: 'the ending update re-tokenizes the held code line a collaborator joined into a paragraph and writes the tokens there',
    },
  ],
  [
    'carry:ending-phase-field',
    {
      per1000: 187.3,
      seen: "the ending update re-tokenizes the held code line a collaborator joined into a paragraph and writes the tokens' styles there",
    },
  ],
  [
    'carry:ending-phase-text',
    {
      per1000: 94.8,
      seen: "the composer's writes from the ending update add or remove characters, in the held line or another block, for example the text of an inline decorator its highlighter turned into code text",
    },
  ],
  [
    'carry:decorator-lost',
    {
      per1000: 57.5,
      seen: "the composer's highlighter, run on the held line as the code it was, turns its inline decorator into code text (stock highlighters do so in any code block)",
    },
  ],
  [
    'carry:other-block-changed',
    {
      per1000: 15.2,
      seen: "with the held line deleted by the collaborator, the composer's re-tokenized text joins the untouched block after it",
    },
  ],
  [
    'carry:ending-phase-other-block',
    {
      per1000: 15.2,
      seen: "with the held line deleted by the collaborator, the composer's re-tokenized text joins the untouched block after it",
    },
  ],
  [
    'carry:ending-phase-state',
    {
      per1000: 7.2,
      seen: 'the ending phase leaves NodeState values the ending update did not ask for on the held line',
    },
  ],
  [
    'carry:target-value',
    {
      per1000: 7.2,
      seen: 'a NodeState value the ending update set does not stay on a changed character',
    },
  ],
]);

/** Whether a finding's class is a known-open one (counted in any mode). */
const isKnownClass = (lane: string, f: Finding) =>
  KNOWN_OPEN.has(`${lane}:${f.cls}`);
/** Whether a finding is let through: a known-open class outside strict mode. */
const isKnown = (lane: string, f: Finding) => !STRICT && isKnownClass(lane, f);

const TEST_FILE = 'packages/lexical-y/src/__tests__/unit/LaneFuzz.test.ts';

function replayCommand(file: string): string {
  // A strict run's repro fails only in strict mode.
  return `${STRICT ? 'LANE_STRICT=1 ' : ''}LANE_REPLAY=${file} pnpm exec vitest run --project unit ${TEST_FILE}`;
}

async function report(lane: AnyLane, h: AnyHistory, found: Finding[]) {
  const cls = found[0].cls;
  const shrunk =
    SHRINK > 0
      ? await shrink(lane, h, cls, SHRINK)
      : {findings: found, history: h, runs: 0};
  const findings = shrunk.findings.length > 0 ? shrunk.findings : found;
  fs.mkdirSync(OUT, {recursive: true});
  const file = path.join(
    OUT,
    `${lane.name}-s${h.seed}${h.gc ? '-gc' : ''}-${cls}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(shrunk.history, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(
    [
      `lane ${lane.name}, seed ${h.seed}${h.gc ? ' (gc)' : ''}: ${cls}`,
      ...findings
        .filter(f => f.cls === cls)
        .slice(0, 4)
        .map(f => `  ${f.detail}`),
      `minimized repro (${shrunk.runs} shrink runs), written to ${file}:`,
      JSON.stringify(shrunk.history),
      `replay: ${replayCommand(file)}`,
    ].join('\n'),
  );
}

async function runSeeds(lane: AnyLane, from: number, to: number, gc: boolean) {
  const failed: string[] = [];
  const known = new Map<string, number>();
  let shrunk = 0;
  for (let seed = from; seed < to; seed++) {
    const h = lane.generate(seed, gc);
    const findings = await runSafe(lane, h);
    if (findings.length === 0) {
      continue;
    }
    const knownClasses = [
      ...new Set(
        findings.filter(f => isKnownClass(lane.name, f)).map(f => f.cls),
      ),
    ];
    for (const cls of knownClasses) {
      known.set(cls, (known.get(cls) ?? 0) + 1);
    }
    const real = findings.filter(f => !isKnown(lane.name, f));
    const classes = [...new Set(real.map(f => f.cls))];
    if (process.env.LANE_OUT) {
      fs.mkdirSync(OUT, {recursive: true});
      fs.appendFileSync(
        path.join(OUT, 'findings.jsonl'),
        JSON.stringify({classes, history: h, known: knownClasses}) + '\n',
      );
    }
    if (real.length === 0) {
      continue;
    }
    failed.push(`seed ${seed}${gc ? ' (gc)' : ''}: ${classes.join(', ')}`);
    if (shrunk++ < SHRINK_PER_TEST) {
      await report(lane, h, real);
    }
  }
  // The smoke slice in the unit tests prints nothing for known-open classes.
  if (known.size > 0 && process.env.LANE_SEEDS !== undefined) {
    // eslint-disable-next-line no-console
    console.log(
      [
        `lane ${lane.name} seeds ${from}..${to - 1}${gc ? ' (gc)' : ''}, known open (histories):`,
        ...[...known].map(
          ([cls, n]) =>
            `  ${cls}: ${n} (${KNOWN_OPEN.get(`${lane.name}:${cls}`)?.seen})`,
        ),
      ].join('\n'),
    );
  }
  const totals = knownTotals.get(`${lane.name}${gc ? ' (gc)' : ''}`);
  for (const [cls, n] of known) {
    totals?.set(cls, (totals.get(cls) ?? 0) + n);
  }
  return failed;
}

/**
 * Known-open histories per lane and gc setting, over the whole run. In
 * GitHub Actions they go to the job summary once (afterAll), with each
 * class's ceiling, so a night where a known class grows does not look like
 * a quiet one.
 */
const knownTotals = new Map<string, Map<string, number>>();

/** The fewest histories per lane and gc setting a ceiling is checked on. */
const CEILING_MIN_HISTORIES = 500;

/**
 * The most histories of `histories` a known-open class may show: 1.5 times
 * its rate on main, and never less than 4 standard deviations (plus 2) above
 * it, so a rare class does not fail a night by chance (a class seen 3 times
 * in 3,000 histories on main would reach 1.5 times that, 5, on about one
 * night in six).
 */
function ceiling(per1000: number, histories: number): number {
  const expected = (per1000 * histories) / 1000;
  return Math.floor(
    Math.max(1.5 * expected, expected + 4 * Math.sqrt(expected) + 2),
  );
}

/** Each class's count and ceiling for one lane and gc setting. */
function ceilingRows(lane: string, totals: Map<string, number>) {
  return [...KNOWN_OPEN]
    .filter(([key]) => key.startsWith(`${lane}:`))
    .map(([key, {per1000}]) => {
      const cls = key.slice(lane.length + 1);
      const n = totals.get(cls) ?? 0;
      const max = ceiling(per1000, SEEDS);
      return {ceiling: max, cls, histories: n, over: n > max, per1000};
    })
    .sort((a, b) => b.histories - a.histories);
}

afterAll(() => {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary || process.env.LANE_SEEDS === undefined) {
    return;
  }
  const lines = [];
  for (const [run, totals] of knownTotals) {
    const rows = ceilingRows(run.split(' ')[0], totals);
    lines.push(
      `${run}, seeds ${START} to ${START + SEEDS - 1}, known open:`,
      '',
      '| Class | Histories | Ceiling | Rate on main (per 1,000) |',
      '| --- | --- | --- | --- |',
      ...rows.map(
        r =>
          `| \`${r.cls}\` | ${r.histories}${r.over ? ' (over)' : ''} | ${r.ceiling} | ${r.per1000} |`,
      ),
      '',
    );
  }
  fs.appendFileSync(summary, lines.join('\n') + '\n');
});

/**
 * A test's timeout: half a second per run (a history takes well under 100
 * ms) for its histories and the shrink runs of the failures it shrinks, at
 * least a minute. With the default shrink budget, a hang in the smoke slice
 * fails in about a minute and a half, not half an hour.
 */
function timeout(histories: number): number {
  const runs = histories + Math.min(histories, SHRINK_PER_TEST) * SHRINK;
  return Math.max(60_000, runs * 500);
}

/** Seed ranges of CHUNK histories, first and last seed included. */
function chunks(start: number, count: number): [number, number][] {
  const out: [number, number][] = [];
  for (let s = start; s < start + count; s += CHUNK) {
    out.push([s, Math.min(s + CHUNK, start + count) - 1]);
  }
  return out;
}

beforeAll(async () => {
  await loadCodeLanguage('javascript');
  await loadCodeTheme('one-light');
});

if (process.env.LANE_REPLAY) {
  test(`replay ${process.env.LANE_REPLAY}`, async () => {
    const h: AnyHistory = JSON.parse(
      fs.readFileSync(process.env.LANE_REPLAY!, 'utf8'),
    );
    const lane = LANES.find(l => l.name === h.lane);
    expect(lane).toBeDefined();
    const findings = await runSafe(lane!, h);
    // eslint-disable-next-line no-console
    console.log(findings.map(f => `${f.cls}: ${f.detail}`).join('\n'));
    expect(findings.filter(f => !isKnown(h.lane, f))).toEqual([]);
  }, 120_000);
} else {
  for (const lane of LANES.filter(l => !ONLY || ONLY.includes(l.name))) {
    describe(`lane ${lane.name}`, () => {
      for (const gc of GCS) {
        const run = `${lane.name}${gc ? ' (gc)' : ''}`;
        knownTotals.set(run, new Map());
        test.each(chunks(START, SEEDS))(
          `${gc ? 'gc ' : ''}seeds %i..%i`,
          async (first, last) => {
            expect(await runSeeds(lane, first, last + 1, gc)).toEqual([]);
          },
          timeout(Math.min(CHUNK, SEEDS)),
        );
        // After this lane and gc setting's histories (tests in a file run
        // in order): the known-open classes against their ceilings.
        test(`${gc ? 'gc ' : ''}known-open classes stay under their ceilings`, () => {
          const rows = ceilingRows(lane.name, knownTotals.get(run)!);
          if (process.env.LANE_OUT) {
            fs.mkdirSync(OUT, {recursive: true});
            fs.writeFileSync(
              path.join(OUT, `known-open-${lane.name}-gc${gc ? 1 : 0}.json`),
              JSON.stringify(
                {gc, histories: SEEDS, lane: lane.name, rows, start: START},
                null,
                2,
              ) + '\n',
            );
          }
          if (STRICT || SEEDS < CEILING_MIN_HISTORIES) {
            return;
          }
          expect(
            rows
              .filter(r => r.over)
              .map(
                r =>
                  `${r.cls}: ${r.histories} of ${SEEDS} histories, ceiling ${r.ceiling} (${r.per1000} per 1,000 on main)`,
              ),
          ).toEqual([]);
        });
      }
    });
  }
}
