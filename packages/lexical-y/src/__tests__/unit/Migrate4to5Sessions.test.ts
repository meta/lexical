/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The frozen step @lexical/y/migrate/4to5 on layout 4 rooms that two-peer
// sessions and documents written apart from the step's own fixtures left
// (../golden/migrate-4to5-sessions-r1.json), each written by main a33a6fd3f
// plus the regression tests of the layout 5 pull request's base, with that
// release's fresh read beside it (a SHA-256 of its editor JSON, keys
// sorted, and its block ids), each input's bytes once in a table by SHA-256
// (inputs of the same bytes and configuration are listed once, the others
// as `aliases`):
// - `static/*`: quotes that hold paragraphs at the root's edges, side by
//   side, as an only child, in a box, a collapsible, a list item, a table
//   cell and a component's body slot, holding a quote that is not a shadow
//   root, a nested mix, only empty paragraphs, block decorators, rich
//   inline content, NodeState on blocks and on text across a line break;
//   block ids off, on, and on one block only (`static/mixed/*`);
// - `random/*`: seeded random sessions of two peers editing such quotes
//   offline, then syncing (splits, joins, moves into and out of a quote,
//   formats, links, NodeState on text, indents), gc off and on: the 49 of
//   1,600 the step's first revision read differently;
// - `dup/*`: paragraphs two peers moved into one quote, a move beside an
//   Enter, a paragraph moved out and back: blocks whose stored id repeats an
//   earlier block's, which readers show with an id derived from their item;
// - `extra/*`: quotes in named slots (a component's body and title, a pull
//   quote's two slots, a card's title and its children) and two peers'
//   edits there, more repeated stored ids, and line classes that are shadow
//   roots by class or by a NodeState that is not flat (../utils/
//   shadowLineClasses: the step leaves them as lines);
// - `custom/*`: those line classes, seeded;
// - `rereview/*`: rooms outside writers or races leave: a quote's marker
//   carrying a list item's group keys (`g`), a quote's `shadowRoot` false,
//   deleted or `'true'` while it holds paragraphs, a quote of text whose
//   marker says `shadowRoot`, stored ids repeated across slots, nesting and
//   a quote and its child, a stored id equal to another block's derived id;
//   and races of `shadowRoot` off with Enter or typing, bold over part of a
//   long run with typing, a set-valued NodeState change with a split;
// - `nested-ids/*`: a list whose second item holds a nested list, in such a
//   quote, in a quote in it, in a table cell in it, in a box in it, a flat
//   list in a quote in it, a table or a quote in a list item in it, and
//   controls outside quotes; block ids off and on, written without them and
//   edited by a client with them (`mixed`), and with stored ids two peers'
//   moves repeat (`dup`): the list item holding a nested list has no marker
//   where lists are group lines, and readers derive its id from the nested
//   list's first line (`_w`);
// - `rereview3/*`: one peer wraps a quote's paragraph in a quote that holds
//   paragraphs while another turns it into a list item and indents it;
// - `review4/*`: a collapsible in such a quote (its title holds text but
//   declares no `children`, so readers give it no id) and a random session
//   that left a quote of text stored as a node in a slot's quote (readers
//   identify it), as written, mixed, repeated and with stored ids of a
//   derived id's shape (one equal to the title's own derived id).
// Each migrates (with its own gc) to its frozen bytes and reads exactly as
// the layout 4 release read it, every block's id included. Known limit
// (`limit`): an inline decorator a concurrent edit left alone between two
// blocks of such a quote (layout 4 showed it in a paragraph of its own) is
// migrated as a block of its own.

import * as Y from '@y/y';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {migrateYState} from '../../migrate';
import step4to5 from '../../migrate/4to5';
import {blockIdsOf} from '../utils/blockIdsOf';
import {canonicalJSON, sha256} from '../utils/digest';
import {freshReader, NODES, type Peer} from '../utils/harness';
import {SHADOW_LINE_NODES} from '../utils/shadowLineClasses';
import {SLOT_NODES} from '../utils/slots';

type Input = {
  name: string;
  nodes: 'harness' | 'slots' | 'shadow-lines';
  withBlockIds: boolean;
  gc: boolean;
  /** `sha256:` and the SHA-256 of its bytes, a key of `states`. */
  state: string;
  read: string;
  /** Every block's id in that read, in order, `-` for none (see blockIdsOf). */
  blockIds: string;
  limit?: 'inline-decorator-alone';
  /** Other inputs of the same bytes and configuration (not repeated). */
  aliases?: string[];
};

