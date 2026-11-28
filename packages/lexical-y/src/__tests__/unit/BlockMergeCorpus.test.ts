/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The block merge (D133) over a generated corpus (utils/blockMergeCorpus):
// 2,800 seeded cases of two concurrent sets of edits to one block, over
// paragraphs, a heading, formatted runs, links, line breaks, a list, a
// table and text of repeated letters, each checked against a model in
// which every character has an identity. Every merged block must be what
// the model makes of both sides' edits (so no character is lost or there
// twice, and the format of what neither side touched is as it was); edits
// whose order matters must stay a conflict; and the merge may change
// nothing of a report but turn a conflict into a merge.
//
// BLOCK_MERGE_CORPUS_OUT=<file> writes the counts as JSON.

import * as fs from 'node:fs';
import {describe, expect, test} from 'vitest';

import {
  type Case,
  FAMILIES,
  makeCase,
  type Outcome,
  runCase,
} from '../utils/blockMergeCorpus';

// BLOCK_MERGE_CORPUS_CASES=<n> runs another number of seeds, and
// BLOCK_MERGE_CORPUS_FROM=<seed> starts at another seed (a soak, in parts).
const CASES = Number(process.env.BLOCK_MERGE_CORPUS_CASES || 2800);
const FROM = Number(process.env.BLOCK_MERGE_CORPUS_FROM || 0);

describe('block merge corpus', () => {
  // Of each case, what the counts and a failure's message need (a soak
  // does not hold every document).
  const cases: Pick<Case, 'family' | 'label'>[] = [];
  const outcomes: Outcome[] = [];
  const first = JSON.stringify(makeCase(FROM));
  for (let seed = FROM; seed < FROM + CASES; seed++) {
    const c = makeCase(seed);
    cases.push({family: c.family, label: c.label});
    outcomes.push(runCase(c));
  }

  test('the corpus is the same for the same seeds', () => {
    expect(JSON.stringify(makeCase(FROM))).toBe(first);
    for (const at of [1, Math.floor(CASES / 3), CASES - 1]) {
      const c = makeCase(FROM + at);
      expect(JSON.stringify(makeCase(FROM + at))).toBe(JSON.stringify(c));
      expect({family: c.family, label: c.label}).toEqual(cases[at]);
    }
    // And they differ from one seed to the next.
    expect(JSON.stringify(makeCase(FROM + 1))).not.toBe(first);
  });

  test('no merged block differs from what both sides edits make, and no report changes but from conflict to merged', () => {
    const wrong = outcomes.flatMap((outcome, at) =>
      outcome.violations.map(
        violation =>
          `seed ${FROM + at} (${cases[at].family}, ${cases[at].label}): ${violation}`,
      ),
    );
    expect(wrong).toEqual([]);
  });

  test('edits whose order matters are never merged', () => {
    const merged = outcomes
      .map((outcome, at) => ({outcome, seed: FROM + at}))
      .filter(
        ({outcome}) => outcome.kind === 'order' && outcome.after === 'merged',
      )
      .map(({seed}) => seed);
    expect(merged).toEqual([]);
  });

  test('the counts', () => {
    const count = (filter: (o: Outcome, c: Pick<Case, 'family'>) => boolean) =>
      outcomes.filter((o, i) => filter(o, cases[i])).length;
    const reasons = (
      filter: (o: Outcome, c: Pick<Case, 'family'>) => boolean,
    ) => {
      const by: Record<string, number> = {};
      outcomes.forEach((o, i) => {
        if (o.after === 'conflict' && filter(o, cases[i])) {
          const key = `${o.conflict}: ${o.conflictDetail}`;
          by[key] = (by[key] || 0) + 1;
        }
      });
      return Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]));
    };
    const conflictBefore = (o: Outcome) => o.before === 'conflict';
    const summary = {
      // The target block's entry without the merge.
      before: {
        conflict: count(conflictBefore),
        inDocument: count(o => o.before === 'in-document'),
        unchanged: count(o => o.before === 'unchanged'),
        whole: count(o => o.before === 'whole'),
      },
      byFamily: Object.fromEntries(
        FAMILIES.map(family => [
          family,
          {
            conflicts: count(
              (o, c) => conflictBefore(o) && c.family === family,
            ),
            merged: count(
              (o, c) =>
                conflictBefore(o) &&
                c.family === family &&
                o.after === 'merged',
            ),
          },
        ]),
      ),
      // By what the model says of the two sides' edits (see Expected).
      byModel: Object.fromEntries(
        (['commute', 'typed-format', 'order'] as const).map(kind => [
          kind,
          {
            conflicts: count(o => conflictBefore(o) && o.kind === kind),
            inDocument: count(
              o =>
                conflictBefore(o) &&
                o.kind === kind &&
                o.after === 'in-document',
            ),
            merged: count(
              o => conflictBefore(o) && o.kind === kind && o.after === 'merged',
            ),
            why: reasons(o => conflictBefore(o) && o.kind === kind),
          },
        ]),
      ),
      cases: CASES,
      // Of the conflicts without the merge, what the merge makes of them:
      // a merge to write, a block the document already holds with the
      // user's edits (one of them had arrived), or still a conflict.
      ofConflicts: {
        inDocument: count(o => conflictBefore(o) && o.after === 'in-document'),
        merged: count(o => conflictBefore(o) && o.after === 'merged'),
        stillConflict: count(o => conflictBefore(o) && o.after === 'conflict'),
      },
      violations: outcomes.reduce((n, o) => n + o.violations.length, 0),
    };
    const out = process.env.BLOCK_MERGE_CORPUS_OUT;
    if (out !== undefined) {
      fs.writeFileSync(out, JSON.stringify(summary, null, 2));
    }
    expect(summary.violations).toBe(0);
    expect(summary.byModel.order.merged).toBe(0);
    // The merge resolves most of the conflicts whose edits commute.
    expect(summary.byModel.commute.merged).toBeGreaterThan(
      summary.byModel.commute.conflicts / 2,
    );
  });
});
