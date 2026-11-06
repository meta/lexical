/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Measures block handles on a 10,000-block document of random ids, next to
// the cost of the index that $getBlockById keeps. Timing is
// machine-dependent, so this only runs when BLOCK_ID_PERF=1:
//
//   BLOCK_ID_PERF=1 npx vitest --project unit --no-watch \
//     packages/lexical-extension/src/__tests__/unit/BlockIdExtension.handles.perf.test.ts

import {
  $getBlockById,
  $getBlockHandle,
  $getBlockHandles,
  $resolveBlockHandle,
  BlockIdExtension,
  buildEditorFromExtensions,
  configExtension,
  generateBlockId,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {$createParagraphNode, $getRoot} from 'lexical';
import {describe, expect, test} from 'vitest';

const BLOCKS = 10000;
const ROUNDS = 15;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function time(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function documentJSON(ids: string[]): string {
  return JSON.stringify({
    root: {
      children: ids.map((id, i) => ({
        $: {blockId: id},
        children: [{text: `Block ${i} with some text`, type: 'text'}],
        type: 'paragraph',
      })),
      type: 'root',
    },
  });
}

function build(withIds: boolean, disabled = false): LexicalEditorWithDispose {
  return buildEditorFromExtensions({
    $initialEditorState: null,
    dependencies: [
      RichTextExtension,
      ...(withIds ? [configExtension(BlockIdExtension, {disabled})] : []),
    ],
    name: '[block-handle-perf]',
  });
}

describe.skipIf(process.env.BLOCK_ID_PERF !== '1')(
  'block handles: 10,000 blocks',
  () => {
    test('handles next to the $getBlockById index', () => {
      const ids = Array.from({length: BLOCKS}, generateBlockId);
      const json = documentJSON(ids);
      const loads = {with: [] as number[], without: [] as number[]};
      for (let round = 0; round < ROUNDS; round++) {
        // Alternate which goes first, so that drift affects both alike.
        for (const withIds of round % 2 ? [true, false] : [false, true]) {
          using editor = build(withIds);
          const state = editor.parseEditorState(json);
          loads[withIds ? 'with' : 'without'].push(
            time(() => editor.setEditorState(state)),
          );
        }
      }
      using editor = build(true);
      editor.setEditorState(editor.parseEditorState(json));
      const keys = editor.read(() =>
        $getRoot()
          .getChildren()
          .map(node => node.getKey()),
      );
      const cold: number[] = [];
      const allHandles: number[] = [];
      const handleMap: number[] = [];
      const resolveAll: number[] = [];
      const byIdAll: number[] = [];
      let handles = new Map<string, string>();
      for (let round = 0; round < ROUNDS; round++) {
        // A new block changes the set of ids: the next read builds the table.
        editor.update(
          () => {
            $getRoot().append($createParagraphNode());
          },
          {discrete: true},
        );
        editor.read(() => {
          const first = $getRoot().getFirstChildOrThrow();
          cold.push(time(() => $getBlockHandle(first)));
          // Every block's handle, as an HTML export with handles asks.
          allHandles.push(
            time(() => {
              for (const node of $getRoot().getChildren()) {
                $getBlockHandle(node);
              }
            }),
          );
          handleMap.push(
            time(() => {
              handles = $getBlockHandles();
            }),
          );
          const list = Array.from(handles.values());
          resolveAll.push(
            time(() => {
              for (const handle of list) {
                $resolveBlockHandle(handle);
              }
            }),
          );
          byIdAll.push(
            time(() => {
              for (const id of ids) {
                $getBlockById(id);
              }
            }),
          );
        });
      }
      const lengths = new Map<number, number>();
      for (const handle of handles.values()) {
        lengths.set(handle.length, (lengths.get(handle.length) || 0) + 1);
      }
      expect(keys).toHaveLength(BLOCKS);
      const ms = (value: number) => `${value.toFixed(2)} ms`;
      // eslint-disable-next-line no-console
      console.log(
        [
          `block handles, ${BLOCKS} blocks of random 21-character ids, medians of ${ROUNDS}:`,
          `  load (setEditorState) without BlockIdExtension: ${ms(median(loads.without))}`,
          `  load with it (builds the $getBlockById index):  ${ms(median(loads.with))}`,
          `  index share of the load: ${ms(median(loads.with) - median(loads.without))}`,
          `  first $getBlockHandle after a commit (builds all handles): ${ms(median(cold))}`,
          `  $getBlockHandle for every block, cached:   ${ms(median(allHandles))}`,
          `  $getBlockHandles(), cached:                ${ms(median(handleMap))}`,
          `  $resolveBlockHandle for every handle:      ${ms(median(resolveAll))}`,
          `  $getBlockById for every id:                ${ms(median(byIdAll))}`,
          `  handle lengths: ${JSON.stringify(Object.fromEntries(lengths))}`,
        ].join('\n'),
      );
    }, 120000);

    test('every handle while the extension is disabled, and derived ids', () => {
      const lines: string[] = [];
      for (const count of [2000, BLOCKS]) {
        const ids = Array.from({length: count}, generateBlockId);
        const json = documentJSON(ids);
        for (const disabled of [false, true]) {
          using editor = build(true, disabled);
          editor.setEditorState(editor.parseEditorState(json));
          const runs: number[] = [];
          for (let round = 0; round < 5; round++) {
            runs.push(
              time(() =>
                editor.read(() => {
                  for (const node of $getRoot().getChildren()) {
                    $getBlockHandle(node);
                  }
                }),
              ),
            );
          }
          const all = time(() => editor.read(() => $getBlockHandles()));
          lines.push(
            `  ${count} blocks, ${disabled ? 'disabled (scan)' : 'enabled (index)'}: ` +
              `$getBlockHandle for every block in one read: ${median(runs).toFixed(2)} ms; ` +
              `$getBlockHandles() once: ${all.toFixed(2)} ms`,
          );
        }
      }
      // Ids shaped like @lexical/y's derived ids: one client, close clocks.
      let clock = 0;
      const derived = Array.from({length: BLOCKS}, () => {
        clock += 10 + Math.floor(Math.random() * 70);
        return `y${(2 ** 50).toString(36)}_${clock.toString(36)}`;
      });
      using editor = build(true);
      editor.setEditorState(editor.parseEditorState(documentJSON(derived)));
      const lengths = new Map<number, number>();
      const runs: number[] = [];
      for (let round = 0; round < 5; round++) {
        editor.update(
          () => {
            $getRoot().append($createParagraphNode());
          },
          {discrete: true},
        );
        runs.push(time(() => editor.read(() => $getBlockHandles())));
      }
      for (const handle of editor.read($getBlockHandles).values()) {
        lengths.set(handle.length, (lengths.get(handle.length) || 0) + 1);
      }
      lines.push(
        `  ${BLOCKS} derived ids: $getBlockHandles() after a commit ` +
          `${median(runs).toFixed(2)} ms, handle lengths ` +
          JSON.stringify(Object.fromEntries(lengths)),
      );
      // eslint-disable-next-line no-console
      console.log(`block handles, medians of 5:\n${lines.join('\n')}`);
    }, 120000);
  },
);
