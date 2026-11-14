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
// catalog of that commit plus its `quote/shadow-root` shape:
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
//   both paragraphs at once. Their read holds every character's NodeState.
// Gc off and on: each migrates to its frozen bytes; reads exactly as the
// layout 4 release read it (block ids included); a root without a quote
// that holds paragraphs gets only its layout record and epoch; and the
// migrated root holds no such line (the runner's checks pass, and the step's
// checkAfter does not on the input). A migrated state migrates no further.
// Golden outputs are written once (MIGRATE_GOLDEN_WRITE=1 when a fixture has
// none) and never regenerated; the frozen sources are pinned by hash.

import * as Y from '@y/y';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, test} from 'vitest';

import {readYState} from '../../headless';
import {migrateYState} from '../../migrate';
import step4to5 from '../../migrate/4to5';
import {$snapshot, catalogHeadlessConfig} from '../catalog/bind';
import {freshReader, NODES, type Peer} from '../utils/harness';
import {TEXT_STATE_DOCS} from '../utils/textStateQuote';

type Input = {
  kind: 'catalog' | 'harness';
  name: string;
  state: string;
  read: unknown;
  blockIds?: 'absent' | 'enabled';
  gc?: boolean;
  withBlockIds?: boolean;
};

const GOLDEN = path.join(__dirname, 'golden', 'migrate-4to5-r1.json');
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as {
  inputs: Input[];
  outputs: Record<string, {gcOff: string; gcOn: string}>;
};
const WRITE = process.env.MIGRATE_GOLDEN_WRITE === '1';

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

const keyOf = (f: Input) =>
  f.kind === 'catalog'
    ? `catalog/${f.blockIds}/${f.name}`
    : `harness/${f.withBlockIds ? 'ids' : 'no-ids'}/${f.gc ? 'gc-on' : 'gc-off'}/${f.name}`;

const migrate = (f: Input, gc: boolean) =>
  migrateYState(unb64(f.state), [step4to5], {gc});

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
        golden.inputs.filter(f => f.kind === 'harness').map(f => f.name),
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
    ]);
    // Inputs that hold a quote with paragraphs: the step has work there.
    const shadow = golden.inputs.filter(f => holdsShadowLine(unb64(f.state)));
    expect(shadow.map(keyOf)).toContain('catalog/absent/quote/shadow-root');
    expect(shadow.length).toBe(2 + 16 + 24);
  });

  for (const f of golden.inputs) {
    for (const gc of [false, true]) {
      test(`${keyOf(f)}, gc ${gc ? 'on' : 'off'}: frozen bytes, the layout 4 read, the record only where there is no such quote`, async () => {
        const result = migrate(f, gc);
        const out = golden.outputs[keyOf(f)];
        expect(out).toBeDefined();
        expect(b64(result.state)).toBe(gc ? out.gcOn : out.gcOff);
        expect(await readAfter(f, result.state)).toEqual(f.read);
        expect(holdsShadowLine(result.state)).toBe(false);
        const [root] = result.receipt.roots;
        expect(root.to).toBe(5);
        const [step] = root.steps;
        if (!holdsShadowLine(unb64(f.state))) {
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
  '2fab02af5409c251f685d67f722cde6a9d99f7316cadb6a4b965fc6f54b6a23f';