const GOLDEN = path.join(__dirname, 'golden', 'migrate-4to5-sessions-r1.json');
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as {
  inputs: Input[];
  outputs: Record<string, string>;
  /** Each input's bytes once, base64, by SHA-256. */
  states: Record<string, string>;
};

const NODE_SETS = {
  harness: NODES,
  'shadow-lines': SHADOW_LINE_NODES,
  slots: SLOT_NODES,
};
const stateOf = (f: Input) =>
  new Uint8Array(Buffer.from(golden.states[f.state.slice(7)], 'base64'));
const idsOf = (read: unknown) =>
  blockIdsOf(read)
    .map(line => line.slice(line.lastIndexOf(' ') + 1))
    .join(' ');
const keyOf = (f: Input) =>
  `${f.name}/${f.withBlockIds ? 'ids' : 'no-ids'}/${f.gc ? 'gc-on' : 'gc-off'}`;

/** Whether the root of `state` holds a line whose marker is such a quote. */
function holdsShadowLine(state: Uint8Array): boolean {
  const doc = new Y.Doc({gc: false});
  Y.applyUpdate(doc, state);
  return step4to5.checkAfter(doc.get('lexical-y') as Y.Node).length > 0;
}

async function readAfter(f: Input, state: Uint8Array): Promise<unknown> {
  const doc = new Y.Doc({gc: false});
  Y.applyUpdate(doc, state);
  const fresh = await freshReader({
    doc,
    gc: f.gc,
    nodes: NODE_SETS[f.nodes],
    prepare: undefined,
    withBlockIds: f.withBlockIds,
  } as unknown as Peer);
  expect(fresh.errors).toEqual([]);
  return fresh.json();
}

describe('@lexical/y/migrate/4to5 on sessions', () => {
  test('the inputs: every group, slots, repeated ids, class-level shadow roots', () => {
    const count = (prefix: string, shadow?: boolean) =>
      golden.inputs.filter(
        f =>
          f.name.startsWith(prefix) &&
          (shadow === undefined || holdsShadowLine(stateOf(f)) === shadow),
      ).length;
    expect(golden.inputs.length).toBe(360);
    expect(new Set(golden.inputs.map(keyOf)).size).toBe(360);
    expect(golden.inputs.flatMap(f => f.aliases ?? []).length).toBe(12);
    for (const f of golden.inputs) {
      expect(sha256(stateOf(f))).toBe(f.state.slice(7));
    }
    expect(count('static/', true)).toBe(96);
    expect(count('random/', true)).toBe(49);
    expect(count('rereview/')).toBe(46);
    expect(count('rereview3/', true)).toBe(12);
    expect(count('nested-ids/', true)).toBe(70);
    expect(count('review4/', true)).toBe(21);
    expect(count('rereview/craft/quote-with-g', true)).toBe(4);
    expect(count('dup/', true)).toBe(14);
    expect(count('custom/', false)).toBe(4);
    expect(count('extra/', true)).toBe(40);
    expect(count('extra/static/class/', false)).toBe(2);
    expect(count('extra/race/class/', false)).toBe(4);
    // Quotes in named slots, block ids off, on and mixed.
    expect(
      golden.inputs.filter(
        f =>
          f.nodes === 'slots' && f.withBlockIds && holdsShadowLine(stateOf(f)),
      ).length,
    ).toBeGreaterThan(20);
    // Blocks whose stored id repeats an earlier block's show a derived id.
    expect(
      golden.inputs.filter(f =>
        f.blockIds.split(' ').some(id => /^y[0-9a-z]+_/.test(id)),
      ).length,
    ).toBeGreaterThan(40);
    expect(golden.inputs.filter(f => f.limit !== undefined).length).toBe(8);
  });

  for (const f of golden.inputs) {
    const run = f.limit === undefined ? test : test.fails;
    run(
      `${keyOf(f)}: frozen bytes, the layout 4 read and every block id${f.limit === undefined ? '' : ' (limit: an inline decorator alone between two blocks of the quote becomes a block)'}`,
      async () => {
        const result = migrateYState(stateOf(f), [step4to5], {gc: f.gc});
        expect(`sha256:${sha256(result.state)}`).toBe(golden.outputs[keyOf(f)]);
        expect(holdsShadowLine(result.state)).toBe(false);
        const after = await readAfter(f, result.state);
        expect(idsOf(after)).toBe(f.blockIds);
        expect(`sha256:${sha256(canonicalJSON(after))}`).toBe(f.read);
        const again = migrateYState(result.state, [step4to5], {gc: f.gc});
        expect(again.receipt.changed).toBe(false);
      },
    );
  }
});
