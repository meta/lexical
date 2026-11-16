/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The block merge (D133) through the public path, on stored documents and a
// bound editor: describeUnsyncedEdits reads three Yjs states, and
// replayUnsyncedEdits writes the merged blocks through the binding.
//
// 1. One case in thirteen of the corpus (utils/blockMergeCorpus) as real
//    documents: what the report merges is what the model makes of both
//    sides' edits, the replay writes exactly that, and a second report
//    finds the document holds the user's edits (so the capture can go).
// 2. Every node shape of the catalog, edited at its first text by the user
//    and at its last by someone else: merged with both edits once each, or
//    a conflict; never an error, and never a block that loses either edit.
// Run with gc off and on (LEXICAL_Y_GC=1).

import {
  blockIdState,
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import * as Y from '@y/y';
import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  $parseSerializedNode,
  $setState,
  defineExtension,
  type LexicalEditor,
  type LexicalNode,
  type SerializedLexicalNode,
  type TextNode,
} from 'lexical';
import * as fs from 'node:fs';
import {afterEach, describe, expect, test} from 'vitest';

import {
  createYDoc,
  yCollab,
  type YCollabBinding,
  YCollabExtension,
} from '../..';
import {
  describeUnsyncedEdits,
  editYState,
  seedYState,
  type YUnsyncedBlock,
} from '../../headless';
import {canonical} from '../../internal/BlockMerge';
import {replayUnsyncedEdits} from '../../offline';
import {catalogAppExtension, catalogHeadlessConfig} from '../catalog/bind';
import {NODE_SHAPES} from '../catalog/nodes';
import {
  applyAll,
  docJSON,
  expected,
  isExpected,
  makeCase,
  project,
} from '../utils/blockMergeCorpus';
import {WITH_GC} from '../utils/harness';

const IDS = {blockIds: 'enabled'} as const;
const config = catalogHeadlessConfig(IDS, {onWarn: () => {}});

const live: {dispose(): void}[] = [];
afterEach(() => {
  for (const editor of live.splice(0)) {
    editor.dispose();
  }
});

/** A tab: an editor bound to a document made from `state`. */
function client(state: Uint8Array): {
  binding: YCollabBinding;
  doc: Y.Doc;
  editor: LexicalEditor;
} {
  const doc = createYDoc(state, {gc: WITH_GC});
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        catalogAppExtension(IDS),
        yCollab({doc, onStatus: () => {}, schemaVersion: 1, synced: true}),
      ],
      name: 'block-merge-replay-test',
      onError: error => {
        throw error;
      },
      onWarn: () => {},
    }),
  );
  live.push(editor);
  const binding = getExtensionDependencyFromEditor(editor, YCollabExtension)
    .output.collab;
  return {binding, doc, editor};
}

const seedJSON = (blocks: readonly SerializedLexicalNode[]) =>
  seedYState(config, () => {
    $getRoot().append(...blocks.map(block => $parseSerializedNode(block)));
  });

const describeStates = (
  yours: Uint8Array,
  base: Uint8Array,
  current: Uint8Array,
  blockMerge?: boolean,
) =>
  describeUnsyncedEdits({
    base,
    blockMerge,
    capturedAt: 0,
    config,
    current,
    edits: {state: yours},
    reason: 'stale',
  });

/** The panel: nothing of a report is written over the document by itself. */
const PANEL = {handle: () => {}};

const isMerge = (block: YUnsyncedBlock) =>
  block.resolution === 'merged' &&
  block.merged != null &&
  canonical(block.merged) !== canonical(block.now);

const blocksOf = (editor: LexicalEditor) =>
  editor.read(() => editor.getEditorState().toJSON().root.children);

const idOf = (block: SerializedLexicalNode) =>
  (block as {$?: {blockId?: string}}).$?.blockId;

