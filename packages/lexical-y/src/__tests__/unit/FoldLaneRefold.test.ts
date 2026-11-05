/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Property test: a start formats map folded in a lane (see Seen.FoldLane)
// and folded again once its fold point went stale (see Seen.frontierOf)
// equals a fold from scratch in the same lane. Random layout 3 runs (bold
// and italic, some paired, some plain), some of their items deleted and
// kept by a hold, some held back, block boundaries between them; a start
// is folded up to a boundary in each lane, the boundary deleted, and the
// start asked for from an earlier boundary. Env: FL_SEEDS (default 200).

import * as Y from '@y/y';
import {expect, test} from 'vitest';

import {Hidden} from '../../internal/Hidden';
import {stepFormat, withHeldView} from '../../internal/Ident';
import {writeLayout3Formats} from '../../internal/Layout3';
import {type FoldLane, frontierOf, noteFolded} from '../../internal/Seen';
import {currentView, emptyView, seenBy} from '../../internal/Unread';

const SEEDS = Number(process.env.FL_SEEDS ?? 200);

function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    chance: (p: number) => next() < p,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
  };
}

/** A fold of `lane` from scratch, up to and with `to`. */
function foldFresh(
  root: Y.Node,
  to: Y.Item,
  lane: FoldLane,
  hidden: Hidden,
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (let it = root._start; it !== null; it = it.right as Y.Item | null) {
    if (it.content instanceof Y.ContentFormat) {
      const kept = it.deleted && hidden.keeps(it);
      const counts =
        lane === 'raw'
          ? !it.deleted
          : lane === 'stored'
            ? !it.deleted
            : (!it.deleted || kept) && !hidden.hides(it);
      if (counts) {
        if (lane === 'shown') {
          withHeldView(hidden, () => stepFormat(out, it));
        } else {
          stepFormat(out, it);
        }
      }
    }
    if (it === to) {
      break;
    }
  }
  return out;
}

const show = (m: Map<string, unknown>) =>
  JSON.stringify([...m].filter(([k]) => !k.startsWith('\u0002')).sort());

for (let seed = 1; seed <= SEEDS; seed++) {
  test(`a start folded again in its lane equals a fold from scratch (seed ${seed})`, () => {
    const r = rng(seed);
    const doc = new Y.Doc({gc: r.chance(0.5)});
    const root = doc.get('lexical-y');
    root.setAttr('lexical-y:3', true);
    const n = r.int(6, 14);
    root.insert(0, 'abcdefghijklmnop'.slice(0, n));
    // Block boundaries (stored nodes) at random places.
    const boundaries: Y.Node[] = [];
    for (let k = r.int(2, 4); k > 0; k--) {
      const node = new Y.Node('\u00b6');
      root.insert(r.int(0, (root as unknown as {length: number}).length), [
        node,
      ]);
      boundaries.push(node);
    }
    const len = (root as unknown as {length: number}).length;
    const values: Map<string, unknown>[] = [];
    let bold = false;
    let italic = false;
    for (let i = 0; i < len; i++) {
      if (r.chance(0.3)) {
        bold = !bold;
      }
      if (r.chance(0.2)) {
        italic = !italic;
      }
      const m = new Map<string, unknown>();
      if (bold) {
        m.set('f:bold', true);
      }
      if (italic) {
        m.set('f:italic', true);
      }
      values.push(m);
    }
    doc.transact(tr => writeLayout3Formats(tr, root, values));
    const formats: Y.Item[] = [];
    for (let it = root._start; it !== null; it = it.right as Y.Item | null) {
      if (!it.deleted && it.content instanceof Y.ContentFormat) {
        formats.push(it);
      }
    }
    // Kept deletions and held items.
    const hidden = new Hidden('line');
    doc.transact(tr => {
      for (const it of formats) {
        if (r.chance(0.25)) {
          hidden.keep(it);
          it.delete(tr);
        }
      }
    });
    for (const it of formats) {
      if (!it.deleted && r.chance(0.2)) {
        hidden.add(it.id.client, it.id.clock, it.length);
      }
    }
    const items = boundaries
      .map(b => b._item!)
      .sort((x, y) => (reaches(x, y) ? -1 : 1));
    const to = items[items.length - 1];
    const left = items.length > 1 ? items[r.int(0, items.length - 2)] : null;
    const view = emptyView(root, it => hidden.keeps(it));
    seenBy(
      () => view,
      () => {
        for (const lane of ['raw', 'stored', 'shown'] as FoldLane[]) {
          const start = foldFresh(root, to, lane, hidden);
          noteFolded(start, to, lane, hidden);
          const copy = new Map(start);
          noteFolded(copy, to, lane, hidden);
          // The fold point goes stale: deleted.
          doc.transact(tr => {
            if (!to.deleted) {
              to.delete(tr);
            }
          });
          const frontier = frontierOf(currentView(), copy, left, root, null);
          expect(frontier).toBeNull();
          const fresh =
            left === null ? new Map() : foldFresh(root, left, lane, hidden);
          expect(`${lane} ${show(copy)}`).toBe(`${lane} ${show(fresh)}`);
        }
      },
    );
    hidden.releaseKeeps();
    doc.destroy();
  });
}

/** Whether item `a` comes before item `b` in their list. */
function reaches(a: Y.Item, b: Y.Item): boolean {
  for (let it: Y.Item | null = a; it !== null; it = it.right as Y.Item | null) {
    if (it === b) {
      return true;
    }
  }
  return false;
}
