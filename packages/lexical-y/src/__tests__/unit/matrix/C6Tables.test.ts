/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Contract C6 for concurrent table structure edits, enumerated: three peers
// open the same 2x2 table, and each inserts a row, inserts a column, or
// does nothing, at every cell choice, concurrently; messages are then
// delivered in many interleavings (channels keep their order). For every
// binding (`@lexical/y`, `@lexical/yjs` v1 and v2), without and with an app
// repair that pads the short rows each peer created after remote changes:
//
// - the network settles (no update ping-pong) within a bounded number of
//   deliveries, and every peer shows the same table;
// - no cell is duplicated: the table has 2 + (columns inserted) cells in
//   its widest row (with the repair, see `allowed`) and 2 + (rows inserted)
//   rows;
// - with the repair, every row is as wide as the widest (`@lexical/yjs` peers; a
//   `@lexical/y` peer has no node-to-shared-type mapping to tell which rows
//   it created, so the repair does nothing there).
//
// MATRIX_FULL=1 runs 40 interleavings per script (default 6).

import {
  $createTableNodeWithDimensions,
  $insertTableColumnAtSelection,
  $insertTableRowAtSelection,
  $isTableNode,
} from '@lexical/table';
import {$getRoot, $isElementNode} from 'lexical';
import {afterEach, describe, expect, test} from 'vitest';

import {BINDING_KINDS, type BindingKind, CatalogNet, prng} from '../../catalog';

const FULL = process.env.MATRIX_FULL === '1';
const ORDERS = FULL ? 40 : 6;
const LIMIT = 500;

type Edit = 'none' | 'row' | 'column';
const EDITS: Edit[] = ['none', 'row', 'column'];
/** The cell each peer edits at (row, column), varied per script. */
const CELLS: [number, number][] = [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 1],
];

const nets: CatalogNet[] = [];
afterEach(() => {
  for (const n of nets.splice(0)) {
    n.dispose();
  }
});

function $selectCell(row: number, col: number): void {
  const table = $getRoot().getChildren().find($isTableNode)!;
  const r = table.getChildAtIndex(row);
  const cell = $isElementNode(r) ? r.getChildAtIndex(col) : null;
  if (!$isElementNode(cell)) {
    throw new Error('no cell');
  }
  cell.selectStart();
}

function run(
  kind: BindingKind,
  edits: Edit[],
  cells: [number, number][],
  repair: boolean,
  order: number,
): string[] {
  const net = new CatalogNet(kind);
  nets.push(net);
  const peers = ['A', 'B', 'C'].map(n => net.add(n));
  for (const p of peers) {
    p.repair = repair ? 'owner-rows' : 'none';
  }
  const [a] = peers;
  a.update(() => {
    $getRoot()
      .clear()
      .append($createTableNodeWithDimensions(2, 2, false));
  });
  if (a.yBinding !== null) {
    a.yBinding.initialize();
    a.flush();
  }
  const opened = net.settle(LIMIT);
  if (opened.left > 0) {
    return [`opening did not settle: ${JSON.stringify(opened)}`];
  }
  edits.forEach((edit, i) => {
    if (edit === 'none') {
      return;
    }
    peers[i].update(() => {
      $selectCell(...cells[i]);
      if (edit === 'row') {
        $insertTableRowAtSelection(true);
      } else {
        $insertTableColumnAtSelection(true);
      }
    });
  });
  const rand = prng(order + 1);
  const settled = net.settle(LIMIT, length =>
    order === 0 ? 0 : Math.floor(rand() * length),
  );
  const out: string[] = [];
  if (settled.left > 0) {
    out.push(
      `did not settle: ${settled.left} left after ${settled.delivered} deliveries (largest ${settled.maxBytes} bytes)`,
    );
  }
  const shapes = peers.map(p => JSON.stringify(p.tableRows()));
  if (new Set(shapes).size > 1) {
    out.push(`peers differ: ${shapes.join(' | ')}`);
  }
  const columns = edits.filter(e => e === 'column').length;
  const width = 2 + columns;
  const height = 2 + edits.filter(e => e === 'row').length;
  // An owner-gated row repair races a concurrent column insert: the owner
  // pads its new row to the width it sees, and the column insert, which did
  // not know the row, adds no cell to it but its own cell lands in the
  // other rows; the row then gets one cell from each side. That is the
  // app-level repair's race (it matters for the design of an upstream row
  // repair), not a Lexical bug: with the repair off, and with the repair on
  // but no column insert, the same scripts and interleavings settle at the
  // exact width (checked 10/30 on main for the six cells where it shows:
  // yjs-v1 and yjs-v2, row/row/column #3, row/column/row #4,
  // column/column/row #4). So with the repair each column insert may leave
  // one extra cell per row, and no more.
  const allowed = repair && edits.includes('row') ? width + columns : width;
  for (const p of peers) {
    const [rows] = p.tableRows();
    if (rows === undefined) {
      out.push(`${p.name}: no table`);
      continue;
    }
    if (rows.length !== height || Math.max(...rows) > allowed) {
      out.push(
        `${p.name}: rows ${JSON.stringify(rows)}, expected ${height} rows of at most ${allowed} cells`,
      );
    } else if (
      repair &&
      kind !== 'y' &&
      rows.some(r => r !== Math.max(...rows))
    ) {
      out.push(
        `${p.name}: rows ${JSON.stringify(rows)} not padded to one width by the repair`,
      );
    }
    for (const e of p.errors) {
      out.push(`${p.name} error: ${String(e).slice(0, 200)}`);
    }
  }
  return out;
}

const SCRIPTS: {edits: Edit[]; cells: [number, number][]}[] = [];
for (const x of EDITS) {
  for (const y of EDITS) {
    for (const z of EDITS) {
      const edits = [x, y, z];
      if (edits.filter(e => e !== 'none').length < 2) {
        continue;
      }
      // Cells rotate with the script, so every cell is used by every peer.
      const k = SCRIPTS.length;
      SCRIPTS.push({
        cells: [0, 1, 2].map(i => CELLS[(k + i) % CELLS.length]),
        edits,
      });
    }
  }
}

describe('C6: concurrent table structure edits settle without duplicating cells', () => {
  for (const kind of BINDING_KINDS) {
    for (const repair of [false, true]) {
      for (const {edits, cells} of SCRIPTS) {
        for (let order = 0; order < ORDERS; order++) {
          test(`${kind}${repair ? ', owner repair' : ''}: ${edits.join('/')} at ${cells.map(c => c.join(':')).join(' ')}, interleaving ${order}`, () => {
            expect(run(kind, edits, cells, repair, order)).toEqual([]);
          });
        }
      }
    }
  }
});