describe('block merge: the corpus as stored documents', () => {
  const STEP = 13;
  const counts = {
    cases: 0,
    conflicts: 0,
    merged: 0,
    notApplied: {} as Record<string, number>,
  };
  for (let seed = 0; seed < 2800; seed += STEP) {
    const c = makeCase(seed);
    test(`seed ${seed} (${c.family}: ${c.label})`, () => {
      const yoursDoc = applyAll(c.base, c.yours)!;
      const nowDoc = applyAll(c.base, c.theirs)!;
      const base = seedJSON(docJSON(c.base));
      const yours = seedJSON(docJSON(yoursDoc));
      const now = seedJSON(docJSON(nowDoc));
      const want = expected(c);
      const report = describeStates(yours, base, now);
      const off = describeStates(yours, base, now, false);
      counts.cases++;
      // With the merge off, nothing but what the document already holds
      // is merged, and every other entry is as it is with the merge on.
      expect(off.blocks.filter(isMerge)).toEqual([]);
      expect(off.blocks.map(block => block.id)).toEqual(
        report.blocks.map(block => block.id),
      );
      off.blocks.forEach((block, i) => {
        if (block.resolution !== 'conflict') {
          expect(report.blocks[i].resolution).toBe(block.resolution);
        }
      });
      const merges = report.blocks.filter(isMerge);
      for (const block of report.blocks) {
        if (block.resolution === 'merged' && block.merged != null) {
          expect(
            isExpected(want, block.id, block.merged),
            `block ${block.id} merged into what neither order of the edits makes`,
          ).toBe(true);
        }
      }
      counts.merged += merges.length;
      counts.conflicts += report.blocks.filter(
        block => block.resolution === 'conflict',
      ).length;
      // The replay writes the merges (and the whole blocks) through the
      // binding, in one update.
      const tab = client(now);
      const result = replayUnsyncedEdits({
        autoReplay: 'replayable',
        binding: tab.binding,
        leftovers: PANEL,
        report,
      });
      for (const skipped of result.notApplied) {
        counts.notApplied[skipped.reason] =
          (counts.notApplied[skipped.reason] || 0) + 1;
      }
      const after = blocksOf(tab.editor);
      for (const block of merges) {
        expect(result.applied, `block ${block.id} applied`).toContain(block.id);
        const written = after.find(node => idOf(node) === block.id);
        expect(written).toBeDefined();
        expect(canonical(project(written!))).toBe(
          canonical(project(block.merged!)),
        );
      }
      // Conflicts are left as the document had them.
      const before = docJSON(nowDoc);
      for (const block of report.blocks) {
        if (block.resolution === 'conflict' && block.now !== null) {
          const kept = after.find(node => idOf(node) === block.id);
          const was = before.find(node => idOf(node) === block.id);
          expect(canonical(project(kept!))).toBe(canonical(project(was!)));
        }
      }
      // Described again, against the document as the replay left it: each
      // merged block is one the document holds, with nothing to write.
      const again = describeStates(yours, base, Y.encodeStateAsUpdate(tab.doc));
      for (const block of merges) {
        const entry = again.blocks.find(b => b.id === block.id);
        expect(entry, `block ${block.id} reported again`).toBeDefined();
        expect(
          entry!.resolution,
          `block ${block.id} described again: ${entry!.conflictDetail}`,
        ).toBe('merged');
        expect(canonical(entry!.merged)).toBe(canonical(entry!.now));
      }
      expect(
        replayUnsyncedEdits({
          autoReplay: 'replayable',
          binding: tab.binding,
          leftovers: PANEL,
          report: again,
        }).applied,
      ).toEqual([]);
    });
  }

  test('the replay skipped no merged block', () => {
    expect(counts.cases).toBe(Math.ceil(2800 / STEP));
    expect(counts.merged).toBeGreaterThan(counts.cases / 3);
    // A whole block may be skipped (a deleted block someone changed); a
    // merge is never refused for having changed since.
    expect(counts.notApplied['changed-since'] ?? 0).toBe(0);
  });
});

describe('block merge: every node shape of the catalog', () => {
  /** The normal-mode text nodes under `node`, in document order. */
  const $texts = (node: LexicalNode): TextNode[] =>
    $isTextNode(node)
      ? node.getMode() === 'normal' && node.getType() === 'text'
        ? [node]
        : []
      : $isElementNode(node)
        ? node.getChildren().flatMap($texts)
        : [];
  const textOf = (node: unknown): string => {
    const record = node as {text?: unknown; children?: unknown[]};
    return (
      (typeof record.text === 'string' ? record.text : '') +
      (Array.isArray(record.children)
        ? record.children.map(textOf).join('')
        : '')
    );
  };
  const outcomes: Record<string, string> = {};
  for (const shape of NODE_SHAPES) {
    test(shape.name, () => {
      // One stored document, edited twice: by the user at its first
      // text, and by someone else at its last.
      const base = seedYState(config, () => {
        const block = shape.$block();
        $setState(block, blockIdState, 'shape');
        $getRoot().append(block);
      });
      let editable = false;
      const edited = (edit: 'yours' | 'theirs') =>
        editYState(
          base,
          config,
          () => {
            const texts = $texts($getRoot().getFirstChildOrThrow());
            editable = texts.length > 0;
            if (editable && edit === 'yours') {
              const first = texts[0];
              first.setTextContent(`\u00a5${first.getTextContent()}`);
            } else if (editable) {
              const last = texts[texts.length - 1];
              last.setTextContent(`${last.getTextContent()}\u00a7`);
            }
          },
          {writer: null},
        ).state;
      const yours = edited('yours');
      const now = edited('theirs');
      const report = describeStates(yours, base, now);
      if (!editable) {
        outcomes[shape.name] = 'no plain text to edit';
        expect(report.blocks).toEqual([]);
        return;
      }
      const block = report.blocks.find(b => b.id === 'shape');
      if (block === undefined) {
        // The edit did not survive the shape's own transforms.
        outcomes[shape.name] = 'unchanged';
        return;
      }
      expect(describeStates(yours, base, now, false).blocks[0].resolution).toBe(
        'conflict',
      );
      if (block.resolution !== 'merged') {
        expect(block.resolution).toBe('conflict');
        outcomes[shape.name] =
          `conflict (${block.conflict}: ${block.conflictDetail})`;
        return;
      }
      // Both edits, once each, and nothing else of the text changed.
      const merged = textOf(block.merged);
      expect(merged.split('¥').length).toBe(2);
      expect(merged.split('§').length).toBe(2);
      expect(merged.replace('¥', '').replace('§', '')).toBe(textOf(block.base));
      const tab = client(now);
      const result = replayUnsyncedEdits({
        autoReplay: 'replayable',
        binding: tab.binding,
        leftovers: PANEL,
        report,
      });
      outcomes[shape.name] =
        result.applied.length > 0
          ? 'merged and replayed'
          : `merged, replay skipped (${result.notApplied[0].reason})`;
      if (result.applied.length > 0) {
        const text = tab.editor.read(() => $getRoot().getTextContent());
        expect(text.split('¥').length).toBe(2);
        expect(text.split('§').length).toBe(2);
      }
    });
  }

  test('the shapes that merge, and why the others do not', () => {
    const out = process.env.BLOCK_MERGE_SHAPES_OUT;
    if (out !== undefined) {
      fs.writeFileSync(out, JSON.stringify(outcomes, null, 2));
    }
    expect(Object.keys(outcomes).length).toBe(NODE_SHAPES.length);
    const merged = Object.values(outcomes).filter(outcome =>
      outcome.startsWith('merged'),
    ).length;
    expect(merged).toBeGreaterThan(NODE_SHAPES.length / 3);
  });
});
