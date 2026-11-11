/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {Paragraph, PhrasingContent} from 'mdast';

import {TEXT_TYPE_TO_FORMAT} from 'lexical';
import {fromMarkdown} from 'mdast-util-from-markdown';
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from 'mdast-util-gfm-strikethrough';
import {toMarkdown} from 'mdast-util-to-markdown';
import {gfmStrikethrough} from 'micromark-extension-gfm-strikethrough';
import {describe, expect, it} from 'vitest';

import {
  phrasingFromFormattedText,
  phrasingFromTextRuns,
  type TextRun,
} from '../../handlers';

/**
 * Normalizes phrasing into ordered (text, format-bitmask) runs, merging
 * adjacent equal-format text, so trees of different nesting shape compare
 * equal exactly when they mean the same formatted text.
 */
function formatRuns(
  nodes: PhrasingContent[],
  format = 0,
  out: TextRun[] = [],
): TextRun[] {
  for (const node of nodes) {
    let value: string | null = null;
    let f = format;
    if (node.type === 'text') {
      value = node.value;
    } else if (node.type === 'inlineCode') {
      value = node.value;
      f |= TEXT_TYPE_TO_FORMAT.code;
    } else if ('children' in node) {
      const bit =
        node.type === 'strong'
          ? TEXT_TYPE_TO_FORMAT.bold
          : node.type === 'emphasis'
            ? TEXT_TYPE_TO_FORMAT.italic
            : node.type === 'delete'
              ? TEXT_TYPE_TO_FORMAT.strikethrough
              : 0;
      formatRuns(node.children as PhrasingContent[], format | bit, out);
      continue;
    } else {
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.format === f) {
      last.value += value;
    } else {
      out.push({format: f, value});
    }
  }
  return out;
}

/** Serializes every phrasing tree, reusing the parse of identical markdown. */
function createRoundTripChecker() {
  const parsedRuns = new Map<string, string>();
  return (phrasing: PhrasingContent[]): {md: string; ok: boolean} => {
    const md = toMarkdown(
      {children: [{children: phrasing, type: 'paragraph'}], type: 'root'},
      {extensions: [gfmStrikethroughToMarkdown()]},
    );
    let parsed = parsedRuns.get(md);
    if (parsed === undefined) {
      const back = fromMarkdown(md, {
        extensions: [gfmStrikethrough()],
        mdastExtensions: [gfmStrikethroughFromMarkdown()],
      });
      const paragraph = back.children[0] as Paragraph;
      parsed = JSON.stringify(formatRuns(paragraph.children));
      parsedRuns.set(md, parsed);
    }
    // Different trees may serialize identically but mean different things.
    // Always compare the parsed runs with this tree's own expected runs.
    return {md, ok: parsed === JSON.stringify(formatRuns(phrasing))};
  };
}

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generates a random run sequence with adjacent equal formats pre-merged. */
function randomRuns(
  rand: () => number,
  formats: readonly number[],
  formatProbability: number,
): TextRun[] {
  const words = ['he', 'llo', 'wor', 'ld', 'foo', 'bar', 'x'];
  const count = 1 + Math.floor(rand() * 6);
  const runs: TextRun[] = [];
  for (let k = 0; k < count; k++) {
    let format = 0;
    for (const f of formats) {
      if (rand() < formatProbability) {
        format |= f;
      }
    }
    const value = words[Math.floor(rand() * words.length)];
    const last = runs[runs.length - 1];
    if (last && last.format === format) {
      last.value += value;
    } else {
      runs.push({format, value});
    }
  }
  return runs;
}

// Each test round-trips 2,000 random sequences: 1 to 3 s alone, over
// vitest's default 5 s limit when the whole suite runs.
describe('phrasingFromTextRuns', {timeout: 30_000}, () => {
  it('round-trips arbitrary bold/italic overlap exactly', () => {
    const roundTrips = createRoundTripChecker();
    const rand = mulberry32(99);
    const formats = [TEXT_TYPE_TO_FORMAT.bold, TEXT_TYPE_TO_FORMAT.italic];
    for (let trial = 0; trial < 2000; trial++) {
      const runs = randomRuns(rand, formats, 0.45);
      const result = roundTrips(phrasingFromTextRuns(runs));
      expect(
        result.ok,
        `trial ${trial}: ${JSON.stringify(runs)} -> ${JSON.stringify(result.md)}`,
      ).toBe(true);
    }
  });

  it('never round-trips worse than per-run nesting, for any format mix', () => {
    const roundTrips = createRoundTripChecker();
    // Strikethrough and inline code delimiters are not flanking-safe in every
    // position, so a perfect round-trip cannot be promised for every random
    // sequence — but the grouped nesting must never fail where the old
    // one-node-per-run nesting succeeded.
    const rand = mulberry32(12345);
    const formats = [
      TEXT_TYPE_TO_FORMAT.bold,
      TEXT_TYPE_TO_FORMAT.italic,
      TEXT_TYPE_TO_FORMAT.strikethrough,
      TEXT_TYPE_TO_FORMAT.code,
    ];
    let improved = 0;
    for (let trial = 0; trial < 2000; trial++) {
      const runs = randomRuns(rand, formats, 0.35);
      const oldPhrasing = runs.map(run =>
        phrasingFromFormattedText(run.value, run.format),
      );
      const newPhrasing = phrasingFromTextRuns(runs);
      // Both shapes must mean the same formatted text.
      expect(formatRuns(newPhrasing)).toEqual(formatRuns(oldPhrasing));
      const oldResult = roundTrips(oldPhrasing);
      const newResult = roundTrips(newPhrasing);
      if (oldResult.ok && !newResult.ok) {
        expect.fail(
          `regression at trial ${trial}: ${JSON.stringify(runs)}\n` +
            `old ok: ${JSON.stringify(oldResult.md)}\n` +
            `new bad: ${JSON.stringify(newResult.md)}`,
        );
      }
      if (newResult.ok && !oldResult.ok) {
        improved++;
      }
    }
    expect(improved).toBeGreaterThan(0);
  });
});
