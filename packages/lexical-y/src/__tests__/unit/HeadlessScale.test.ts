/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A server edit opens the stored document, writes one change and disposes
// everything: its cost is dominated by reading the document, which must stay
// linear in its size.

import {$getRoot} from 'lexical';
import {describe, expect, test} from 'vitest';

import {editYState, readYState, seedYState} from '../../headless';
import {createHeadlessYEditor} from '../../internal/HeadlessEditor';
import {$block, $p, NODES} from '../utils/harness';

const config = {
  clientIDRange: 'uint32' as const,
  nodes: NODES,
  schemaVersion: 1,
};

function measure(blocks: number) {
  let t = performance.now();
  const state = seedYState(config, () => {
    for (let i = 0; i < blocks; i++) {
      $getRoot().append($p(`paragraph ${i} with some text in it`));
    }
  });
  const seedMs = performance.now() - t;
  t = performance.now();
  const {update, state: next} = editYState(
    state,
    config,
    () => {
      $block([Math.floor(blocks / 2)]).append($p('x').getFirstChild()!);
      $getRoot().append($p('appended by the server'));
    },
    {writer: null},
  );
  const editMs = performance.now() - t;
  t = performance.now();
  const last = readYState(next, config, () =>
    $getRoot().getLastChild()!.getTextContent(),
  );
  const readMs = performance.now() - t;
  expect(last).toBe('appended by the server');
  // The same edit through a handle, phase by phase.
  t = performance.now();
  const handle = createHeadlessYEditor({...config, state});
  const openMs = performance.now() - t;
  t = performance.now();
  handle.editor.update(() => $getRoot().append($p('one more')), {
    discrete: true,
  });
  const writeMs = performance.now() - t;
  t = performance.now();
  handle.dispose();
  const disposeMs = performance.now() - t;
  return {
    blocks,
    disposeMs: Math.round(disposeMs),
    editMs: Math.round(editMs),
    openMs: Math.round(openMs),
    readMs: Math.round(readMs),
    seedMs: Math.round(seedMs),
    stateBytes: state.length,
    updateBytes: update!.length,
    writeMs: Math.round(writeMs),
  };
}

describe('@lexical/y/headless at scale', () => {
  test('open, edit and dispose a 10,000-block document', () => {
    // Warm up the JIT so the small run is not dominated by compilation.
    measure(200);
    const small = measure(1000);
    const big = measure(10000);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({big, small}));
    // The update holds only the change, whatever the document's size.
    expect(big.updateBytes).toBeLessThan(200);
    // 10x the blocks: allow 30x before calling it superlinear.
    expect(big.editMs).toBeLessThan(Math.max(30 * small.editMs, 2000));
    expect(big.editMs).toBeLessThan(20000);
  }, 120000);
});
