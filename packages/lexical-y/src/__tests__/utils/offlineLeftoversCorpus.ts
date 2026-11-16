/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// The corpus of unsynced edits (utils/unsyncedCorpus) through a replay with
// leftovers (D134), on stored documents and a bound editor: each case's
// base, the user's document and the current one are seeded as Yjs states,
// described, and replayed into an editor bound to the current one. Then,
// for every case:
//
// 1. no block of the report is dropped (utils/offlineLeftovers);
// 2. every replayed block is written as the user had it;
// 3. every block that cannot be replayed is in the document exactly once,
//    inside what the wrapper wrote, as the user had it, under a new id;
// 4. every other block is as the document had it;
// 5. no text is lost or duplicated: each word only the user typed is in
//    the document as often as in theirs, and each word only the other side
//    typed as often as in the current one.
//
// OfflineLeftoversCorpus*.test.ts run ranges of seeds, a file each, so the
// project runs them in parallel.

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $getRoot,
  $parseSerializedNode,
  defineExtension,
  type SerializedLexicalNode,
} from 'lexical';
import * as fs from 'node:fs';
import {afterEach, describe, expect, test} from 'vitest';

import {createYDoc, yCollab, YCollabExtension} from '../..';
import {describeUnsyncedEdits, seedYState} from '../../headless';
import {
  replayUnsyncedEdits,
  wrapLeftoversAsQuote,
  type YLeftovers,
} from '../../offline';
import {catalogAppExtension, catalogHeadlessConfig} from '../catalog/bind';
import {WITH_GC} from './harness';
import {
  blockIdsIn,
  count,
  expectNothingDropped,
  textIn,
} from './offlineLeftovers';
import {
  applyAll,
  docJSON,
  docText,
  makeCase,
  project,
  THEIR_WORDS,
  YOUR_WORDS,
} from './unsyncedCorpus';

const IDS = {blockIds: 'enabled'} as const;
const config = catalogHeadlessConfig(IDS, {onWarn: () => {}});

// No letter of the corpus's words.
const LABEL = '§¶ ¶§';

/** The wrappers a case is run with, by seed. */
const WRAPPERS: readonly {
  readonly name: string;
  readonly leftovers: YLeftovers;
  /** Whether a paragraph is written as another type (a quote). */
  readonly retypes: boolean;
}[] = [
  {
    leftovers: {wrap: wrapLeftoversAsQuote(LABEL)},
    name: 'quote, after-block',
    retypes: true,
  },
  {
    leftovers: {placement: 'top', wrap: wrapLeftoversAsQuote(LABEL)},
    name: 'quote, top',
    retypes: true,
  },
  {
    // An app's wrapper: a label of its own, and the blocks as they are.
    leftovers: {
      wrap: (blocks, context) => [
        ...wrapLeftoversAsQuote(LABEL)([], context),
        ...blocks.map(block => block.yours),
      ],
    },
    name: 'as they are, after-block',
    retypes: false,
  },
  {
    leftovers: {
      placement: 'top',
      wrap: (blocks, context) => [
        ...wrapLeftoversAsQuote(LABEL)([], context),
        ...blocks.map(block => block.yours),
      ],
    },
    name: 'as they are, top',
    retypes: false,
  },
];

const idOf = (block: SerializedLexicalNode) =>
  (block as {$?: {blockId?: string}}).$?.blockId;

/** What a block shows, without its ids (and its own type, for a retyped one). */
function shown(block: SerializedLexicalNode, retyped: boolean): string {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(strip);
    }
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        if (key !== 'id') {
          out[key] = strip(inner);
        }
      }
      return out;
    }
    return value;
  };
  const projected = strip(project(block)) as Record<string, unknown>;
  if (retyped) {
    delete projected.type;
  }
  return JSON.stringify(projected);
}

export interface CorpusCounts {
  cases: number;
  applied: number;
  inserted: number;
  withLeftovers: number;
  fallbacks: number;
}

