/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The cost of reading the handle of every block, counted in calls of
// $isIdentifiedBlock rather than timed: it must grow linearly with the number
// of blocks, also when many blocks hold one id (which persists while the
// extension is disabled).

import {
  $getBlockHandle,
  $getBlockHandles,
  $isRootChildBlock,
  BlockIdExtension,
  buildEditorFromExtensions,
  configExtension,
} from '@lexical/extension';
import {HeadlessExtension} from '@lexical/headless';
import {$getRoot, defineExtension} from 'lexical';
import {describe, expect, test} from 'vitest';

function countCalls(
  count: number,
  options: {disabled: boolean; duplicate: boolean},
): {calls: number; handles: number} {
  let calls = 0;
  using editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        HeadlessExtension,
        configExtension(BlockIdExtension, {
          $isIdentifiedBlock: node => {
            calls++;
            return $isRootChildBlock(node);
          },
          disabled: options.disabled,
        }),
      ],
      name: '[block-handle-cost]',
    }),
  );
  editor.setEditorState(
    editor.parseEditorState({
      root: {
        children: Array.from({length: count}, (_, i) => ({
          $: {
            blockId: options.duplicate
              ? 'shared-block-id'
              : `block-${String(i).padStart(12, '0')}`,
          },
          children: [{text: `p${i}`, type: 'text'}],
          type: 'paragraph',
        })),
        type: 'root',
      },
    } as never),
  );
  // Build what reading needs once (the index, the scan, the table), so that
  // only the reads are counted.
  editor.read(() => $getBlockHandles());
  calls = 0;
  const handles = editor.read(
    () =>
      $getRoot()
        .getChildren()
        .filter(node => $getBlockHandle(node) !== null).length,
  );
  return {calls, handles};
}

describe('reading every handle costs linear time', () => {
  for (const disabled of [true, false]) {
    for (const duplicate of [false, true]) {
      // While enabled, loading repairs the repeated id (every block gets an
      // id of its own); while disabled, every block keeps it.
      test(`${disabled ? 'disabled' : 'enabled'}, ${duplicate ? 'one id repeated' : 'unique ids'}`, () => {
        const rows = [40, 80, 160].map(count =>
          countCalls(count, {disabled, duplicate}),
        );
        for (const [i, row] of rows.entries()) {
          // Only the first holder of a repeated id has a handle.
          expect(row.handles).toBe(duplicate && disabled ? 1 : 40 * 2 ** i);
        }
        // Doubling the blocks at most doubles the calls (plus slack).
        expect(rows[2].calls).toBeLessThanOrEqual(2.2 * rows[1].calls + 4);
        expect(rows[1].calls).toBeLessThanOrEqual(2.2 * rows[0].calls + 4);
      });
    }
  }
});
