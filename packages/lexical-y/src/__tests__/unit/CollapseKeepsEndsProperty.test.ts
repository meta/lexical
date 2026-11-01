/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$isLinkNode, $toggleLink} from '@lexical/link';
import {$addMarkID, $getNodeMarkIDs, $removeMarkID} from '@lexical/mark';
import {$patchStyleText} from '@lexical/selection';
import {
  $createTextNode,
  $getRoot,
  $isElementNode,
  $setSelection,
  type TextNode,
} from 'lexical';
import {describe, expect, test, vi} from 'vitest';

import {Cursor} from '../../internal/Cursor';
import {mulberry32} from '../utils/fuzz';
import {
  $block,
  $p,
  $selectIn,
  freshReader,
  type Peer,
  setup,
} from '../utils/harness';
import {prepareMarkState as prepare} from '../utils/sizeOps';

// A delete collapses the format items of the run of deleted content it
// leaves (Cursor#collapseGap). On main the concurrent case fails
// (test.fails, #9609): the collapse deletes the end a typist's restore
// relies on. #9617 (parked) kept it.
// Property: the collapse never changes what anyone shows. Random documents
// (comments on most words, with ids that repeat so that one comment has
// several runs, and formats, styles and links), then one peer types inside a
// word while the other deletes the words around it and then text next to
// them. Every peer and a fresh reader are compared, character by character,
// with the same session run with no collapse at all, and no peer writes
// more items for it:
// - taking turns (each peer sees every edit before the next), everything
//   shows the same;
// - typing and deleting at the same time, every character of the document's
//   own text shows the same (the typed text may take the value of other
//   content deleted in a collapsed run: "what the bound gives up" in
//   collapseGap). Before the collapse kept ends, 33 of the first 1,000 such
//   sessions failed in each client id order (the first is seed 53: a comment
//   whose end went ran on over the following words).
// KEEP_ENDS_SEEDS (sessions typing and deleting at the same time; a third as
// many taking turns) and KEEP_ENDS_SEED_START run other sessions.

const SEEDS = Number(process.env.KEEP_ENDS_SEEDS ?? 60);
const START = Number(process.env.KEEP_ENDS_SEED_START ?? 1);

const WORDS = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh'];
const IDS = ['c0', 'c1', 'c2', 'c3'];

/** Each character of every line, with its format, style, comments and link. */
function $view(): string[] {
  const out: string[] = [];
  for (const block of $getRoot().getChildren()) {
    if ($isElementNode(block)) {
      for (const node of block.getAllTextNodes() as TextNode[]) {
        const parent = node.getParent();
        const sig = [
          node.getFormat(),
          node.getStyle(),
          [...$getNodeMarkIDs(node)].sort().join('+'),
          $isLinkNode(parent) ? parent.getURL() : '',
        ].join('/');
        for (const ch of node.getTextContent()) {
          out.push(`${ch}${sig}`);
        }
      }
    }
    out.push('|');
  }
  return out;
}

type Rand = () => number;
const pick = <T>(rand: Rand, xs: readonly T[]): T =>
  xs[Math.floor(rand() * xs.length)];
const int = (rand: Rand, n: number) => Math.floor(rand() * n);

/** The text size of `peer`'s line `line`. */
const size = (peer: Peer, line: number) =>
  peer.read(() => $block([line]).getTextContentSize());

/** A range of at least one character of `peer`'s line `line`, or null. */
function range(rand: Rand, peer: Peer, line: number): [number, number] | null {
  const n = size(peer, line);
  if (n === 0) {
    return null;
  }
  const from = int(rand, n);
  return [from, Math.min(n, from + 1 + int(rand, 6))];
}

/** A format change, comment or link over a random range of `peer`. */
function formatOp(rand: Rand, peer: Peer, line: number) {
  const r = range(rand, peer, line);
  if (r === null) {
    return;
  }
  const kind = int(rand, 7);
  peer.update(() => {
    const selection = $selectIn([line], r[0], r[1]);
    if (kind <= 2) {
      const id = pick(rand, IDS);
      if (kind === 2) {
        $removeMarkID(id, selection);
      } else {
        $addMarkID(id, selection);
      }
    } else if (kind === 3) {
      selection.formatText(pick(rand, ['bold', 'italic'] as const));
    } else if (kind === 4) {
      $patchStyleText(selection, {color: pick(rand, ['red', 'blue', null])});
    } else {
      $toggleLink(kind === 5 ? 'https://a.test' : 'https://b.test');
    }
    $setSelection(null);
  });
}