/** Define the corpus tests of seeds `from` (included) to `to` (not). */
export function describeLeftoversCorpus(
  from: number,
  to: number,
  autoReplay: 'replayable' | 'none' = 'replayable',
): void {
  const live: {dispose(): void}[] = [];
  afterEach(() => {
    for (const editor of live.splice(0)) {
      editor.dispose();
    }
  });
  const seedJSON = (blocks: readonly SerializedLexicalNode[]) =>
    seedYState(config, () => {
      $getRoot().append(...blocks.map(block => $parseSerializedNode(block)));
    });
  const counts: CorpusCounts = {
    applied: 0,
    cases: 0,
    fallbacks: 0,
    inserted: 0,
    withLeftovers: 0,
  };

  function run(seed: number): void {
    const c = makeCase(seed);
    const wrapper = WRAPPERS[seed % WRAPPERS.length];
    const yoursDoc = applyAll(c.base, c.yours)!;
    const nowDoc = applyAll(c.base, c.theirs)!;
    const now = seedJSON(docJSON(nowDoc));
    const report = describeUnsyncedEdits({
      base: seedJSON(docJSON(c.base)),
      // Off here: this corpus is about where a block that is not replayed
      // goes, so every block both sides changed must stay a leftover. The
      // merge has its own corpus (BlockMergeCorpus, BlockMergeReplay).
      blockMerge: false,
      capturedAt: 0,
      config,
      current: now,
      edits: {state: seedJSON(docJSON(yoursDoc))},
      reason: 'stale',
    });
    const doc = createYDoc(now, {gc: WITH_GC});
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          catalogAppExtension(IDS),
          yCollab({doc, onStatus: () => {}, schemaVersion: 1, synced: true}),
        ],
        name: 'offline-leftovers-corpus',
        onError: error => {
          throw error;
        },
        onWarn: () => {},
      }),
    );
    live.push(editor);
    const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
      .output.collab;
    const read = () =>
      editor.read(() => editor.getEditorState().toJSON().root.children);
    const before = read();
    const known = new Set(
      blockIdsIn([
        ...before,
        ...report.blocks.flatMap(b => [b.yours, b.base, b.now]),
      ]),
    );
    const result = replayUnsyncedEdits({
      autoReplay,
      binding,
      leftovers: wrapper.leftovers,
      report,
    });
    const after = read();
    const where = `seed ${seed} (${c.family}: ${c.label}; ${wrapper.name}; ${autoReplay})`;
    if (autoReplay === 'none') {
      // Nothing written over the document; every block the user added or
      // changed is written under the wrapper.
      expect(result.applied, where).toEqual([]);
    }

    // 1. Nothing dropped.
    const written = expectNothingDropped(report, result);
    counts.cases++;
    counts.applied += result.applied.length;
    counts.inserted += written.length;
    counts.withLeftovers += written.length > 0 ? 1 : 0;
    // The corpus's nodes are the editor's, and both wrappers keep every
    // block: no wrapper's output is refused.
    counts.fallbacks += result.leftovers.filter(
      place => place.fallback !== null,
    ).length;
    for (const place of result.leftovers) {
      expect(place.fallback, where).toBeNull();
    }

    // Every block has an id, none twice, and what was written has new ones.
    const ids = blockIdsIn(after);
    expect(new Set(ids).size, where).toBe(ids.length);
    const afterById = new Map(after.map(block => [idOf(block), block]));
    const insertedIds = new Set(result.inserted);
    expect(insertedIds.size, where).toBe(result.inserted.length);
    for (const id of result.inserted) {
      expect(known.has(id), `${where}: inserted id ${id} is not new`).toBe(
        false,
      );
      expect(afterById.has(id), `${where}: inserted id ${id}`).toBe(true);
      for (const nested of blockIdsIn([afterById.get(id)])) {
        expect(known.has(nested), `${where}: nested id ${nested}`).toBe(false);
      }
    }

    // 3. Every block that cannot be replayed, once, inside what the
    // wrapper wrote: a label, then each block as the user had it.
    const reported = new Map(report.blocks.map(block => [block.id, block]));
    for (const place of result.leftovers) {
      expect(place.inserted.length, where).toBe(place.blocks.length + 1);
      expect(textIn(afterById.get(place.inserted[0])), where).toBe(LABEL);
      place.blocks.forEach((id, i) => {
        const yours = reported.get(id)!.yours!;
        // The default wrapper writes a paragraph with text as a quote.
        const retyped =
          wrapper.retypes && yours.type === 'paragraph' && textIn(yours) !== '';
        const node = afterById.get(place.inserted[i + 1])!;
        expect(node.type, where).toBe(retyped ? 'quote' : yours.type);
        expect(shown(node, retyped), `${where}: block ${id} as written`).toBe(
          shown(yours, retyped),
        );
      });
      // Where: the top, or right after the block it names.
      const at = after.findIndex(block => idOf(block) === place.inserted[0]);
      if (place.after === null) {
        expect(at, where).toBe(0);
      } else {
        expect(idOf(after[at - 1]), where).toBe(place.after);
      }
      // Its blocks follow each other.
      place.inserted.forEach((id, i) => {
        expect(idOf(after[at + i]), where).toBe(id);
      });
    }

    // 2 and 4. The rest of the document: the replayed blocks as the user
    // had them, every other block as it was.
    const rest = after.filter(block => !insertedIds.has(idOf(block)!));
    const expected = new Map(before.map(block => [idOf(block), block]));
    for (const id of result.applied) {
      const block = reported.get(id)!;
      if (block.yours === null) {
        expected.delete(id);
      } else {
        expected.set(id, block.yours);
      }
    }
    expect(rest.map(idOf).sort(), where).toEqual([...expected.keys()].sort());
    for (const block of rest) {
      expect(shown(block, false), `${where}: block ${idOf(block)}`).toBe(
        shown(expected.get(idOf(block))!, false),
      );
    }
    // Blocks the document had keep their order.
    const kept = new Set(rest.map(idOf));
    expect(
      rest.map(idOf).filter(id => before.some(b => idOf(b) === id)),
      where,
    ).toEqual(before.map(idOf).filter(id => kept.has(id)));

    // 5. No text lost or duplicated. Every character is accounted for:
    // the document as it was, what each replayed block changed, each block
    // written, and a label per place.
    const text = after.map(textIn).join('\n');
    const beforeText = before.map(textIn).join('\n');
    const beforeById = new Map(before.map(block => [idOf(block), block]));
    const expectedCount = (measure: (value: string) => number) =>
      measure(beforeText) +
      result.applied.reduce((sum, id) => {
        const block = reported.get(id)!;
        return (
          sum +
          measure(textIn(block.yours)) -
          measure(textIn(beforeById.get(id)))
        );
      }, 0) +
      written.reduce(
        (sum, id) => sum + measure(textIn(reported.get(id)!.yours)),
        0,
      );
    const letters = (value: string) => value.replace(/\n/g, '').length;
    expect(letters(text), `${where}: characters`).toBe(
      expectedCount(letters) + result.leftovers.length * LABEL.length,
    );
    const yoursText = docText(yoursDoc);
    const nowText = docText(nowDoc);
    // The stored documents read as the model's.
    expect(letters(beforeText), where).toBe(letters(nowText));
    for (const word of [...YOUR_WORDS, ...THEIR_WORDS]) {
      const times = (value: string) => count(value, word);
      expect(times(text), `${where}: "${word}"`).toBe(expectedCount(times));
    }
    // By the model: nothing only the user typed is lost (each of their
    // words is in the document at least as often as in theirs), and what
    // only the other side typed is there exactly as often as it was.
    for (const word of YOUR_WORDS) {
      expect(
        count(text, word),
        `${where}: the user's "${word}"`,
      ).toBeGreaterThanOrEqual(count(yoursText, word));
    }
    for (const word of THEIR_WORDS.filter(w => w.length > 1)) {
      expect(
        count(text, word) -
          written.reduce(
            (sum, id) => sum + count(textIn(reported.get(id)!.yours), word),
            0,
          ),
        `${where}: the other side's "${word}"`,
      ).toBe(count(nowText, word));
    }
    expect(count(text, LABEL), where).toBe(result.leftovers.length);

    editor.dispose();
    live.splice(live.indexOf(editor), 1);
  }

  describe(`leftovers: the corpus, seeds ${from} to ${to - 1}, autoReplay '${autoReplay}'`, () => {
    const CHUNK = 50;
    for (let start = from; start < to; start += CHUNK) {
      const end = Math.min(to, start + CHUNK);
      // A chunk takes 1 to 3 s alone; the first in a worker also loads the
      // modules, and four files run at once.
      test(`seeds ${start} to ${end - 1}`, {timeout: 60000}, () => {
        for (let seed = start; seed < end; seed++) {
          run(seed);
        }
      });
    }

    test('the corpus has blocks to replay and blocks to insert', () => {
      expect(counts.cases).toBe(to - from);
      expect(counts.fallbacks).toBe(0);
      // Most cases are a block both sides changed.
      expect(counts.withLeftovers).toBeGreaterThan(counts.cases / 3);
      if (autoReplay === 'replayable') {
        expect(counts.applied).toBeGreaterThan(counts.cases / 20);
      } else {
        expect(counts.applied).toBe(0);
      }
      const out = process.env.LEFTOVERS_CORPUS_OUT;
      if (out !== undefined) {
        fs.appendFileSync(out, `${JSON.stringify({from, to, ...counts})}\n`);
      }
    });
  });
}
