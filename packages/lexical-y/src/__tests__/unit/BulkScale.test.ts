/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// One update that changes every line of a big document (text nodes merging
// in each line, joins of every pair of lines) must cost time proportional to
// the document, on the writer and on the peer that reads it.

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  type ElementNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {setup} from '../utils/harness';

async function timed(lines: number, op: () => void): Promise<number> {
  const t = await setup(
    () => {
      for (let i = 0; i < lines; i++) {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('line '),
            $createTextNode(String(i)).toggleFormat('bold'),
            $createTextNode(' end'),
          ),
        );
      }
    },
    {ids: [1, 2]},
  );
  const [a, b] = t.peers;
  const t0 = performance.now();
  a.update(op);
  const ms = performance.now() - t0;
  expect(b.describe()).toBe(a.describe());
  expect(a.warnings).toEqual([]);
  expect(b.warnings).toEqual([]);
  return ms;
}

const $unboldAll = () => {
  $getRoot().select(0, $getRoot().getChildrenSize());
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    // Mixed: the first toggle bolds everything, the second unbolds it, so
    // the three text nodes of every line merge into one.
    selection.formatText('bold');
    selection.formatText('bold');
  }
};

const $joinPairs = () => {
  const kids = $getRoot().getChildren() as ElementNode[];
  for (let i = 0; i + 1 < kids.length; i += 2) {
    kids[i].append(...kids[i + 1].getChildren());
    kids[i + 1].remove();
  }
};

// 2,500 and 10,000 lines by default (the setup dominates: about 3 s here,
// a few times that on a slow CI runner); BULK_SCALE_LINES=5000 runs the
// original 5,000 / 20,000.
const LINES = Number(process.env.BULK_SCALE_LINES ?? 2500);

describe('@lexical/y bulk updates scale linearly', () => {
  for (const [name, op] of [
    ['select all and remove bold (text nodes merge in every line)', $unboldAll],
    ['join every pair of lines in one update', $joinPairs],
  ] as const) {
    test(
      name,
      async () => {
        const small = await timed(LINES, op);
        const big = await timed(LINES * 4, op);
        // Linear is 4x, quadratic 16x (a quadratic writer took 100 s at 20k
        // lines). Generous bounds for shared CI machines.
        expect(big).toBeLessThan((LINES * 4 * 30_000) / 20_000);
        expect(big / Math.max(small, 50)).toBeLessThan(10);
      },
      120_000,
    );
  }
});
