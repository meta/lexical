/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The frozen step @lexical/y/migrate/4to5 on its golden fixtures. Every
// input is layout 4 bytes with the layout 4 release's own read beside it,
// written by main a33a6fd3f (the last release whose floor was 4) with the
// catalog of that commit plus the shapes the layout 5 pull request adds
// (`quote/shadow-root`, `quote/shadow-root-nested`, and
// `downstream/component-slots-quote`, such a quote in a named slot):
// - `catalog/<blockIds>/<shape>`: every node shape of the catalog alone,
//   seeded headless, with BlockIdExtension absent and enabled; read as a
//   `$snapshot` (editor JSON, derived fields, list numbering);
// - `harness/<ids>/<gc>/<scenario>`: bound peers, with and without block
//   ids, gc off and on: a paragraph moved into (or replaced by) a quote that
//   holds paragraphs while a peer types in it (text a read shows as a
//   paragraph of its own in the quote, with a derived id), a split in such
//   a quote while a peer types after the caret, and quotes that hold a
//   heading, formatted text with a link, a list, a block decorator and an
//   empty paragraph, beside a quote of text and inside a table cell; read
//   as a fresh reader's editor JSON;
// - `harness/<ids>/<gc>/text-state/<doc>[/edited]`: NodeState on text (a
//   flat value and a set of ids on the same text, as an extension that
//   anchors comments stores them; ../utils/textStateQuote) inside one of a
//   quote's paragraphs, across both, and from a root paragraph into the
//   quote; seeded, and edited by two peers typing into the stated text of
//   both paragraphs at once. Their read holds every character's NodeState;
// - `harness/<ids>/<gc>/nested/<doc>`: quotes that hold paragraphs inside
//   such quotes, two and three levels deep, with a list, a table (a list in
//   a cell), a heading and a block decorator among their blocks, ids off
//   and on;
// - `harness/ids/<gc>/mixed-ids/<doc>`: the same documents written without
//   BlockIdExtension, then the first root paragraph edited by a client with
//   it, so that only that paragraph stores a block id and every other block
//   shows the id readers derive from the document;
// - `harness/<ids>/gc-off/quote-and-list-item/<order>`: one peer wraps a
//   paragraph in a quote that holds paragraphs while another turns the
//   same paragraph into a list item, in the client orders that leave the
//   quote's marker with the list item's group keys (`g`, `g:listType`,
//   `l`): readers show a quote, so the step converts it (see
//   regressions/QuoteMarkerWithGroupKeyAfter4to5.test.ts);
// - `harness/ids/<gc>/nested-lists/<ids>/<place>`: a list whose second item
//   holds a nested list, in such a quote (stored there as a node), in a
//   quote in it, in a table cell in it and in a box in it (stored there as
//   group lines, where the item holding the nested list has no marker and
//   readers derive its id from the nested list's first line, `_w`), written
//   without block ids and then edited by a client with them (`mixed`), or
//   with block ids that two peers' moves repeat (`repeated`);
// - `harness/<ids>/<gc>/n1/<ids>/box-of-text`: an element whose class
//   declares no `children` (a box of text, stored as a node of inline
//   content, `c` = 'i') alone between two paragraphs of such a quote: a
//   block of its own, as readers show it (not a paragraph around it);
// - `harness/ids/<gc>/n4/<ids>/widget-in-nested-quote-s-flag`: a quote in
//   such a quote whose flag is stored as `s:shadowRoot` (not `p:`), which
//   readers still take for a shadow root (it gets no block id).
// Every block's id, stored or derived, is compared block by block.
// Gc off and on: each migrates to its frozen bytes; reads exactly as the
// layout 4 release read it (block ids included); a root without a quote
// that holds paragraphs gets only its layout record and epoch; and the
// migrated root holds no such line (the runner's checks pass, and the step's
// checkAfter does not on the input). A migrated state migrates no further.
// Golden outputs are written once (MIGRATE_GOLDEN_WRITE=1 when a fixture has
// none) and never regenerated; the frozen sources are pinned by hash. A few
// inputs keep their whole read and output bytes; the others keep SHA-256
// digests of them (of the read's JSON with sorted keys, of the bytes) and
// their block ids.

