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
import {describe, expect, test} from 'vitest';

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

// Random documents (comments on most words, with ids that repeat so that
// one comment has several runs, and formats, styles and links), then one
// peer types inside a word while the other deletes the words around it and
// then text next to them, taking turns or at the same time. No peer throws,
// and every peer and a fresh reader show the same, character by character.
// (Until D86 these sessions also compared each run with one where a delete
// did not collapse the run it left; a delete now never does.)
// DELETE_TYPING_SEEDS (sessions typing and deleting at the same time; a
// third as many taking turns) and DELETE_TYPING_SEED_START run other
// sessions.

const SEEDS = Number(process.env.DELETE_TYPING_SEEDS ?? 60);
const START = Number(process.env.DELETE_TYPING_SEED_START ?? 1);

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

type Session = {views: string[][]; errors: unknown[]};

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
): Promise<Session> {
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
    errors: [...t.a.errors, ...t.b.errors, ...fresh.errors],
    views: [t.a, t.b, fresh].map(p => p.read($view)),
  };
}

describe('@lexical/y a delete next to typing: every peer and a fresh reader agree', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    for (const together of [true, false]) {
      test(`${together ? 'taking turns' : 'typing ‖ deletes'} (ids ${ids})`, async () => {
        const n = together ? Math.ceil(SEEDS / 3) : SEEDS;
        for (let seed = START; seed < START + n; seed++) {
          const {errors, views} = await run(seed, ids, together);
          expect({errors, seed}).toEqual({errors: [], seed});
          expect({seed, view: views[1]}).toEqual({seed, view: views[0]});
          expect({seed, view: views[2]}).toEqual({seed, view: views[0]});
        }
      }, 600_000);
    }
  }
});
