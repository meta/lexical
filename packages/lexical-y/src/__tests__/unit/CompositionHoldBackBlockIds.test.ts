/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Part of the composition hold-back matrix (see CompositionHoldBack.test.ts)
// with BlockIdExtension: the reads a held change makes keep the line's id
// and node too; and finding R-5 of the review of the hold-back.
import '../utils/blockIdsEnv';

import {blockIdState} from '@lexical/extension';
import {
  $getNodeByKey,
  $getRoot,
  $getState,
  $setCompositionKey,
  $setState,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {REMOTE, runCase, SHAPES} from '../utils/compositionHoldBack';
import {
  $block,
  $p,
  expectConverged,
  setup,
  WITH_BLOCK_IDS,
} from '../utils/harness';

delete process.env.LEXICAL_Y_BLOCK_ID;

const ENDINGS = ['completed', 'Enter', 'a change of the line type'] as const;

describe('@lexical/y composition hold-back with block ids', () => {
  for (const shapeName of ['list item', 'plain']) {
    for (const [remoteName, remote] of Object.entries(REMOTE)) {
      for (const end of ENDINGS) {
        for (const ids of [
          [1, 2],
          [2, 1],
        ]) {
          const shape = SHAPES[shapeName];
          test(`${shapeName} line, remote ${remoteName}, ${end} (ids ${ids})`, async () => {
            expect(WITH_BLOCK_IDS).toBe(true);
            await runCase(shape, remote, end, ids);
          });
        }
      }
    }
  }
});

describe('R-5: a peer changes the block id of the line A composes in', () => {
  test('the line shows its old id until the composition ends', async () => {
    expect(WITH_BLOCK_IDS).toBe(true);
    const t = await setup(() => $getRoot().append($p('composed'), $p('next')));
    const id = () => t.a.read(() => $getState($block([0]), blockIdState));
    const was = id();
    let key = '';
    t.a.update(() => {
      const node = $block([0]).getFirstChildOrThrow() as TextNode;
      node.select(8, 8);
      $setCompositionKey(node.getKey());
      key = node.getKey();
    });
    t.b.update(() => $setState($block([0]), blockIdState, 'remote-id'));
    await t.sync();
    expect(id()).toBe(was);
    // A composition step: an update that settles the ids it touched.
    t.a.update(() => {
      const node = $getNodeByKey(key) as TextNode;
      node.setTextContent('composedに');
      node.select(9, 9);
    });
    await t.sync();
    expect(id()).toBe(was);
    t.a.update(() => $setCompositionKey(null));
    await t.sync();
    await expectConverged(t.peers);
    expect(id()).toBe('remote-id');
  });
});