import * as Y from '@y/y';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {readYState} from '../../headless';
import {migrateYState} from '../../migrate';
import step4to5 from '../../migrate/4to5';
import {$snapshot, catalogHeadlessConfig} from '../catalog/bind';
import {blockIdsOf} from '../utils/blockIdsOf';
import {canonicalJSON, sha256} from '../utils/digest';
import {freshReader, NODES, type Peer} from '../utils/harness';
import {TEXT_STATE_DOCS} from '../utils/textStateQuote';

/**
 * `sha256:` and a SHA-256 in hex, where the fixture keeps a digest instead
 * of the whole value.
 */
type Digest = `sha256:${string}`;

type Input = {
  kind: 'catalog' | 'harness';
  name: string;
  /** `sha256:` and the SHA-256 of its bytes, a key of `states`. */
  state: string;
  /** Other inputs of the same bytes and configuration (not repeated). */
  aliases?: string[];
  /** The layout 4 read, or its digest (of its JSON). */
  read: unknown;
  /** Every block's type and id in that read (see blockIdsOf). */
  blockIdList?: string[];
  blockIds?: 'absent' | 'enabled';
  gc?: boolean;
  withBlockIds?: boolean;
};

const GOLDEN = path.join(__dirname, 'golden', 'migrate-4to5-r1.json');
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as {
  inputs: Input[];
  outputs: Record<string, {gcOff: string; gcOn: string}>;
  /** Each input's bytes once, base64, by SHA-256. */
  states: Record<string, string>;
};
const WRITE = process.env.MIGRATE_GOLDEN_WRITE === '1';

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const isDigest = (v: unknown): v is Digest =>
  typeof v === 'string' && v.startsWith('sha256:');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
/** An input's bytes (from the table, or inline for one not yet added). */
const stateOf = (f: Input) =>
  unb64(isDigest(f.state) ? golden.states[f.state.slice(7)] : f.state);

const keyOf = (f: Input) =>
  f.kind === 'catalog'
    ? `catalog/${f.blockIds}/${f.name}`
    : `harness/${f.withBlockIds ? 'ids' : 'no-ids'}/${f.gc ? 'gc-on' : 'gc-off'}/${f.name}`;

const migrate = (f: Input, gc: boolean) =>
  migrateYState(stateOf(f), [step4to5], {gc});

/** Whether the root of `state` holds a line whose marker is a shadow root. */
function holdsShadowLine(state: Uint8Array): boolean {
  const doc = new Y.Doc({gc: false});
  Y.applyUpdate(doc, state);
  return step4to5.checkAfter(doc.get('lexical-y') as Y.Node).length > 0;
}

async function readAfter(f: Input, state: Uint8Array): Promise<unknown> {
  if (f.kind === 'catalog') {
    return readYState(
      state,
      catalogHeadlessConfig({blockIds: f.blockIds!}),
      () => $snapshot(),
    );
  }
  const doc = new Y.Doc({gc: false});
  Y.applyUpdate(doc, state);
  const from = {
    doc,
    gc: f.gc,
    nodes: NODES,
    prepare: undefined,
    withBlockIds: f.withBlockIds,
  } as unknown as Peer;
  const fresh = await freshReader(from);
  expect(fresh.errors).toEqual([]);
  return fresh.json();
}

if (WRITE) {
  for (const f of golden.inputs) {
    const key = keyOf(f);
    if (golden.outputs[key] === undefined) {
      golden.outputs[key] = {
        gcOff: b64(migrate(f, false).state),
        gcOn: b64(migrate(f, true).state),
      };
    }
  }
  // Inputs added with their bytes inline go to the table.
  for (const f of golden.inputs) {
    if (!isDigest(f.state)) {
      const hash = createHash('sha256').update(unb64(f.state)).digest('hex');
      golden.states[hash] = f.state;
      f.state = `sha256:${hash}`;
    }
  }
  // Then `prettier --write` the file, and pin the new digest below.
  fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n');
}

