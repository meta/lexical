/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Contract C6 over the binding dimension: three peers bound with
// `@lexical/y`, `@lexical/yjs` v1 or `@lexical/yjs` v2 make concurrent edits
// from the core packages (typing, deleting, formats, marks, paragraphs,
// table rows and columns, list type and start) with partial deliveries in
// between; once every message is delivered, in any order, the network
// settles (no peer keeps answering updates with updates) within a bounded
// number of deliveries, and every peer shows the same document. Also with
// every peer making an empty local update of its own after each remote
// change, as apps' plugins do, and with an app that pads the table rows its
// client created after each remote change. A plugin that runs the table
// transforms over every table after each remote change does not settle
// (#9582, pinned with its repro), so it is not a variant here.
//
// MATRIX_FULL=1 runs 200 seeds per binding (default 24).

import {$getRoot} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {
  $appendShapes,
  BINDING_KINDS,
  type BindingKind,
  CatalogNet,
  CORE_OPS,
  firstDifference,
  NODE_SHAPES,
  prng,
} from '../../catalog';

const FULL = process.env.MATRIX_FULL === '1';
const SEEDS = FULL ? 200 : 24;
const STEPS = 12;
/** Deliveries allowed to settle: every message of the edits and their echoes. */
const LIMIT = 400;

const DOC = [
  'table/list-in-cell',
  'table/merged-cells',
  'list/number-start-5',
  'list/check-nested',
  'paragraph/formatted-first-text',
  'text/normal',
  'mark/text',
  'link/text',
  'quote/text',
  'heading/h2',
].map(name => NODE_SHAPES.find(s => s.name === name)!);

const nets: CatalogNet[] = [];
afterEach(() => {
  for (const n of nets.splice(0)) {
    n.dispose();
  }
});

const elide = (json: unknown) =>
  JSON.parse(JSON.stringify(json), (key, value) =>
    key === 'editorState' && value !== null && typeof value === 'object'
      ? '(nested editor)'
      : value,
  );

type Variant = {
  followUp: 'none' | 'empty';
  repair: 'none' | 'owner-rows';
  /** Only table edits and typing, on a table. */
  tables: boolean;
};

const TABLE_DOC = ['table/list-in-cell', 'text/normal'].map(
  name => NODE_SHAPES.find(s => s.name === name)!,
);
const TABLE_OPS = CORE_OPS.filter(
  op => op.name.startsWith('table-insert') || op.name === 'type',
);

function run(kind: BindingKind, seed: number, variant: Variant): string[] {
  const out: string[] = [];
  const rand = prng(seed);
  const net = new CatalogNet(kind);
  nets.push(net);
  const peers = ['A', 'B', 'C'].map(n => net.add(n));
  for (const p of peers) {
    p.followUp = variant.followUp;
    p.repair = variant.repair;
  }
  const ops = variant.tables ? TABLE_OPS : CORE_OPS;
  const [a] = peers;
  a.update(() => {
    $getRoot().clear();
    $appendShapes(variant.tables ? TABLE_DOC : DOC);
  });
  if (a.yBinding !== null) {
    a.yBinding.initialize();
    a.flush();
  }
  const opened = net.settle(LIMIT);
  if (opened.left > 0) {
    return [`opening did not settle: ${JSON.stringify(opened)}`];
  }

  const done: string[] = [];
  for (let step = 0; step < STEPS; step++) {
    const peer = peers[Math.floor(rand() * peers.length)];
    const op = ops[Math.floor(rand() * ops.length)];
    done.push(`${peer.name}:${op.name}`);
    peer.update(() => {
      op.$run(rand);
    });
    if (rand() < 0.3) {
      const n = Math.floor(rand() * 4);
      for (let i = 0; i < n && net.queue.length > 0; i++) {
        net.deliverAt(Math.floor(rand() * net.queue.length));
      }
    }
  }
  const settled = net.settle(LIMIT, length => Math.floor(rand() * length));
  if (settled.left > 0) {
    out.push(
      `did not settle: ${settled.left} messages left after ${settled.delivered} deliveries (largest ${settled.maxBytes} bytes); ops ${done.join(' ')}`,
    );
    return out;
  }
  const first = elide(peers[0].json());
  for (const p of peers.slice(1)) {
    const d = firstDifference(elide(p.json()), first);
    if (d !== null) {
      out.push(`${p.name} differs from A at ${d}; ops ${done.join(' ')}`);
    }
  }
  for (const p of peers) {
    for (const e of p.errors) {
      out.push(
        `${p.name} error: ${String(e).slice(0, 200)}; ops ${done.join(' ')}`,
      );
    }
    for (const w of p.warnings.filter(x => x.includes('self-check'))) {
      out.push(`${p.name}: ${w.slice(0, 200)}`);
    }
  }
  return out;
}

const VARIANTS: Variant[] = [
  {followUp: 'none', repair: 'none', tables: false},
  {followUp: 'empty', repair: 'none', tables: false},
  {followUp: 'none', repair: 'owner-rows', tables: false},
  {followUp: 'none', repair: 'none', tables: true},
  {followUp: 'none', repair: 'owner-rows', tables: true},
];
const label = (v: Variant) =>
  `${v.tables ? 'table edits' : 'core edits'}, follow-ups ${v.followUp}, repair ${v.repair}`;

describe('C6: concurrent core edits settle and converge, every binding', () => {
  for (const kind of BINDING_KINDS) {
    for (const variant of VARIANTS) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        test(`${kind}, ${label(variant)}, seed ${seed}`, () => {
          expect(run(kind, seed, variant)).toEqual([]);
        });
      }
    }
  }
});