/**
 * Typed text: upper-case letters, either inheriting what is around (the
 * selection's insertText) or as a text node of its own with nothing (a
 * restore of everything after it).
 */
function typeOp(rand: Rand, peer: Peer, line: number, word?: [number, number]) {
  const n = size(peer, line);
  const off =
    word !== undefined && word[1] - word[0] > 1
      ? word[0] + 1 + int(rand, word[1] - word[0] - 1)
      : int(rand, n + 1);
  const text = pick(rand, ['X', 'YZ', 'Q']);
  const plain = rand() < 0.6;
  peer.update(() => {
    if (plain && off > 0 && off < n) {
      let o = off;
      for (const node of $block([line]).getAllTextNodes() as TextNode[]) {
        if (o > 0 && o < node.getTextContentSize()) {
          const [, tail] = node.splitText(o);
          tail.insertBefore($createTextNode(text));
          break;
        }
        if (o === node.getTextContentSize()) {
          node.insertAfter($createTextNode(text));
          break;
        }
        o -= node.getTextContentSize();
      }
    } else {
      $selectIn([line], off).insertText(text);
    }
    $setSelection(null);
  });
}

type Session = {views: string[][]; errors: unknown[]; clocks: number[]};

/** The word spans of `peer`'s line `line`. */
function wordSpans(peer: Peer, line: number): [number, number][] {
  const text = peer.read(() => $block([line]).getTextContent());
  const spans: [number, number][] = [];
  for (const m of text.matchAll(/\S+/g)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

async function run(
  seed: number,
  ids: number[],
  together: boolean,
  collapse: boolean,
): Promise<Session> {
  const spy = collapse
    ? null
    : vi
        .spyOn(
          Cursor.prototype as unknown as {collapseGap: () => void},
          'collapseGap',
        )
        .mockImplementation(() => {});
  try {
    const rand = mulberry32(seed);
    const line = () =>
      Array.from({length: 6 + int(rand, 4)}, () => pick(rand, WORDS)).join(' ');
    const lines = [line(), line()];
    const t = await setup(() => $getRoot().append(...lines.map($p)), {
      ids,
      prepare,
    });
    // The document's history, taking turns: most words get a comment (ids
    // repeat, so a comment can have several runs), and a few other format
    // changes, comments, links and removals over random ranges.
    for (let l = 0; l < 2; l++) {
      for (const [from, to] of wordSpans(t.a, l)) {
        if (rand() < 0.7) {
          const id = pick(rand, IDS);
          pick(rand, [t.a, t.b]).update(() => {
            $addMarkID(id, $selectIn([l], from, to));
            $setSelection(null);
          });
        }
      }
    }
    for (let i = 0, n = 1 + int(rand, 5); i < n; i++) {
      formatOp(rand, pick(rand, [t.a, t.b]), int(rand, 2));
    }
    await t.sync();
    if (!together) {
      t.offline();
    }
    // A types inside a word (or changes a format there) while B deletes
    // the words around it and then, in later deletes, next to them.
    const where = int(rand, 2);
    const spans = wordSpans(t.b, where);
    const target = pick(rand, spans);
    for (let i = 0, n = 1 + int(rand, 2); i < n; i++) {
      if (rand() < 0.85) {
        typeOp(rand, t.a, where, target);
      } else {
        formatOp(rand, t.a, where);
      }
      if (together) {
        await t.sync();
      }
    }
    // B's words (with A's text in them when B has seen it).
    const seen = wordSpans(t.b, where);
    const k = Math.min(spans.indexOf(target), seen.length - 1);
    let first = seen[Math.max(0, k - int(rand, 3))][0];
    const last = seen[Math.min(seen.length - 1, k + int(rand, 3))][1];
    t.b.update(() => {
      $selectIn([where], first, last).removeText();
      $setSelection(null);
    });
    if (together) {
      await t.sync();
    }
    for (let i = 0, n = 1 + int(rand, 3); i < n; i++) {
      const lineSize = size(t.b, where);
      const len = 1 + int(rand, 4);
      first = Math.min(first, lineSize);
      // Right after the deleted words, or right before them.
      const [from, to] =
        rand() < 0.6
          ? [first, Math.min(lineSize, first + len)]
          : [Math.max(0, first - len), first];
      if (from < to) {
        t.b.update(() => {
          $selectIn([where], from, to).removeText();
          $setSelection(null);
        });
        first = from;
      }
      if (together) {
        await t.sync();
      }
    }
    await t.sync();
    const fresh = await freshReader(t.a);
    return {
      clocks: [t.a, t.b].map(p => p.doc.store.getClock(p.doc.clientID)),
      errors: [...t.a.errors, ...t.b.errors, ...fresh.errors],
      views: [t.a, t.b, fresh].map(p => p.read($view)),
    };
  } finally {
    spy?.mockRestore();
  }
}

// Seeds (of the default range) where main's collapse lets a comment spread
// over the document's own text when typing and deleting at the same time.
const MAIN_SPREADS = new Set([53]);

/** The document's own text: the typist's capitals stand for themselves. */
const own = (v: string[]) =>
  v.map(c => (/[A-Z]/.test(c.charAt(0)) ? c.charAt(0) : c));

/**
 * A session typing and deleting at the same time, with and without the
 * collapse, and the checks that hold whatever the collapse keeps: no
 * errors, no more writes, the same characters, every peer and a fresh
 * reader agreeing.
 */
async function concurrent(
  seed: number,
  ids: number[],
): Promise<[Session, Session]> {
  const kept = await run(seed, ids, false, true);
  const none = await run(seed, ids, false, false);
  expect(kept.errors).toEqual([]);
  expect({clocks: kept.clocks, seed}).toEqual({clocks: none.clocks, seed});
  const chars = (views: string[][]) =>
    views.map(v => v.map(c => c.charAt(0)).join(''));
  expect(chars(kept.views)).toEqual(chars(none.views));
  expect(kept.views[1]).toEqual(kept.views[0]);
  expect(kept.views[2]).toEqual(kept.views[0]);
  return [kept, none];
}

describe('@lexical/y a delete collapsing a run never changes what anyone shows', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test(`taking turns: every character shows as with no collapse (ids ${ids})`, async () => {
      for (let seed = START; seed < START + Math.ceil(SEEDS / 3); seed++) {
        const kept = await run(seed, ids, true, true);
        const none = await run(seed, ids, true, false);
        expect(kept.errors).toEqual([]);
        expect({seed, views: kept.views}).toEqual({seed, views: none.views});
        // No peer writes more for it.
        expect({clocks: kept.clocks, seed}).toEqual({
          clocks: none.clocks,
          seed,
        });
      }
    }, 600_000);

    test(`typing ‖ deletes: the document's own text shows as with no collapse (ids ${ids})`, async () => {
      for (let seed = START; seed < START + SEEDS; seed++) {
        const [kept, none] = await concurrent(seed, ids);
        if (!MAIN_SPREADS.has(seed)) {
          expect({seed, view: own(kept.views[0])}).toEqual({
            seed,
            view: own(none.views[0]),
          });
        }
      }
    }, 600_000);

    // The sessions where main's collapse deletes the end a typist's restore
    // relies on, so a comment spreads over the document's own text (#9609):
    // everything else holds there, and the own text fails until a fix.
    for (const seed of MAIN_SPREADS) {
      if (seed < START || seed >= START + SEEDS) {
        continue;
      }
      test.fails(
        `typing ‖ deletes, seed ${seed}: the document's own text shows as with no collapse (ids ${ids}, #9609)`,
        async () => {
          const [kept, none] = await concurrent(seed, ids);
          expect({seed, view: own(kept.views[0])}).toEqual({
            seed,
            view: own(none.views[0]),
          });
        },
        600_000,
      );
    }
  }
});