describe('@lexical/y/migrate/4to5 golden fixtures', () => {
  test('the inputs: every catalog shape (block ids absent and enabled), the race and block scenarios, NodeState on text', () => {
    const catalog = golden.inputs.filter(f => f.kind === 'catalog');
    expect(catalog.length).toBe(2 * new Set(catalog.map(f => f.name)).size);
    expect(catalog.map(f => f.name)).toContain('quote/shadow-root');
    expect([
      ...new Set(
        golden.inputs
          .filter(f => f.kind === 'harness')
          .flatMap(f => [f.name, ...(f.aliases ?? [])]),
      ),
    ]).toEqual([
      'moved-into-quote-while-typing',
      'replaced-by-quote-while-typing',
      'split-while-typing',
      'blocks-in-quotes',
      ...TEXT_STATE_DOCS.flatMap(d => [
        `text-state/${d.name}`,
        `text-state/${d.name}/edited`,
      ]),
      'nested/nested-2',
      'mixed-ids/nested-2',
      'nested/nested-3-with-list-and-table',
      'mixed-ids/nested-3-with-list-and-table',
      'nested/blocks-mixed',
      'mixed-ids/blocks-mixed',
      'quote-and-list-item/12-swapped',
      'quote-and-list-item/21',
      'nested-lists/mixed/list-in-quote',
      'nested-lists/mixed/quote-in-quote',
      'nested-lists/repeated/quote-in-quote',
      'nested-lists/mixed/cell-in-quote',
      'nested-lists/mixed/box-in-quote',
      'n1/static/box-of-text',
      'n1/mixed/box-of-text',
      'n1/repeated/box-of-text',
      'n4/static/widget-in-nested-quote-s-flag',
      'n4/mixed/widget-in-nested-quote-s-flag',
    ]);
    // Inputs that hold a quote with paragraphs: the step has work there.
    const shadow = golden.inputs.filter(f => holdsShadowLine(stateOf(f)));
    expect(shadow.map(keyOf)).toContain('catalog/absent/quote/shadow-root');
    expect(shadow.length).toBe(6 + 16 + 24 + 18 + 4 + 10 - 3 + 12);
    expect(golden.inputs.flatMap(f => f.aliases ?? []).length).toBe(3);
    for (const f of golden.inputs) {
      expect(isDigest(f.state)).toBe(true);
      expect(createHash('sha256').update(stateOf(f)).digest('hex')).toBe(
        f.state.slice(7),
      );
    }
  });

  for (const f of golden.inputs) {
    for (const gc of [false, true]) {
      test(`${keyOf(f)}, gc ${gc ? 'on' : 'off'}: frozen bytes, the layout 4 read, the record only where there is no such quote`, async () => {
        const result = migrate(f, gc);
        const out = golden.outputs[keyOf(f)];
        expect(out).toBeDefined();
        const bytes = gc ? out.gcOn : out.gcOff;
        if (isDigest(bytes)) {
          expect(`sha256:${sha256(result.state)}`).toBe(bytes);
        } else {
          expect(b64(result.state)).toBe(bytes);
        }
        const after = await readAfter(f, result.state);
        // Every block's id, stored or derived, before and after (also part of
        // the whole read below, here block by block for the message).
        expect(blockIdsOf(after)).toEqual(f.blockIdList ?? blockIdsOf(f.read));
        if (isDigest(f.read)) {
          expect(`sha256:${sha256(canonicalJSON(after))}`).toBe(f.read);
        } else {
          expect(after).toEqual(f.read);
        }
        expect(holdsShadowLine(result.state)).toBe(false);
        const [root] = result.receipt.roots;
        expect(root.to).toBe(5);
        const [step] = root.steps;
        if (!holdsShadowLine(stateOf(f))) {
          // The layout record and the epoch, nothing else.
          expect(step.written).toBe(2);
        } else {
          expect(step.written).toBeGreaterThan(2);
          expect(step.deleted).toBeGreaterThan(0);
        }
        // Once migrated, nothing is left to do.
        const again = migrateYState(result.state, [step4to5], {gc});
        expect(again.receipt.changed).toBe(false);
        expect(b64(again.state)).toBe(b64(result.state));
      });
    }
  }

  test('the frozen sources and fixtures are unchanged (a change is a new revision)', () => {
    const dir = path.join(__dirname, '..', '..', 'migrate');
    const files = [
      '4to5.ts',
      '4to5/frozen/layout4.ts',
      '4to5/frozen/restructure.ts',
    ];
    const hash = createHash('sha256');
    for (const file of files) {
      hash.update(file + '\0' + fs.readFileSync(path.join(dir, file), 'utf8'));
    }
    hash.update(fs.readFileSync(GOLDEN, 'utf8'));
    expect(hash.digest('hex')).toBe(DIGEST);
  });
});

const DIGEST =
  '7402fb0504ca755d2c031b5ab88bd60940807496c2ee0d1ffb22002e6bb28d0f';
